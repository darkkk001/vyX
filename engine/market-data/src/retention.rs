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

/// Spawns the nightly job -- sleeps until the next 00:10 UTC, runs M1
/// then M5, then loops (each iteration re-sleeps to the *next* day's
/// 00:10 rather than a flat 24h timer, so a slow pass never drifts the
/// schedule later day over day). CANDLE_M1_RETENTION_DAYS/
/// CANDLE_M5_RETENTION_DAYS default to 30/180 -- both configurable for
/// the same reason (a broker that genuinely needs longer M1 history for
/// some analytics use case shouldn't need a code change to get it), even
/// though only M1's was explicitly asked for.
pub fn spawn_candle_retention(pool: PgPool) {
    let m1_retention_days = retention_days_from_env("CANDLE_M1_RETENTION_DAYS", 30);
    let m5_retention_days = retention_days_from_env("CANDLE_M5_RETENTION_DAYS", 180);

    tokio::spawn(async move {
        loop {
            let sleep_for = duration_until_next_run(Utc::now(), 0, 10);
            tokio::time::sleep(sleep_for).await;
            run_retention_pass(&pool, "M1", m1_retention_days).await;
            run_retention_pass(&pool, "M5", m5_retention_days).await;
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
}
