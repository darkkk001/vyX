//! In-process feed-latency/health counters — Phase 4 of the tick-pipeline
//! audit. Deliberately not Prometheus/Grafana: at this scale (one
//! process, one Postgres, no fleet), an in-memory rolling window plus a
//! handful of atomic counters is the right-sized tool, matching this
//! workspace's existing "no metrics infra anywhere yet" baseline. Read
//! via `GET /internal/feed-stats` (engine/server/src/main.rs), same
//! shared-secret guard as the order routes.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const WINDOW: usize = 500;

pub struct FeedStats {
    latencies_ms: Mutex<VecDeque<i64>>,
    ticks_ingested_total: AtomicU64,
    ticks_missing_t0_total: AtomicU64,
    ticks_dropped_invalid_total: AtomicU64,
    nats_publish_failures_total: AtomicU64,
    candle_write_failures_total: AtomicU64,
}

impl FeedStats {
    pub fn new() -> Self {
        Self {
            latencies_ms: Mutex::new(VecDeque::with_capacity(WINDOW)),
            ticks_ingested_total: AtomicU64::new(0),
            ticks_missing_t0_total: AtomicU64::new(0),
            ticks_dropped_invalid_total: AtomicU64::new(0),
            nats_publish_failures_total: AtomicU64::new(0),
            candle_write_failures_total: AtomicU64::new(0),
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

    pub fn record_dropped_invalid(&self, count: u64) {
        self.ticks_dropped_invalid_total.fetch_add(count, Ordering::Relaxed);
    }

    pub fn record_nats_publish_failure(&self) {
        self.nats_publish_failures_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_candle_write_failure(&self) {
        self.candle_write_failures_total.fetch_add(1, Ordering::Relaxed);
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
            current_ms: guard.back().copied(),
            p50_ms: percentile(0.50),
            p95_ms: percentile(0.95),
            p99_ms: percentile(0.99),
            max_ms: sorted.last().copied(),
            ticks_ingested_total: self.ticks_ingested_total.load(Ordering::Relaxed),
            ticks_missing_t0_total: self.ticks_missing_t0_total.load(Ordering::Relaxed),
            ticks_dropped_invalid_total: self.ticks_dropped_invalid_total.load(Ordering::Relaxed),
            nats_publish_failures_total: self.nats_publish_failures_total.load(Ordering::Relaxed),
            candle_write_failures_total: self.candle_write_failures_total.load(Ordering::Relaxed),
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
    pub current_ms: Option<i64>,
    pub p50_ms: Option<i64>,
    pub p95_ms: Option<i64>,
    pub p99_ms: Option<i64>,
    pub max_ms: Option<i64>,
    pub ticks_ingested_total: u64,
    pub ticks_missing_t0_total: u64,
    pub ticks_dropped_invalid_total: u64,
    pub nats_publish_failures_total: u64,
    pub candle_write_failures_total: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_are_none_with_no_samples() {
        let stats = FeedStats::new();
        let snap = stats.snapshot();
        assert_eq!(snap.sample_count, 0);
        assert_eq!(snap.p50_ms, None);
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
        assert_eq!(snap.current_ms, Some(30)); // last one recorded
        assert_eq!(snap.ticks_ingested_total, 5);
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
