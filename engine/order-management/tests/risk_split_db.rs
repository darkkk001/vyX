//! Rust cutover Stage 6: the ENGINE side of the risk-authority split, against real rows on the scratch DB (the web side is
//! lib/risk-split.test.ts, lib/risk-split-stale.test.ts, lib/risk-owner.test.ts; both together are scripts/load/run.sh --split).
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test risk_split_db -- --nocapture
//!
//! Every test runs with authority::enforce() on (what the server does in every live mode) and one at a time (they share the
//! database's RUST-owned accounts, which a pass lists). Committed rows, cleaned up by broker.
//!
//! The four combinations the owner named, each with a DEMO and a LIVE account in three situations the risk path acts on (a
//! stop-out, an SL touch, a margin call):
//!   WEB broker / WEB with the demo-only flag off / RUST + demo-only / RUST + all accounts.
//! The engine must act on exactly the accounts risk_owner_of gives it, by the pass AND by a fire, write nothing for the others,
//! and be refused INSIDE its own transaction when the account changes hands.

use market_data::cache::TickCache;
use market_data::risk_hook::{FireSource, LiveFire};
use order_management::authority::{self, risk_owner_of, RiskOwner};
use order_management::{book, monitor};
use protocol::Tick;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("risk_split_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(sqlx::postgres::PgPoolOptions::new().max_connections(16).connect(&url).await.expect("connect to the scratch DB"))
}

/// Serializes the tests of this file (a pass lists every RUST-owned account in the database), switches enforcement on, and removes what an
/// earlier run left behind (a test that panics skips its own cleanup; a leftover RUST broker would be acted on by the next pass, and a
/// leftover symbol would show up in other suites' checks of the shared database).
async fn exclusive(pool: &PgPool) -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        authority::enforce();
        let path = std::env::temp_dir().join(format!("risk-split-engine-{}.jsonl", Uuid::new_v4()));
        std::env::set_var("VYX_RISK_ACTION_TRACE", &path);
    });
    let guard = LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    for table in ["PostCloseEffect", "Notification", "AuditLog", "Transaction", "Position", "Order", "Account", "BrokerSymbol", "Group"] {
        sqlx::query(&format!(r#"DELETE FROM "{table}" WHERE "brokerId" LIKE 'split-%'"#)).execute(pool).await.unwrap();
    }
    sqlx::query(r#"DELETE FROM "Broker" WHERE id LIKE 'split-%'"#).execute(pool).await.unwrap();
    sqlx::query(r#"DELETE FROM "Symbol" WHERE id LIKE 'split-s-%'"#).execute(pool).await.unwrap();
    // the engine-down watchdog (Stage 6): every test starts with a heartbeat that is fresh for a year, so the split tests prove the SPLIT
    // (the watchdog tests below set their own ages)
    set_heartbeat(pool, 0, 31_536_000).await;
    guard
}

/// The heartbeat row as a test wants it: last beat `age_secs` ago by the database clock, stale after `stale_after` seconds.
async fn set_heartbeat(pool: &PgPool, age_secs: i64, stale_after: i32) {
    sqlx::query(
        r#"INSERT INTO "RiskEngineHeartbeat" (name, "beatAt", "staleAfterSecs") VALUES ('risk', clock_timestamp() - ($1 || ' seconds')::interval, $2)
           ON CONFLICT (name) DO UPDATE SET "beatAt" = clock_timestamp() - ($1 || ' seconds')::interval, "staleAfterSecs" = $2"#,
    )
    .bind(age_secs.to_string())
    .bind(stale_after)
    .execute(pool)
    .await
    .unwrap();
}

fn trace_lines() -> Vec<serde_json::Value> {
    let path = std::env::var("VYX_RISK_ACTION_TRACE").unwrap();
    std::fs::read_to_string(path).unwrap_or_default().lines().filter(|l| !l.is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    StopOut,
    SlTouch,
    MarginCall,
}

#[derive(Clone, Debug)]
struct Acct {
    id: String,
    mode: &'static str,
    kind: Kind,
    position: String,
}

struct World {
    broker: String,
    group: String,
    symbol: String,
    symbol_name: String,
    accounts: Vec<Acct>,
}

const COMBINATIONS: [(&str, &str, bool); 4] = [
    ("WEB broker", "WEB", true),
    ("WEB broker, demo-only off", "WEB", false),
    ("RUST + demo-only", "RUST", true),
    ("RUST + all accounts", "RUST", false),
];

async fn broker_and_symbol(pool: &PgPool, authority: &str, demo_only: bool) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, symbol) = (format!("split-{tag}"), format!("split-g-{tag}"), format!("split-s-{tag}"));
    // not a "v*" name: those are the synthetic feed's symbols (other suites check the shared database for them)
    let symbol_name = format!("ZSP{}", &tag[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "riskAuthority", "riskAuthorityDemoOnly", "updatedAt") VALUES ($1, $1, $1, $2::"RiskAuthority", $3, now())"#)
        .bind(&broker).bind(authority).bind(demo_only).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, leverage, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 1, 100, 50, now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, $2, 'USD', 2, 1, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "hedgedMarginPct", "updatedAt") VALUES ($1, $2, $3, 200, now())"#)
        .bind(format!("split-bs-{tag}")).bind(&broker).bind(&symbol).execute(pool).await.unwrap();
    World { broker, group, symbol, symbol_name, accounts: Vec::new() }
}

async fn add_account(pool: &PgPool, w: &World, mode: &str, balance: Decimal, sl: Option<Decimal>, n: usize) -> (String, Vec<String>) {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let account = format!("split-a-{tag}");
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'Split Test', $6::"AccountMode", $7, 1, now())"#,
    )
    .bind(&account).bind(&w.broker).bind(&w.group).bind(format!("2{}", &tag[..7])).bind(format!("split-{tag}@test.local")).bind(mode).bind(balance)
    .execute(pool).await.unwrap();
    let mut positions = Vec::new();
    for i in 0..n {
        let (order, position) = (format!("split-o-{tag}-{i}"), format!("split-p-{tag}-{i}"));
        sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 1, 'FILLED', $1, now())"#)
            .bind(&order).bind(&w.broker).bind(&account).bind(&w.symbol).execute(pool).await.unwrap();
        let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
        sqlx::query(
            r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", "slPrice", ticket, "openedAt")
               VALUES ($1, $2, $3, $4, $5, 'BUY', 1, 100, $6, $7, now() + ($8 || ' milliseconds')::interval)"#,
        )
        .bind(&position).bind(&w.broker).bind(&account).bind(&w.symbol).bind(&order).bind(sl).bind(ticket).bind(i.to_string())
        .execute(pool).await.unwrap();
        positions.push(position);
    }
    (account, positions)
}

/// A DEMO and a LIVE account in each of the three situations; the price will be 90 (leverage 1, contract 1: margin = price).
async fn world(pool: &PgPool, authority: &str, demo_only: bool) -> World {
    let mut w = broker_and_symbol(pool, authority, demo_only).await;
    for mode in ["DEMO", "LIVE"] {
        for (kind, balance, sl) in [(Kind::StopOut, dec!(20), None), (Kind::SlTouch, dec!(100000), Some(dec!(95))), (Kind::MarginCall, dec!(80), None)] {
            let (id, positions) = add_account(pool, &w, mode, balance, sl, 1).await;
            w.accounts.push(Acct { id, mode: if mode == "DEMO" { "DEMO" } else { "LIVE" }, kind, position: positions[0].clone() });
        }
    }
    w
}

/// Waits until nothing is writing for this broker any more (the live worker may still be finishing the stop-out it was fired for: it closes the
/// next position after the one a test asserted on), then deletes what the test made.
async fn cleanup(pool: &PgPool, w: &World) {
    let mut last = (-1i64, -1i64);
    let mut quiet = 0;
    for _ in 0..100 {
        let a: (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Transaction" WHERE "brokerId" = $1"#).bind(&w.broker).fetch_one(pool).await.unwrap();
        let b: (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "PostCloseEffect" WHERE "brokerId" = $1"#).bind(&w.broker).fetch_one(pool).await.unwrap();
        quiet = if (a.0, b.0) == last { quiet + 1 } else { 0 };
        last = (a.0, b.0);
        if quiet >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for sql in [
        r#"DELETE FROM "PostCloseEffect" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Notification" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "AuditLog" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Transaction" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "BrokerSymbol" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Broker" WHERE id = $1"#,
    ] {
        sqlx::query(sql).bind(&w.broker).execute(pool).await.unwrap();
    }
    sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&w.symbol).execute(pool).await.unwrap();
}

fn tick(symbol: &str, bid: Decimal) -> Tick {
    serde_json::from_value(serde_json::json!({ "symbol": symbol, "bid": bid, "ask": bid })).unwrap()
}

fn cache_at(symbol: &str, bid: Decimal) -> Arc<TickCache> {
    let c = TickCache::new();
    c.set(&tick(symbol, bid), chrono::Utc::now());
    Arc::new(c)
}

async fn status(pool: &PgPool, position: &str) -> String {
    sqlx::query_as::<_, (String,)>(r#"SELECT status::text FROM "Position" WHERE id = $1"#).bind(position).fetch_one(pool).await.unwrap().0
}

async fn flag(pool: &PgPool, account: &str) -> bool {
    sqlx::query_as::<_, (bool,)>(r#"SELECT "marginCallNotifiedAt" IS NOT NULL FROM "Account" WHERE id = $1"#).bind(account).fetch_one(pool).await.unwrap().0
}

async fn count(pool: &PgPool, sql: &str, bind: &str) -> i64 {
    sqlx::query_as::<_, (i64,)>(sql).bind(bind).fetch_one(pool).await.unwrap().0
}

/// What the engine did to each account of `w`, against the rule.
async fn assert_engine_acted_exactly_on_its_own(pool: &PgPool, w: &World, authority_name: &str, demo_only: bool, how: &str) {
    for a in &w.accounts {
        let engine_owns = risk_owner_of(Some(authority_name), Some(demo_only), Some(a.mode)) == RiskOwner::Rust;
        let label = format!("{how}: {authority_name} demo-only={demo_only} {} {:?}", a.mode, a.kind);
        match a.kind {
            Kind::MarginCall => {
                assert_eq!(status(pool, &a.position).await, "OPEN", "{label}: a margin call closes nothing");
                assert_eq!(flag(pool, &a.id).await, engine_owns, "{label}: the margin-call edge");
                let notices = count(pool, r#"SELECT count(*) FROM "PostCloseEffect" WHERE "accountId" = $1 AND kind = 'MARGIN_CALL'"#, &a.id).await;
                assert_eq!(notices, engine_owns as i64, "{label}: the margin-call notice row");
            }
            _ => {
                assert_eq!(status(pool, &a.position).await == "CLOSED", engine_owns, "{label}: closed");
                assert_eq!(count(pool, r#"SELECT count(*) FROM "Transaction" WHERE "accountId" = $1 AND type = 'TRADE_PNL'"#, &a.id).await, engine_owns as i64, "{label}: TRADE_PNL rows");
                assert_eq!(count(pool, r#"SELECT count(*) FROM "PostCloseEffect" WHERE "accountId" = $1 AND kind = 'POSITION_CLOSED'"#, &a.id).await, engine_owns as i64, "{label}: outbox rows");
            }
        }
    }
    // every action in the trace is the engine's, on an account the rule gives it, and every owned account was acted on
    let mine: Vec<serde_json::Value> = trace_lines().into_iter().filter(|t| w.accounts.iter().any(|a| Some(a.id.as_str()) == t["accountId"].as_str())).collect();
    for t in &mine {
        assert_eq!(t["actor"], "RUST", "{how}: {t}");
    }
    for a in &w.accounts {
        let engine_owns = risk_owner_of(Some(authority_name), Some(demo_only), Some(a.mode)) == RiskOwner::Rust;
        assert_eq!(mine.iter().any(|t| t["accountId"] == a.id.as_str()), engine_owns, "{how}: {} {:?} acted on", a.mode, a.kind);
    }
}

#[tokio::test]
async fn every_combination_the_engine_pass_acts_on_exactly_the_accounts_the_rule_gives_it() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    for (name, authority_name, demo_only) in COMBINATIONS {
        let w = world(&pool, authority_name, demo_only).await;
        let cache = cache_at(&w.symbol_name, dec!(90));
        let report = book::with_price_source(book::PriceSource::Ticks(cache), monitor::run_pass(&pool, None, &mut monitor::PassCursor::default())).await;
        assert_eq!(report.errors, 0, "{name}");
        assert_engine_acted_exactly_on_its_own(&pool, &w, authority_name, demo_only, &format!("pass, {name}")).await;
        cleanup(&pool, &w).await;
    }
}

#[tokio::test]
async fn every_combination_a_fire_for_any_account_acts_only_on_the_ones_the_engine_owns() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    for (name, authority_name, demo_only) in COMBINATIONS {
        let w = world(&pool, authority_name, demo_only).await;
        let cache = cache_at(&w.symbol_name, dec!(90));
        // a fire for EVERY account, as if the routing cache had said "engine" for all of them (a stale cache): the evaluation
        // itself reads the database's answer and drops the accounts that are not the engine's
        for a in &w.accounts {
            let fire = LiveFire { account_id: a.id.clone(), ticks: HashMap::from([(w.symbol_name.clone(), (dec!(90), dec!(90), chrono::Utc::now()))]), source: FireSource::Margin };
            let r = book::with_price_source(book::PriceSource::Ticks(cache.clone()), monitor::evaluate_live_fire(&pool, None, fire)).await.unwrap().expect("evaluated or dropped");
            let engine_owns = risk_owner_of(Some(authority_name), Some(demo_only), Some(a.mode)) == RiskOwner::Rust;
            assert_eq!(r.not_owner, !engine_owns, "{name}: {} {:?} dropped as not ours", a.mode, a.kind);
        }
        assert_engine_acted_exactly_on_its_own(&pool, &w, authority_name, demo_only, &format!("fire, {name}")).await;
        cleanup(&pool, &w).await;
    }
}

/// The rule in its three forms agrees on every cell of the cross product the schema allows: risk_owner_of, the SQL predicate
/// the pass lists with, the single-account read, and the in-transaction read.
#[tokio::test]
async fn the_sql_forms_of_the_rule_agree_with_risk_owner_of_on_every_combination() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    for authority_name in ["WEB", "RUST"] {
        for demo_only in [true, false] {
            let mut w = broker_and_symbol(&pool, authority_name, demo_only).await;
            for mode in ["DEMO", "LIVE"] {
                let (id, positions) = add_account(&pool, &w, mode, dec!(1000), None, 1).await;
                w.accounts.push(Acct { id, mode: if mode == "DEMO" { "DEMO" } else { "LIVE" }, kind: Kind::StopOut, position: positions[0].clone() });
            }
            let listed = authority::rust_owned_account_ids_with_open_positions(&pool).await.unwrap();
            for a in &w.accounts {
                let rule = risk_owner_of(Some(authority_name), Some(demo_only), Some(a.mode));
                let label = format!("{authority_name} demo-only={demo_only} {}", a.mode);
                assert_eq!(listed.contains(&a.id), rule == RiskOwner::Rust, "{label}: the pass's listing");
                assert_eq!(authority::owner_of_account(&pool, &a.id).await.unwrap(), Some(rule), "{label}: owner_of_account");
                let mut tx = pool.begin().await.unwrap();
                assert_eq!(authority::lock_owner_in_tx(&mut tx, &a.id).await.unwrap(), Some(rule), "{label}: lock_owner_in_tx");
                tx.rollback().await.unwrap();
            }
            // the pass order is the account id's byte order
            let mut sorted = listed.clone();
            sorted.sort();
            assert_eq!(listed, sorted);
            cleanup(&pool, &w).await;
        }
    }
    assert_eq!(authority::owner_of_account(&pool, "no-such-account").await.unwrap(), None);
}

async fn wait_blocked(pool: &PgPool, like: &str) -> bool {
    for _ in 0..200 {
        let (n,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1"#).bind(like).fetch_one(pool).await.unwrap();
        if n > 0 {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

/// The handoff, in the database: a flip WAITS for a close the engine has already authorised (its FOR SHARE on the broker row),
/// and the engine's NEXT close, after the flip, is refused inside its transaction and writes nothing.
#[tokio::test]
async fn a_flip_waits_for_an_engine_close_in_flight_and_the_next_engine_close_is_refused() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    let mut w = broker_and_symbol(&pool, "RUST", false).await;
    let (account, positions) = add_account(&pool, &w, "LIVE", dec!(1000), None, 2).await;
    w.accounts.push(Acct { id: account.clone(), mode: "LIVE", kind: Kind::StopOut, position: positions[0].clone() });

    let mut tx = pool.begin().await.unwrap();
    let first = book::close_position_as(&mut tx, Some(RiskOwner::Rust), &positions[0], dec!(1), dec!(90), dec!(-10), "Stop-out (automatic): test").await.unwrap();
    assert!(matches!(first, book::CloseResult::Closed(_)));

    // the flip arrives while that transaction is open
    let flip_pool = pool.clone();
    let broker = w.broker.clone();
    let flip = tokio::spawn(async move { sqlx::query(r#"UPDATE "Broker" SET "riskAuthority" = 'WEB' WHERE id = $1"#).bind(&broker).execute(&flip_pool).await });
    assert!(wait_blocked(&pool, "UPDATE \"Broker\" SET \"riskAuthority\"%").await, "the flip is blocked on the engine's in-flight close");
    assert!(!flip.is_finished());
    tx.commit().await.unwrap();
    flip.await.unwrap().unwrap();

    // the first close stands (it was the owner's); the second is refused inside its own transaction
    assert_eq!(status(&pool, &positions[0]).await, "CLOSED");
    let mut tx2 = pool.begin().await.unwrap();
    let second = book::close_position_as(&mut tx2, Some(RiskOwner::Rust), &positions[1], dec!(1), dec!(90), dec!(-10), "Stop-out (automatic): test").await.unwrap();
    assert!(matches!(second, book::CloseResult::NotOwner(RiskOwner::Web)), "{second:?}");
    tx2.rollback().await.unwrap();
    assert_eq!(status(&pool, &positions[1]).await, "OPEN", "the refused close wrote nothing");
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "Transaction" WHERE "accountId" = $1 AND type = 'TRADE_PNL'"#, &account).await, 1);
    // and the web's check now passes
    let mut tx3 = pool.begin().await.unwrap();
    assert_eq!(authority::lock_owner_in_tx(&mut tx3, &account).await.unwrap(), Some(RiskOwner::Web));
    tx3.rollback().await.unwrap();
    // the margin-call edge is guarded the same way
    assert!(!book::apply_margin_call_edge_as(&pool, Some(RiskOwner::Rust), &account, book::MarginCallEdge::In { margin_level: dec!(80), call_level: dec!(100) }).await.unwrap());
    assert!(!flag(&pool, &account).await, "a refused margin-call edge writes no flag");
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "PostCloseEffect" WHERE "accountId" = $1 AND kind = 'MARGIN_CALL'"#, &account).await, 0);
    cleanup(&pool, &w).await;
}

/// The WEB-fallback drill, engine half: an evaluation is stopping an account out position by position; the owner flips the
/// broker back to WEB right after the FIRST close committed. The engine's next close is refused, it stops (no further close,
/// no margin-call edge), and what is left open is the web's to stop out (lib/risk-split-flip.test.ts and
/// scripts/load/run.sh --split-drill take it from there).
#[tokio::test]
async fn flipping_to_web_in_the_middle_of_an_engine_evaluation_stops_it_after_the_close_that_already_committed() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    let mut w = broker_and_symbol(&pool, "RUST", false).await;
    // three positions of 1 lot, 100 -> 90: equity 20 - 30 = -10: every one is stopped out in turn
    let (account, positions) = add_account(&pool, &w, "LIVE", dec!(20), None, 3).await;
    w.accounts.push(Acct { id: account.clone(), mode: "LIVE", kind: Kind::StopOut, position: positions[0].clone() });
    let cache = cache_at(&w.symbol_name, dec!(90));

    let (reached, go) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    *monitor::AFTER_CLOSE_HOOK.lock().unwrap() = Some((reached.clone(), go.clone()));
    let eval_pool = pool.clone();
    let acct = account.clone();
    let evaluation = tokio::spawn(book::with_price_source(book::PriceSource::Ticks(cache), async move { monitor::evaluate_account(&eval_pool, None, &acct).await }));
    tokio::time::timeout(Duration::from_secs(10), reached.notified()).await.expect("the first close committed");
    sqlx::query(r#"UPDATE "Broker" SET "riskAuthority" = 'WEB' WHERE id = $1"#).bind(&w.broker).execute(&pool).await.unwrap();
    go.notify_one();
    let report = evaluation.await.unwrap().unwrap().expect("evaluated");

    assert!(report.not_owner, "the evaluation noticed the flip: {report:?}");
    let open: i64 = count(&pool, r#"SELECT count(*) FROM "Position" WHERE "accountId" = $1 AND status = 'OPEN'"#, &account).await;
    assert_eq!(open, 2, "exactly one close happened before the flip, the engine acted on nothing after it");
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "Transaction" WHERE "accountId" = $1 AND type = 'TRADE_PNL'"#, &account).await, 1);
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "PostCloseEffect" WHERE "accountId" = $1"#, &account).await, 1, "one close, one follow-up row, no margin-call edge");
    assert!(!flag(&pool, &account).await);
    // the engine's next evaluation of that account drops it at the prefilter: it is the web's now
    let cache = cache_at(&w.symbol_name, dec!(90));
    let again = book::with_price_source(book::PriceSource::Ticks(cache), monitor::evaluate_account(&pool, None, &account)).await.unwrap().unwrap();
    assert!(again.not_owner);
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "Position" WHERE "accountId" = $1 AND status = 'OPEN'"#, &account).await, 2);
    cleanup(&pool, &w).await;
}

/// The unpinned fire (owner 2026-09-29): it carries the TICK, not the positions. The account's CURRENT positions are read
/// inside the evaluation: a position opened AFTER the fire is evaluated and stopped out; one closed since is not touched.
/// (A pinned evaluation, the shadow's, sees the account as it stood at the fire: the new position is invisible to it.)
#[tokio::test]
async fn the_fire_evaluates_the_accounts_current_positions_not_the_positions_at_the_fire() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    let mut w = broker_and_symbol(&pool, "RUST", false).await;
    // a healthy account at the fire: balance 1000, one 1-lot position 100 -> 90 (equity 990 on 90)
    let (account, first) = add_account(&pool, &w, "LIVE", dec!(1000), None, 1).await;
    w.accounts.push(Acct { id: account.clone(), mode: "LIVE", kind: Kind::MarginCall, position: first[0].clone() });
    let cache = cache_at(&w.symbol_name, dec!(90));
    let fire = LiveFire { account_id: account.clone(), ticks: HashMap::from([(w.symbol_name.clone(), (dec!(90), dec!(90), chrono::Utc::now()))]), source: FireSource::Margin };

    // ... then, before the evaluation runs, the account opens 20 lots 100 -> 90: equity 1000 - 210 = 790 on 1890 = 41.8 % (stop-out 50)
    let tag = Uuid::new_v4().simple().to_string()[..8].to_string();
    sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 20, 'FILLED', $1, now())"#)
        .bind(format!("late-o-{tag}")).bind(&w.broker).bind(&account).bind(&w.symbol).execute(&pool).await.unwrap();
    let ticket: i32 = (u32::from_str_radix(&tag[..7], 16).unwrap() % 2_000_000_000) as i32;
    sqlx::query(r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket, "openedAt") VALUES ($1, $2, $3, $4, $5, 'BUY', 20, 100, $6, now() + interval '5 seconds')"#)
        .bind(format!("late-p-{tag}")).bind(&w.broker).bind(&account).bind(&w.symbol).bind(format!("late-o-{tag}")).bind(ticket).execute(&pool).await.unwrap();

    let r = book::with_price_source(book::PriceSource::Ticks(cache), monitor::evaluate_live_fire(&pool, None, fire)).await.unwrap().unwrap();
    assert!(!r.closed.is_empty(), "the position opened after the fire was seen and stopped out: {r:?}");
    assert!(r.closed.iter().any(|(id, why)| *id == format!("late-p-{tag}") && *why == "stop_out"), "{r:?}");
    assert_eq!(status(&pool, &format!("late-p-{tag}")).await, "CLOSED");
    cleanup(&pool, &w).await;
}

/// The fire prices the symbols it names at THE TICK IT CARRIES (the one that crossed), not at whatever the cache holds by the time
/// the evaluation runs; a carried tick older than the web's 15 s freshness rule is ignored and the cache decides.
#[tokio::test]
async fn the_fire_prices_the_account_at_the_tick_it_carries() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    for (carried_age_secs, expected_close) in [(0i64, dec!(60)), (20, dec!(90))] {
        let mut w = broker_and_symbol(&pool, "RUST", false).await;
        let (account, positions) = add_account(&pool, &w, "LIVE", dec!(20), None, 1).await;
        w.accounts.push(Acct { id: account.clone(), mode: "LIVE", kind: Kind::StopOut, position: positions[0].clone() });
        // the cache has moved on to 90 (a stop-out at either price); the fire carries 60
        let cache = cache_at(&w.symbol_name, dec!(90));
        let fire = LiveFire {
            account_id: account.clone(),
            ticks: HashMap::from([(w.symbol_name.clone(), (dec!(60), dec!(60), chrono::Utc::now() - chrono::Duration::seconds(carried_age_secs)))]),
            source: FireSource::SlTp,
        };
        book::with_price_source(book::PriceSource::Ticks(cache), monitor::evaluate_live_fire(&pool, None, fire)).await.unwrap().unwrap();
        let (close_price,): (Decimal,) = sqlx::query_as(r#"SELECT "closePrice" FROM "Position" WHERE id = $1"#).bind(&positions[0]).fetch_one(&pool).await.unwrap();
        assert_eq!(close_price, expected_close, "carried tick {carried_age_secs} s old");
        cleanup(&pool, &w).await;
    }
}

/// CUTOVER GATE (docs/RUST-CUTOVER-PLAN.md 6.1, owner 2026-09-29): an S3-shaped ramp in RUST mode sends the margin-call notice
/// FROM THE FIRE (not the pass: no pass runs here) and stops the account out on the crossing tick. The web's call is not made for
/// the engine's account; for a WEB-owned account of the same book it still is.
#[tokio::test]
async fn an_s3_ramp_sends_the_margin_call_notice_from_the_fire_and_stops_out_on_the_crossing_tick() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    let mut w = broker_and_symbol(&pool, "RUST", true).await; // demo-only: DEMO is the engine's, LIVE the web's
    let (demo, demo_pos) = add_account(&pool, &w, "DEMO", dec!(20), None, 1).await;
    let (live, live_pos) = add_account(&pool, &w, "LIVE", dec!(20), None, 1).await;
    // leverage 10 (margin = price / 10): level(p) = 1000 x (20 + p - 100) / p, so 100 -> 200 %, 87 -> 80.5 % (call), 80 -> 0 % (stop-out)
    sqlx::query(r#"UPDATE "Account" SET leverage = 10 WHERE id = ANY($1)"#).bind(vec![demo.clone(), live.clone()]).execute(&pool).await.unwrap();
    w.accounts.push(Acct { id: demo.clone(), mode: "DEMO", kind: Kind::MarginCall, position: demo_pos[0].clone() });
    w.accounts.push(Acct { id: live.clone(), mode: "LIVE", kind: Kind::MarginCall, position: live_pos[0].clone() });

    let cache = cache_at(&w.symbol_name, dec!(100));
    let prices = book::PriceSource::Ticks(cache.clone());
    let sender = monitor::spawn_live_trigger(pool.clone(), prices, None, Arc::new(|| {}));
    let authority = authority::AuthorityCache::with_rust_brokers(&[(w.broker.as_str(), true)]);
    let watch = order_management::margin_watch::MarginWatch::new();
    watch.set_live(authority, sender);
    watch.reload(&pool).await;

    // the ramp: 100 (healthy, 200 %) -> 87 (margin call, 80.5 %) -> 80 (stop-out, equity 0)
    let t0 = std::time::Instant::now();
    cache.set(&tick(&w.symbol_name, dec!(100)), chrono::Utc::now());
    assert!(watch.decide(&[tick(&w.symbol_name, dec!(100))], &cache, t0).is_empty(), "healthy: nothing fires");
    cache.set(&tick(&w.symbol_name, dec!(87)), chrono::Utc::now());
    let web_symbols = watch.decide(&[tick(&w.symbol_name, dec!(87))], &cache, t0 + Duration::from_secs(1));
    assert_eq!(web_symbols, vec![w.symbol_name.clone()], "only the WEB-owned LIVE account asks the web: its symbol is returned for the hook's call");

    // the engine's notice arrives from the fire, with no pass running
    let mut notified = false;
    for _ in 0..200 {
        if flag(&pool, &demo).await {
            notified = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(notified, "the margin-call edge was written by the fire");
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "PostCloseEffect" WHERE "accountId" = $1 AND kind = 'MARGIN_CALL'"#, &demo).await, 1);
    assert!(!flag(&pool, &live).await, "the web's account is untouched by the engine");
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "PostCloseEffect" WHERE "accountId" = $1"#, &live).await, 0);

    // the crossing tick: stop-out, on that tick
    cache.set(&tick(&w.symbol_name, dec!(80)), chrono::Utc::now());
    let again = watch.decide(&[tick(&w.symbol_name, dec!(80))], &cache, t0 + Duration::from_secs(8));
    assert_eq!(again, vec![w.symbol_name.clone()], "the web account is at its stop-out too: still the web's call");
    let mut closed = false;
    for _ in 0..200 {
        if status(&pool, &demo_pos[0]).await == "CLOSED" {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(closed, "the engine stopped its account out from the fire");
    let (close_price, note): (Decimal, String) = sqlx::query_as(
        r#"SELECT p."closePrice", t.note FROM "Position" p JOIN "Transaction" t ON t."referenceId" = p.id AND t.type = 'TRADE_PNL' WHERE p.id = $1"#,
    )
    .bind(&demo_pos[0]).fetch_one(&pool).await.unwrap();
    assert_eq!(close_price, dec!(80), "closed at the crossing tick");
    assert!(note.starts_with("Stop-out (automatic): margin level"), "{note}");
    assert_eq!(status(&pool, &live_pos[0]).await, "OPEN", "the web account is the web's to stop out");
    cleanup(&pool, &w).await;
}

/// CUTOVER GATE (docs/RUST-CUTOVER-PLAN.md 6.1, owner 2026-10-01): a position opened just before a gap is not in the trigger's in-memory
/// book when the gap tick arrives (the book learns of a fill by a reload). In RUST mode the engine used to stop it out only at its next
/// 5 s pass. Now a reload the web ASKED for (a fill announcement) evaluates the engine-owned accounts at the latest prices at once.
/// CONTROL: the gap tick alone does not see the new position. Then the announced reload does, without any further tick and without a pass.
#[tokio::test]
async fn a_position_opened_just_before_a_gap_is_stopped_out_by_the_engine_on_the_announced_reload() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    let mut w = broker_and_symbol(&pool, "RUST", false).await;
    // a healthy account (balance 1000, leverage 10) with one 1-lot position 100: at the gap (80) it holds 12250 %
    let (account, first) = add_account(&pool, &w, "LIVE", dec!(1000), None, 1).await;
    sqlx::query(r#"UPDATE "Account" SET leverage = 10 WHERE id = $1"#).bind(&account).execute(&pool).await.unwrap();
    w.accounts.push(Acct { id: account.clone(), mode: "LIVE", kind: Kind::MarginCall, position: first[0].clone() });

    let cache = cache_at(&w.symbol_name, dec!(100));
    let sender = monitor::spawn_live_trigger(pool.clone(), book::PriceSource::Ticks(cache.clone()), None, Arc::new(|| {}));
    let authority = authority::AuthorityCache::with_rust_brokers(&[(w.broker.as_str(), false)]);
    let watch = order_management::margin_watch::MarginWatch::new();
    watch.set_live(authority, sender);
    // the real reload loop (a long safety interval: only an announced change reloads it): its first load is the book as of before the fill
    watch.spawn_reload_loop_with(pool.clone(), cache.clone(), Arc::new(|| Duration::from_secs(600)));
    for _ in 0..200 {
        if watch.book_symbols().is_some_and(|s| s.contains(&w.symbol_name)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(watch.book_symbols().is_some_and(|s| s.contains(&w.symbol_name)), "the first load");

    // the fill: 100 lots at 100 (opened after the book was loaded)
    let tag = Uuid::new_v4().simple().to_string()[..8].to_string();
    sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 100, 'FILLED', $1, now())"#)
        .bind(format!("gap-o-{tag}")).bind(&w.broker).bind(&account).bind(&w.symbol).execute(&pool).await.unwrap();
    let ticket: i32 = (u32::from_str_radix(&tag[..7], 16).unwrap() % 2_000_000_000) as i32;
    sqlx::query(r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket, "openedAt") VALUES ($1, $2, $3, $4, $5, 'BUY', 100, 100, $6, now() + interval '5 seconds')"#)
        .bind(format!("gap-p-{tag}")).bind(&w.broker).bind(&account).bind(&w.symbol).bind(format!("gap-o-{tag}")).bind(ticket).execute(&pool).await.unwrap();

    // the gap tick: the book does not hold the new position yet, so the tick alone fires nothing (the 2026-10-01 a4 case)
    cache.set(&tick(&w.symbol_name, dec!(80)), chrono::Utc::now());
    assert!(watch.decide(&[tick(&w.symbol_name, dec!(80))], &cache, std::time::Instant::now()).is_empty());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(status(&pool, &format!("gap-p-{tag}")).await, "OPEN", "control: nothing has acted on the gap tick alone");

    // the web announces the fill (book_events -> request_reload): the loop reloads the book and evaluates the engine-owned accounts
    // at the latest prices at once
    watch.request_reload();
    let mut closed = false;
    for _ in 0..200 {
        if status(&pool, &format!("gap-p-{tag}")).await == "CLOSED" {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(closed, "the new position was stopped out on the announced reload, with no further tick and no pass");
    let (close_price,): (Decimal,) = sqlx::query_as(r#"SELECT "closePrice" FROM "Position" WHERE id = $1"#).bind(format!("gap-p-{tag}")).fetch_one(&pool).await.unwrap();
    assert_eq!(close_price, dec!(80), "at the gap price");
    // a WEB-owned account in the same situation is not looked at by this path
    cleanup(&pool, &w).await;
}

// ---- the engine-down watchdog (docs/STAGE6-PLAN.md section 14) ---------------------------------------------------------------------

/// A stale heartbeat hands EVERY account to the web, in every form the engine reads the owner in: the pass listing, the single-account
/// read, the in-transaction read, the close and the margin-call edge (the two acting transactions), the fire. A fresh one hands them back.
#[tokio::test]
async fn a_stale_heartbeat_hands_every_account_to_the_web_in_every_form_and_a_beat_hands_them_back() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    let mut w = broker_and_symbol(&pool, "RUST", false).await;
    let (account, positions) = add_account(&pool, &w, "LIVE", dec!(20), None, 2).await;
    w.accounts.push(Acct { id: account.clone(), mode: "LIVE", kind: Kind::StopOut, position: positions[0].clone() });
    let (demo, _demo_pos) = add_account(&pool, &w, "DEMO", dec!(1000), None, 1).await;

    // fresh: the engine owns both
    set_heartbeat(&pool, 5, 30).await;
    assert_eq!(authority::owner_of_account(&pool, &account).await.unwrap(), Some(RiskOwner::Rust));
    assert!(authority::rust_owned_account_ids_with_open_positions(&pool).await.unwrap().contains(&account));

    // stale (the last beat 31 s ago, stale after 30 s)
    set_heartbeat(&pool, 31, 30).await;
    for id in [&account, &demo] {
        assert_eq!(authority::owner_of_account(&pool, id).await.unwrap(), Some(RiskOwner::Web), "prefilter read");
        let mut tx = pool.begin().await.unwrap();
        assert_eq!(authority::lock_owner_in_tx(&mut tx, id).await.unwrap(), Some(RiskOwner::Web), "in-transaction read");
        tx.rollback().await.unwrap();
    }
    let listed = authority::rust_owned_account_ids_with_open_positions(&pool).await.unwrap();
    assert!(!listed.contains(&account) && !listed.contains(&demo), "the pass lists nothing of a stale engine: {listed:?}");
    // the acting transactions refuse INSIDE themselves (the prefilter is bypassed here on purpose: this is the stalled engine that
    // decided before it stalled and acts after)
    let mut tx = pool.begin().await.unwrap();
    let refused = book::close_position_as(&mut tx, Some(RiskOwner::Rust), &positions[0], dec!(1), dec!(90), dec!(-10), "Stop-out (automatic): test").await.unwrap();
    assert!(matches!(refused, book::CloseResult::NotOwner(RiskOwner::Web)), "{refused:?}");
    tx.rollback().await.unwrap();
    assert_eq!(status(&pool, &positions[0]).await, "OPEN", "a stale engine's close wrote nothing");
    assert!(!book::apply_margin_call_edge_as(&pool, Some(RiskOwner::Rust), &account, book::MarginCallEdge::In { margin_level: dec!(80), call_level: dec!(100) }).await.unwrap());
    assert!(!flag(&pool, &account).await, "a stale engine's margin-call edge wrote nothing");
    // a whole evaluation and a fire do nothing too
    let cache = cache_at(&w.symbol_name, dec!(90));
    let r = book::with_price_source(book::PriceSource::Ticks(cache.clone()), monitor::evaluate_account(&pool, None, &account)).await.unwrap().unwrap();
    assert!(r.not_owner && r.closed.is_empty(), "{r:?}");
    let fire = LiveFire { account_id: account.clone(), ticks: HashMap::from([(w.symbol_name.clone(), (dec!(90), dec!(90), chrono::Utc::now()))]), source: FireSource::Margin };
    let r = book::with_price_source(book::PriceSource::Ticks(cache.clone()), monitor::evaluate_live_fire(&pool, None, fire)).await.unwrap().unwrap();
    assert!(r.not_owner && r.closed.is_empty(), "{r:?}");
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "Transaction" WHERE "accountId" = $1 AND type = 'TRADE_PNL'"#, &account).await, 0);
    assert!(trace_lines().iter().all(|t| t["accountId"] != account.as_str()), "no traced action: the stale engine took none");

    // a missing row is stale too
    sqlx::query(r#"DELETE FROM "RiskEngineHeartbeat" WHERE name = 'risk'"#).execute(&pool).await.unwrap();
    assert_eq!(authority::owner_of_account(&pool, &account).await.unwrap(), Some(RiskOwner::Web));

    // the engine returns: the first thing it does is beat; from then on it owns the accounts again and acts
    authority::beat(&pool).await.unwrap();
    assert_eq!(authority::owner_of_account(&pool, &account).await.unwrap(), Some(RiskOwner::Rust));
    let r = book::with_price_source(book::PriceSource::Ticks(cache), monitor::evaluate_account(&pool, None, &account)).await.unwrap().unwrap();
    assert!(!r.not_owner && !r.closed.is_empty(), "after a beat the engine acts again: {r:?}");
    cleanup(&pool, &w).await;
}

/// The lock that makes the stale reading trustworthy: a transaction that read "stale" (or "fresh") holds the heartbeat row FOR SHARE, so the
/// engine's next beat WAITS for it. Without the lock a beat could land between the reading and the action.
#[tokio::test]
async fn a_beat_waits_for_a_transaction_that_has_read_the_heartbeat() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    let mut w = broker_and_symbol(&pool, "RUST", false).await;
    let (account, positions) = add_account(&pool, &w, "LIVE", dec!(1000), None, 1).await;
    w.accounts.push(Acct { id: account.clone(), mode: "LIVE", kind: Kind::StopOut, position: positions[0].clone() });
    set_heartbeat(&pool, 5, 30).await;

    let mut tx = pool.begin().await.unwrap();
    assert_eq!(authority::lock_owner_in_tx(&mut tx, &account).await.unwrap(), Some(RiskOwner::Rust));
    let beat_pool = pool.clone();
    let beating = tokio::spawn(async move { authority::beat(&beat_pool).await });
    assert!(wait_blocked(&pool, "INSERT INTO \"RiskEngineHeartbeat\"%").await, "the beat is blocked on the acting transaction's share lock");
    assert!(!beating.is_finished());
    tx.commit().await.unwrap();
    beating.await.unwrap().unwrap();
    cleanup(&pool, &w).await;
}

/// ENGINE STALLS, THE WEB HANDLES THE NEXT STOP-OUT EXACTLY ONCE, THE ENGINE RESUMES, NOTHING IS DUPLICATED (engine half; the web half and the
/// real web walking the same database are lib/risk-watchdog.test.ts and scripts/load/run-split.sh --stall). The web's close is stood in for here by
/// the web actor of the same close routine (the web's own routine is lib/position-close.ts, proven in the split harness).
#[tokio::test]
async fn an_engine_stall_the_web_stops_out_once_and_the_returning_engine_duplicates_nothing() {
    let Some(pool) = pool().await else { return };
    let _x = exclusive(&pool).await;
    let mut w = broker_and_symbol(&pool, "RUST", false).await;
    // two positions of 1 lot, 100 -> 90, balance 20: equity -10, a stop-out
    let (account, positions) = add_account(&pool, &w, "LIVE", dec!(20), None, 2).await;
    w.accounts.push(Acct { id: account.clone(), mode: "LIVE", kind: Kind::StopOut, position: positions[0].clone() });
    let cache = cache_at(&w.symbol_name, dec!(90));

    // the engine is healthy, then STALLS: its last beat is 40 s old (stale after 30 s)
    set_heartbeat(&pool, 40, 30).await;
    // it wakes up inside an evaluation it started before the stall and acts: refused, nothing written
    let r = book::with_price_source(book::PriceSource::Ticks(cache.clone()), monitor::evaluate_account(&pool, None, &account)).await.unwrap().unwrap();
    assert!(r.not_owner);
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "Position" WHERE "accountId" = $1 AND status = 'OPEN'"#, &account).await, 2);

    // the web takes the stop-out (the web actor passes the same in-transaction check: a stale engine's account is WEB-owned)
    let mut tx = pool.begin().await.unwrap();
    let web = book::close_position_as(&mut tx, Some(RiskOwner::Web), &positions[0], dec!(1), dec!(90), dec!(-10), "Stop-out (automatic): web").await.unwrap();
    assert!(matches!(web, book::CloseResult::Closed(_)), "{web:?}");
    tx.commit().await.unwrap();
    // the engine returns and evaluates the same account again, in every way it can: an evaluation, a fire, a pass. Position 0 must not be closed twice
    authority::beat(&pool).await.unwrap();
    let r = book::with_price_source(book::PriceSource::Ticks(cache.clone()), monitor::evaluate_account(&pool, None, &account)).await.unwrap().unwrap();
    assert!(!r.not_owner, "the engine owns the account again after its beat: {r:?}");
    let fire = LiveFire { account_id: account.clone(), ticks: HashMap::from([(w.symbol_name.clone(), (dec!(90), dec!(90), chrono::Utc::now()))]), source: FireSource::Margin };
    book::with_price_source(book::PriceSource::Ticks(cache.clone()), monitor::evaluate_live_fire(&pool, None, fire)).await.unwrap();
    book::with_price_source(book::PriceSource::Ticks(cache), monitor::run_pass(&pool, None, &mut monitor::PassCursor::default())).await;

    // exactly one TRADE_PNL per position, never two; position 0 was the web's (no follow-up row: only an engine close queues one)
    let dup: Vec<(String, i64)> = sqlx::query_as(r#"SELECT "referenceId", count(*) FROM "Transaction" WHERE "accountId" = $1 AND type = 'TRADE_PNL' GROUP BY 1 HAVING count(*) > 1"#).bind(&account).fetch_all(&pool).await.unwrap();
    assert!(dup.is_empty(), "a position was closed twice: {dup:?}");
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "Transaction" WHERE "referenceId" = $1 AND type = 'TRADE_PNL'"#, &positions[0]).await, 1);
    assert_eq!(count(&pool, r#"SELECT count(*) FROM "PostCloseEffect" WHERE "positionId" = $1"#, &positions[0]).await, 0, "position 0 was closed by the web");
    assert!(trace_lines().iter().filter(|t| t["accountId"] == account.as_str() && t["actor"] == "RUST" && t["ref"] == positions[0].as_str()).count() == 0, "the engine took no action on position 0");
    cleanup(&pool, &w).await;
}
