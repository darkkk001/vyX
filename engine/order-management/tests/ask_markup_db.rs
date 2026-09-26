//! The account's ask on the real book (owner decision 2026-09-26, market_data::ask_markup = lib/ask-markup.ts): a SELL
//! is stopped out / SL-triggered at its account's marked-up ask, in shadow AND live, at the identical price; a coverage
//! account stays raw; the pricing engine's target mode and per-account override resolve like the web.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test ask_markup_db
//!
//! Each scenario has its own broker and its own symbol, committed and deleted afterwards; scratch database only.

use market_data::ask_markup::AskRule;
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
            eprintln!("ask_markup_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

/// How the scenario's pricing is configured.
#[derive(Default, Clone)]
struct Pricing {
    engine: bool,
    coverage_group: bool,
    broker_markup: Decimal,
    group_markup: Option<Decimal>,
    group_target: Option<Decimal>,
    account_symbol_markup: Option<Decimal>,
}

struct World {
    pool: PgPool,
    broker: String,
    account: String,
    symbol: String,
    symbol_name: String,
}

/// broker + group (stop-out 50, call 100) + one account (leverage 100) + its own 2-digit symbol (contract 1, USD) priced at
/// bid 4298.96 / ask 4299.13 now, + one SELL of 10 lots at 4290.00 with the given SL.
async fn world(pool: &PgPool, pr: &Pricing, balance: Decimal, sl: Option<Decimal>) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, account, symbol) = (format!("askm-{tag}"), format!("askm-g-{tag}"), format!("askm-a-{tag}"), format!("askm-s-{tag}"));
    let symbol_name = format!("ZA{}", &tag[..6].to_uppercase());
    let q = |sql: &'static str| sqlx::query(sql);
    q(r#"INSERT INTO "Broker" (id, name, subdomain, "negativeBalanceProtection", "pricingEngineEnabled", "updatedAt") VALUES ($1, $1, $1, true, $2, now())"#)
        .bind(&broker).bind(pr.engine).execute(pool).await.unwrap();
    q(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", category, "updatedAt") VALUES ($1, $2, $1, 100, 50, $3::"RoutingCategory", now())"#)
        .bind(&group).bind(&broker).bind(if pr.coverage_group { "COVERAGE" } else { "B_BOOK" }).execute(pool).await.unwrap();
    q(r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, credit, leverage, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'x', 'Ask Markup Test', 'LIVE', $6, 0, 100, now())"#)
        .bind(&account).bind(&broker).bind(&group).bind(format!("6{}", &tag[..7])).bind(format!("askm-{tag}@test.local")).bind(balance)
        .execute(pool).await.unwrap();
    q(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, 'ZA', 'USD', 2, 1, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    q(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "spreadMarkup", "updatedAt") VALUES ($1, $2, $3, $4, now())"#)
        .bind(format!("askm-bs-{tag}")).bind(&broker).bind(&symbol).bind(pr.broker_markup).execute(pool).await.unwrap();
    if pr.group_markup.is_some() || pr.group_target.is_some() {
        q(r#"INSERT INTO "GroupSymbolConfig" (id, "groupId", "symbolId", "spreadMarkup", "targetTotalSpreadPips", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())"#)
            .bind(format!("askm-gsc-{tag}")).bind(&group).bind(&symbol).bind(pr.group_markup).bind(pr.group_target).execute(pool).await.unwrap();
    }
    if let Some(m) = pr.account_symbol_markup {
        q(r#"INSERT INTO "AccountSymbolConfig" (id, "accountId", "symbolId", "spreadMarkup", "updatedAt") VALUES ($1, $2, $3, $4, now())"#)
            .bind(format!("askm-asc-{tag}")).bind(&account).bind(&symbol).bind(m).execute(pool).await.unwrap();
    }
    q(r#"INSERT INTO "LivePrice" (symbol, bid, ask, "updatedAt", "tickAt") VALUES ($1, 4298.96, 4299.13, now(), now())"#)
        .bind(&symbol_name).execute(pool).await.unwrap();
    let order = format!("askm-o-{tag}");
    q(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
         VALUES ($1, $2, $3, $4, 'SELL', 'MARKET', 10, 'FILLED', $1, now())"#)
        .bind(&order).bind(&broker).bind(&account).bind(&symbol).execute(pool).await.unwrap();
    let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
    q(r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", "slPrice", ticket, "openedAt")
         VALUES ($1, $2, $3, $4, $5, 'SELL', 10, 4290.00, $6, $7, now())"#)
        .bind(format!("askm-p-{tag}")).bind(&broker).bind(&account).bind(&symbol).bind(&order).bind(sl).bind(ticket)
        .execute(pool).await.unwrap();
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
            r#"DELETE FROM "AccountSymbolConfig" WHERE "accountId" IN (SELECT id FROM "Account" WHERE "brokerId" = $1)"#,
            r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "GroupSymbolConfig" WHERE "groupId" IN (SELECT id FROM "Group" WHERE "brokerId" = $1)"#,
            r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "BrokerSymbol" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Broker" WHERE id = $1"#,
        ] {
            let _ = sqlx::query(sql).bind(&self.broker).execute(&self.pool).await;
        }
        let _ = sqlx::query(r#"DELETE FROM "LivePrice" WHERE symbol = $1"#).bind(&self.symbol_name).execute(&self.pool).await;
        let _ = sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&self.symbol).execute(&self.pool).await;
    }

    /// Shadow (twice, nothing written), then live: returns the shadow's close decisions and live's real closes.
    async fn shadow_then_live(&self) -> (Vec<(Kind, Decimal, Decimal)>, Vec<(Decimal, Decimal)>) {
        let recorder = Arc::new(Recorder::in_memory());
        let mode = Mode::Shadow(recorder.clone());
        monitor::evaluate_account_mode(&self.pool, None, &self.account, &mode).await.unwrap();
        let (open_after_shadow,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Position" WHERE "accountId" = $1 AND status = 'OPEN'"#)
            .bind(&self.account).fetch_one(&self.pool).await.unwrap();
        assert_eq!(open_after_shadow, 1, "shadow wrote to the book");
        let decisions: Vec<(Kind, Decimal, Decimal)> = recorder.decisions().into_iter().filter(|(d, _)| d.kind.is_close())
            .map(|(d, _)| (d.kind, d.close_price.unwrap(), d.pnl.unwrap())).collect();
        monitor::evaluate_account(&self.pool, None, &self.account).await.unwrap();
        let real: Vec<(Decimal, Decimal)> = sqlx::query_as(r#"SELECT "closePrice", "realizedPnl" FROM "Position" WHERE "accountId" = $1 AND status = 'CLOSED'"#)
            .bind(&self.account).fetch_all(&self.pool).await.unwrap();
        (decisions, real)
    }
}

/// Runs the scenario body on its own task so a failing assertion still cleans the world up, then re-raises it.
async fn run<T: Send + 'static>(w: &World, f: impl std::future::Future<Output = T> + Send + 'static) -> T {
    let res = tokio::spawn(f).await;
    w.cleanup().await;
    match res {
        Ok(v) => v,
        Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
        Err(e) => panic!("{e}"),
    }
}

const SL: Decimal = dec!(4299.25);

#[tokio::test]
async fn a_sell_sl_between_the_raw_and_the_account_ask_fires_at_the_account_ask_in_shadow_and_live() {
    let Some(pool) = pool().await else { return };
    // engine off, group markup 1.5 pips (Futurix Standard's shape): account ask = 4299.13 + 0.15 = 4299.28 >= SL 4299.25
    let w = world(&pool, &Pricing { group_markup: Some(dec!(1.5)), broker_markup: dec!(0.5), ..Default::default() }, dec!(100000), Some(SL)).await;
    let (w_pool, w_acct) = (w.pool.clone(), w.account.clone());
    let (shadow, live) = run(&w, async move {
        let positions = order_management::book::open_positions_with_market(&w_pool, &w_acct).await.unwrap();
        assert_eq!(positions[0].ask_rule, Some(AskRule::Markup { markup_pips: dec!(1.5), digits: 2 }), "the group's markup wins over the broker's");
        World { pool: w_pool.clone(), broker: String::new(), account: w_acct.clone(), symbol: String::new(), symbol_name: String::new() }.shadow_then_live().await
    }).await;
    // P&L = (4290.00 - 4299.28) x 1 x 10 = -92.80
    assert_eq!(shadow, vec![(Kind::StopLoss, dec!(4299.28), dec!(-92.80))]);
    assert_eq!(live, vec![(dec!(4299.28), dec!(-92.80))], "live closes at the same price and P&L as the shadow decided");
}

#[tokio::test]
async fn a_sell_is_stopped_out_on_its_account_ask_when_the_raw_ask_would_leave_it_above() {
    let Some(pool) = pool().await else { return };
    // balance 307, SELL 10 x 4290 at leverage 100:
    //   raw     ask 4299.13: equity 307 - 91.30 = 215.70 / margin 429.913 = 50.17 %  (> 50: no stop-out)
    //   account ask 4299.28: equity 307 - 92.80 = 214.20 / margin 429.928 = 49.82 %  (<= 50: stop-out)
    let w = world(&pool, &Pricing { group_markup: Some(dec!(1.5)), ..Default::default() }, dec!(307), None).await;
    let (w_pool, w_acct) = (w.pool.clone(), w.account.clone());
    let (shadow, live) = run(&w, async move {
        World { pool: w_pool, broker: String::new(), account: w_acct, symbol: String::new(), symbol_name: String::new() }.shadow_then_live().await
    }).await;
    assert_eq!(shadow, vec![(Kind::StopOut, dec!(4299.28), dec!(-92.80))]);
    assert_eq!(live, vec![(dec!(4299.28), dec!(-92.80))]);
}

#[tokio::test]
async fn the_coverage_account_stays_raw_whatever_is_configured() {
    let Some(pool) = pool().await else { return };
    let w = world(&pool, &Pricing { coverage_group: true, group_markup: Some(dec!(1.5)), broker_markup: dec!(2), ..Default::default() }, dec!(100000), Some(SL)).await;
    let (w_pool, w_acct) = (w.pool.clone(), w.account.clone());
    let (shadow, live) = run(&w, async move {
        let positions = order_management::book::open_positions_with_market(&w_pool, &w_acct).await.unwrap();
        assert_eq!(positions[0].ask_rule, Some(AskRule::Markup { markup_pips: Decimal::ZERO, digits: 2 }));
        World { pool: w_pool, broker: String::new(), account: w_acct, symbol: String::new(), symbol_name: String::new() }.shadow_then_live().await
    }).await;
    assert!(shadow.is_empty() && live.is_empty(), "raw ask 4299.13 is below the SL 4299.25: nothing fires");
}

#[tokio::test]
async fn pricing_engine_target_mode_and_the_account_override_resolve_like_the_web() {
    let Some(pool) = pool().await else { return };
    // engine on, group target 3 pips over a 1.7-pip raw spread -> +1.3 pips -> 4299.26 >= SL: fires at 4299.26
    let w = world(&pool, &Pricing { engine: true, group_target: Some(dec!(3)), group_markup: Some(dec!(9)), ..Default::default() }, dec!(100000), Some(SL)).await;
    let (w_pool, w_acct) = (w.pool.clone(), w.account.clone());
    let (shadow, live) = run(&w, async move {
        let positions = order_management::book::open_positions_with_market(&w_pool, &w_acct).await.unwrap();
        assert_eq!(positions[0].ask_rule, Some(AskRule::Target { target_pips: dec!(3), fallback_pips: Some(dec!(9)), digits: 2 }));
        World { pool: w_pool, broker: String::new(), account: w_acct, symbol: String::new(), symbol_name: String::new() }.shadow_then_live().await
    }).await;
    // (4290.00 - 4299.26) x 10 = -92.60
    assert_eq!(shadow, vec![(Kind::StopLoss, dec!(4299.26), dec!(-92.60))]);
    assert_eq!(live, vec![(dec!(4299.26), dec!(-92.60))]);

    // an AccountSymbolConfig markup of 0.2 pips beats the group target: 4299.15 < SL, nothing fires
    let w = world(&pool, &Pricing { engine: true, group_target: Some(dec!(3)), account_symbol_markup: Some(dec!(0.2)), ..Default::default() }, dec!(100000), Some(SL)).await;
    let (w_pool, w_acct) = (w.pool.clone(), w.account.clone());
    let (shadow, live) = run(&w, async move {
        let positions = order_management::book::open_positions_with_market(&w_pool, &w_acct).await.unwrap();
        assert_eq!(positions[0].ask_rule, Some(AskRule::Markup { markup_pips: dec!(0.2), digits: 2 }));
        World { pool: w_pool, broker: String::new(), account: w_acct, symbol: String::new(), symbol_name: String::new() }.shadow_then_live().await
    }).await;
    assert!(shadow.is_empty() && live.is_empty());
}

#[tokio::test]
async fn the_margin_trigger_book_carries_the_rule_and_values_the_sell_at_the_account_ask() {
    let Some(pool) = pool().await else { return };
    let w = world(&pool, &Pricing { group_markup: Some(dec!(1.5)), ..Default::default() }, dec!(307), None).await;
    let (w_pool, w_acct, w_sym) = (w.pool.clone(), w.account.clone(), w.symbol_name.clone());
    run(&w, async move {
        let book = order_management::margin_watch::load_book(&w_pool).await.unwrap();
        let acct = book.accounts.iter().find(|a| a.id == w_acct).expect("the test account is in the book");
        assert_eq!(acct.positions[0].ask_rule, Some(AskRule::Markup { markup_pips: dec!(1.5), digits: 2 }));
        let cache = market_data::cache::TickCache::new();
        let t: protocol::Tick = serde_json::from_value(serde_json::json!({ "symbol": w_sym, "bid": "4298.96", "ask": "4299.13" })).unwrap();
        cache.set(&t, chrono::Utc::now());
        let (equity, used) = order_management::margin_watch::measure(acct, &cache);
        // at the account ask 4299.28: equity 307 - 92.80, margin 10 x 4299.28 / 100
        assert_eq!(equity, dec!(214.20));
        assert_eq!(used, dec!(429.928));
    }).await;
}
