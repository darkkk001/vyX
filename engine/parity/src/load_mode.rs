//! Stage 4 load harness, engine side (docs/RUST-CUTOVER-PLAN.md §4.2, §4.7): `cargo run -p parity -- --load-run
//! <walkers> <report.json>` on the scratch `vyx_load_engine` database, already seeded by scripts/load/seed.ts.
//!
//! Production shape, made adversarial:
//! - the REAL pass (`monitor::run_pass`, what `run_once` runs) by K walkers AT THE SAME TIME, round after round;
//! - the REAL dispatcher (`outbox::spawn`) running concurrently the whole time, into the web's real route served
//!   by scripts/parity/post-close-server.ts on the same database (VYX_POST_CLOSE_URL / _SECRET);
//! - the shocked prices kept fresh (tickAt) like a live feed, the deliberately stale symbol left stale.
//!
//! It stops when a whole round closes nothing, defers nothing and no follow-up is pending (cap: MAX_ROUNDS), and
//! writes timings, deferral counts per account and the safety releases taken.

use order_management::{book, monitor, outbox};
use serde::Serialize;
use sqlx::PgPool;
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub const LOAD_URL: &str = "postgresql://postgres@127.0.0.1:5499/vyx_load_engine";
const MAX_ROUNDS: usize = 40;

pub async fn connect() -> Result<PgPool, String> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(32)
        .connect(LOAD_URL)
        .await
        .map_err(|e| format!("connect {LOAD_URL}: {e}"))?;
    let (db, port): (String, i32) = sqlx::query_as("SELECT current_database()::text, inet_server_port()")
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;
    if db != "vyx_load_engine" || port != 5499 {
        return Err(format!("connected to {db}:{port}, expected vyx_load_engine:5499 -- refusing"));
    }
    Ok(pool)
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountDeferral {
    passes_deferred: usize,
    /// first deferral -> first evaluation after it, ms
    waited_ms: Option<u128>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadReport {
    walkers: usize,
    rounds: usize,
    settled: bool,
    wall_ms: u128,
    /// wall time of every pass, ms
    pass_ms: Vec<u128>,
    closed: usize,
    errors: usize,
    defer_queries: u64,
    safety_releases: u64,
    max_passes_deferred: usize,
    max_waited_ms: u128,
    deferrals: BTreeMap<String, AccountDeferral>,
    pg_xact_commit: i64,
    pg_tup_fetched: i64,
}

async fn pg_counters(pool: &PgPool) -> Result<(i64, i64), String> {
    sqlx::query_as(r#"SELECT xact_commit, tup_fetched FROM pg_stat_database WHERE datname = current_database()"#)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())
}

pub async fn run(walkers: usize) -> Result<LoadReport, String> {
    let pool = connect().await?;
    let cfg = outbox::DispatcherConfig::from_env().ok_or("VYX_POST_CLOSE_URL / VYX_POST_CLOSE_SECRET must point at the load post-close server")?;
    outbox::spawn(pool.clone(), cfg);

    // the live feed: same prices, fresh tickAt
    let restamp_pool = pool.clone();
    let restamper = tokio::spawn(async move {
        loop {
            let _ = sqlx::query(r#"UPDATE "LivePrice" SET "tickAt" = now() WHERE "tickAt" > now() - interval '60 seconds'"#)
                .execute(&restamp_pool)
                .await;
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    sqlx::query(r#"UPDATE "LivePrice" SET "tickAt" = now() WHERE "tickAt" > now() - interval '60 seconds'"#)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let (x0, t0) = pg_counters(&pool).await?;
    let q0 = book::DEFER_QUERIES.load(Ordering::Relaxed);
    let s0 = book::SAFETY_RELEASES.load(Ordering::Relaxed);
    let start = Instant::now();
    let mut report = LoadReport { walkers, ..Default::default() };
    let mut first_deferred: BTreeMap<String, Instant> = BTreeMap::new();

    for round in 0..MAX_ROUNDS {
        report.rounds = round + 1;
        let handles: Vec<_> = (0..walkers)
            .map(|_| {
                let pool = pool.clone();
                tokio::spawn(async move {
                    let t = Instant::now();
                    let r = monitor::run_pass(&pool, None).await;
                    (r, t.elapsed().as_millis())
                })
            })
            .collect();
        let mut round_closed = 0;
        let mut round_deferred = 0;
        for h in handles {
            let (r, ms) = h.await.map_err(|e| e.to_string())?;
            report.pass_ms.push(ms);
            round_closed += r.closed;
            round_deferred += r.deferred.len();
            report.errors += r.errors;
            for a in &r.deferred {
                report.deferrals.entry(a.clone()).or_default().passes_deferred += 1;
                first_deferred.entry(a.clone()).or_insert_with(Instant::now);
            }
            for a in &r.evaluated {
                if let Some(t) = first_deferred.get(a) {
                    let d = report.deferrals.entry(a.clone()).or_default();
                    if d.waited_ms.is_none() {
                        d.waited_ms = Some(t.elapsed().as_millis());
                    }
                }
            }
        }
        report.closed += round_closed;
        let (pending,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "PostCloseEffect" WHERE status = 'PENDING'"#)
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
        if round_closed == 0 && round_deferred == 0 && pending == 0 {
            report.settled = true;
            break;
        }
        if round_closed == 0 && round_deferred == 0 {
            // only follow-ups left: let the dispatcher finish them before the next round
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    // the last follow-ups (a round can end with rows still in flight)
    for _ in 0..200 {
        let (pending,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "PostCloseEffect" WHERE status = 'PENDING'"#)
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
        if pending == 0 {
            break;
        }
        outbox::wake();
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    restamper.abort();

    report.wall_ms = start.elapsed().as_millis();
    let (x1, t1) = pg_counters(&pool).await?;
    report.pg_xact_commit = x1 - x0;
    report.pg_tup_fetched = t1 - t0;
    report.defer_queries = book::DEFER_QUERIES.load(Ordering::Relaxed) - q0;
    report.safety_releases = book::SAFETY_RELEASES.load(Ordering::Relaxed) - s0;
    report.max_passes_deferred = report.deferrals.values().map(|d| d.passes_deferred).max().unwrap_or(0);
    report.max_waited_ms = report.deferrals.values().filter_map(|d| d.waited_ms).max().unwrap_or(0);
    Ok(report)
}

pub fn main(args: &[String]) {
    let walkers: usize = args.first().and_then(|v| v.parse().ok()).unwrap_or(2);
    let out = args.get(1).cloned().unwrap_or_else(|| "load-engine-report.json".into());
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    match rt.block_on(run(walkers)) {
        Ok(report) => {
            println!(
                "[load:engine] walkers={} rounds={} settled={} closed={} wall={}ms deferQueries={} safetyReleases={} maxPassesDeferred={} maxWaited={}ms errors={}",
                report.walkers, report.rounds, report.settled, report.closed, report.wall_ms, report.defer_queries, report.safety_releases,
                report.max_passes_deferred, report.max_waited_ms, report.errors
            );
            std::fs::write(&out, serde_json::to_string_pretty(&report).expect("serialize") + "\n").expect("write report");
            if !report.settled || report.errors > 0 {
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("[load:engine] {e}");
            std::process::exit(2);
        }
    }
}
