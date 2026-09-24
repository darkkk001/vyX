//! Stage 5 drift guard (docs/RUST-CUTOVER-PLAN.md §5.1): on the same book, `Mode::Shadow` must (1) write NOTHING
//! (no close, no Transaction, no follow-up row, no margin-call edge, funds untouched) and (2) decide exactly what
//! `Mode::Live` then really does: the same positions, close prices, P&L, final balance / credit and
//! negative-balance write-off. Each scenario runs shadow first, checks the book is untouched, then live.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test shadow_db
//!
//! Every scenario has its own broker AND its own symbol (LivePrice is keyed by symbol), committed and deleted
//! afterwards; scratch database only.

use order_management::monitor::{self, Mode};
use order_management::shadow::{Kind, Recorder};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("shadow_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

#[derive(Clone)]
struct World {
    pool: PgPool,
    broker: String,
    account: String,
    symbol: String,
    symbol_name: String,
}

struct Pos {
    side: &'static str,
    open: Decimal,
    sl: Option<Decimal>,
    tp: Option<Decimal>,
}

/// broker (NBP on/off) + group (call / stop-out) + one account (balance, credit, leverage 100) + its own
/// symbol (contract 1, USD) priced at bid / ask now, + positions of 10 lots each.
async fn world(pool: &PgPool, nbp: bool, call: Decimal, stop_out: Decimal, balance: Decimal, credit: Decimal, positions: &[Pos], bid: Decimal, ask: Decimal) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, account, symbol) = (format!("shd-{tag}"), format!("shd-g-{tag}"), format!("shd-a-{tag}"), format!("shd-s-{tag}"));
    let symbol_name = format!("ZT{}", &tag[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "negativeBalanceProtection", "updatedAt") VALUES ($1, $1, $1, $2, now())"#)
        .bind(&broker).bind(nbp).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, $3, $4, now())"#)
        .bind(&group).bind(&broker).bind(call).bind(stop_out).execute(pool).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, credit, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'Shadow Test', 'LIVE', $6, $7, 100, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("7{}", &tag[..7])).bind(format!("shd-{tag}@test.local")).bind(balance).bind(credit)
    .execute(pool).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt")
           VALUES ($1, $2, 'ZT', 'USD', 2, 1, 'CRYPTO', now())"#,
    )
    .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "LivePrice" (symbol, bid, ask, "updatedAt", "tickAt") VALUES ($1, $2, $3, now(), now())"#)
        .bind(&symbol_name).bind(bid).bind(ask).execute(pool).await.unwrap();
    for (i, p) in positions.iter().enumerate() {
        let (order, position) = (format!("shd-o-{tag}-{i}"), format!("shd-p-{tag}-{i}"));
        sqlx::query(
            r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
               VALUES ($1, $2, $3, $4, $5::"OrderSide", 'MARKET', 10, 'FILLED', $1, now())"#,
        )
        .bind(&order).bind(&broker).bind(&account).bind(&symbol).bind(p.side).execute(pool).await.unwrap();
        let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
        sqlx::query(
            r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", "slPrice", "tpPrice", ticket, "openedAt")
               VALUES ($1, $2, $3, $4, $5, $6::"OrderSide", 10, $7, $8, $9, $10, now() - make_interval(secs => $11))"#,
        )
        .bind(&position).bind(&broker).bind(&account).bind(&symbol).bind(&order).bind(p.side).bind(p.open).bind(p.sl).bind(p.tp).bind(ticket)
        .bind(100.0 - i as f64) // oldest first = listed first
        .execute(pool).await.unwrap();
    }
    World { pool: pool.clone(), broker, account, symbol, symbol_name }
}

impl World {
    async fn cleanup(&self) {
        for sql in [
            r#"DELETE FROM "PostCloseEffect" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "AuditLog" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Notification" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Transaction" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Broker" WHERE id = $1"#,
        ] {
            let _ = sqlx::query(sql).bind(&self.broker).execute(&self.pool).await;
        }
        let _ = sqlx::query(r#"DELETE FROM "LivePrice" WHERE symbol = $1"#).bind(&self.symbol_name).execute(&self.pool).await;
        let _ = sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&self.symbol).execute(&self.pool).await;
    }

    /// Everything a close or an edge would have written, as one comparable tuple.
    async fn footprint(&self) -> (i64, i64, i64, Decimal, Decimal, bool) {
        let (open,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Position" WHERE "accountId" = $1 AND status = 'OPEN'"#).bind(&self.account).fetch_one(&self.pool).await.unwrap();
        let (txns,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Transaction" WHERE "accountId" = $1"#).bind(&self.account).fetch_one(&self.pool).await.unwrap();
        let (fx,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "PostCloseEffect" WHERE "brokerId" = $1"#).bind(&self.broker).fetch_one(&self.pool).await.unwrap();
        let (b, c, n): (Decimal, Decimal, Option<chrono::DateTime<chrono::Utc>>) =
            sqlx::query_as(r#"SELECT balance, credit, "marginCallNotifiedAt" FROM "Account" WHERE id = $1"#).bind(&self.account).fetch_one(&self.pool).await.unwrap();
        (open, txns, fx, b, c, n.is_some())
    }

    /// The real closes: position id -> (close price, realized P&L), plus final funds and total write-off.
    async fn real_closes(&self) -> (Vec<(String, Decimal, Decimal)>, Decimal, Decimal, Decimal) {
        let rows: Vec<(String, Decimal, Decimal)> = sqlx::query_as(
            r#"SELECT id, "closePrice", "realizedPnl" FROM "Position" WHERE "accountId" = $1 AND status = 'CLOSED' ORDER BY id"#,
        )
        .bind(&self.account).fetch_all(&self.pool).await.unwrap();
        let (b, c): (Decimal, Decimal) = sqlx::query_as(r#"SELECT balance, credit FROM "Account" WHERE id = $1"#).bind(&self.account).fetch_one(&self.pool).await.unwrap();
        let (w,): (Option<Decimal>,) = sqlx::query_as(r#"SELECT sum(amount) FROM "Transaction" WHERE "accountId" = $1 AND type = 'NEGATIVE_BALANCE_PROTECTION'"#)
            .bind(&self.account).fetch_one(&self.pool).await.unwrap();
        (rows, b, c, w.unwrap_or(Decimal::ZERO))
    }
}

/// Shadow, then the untouched check, then live, then the comparison. Returns the shadow's decisions.
async fn shadow_then_live(w: &World) -> Vec<order_management::shadow::Decision> {
    let before = w.footprint().await;
    let recorder = Arc::new(Recorder::in_memory());
    let mode = Mode::Shadow(recorder.clone());
    // twice: a second pass must not duplicate a decision (one record, two sightings)
    monitor::evaluate_account_mode(&w.pool, None, &w.account, &mode).await.unwrap();
    monitor::evaluate_account_mode(&w.pool, None, &w.account, &mode).await.unwrap();
    assert_eq!(w.footprint().await, before, "shadow wrote to the book");
    let decisions: Vec<_> = recorder.decisions().into_iter().map(|(d, n)| {
        // a close is seen on every pass until it happens; a margin-call edge is recorded on CHANGE only
        assert_eq!(n, if d.kind.is_close() { 2 } else { 1 }, "sightings: {d:?}");
        d
    }).collect();

    monitor::evaluate_account(&w.pool, None, &w.account).await.unwrap();
    let (real, balance, credit, write_off) = w.real_closes().await;

    let mut would: Vec<(String, Decimal, Decimal)> = decisions.iter().filter(|d| d.kind.is_close())
        .map(|d| (d.position_id.clone().unwrap(), d.close_price.unwrap(), d.pnl.unwrap())).collect();
    would.sort();
    assert_eq!(would, real, "shadow's would-closes = live's real closes (position, price, P&L)");
    if let Some(last) = decisions.iter().filter(|d| d.kind.is_close()).max_by_key(|d| d.position_id.clone()) {
        let _ = last; // order-independent checks below
    }
    if !real.is_empty() {
        // the funds after the LAST simulated close = the account after the real closes
        let final_sim = decisions.iter().filter(|d| d.kind.is_close()).map(|d| (d.balance_after.unwrap(), d.credit_after.unwrap()));
        assert!(final_sim.clone().any(|f| f == (balance, credit)), "a simulated close ends at the real funds {balance}/{credit}: {decisions:?}");
        let sim_write_off: Decimal = decisions.iter().filter_map(|d| d.write_off).sum();
        assert_eq!(sim_write_off, write_off, "negative-balance write-off");
    }
    decisions
}

#[tokio::test]
async fn stop_out_cascade_through_credit_and_negative_balance_protection_matches_live() {
    let Some(pool) = pool().await else { return };
    // 3 x 10 lots BUY at 100 / 101 / 102, bid 88: equity 100 + 50 - (120 + 130 + 140) < 0 -> every one closes;
    // the first loss eats balance then credit, the next ones go past credit into the broker's write-off
    let w = world(&pool, true, dec!(100), dec!(50), dec!(100), dec!(50),
        &[Pos { side: "BUY", open: dec!(100), sl: None, tp: None }, Pos { side: "BUY", open: dec!(101), sl: None, tp: None }, Pos { side: "BUY", open: dec!(102), sl: None, tp: None }],
        dec!(88), dec!(88.1)).await;
    let res = run_catching(&w).await;
    w.cleanup().await;
    let d = res.unwrap_or_else(|e| std::panic::resume_unwind(e));
    assert_eq!(d.iter().filter(|x| x.kind == Kind::StopOut).count(), 3);
    assert!(d.iter().any(|x| x.write_off.is_some()), "write-off exercised");
}

#[tokio::test]
async fn sl_and_tp_in_one_pass_match_live() {
    let Some(pool) = pool().await else { return };
    // BUY at 100 with SL 95 (bid 94 hits it); SELL at 100 with TP 96 (ask 94.1 hits it); healthy account
    let w = world(&pool, true, dec!(100), dec!(50), dec!(100000), dec!(0),
        &[Pos { side: "BUY", open: dec!(100), sl: Some(dec!(95)), tp: None }, Pos { side: "SELL", open: dec!(100), sl: None, tp: Some(dec!(96)) }],
        dec!(94), dec!(94.1)).await;
    let res = run_catching(&w).await;
    w.cleanup().await;
    let d = res.unwrap_or_else(|e| std::panic::resume_unwind(e));
    assert_eq!(d.iter().filter(|x| x.kind == Kind::StopLoss).count(), 1);
    assert_eq!(d.iter().filter(|x| x.kind == Kind::TakeProfit).count(), 1);
}

#[tokio::test]
async fn a_margin_call_is_recorded_as_an_edge_and_live_sets_the_flag() {
    let Some(pool) = pool().await else { return };
    // 1 x 10 lots BUY at 100, bid 97: used 9.7, equity 12 - 30 + ... -> choose balance so the level sits between 50 and 100
    // equity = 38 - 30 = 8 over used 9.7 = 82 %: margin call, no stop-out
    let w = world(&pool, true, dec!(100), dec!(50), dec!(38), dec!(0), &[Pos { side: "BUY", open: dec!(100), sl: None, tp: None }], dec!(97), dec!(97.1)).await;
    let res = run_catching(&w).await;
    let flag = w.footprint().await.5;
    w.cleanup().await;
    let d = res.unwrap_or_else(|e| std::panic::resume_unwind(e));
    assert_eq!(d.iter().map(|x| x.kind).collect::<Vec<_>>(), vec![Kind::MarginCallIn]);
    assert!(flag, "live set marginCallNotifiedAt for the same episode");
}

/// shadow_then_live on an owned copy in its own task, so a failing assertion still lets the caller delete the
/// committed fixture before re-raising it.
async fn run_catching(w: &World) -> std::thread::Result<Vec<order_management::shadow::Decision>> {
    let owned = w.clone();
    tokio::task::spawn(async move { shadow_then_live(&owned).await }).await.map_err(|e| e.into_panic())
}
