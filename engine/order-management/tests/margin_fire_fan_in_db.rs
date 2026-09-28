//! Stage 5 soak, S2 fan-in 2026-09-28 21:39:35 UTC: three zzshadowbot accounts on vIDX stopped out on ONE tick (the bot's
//! 1.6 % gap). The per-tick margin trigger fired for all three and handed them to the shadow before the web was called;
//! the shadow evaluated them one after another (account order: 49990001, 49990002, 49990004), each by re-reading the
//! book. The web closed 49990002 FIRST (21:39:35.199; 49990001 +80 ms, 49990004 +147 ms), so the shadow's read of it came
//! after the close, found nothing open and recorded nothing: WEB_ONLY on 49990002, MATCH on the other two.
//!
//! The fix: the trigger hands the shadow (account, book::Pin = the fire moment + the tick-cache prices it measured) and
//! the shadow evaluates the account AS IT STOOD AT THE FIRE, the same pinned evaluation as the SL / TP snapshot. This
//! test replays the exact ordering on the real schema: S2's balances, leverages and lots, the web's close rows written
//! the way lib/position-close.ts writes them, the web closing the middle account before the shadow reads it; and runs
//! the real Reconciler:
//!   CONTROL (the old id-only evaluation): MATCH, WEB_ONLY, MATCH, the incident reproduced;
//!   FIX     (evaluated with the fire's pin): MATCH, MATCH, MATCH, the shadow's price / P&L / balance = the web's.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test margin_fire_fan_in_db

use market_data::cache::TickCache;
use order_management::margin_watch::{load_book, Book, MarginFire, MarginWatch};
use order_management::monitor::{evaluate_account_mode, Mode};
use order_management::reconcile::Reconciler;
use order_management::shadow::Recorder;
use protocol::Tick;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

fn url() -> Option<String> {
    match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => {
            assert!(u.contains("@127.0.0.1:") || u.contains("@localhost:"), "refusing a non-local test database: {u}");
            Some(u)
        }
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("margin_fire_fan_in_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

/// S2's three accounts: (label, balance, leverage, lots). One BUY each at 20002 (contract 1), group MC 100 / SO 50.
const ACCOUNTS: [(&str, Decimal, i32, Decimal); 3] = [("a1", dec!(10000), 100, dec!(24.99)), ("a2", dec!(2000), 200, dec!(5.71)), ("a4", dec!(1000), 50, dec!(1.99))];
const OPEN: Decimal = dec!(20002);
const GAP_BID: Decimal = dec!(19680); // the bot's -1.6 % gap
const GAP_ASK: Decimal = dec!(19682);

struct World {
    pool: PgPool,
    broker: String,
    symbol: String,
    symbol_name: String,
    /// (label, account id, position id, balance, lots), in account-id order = the shadow's order
    accounts: Vec<(&'static str, String, String, Decimal, Decimal)>,
}

async fn world(pool: &PgPool) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, symbol) = (format!("fan-{tag}"), format!("fan-g-{tag}"), format!("fan-s-{tag}"));
    let symbol_name = format!("vF{}", &tag[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 50, now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, $2, 'USD', 1, 1, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "hedgedMarginPct", "updatedAt") VALUES ($1, $2, $3, 200, now())"#)
        .bind(format!("fan-bs-{tag}")).bind(&broker).bind(&symbol).execute(pool).await.unwrap();
    let mut accounts = Vec::new();
    for (i, (label, balance, leverage, lots)) in ACCOUNTS.iter().enumerate() {
        // ids sort in the S2 order (a1 < a2 < a4), like the real cuids, so the shadow reads them in that order
        let account = format!("fan-a-{tag}-{i}");
        sqlx::query(
            r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
               VALUES ($1, $2, $3, $4, $5, 'x', 'Fan-in Test', 'LIVE', $6, $7, now())"#,
        )
        .bind(&account).bind(&broker).bind(&group).bind(format!("4{}{i}", &tag[..6])).bind(format!("fan-{tag}-{i}@test.local")).bind(balance).bind(leverage)
        .execute(pool).await.unwrap();
        let (order, position) = (format!("fan-o-{tag}-{i}"), format!("fan-p-{tag}-{i}"));
        sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', $5, 'FILLED', $1, now())"#)
            .bind(&order).bind(&broker).bind(&account).bind(&symbol).bind(lots).execute(pool).await.unwrap();
        let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
        sqlx::query(
            r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket, "openedAt")
               VALUES ($1, $2, $3, $4, $5, 'BUY', $6, $7, $8, now() - interval '70 seconds')"#,
        )
        .bind(&position).bind(&broker).bind(&account).bind(&symbol).bind(&order).bind(lots).bind(OPEN).bind(ticket)
        .execute(pool).await.unwrap();
        accounts.push((*label, account, position, *balance, *lots));
    }
    World { pool: pool.clone(), broker, symbol, symbol_name, accounts }
}

impl World {
    /// The web's automatic close, the rows lib/position-close.ts writes: position CLOSED (price, P&L, closedAt), the
    /// balance moved under a lock, a TRADE_PNL row with balanceBefore / After and the stop-out note.
    async fn web_close(&self, idx: usize) {
        let (_, account, position, _, lots) = &self.accounts[idx];
        let pnl = (GAP_BID - OPEN) * lots;
        let mut t = self.pool.begin().await.unwrap();
        sqlx::query(r#"UPDATE "Position" SET status = 'CLOSED', "closePrice" = $2, "realizedPnl" = $3, "closedAt" = now() WHERE id = $1 AND status = 'OPEN'"#)
            .bind(position).bind(GAP_BID).bind(pnl).execute(&mut *t).await.unwrap();
        let (before,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1 FOR UPDATE"#).bind(account).fetch_one(&mut *t).await.unwrap();
        sqlx::query(r#"UPDATE "Account" SET balance = $2 WHERE id = $1"#).bind(account).bind(before + pnl).execute(&mut *t).await.unwrap();
        sqlx::query(
            r#"INSERT INTO "Transaction" (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
               VALUES ($1, $2, $3, 'TRADE_PNL', 'COMPLETED', $4, $5, $6, 'Position', $7, 'Stop-out (automatic): margin level below 50%', now())"#,
        )
        .bind(format!("fan-t-{position}")).bind(&self.broker).bind(account).bind(pnl).bind(before).bind(before + pnl).bind(position)
        .execute(&mut *t).await.unwrap();
        t.commit().await.unwrap();
    }

    async fn cleanup(&self) {
        for sql in [
            r#"DELETE FROM "Transaction" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "BrokerSymbol" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Broker" WHERE id = $1"#,
        ] {
            let _ = sqlx::query(sql).bind(&self.broker).execute(&self.pool).await;
        }
        let _ = sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&self.symbol).execute(&self.pool).await;
        for (_, account, ..) in &self.accounts {
            let _ = sqlx::query("DELETE FROM shadow_decision WHERE account_id = $1").bind(account).execute(&self.pool).await;
            let _ = sqlx::query("DELETE FROM shadow_pair WHERE account_id = $1").bind(account).execute(&self.pool).await;
        }
    }
}

/// Per account (label, pair class, the shadow's stop-out decision (close price, P&L, balance after), the web's balance after).
type Outcome = Vec<(&'static str, String, Option<(Option<Decimal>, Option<Decimal>, Option<Decimal>)>, Decimal)>;

async fn run(pool: &PgPool, url: &str, pinned: bool) -> Outcome {
    let w = world(pool).await;
    let recorder = Arc::new(Recorder::connect(url).await.expect("local store"));
    let cache = Arc::new(TickCache::new());
    let tick: Tick = serde_json::from_value(serde_json::json!({ "symbol": w.symbol_name, "bid": GAP_BID, "ask": GAP_ASK })).unwrap();

    // the watch's book = these three accounts (the production book, narrowed to this test's broker)
    let book = load_book(pool).await.unwrap();
    let mine: Vec<_> = book.accounts.into_iter().filter(|a| w.accounts.iter().any(|(_, id, ..)| *id == a.id)).collect();
    assert_eq!(mine.len(), 3, "the three accounts are in the book");
    let watch = MarginWatch::new();
    watch.set_book(Book::new(mine));
    let (tx, mut fires) = tokio::sync::mpsc::unbounded_channel::<MarginFire>();
    watch.set_on_fire(tx);

    // the gap tick: all three at or below stop-out on ONE tick -> the trigger fires for all three (before the web call)
    cache.set(&tick, chrono::Utc::now());
    let symbols = watch.decide(std::slice::from_ref(&tick), &cache, std::time::Instant::now());
    assert_eq!(symbols, vec![w.symbol_name.clone()], "the web is called for the symbol");
    let mut handed = Vec::new();
    while let Ok(f) = fires.try_recv() {
        handed.push(f);
    }
    let order: Vec<&str> = handed.iter().map(|f| w.accounts.iter().find(|a| a.1 == f.account_id).unwrap().0).collect();
    assert_eq!(order, vec!["a1", "a2", "a4"], "all three handed to the shadow, in its evaluation order");

    // the web's first close lands on a2 BEFORE the shadow has read anything (21:39:35.199 in production)
    w.web_close(1).await;
    // the shadow evaluates in its order a1, a2, a4; the web closes a1 and a4 after the shadow's reads of them
    let mode = Mode::Shadow(recorder.clone());
    for fire in handed {
        let (label, ..) = *w.accounts.iter().find(|a| a.1 == fire.account_id).unwrap();
        let eval = async {
            if pinned {
                order_management::book::with_pin(fire.pin, evaluate_account_mode(pool, None, &fire.account_id, &mode)).await
            } else {
                evaluate_account_mode(pool, None, &fire.account_id, &mode).await // the old id-only evaluation
            }
        };
        order_management::book::with_price_source(order_management::book::PriceSource::Ticks(cache.clone()), eval).await.unwrap();
        match label {
            "a1" => w.web_close(0).await,
            "a4" => w.web_close(2).await,
            _ => {}
        }
    }

    tokio::time::sleep(Duration::from_millis(50)).await;
    let reconciler = Reconciler::new(pool.clone(), recorder.clone()).await.expect("reconciler").with_timing(60, 0);
    reconciler.run_once().await.unwrap();
    let mut out = Vec::new();
    for (label, account, position, balance, lots) in &w.accounts {
        let class: Option<(String,)> = sqlx::query_as("SELECT class FROM shadow_pair WHERE position_id = $1 AND kind = 'stop_out'").bind(position).fetch_optional(pool).await.unwrap();
        let decision: Option<(Option<Decimal>, Option<Decimal>, Option<Decimal>)> =
            sqlx::query_as("SELECT close_price, pnl, balance_after FROM shadow_decision WHERE position_id = $1 AND kind = 'stop_out' ORDER BY first_seen LIMIT 1")
                .bind(position).fetch_optional(pool).await.unwrap();
        let _ = account;
        out.push((*label, class.map(|c| c.0).unwrap_or_else(|| "NONE".into()), decision, *balance + (GAP_BID - OPEN) * lots));
    }
    w.cleanup().await;
    out
}

#[tokio::test]
async fn three_accounts_stopped_out_on_one_tick_all_match_even_when_the_web_closes_one_before_the_shadow_reads_it() {
    let Some(url) = url() else { return };
    let pool = PgPool::connect(&url).await.expect("scratch DB");
    let _ = Recorder::connect(&url).await.expect("local store"); // creates the shadow tables
    sqlx::query("DELETE FROM shadow_state WHERE key LIKE 'web_close_cursor%' OR key LIKE 'web_mc_cursor%'").execute(&pool).await.ok();

    // CONTROL: the old id-only evaluation reproduces the production incident exactly
    let control = run(&pool, &url, false).await;
    for (label, class, decision, _) in &control {
        eprintln!("CONTROL (id only) {label}: {class} decision={decision:?}");
    }
    let classes: Vec<&str> = control.iter().map(|c| c.1.as_str()).collect();
    assert_eq!(classes, vec!["MATCH", "WEB_ONLY", "MATCH"], "the incident: a2, closed by the web before the shadow read it, is WEB_ONLY");
    assert!(control[1].2.is_none(), "and the shadow recorded no decision for it");

    // FIX: every fire evaluated with its pin -> all three MATCH, the shadow's numbers are the web's
    let fixed = run(&pool, &url, true).await;
    for (label, class, decision, web_balance) in &fixed {
        eprintln!("FIX (pinned) {label}: {class} decision={decision:?} web balance after={web_balance}");
        assert_eq!(class, "MATCH", "{label}: {class}");
        let (price, pnl, balance_after) = decision.unwrap_or_else(|| panic!("{label}: the shadow recorded no stop-out"));
        assert_eq!(price, Some(GAP_BID), "{label}: the shadow's close price is the web's");
        let lots = ACCOUNTS.iter().find(|a| a.0 == *label).unwrap().3;
        assert_eq!(pnl, Some((GAP_BID - OPEN) * lots), "{label}: the shadow's P&L is the web's");
        // the funds are pinned to BEFORE the web's close (else the P&L would count twice): the web's balance after
        assert_eq!(balance_after, Some(*web_balance), "{label}: the shadow's balance after is the web's");
    }
}

/// The identity match is bounded: a fire naming a position the web closed well BEFORE the fire (a stale book, 60 s)
/// does not revive it. The shadow sees nothing open and records nothing (only a close within 5 s of the fire counts).
#[tokio::test]
async fn a_fire_naming_a_position_closed_long_before_it_does_not_revive_it() {
    let Some(url) = url() else { return };
    let pool = PgPool::connect(&url).await.expect("scratch DB");
    let recorder = Arc::new(Recorder::connect(&url).await.expect("local store"));
    let w = world(&pool).await;
    w.web_close(0).await;
    let (_, account, position, ..) = w.accounts[0].clone();
    sqlx::query(r#"UPDATE "Position" SET "closedAt" = now() - interval '60 seconds' WHERE id = $1"#).bind(&position).execute(&pool).await.unwrap();
    sqlx::query(r#"UPDATE "Transaction" SET "createdAt" = now() - interval '60 seconds' WHERE "referenceId" = $1"#).bind(&position).execute(&pool).await.unwrap();

    let now = chrono::Utc::now();
    let pin = order_management::book::Pin { at: now, ticks: [(w.symbol_name.clone(), (GAP_BID, GAP_ASK, now))].into_iter().collect(), measured: vec![position.clone()] };
    let mode = Mode::Shadow(recorder.clone());
    order_management::book::with_pin(pin, evaluate_account_mode(&pool, None, &account, &mode)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let decision: Option<(String,)> = sqlx::query_as("SELECT kind FROM shadow_decision WHERE position_id = $1").bind(&position).fetch_optional(&pool).await.unwrap();
    w.cleanup().await;
    assert!(decision.is_none(), "a position closed 60 s before the fire is not revived: {decision:?}");
}
