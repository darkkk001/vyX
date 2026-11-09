//! Tracks the single upstream price source's broker-server-to-UTC offset
//! (protocol::Tick's `broker_offset_sec`, the EA's `BrokerOffsetSec`) so
//! the live tick-aggregation path (`bucket_start`) and the gap-fill sweep
//! (which runs on its own timer, independent of any specific tick) can
//! both bucket D1/W1/Mn1/Y1 candles at the broker's own day boundary --
//! see `bucket_start`/`broker_day_start`'s own doc comments for why.
//!
//! There is exactly one upstream price source today (see ingest.rs's own
//! module doc on this crate being "broker-agnostic raw market data"), so
//! this is a single global value, not one per (symbol, broker) pair --
//! every symbol this crate ingests comes from the same MT5 terminal and
//! shares the same broker-server clock.

use crate::ny_close_server_offset_sec;
use chrono::{DateTime, Utc};
use protocol::Tick;
use std::sync::atomic::{AtomicI64, Ordering};

/// Sentinel: no tick has reported an offset yet.
const UNSET: i64 = i64::MIN;

pub struct BrokerOffsetTracker {
    // UNSET = "no tick has ever reported a real offset yet". Until one does,
    // current() answers with the New-York-close rule's offset for now
    // (market_data::ny_close_server_offset_sec: +3h in US summer time, +2h
    // otherwise), never 0 -- an offset of 0 files calendar bars at 00:00 UTC,
    // a second key beside the real broker-day one.
    current_sec: AtomicI64,
}

impl BrokerOffsetTracker {
    pub fn new() -> Self {
        Self { current_sec: AtomicI64::new(UNSET) }
    }

    /// Records `tick`'s own broker_offset_sec if it carries one (Relaxed
    /// ordering: this is a plain "last write wins" gauge, not a value
    /// anything synchronizes other memory against), and returns the
    /// tracker's resulting current value either way -- callers use the
    /// return value directly instead of a separate load, so a tick that
    /// does carry a fresh offset is bucketed against that exact value
    /// even if another thread's read of `current()` races it.
    ///
    /// A tick WITHOUT an offset is bucketed with the New-York-close rule's
    /// offset for now; it does not touch the stored value.
    pub fn observe(&self, tick: &Tick) -> i64 {
        self.observe_at(tick, Utc::now())
    }

    /// `observe` with an injected clock (tests).
    pub fn observe_at(&self, tick: &Tick, now: DateTime<Utc>) -> i64 {
        if let Some(offset) = tick.broker_offset_sec {
            self.current_sec.store(offset, Ordering::Relaxed);
            offset
        } else {
            ny_close_server_offset_sec(now)
        }
    }

    /// The last-reported offset (or the New-York-close rule's offset for now
    /// when none has been reported), for a caller with no tick of its own to
    /// hand `observe` (the gap-fill sweep, which runs on a timer).
    pub fn current(&self) -> i64 {
        self.current_at(Utc::now())
    }

    /// `current` with an injected clock (tests).
    pub fn current_at(&self, now: DateTime<Utc>) -> i64 {
        match self.current_sec.load(Ordering::Relaxed) {
            UNSET => ny_close_server_offset_sec(now),
            v => v,
        }
    }
}

impl Default for BrokerOffsetTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tick_with_offset(offset: Option<i64>) -> Tick {
        Tick {
            symbol: "EURUSD".into(),
            bid: Default::default(),
            ask: Default::default(),
            t0: None,
            clock_offset_ms: None,
            rtt_ms: None,
            tick_ms: None,
            broker_offset_sec: offset,
            bars: Vec::new(), tick_count: None,
        }
    }

    fn at(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        use chrono::TimeZone;
        Utc.with_ymd_and_hms(y, m, d, 12, 0, 0).unwrap()
    }

    #[test]
    fn before_any_tick_reports_an_offset_current_is_the_ny_close_rule() {
        let tracker = BrokerOffsetTracker::new();
        assert_eq!(tracker.current_at(at(2026, 7, 15)), 3 * 3600, "US summer time");
        assert_eq!(tracker.current_at(at(2026, 12, 15)), 2 * 3600, "winter");
        assert_ne!(tracker.current(), 0);
    }

    #[test]
    fn a_tick_without_an_offset_uses_the_rule_and_does_not_store_it() {
        let tracker = BrokerOffsetTracker::new();
        assert_eq!(tracker.observe_at(&tick_with_offset(None), at(2026, 7, 15)), 3 * 3600);
        assert_eq!(tracker.observe_at(&tick_with_offset(None), at(2026, 12, 15)), 2 * 3600);
    }

    #[test]
    fn observe_records_and_returns_a_fresh_offset() {
        let tracker = BrokerOffsetTracker::new();
        let returned = tracker.observe(&tick_with_offset(Some(3 * 3600)));
        assert_eq!(returned, 3 * 3600);
        assert_eq!(tracker.current(), 3 * 3600);
    }

    #[test]
    fn a_tick_with_no_offset_uses_the_rule_while_current_keeps_the_last_reported_value() {
        let tracker = BrokerOffsetTracker::new();
        tracker.observe(&tick_with_offset(Some(3 * 3600)));
        let returned = tracker.observe_at(&tick_with_offset(None), at(2026, 12, 15));
        assert_eq!(returned, 2 * 3600);
        assert_eq!(tracker.current_at(at(2026, 12, 15)), 3 * 3600);
    }

    #[test]
    fn a_dst_shift_updates_the_tracked_value_on_the_next_tick_that_reports_it() {
        let tracker = BrokerOffsetTracker::new();
        tracker.observe(&tick_with_offset(Some(3 * 3600)));
        tracker.observe(&tick_with_offset(Some(2 * 3600)));
        assert_eq!(tracker.current(), 2 * 3600);
    }
}
