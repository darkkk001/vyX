//! DB-backed tests for margin_watch.rs (per-tick margin trigger, 2026-09-24) on the REAL Prisma schema: the
//! book loader reads what the web's risk monitor reads (balance, credit, leverage, the account's own group
//! thresholds, open positions), and a tick that puts a loaded account at or below its stop-out reaches the
//! web's margin-monitor route through the real RiskHook.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test \
//!   VYX_REQUIRE_DB_TESTS=1 cargo test -p order-management --test margin_watch_db
//! Skips without the URL (unless VYX_REQUIRE_DB_TESTS=1). Local databases only; every test rolls back.

use market_data::cache::TickCache;
use market_data::risk_hook::RiskHook;
use order_management::margin_watch::{load_book, MarginWatch};
use protocol::Tick;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("margin_watch_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

fn id() -> String {
    Uuid::new_v4().simple().to_string()
}

/// A broker + account (leverage 1000, `balance`) holding `n` x 0.01 XAUUSD BUY at 4290. `levels` = the
/// group's (marginCall, stopOut); None = a group left at the schema defaults.
async fn account(db: &mut sqlx::PgConnection, balance: Decimal, levels: Option<(Decimal, Decimal)>, n: usize) -> String {
    let (broker, account) = (id(), id());
    let tag = &broker[..10];
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $2, $3, now())"#)
        .bind(&broker).bind(format!("MW DB Test {tag}")).bind(format!("mwdb-{tag}"))
        .execute(&mut *db).await.unwrap();
    // every account has a group (migration stage3b_group_required); None = the group's column defaults
    let group = id();
    match levels {
        Some((call, stop_out)) => sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())"#)
            .bind(&group).bind(&broker).bind(format!("MWDB-{tag}")).bind(call).bind(stop_out)
            .execute(&mut *db).await.unwrap(),
        None => sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "updatedAt") VALUES ($1, $2, $3, now())"#)
            .bind(&group).bind(&broker).bind(format!("MWDB-{tag}"))
            .execute(&mut *db).await.unwrap(),
    };
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'MW DB Test', 'LIVE', $6, 1000, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("6{}", &tag[..7])).bind(format!("mwdb-{tag}@test.local")).bind(balance)
    .execute(&mut *db).await.unwrap();
    let (symbol,): (String,) = sqlx::query_as(r#"SELECT id FROM "Symbol" WHERE name = 'XAUUSD'"#).fetch_one(&mut *db).await.expect("XAUUSD seeded");
    for _ in 0..n {
        let (order, position) = (id(), id());
        sqlx::query(
            r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
               VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 0.01, 'FILLED', $5, now())"#,
        )
        .bind(&order).bind(&broker).bind(&account).bind(&symbol).bind(format!("mwdb:{order}"))
        .execute(&mut *db).await.unwrap();
        let ticket: i32 = (u32::from_str_radix(&position[..7], 16).unwrap() % 2_000_000_000) as i32;
        sqlx::query(
            r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket)
               VALUES ($1, $2, $3, $4, $5, 'BUY', 0.01, 4290, $6)"#,
        )
        .bind(&position).bind(&broker).bind(&account).bind(&symbol).bind(&order).bind(ticket)
        .execute(&mut *db).await.unwrap();
    }
    account
}

fn gold(bid: Decimal) -> Tick {
    serde_json::from_value(serde_json::json!({ "symbol": "XAUUSD", "bid": bid, "ask": bid + dec!(0.3) })).unwrap()
}

/// A one-route HTTP server recording each request line.
async fn mock_route() -> (String, mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api/internal/margin-monitor", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string());
                let _ = sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}").await;
            });
        }
    });
    (url, rx)
}

#[tokio::test]
async fn the_book_carries_balance_leverage_group_thresholds_and_open_positions() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let grouped = account(&mut *tx, dec!(142), Some((dec!(100), dec!(99))), 10).await;
    let at_defaults = account(&mut *tx, dec!(500), None, 2).await;
    let flat = account(&mut *tx, dec!(500), Some((dec!(100), dec!(99))), 0).await;

    let book = load_book(&mut *tx).await.unwrap();
    let a = book.accounts.iter().find(|a| a.id == grouped).expect("grouped account loaded");
    assert_eq!((a.balance, a.credit, a.leverage, a.currency.as_str()), (dec!(142), dec!(0), 1000, "USD"));
    assert_eq!((a.thresholds.call_level, a.thresholds.stop_out_level), (dec!(100), dec!(99)));
    assert_eq!(a.positions.len(), 10);
    assert!(a.positions.iter().all(|p| p.symbol == "XAUUSD" && p.volume == dec!(0.01) && p.open_price == dec!(4290) && p.contract_size == dec!(100)));
    // a group at the schema defaults: 100 / 50
    let u = book.accounts.iter().find(|a| a.id == at_defaults).expect("at_defaults account loaded");
    assert_eq!((u.thresholds.call_level, u.thresholds.stop_out_level), (dec!(100), dec!(50)));
    // nothing open: not watched
    assert!(book.accounts.iter().all(|a| a.id != flat));
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn a_tick_that_puts_a_loaded_account_under_stop_out_calls_the_route_for_its_symbol() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    // 10 x 0.01 at 4290, bid 4280: equity 142 - 100 = 42, used 42.80 -> 98.1 % <= 99
    let acc = account(&mut *tx, dec!(142), Some((dec!(100), dec!(99))), 10).await;
    let book = load_book(&mut *tx).await.unwrap();
    tx.rollback().await.unwrap();
    // only this test's account (the scratch DB may hold others)
    let mine: Vec<_> = book.accounts.into_iter().filter(|a| a.id == acc).collect();
    assert_eq!(mine.len(), 1);

    let (url, mut rx) = mock_route().await;
    std::env::set_var("VYX_RISK_HOOK_URL", &url);
    std::env::set_var("VYX_RISK_HOOK_SECRET", "s3cret");
    let hook = RiskHook::from_env().expect("hook");
    let watch = MarginWatch::new();
    watch.set_book(order_management::margin_watch::Book::new(mine.clone()));
    hook.set_margin_watch(watch.clone());

    // above: bid 4289 -> equity 132 / 42.89 = 307 %: nothing
    let cache = TickCache::new();
    let t = gold(dec!(4289));
    cache.set(&t, chrono::Utc::now());
    hook.after_flush(std::slice::from_ref(&t), &cache);
    assert!(tokio::time::timeout(Duration::from_millis(400), rx.recv()).await.is_err(), "no call above stop-out");

    // the tick that crosses: the route is asked for XAUUSD at once, no SL / TP anywhere
    let t = gold(dec!(4280));
    cache.set(&t, chrono::Utc::now());
    let started = std::time::Instant::now();
    hook.after_flush(std::slice::from_ref(&t), &cache);
    let line = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("route called").unwrap();
    assert_eq!(line, "GET /api/internal/margin-monitor?symbols=XAUUSD HTTP/1.1");
    assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
    let _: Arc<MarginWatch> = watch;
}

/// MT5 hedged margin (2026-09-25): the trigger reads BrokerSymbol.hedgedMarginPct from the DB and measures the hedged
/// margin, so a hedged account is neither falsely triggered (pct 50) nor missed (pct 200). BUY 0.10 + SELL 0.10 XAUUSD
/// at 4290, leverage 1000, balance 80; tick 4280 / 4280.30: floating -100 + 97 = -3 -> equity 77. Margin: legs 42.80 +
/// 42.803 = 85.603 at 200 % -> 90 % (<= 99: fire); at 50 % -> 21.40 -> 360 % (no fire).
async fn hedged_pair_fires(pct: Decimal) -> bool {
    let Some(pool) = pool().await else { return pct == dec!(200) };
    let mut tx = pool.begin().await.unwrap();
    let acc = account(&mut *tx, dec!(80), Some((dec!(100), dec!(99))), 0).await;
    let (broker,): (String,) = sqlx::query_as(r#"SELECT "brokerId" FROM "Account" WHERE id = $1"#).bind(&acc).fetch_one(&mut *tx).await.unwrap();
    let (symbol,): (String,) = sqlx::query_as(r#"SELECT id FROM "Symbol" WHERE name = 'XAUUSD'"#).fetch_one(&mut *tx).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "hedgedMarginPct", "updatedAt") VALUES ($1, $2, $3, $4, now())"#)
        .bind(id()).bind(&broker).bind(&symbol).bind(pct).execute(&mut *tx).await.unwrap();
    for side in ["BUY", "SELL"] {
        let (order, position) = (id(), id());
        sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, $4, $5::"OrderSide", 'MARKET', 0.10, 'FILLED', $6, now())"#)
            .bind(&order).bind(&broker).bind(&acc).bind(&symbol).bind(side).bind(format!("mwdb:{order}")).execute(&mut *tx).await.unwrap();
        let ticket: i32 = (u32::from_str_radix(&position[..7], 16).unwrap() % 2_000_000_000) as i32;
        sqlx::query(r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket) VALUES ($1, $2, $3, $4, $5, $6::"OrderSide", 0.10, 4290, $7)"#)
            .bind(&position).bind(&broker).bind(&acc).bind(&symbol).bind(&order).bind(side).bind(ticket).execute(&mut *tx).await.unwrap();
    }
    let book = load_book(&mut *tx).await.unwrap();
    tx.rollback().await.unwrap();
    let mine: Vec<_> = book.accounts.into_iter().filter(|a| a.id == acc).collect();
    assert_eq!(mine.len(), 1);
    assert!(mine[0].positions.iter().all(|p| p.hedged_margin_pct == pct), "the book carries the symbol's hedged margin %");
    let watch = MarginWatch::new();
    watch.set_book(order_management::margin_watch::Book::new(mine));
    let cache = TickCache::new();
    let t = gold(dec!(4280));
    cache.set(&t, chrono::Utc::now());
    !watch.decide(std::slice::from_ref(&t), &cache, std::time::Instant::now()).is_empty()
}

#[tokio::test]
async fn a_hedged_pair_is_measured_with_the_symbols_hedged_margin_pct() {
    assert!(hedged_pair_fires(dec!(200)).await, "200 %: both legs in full, 90 % <= 99: the trigger fires");
    assert!(!hedged_pair_fires(dec!(50)).await, "50 %: 360 %, the hedged account must NOT be triggered");
}
