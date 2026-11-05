//! Leverage rules + HMR plugin (owner spec 2026-11-06), the engine on a real database.
//!
//! `tests/leverage_hmr_parity.rs` proves the pure rules against the web's vectors. This proves they are actually REACHED and WRITTEN:
//! a market open and a resting order's fill during a window pass their margin check at the window's leverage and store
//! `Position.openLeverage`; a position keeps its margin leverage after the window ends; the margin reads (book, margin watch) use
//! `openLeverage ?? account.leverage`; a disabled plugin, a symbol outside the map and an expired window change nothing; a refusal
//! names the window.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_hmr_eng \
//!   ENGINE_TEST_NATS_URL=nats://127.0.0.1:4299 VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test hmr_db
//!
//! `the_engine_still_opens_and_reads_on_a_database_without_the_hmr_migration` runs only against a database from BEFORE the web
//! migration (ENGINE_TEST_EXPECT_NO_HMR=1): the engine must work before and after it.

use order_management::{calc, db, hmr};
use protocol::{OrderSide, OrderType};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("hmr_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

async fn nats() -> Option<async_nats::Client> {
    let url = std::env::var("ENGINE_TEST_NATS_URL").ok().filter(|u| !u.is_empty())?;
    Some(async_nats::connect(&url).await.expect("connect to the throwaway NATS"))
}

fn expect_no_hmr() -> bool {
    std::env::var("ENGINE_TEST_EXPECT_NO_HMR").as_deref() == Ok("1")
}

fn id() -> String {
    Uuid::new_v4().simple().to_string()
}

struct Fx {
    broker: String,
    group: String,
    account: String,
    symbol_id: String,
    symbol_name: String,
}

/// A LIVE account (leverage `account_leverage`, balance `balance`) in a group of maximum leverage `group_leverage`, one USD-quoted CRYPTO
/// symbol (always open) of contract size 1.
async fn fixture(pool: &PgPool, balance: Decimal, account_leverage: i32, group_leverage: i32) -> Fx {
    let (broker, group, account, symbol) = (id(), id(), id(), id());
    let t = broker[..10].to_string();
    let symbol_name = format!("ZH{}", t[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "negativeBalanceProtection", "updatedAt") VALUES ($1, $2, $3, true, now())"#)
        .bind(&broker).bind(format!("HMR {t}")).bind(format!("hmr-{t}")).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, category, leverage, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $3, 'B_BOOK'::"RoutingCategory", $4, 100, 50, now())"#)
        .bind(&group).bind(&broker).bind(format!("HMR-{t}")).bind(group_leverage).execute(pool).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, credit, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'HMR', 'LIVE', $6, 0, $7, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("4{}", &t[..7])).bind(format!("hmr-{t}@test.local")).bind(balance).bind(account_leverage)
    .execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, 'XAU', 'USD', 2, 1, 'CRYPTO'::"SymbolCategory", now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "commissionPerLot", "updatedAt") VALUES ($1, $2, $3, 0, now())"#)
        .bind(id()).bind(&broker).bind(&symbol).execute(pool).await.unwrap();
    Fx { broker, group, account, symbol_id: symbol, symbol_name }
}

async fn cleanup(pool: &PgPool, fx: &Fx) {
    for sql in [
        r#"DELETE FROM "Deal" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Transaction" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "AuditLog" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "PostCloseEffect" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "BrokerSymbol" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
    ] {
        sqlx::query(sql).bind(&fx.broker).execute(pool).await.unwrap();
    }
    if !expect_no_hmr() {
        sqlx::query(r#"DELETE FROM "HmrWindow" WHERE "brokerId" = $1"#).bind(&fx.broker).execute(pool).await.unwrap();
        sqlx::query(r#"DELETE FROM "HmrCorrelation" WHERE "brokerId" = $1"#).bind(&fx.broker).execute(pool).await.unwrap();
    }
    sqlx::query(r#"DELETE FROM "Broker" WHERE id = $1"#).bind(&fx.broker).execute(pool).await.unwrap();
    sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&fx.symbol_id).execute(pool).await.unwrap();
}

/// Switches the plugin on and gives USD a symbol list (the fixture symbol plus an unrelated one).
async fn hmr_on(pool: &PgPool, fx: &Fx, listed: &[&str]) {
    sqlx::query(r#"UPDATE "Broker" SET "hmrEnabled" = true WHERE id = $1"#).bind(&fx.broker).execute(pool).await.unwrap();
    let symbols: Vec<String> = listed.iter().map(|s| s.to_string()).collect();
    sqlx::query(r#"INSERT INTO "HmrCorrelation" (id, "brokerId", currency, symbols) VALUES ($1, $2, 'USD', $3)"#).bind(id()).bind(&fx.broker).bind(&symbols).execute(pool).await.unwrap();
    hmr::reset_cache();
}

/// A window around now (`from_min` .. `to_min` minutes from now; negative = past).
async fn window(pool: &PgPool, fx: &Fx, currency: &str, from_min: i64, to_min: i64, leverage: i32) -> String {
    let wid = id();
    sqlx::query(r#"INSERT INTO "HmrWindow" (id, "brokerId", currency, "startsAt", "endsAt", leverage, enabled, "updatedAt") VALUES ($1, $2, $3, now() + make_interval(mins => $4::int), now() + make_interval(mins => $5::int), $6, true, now())"#)
        .bind(&wid).bind(&fx.broker).bind(currency).bind(from_min as i32).bind(to_min as i32).bind(leverage).execute(pool).await.unwrap();
    hmr::reset_cache();
    wid
}

fn tick(symbol: &str) -> protocol::Tick {
    protocol::Tick { symbol: symbol.to_string(), bid: dec!(4298.96), ask: dec!(4299.13), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None, bars: Vec::new(), tick_count: None }
}

fn request(fx: &Fx, volume: Decimal) -> order_management::PlaceMarketOrderRequest {
    order_management::PlaceMarketOrderRequest {
        broker_id: fx.broker.clone(),
        account_id: fx.account.clone(),
        symbol: fx.symbol_name.clone(),
        side: OrderSide::Buy,
        volume,
        sl_price: None,
        tp_price: None,
        equity: dec!(100000),
        used_margin: dec!(0),
        contract_size: dec!(1),
        leverage: 100,
        idempotency_key: None,
    }
}

async fn place(pool: &PgPool, nats: &async_nats::Client, fx: &Fx, volume: Decimal) -> order_management::PlaceMarketOrderOutcome {
    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());
    cache.set(&tick(&fx.symbol_name), chrono::Utc::now());
    order_management::place_market_order(pool, nats, &cache, None, 0, request(fx, volume)).await.expect("the order path ran")
}

async fn open_leverage_of(pool: &PgPool, position_id: &str) -> Option<i32> {
    let (l,): (Option<i32>,) = sqlx::query_as(r#"SELECT "openLeverage" FROM "Position" WHERE id = $1"#).bind(position_id).fetch_one(pool).await.unwrap();
    l
}

fn filled(o: order_management::PlaceMarketOrderOutcome) -> String {
    match o {
        order_management::PlaceMarketOrderOutcome::Filled { position_id, .. } => position_id,
        order_management::PlaceMarketOrderOutcome::Rejected { reason, .. } => panic!("expected a fill, was refused: {reason}"),
    }
}

fn refused(o: order_management::PlaceMarketOrderOutcome) -> String {
    match o {
        order_management::PlaceMarketOrderOutcome::Rejected { reason, .. } => reason,
        order_management::PlaceMarketOrderOutcome::Filled { .. } => panic!("expected a refusal, it filled"),
    }
}

/// price the book at the fixture tick and return the account's used margin (calc::used_margin over load_book_state)
async fn used_margin_now(pool: &PgPool, fx: &Fx) -> Decimal {
    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());
    cache.set(&tick(&fx.symbol_name), chrono::Utc::now());
    let pricing = market_data::pricing::PricingCache::new();
    pricing.reload(pool).await.unwrap();
    let state = order_management::book::with_book_sources(
        order_management::book::PriceSource::Ticks(cache.clone()),
        Some(pricing.clone()),
        calc::load_book_state(pool, &fx.account),
    )
    .await
    .unwrap()
    .expect("the account exists");
    calc::used_margin(&state)
}

#[tokio::test]
async fn a_market_open_in_a_window_margins_at_the_window_and_stores_it_and_keeps_it_after_the_window() {
    if expect_no_hmr() { return; }
    let Some(pool) = pool().await else { return };
    let Some(nats) = nats().await else { return };
    db::use_prisma_book();
    let fx = fixture(&pool, dec!(100000), 500, 500).await;
    hmr_on(&pool, &fx, &[&fx.symbol_name]).await;
    let wid = window(&pool, &fx, "USD", -5, 60, 20).await;

    // 10 lots at 4299.13: notional 42,991.30 -> margin 2,149.565 at 1:20 (86 at the account's 1:500)
    let p1 = filled(place(&pool, &nats, &fx, dec!(10)).await);
    assert_eq!(open_leverage_of(&pool, &p1).await, Some(20), "the position opened under the window stores the window's leverage");
    assert_eq!(used_margin_now(&pool, &fx).await, dec!(10) * dec!(4298.96) / dec!(20), "and its margin is measured at 1:20 (a BUY is valued at the bid)");

    // the window ends: the open position keeps its HMR margin; a NEW position is on the account's leverage
    sqlx::query(r#"UPDATE "HmrWindow" SET "endsAt" = now() - interval '1 minute' WHERE id = $1"#).bind(&wid).execute(&pool).await.unwrap();
    hmr::reset_cache();
    let p2 = filled(place(&pool, &nats, &fx, dec!(10)).await);
    assert_eq!(open_leverage_of(&pool, &p2).await, None, "after the window a new position follows the account");
    assert_eq!(open_leverage_of(&pool, &p1).await, Some(20), "the first position keeps its leverage after the window ended");
    let both = dec!(10) * dec!(4298.96) / dec!(20) + dec!(10) * dec!(4298.96) / dec!(500);
    assert_eq!(used_margin_now(&pool, &fx).await, both, "each position is margined at its own leverage: openLeverage ?? account.leverage");
    cleanup(&pool, &fx).await;
}

#[tokio::test]
async fn a_window_that_starts_later_does_not_touch_an_open_position() {
    if expect_no_hmr() { return; }
    let Some(pool) = pool().await else { return };
    let Some(nats) = nats().await else { return };
    db::use_prisma_book();
    let fx = fixture(&pool, dec!(100000), 500, 500).await;
    hmr_on(&pool, &fx, &[&fx.symbol_name]).await;
    let p1 = filled(place(&pool, &nats, &fx, dec!(10)).await);
    assert_eq!(open_leverage_of(&pool, &p1).await, None);
    let before = used_margin_now(&pool, &fx).await;
    // a window starts now, on the position's symbol: no re-margin of what is open
    window(&pool, &fx, "USD", -1, 30, 5).await;
    assert_eq!(used_margin_now(&pool, &fx).await, before, "existing positions are not re-margined when a window starts");
    assert_eq!(open_leverage_of(&pool, &p1).await, None);
    cleanup(&pool, &fx).await;
}

#[tokio::test]
async fn an_order_that_only_the_window_makes_unaffordable_is_refused_and_the_refusal_names_the_window() {
    if expect_no_hmr() { return; }
    let Some(pool) = pool().await else { return };
    let Some(nats) = nats().await else { return };
    db::use_prisma_book();
    // balance 1,000: 10 lots need 86 at 1:500 (fine) but 2,149.57 at 1:20 (refused)
    let fx = fixture(&pool, dec!(1000), 500, 500).await;
    hmr_on(&pool, &fx, &[&fx.symbol_name]).await;
    let reason = refused({
        window(&pool, &fx, "USD", -5, 60, 20).await;
        place(&pool, &nats, &fx, dec!(10)).await
    });
    assert!(reason.starts_with("Not enough balance for this order. HMR in effect for USD until "), "{reason}");
    assert!(reason.ends_with(&format!(" UTC: leverage 1:20 on new {} positions.", fx.symbol_name)), "{reason}");
    assert_eq!(sqlx::query_scalar::<_, i64>(r#"SELECT count(*) FROM "Position" WHERE "accountId" = $1"#).bind(&fx.account).fetch_one(&pool).await.unwrap(), 0);
    // with the plugin off the very same order fills, on the account's leverage
    sqlx::query(r#"UPDATE "Broker" SET "hmrEnabled" = false WHERE id = $1"#).bind(&fx.broker).execute(&pool).await.unwrap();
    hmr::reset_cache();
    let p = filled(place(&pool, &nats, &fx, dec!(10)).await);
    assert_eq!(open_leverage_of(&pool, &p).await, None, "plugin off = no effect");
    cleanup(&pool, &fx).await;
}

#[tokio::test]
async fn a_symbol_outside_the_map_and_a_disabled_window_are_unaffected_and_the_lowest_overlapping_window_wins() {
    if expect_no_hmr() { return; }
    let Some(pool) = pool().await else { return };
    let Some(nats) = nats().await else { return };
    db::use_prisma_book();
    let fx = fixture(&pool, dec!(100000), 500, 500).await;
    hmr_on(&pool, &fx, &["SOMETHINGELSE"]).await; // the fixture symbol is NOT in USD's list
    window(&pool, &fx, "USD", -5, 60, 20).await;
    let p = filled(place(&pool, &nats, &fx, dec!(1)).await);
    assert_eq!(open_leverage_of(&pool, &p).await, None, "a symbol outside the correlation map is unaffected");

    // list it, add a disabled window and two overlapping ones: the lowest enabled one wins
    sqlx::query(r#"UPDATE "HmrCorrelation" SET symbols = $2 WHERE "brokerId" = $1 AND currency = 'USD'"#).bind(&fx.broker).bind(vec![fx.symbol_name.clone()]).execute(&pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "HmrWindow" (id, "brokerId", currency, "startsAt", "endsAt", leverage, enabled, "updatedAt") VALUES ($1, $2, 'USD', now() - interval '5 minutes', now() + interval '60 minutes', 2, false, now())"#)
        .bind(id()).bind(&fx.broker).execute(&pool).await.unwrap();
    window(&pool, &fx, "USD", -5, 30, 10).await;
    let p2 = filled(place(&pool, &nats, &fx, dec!(1)).await);
    assert_eq!(open_leverage_of(&pool, &p2).await, Some(10), "windows 1:20 and 1:10 overlap, the disabled 1:2 is ignored: the lowest wins");
    cleanup(&pool, &fx).await;
}

#[tokio::test]
async fn an_account_above_its_group_is_held_to_the_group_maximum_on_a_new_open() {
    if expect_no_hmr() { return; }
    let Some(pool) = pool().await else { return };
    let Some(nats) = nats().await else { return };
    db::use_prisma_book();
    let fx = fixture(&pool, dec!(100000), 1000, 500).await; // legacy data: 1:1000 on a 1:500 group
    let p = filled(place(&pool, &nats, &fx, dec!(10)).await);
    assert_eq!(open_leverage_of(&pool, &p).await, Some(500), "the group maximum is the ceiling of a new position");
    cleanup(&pool, &fx).await;
}

fn new_order(fx: &Fx, price: Decimal) -> db::NewOrder {
    db::NewOrder {
        broker_id: fx.broker.clone(),
        account_id: fx.account.clone(),
        symbol: fx.symbol_name.clone(),
        symbol_id: fx.symbol_id.clone(),
        side: OrderSide::Buy,
        order_type: OrderType::Limit,
        volume: dec!(10),
        requested_price: Some(price),
        sl_price: None,
        tp_price: None,
    }
}

#[tokio::test]
async fn a_resting_order_that_fills_in_a_window_margins_and_stores_the_windows_leverage() {
    if expect_no_hmr() { return; }
    let Some(pool) = pool().await else { return };
    let Some(nats) = nats().await else { return };
    db::use_prisma_book();
    let fx = fixture(&pool, dec!(100000), 500, 500).await;
    hmr_on(&pool, &fx, &[&fx.symbol_name]).await;
    window(&pool, &fx, "USD", -5, 60, 20).await;
    // a BUY LIMIT above the ask: it triggers on this tick
    let mut tx = pool.begin().await.unwrap();
    let order_id = db::insert_order(&mut tx, db::Book::Prisma, &new_order(&fx, dec!(5000))).await.unwrap();
    tx.commit().await.unwrap();
    order_management::pending_orders::check_symbol_for_triggers(&pool, &nats, &tick(&fx.symbol_name)).await;
    let (status,): (String,) = sqlx::query_as(r#"SELECT status::text FROM "Order" WHERE id = $1"#).bind(&order_id).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "FILLED");
    let (lev,): (Option<i32>,) = sqlx::query_as(r#"SELECT "openLeverage" FROM "Position" WHERE "originOrderId" = $1"#).bind(&order_id).fetch_one(&pool).await.unwrap();
    assert_eq!(lev, Some(20), "a pending order filled during a window is a new position and gets the window's leverage");

    // a second resting order fills AFTER the window: the account's leverage
    sqlx::query(r#"UPDATE "HmrWindow" SET "endsAt" = now() - interval '1 minute' WHERE "brokerId" = $1"#).bind(&fx.broker).execute(&pool).await.unwrap();
    hmr::reset_cache();
    let mut tx = pool.begin().await.unwrap();
    let order2 = db::insert_order(&mut tx, db::Book::Prisma, &new_order(&fx, dec!(5000))).await.unwrap();
    tx.commit().await.unwrap();
    order_management::pending_orders::check_symbol_for_triggers(&pool, &nats, &tick(&fx.symbol_name)).await;
    let (lev2,): (Option<i32>,) = sqlx::query_as(r#"SELECT "openLeverage" FROM "Position" WHERE "originOrderId" = $1"#).bind(&order2).fetch_one(&pool).await.unwrap();
    assert_eq!(lev2, None);
    cleanup(&pool, &fx).await;
}

#[tokio::test]
async fn a_resting_order_the_window_makes_unaffordable_is_rejected_naming_the_window() {
    if expect_no_hmr() { return; }
    let Some(pool) = pool().await else { return };
    let Some(nats) = nats().await else { return };
    db::use_prisma_book();
    let fx = fixture(&pool, dec!(1000), 500, 500).await;
    hmr_on(&pool, &fx, &[&fx.symbol_name]).await;
    window(&pool, &fx, "USD", -5, 60, 20).await;
    let mut tx = pool.begin().await.unwrap();
    let order_id = db::insert_order(&mut tx, db::Book::Prisma, &new_order(&fx, dec!(5000))).await.unwrap();
    tx.commit().await.unwrap();
    order_management::pending_orders::check_symbol_for_triggers(&pool, &nats, &tick(&fx.symbol_name)).await;
    let (status, reason): (String, Option<String>) = sqlx::query_as(r#"SELECT status::text, "rejectionReason" FROM "Order" WHERE id = $1"#).bind(&order_id).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "REJECTED");
    let reason = reason.unwrap_or_default();
    assert!(reason.contains("HMR in effect for USD until"), "{reason}");
    assert_eq!(sqlx::query_scalar::<_, i64>(r#"SELECT count(*) FROM "Position" WHERE "accountId" = $1"#).bind(&fx.account).fetch_one(&pool).await.unwrap(), 0);
    cleanup(&pool, &fx).await;
}

#[tokio::test]
async fn the_margin_watch_book_reads_the_open_leverage_of_each_position() {
    if expect_no_hmr() { return; }
    let Some(pool) = pool().await else { return };
    let Some(nats) = nats().await else { return };
    db::use_prisma_book();
    let fx = fixture(&pool, dec!(100000), 500, 500).await;
    hmr_on(&pool, &fx, &[&fx.symbol_name]).await;
    let w = window(&pool, &fx, "USD", -5, 60, 20).await;
    let hmr_pos = filled(place(&pool, &nats, &fx, dec!(10)).await);
    sqlx::query(r#"UPDATE "HmrWindow" SET "endsAt" = now() - interval '1 minute' WHERE id = $1"#).bind(&w).execute(&pool).await.unwrap();
    hmr::reset_cache();
    let plain_pos = filled(place(&pool, &nats, &fx, dec!(10)).await);

    let mut conn = pool.acquire().await.unwrap();
    let book = order_management::margin_watch::load_book_on(&mut conn, None).await.unwrap();
    let account = book.accounts.iter().find(|a| a.id == fx.account).expect("the account is watched");
    let lev = |pid: &str| account.positions.iter().find(|p| p.id == pid).unwrap().open_leverage;
    assert_eq!(lev(&hmr_pos), Some(20));
    assert_eq!(lev(&plain_pos), None);

    // and the watcher's measure: the HMR position is margined at 1:20, the other at the account's 1:500
    let cache = market_data::cache::TickCache::new();
    cache.set(&tick(&fx.symbol_name), chrono::Utc::now());
    let (_, used) = order_management::margin_watch::measure(account, &cache);
    assert_eq!(used, dec!(10) * dec!(4298.96) / dec!(20) + dec!(10) * dec!(4298.96) / dec!(500));
    cleanup(&pool, &fx).await;
}

/// The engine must run before AND after the web migration. Against a database from before it (no openLeverage column, no HMR tables,
/// the 23-argument vyx_open_position), a market open, a resting fill and the margin reads all still work and write nothing HMR.
#[tokio::test]
async fn the_engine_still_opens_and_reads_on_a_database_without_the_hmr_migration() {
    if !expect_no_hmr() { return; }
    let Some(pool) = pool().await else { return };
    let Some(nats) = nats().await else { return };
    db::use_prisma_book();
    hmr::reset_cache();
    let fx = fixture(&pool, dec!(100000), 500, 500).await;
    let p = filled(place(&pool, &nats, &fx, dec!(10)).await);
    let (rows,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM information_schema.columns WHERE table_name = 'Position' AND column_name = 'openLeverage'"#).fetch_one(&pool).await.unwrap();
    assert_eq!(rows, 0, "this run is against a database from before the migration");
    assert_eq!(used_margin_now(&pool, &fx).await, dec!(10) * dec!(4298.96) / dec!(500));
    // a resting order fills too
    let mut tx = pool.begin().await.unwrap();
    let order_id = db::insert_order(&mut tx, db::Book::Prisma, &new_order(&fx, dec!(5000))).await.unwrap();
    tx.commit().await.unwrap();
    order_management::pending_orders::check_symbol_for_triggers(&pool, &nats, &tick(&fx.symbol_name)).await;
    let (status,): (String,) = sqlx::query_as(r#"SELECT status::text FROM "Order" WHERE id = $1"#).bind(&order_id).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "FILLED");
    let mut conn = pool.acquire().await.unwrap();
    let book = order_management::margin_watch::load_book_on(&mut conn, None).await.unwrap();
    assert!(book.accounts.iter().any(|a| a.id == fx.account));
    let _ = p;
    cleanup(&pool, &fx).await;
    let _ = fx.group;
}
