//! Stage 1 DB mode: the scenario is already seeded into `vyx_rust_harness` (scripts/parity/run-ts.ts with
//! PARITY_SEED_ONLY=1), and this runs the engine's REAL margin monitor on it -- order_management::monitor::
//! evaluate_account over book.rs, the same code path production would run -- then reads back what it left
//! in the database, in the same shape as the web's out/ts/<scenario>.json.

use crate::{AccountOutcome, Scenario, Txn};
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::BTreeMap;

pub const HARNESS_URL: &str = "postgresql://postgres@127.0.0.1:5499/vyx_rust_harness";

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

pub async fn evaluate(pool: &PgPool, sc: &Scenario) -> Result<BTreeMap<String, AccountOutcome>, String> {
    let mut out = BTreeMap::new();
    for acct in &sc.accounts {
        let report = order_management::monitor::evaluate_account(pool, None, &acct.key)
            .await
            .map_err(|e| format!("{}/{}: {e}", sc.name, acct.key))?
            .ok_or_else(|| format!("{}/{}: evaluate_account did not evaluate (no positions / thresholds not loaded)", sc.name, acct.key))?;

        let (balance,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#)
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
            i * 10 + usize::from(kind != "TRADE_PNL")
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
                transactions: ordered.into_iter().map(|(kind, amount, _)| Txn { kind, amount: money(amount) }).collect(),
                margin_call_notified: report.margin_call,
            },
        );
    }
    Ok(out)
}
