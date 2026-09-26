//! Guard 2 (owner, 2026-09-26): with the book idle the safety reload runs only every 10 minutes, so a LOST book-change
//! event must be detected. The gateway stamps every book-change event with (book_epoch, book_seq) and repeats it on
//! `book.seq`; the engine's tracker (market_data::book_events::BookFeed) sees a gap and reloads everything at once.
//!
//! Wired as the server wires it: the event subjects feed the debouncer, the `book.seq` markers feed the tracker, both
//! reload the same RiskHook; its safety cadence is market_data::book_events::safety_interval for an idle book (10 min
//! while the feed is healthy), so only an event can make the new SL watched within the test.
//!
//! LOST: a new position with an SL is written WITHOUT its event (seq 2 lost); a later event (seq 3, an unrelated
//! account) arrives -> a gap -> an immediate forced full reload -> the SL is watched at once.
//! CONTROL: the same with the next event at seq 2 (nothing lost) -> no forced reload; only the normal event-driven one.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test book_seq_lost_event_db -- --nocapture

use market_data::activity::Gate;
use market_data::book_events::{safety_interval, spawn_debounced, BookFeed, DEBOUNCE, SAFETY_IDLE};
use market_data::cache::TickCache;
use market_data::risk_hook::RiskHook;
use protocol::Tick;
use sqlx::PgPool;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
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
            eprintln!("book_seq_lost_event_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

struct World {
    pool: PgPool,
    broker: String,
    symbol: String,
    symbol_name: String,
    account: String,
}

async fn world(pool: &PgPool) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, account, symbol) = (format!("seq-{tag}"), format!("seq-g-{tag}"), format!("seq-a-{tag}"), format!("seq-s-{tag}"));
    let symbol_name = format!("ZQ{}", &tag[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 50, now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'Seq Test', 'LIVE', 10000, 100, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("6{}", &tag[..7])).bind(format!("seq-{tag}@test.local"))
    .execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, 'ZQ', 'USD', 2, 1, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "updatedAt") VALUES ($1, $2, $3, now())"#)
        .bind(format!("seq-bs-{tag}")).bind(&broker).bind(&symbol).execute(pool).await.unwrap();
    World { pool: pool.clone(), broker, symbol, symbol_name, account }
}

impl World {
    /// The web opens a position with an SL -- in the database only; its announcement is the one that gets lost.
    async fn open_with_sl(&self) -> String {
        let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
        let (order, position) = (format!("seq-o-{tag}"), format!("seq-p-{tag}"));
        sqlx::query(
            r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
               VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 1, 'FILLED', $1, now())"#,
        )
        .bind(&order).bind(&self.broker).bind(&self.account).bind(&self.symbol).execute(&self.pool).await.unwrap();
        let ticket: i32 = (u32::from_str_radix(&tag[..7], 16).unwrap() % 2_000_000_000) as i32;
        sqlx::query(
            r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", "slPrice", ticket, "openedAt")
               VALUES ($1, $2, $3, $4, $5, 'BUY', 1, 100, 95, $6, now())"#,
        )
        .bind(&position).bind(&self.broker).bind(&self.account).bind(&self.symbol).bind(&order).bind(ticket)
        .execute(&self.pool).await.unwrap();
        position
    }

    async fn cleanup(&self) {
        let p = &self.pool;
        sqlx::query(r#"DELETE FROM "Position" WHERE "brokerId" = $1"#).bind(&self.broker).execute(p).await.ok();
        sqlx::query(r#"DELETE FROM "Order" WHERE "brokerId" = $1"#).bind(&self.broker).execute(p).await.ok();
        sqlx::query(r#"DELETE FROM "Account" WHERE "brokerId" = $1"#).bind(&self.broker).execute(p).await.ok();
        sqlx::query(r#"DELETE FROM "BrokerSymbol" WHERE "brokerId" = $1"#).bind(&self.broker).execute(p).await.ok();
        sqlx::query(r#"DELETE FROM "Group" WHERE "brokerId" = $1"#).bind(&self.broker).execute(p).await.ok();
        sqlx::query(r#"DELETE FROM "Broker" WHERE id = $1"#).bind(&self.broker).execute(p).await.ok();
        sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&self.symbol).execute(p).await.ok();
    }
}

fn marker(epoch: &str, seq: u64) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "book_epoch": epoch, "book_seq": seq, "subject": "position.modified" })).unwrap()
}

/// One run: the idle-book cadence (10 min with a healthy feed), a healthy feed at seq 1, a new SL written without an
/// event, then the next event arrives with `next_seq` on both paths (its subject -> debouncer, its marker -> tracker).
/// Returns (SL watched within, forced reloads, reloads caused by that event).
async fn run(pool: &PgPool, next_seq: u64) -> (Option<Duration>, u64, u64) {
    let w = world(pool).await;
    let cache = Arc::new(TickCache::new());
    let tick: Tick = serde_json::from_value(serde_json::json!({ "symbol": w.symbol_name, "bid": "100", "ask": "100.1" })).unwrap();
    cache.set(&tick, chrono::Utc::now()); // something ticks, so only the cadence (not the feed-quiet gate) holds the poll

    std::env::set_var("VYX_RISK_HOOK_URL", "http://127.0.0.1:1/x");
    std::env::set_var("VYX_RISK_HOOK_SECRET", "s3cret");
    let hook = RiskHook::from_env().expect("hook");
    let feed = BookFeed::new();
    assert!(!feed.observe_marker(&marker("epoch-A", 1)), "first sequenced event: healthy, no forced reload");
    assert!(feed.is_healthy());
    let f = feed.clone();
    let interval = Arc::new(move || safety_interval(Gate::BookClosed, f.is_healthy()));
    assert_eq!(interval(), SAFETY_IDLE, "idle book + healthy feed: the 10-minute safety cadence");
    hook.spawn_reload_loop_with(pool.clone(), cache.clone(), interval);

    // production wiring: subjects -> debouncer -> request_reload; markers -> tracker -> request_reload on a gap
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let h = hook.clone();
    spawn_debounced(rx, DEBOUNCE, Arc::new(move || h.request_reload()));

    tokio::time::sleep(Duration::from_millis(400)).await; // the first load
    let new_position = w.open_with_sl().await; // seq 2 would announce it: its event is LOST (never delivered)
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!hook.watches(&new_position), "the lost announcement: not watched, and the 10-minute poll is far away");

    let before = hook.reload_count.load(Ordering::Relaxed);
    let at = Instant::now();
    // the next event (an unrelated account's change) arrives on its subject and its marker on book.seq
    tx.send("position.modified".into()).unwrap();
    if feed.observe_marker(&marker("epoch-A", next_seq)) {
        hook.request_reload();
    }
    let mut watched = None;
    while at.elapsed() < Duration::from_secs(3) {
        if hook.watches(&new_position) {
            watched = Some(at.elapsed());
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(DEBOUNCE * 5).await; // let the debounced reload of that event land too
    let caused = hook.reload_count.load(Ordering::Relaxed) - before;
    let forced = feed.forced_reloads.load(Ordering::Relaxed);
    w.cleanup().await;
    (watched, forced, caused)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_book_event_is_detected_by_the_sequence_gap_and_reloads_at_once() {
    let Some(url) = url() else { return };
    let pool = PgPool::connect(&url).await.expect("scratch DB");

    // LOST: seq 2 (the new SL's own announcement) never arrives; the next event is seq 3
    let (watched, forced, caused) = run(&pool, 3).await;
    eprintln!("LOST (seq 1 -> 3): SL watched after {watched:?}; forced full reloads {forced}; reloads caused by the event {caused}");
    let took = watched.expect("the lost event's SL must be watched");
    assert_eq!(forced, 1, "the gap forces exactly one full reload");
    assert!(took < DEBOUNCE, "the forced reload is immediate (not after the {DEBOUNCE:?} debounce): {took:?}");
    assert!((1..=2).contains(&caused), "one forced reload (+ the event's own debounced one): {caused}");

    // CONTROL: nothing lost -- the next event is seq 2
    let (watched, forced, caused) = run(&pool, 2).await;
    eprintln!("CONTROL (seq 1 -> 2): SL watched after {watched:?}; forced full reloads {forced}; reloads caused by the event {caused}");
    assert_eq!(forced, 0, "an in-order stream forces nothing");
    assert_eq!(caused, 1, "only the normal event-driven reload");
    let took = watched.expect("the next event's own reload still picks the SL up");
    assert!(took >= DEBOUNCE, "without a gap the reload waits for the debounce: {took:?}");
}
