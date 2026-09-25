//! The book's price source (2026-09-25), in the production condition: the database's "LivePrice" is STALE (the feed's
//! writes went VPS-local in S5; Neon's rows stopped moving) while the engine's in-memory ticks are fresh. The shadow must
//! decide from the ticks; on the database source the same book is unpriced and decides nothing.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test \
//!   VYX_REQUIRE_DB_TESTS=1 cargo test -p order-management --test price_source_db
//! Local databases only. Every scenario has its own broker and symbol, deleted afterwards.

use market_data::cache::TickCache;
use order_management::book::{with_price_source, PriceSource};
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
            eprintln!("price_source_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

struct World {
    pool: PgPool,
    broker: String,
    account: String,
    symbol: String,
    symbol_name: String,
}

/// One account (balance 100, leverage 100, group 100 / 50) holding 10 lots BUY at 100 of its own symbol (contract 1),
/// whose database LivePrice is `db_bid` and `db_age_secs` old.
async fn world(pool: &PgPool, db_bid: Decimal, db_age_secs: i64) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, account, symbol) = (format!("psr-{tag}"), format!("psr-g-{tag}"), format!("psr-a-{tag}"), format!("psr-s-{tag}"));
    let symbol_name = format!("ZP{}", &tag[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 50, now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'Price Source Test', 'LIVE', 100, 100, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("8{}", &tag[..7])).bind(format!("psr-{tag}@test.local"))
    .execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, 'ZP', 'USD', 2, 1, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "LivePrice" (symbol, bid, ask, "updatedAt", "tickAt") VALUES ($1, $2, $2 + 0.1, now() - make_interval(secs => $3), now() - make_interval(secs => $3))"#)
        .bind(&symbol_name).bind(db_bid).bind(db_age_secs as f64).execute(pool).await.unwrap();
    let (order, position) = (format!("psr-o-{tag}"), format!("psr-p-{tag}"));
    sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 10, 'FILLED', $1, now())"#)
        .bind(&order).bind(&broker).bind(&account).bind(&symbol).execute(pool).await.unwrap();
    let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
    sqlx::query(r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket) VALUES ($1, $2, $3, $4, $5, 'BUY', 10, 100, $6)"#)
        .bind(&position).bind(&broker).bind(&account).bind(&symbol).bind(&order).bind(ticket).execute(pool).await.unwrap();
    World { pool: pool.clone(), broker, account, symbol, symbol_name }
}

impl World {
    async fn cleanup(&self) {
        for sql in [
            r#"DELETE FROM "PostCloseEffect" WHERE "brokerId" = $1"#,
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

    /// One shadow evaluation of the account under `source`: the kinds decided.
    async fn shadow_kinds(&self, source: PriceSource) -> Vec<Kind> {
        let recorder = Arc::new(Recorder::in_memory());
        let mode = Mode::Shadow(recorder.clone());
        with_price_source(source, monitor::evaluate_account_mode(&self.pool, None, &self.account, &mode)).await.unwrap();
        recorder.decisions().into_iter().map(|(d, _)| d.kind).collect()
    }
}

fn ticks(symbol: &str, bid: Decimal) -> Arc<TickCache> {
    let cache = Arc::new(TickCache::new());
    let tick: protocol::Tick = serde_json::from_value(serde_json::json!({ "symbol": symbol, "bid": bid, "ask": bid + dec!(0.1) })).unwrap();
    cache.set(&tick, chrono::Utc::now());
    cache
}

#[tokio::test]
async fn stale_database_prices_and_fresh_ticks_the_shadow_decides_from_the_ticks() {
    let Some(pool) = pool().await else { return };
    // the production condition: the database price is 10 days old; the feed (ticks) says 90.4:
    // 10 lots BUY at 100, balance 100 -> equity 100 - 96 = 4, margin 10 x 90.4 / 100 = 9.04
    // 90.4 -> equity 4, margin 9.04 -> 44 % <= 50: stop-out.
    let w = world(&pool, dec!(100), 10 * 24 * 3600).await;
    let on_ticks = w.shadow_kinds(PriceSource::Ticks(ticks(&w.symbol_name, dec!(90.4)))).await;
    let on_db = w.shadow_kinds(PriceSource::Db).await;
    w.cleanup().await;
    assert!(on_ticks.contains(&Kind::StopOut), "fresh ticks: the shadow decides the stop-out: {on_ticks:?}");
    assert!(on_db.is_empty(), "stale database price: unpriced, nothing decided (what production would have done): {on_db:?}");
}

#[tokio::test]
async fn with_both_fresh_the_ticks_win_the_database_price_is_not_read() {
    let Some(pool) = pool().await else { return };
    // the database says a healthy 100 (fresh), the ticks say 90.4: the decision follows the ticks
    let w = world(&pool, dec!(100), 0).await;
    let on_ticks = w.shadow_kinds(PriceSource::Ticks(ticks(&w.symbol_name, dec!(90.4)))).await;
    let on_db = w.shadow_kinds(PriceSource::Db).await;
    w.cleanup().await;
    assert!(on_ticks.contains(&Kind::StopOut), "{on_ticks:?}");
    assert!(on_db.is_empty(), "the database price alone is healthy: {on_db:?}");
}

#[tokio::test]
async fn stale_ticks_are_unpriced_too() {
    let Some(pool) = pool().await else { return };
    let w = world(&pool, dec!(100), 10 * 24 * 3600).await;
    let cache = Arc::new(TickCache::new());
    let tick: protocol::Tick = serde_json::from_value(serde_json::json!({ "symbol": w.symbol_name, "bid": dec!(90.4), "ask": dec!(90.5) })).unwrap();
    cache.set(&tick, chrono::Utc::now() - chrono::Duration::seconds(20));
    let kinds = w.shadow_kinds(PriceSource::Ticks(cache)).await;
    w.cleanup().await;
    assert!(kinds.is_empty(), "a 20 s old tick is stale, as on the web: {kinds:?}");
}
