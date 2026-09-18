//! Nightly Candle retention -- Contabo DB hygiene audit: M1 candles were
//! 68% of all Candle rows (measured on the live Neon instance: 133,652 of
//! 196,452), and nothing reads an M1 bar older than a few weeks (the
//! chart's own history fetch pages by timeframe, and a trader looking at
//! months of history is on M30/H1/H4/D1, not M1). Deletes in bounded
//! batches with a small sleep between them, same "don't hold Postgres
//! hostage for a slow maintenance job" instinct as this crate's flush
//! timeouts (ingest.rs's DB_FLUSH_TIMEOUT) -- a single unbatched DELETE
//! spanning hundreds of thousands of rows would hold long locks and bloat
//! the WAL in one shot instead of in small, interruptible steps.
//!
//! fix/deep-backfill-full-history: this module also owns the off-grid
//! sweep (`sweep_offgrid_candles` / `spawn_offgrid_sweep`) -- the one-off
//! deletion of the phantom `hh:mm:01` rows that pre-v1.39 EA backfills
//! left beside the real buckets. Same batched-delete machinery, same
//! "log and stop, never crash" convention; it lives here rather than in a
//! new module because it is the same job (a bounded maintenance DELETE
//! over "Candle") with a different predicate.

use crate::{Timeframe, TIMEFRAMES};
use chrono::{DateTime, Duration as ChronoDuration, NaiveTime, Utc};
use sqlx::PgPool;
use std::time::Duration as StdDuration;

const RETENTION_BATCH_SIZE: i64 = 10_000;
// Deliberately larger than the DB_FLUSH_TIMEOUT-scale pauses elsewhere in
// this crate -- this job runs once a night, not on the hot path, so
// there's no reason to rush it; a small pause between batches gives the
// live tick-ingestion flushes (ingest.rs) room to interleave instead of
// this job monopolizing the connection pool for however long a full pass
// takes.
const RETENTION_BATCH_SLEEP: StdDuration = StdDuration::from_millis(200);

fn retention_days_from_env(var: &str, default: i64) -> i64 {
    std::env::var(var)
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|&d| d > 0)
        .unwrap_or(default)
}

/// Pure so it's testable without a clock or a sleep -- returns how long
/// to wait from `now` until the next occurrence of `target_hour`:
/// `target_minute` UTC ("server time" here means this engine's own clock,
/// which is UTC everywhere else in this crate too -- LivePrice.updatedAt,
/// Candle.bucketStart, the gap-fill tracker -- not a locale-dependent
/// notion of "the server's timezone").
fn duration_until_next_run(now: DateTime<Utc>, target_hour: u32, target_minute: u32) -> StdDuration {
    let target_time = NaiveTime::from_hms_opt(target_hour, target_minute, 0).expect("valid hour/minute");
    let today_at_target = now.date_naive().and_time(target_time).and_utc();
    let next_run = if today_at_target > now { today_at_target } else { today_at_target + ChronoDuration::days(1) };
    (next_run - now).to_std().unwrap_or(StdDuration::ZERO)
}

// `DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT $3)` -- the standard
// Postgres pattern for a bounded batch delete (DELETE itself has no
// LIMIT clause). Uses the new Candle_timeframe_bucketStart_idx
// (prisma/schema.prisma, migration 20260831060000) -- Candle_pkey leads
// with symbol, so it can't serve an index scan for a WHERE clause that
// filters by timeframe + bucketStart alone.
async fn delete_one_batch(pool: &PgPool, timeframe: &str, cutoff: DateTime<Utc>) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM "Candle"
        WHERE ctid IN (
            SELECT ctid FROM "Candle"
            WHERE timeframe = $1::"CandleTimeframe" AND "bucketStart" < $2
            LIMIT $3
        )
        "#,
    )
    .bind(timeframe)
    .bind(cutoff)
    .bind(RETENTION_BATCH_SIZE)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Runs one full retention pass for a single timeframe -- every batch
/// until fewer than a full batch comes back (caught up) or a batch fails
/// (logged and this pass stops early; the next scheduled run tries again,
/// same "log and drop, never crash the process over it" convention as
/// ingest.rs's flush failures).
pub async fn run_retention_pass(pool: &PgPool, timeframe: &str, retention_days: i64) {
    let cutoff = Utc::now() - ChronoDuration::days(retention_days);
    let mut total_deleted: u64 = 0;

    loop {
        match delete_one_batch(pool, timeframe, cutoff).await {
            Ok(n) => {
                total_deleted += n;
                if n < RETENTION_BATCH_SIZE as u64 {
                    break; // fewer than a full batch -- caught up
                }
                tokio::time::sleep(RETENTION_BATCH_SLEEP).await;
            }
            Err(err) => {
                tracing::warn!(?err, timeframe, "candle retention batch delete failed, stopping this pass early -- next scheduled run will retry");
                break;
            }
        }
    }

    tracing::info!(timeframe, retention_days, rows_deleted = total_deleted, "candle retention pass complete");
}

/// The modulus a stored `bucketStart` must be a whole multiple of (in
/// epoch milliseconds) for this timeframe -- the SQL twin of
/// `crate::bucket_is_aligned`, and deliberately no looser: M1..H1 sit on
/// their own fixed grid from the epoch; H4/D1 are shifted by the broker
/// offset (whole hours, at worst :30) and W1/MN1/Y1 are calendar buckets,
/// so for those only the whole-minute rule holds. Kept as a function of
/// the enum (not a hand-written CASE in the SQL) so a timeframe added to
/// `bucket_is_aligned` cannot be forgotten here.
fn grid_ms(tf: Timeframe) -> i64 {
    match tf {
        Timeframe::M1 | Timeframe::M5 | Timeframe::M15 | Timeframe::M30 | Timeframe::H1 => {
            crate::fixed_ms(tf).expect("fixed timeframe")
        }
        _ => 60_000,
    }
}

/// How many rows of this timeframe sit off its grid. The predicate cannot
/// use an index (it is arithmetic on the column), so this is one
/// sequential pass over the timeframe's rows -- on the live store that is
/// ~200k rows in total, tens of milliseconds, paid once per boot; the
/// point of counting first is that a clean store (every boot after the
/// one-off cleanup) costs exactly that and issues no DELETE at all.
async fn count_offgrid(pool: &PgPool, timeframe: &str, grid_ms: i64) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT count(*) FROM "Candle"
        WHERE timeframe = $1::"CandleTimeframe"
          AND (EXTRACT(EPOCH FROM "bucketStart") * 1000)::bigint % $2 <> 0
        "#,
    )
    .bind(timeframe)
    .bind(grid_ms)
    .fetch_one(pool)
    .await
}

// Same `DELETE ... WHERE ctid IN (SELECT ... LIMIT)` bounded-batch shape as
// delete_one_batch above, with the alignment predicate instead of the age
// one. `(EXTRACT(EPOCH ...) * 1000)::bigint` -- not `EXTRACT(EPOCH ...)::
// bigint % 60` -- so a bucketStart with a sub-second component (the column
// is TIMESTAMPTZ(3)) is caught too; the Rust predicate works in epoch ms
// for the same reason.
async fn delete_offgrid_batch(pool: &PgPool, timeframe: &str, grid_ms: i64) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM "Candle"
        WHERE ctid IN (
            SELECT ctid FROM "Candle"
            WHERE timeframe = $1::"CandleTimeframe"
              AND (EXTRACT(EPOCH FROM "bucketStart") * 1000)::bigint % $2 <> 0
            LIMIT $3
        )
        "#,
    )
    .bind(timeframe)
    .bind(grid_ms)
    .bind(RETENTION_BATCH_SIZE)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Deletes every "Candle" row whose bucketStart is off its timeframe's
/// grid (`crate::bucket_is_aligned`'s definition, see `grid_ms`), one
/// timeframe at a time, in bounded batches. Returns the rows deleted per
/// timeframe (only timeframes that had any), so the caller can log it and
/// a test can assert it.
///
/// Why these rows exist: before EA v1.39 the EA's UTC conversion
/// (`TimeTradeServer() - TimeGMT()`, two second-resolution reads) could
/// come out as 10799/10801 instead of 10800 and stay that way until the
/// next clock sync, so every bar of every history pass in that window
/// landed at hh:mm:01 (or :59) -- a brand-new row one second beside the
/// real bucket, holding the broker's real OHLC while the real row kept its
/// tick-built values, and the authoritative overwrite never met the real
/// row. ingest_history now rejects such bars at the door (b0d3967), which
/// stops new ones; nothing deletes the ones already stored, and the
/// full-history deep backfill only ever writes aligned buckets, so it
/// cannot either. Nothing this engine writes itself is ever off-grid
/// (`bucket_start` floors, gap fills step from a floored start), so an
/// unaligned row can only be one of these phantoms: deleting by predicate
/// alone is safe.
///
/// Idempotent and cheap when clean -- one count per timeframe, no DELETE
/// unless the count is non-zero -- so it runs at every boot and once a
/// night (`spawn_offgrid_sweep`, `spawn_candle_retention`) rather than as
/// a one-off migration someone has to remember to run on each store.
pub async fn sweep_offgrid_candles(pool: &PgPool) -> Vec<(&'static str, u64)> {
    let mut deleted_per_tf: Vec<(&'static str, u64)> = Vec::new();
    for tf in TIMEFRAMES {
        let timeframe = crate::db::timeframe_to_str(tf);
        let grid = grid_ms(tf);
        let pending = match count_offgrid(pool, timeframe, grid).await {
            Ok(n) => n,
            Err(err) => {
                tracing::warn!(?err, timeframe, "off-grid candle sweep: count failed, skipping this timeframe -- next boot/nightly run retries");
                continue;
            }
        };
        if pending == 0 {
            continue;
        }
        tracing::info!(timeframe, off_grid_rows = pending, "off-grid candle sweep: phantom rows found, deleting in batches");
        let mut total_deleted: u64 = 0;
        loop {
            match delete_offgrid_batch(pool, timeframe, grid).await {
                Ok(n) => {
                    total_deleted += n;
                    if n < RETENTION_BATCH_SIZE as u64 {
                        break;
                    }
                    tokio::time::sleep(RETENTION_BATCH_SLEEP).await;
                }
                Err(err) => {
                    tracing::warn!(?err, timeframe, rows_deleted = total_deleted, "off-grid candle sweep: batch delete failed, stopping this timeframe early -- next boot/nightly run retries");
                    break;
                }
            }
        }
        tracing::info!(timeframe, rows_deleted = total_deleted, "off-grid candle sweep: timeframe done");
        deleted_per_tf.push((timeframe, total_deleted));
    }
    deleted_per_tf
}

/// Boot-time off-grid sweep over every write target of the current
/// MARKET_DATA_WRITE mode. Spawned, not awaited, so a slow store can never
/// delay the HTTP listener or the tick flush from starting; the log line
/// per target is the operator's evidence (deploy/deep-backfill-runbook.md
/// reads it back), and a clean store logs `phantom_rows_deleted = 0`.
pub fn spawn_offgrid_sweep(pools: std::sync::Arc<crate::sink::MarketDataPools>) {
    tokio::spawn(async move {
        for (sink, pool) in pools.targets() {
            let deleted = sweep_offgrid_candles(pool).await;
            let total: u64 = deleted.iter().map(|(_, n)| n).sum();
            tracing::info!(sink = sink.as_str(), phantom_rows_deleted = total, per_timeframe = ?deleted, "off-grid candle sweep complete");
        }
    });
}

/// Spawns the nightly job -- sleeps until the next 00:10 UTC, runs M1
/// then M5, then loops (each iteration re-sleeps to the *next* day's
/// 00:10 rather than a flat 24h timer, so a slow pass never drifts the
/// schedule later day over day). CANDLE_M1_RETENTION_DAYS/
/// CANDLE_M5_RETENTION_DAYS default to 30/180 -- both configurable for
/// the same reason (a broker that genuinely needs longer M1 history for
/// some analytics use case shouldn't need a code change to get it), even
/// though only M1's was explicitly asked for.
pub fn spawn_candle_retention(pools: std::sync::Arc<crate::sink::MarketDataPools>) {
    let m1_retention_days = retention_days_from_env("CANDLE_M1_RETENTION_DAYS", 30);
    let m5_retention_days = retention_days_from_env("CANDLE_M5_RETENTION_DAYS", 180);

    // hotfix/terminal-live-bugs round 3 -- this only ever logged on
    // completion (run_retention_pass's own info! at the end of each pass),
    // which is up to 24h after boot for the first run and gives no way to
    // confirm from the log alone that this task is actually scheduled with
    // the config you think it has (e.g. after an env var change) without
    // waiting for it to fire.
    let first_run_at = Utc::now() + ChronoDuration::from_std(duration_until_next_run(Utc::now(), 0, 10)).unwrap_or_default();
    tracing::info!(
        m1_retention_days,
        m5_retention_days,
        next_run_at = %first_run_at.to_rfc3339(),
        "candle retention scheduled"
    );

    tokio::spawn(async move {
        loop {
            let sleep_for = duration_until_next_run(Utc::now(), 0, 10);
            tokio::time::sleep(sleep_for).await;
            // every write target of the current MARKET_DATA_WRITE mode
            // (Neon and / or the VPS store) keeps the same retention
            for (sink, pool) in pools.targets() {
                tracing::info!(sink = sink.as_str(), "candle retention pass");
                run_retention_pass(pool, "M1", m1_retention_days).await;
                run_retention_pass(pool, "M5", m5_retention_days).await;
                // Belt and braces next to the boot-time sweep: a store that
                // somehow grew a phantom again is cleaned within a day, at
                // the cost of one count per timeframe.
                let swept = sweep_offgrid_candles(pool).await;
                tracing::info!(sink = sink.as_str(), phantom_rows_deleted = swept.iter().map(|(_, n)| n).sum::<u64>(), "nightly off-grid candle sweep complete");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn sleeps_until_later_today_when_the_target_time_hasnt_passed_yet() {
        let now = Utc.with_ymd_and_hms(2026, 8, 31, 0, 0, 0).unwrap(); // midnight
        let dur = duration_until_next_run(now, 0, 10);
        assert_eq!(dur, StdDuration::from_secs(10 * 60));
    }

    #[test]
    fn sleeps_until_tomorrow_when_the_target_time_already_passed_today() {
        let now = Utc.with_ymd_and_hms(2026, 8, 31, 12, 0, 0).unwrap(); // noon, well past 00:10
        let dur = duration_until_next_run(now, 0, 10);
        let expected = ChronoDuration::hours(12) + ChronoDuration::minutes(10);
        assert_eq!(dur, expected.to_std().unwrap());
    }

    #[test]
    fn exactly_at_the_target_time_counts_as_already_passed_rolls_to_tomorrow() {
        let now = Utc.with_ymd_and_hms(2026, 8, 31, 0, 10, 0).unwrap();
        let dur = duration_until_next_run(now, 0, 10);
        assert_eq!(dur, StdDuration::from_secs(24 * 60 * 60));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn batched_delete_skips_itself_without_a_live_database() {
        // Same convention as db::tests -- this crate has no live-DB test
        // infrastructure by default (see db.rs's own module doc comment),
        // so this only actually exercises delete_one_batch/run_retention_pass
        // when DATABASE_URL is set, and never fails the build without one.
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return;
        };
        let Ok(pool) = PgPool::connect(&database_url).await else {
            eprintln!("skipping: could not connect to DATABASE_URL");
            return;
        };

        // A cutoff far in the past against an obviously-fake timeframe
        // string would fail the enum cast, so this exercises the real
        // M1 path but with a cutoff of "the epoch" -- nothing genuinely
        // 56 years old exists, so this is a real query that's guaranteed
        // to delete zero rows, proving the query itself is valid SQL
        // against the real schema without risking any real data.
        let ancient_cutoff = Utc.with_ymd_and_hms(1970, 1, 1, 0, 0, 0).unwrap();
        let deleted = delete_one_batch(&pool, "M1", ancient_cutoff).await.expect("query should succeed");
        assert_eq!(deleted, 0, "a cutoff of the Unix epoch must never match any real row");
    }

    #[test]
    fn the_sql_grid_agrees_with_bucket_is_aligned_for_every_timeframe() {
        // grid_ms is the SQL side of crate::bucket_is_aligned; if the two
        // ever disagree the sweep would delete real rows (too strict) or
        // leave phantoms (too loose). Probe every timeframe at its own
        // grid, one minute off it, and one second off it.
        for tf in TIMEFRAMES {
            let g = grid_ms(tf);
            for probe in [0i64, g, 7 * g, g + 60_000, g + 1_000, g - 1_000, g + 500] {
                let sql_aligned = probe.rem_euclid(g) == 0;
                assert_eq!(sql_aligned, crate::bucket_is_aligned(tf, probe), "{tf:?} at {probe}ms");
            }
        }
    }

    /// fix/deep-backfill-full-history -- the sweep must delete exactly the
    /// off-grid rows and nothing else. Seeds, per timeframe, one aligned row
    /// and the two phantom shapes a pre-v1.39 EA produced (bucket + 1s for a
    /// 10799 offset, bucket - 1s for 10801), plus an M5 row on the M1 grid
    /// but off the M5 grid, plus H4/D1 rows at broker-offset boundaries
    /// (21:00, 01:00 UTC -- aligned to the minute, must survive).
    #[tokio::test]
    async fn offgrid_sweep_deletes_only_the_phantom_rows() {
        let Ok(url) = std::env::var("MARKET_DATA_TEST_LOCAL_URL") else {
            eprintln!("skipping: MARKET_DATA_TEST_LOCAL_URL not set");
            return;
        };
        let pool = PgPool::connect(&url).await.expect("connect");
        let symbol = format!("TESTDB_OFFGRID{}", Utc::now().timestamp_millis() % 1_000_000);
        let base = Utc.with_ymd_and_hms(2026, 8, 12, 12, 0, 0).unwrap(); // on every fixed grid (12:00 = M1..H1 aligned)
        let insert = |tf: &'static str, at: DateTime<Utc>| {
            let symbol = symbol.clone();
            let pool = pool.clone();
            async move {
                sqlx::query(r#"INSERT INTO "Candle" (symbol, timeframe, "bucketStart", open, high, low, close, "updatedAt") VALUES ($1, $2::"CandleTimeframe", $3, 1, 2, 0.5, 1.5, now())"#)
                    .bind(symbol)
                    .bind(tf)
                    .bind(at)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        };
        let sec = |n: i64| ChronoDuration::seconds(n);
        // Survivors: one aligned row per timeframe, plus broker-boundary H4/D1/W1.
        let keep: Vec<(&'static str, DateTime<Utc>)> = vec![
            ("M1", base), ("M1", base + sec(60)),
            ("M5", base), ("M15", base), ("M30", base), ("H1", base),
            ("H4", Utc.with_ymd_and_hms(2026, 8, 12, 1, 0, 0).unwrap()),   // UTC+3 broker: H4 opens 01:00 UTC
            ("D1", Utc.with_ymd_and_hms(2026, 8, 11, 21, 0, 0).unwrap()),  // UTC+3 broker: D1 opens 21:00 UTC
            ("D1", Utc.with_ymd_and_hms(2026, 8, 11, 21, 30, 0).unwrap()), // a :30 offset broker is still on the minute grid
            ("W1", Utc.with_ymd_and_hms(2026, 8, 9, 21, 0, 0).unwrap()),
            ("MN1", Utc.with_ymd_and_hms(2026, 7, 31, 21, 0, 0).unwrap()),
        ];
        // Phantoms: the two second-offset shapes, a sub-second one, and an M5 on the wrong grid.
        let drop: Vec<(&'static str, DateTime<Utc>)> = vec![
            ("M1", base + sec(1)), ("M1", base + sec(60) - sec(1)),
            ("M5", base + sec(1)), ("M5", base + sec(60)),               // 12:01:00 is M1-aligned, not an M5 bucket
            ("M15", base + sec(1)), ("M30", base - sec(1)), ("H1", base + sec(1)),
            ("H4", Utc.with_ymd_and_hms(2026, 8, 12, 1, 0, 1).unwrap()),
            ("D1", Utc.with_ymd_and_hms(2026, 8, 11, 21, 0, 1).unwrap()),
            ("W1", Utc.with_ymd_and_hms(2026, 8, 9, 20, 59, 59).unwrap()),
            ("M1", base + ChronoDuration::milliseconds(500)),
        ];
        for (tf, at) in keep.iter().chain(drop.iter()) {
            insert(tf, *at).await;
        }

        // The sweep is table-wide (that is the point), and this DB is shared
        // with other tests' fixtures, so the counts are lower bounds; the
        // exact property is asserted on this symbol's surviving rows below.
        let deleted = sweep_offgrid_candles(&pool).await;
        let total: u64 = deleted.iter().map(|(_, n)| n).sum();
        assert!(total as usize >= drop.len(), "at least this symbol's phantoms deleted: {deleted:?}");
        assert!(deleted.iter().any(|(tf, n)| *tf == "M5" && *n >= 2), "both M5 phantoms (off-second and on the M1 grid) counted under M5: {deleted:?}");

        let remaining: Vec<(String, DateTime<Utc>)> = sqlx::query_as(r#"SELECT timeframe::text, "bucketStart" FROM "Candle" WHERE symbol = $1 ORDER BY 1, 2"#)
            .bind(&symbol)
            .fetch_all(&pool)
            .await
            .unwrap();
        let mut expected: Vec<(String, DateTime<Utc>)> = keep.iter().map(|(tf, at)| (tf.to_string(), *at)).collect();
        expected.sort();
        assert_eq!(remaining, expected, "exactly the aligned rows survive");

        // Idempotent: a second pass finds nothing left under this symbol.
        let _ = sweep_offgrid_candles(&pool).await;
        let still: Vec<(String, DateTime<Utc>)> = sqlx::query_as(r#"SELECT timeframe::text, "bucketStart" FROM "Candle" WHERE symbol = $1 ORDER BY 1, 2"#)
            .bind(&symbol)
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(still, expected, "second sweep is a no-op for the aligned rows");

        sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1"#).bind(&symbol).execute(&pool).await.unwrap();
    }
}
