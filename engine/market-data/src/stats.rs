//! In-process feed-latency/health counters — Phase 4 of the tick-pipeline
//! audit. Deliberately not Prometheus/Grafana: at this scale (one
//! process, one Postgres, no fleet), an in-memory rolling window plus a
//! handful of atomic counters is the right-sized tool, matching this
//! workspace's existing "no metrics infra anywhere yet" baseline. Read
//! via `GET /internal/feed-stats` (engine/server/src/main.rs), same
//! shared-secret guard as the order routes.

use chrono::Utc;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Mutex;

const WINDOW: usize = 500;

// A DB flush that's timing out on every attempt would otherwise log once
// per flush interval -- up to 4/s at the 250ms LivePrice cadence, which is
// exactly the "spam logs" half of the Contabo incident this exists to
// fix. The failure counters below still record every single failure for
// /internal/feed-stats; this only throttles what actually prints.
const LOG_RATE_LIMIT_MS: i64 = 30_000;

pub struct FeedStats {
    latencies_ms: Mutex<VecDeque<i64>>,
    ticks_ingested_total: AtomicU64,
    ticks_missing_t0_total: AtomicU64,
    ticks_dropped_invalid_total: AtomicU64,
    // t0 is meant to be UTC epoch ms (see protocol::Tick's doc comment) --
    // a delta outside [0, 60_000]ms against this engine's own UTC clock
    // means either the EA sent a broker-local timestamp instead of UTC
    // (confirmed live: Pepperstone's UTC+3 offset alone produced a
    // constant -10,800,000ms p50 before the EA-side fix) or genuine clock
    // skew large enough to be more noise than signal. Counted here and
    // excluded from the latency window entirely, rather than recorded as
    // a real (garbage) sample -- a single bad delta would otherwise
    // dominate p50/p95 for the next WINDOW ticks.
    t0_invalid_total: AtomicU64,
    nats_publish_failures_total: AtomicU64,
    nats_publish_success_total: AtomicU64,
    candle_write_failures_total: AtomicU64,
    // Shared across both flush loops (LivePrice and Candle) -- the
    // Contabo audit asked for one db_ok/db_fail/db_lag_ms trio, not one
    // pair per table, so both loops report into the same counters.
    // candle_write_failures_total above stays too, for the more granular
    // per-table breakdown that already existed.
    db_write_success_total: AtomicU64,
    db_write_failure_total: AtomicU64,
    last_db_lag_ms: AtomicI64,
    live_price_failure_last_logged_ms: AtomicI64,
    candle_failure_last_logged_ms: AtomicI64,
}

impl FeedStats {
    pub fn new() -> Self {
        Self {
            latencies_ms: Mutex::new(VecDeque::with_capacity(WINDOW)),
            ticks_ingested_total: AtomicU64::new(0),
            ticks_missing_t0_total: AtomicU64::new(0),
            ticks_dropped_invalid_total: AtomicU64::new(0),
            t0_invalid_total: AtomicU64::new(0),
            nats_publish_failures_total: AtomicU64::new(0),
            nats_publish_success_total: AtomicU64::new(0),
            candle_write_failures_total: AtomicU64::new(0),
            db_write_success_total: AtomicU64::new(0),
            db_write_failure_total: AtomicU64::new(0),
            last_db_lag_ms: AtomicI64::new(0),
            live_price_failure_last_logged_ms: AtomicI64::new(0),
            candle_failure_last_logged_ms: AtomicI64::new(0),
        }
    }

    /// `ms` is EA-capture-to-Rust-ingest latency, only computable when the
    /// tick carried a `t0` (see protocol::Tick's doc comment) -- a
    /// negative value (clock skew between the MT5 terminal and this host)
    /// is still recorded as-is rather than discarded, since a consistently
    /// negative reading is itself a real signal (clock drift) worth
    /// surfacing, not noise to hide.
    pub fn record_latency_ms(&self, ms: i64) {
        let mut guard = self.latencies_ms.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() == WINDOW {
            guard.pop_front();
        }
        guard.push_back(ms);
        self.ticks_ingested_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_missing_t0(&self) {
        self.ticks_missing_t0_total.fetch_add(1, Ordering::Relaxed);
        self.ticks_ingested_total.fetch_add(1, Ordering::Relaxed);
    }

    /// The tick still counts toward ticks_in (it was really ingested,
    /// just with an unusable timestamp) -- only the latency window and
    /// its percentiles exclude it.
    pub fn record_invalid_t0(&self) {
        self.t0_invalid_total.fetch_add(1, Ordering::Relaxed);
        self.ticks_ingested_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_dropped_invalid(&self, count: u64) {
        self.ticks_dropped_invalid_total.fetch_add(count, Ordering::Relaxed);
    }

    pub fn record_nats_publish_failure(&self) {
        self.nats_publish_failures_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_candle_write_failure(&self) {
        self.candle_write_failures_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_nats_publish_success(&self) {
        self.nats_publish_success_total.fetch_add(1, Ordering::Relaxed);
    }

    /// Called by both flush loops (LivePrice and Candle) after every
    /// attempt, success or failure -- `lag_ms` is that attempt's own
    /// duration (including a timed-out attempt, whose lag is the timeout
    /// itself), so `db_lag_ms` in the snapshot always reflects the most
    /// recent flush of either kind, whichever finished last.
    pub fn record_db_write(&self, ok: bool, lag_ms: i64) {
        if ok {
            self.db_write_success_total.fetch_add(1, Ordering::Relaxed);
        } else {
            self.db_write_failure_total.fetch_add(1, Ordering::Relaxed);
        }
        self.last_db_lag_ms.store(lag_ms, Ordering::Relaxed);
    }

    pub fn should_log_live_price_failure(&self) -> bool {
        Self::gate(&self.live_price_failure_last_logged_ms)
    }

    pub fn should_log_candle_failure(&self) -> bool {
        Self::gate(&self.candle_failure_last_logged_ms)
    }

    // Not a compare-and-swap loop -- a race where two threads both pass
    // this check in the same instant means (at most) one extra log line
    // once every 30s, an acceptable trade for not needing retry logic in
    // a rate limiter.
    fn gate(last_logged: &AtomicI64) -> bool {
        let now = Utc::now().timestamp_millis();
        let last = last_logged.load(Ordering::Relaxed);
        if now - last >= LOG_RATE_LIMIT_MS {
            last_logged.store(now, Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    pub fn snapshot(&self) -> FeedStatsSnapshot {
        let guard = self.latencies_ms.lock().unwrap_or_else(|e| e.into_inner());
        let mut sorted: Vec<i64> = guard.iter().copied().collect();
        sorted.sort_unstable();
        let percentile = |p: f64| -> Option<i64> {
            if sorted.is_empty() {
                return None;
            }
            let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
            sorted.get(idx).copied()
        };

        FeedStatsSnapshot {
            sample_count: sorted.len(),
            ea_to_engine_ms_last: guard.back().copied(),
            ea_to_engine_ms_p50: percentile(0.50),
            ea_to_engine_ms_p95: percentile(0.95),
            p99_ms: percentile(0.99),
            max_ms: sorted.last().copied(),
            ticks_in: self.ticks_ingested_total.load(Ordering::Relaxed),
            ticks_missing_t0_total: self.ticks_missing_t0_total.load(Ordering::Relaxed),
            ticks_dropped_invalid_total: self.ticks_dropped_invalid_total.load(Ordering::Relaxed),
            t0_invalid: self.t0_invalid_total.load(Ordering::Relaxed),
            nats_out: self.nats_publish_success_total.load(Ordering::Relaxed),
            nats_publish_failures_total: self.nats_publish_failures_total.load(Ordering::Relaxed),
            candle_write_failures_total: self.candle_write_failures_total.load(Ordering::Relaxed),
            db_ok: self.db_write_success_total.load(Ordering::Relaxed),
            db_fail: self.db_write_failure_total.load(Ordering::Relaxed),
            db_lag_ms: self.last_db_lag_ms.load(Ordering::Relaxed),
        }
    }
}

impl Default for FeedStats {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize)]
pub struct FeedStatsSnapshot {
    pub sample_count: usize,
    // Renamed from current_ms/p50_ms/p95_ms -- p99_ms/max_ms keep their
    // names, only the {last,p50,p95} headline trio moved to this scheme.
    pub ea_to_engine_ms_last: Option<i64>,
    pub ea_to_engine_ms_p50: Option<i64>,
    pub ea_to_engine_ms_p95: Option<i64>,
    pub p99_ms: Option<i64>,
    pub max_ms: Option<i64>,
    // Renamed from ticks_ingested_total to match the Contabo audit's
    // requested field names exactly (ticks_in/nats_out/db_ok/db_fail/
    // db_lag_ms) -- same counter, no behavior change.
    pub ticks_in: u64,
    pub ticks_missing_t0_total: u64,
    pub ticks_dropped_invalid_total: u64,
    pub t0_invalid: u64,
    pub nats_out: u64,
    pub nats_publish_failures_total: u64,
    pub candle_write_failures_total: u64,
    pub db_ok: u64,
    pub db_fail: u64,
    pub db_lag_ms: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_are_none_with_no_samples() {
        let stats = FeedStats::new();
        let snap = stats.snapshot();
        assert_eq!(snap.sample_count, 0);
        assert_eq!(snap.ea_to_engine_ms_p50, None);
        assert_eq!(snap.max_ms, None);
    }

    #[test]
    fn max_and_current_track_correctly() {
        let stats = FeedStats::new();
        for ms in [10, 50, 20, 90, 30] {
            stats.record_latency_ms(ms);
        }
        let snap = stats.snapshot();
        assert_eq!(snap.sample_count, 5);
        assert_eq!(snap.max_ms, Some(90));
        assert_eq!(snap.ea_to_engine_ms_last, Some(30)); // last one recorded
        assert_eq!(snap.ticks_in, 5);
    }

    #[test]
    fn invalid_t0_is_excluded_from_the_latency_window_but_still_counts_as_ingested() {
        let stats = FeedStats::new();
        stats.record_latency_ms(50);
        stats.record_invalid_t0();
        stats.record_invalid_t0();
        let snap = stats.snapshot();
        assert_eq!(snap.sample_count, 1); // only the one real latency sample
        assert_eq!(snap.ea_to_engine_ms_last, Some(50));
        assert_eq!(snap.t0_invalid, 2);
        assert_eq!(snap.ticks_in, 3); // 1 real + 2 invalid-t0, all "ingested"
    }

    #[test]
    fn window_evicts_oldest_beyond_capacity() {
        let stats = FeedStats::new();
        for ms in 0..(WINDOW as i64 + 10) {
            stats.record_latency_ms(ms);
        }
        let snap = stats.snapshot();
        assert_eq!(snap.sample_count, WINDOW);
        // the oldest 10 samples (0..10) should have been evicted
        assert_eq!(snap.max_ms, Some(WINDOW as i64 + 9));
    }
}
