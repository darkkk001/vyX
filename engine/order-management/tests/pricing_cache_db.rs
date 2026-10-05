//! The pricing cache and the shadow pass's one-snapshot book (2026-10-05, Neon load), on the real schema:
//!   1. statements per shadow pass, MEASURED (sqlx's own one-event-per-statement log, counted on this thread): the old
//!      per-account structure (list the accounts, then one load_book_state + one thresholds read per account) against
//!      run_pass_mode's load_pass_book, at two book sizes; and the pass book's state equals load_book_state's for every
//!      account (funds, prices, ask rules), so the fewer statements decide on the same numbers;
//!   2. the cache reloads when asked (config.changed / account.updated) and the new markup reaches the book read; with
//!      nothing asked and nothing moving it reads nothing.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_engine_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test pricing_cache_db -- --test-threads=1

use market_data::cache::TickCache;
use market_data::pricing::PricingCache;
use order_management::book::{self, with_book_sources, PriceSource};
use order_management::calc::load_book_state;
use order_management::monitor::{evaluate_account_mode, run_pass_mode, Mode, PassCursor};
use order_management::shadow::Recorder;
use protocol::Tick;
use sqlx::PgPool;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing_subscriber::layer::SubscriberExt;
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
            eprintln!("pricing_cache_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

// ---- statement counter: sqlx logs every statement it runs as one `sqlx::query` event ----

// One GLOBAL subscriber counting only the events of the measuring test's own thread (#[tokio::test] runs every query of
// that test on its thread): a thread-local subscriber misses events while another test thread runs without one
// (tracing caches each callsite's interest across threads).
#[derive(Clone, Default)]
struct Counter {
    n: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<String>>>,
    thread: Arc<Mutex<Option<std::thread::ThreadId>>>,
}

fn counter() -> Counter {
    static C: std::sync::OnceLock<Counter> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        let c = Counter::default();
        tracing::subscriber::set_global_default(tracing_subscriber::registry().with(c.clone())).expect("the only global subscriber of this test binary");
        c
    })
    .clone()
}

struct Text(String);
impl tracing::field::Visit for Text {
    fn record_debug(&mut self, f: &tracing::field::Field, v: &dyn std::fmt::Debug) {
        self.0.push_str(&format!("{}={:?} ", f.name(), v));
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Counter {
    fn on_event(&self, e: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        if e.metadata().target() != "sqlx::query" || *self.thread.lock().unwrap() != Some(std::thread::current().id()) {
            return;
        }
        let mut t = Text(String::new());
        e.record(&mut t);
        // the shadow store's own writes (decisions, samples) are not book reads
        if t.0.contains("shadow_") {
            return;
        }
        self.n.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().unwrap().push(t.0.chars().take(140).collect());
    }
}

impl Counter {
    fn take(&self) -> usize {
        self.seen.lock().unwrap().clear();
        self.n.swap(0, Ordering::SeqCst)
    }
}

// ---- a broker with the pricing engine on, a group and broker markup, N accounts each holding a BUY and a SELL ----

struct World {
    pool: PgPool,
    broker: String,
    group: String,
    symbol: String,
    symbol_name: String,
    accounts: Vec<String>,
    tag: String,
}

async fn world(pool: &PgPool, n: usize) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, symbol) = (format!("pc-{tag}"), format!("pc-g-{tag}"), format!("pc-s-{tag}"));
    let symbol_name = format!("PC{}", &tag[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "pricingEngineEnabled", "updatedAt") VALUES ($1, $1, $1, true, now())"#)
        .bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 50, now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, $2, 'USD', 5, 100000, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "spreadMarkup", "updatedAt") VALUES ($1, $2, $3, 2, now())"#)
        .bind(format!("pc-bs-{tag}")).bind(&broker).bind(&symbol).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "GroupSymbolConfig" (id, "groupId", "symbolId", "spreadMarkup", "updatedAt") VALUES ($1, $2, $3, 3, now())"#)
        .bind(format!("pc-gsc-{tag}")).bind(&group).bind(&symbol).execute(pool).await.unwrap();
    let mut w = World { pool: pool.clone(), broker, group, symbol, symbol_name, accounts: Vec::new(), tag };
    w.add_accounts(n).await;
    w
}

impl World {
    async fn add_accounts(&mut self, n: usize) {
        for _ in 0..n {
            let i = self.accounts.len();
            // "!" sorts first, so the pass meets these accounts before anything else in the database
            let account = format!("!pc-a-{}-{i:03}", self.tag);
            sqlx::query(
                r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
                   VALUES ($1, $2, $3, $4, $5, 'x', 'Pricing Cache Test', 'LIVE', 100000, 100, now())"#,
            )
            .bind(&account).bind(&self.broker).bind(&self.group).bind(format!("7{}{i:03}", &self.tag[..5])).bind(format!("{account}@test.local"))
            .execute(&self.pool).await.unwrap();
            // the 2nd account onward of every 3 has its own markup level too
            if i % 3 == 1 {
                sqlx::query(r#"INSERT INTO "AccountSymbolConfig" (id, "accountId", "symbolId", "spreadMarkup", "updatedAt") VALUES ($1, $2, $3, 7, now())"#)
                    .bind(format!("pc-asc-{}-{i}", self.tag)).bind(&account).bind(&self.symbol).execute(&self.pool).await.unwrap();
            }
            for (k, side) in ["BUY", "SELL"].iter().enumerate() {
                let (order, position) = (format!("pc-o-{}-{i}-{k}", self.tag), format!("pc-p-{}-{i}-{k}", self.tag));
                sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, $4, $5::"OrderSide", 'MARKET', 0.1, 'FILLED', $1, now())"#)
                    .bind(&order).bind(&self.broker).bind(&account).bind(&self.symbol).bind(side).execute(&self.pool).await.unwrap();
                let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
                sqlx::query(
                    r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket, "openedAt")
                       VALUES ($1, $2, $3, $4, $5, $6::"OrderSide", 0.1, 1.1000, $7, now() - interval '30 seconds')"#,
                )
                .bind(&position).bind(&self.broker).bind(&account).bind(&self.symbol).bind(&order).bind(side).bind(ticket)
                .execute(&self.pool).await.unwrap();
            }
            self.accounts.push(account);
        }
    }

    fn tick(&self, cache: &TickCache) {
        let t: Tick = serde_json::from_value(serde_json::json!({ "symbol": self.symbol_name, "bid": "1.10100", "ask": "1.10110" })).unwrap();
        cache.set(&t, chrono::Utc::now());
    }

    async fn cleanup(&self) {
        let _ = sqlx::query(r#"DELETE FROM "AccountSymbolConfig" WHERE "symbolId" = $1"#).bind(&self.symbol).execute(&self.pool).await;
        let _ = sqlx::query(r#"DELETE FROM "GroupSymbolConfig" WHERE "symbolId" = $1"#).bind(&self.symbol).execute(&self.pool).await;
        for sql in [
            r#"DELETE FROM "Notification" WHERE "brokerId" = $1"#,
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
    }
}

/// Statements of one shadow pass the OLD way (the 86a4adc structure: the list query, then every account read on its
/// own -- this world's accounts only, so other tests' rows in the shared scratch DB never change the number), and of
/// run_pass_mode (load_pass_book: constant whatever the book holds), counted on this thread. The cache is loaded first
/// in both, as in production. Returns (before, after, pass errors). Never panics: the caller cleans up first.
async fn measure(pool: &PgPool, w: &World, recorder: &Arc<Recorder>, cache: &Arc<TickCache>, pricing: &Arc<PricingCache>, counter: &Counter) -> (usize, usize, usize) {
    let mode = Mode::Shadow(recorder.clone());
    let src = PriceSource::Ticks(cache.clone());
    counter.take();
    with_book_sources(src.clone(), Some(pricing.clone()), async {
        let _ = book::account_ids_with_open_positions(pool).await;
        for id in &w.accounts {
            let _ = evaluate_account_mode(pool, None, id, &mode).await;
        }
    })
    .await;
    let before = counter.take();
    let mut cursor = PassCursor::default();
    let report = with_book_sources(src, Some(pricing.clone()), run_pass_mode(pool, None, &mut cursor, &mode)).await;
    let seen = counter.seen.lock().unwrap().clone();
    if std::env::var("PC_DUMP").is_ok() {
        eprintln!("{seen:#?}");
    }
    let after = counter.take();
    (before, after, report.errors)
}

#[tokio::test]
async fn a_shadow_pass_reads_a_constant_number_of_statements_and_decides_on_the_same_numbers() {
    let Some(url) = url() else { return };
    let counter = counter();
    *counter.thread.lock().unwrap() = Some(std::thread::current().id());
    let pool = PgPool::connect(&url).await.unwrap();
    let recorder = Arc::new(Recorder::connect(&url).await.expect("local store"));
    let mut w = world(&pool, 4).await;
    let result = async {
        let cache = Arc::new(TickCache::new());
        w.tick(&cache);
        let pricing = PricingCache::new();
        pricing.reload(&pool).await.unwrap();
        let small = measure(&pool, &w, &recorder, &cache, &pricing, &counter).await;
        w.add_accounts(16).await;
        let large = measure(&pool, &w, &recorder, &cache, &pricing, &counter).await;

        // the pass book's numbers are load_book_state's, account by account (funds, prices, ask rules)
        let src = PriceSource::Ticks(cache.clone());
        let pb = with_book_sources(src.clone(), Some(pricing.clone()), book::load_pass_book(&pool, &[])).await;
        let mut mismatches: Vec<String> = Vec::new();
        let mut rules = 0;
        match pb {
            Err(e) => mismatches.push(format!("load_pass_book failed: {e}")),
            Ok(pb) => {
                for id in &w.accounts {
                    let old = with_book_sources(src.clone(), Some(pricing.clone()), load_book_state(&pool, id)).await;
                    let (Ok(Some(old)), Some(new)) = (old, pb.state(id, &src, chrono::Utc::now())) else {
                        mismatches.push(format!("{id}: missing on one side"));
                        continue;
                    };
                    if (old.effective_balance, old.credit, old.leverage) != (new.effective_balance, new.credit, new.leverage) {
                        mismatches.push(format!("{id}: funds differ"));
                    }
                    if format!("{:?}", old.positions) != format!("{:?}", new.positions) {
                        mismatches.push(format!("{id}: rows / prices / ask rules differ:
  old {:?}
  new {:?}", old.positions, new.positions));
                    }
                    rules += new.positions.iter().filter(|p| p.ask_rule.is_some()).count();
                }
            }
        }
        (small, large, mismatches, rules)
    }
    .await;
    w.cleanup().await;
    let ((b4, a4, e4), (b20, a20, e20), mismatches, rules) = result;
    assert_eq!((e4, e20), (0, 0), "the pass evaluated every account without an error");
    assert!(mismatches.is_empty(), "the pass book must decide on load_book_state's numbers: {mismatches:#?}");
    // every position carries the resolved rule (engine on, broker + group levels set): the cache resolved them
    assert_eq!(rules, w.accounts.len() * 2);
    eprintln!("statements per shadow pass: 4 accounts: before {b4}, after {a4}; 20 accounts: before {b20}, after {a20}");
    assert_eq!(a4, a20, "after: the same number of statements whatever the number of accounts");
    assert!(a20 <= 8, "after: a handful of statements per pass, got {a20}");
    assert!(b20 > b4 && b20 >= 20 * 4, "before: several statements per account (sanity of the measurement), got {b4} / {b20}");
}

#[tokio::test]
async fn the_cache_reloads_when_a_change_is_announced_and_reads_nothing_otherwise() {
    let Some(url) = url() else { return };
    let pool = PgPool::connect(&url).await.unwrap();
    let w = world(&pool, 1).await;
    let result = async {
        let ticks = Arc::new(TickCache::new()); // nothing moves: no safety reload is due
        let pricing = PricingCache::new();
        pricing.spawn_reload_loop(pool.clone(), ticks.clone(), Duration::from_millis(200));
        let wait_for = |n: u64| {
            let p = pricing.clone();
            async move {
                for _ in 0..100 {
                    if p.reload_count.load(Ordering::Relaxed) >= n {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                false
            }
        };
        let first = wait_for(1).await;
        // no tick: a real quote moving would make the safety reload due (that is its job); ask rules don't need prices
        let src = PriceSource::Ticks(ticks.clone());
        let rule_of = |pricing: Arc<PricingCache>| {
            let (pool, src, id) = (pool.clone(), src.clone(), w.accounts[0].clone());
            async move {
                let rows = with_book_sources(src, Some(pricing), book::open_positions_with_market(&pool, &id)).await.unwrap();
                rows.iter().find(|p| p.side == protocol::OrderSide::Sell).unwrap().ask_rule
            }
        };
        let before = rule_of(pricing.clone()).await;
        // quiet: the 200 ms safety interval passes several times, nothing moved, nothing asked -> no read
        let loaded = pricing.reload_count.load(Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let quiet = pricing.reload_count.load(Ordering::Relaxed) - loaded;
        // the web changes the group's markup and announces it (config.changed)
        sqlx::query(r#"UPDATE "GroupSymbolConfig" SET "spreadMarkup" = 9 WHERE "groupId" = $1"#).bind(&w.group).execute(&pool).await.unwrap();
        let kept = rule_of(pricing.clone()).await == before;
        pricing.request_reload();
        pricing.request_reload(); // a burst makes at most one more reload than asked once
        let reloaded = wait_for(loaded + 1).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let after = rule_of(pricing.clone()).await;
        let reloads = pricing.reload_count.load(Ordering::Relaxed) - loaded;
        (first, quiet, before, kept, reloaded, after, reloads)
    }
    .await;
    w.cleanup().await;
    let (first, quiet, before, kept, reloaded, after, reloads) = result;
    assert!(first, "the first load runs at once");
    assert!(kept, "not announced yet: the cached rule is kept");
    assert!(reloaded, "an announced change reloads");
    eprintln!("quiet reloads {quiet}; rule before {before:?}, after {after:?}; reloads for the burst {reloads}");
    assert_eq!(quiet, 0, "nothing moved, nothing asked: no reload");
    assert_ne!(before, after, "the announced markup reached the book read");
    assert!((1..=2).contains(&reloads), "{reloads}");
}
