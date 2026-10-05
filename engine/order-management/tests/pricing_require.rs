//! require_pricing_cache (the server sets it for shadow / live, 2026-10-05): a book read with no pricing cache in scope
//! must be an ERROR, never a silent per-read load of the pricing tables on the production database. Its own test
//! binary: the flag is process-wide. Seeds its own open position (the guard is only reached on a non-empty book).
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_engine_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test pricing_require

use market_data::cache::TickCache;
use market_data::pricing::PricingCache;
use order_management::book::{open_positions_with_market, require_pricing_cache, with_book_sources, PriceSource};
use std::sync::Arc;

#[tokio::test]
async fn a_book_read_outside_the_pricing_cache_is_refused_once_required() {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            assert_ne!(std::env::var("VYX_REQUIRE_DB_TESTS").as_deref(), Ok("1"), "ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            return;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    let tag = uuid::Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, symbol, account) = (format!("pr-{tag}"), format!("pr-s-{tag}"), format!("pr-a-{tag}"));
    let seed = [
        (r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#, vec![broker.clone()]),
        (r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 50, now())"#, vec![format!("pr-g-{tag}"), broker.clone()]),
        (r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, $2, 'USD', 5, 100000, 'CRYPTO', now())"#, vec![symbol.clone(), format!("PR{}", &tag[..6].to_uppercase())]),
        (r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt") VALUES ($1, $2, $5, $3, $4, 'x', 'Pricing Require Test', 'LIVE', 1000, 100, now())"#, vec![account.clone(), broker.clone(), format!("8{}", &tag[..6]), format!("{account}@test.local"), format!("pr-g-{tag}")]),
        (r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 0.1, 'FILLED', $1, now())"#, vec![format!("pr-o-{tag}"), broker.clone(), account.clone(), symbol.clone()]),
        (r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket, "openedAt") VALUES ($1, $2, $3, $4, $5, 'BUY', 0.1, 1.1, (random() * 2000000000)::int, now())"#, vec![format!("pr-p-{tag}"), broker.clone(), account.clone(), symbol.clone(), format!("pr-o-{tag}")]),
    ];
    for (sql, binds) in seed {
        let mut q = sqlx::query(sql);
        for b in binds {
            q = q.bind(b);
        }
        q.execute(&pool).await.unwrap();
    }
    let ticks = PriceSource::Ticks(Arc::new(TickCache::new()));
    let result = async {
        let unscoped_before = with_book_sources(ticks.clone(), None, open_positions_with_market(&pool, &account)).await.map(|r| r.len());
        require_pricing_cache();
        let unscoped_after = with_book_sources(ticks.clone(), None, open_positions_with_market(&pool, &account)).await.map(|r| r.len()).map_err(|e| e.to_string());
        let scoped = with_book_sources(ticks.clone(), Some(PricingCache::new()), open_positions_with_market(&pool, &account)).await.map(|r| r.len());
        (unscoped_before, unscoped_after, scoped)
    }
    .await;
    for sql in [
        r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Broker" WHERE id = $1"#,
    ] {
        let _ = sqlx::query(sql).bind(&broker).execute(&pool).await;
    }
    let _ = sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&symbol).execute(&pool).await;
    let (before, after, scoped) = result;
    assert_eq!(before.unwrap(), 1, "not required yet: a read without a cache loads its rows' pricing");
    let err = after.expect_err("required: no silent per-read pricing load");
    assert!(err.contains("pricing cache"), "{err}");
    assert_eq!(scoped.unwrap(), 1, "inside the cache's scope it reads (an unloaded cache loads once)");
}
