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

// SYMMETRIC MARKUP (2026-10-29): the account's ask carries HALF the markup, so an SL that has to sit
// between the raw ask (4299.13) and the account ask is 4299.20 now, not 4299.25 -- a 1.5-pip markup
// puts the account ask at ceil(4299.13 + 0.075) = 4299.21, where it used to be 4299.28.
const SL: Decimal = dec!(4299.20);

#[tokio::test]
async fn a_sell_sl_between_the_raw_and_the_account_ask_fires_at_the_account_ask_in_shadow_and_live() {
    let Some(pool) = pool().await else { return };
    // engine off, group markup 1.5 pips (Futurix Standard's shape): account ask = ceil(4299.13 + 0.075) = 4299.21 >= SL 4299.20
    let w = world(&pool, &Pricing { group_markup: Some(dec!(1.5)), broker_markup: dec!(0.5), ..Default::default() }, dec!(100000), Some(SL)).await;
    let (w_pool, w_acct) = (w.pool.clone(), w.account.clone());
    let (shadow, live) = run(&w, async move {
        let positions = order_management::book::open_positions_with_market(&w_pool, &w_acct).await.unwrap();
        assert_eq!(positions[0].ask_rule, Some(AskRule::Markup { markup_pips: dec!(1.5), digits: 2 }), "the group's markup wins over the broker's");
        World { pool: w_pool.clone(), broker: String::new(), account: w_acct.clone(), symbol: String::new(), symbol_name: String::new() }.shadow_then_live().await
    }).await;
    // P&L = (4290.00 - 4299.21) x 1 x 10 = -92.10
    assert_eq!(shadow, vec![(Kind::StopLoss, dec!(4299.21), dec!(-92.10))]);
    assert_eq!(live, vec![(dec!(4299.21), dec!(-92.10))], "live closes at the same price and P&L as the shadow decided");
}

#[tokio::test]
async fn a_sell_is_stopped_out_on_its_account_ask_when_the_raw_ask_would_leave_it_above() {
    let Some(pool) = pool().await else { return };
    // balance 307, SELL 10 x 4290 at leverage 100:
    //   raw     ask 4299.13: equity 307 - 91.30 = 215.70 / margin 429.913 = 50.17 %  (> 50: no stop-out)
    //   account ask 4299.21: equity 307 - 92.10 = 214.90 / margin 429.921 = 49.99 %  (<= 50: stop-out)
    let w = world(&pool, &Pricing { group_markup: Some(dec!(1.5)), ..Default::default() }, dec!(307), None).await;
    let (w_pool, w_acct) = (w.pool.clone(), w.account.clone());
    let (shadow, live) = run(&w, async move {
        World { pool: w_pool, broker: String::new(), account: w_acct, symbol: String::new(), symbol_name: String::new() }.shadow_then_live().await
    }).await;
    assert_eq!(shadow, vec![(Kind::StopOut, dec!(4299.21), dec!(-92.10))]);
    assert_eq!(live, vec![(dec!(4299.21), dec!(-92.10))]);
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
    assert!(shadow.is_empty() && live.is_empty(), "raw ask 4299.13 is below the SL 4299.20: nothing fires");
}

#[tokio::test]
async fn pricing_engine_target_mode_and_the_account_override_resolve_like_the_web() {
    let Some(pool) = pool().await else { return };
    // engine on, group target 4 pips over a 1.7-pip raw spread -> +2.3 pips of spread -> HALF (0.115) each side,
    // so the account ask is ceil(4299.13 + 0.115) = 4299.25 >= SL 4299.20: fires at 4299.25.
    let w = world(&pool, &Pricing { engine: true, group_target: Some(dec!(4)), group_markup: Some(dec!(9)), ..Default::default() }, dec!(100000), Some(SL)).await;
    let (w_pool, w_acct) = (w.pool.clone(), w.account.clone());
    let (shadow, live) = run(&w, async move {
        let positions = order_management::book::open_positions_with_market(&w_pool, &w_acct).await.unwrap();
        assert_eq!(positions[0].ask_rule, Some(AskRule::Target { target_pips: dec!(4), fallback_pips: Some(dec!(9)), digits: 2 }));
        World { pool: w_pool, broker: String::new(), account: w_acct, symbol: String::new(), symbol_name: String::new() }.shadow_then_live().await
    }).await;
    // (4290.00 - 4299.25) x 10 = -92.50
    assert_eq!(shadow, vec![(Kind::StopLoss, dec!(4299.25), dec!(-92.50))]);
    assert_eq!(live, vec![(dec!(4299.25), dec!(-92.50))]);

    // an AccountSymbolConfig markup of 0.2 pips beats the group target: ceil(4299.13 + 0.01) = 4299.14 < SL, nothing fires
    let w = world(&pool, &Pricing { engine: true, group_target: Some(dec!(4)), account_symbol_markup: Some(dec!(0.2)), ..Default::default() }, dec!(100000), Some(SL)).await;
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
        // at the account ask 4299.21: equity 307 - 92.10, margin 10 x 4299.21 / 100
        assert_eq!(equity, dec!(214.90));
        assert_eq!(used, dec!(429.921));
    }).await;
}

// ── FLIP L2 (2026-11-02): the FILL path resolves the same rule as the QUOTING path ──────────────
//
// engine/order-management/src/pricing.rs used to read BrokerSymbol.spreadMarkup alone and widen only
// the ask, so at ENGINE_ORDER_MANAGEMENT=on a group / account override and every target-spread rule
// vanished from the fill, and a SELL filled at the raw bid. `db::get_ask_levels` + `ask_markup::resolve`
// now resolve it, and this asserts the two resolvers agree ROW FOR ROW with the cached one the quoting
// path uses (`PricingSnapshot::rule`) across every pricing shape -- a markup, a group override, a
// per-account override, target mode, and a coverage account.

/// Every shape, as (label, pricing, expected account bid, expected account ask) off raw 4298.96 / 4299.13
/// (digits 2, pip 0.1, raw spread 1.7 pips). Half the markup each side, rounded AWAY from the client.
/// The same four numbers the web pins in tests/pentest/markup-leak.test.ts.
fn shapes() -> Vec<(&'static str, Pricing, Decimal, Decimal)> {
    vec![
        ("broker 1.5 pips", Pricing { broker_markup: dec!(1.5), ..Default::default() }, dec!(4298.88), dec!(4299.21)),
        ("group 2 pips over a broker default", Pricing { broker_markup: dec!(1.5), group_markup: Some(dec!(2)), ..Default::default() }, dec!(4298.86), dec!(4299.23)),
        (
            "pricing engine: a per-account override beats the group",
            Pricing { engine: true, broker_markup: dec!(1.5), group_markup: Some(dec!(2)), account_symbol_markup: Some(dec!(0.7)), ..Default::default() },
            dec!(4298.92),
            dec!(4299.17),
        ),
        (
            "pricing engine: group target 5 pips over a 1.7-pip raw spread",
            Pricing { engine: true, broker_markup: dec!(1.5), group_target: Some(dec!(5)), ..Default::default() },
            dec!(4298.79),
            dec!(4299.30),
        ),
        ("a coverage group prices raw", Pricing { coverage_group: true, broker_markup: dec!(3), ..Default::default() }, dec!(4298.96), dec!(4299.13)),
    ]
}

#[tokio::test]
async fn the_fill_path_resolves_the_same_rule_as_the_quoting_path_for_every_shape() {
    let Some(pool) = pool().await else { return };
    for (label, pr, want_bid, want_ask) in shapes() {
        let w = world(&pool, &pr, dec!(100000), None).await;
        let (w_pool, broker, account, symbol, symbol_name) =
            (w.pool.clone(), w.broker.clone(), w.account.clone(), w.symbol.clone(), w.symbol_name.clone());
        run(&w, async move {
            // what the FILL path now resolves (one fresh read, no cache)
            let levels = order_management::db::get_ask_levels(&w_pool, &broker, &account, &symbol_name)
                .await
                .unwrap()
                .expect("the Symbol row exists");
            let fill_rule = market_data::ask_markup::resolve(&levels);

            // what the QUOTING path resolves (the cached snapshot)
            let group: (Option<String>,) = sqlx::query_as(r#"SELECT "groupId" FROM "Account" WHERE id = $1"#)
                .bind(&account)
                .fetch_one(&w_pool)
                .await
                .unwrap();
            let mut conn = w_pool.acquire().await.unwrap();
            let snap = market_data::ask_markup::PricingSnapshot::load(&mut conn, None).await.unwrap();
            let quote_rule = snap.rule(market_data::ask_markup::RuleKey {
                account_id: &account,
                broker_id: &broker,
                group_id: group.0.as_deref(),
                symbol_id: &symbol,
                digits: 2,
            });

            assert_eq!(fill_rule, quote_rule, "{label}: the fill and the quote must resolve the SAME rule");

            // and the fill prices off it symmetrically, both sides, mid preserved
            let raw = protocol::Tick {
                symbol: symbol_name.clone(),
                bid: dec!(4298.96),
                ask: dec!(4299.13),
                t0: None,
                clock_offset_ms: None,
                rtt_ms: None,
                tick_ms: None,
                broker_offset_sec: None,
                bars: Vec::new(),
            };
            let quoted = order_management::pricing::quoted_tick(&raw, fill_rule.as_ref());
            assert_eq!((quoted.bid, quoted.ask), (want_bid, want_ask), "{label}: account bid / ask");
            assert!(quoted.bid <= raw.bid && quoted.ask >= raw.ask, "{label}: a markup may never tighten the book");
        })
        .await;
    }
}

#[tokio::test]
async fn an_unknown_symbol_leaves_the_fill_raw_rather_than_failing() {
    let Some(pool) = pool().await else { return };
    let levels = order_management::db::get_ask_levels(&pool, "no-such-broker", "no-such-account", "ZZ_NO_SUCH_SYMBOL").await.unwrap();
    assert!(levels.is_none(), "no Symbol row = None, the long-standing benign fallback");
}

/// The per-tick pending scan reads each resting order's pricing levels in its OWN query (the five
/// config LEFT JOINs in `db::get_pending_orders_for_symbol`), so the entry test and the fill price
/// off one resolved rule without a read per order. This exercises that SQL against a real database:
/// the Rust-side behaviour is unit-tested in pending_orders.rs, but the joins are only ever checked
/// here, and they span the engine's own `orders` table and the five Prisma config tables.
#[tokio::test]
async fn the_pending_scan_carries_each_orders_resolved_rule() {
    let Some(pool) = pool().await else { return };
    for (label, pr, want_bid, want_ask) in shapes() {
        let w = world(&pool, &pr, dec!(100000), None).await;
        let (w_pool, account, symbol_name) = (w.pool.clone(), w.account.clone(), w.symbol_name.clone());
        run(&w, async move {
            // a resting BUY LIMIT on the engine's own order table, for this account and symbol
            let id = format!("pnd-{}", Uuid::new_v4().simple());
            sqlx::query(
                r#"INSERT INTO orders (id, broker_id, account_id, symbol, side, type, status, volume, requested_price)
                   SELECT $1, a."brokerId", a.id, $2, 'BUY'::order_side, 'LIMIT'::order_type, 'ACCEPTED'::order_status, 1, 4290.00
                     FROM "Account" a WHERE a.id = $3"#,
            )
            .bind(&id)
            .bind(&symbol_name)
            .bind(&account)
            .execute(&w_pool)
            .await
            .unwrap();

            let pending = order_management::db::get_pending_orders_for_symbol(&w_pool, order_management::db::Book::Legacy, &symbol_name).await.unwrap();
            let mine = pending.iter().find(|o| o.id == id).expect("the resting order comes back from the scan");
            let rule = mine.ask_levels.as_ref().and_then(market_data::ask_markup::resolve);

            let raw = protocol::Tick {
                symbol: symbol_name.clone(),
                bid: dec!(4298.96),
                ask: dec!(4299.13),
                t0: None,
                clock_offset_ms: None,
                rtt_ms: None,
                tick_ms: None,
                broker_offset_sec: None,
                bars: Vec::new(),
            };
            let quoted = order_management::pricing::quoted_tick(&raw, rule.as_ref());
            assert_eq!((quoted.bid, quoted.ask), (want_bid, want_ask), "{label}: the scan's own levels must resolve to the same quote as the fill path");

            sqlx::query("DELETE FROM orders WHERE id = $1").bind(&id).execute(&w_pool).await.unwrap();
        })
        .await;
    }
}
