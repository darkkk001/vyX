//! Stage 1 DB mode: the scenario is already seeded into `vyx_rust_harness` (scripts/parity/run-ts.ts with
//! PARITY_SEED_ONLY=1), and this runs the engine's REAL margin monitor on it -- order_management::monitor::
//! evaluate_account over book.rs, the same code path production would run -- then reads back what it left
//! in the database, in the same shape as the web's out/ts/<scenario>.json.
//!
//! Stage 4.5: the engine's post-close follow-up is part of the run. After each evaluation cycle the post-close
//! outbox is drained through the REAL dispatcher (order_management::outbox::drain_once) into the web's REAL route,
//! served locally by scripts/parity/post-close-server.ts (run-db.sh starts it and sets VYX_POST_CLOSE_URL /
//! _SECRET). An account the monitor defers (a PENDING follow-up will close one of its positions: a mirror target,
//! an auto-hedged coverage leg) is evaluated in a later cycle, after that follow-up ran -- the web's order. Each
//! account is evaluated exactly once, like the web's single pass, and the side effects are compared too.

use crate::{AccountOutcome, PositionState, Scenario, ScenarioOutcome, Txn};
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::{BTreeMap, BTreeSet};

pub const HARNESS_URL: &str = "postgresql://postgres@127.0.0.1:5499/vyx_rust_harness";
const MAX_CYCLES: usize = 5;

pub async fn connect() -> Result<PgPool, String> {
    let pool = PgPool::connect(HARNESS_URL).await.map_err(|e| format!("connect {HARNESS_URL}: {e}"))?;
    let (db, port): (String, i32) = sqlx::query_as("SELECT current_database()::text, inet_server_port()")
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;
    if db != "vyx_rust_harness" || port != 5499 {
        return Err(format!("connected to {db}:{port}, expected vyx_rust_harness:5499 -- refusing"));
    }
    Ok(pool)
}

fn money(d: Decimal) -> String {
    d.normalize().to_string()
}

/// Runs every due outbox row through the dispatcher until none is left (bounded).
async fn drain(pool: &PgPool, client: &reqwest::Client, cfg: Option<&order_management::outbox::DispatcherConfig>, scenario: &str) -> Result<(), String> {
    for _ in 0..50 {
        let due = order_management::outbox::due_ids(pool, 1).await.map_err(|e| e.to_string())?;
        if due.is_empty() {
            return Ok(());
        }
        let Some(cfg) = cfg else {
            return Err(format!("{scenario}: post-close rows are pending but VYX_POST_CLOSE_URL / _SECRET are unset (run via scripts/parity/run-db.sh)"));
        };
        let stats = order_management::outbox::drain_once(pool, client, cfg).await.map_err(|e| e.to_string())?;
        if stats.failed > 0 {
            let (err,): (Option<String>,) = sqlx::query_as(r#"SELECT "lastError" FROM "PostCloseEffect" WHERE "lastError" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1"#)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            return Err(format!("{scenario}: post-close delivery failed: {}", err.unwrap_or_default()));
        }
    }
    Err(format!("{scenario}: post-close outbox did not drain"))
}

pub async fn evaluate(pool: &PgPool, sc: &Scenario) -> Result<ScenarioOutcome, String> {
    let cfg = order_management::outbox::DispatcherConfig::from_env();
    let client = reqwest::Client::new();

    // cycle by cycle, each account evaluated once (in scenario order, like the web's pass); a deferred account waits
    let mut reports: BTreeMap<String, order_management::monitor::EvalReport> = BTreeMap::new();
    let mut evaluated: BTreeSet<String> = BTreeSet::new();
    for _ in 0..MAX_CYCLES {
        for acct in &sc.accounts {
            if evaluated.contains(&acct.key) {
                continue;
            }
            let report = order_management::monitor::evaluate_account(pool, None, &acct.key)
                .await
                .map_err(|e| format!("{}/{}: {e}", sc.name, acct.key))?;
            match report {
                Some(r) if r.deferred => continue,
                Some(r) => {
                    reports.insert(acct.key.clone(), r);
                }
                // nothing open any more (a follow-up closed it): the web's pass finds the same, level null
                None => {
                    let (open,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Position" WHERE "accountId" = $1 AND status = 'OPEN'"#)
                        .bind(&acct.key)
                        .fetch_one(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    if open > 0 {
                        return Err(format!("{}/{}: evaluate_account did not evaluate an account with open positions", sc.name, acct.key));
                    }
                    reports.insert(acct.key.clone(), Default::default());
                }
            }
            evaluated.insert(acct.key.clone());
        }
        drain(pool, &client, cfg.as_ref(), &sc.name).await?;
        if evaluated.len() == sc.accounts.len() {
            break;
        }
    }
    if evaluated.len() != sc.accounts.len() {
        return Err(format!("{}: accounts still deferred after {MAX_CYCLES} cycles", sc.name));
    }

    let mut out = BTreeMap::new();
    for acct in &sc.accounts {
        let report = &reports[&acct.key];
        let (balance, credit, margin_call_notified): (Decimal, Decimal, bool) =
            sqlx::query_as(r#"SELECT balance, credit, "marginCallNotifiedAt" IS NOT NULL FROM "Account" WHERE id = $1"#)
                .bind(&acct.key)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
        let rows: Vec<(String, Decimal, Option<String>)> = sqlx::query_as(
            r#"SELECT type::text, amount, "referenceId" FROM "Transaction" WHERE "accountId" = $1 ORDER BY "createdAt", id"#,
        )
        .bind(&acct.key)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        // same ordering the TS runner uses: by close order, TRADE_PNL before its write-off
        let closed_ids: Vec<String> = report.closed.iter().map(|(id, _)| id.clone()).collect();
        let rank = |(kind, _, reference): &(String, Decimal, Option<String>)| {
            let i = reference.as_ref().and_then(|r| closed_ids.iter().position(|c| c == r)).unwrap_or(1_000_000);
            // rows of one close share one createdAt (one transaction): order them by kind, the order a close writes them
            i * 10 + match kind.as_str() { "TRADE_PNL" => 0, "CREDIT" => 1, _ => 2 }
        };
        let mut ordered = rows.clone();
        ordered.sort_by_key(|r| rank(r));

        out.insert(
            acct.key.clone(),
            AccountOutcome {
                margin_level_before: report.margin_level_before.map(money),
                closed_position_ids: closed_ids,
                close_reasons: report.closed.iter().map(|(_, r)| r.to_string()).collect(),
                final_balance: money(balance),
                final_credit: money(credit),
                transactions: ordered.into_iter().map(|(kind, amount, _)| Txn { kind, amount: money(amount) }).collect(),
                // Stage 3: the edge column itself, as the TS runner reads it (report.margin_call before)
                margin_call_notified,
            },
        );
    }

    Ok(ScenarioOutcome {
        scenario: sc.name.clone(),
        engine: "rust-db",
        accounts: out,
        side_effects: Some(side_effects(pool).await?),
        positions: Some(position_states(pool).await?),
    })
}

/// Notification / AuditLog rows, counted per (type or action, entity, audience): the harness DB holds one
/// scenario at a time. The same query as scripts/parity/run-ts.ts sideEffects().
pub async fn side_effects(pool: &PgPool) -> Result<BTreeMap<String, i64>, String> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        r#"SELECT 'notification:' || type || ':' || coalesce("entityId", '-') || ':' || CASE WHEN "accountId" IS NULL THEN 'staff' ELSE 'trader' END, count(*) FROM "Notification" GROUP BY 1
           UNION ALL
           SELECT 'audit:' || action || ':' || coalesce("entityId", '-'), count(*) FROM "AuditLog" GROUP BY 1"#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().collect())
}

/// Every position's final state (mirror targets and coverage legs included).
pub async fn position_states(pool: &PgPool) -> Result<BTreeMap<String, PositionState>, String> {
    let rows: Vec<(String, String, Decimal, Option<Decimal>, Option<Decimal>)> =
        sqlx::query_as(r#"SELECT id, status::text, volume, "closePrice", "realizedPnl" FROM "Position""#)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, status, volume, close_price, pnl)| {
            (id, PositionState { status, volume: money(volume), close_price: close_price.map(money), realized_pnl: pnl.map(money) })
        })
        .collect())
}
