//! The reconciler's idle gate (2026-09-26, Neon load): while the book cannot move and nothing waits to be paired, a
//! run is skipped WITHOUT a single statement to the book database; a coverage window (weekend reopen, NFP) always runs;
//! a decision recorded while it slept keeps it running until it is paired, then it sleeps again.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test reconcile_gate_db

use chrono::TimeZone;
use market_data::activity::Gate;
use order_management::reconcile::Reconciler;
use order_management::shadow::Recorder;
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use std::time::Duration;

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
            eprintln!("reconcile_gate_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

#[tokio::test]
async fn an_idle_book_is_not_queried_a_waiting_decision_and_the_reopen_window_are() {
    let Some(url) = url() else { return };
    let recorder = Arc::new(Recorder::connect(&url).await.expect("local store"));
    let store = recorder.store().unwrap().clone();
    // nothing may wait to be paired in the scratch store when the test starts (unpaired decisions of earlier runs)
    sqlx::query("DELETE FROM shadow_decision d WHERE NOT EXISTS (SELECT 1 FROM shadow_pair p WHERE p.decision_key = d.dedupe_key)")
        .execute(&store).await.unwrap();

    // A BOOK pool that cannot connect: ANY statement sent to it fails the call, so Ok(None) proves zero statements.
    let dead_book = PgPoolOptions::new().acquire_timeout(Duration::from_millis(300)).connect_lazy("postgresql://nobody@127.0.0.1:1/none").unwrap();
    let idle = Reconciler::new(dead_book, recorder.clone()).await.expect("reconciler").with_timing(20, 0);
    let every = Duration::from_secs(10);
    let saturday = chrono::Utc.with_ymd_and_hms(2026, 9, 26, 15, 0, 0).unwrap();
    let long_closed = Some(Duration::from_secs(600));

    // idle + nothing waiting + catch-up done: skipped, no statement reached the book
    assert!(matches!(idle.tick(Gate::BookClosed, long_closed, every, saturday).await, Ok(None)), "skipped without the book");
    assert!(matches!(idle.tick(Gate::FeedQuiet, long_closed, every, saturday).await, Ok(None)));
    assert!(matches!(idle.tick(Gate::FlatBook, long_closed, every, saturday).await, Ok(None)));
    // still inside the catch-up after the close: it runs (and so touches the book -> the dead pool errors)
    assert!(idle.tick(Gate::BookClosed, Some(Duration::from_secs(5)), every, saturday).await.is_err(), "catch-up runs");
    // the summer weekend reopen hour (21:00 UTC, shared market-week rule): runs even with the gate closed
    let summer_reopen = chrono::Utc.with_ymd_and_hms(2026, 9, 27, 21, 10, 0).unwrap();
    assert!(idle.tick(Gate::FeedQuiet, long_closed, every, summer_reopen).await.is_err(), "the reopen window runs");
    // 22:10 on that summer Sunday is past the reopen hour: skipped again
    let after = chrono::Utc.with_ymd_and_hms(2026, 9, 27, 22, 10, 0).unwrap();
    assert!(matches!(idle.tick(Gate::FeedQuiet, long_closed, every, after).await, Ok(None)));

    // a decision recorded while it slept: the next tick runs and pairs it (here: a position the book no longer has ->
    // PREEMPTED), then the reconciler sleeps again
    let book = PgPoolOptions::new().connect(&url).await.unwrap();
    let live = Reconciler::new(book, recorder.clone()).await.expect("reconciler").with_timing(20, 0);
    let key = format!("stop_loss:gate-test-{}", uuid::Uuid::new_v4().simple());
    sqlx::query(r#"INSERT INTO shadow_decision (dedupe_key, kind, account_id, position_id, close_price, first_seen, last_seen)
         VALUES ($1, 'stop_loss', 'gate-test-account', 'gate-test-position-gone', 1.0, now() - make_interval(secs => 30), now())"#)
        .bind(&key).execute(&store).await.unwrap();
    assert!(live.waiting_decisions(every * 2).await.unwrap(), "the new decision waits to be paired");
    let ran = live.tick(Gate::BookClosed, long_closed, every, saturday).await.expect("runs");
    assert!(ran.is_some(), "a waiting decision keeps the reconciler running");
    let (class,): (String,) = sqlx::query_as("SELECT class FROM shadow_pair WHERE decision_key = $1").bind(&key).fetch_one(&store).await.unwrap();
    assert_eq!(class, "PREEMPTED");
    assert!(!live.waiting_decisions(every * 2).await.unwrap());
    assert!(matches!(live.tick(Gate::BookClosed, long_closed, every, saturday).await, Ok(None)), "paired: asleep again");

    let _ = sqlx::query("DELETE FROM shadow_pair WHERE decision_key = $1").bind(&key).execute(&store).await;
    let _ = sqlx::query("DELETE FROM shadow_decision WHERE dedupe_key = $1").bind(&key).execute(&store).await;
}
