//! S3 re-run 2026-09-29 02:07:29 UTC (49990004, vEUR ramp): the web's margin-call notice (97.97 %) came back WEB_ONLY
//! although the shadow logged "would act kind=margin_call_in level=78.30" at 02:07:32. Three shadow-only defects:
//!   (a) the margin trigger's fire is evaluated PINNED (27bf7a9) and pinned evaluations recorded no margin-call edge, so
//!       only the 4 s pass could record it, seconds late (78.30 %, not the crossing);
//!   (b) an account evaluated flat never recorded MarginCallOut: its in-memory edge stayed "in" and its next episode in
//!       the same run was taken for the old one (recorded nothing);
//!   (c) the episode number in the stored dedupe key restarted at 1 with every engine process: the 02:07:32 edge reused
//!       an earlier run's key, ON CONFLICT kept that row's old first_seen (already paired), the notice found nothing.
//! These tests run the real MarginWatch, Recorder and Reconciler on the real schema, with S3's account:
//!   1. the trigger ALONE (no pass) records the margin call at the crossing and it pairs MATCH, even with an earlier
//!      process's already-paired `margin_call_in:{account}:1` row in the store;
//!   2. a second episode on the same account in the same run (in, the web closes, a shadow pass sees it flat, a new
//!      position crosses again) is recorded and pairs MATCH, with its own decision.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test shadow_margin_call_edges_db

use market_data::cache::TickCache;
use order_management::book::{with_pin, with_price_source, PriceSource};
use order_management::margin_watch::{load_book, Book, MarginFire, MarginWatch};
use order_management::monitor::{evaluate_account_mode, run_pass_mode, Mode, PassCursor};
use order_management::reconcile::Reconciler;
use order_management::shadow::Recorder;
use protocol::Tick;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
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
            eprintln!("shadow_margin_call_edges_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

const OPEN: Decimal = dec!(1.1002);
const LOTS: Decimal = dec!(0.22);
/// 97.8 %: in margin call (100), above stop-out (50) -- the S3 re-run's web notice read 97.97 %
const MC_BID: Decimal = dec!(1.0760);

struct World {
    pool: PgPool,
    broker: String,
    symbol: String,
    symbol_name: String,
    account: String,
    tag: String,
}

/// S3's re-run account: balance 995.6 (after the SELL leg), leverage 50, MC 100 / SO 50, contract 100000, hedged 50 %.
async fn world(pool: &PgPool) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, symbol, account) = (format!("mce-{tag}"), format!("mce-g-{tag}"), format!("mce-s-{tag}"), format!("mce-a-{tag}"));
    let symbol_name = format!("vM{}", &tag[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 50, now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, $2, 'USD', 5, 100000, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "hedgedMarginPct", "updatedAt") VALUES ($1, $2, $3, 50, now())"#)
        .bind(format!("mce-bs-{tag}")).bind(&broker).bind(&symbol).execute(pool).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'MC Edge Test', 'LIVE', 995.6, 50, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("6{}", &tag[..6])).bind(format!("{account}@test.local"))
    .execute(pool).await.unwrap();
    World { pool: pool.clone(), broker, symbol, symbol_name, account, tag }
}

impl World {
    /// A BUY 0.22 at 1.1002, open.
    async fn open(&self, n: u32) -> String {
        let (order, position) = (format!("mce-o-{}-{n}", self.tag), format!("mce-p-{}-{n}", self.tag));
        sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', $5, 'FILLED', $1, now())"#)
            .bind(&order).bind(&self.broker).bind(&self.account).bind(&self.symbol).bind(LOTS).execute(&self.pool).await.unwrap();
        let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
        sqlx::query(
            r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket, "openedAt")
               VALUES ($1, $2, $3, $4, $5, 'BUY', $6, $7, $8, now() - interval '30 seconds')"#,
        )
        .bind(&position).bind(&self.broker).bind(&self.account).bind(&self.symbol).bind(&order).bind(LOTS).bind(OPEN).bind(ticket)
        .execute(&self.pool).await.unwrap();
        position
    }

    /// The web closes it (flat); the balance is put back so the next episode starts from the same funds.
    async fn web_close(&self, position: &str) {
        sqlx::query(r#"UPDATE "Position" SET status = 'CLOSED', "closePrice" = $2, "realizedPnl" = 0, "closedAt" = now() WHERE id = $1"#)
            .bind(position).bind(OPEN).execute(&self.pool).await.unwrap();
    }

    /// The web's margin-call notice (trader copy), now. Returns its id.
    async fn web_notice(&self, n: u32) -> String {
        let id = format!("mce-n-{}-{n}", self.tag);
        sqlx::query(r#"INSERT INTO "Notification" (id, "brokerId", type, title, body, "entityType", "entityId", "accountId", "createdAt")
             VALUES ($1, $2, 'MARGIN_CALL', 'Margin call', 'margin level 97.97%, at or below the 100% margin-call level', 'Account', $3, $3, now())"#)
            .bind(&id).bind(&self.broker).bind(&self.account).execute(&self.pool).await.unwrap();
        id
    }

    /// The margin trigger's book, narrowed to this account.
    async fn watch_book(&self, watch: &MarginWatch) {
        let book = load_book(&self.pool).await.unwrap();
        watch.set_book(Book::new(book.accounts.into_iter().filter(|a| a.id == self.account).collect()));
    }

    fn tick(&self, cache: &TickCache, bid: Decimal) -> Tick {
        let t: Tick = serde_json::from_value(serde_json::json!({ "symbol": self.symbol_name, "bid": bid, "ask": bid + dec!(0.0002) })).unwrap();
        cache.set(&t, chrono::Utc::now());
        t
    }

    async fn pair_of(&self, notice: &str) -> Option<(String, Option<String>)> {
        sqlx::query_as("SELECT class, decision_key FROM shadow_pair WHERE web_ref = $1 AND kind = 'margin_call_in'")
            .bind(notice).fetch_optional(&self.pool).await.unwrap()
    }

    async fn cleanup(&self) {
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
        let _ = sqlx::query("DELETE FROM shadow_decision WHERE account_id = $1").bind(&self.account).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_pair WHERE account_id = $1").bind(&self.account).execute(&self.pool).await;
    }
}

/// The margin trigger fires on the tick; the fire is evaluated the way the shadow worker does it (pinned, no pass).
async fn fire_and_evaluate(w: &World, watch: &MarginWatch, cache: &Arc<TickCache>, recorder: &Arc<Recorder>, bid: Decimal) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<MarginFire>();
    watch.set_on_fire(tx);
    let t = w.tick(cache, bid);
    watch.decide(std::slice::from_ref(&t), cache, std::time::Instant::now());
    let fire = rx.try_recv().expect("the margin trigger fires on the margin-call crossing");
    assert_eq!(fire.account_id, w.account);
    assert!(!fire.pin.measured.is_empty(), "a margin-trigger pin names the positions it measured");
    let mode = Mode::Shadow(recorder.clone());
    with_price_source(PriceSource::Ticks(cache.clone()), with_pin(fire.pin, evaluate_account_mode(&w.pool, None, &w.account, &mode))).await.unwrap();
}

async fn reconcile(pool: &PgPool, recorder: &Arc<Recorder>) {
    tokio::time::sleep(Duration::from_millis(50)).await;
    let reconciler = Reconciler::new(pool.clone(), recorder.clone()).await.expect("reconciler").with_timing(60, 0);
    reconciler.run_once().await.unwrap();
}

async fn setup(url: &str) -> (PgPool, Arc<Recorder>) {
    let recorder = Arc::new(Recorder::connect(url).await.expect("local store"));
    let pool = PgPool::connect(url).await.expect("scratch DB");
    sqlx::query("DELETE FROM shadow_state WHERE key LIKE 'web_mc_cursor%' OR key LIKE 'web_close_cursor%'").execute(&pool).await.ok();
    (pool, recorder)
}

#[tokio::test]
async fn the_margin_trigger_alone_records_the_margin_call_and_it_matches_even_after_an_earlier_process_used_episode_1() {
    let Some(url) = url() else { return };
    let (pool, recorder) = setup(&url).await;
    let w = world(&pool).await;
    let body = async {
        // an EARLIER engine process's first episode of this account: stored, already paired, a day old (the 02:07 case)
        let stale = format!("margin_call_in:{}:1", w.account);
        sqlx::query(r#"INSERT INTO shadow_decision (dedupe_key, kind, account_id, level, first_seen, last_seen) VALUES ($1, 'margin_call_in', $2, 97.2, now() - interval '1 day', now() - interval '1 day')"#)
            .bind(&stale).bind(&w.account).execute(&pool).await.unwrap();
        sqlx::query(r#"INSERT INTO shadow_pair (class, kind, account_id, decision_key, web_at, shadow_at, skew_ms, known_fan_in, detail) VALUES ('MATCH', 'margin_call_in', $1, $2, now() - interval '1 day', now() - interval '1 day', 0, false, '{}'::jsonb)"#)
            .bind(&w.account).bind(&stale).execute(&pool).await.unwrap();

        w.open(1).await;
        let watch = MarginWatch::new();
        w.watch_book(&watch).await;
        let cache = Arc::new(TickCache::new());
        // the crossing: 97.8 %, the trigger's fire alone (no shadow pass runs in this test)
        fire_and_evaluate(&w, &watch, &cache, &recorder, MC_BID).await;
        let notice = w.web_notice(1).await;
        reconcile(&pool, &recorder).await;

        let pair = w.pair_of(&notice).await;
        let level: Option<(Option<Decimal>,)> = sqlx::query_as("SELECT level FROM shadow_decision WHERE account_id = $1 AND kind = 'margin_call_in' AND dedupe_key <> $2")
            .bind(&w.account).bind(&stale).fetch_optional(&pool).await.unwrap();
        (pair, level, stale)
    };
    let (pair, level, stale) = body.await;
    w.cleanup().await;
    eprintln!("trigger-only margin call: pair {pair:?}, shadow level {level:?}");
    let (class, key) = pair.expect("the web's notice was reconciled");
    assert_eq!(class, "MATCH", "the web's margin call has its shadow counterpart");
    assert_ne!(key.as_deref(), Some(stale.as_str()), "paired with THIS episode's edge, not the earlier process's key");
    let level = level.and_then(|l| l.0).expect("the trigger's fire recorded the margin call");
    assert!(level > dec!(97) && level < dec!(99), "recorded at the crossing (~97.8 %), not seconds later: {level}");
}

#[tokio::test]
async fn a_second_margin_call_episode_on_the_same_account_in_the_same_run_is_recorded_and_matches() {
    let Some(url) = url() else { return };
    let (pool, recorder) = setup(&url).await;
    let w = world(&pool).await;
    let body = async {
        let cache = Arc::new(TickCache::new());
        let watch = MarginWatch::new();
        // episode 1: the crossing, the web's notice
        let p1 = w.open(1).await;
        w.watch_book(&watch).await;
        fire_and_evaluate(&w, &watch, &cache, &recorder, MC_BID).await;
        let n1 = w.web_notice(1).await;
        // the web closes the position first (the shadow never simulated a close): the account is flat
        w.web_close(&p1).await;
        w.watch_book(&watch).await; // the trigger's book reloads on the close: the account leaves it
        // the shadow's pass: the flat account is not in its list, but the shadow still has it "in" -> MarginCallOut
        let mode = Mode::Shadow(recorder.clone());
        let mut cursor = PassCursor::default();
        with_price_source(PriceSource::Ticks(cache.clone()), run_pass_mode(&pool, None, &mut cursor, &mode)).await;
        let outs: (i64,) = sqlx::query_as("SELECT count(*) FROM shadow_decision WHERE account_id = $1 AND kind = 'margin_call_out'")
            .bind(&w.account).fetch_one(&pool).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        // episode 2, same run, same recorder: a new position, the same crossing, the web's second notice
        w.open(2).await;
        w.watch_book(&watch).await;
        fire_and_evaluate(&w, &watch, &cache, &recorder, MC_BID).await;
        let n2 = w.web_notice(2).await;
        reconcile(&pool, &recorder).await;
        (w.pair_of(&n1).await, w.pair_of(&n2).await, outs.0)
    };
    let (e1, e2, outs) = body.await;
    w.cleanup().await;
    eprintln!("episode 1 {e1:?}, margin_call_out rows {outs}, episode 2 {e2:?}");
    assert_eq!(outs, 1, "the flat account's margin call was closed by the shadow pass");
    let (c1, k1) = e1.expect("episode 1 reconciled");
    let (c2, k2) = e2.expect("episode 2 reconciled");
    assert_eq!((c1.as_str(), c2.as_str()), ("MATCH", "MATCH"), "both web notices have their shadow counterpart");
    assert!(k1.is_some() && k2.is_some() && k1 != k2, "two episodes, two shadow decisions: {k1:?} {k2:?}");
}
