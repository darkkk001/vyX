//! The torn read (2026-10-01, S2 07:00:10 UTC, account 49990004 = "a4"): the trigger fired at 07:00:10.472 and the
//! shadow evaluated a1, a2, a4 one after another (~180 ms each). The web closed a4 at 10.871 (TRADE_PNL -643.765 at
//! 10.883), DURING the shadow's pinned evaluation of a4: its funds read saw the balance before the close (1000), its
//! ledger read already saw the close's -643.765 -> pinned balance 1000 - (-643.765) = 1643.765, equity 1000.00, used
//! 783.264 -> 127.67 % -> no stop-out decision -> WEB_ONLY.
//!
//! Replayed on the real schema: the web's close (position CLOSED, balance moved, TRADE_PNL row, as lib/position-close.ts
//! writes them) commits BETWEEN the funds read and the ledger read of the pinned evaluation (calc::BETWEEN_READS_HOOK).
//! CONTROL: the same three reads without one snapshot give 127.67 % (the incident). FIX: load_book_state reads all of
//! them in one REPEATABLE READ snapshot -> one consistent state -> stop-out at 45.48 %, balance after 356.235.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test torn_read_db -- --nocapture

use market_data::cache::TickCache;
use order_management::monitor::{evaluate_account_mode, Mode};
use order_management::shadow::Recorder;
use protocol::Tick;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Notify;
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
            eprintln!("torn_read_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

// S2 a4: balance 1000, BUY 1.99 vIDX @ 20003.5, contract 1, leverage 50, call 100 / stop-out 50; the gap to 19680.
const BALANCE: Decimal = dec!(1000);
const LOTS: Decimal = dec!(1.99);
const OPEN: Decimal = dec!(20003.5);
const GAP_BID: Decimal = dec!(19680);
const GAP_ASK: Decimal = dec!(19682);

struct World {
    pool: PgPool,
    broker: String,
    symbol: String,
    symbol_name: String,
    account: String,
    position: String,
}

async fn world(pool: &PgPool) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, symbol) = (format!("torn-{tag}"), format!("torn-g-{tag}"), format!("torn-s-{tag}"));
    let symbol_name = format!("vT{}", &tag[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 50, now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, $2, 'USD', 1, 1, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "hedgedMarginPct", "updatedAt") VALUES ($1, $2, $3, 200, now())"#)
        .bind(format!("torn-bs-{tag}")).bind(&broker).bind(&symbol).execute(pool).await.unwrap();
    let account = format!("torn-a-{tag}");
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'Torn Read Test', 'LIVE', $6, 50, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("3{}", &tag[..7])).bind(format!("torn-{tag}@test.local")).bind(BALANCE)
    .execute(pool).await.unwrap();
    let (order, position) = (format!("torn-o-{tag}"), format!("torn-p-{tag}"));
    sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', $5, 'FILLED', $1, now())"#)
        .bind(&order).bind(&broker).bind(&account).bind(&symbol).bind(LOTS).execute(pool).await.unwrap();
    let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket, "openedAt")
           VALUES ($1, $2, $3, $4, $5, 'BUY', $6, $7, $8, now() - interval '70 seconds')"#,
    )
    .bind(&position).bind(&broker).bind(&account).bind(&symbol).bind(&order).bind(LOTS).bind(OPEN).bind(ticket)
    .execute(pool).await.unwrap();
    World { pool: pool.clone(), broker, symbol, symbol_name, account, position }
}

impl World {
    /// The web's automatic stop-out close, the rows lib/position-close.ts writes, in one transaction.
    async fn web_close(&self) {
        let pnl = (GAP_BID - OPEN) * LOTS;
        let mut t = self.pool.begin().await.unwrap();
        sqlx::query(r#"UPDATE "Position" SET status = 'CLOSED', "closePrice" = $2, "realizedPnl" = $3, "closedAt" = now() WHERE id = $1 AND status = 'OPEN'"#)
            .bind(&self.position).bind(GAP_BID).bind(pnl).execute(&mut *t).await.unwrap();
        let (before,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1 FOR UPDATE"#).bind(&self.account).fetch_one(&mut *t).await.unwrap();
        sqlx::query(r#"UPDATE "Account" SET balance = $2 WHERE id = $1"#).bind(&self.account).bind(before + pnl).execute(&mut *t).await.unwrap();
        sqlx::query(
            r#"INSERT INTO "Transaction" (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
               VALUES ($1, $2, $3, 'TRADE_PNL', 'COMPLETED', $4, $5, $6, 'Position', $7, 'Stop-out (automatic): margin level below 50%', now())"#,
        )
        .bind(format!("torn-t-{}", self.position)).bind(&self.broker).bind(&self.account).bind(pnl).bind(before).bind(before + pnl).bind(&self.position)
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
        let _ = sqlx::query("DELETE FROM shadow_decision WHERE account_id = $1").bind(&self.account).execute(&self.pool).await;
    }
}

/// margin level of the S2 a4 position at the gap, from a pinned balance
fn level(balance: Decimal) -> Decimal {
    let equity = balance + (GAP_BID - OPEN) * LOTS;
    let used = LOTS * GAP_BID / dec!(50);
    (equity / used * dec!(100)).round_dp(2)
}

#[tokio::test]
async fn a_web_close_committed_between_the_pinned_reads_is_not_counted_twice() {
    let Some(url) = url() else { return };
    let pool = PgPool::connect(&url).await.expect("scratch DB");
    let recorder = Arc::new(Recorder::connect(&url).await.expect("local store"));

    // ---- CONTROL: the three reads as they were (separate statements, no snapshot), the close between them ----
    let w = world(&pool).await;
    let pin_at = chrono::Utc::now();
    let (funds,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&w.account).fetch_one(&pool).await.unwrap();
    w.web_close().await;
    let (since,): (Decimal,) = sqlx::query_as(
        r#"SELECT COALESCE(sum(amount), 0) FROM "Transaction" WHERE "accountId" = $1 AND "referenceType" = 'Position'
             AND ("createdAt" >= $2 OR ("referenceId" = ANY($3) AND "createdAt" >= $2 - interval '5 seconds'))"#,
    )
    .bind(&w.account).bind(pin_at).bind(vec![w.position.clone()]).fetch_one(&pool).await.unwrap();
    let torn = level(funds - since);
    eprintln!("CONTROL (no snapshot): funds {funds}, ledger since pin {since} -> pinned balance {} -> level {torn} %", funds - since);
    w.cleanup().await;
    assert_eq!(torn, dec!(127.67), "the incident: the close counted twice");

    // ---- FIX: the real pinned evaluation, the web's close committed between its funds and ledger reads ----
    let w = world(&pool).await;
    let cache = Arc::new(TickCache::new());
    let now = chrono::Utc::now();
    let tick: Tick = serde_json::from_value(serde_json::json!({ "symbol": w.symbol_name, "bid": GAP_BID, "ask": GAP_ASK })).unwrap();
    cache.set(&tick, now);
    let pin = order_management::book::Pin { at: now, ticks: [(w.symbol_name.clone(), (GAP_BID, GAP_ASK, now))].into_iter().collect(), measured: vec![w.position.clone()] };
    let (reached, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *order_management::calc::BETWEEN_READS_HOOK.lock().unwrap() = Some((reached.clone(), go.clone()));
    let eval = {
        let (pool, account, recorder, cache) = (pool.clone(), w.account.clone(), recorder.clone(), cache.clone());
        tokio::spawn(async move {
            let mode = Mode::Shadow(recorder);
            order_management::book::with_price_source(
                order_management::book::PriceSource::Ticks(cache),
                order_management::book::with_pin(pin, evaluate_account_mode(&pool, None, &account, &mode)),
            )
            .await
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), reached.notified()).await.expect("the evaluation reached the barrier");
    w.web_close().await; // committed while the evaluation sits between its funds read and its ledger read
    go.notify_one();
    eval.await.unwrap().unwrap();
    *order_management::calc::BETWEEN_READS_HOOK.lock().unwrap() = None;

    let decision: Option<(String, Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<Decimal>)> = sqlx::query_as(
        "SELECT kind, level_before, close_price, pnl, balance_after FROM shadow_decision WHERE position_id = $1 ORDER BY first_seen LIMIT 1",
    )
    .bind(&w.position).fetch_optional(&pool).await.unwrap();
    w.cleanup().await;
    eprintln!("FIX (one snapshot): decision {decision:?}; expected level {} %", level(BALANCE));
    let (kind, level_before, close_price, pnl, balance_after) = decision.expect("the shadow decided the stop-out");
    assert_eq!(kind, "stop_out");
    assert_eq!(level_before.map(|l| l.round_dp(2)), Some(dec!(45.48)), "one consistent state: 45.48 %");
    assert_eq!(close_price, Some(GAP_BID));
    assert_eq!(pnl, Some((GAP_BID - OPEN) * LOTS));
    assert_eq!(balance_after, Some(BALANCE + (GAP_BID - OPEN) * LOTS), "the close counted once: 356.235");
}
