//! require_tick_source (the server sets it for shadow / live): a book read with no tick source in scope must be an
//! ERROR, never a silent read of the database's (stale) LivePrice. Its own test binary: the flag is process-wide.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test cargo test -p order-management --test price_source_require

use order_management::book::{open_positions_with_market, require_tick_source, with_price_source, PriceSource};

#[tokio::test]
async fn a_book_read_outside_the_tick_source_is_refused_once_required() {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => return,
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    // any account with an open position will do; none = nothing to read, the guard is not reached
    let Some((account,)): Option<(String,)> = sqlx::query_as(r#"SELECT "accountId" FROM "Position" WHERE status = 'OPEN' LIMIT 1"#).fetch_optional(&pool).await.unwrap() else { return };
    assert!(open_positions_with_market(&pool, &account).await.is_ok(), "not required yet: the database source is allowed");
    require_tick_source();
    let err = open_positions_with_market(&pool, &account).await.expect_err("required: no silent database read");
    assert!(err.to_string().contains("tick source"), "{err}");
    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());
    assert!(with_price_source(PriceSource::Ticks(cache), open_positions_with_market(&pool, &account)).await.is_ok(), "inside the scope it reads");
}
