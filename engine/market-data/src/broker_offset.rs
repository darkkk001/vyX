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

use protocol::Tick;
use std::sync::atomic::{AtomicI64, Ordering};

pub struct BrokerOffsetTracker {
    // 0 = "no tick has ever reported a real offset yet" (an EA build that
    // predates this field, or the very first moments after startup before
    // any tick has arrived) -- broker_day_start's own doc comment
    // guarantees offset=0 reduces to the old naive-UTC-midnight math, so
    // this default is a safe, zero-behavior-change starting point rather
    // than a guess.
    current_sec: AtomicI64,
}

impl BrokerOffsetTracker {
    pub fn new() -> Self {
        Self { current_sec: AtomicI64::new(0) }
    }

    /// Records `tick`'s own broker_offset_sec if it carries one (Relaxed
    /// ordering: this is a plain "last write wins" gauge, not a value
    /// anything synchronizes other memory against), and returns the
    /// tracker's resulting current value either way -- callers use the
    /// return value directly instead of a separate load, so a tick that
    /// does carry a fresh offset is bucketed against that exact value
    /// even if another thread's read of `current()` races it.
    pub fn observe(&self, tick: &Tick) -> i64 {
        if let Some(offset) = tick.broker_offset_sec {
            self.current_sec.store(offset, Ordering::Relaxed);
            offset
        } else {
            self.current_sec.load(Ordering::Relaxed)
        }
    }

    /// The last-observed offset, for a caller with no tick of its own to
    /// hand `observe` (the gap-fill sweep, which runs on a timer).
    pub fn current(&self) -> i64 {
        self.current_sec.load(Ordering::Relaxed)
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
        }
    }

    #[test]
    fn defaults_to_zero_before_any_tick_reports_an_offset() {
        let tracker = BrokerOffsetTracker::new();
        assert_eq!(tracker.current(), 0);
    }

    #[test]
    fn observe_records_and_returns_a_fresh_offset() {
        let tracker = BrokerOffsetTracker::new();
        let returned = tracker.observe(&tick_with_offset(Some(3 * 3600)));
        assert_eq!(returned, 3 * 3600);
        assert_eq!(tracker.current(), 3 * 3600);
    }

    #[test]
    fn a_tick_with_no_offset_leaves_the_last_known_value_in_place() {
        let tracker = BrokerOffsetTracker::new();
        tracker.observe(&tick_with_offset(Some(3 * 3600)));
        let returned = tracker.observe(&tick_with_offset(None)); // an old-build EA tick, or a heartbeat that omitted it
        assert_eq!(returned, 3 * 3600);
        assert_eq!(tracker.current(), 3 * 3600);
    }

    #[test]
    fn a_dst_shift_updates_the_tracked_value_on_the_next_tick_that_reports_it() {
        let tracker = BrokerOffsetTracker::new();
        tracker.observe(&tick_with_offset(Some(3 * 3600)));
        tracker.observe(&tick_with_offset(Some(2 * 3600)));
        assert_eq!(tracker.current(), 2 * 3600);
    }
}
