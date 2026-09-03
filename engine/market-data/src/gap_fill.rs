//! Flat-fill for missing candle buckets — fix/realtime-sync §4. The
//! engine only ever creates a bucket when a tick actually arrives
//! (`candle_updates_for_tick`), so a quiet period (a symbol with no
//! trades, or the engine itself briefly down) leaves a real hole on a
//! categorical time axis. This tracks the last bucket actually written
//! per (symbol, timeframe) and, when a new real tick's bucket has
//! advanced by more than one step, synthesizes flat bars (open = high =
//! low = close = the previous close, matching how every real charting
//! platform represents "no trades this period") for every bucket in
//! between — except across a real market close, where a gap is correct,
//! not missing data.

use crate::{fixed_ms, CandleUpdate, Timeframe};
use chrono::{DateTime, Datelike, Duration, Timelike, Utc, Weekday};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::sync::Mutex;

// Standard global FX weekend close, the same window every major venue
// observes regardless of broker -- deliberately NOT Broker.tradingHaltedAt
// or the per-BrokerSymbol TradingSession config (app/api/manage/symbols'
// own trading-hours feature): those are a broker's own business-rule
// restriction layered on top of whether the underlying market is even
// open, and this crate's ticks are broker-agnostic raw market data (see
// ingest.rs's own module doc) with no broker context to read that config
// against anyway. A gap here means "the real market was shut," not
// "this particular broker chose not to allow trading."
//
// hotfix/terminal-live-bugs round 2 -- production still had flat bars
// across a real Sat/Sun close (08-29 -> 08-30), so whatever built this
// exclusion never actually reached the Contabo binary (see the round-2
// deploy notes: this needs a real `cargo build --release -p server` +
// service restart, not just a git pull). While fixing that, tightened the
// Friday boundary from hour>=22 to hour>=21 per the explicit ask: real FX
// close is NY 17:00, which is 21:00 UTC in winter (EST) and 22:00 UTC in
// summer (EDT) -- this picks the earlier, DST-safe bound rather than
// tracking the actual DST transition date, so at most it skips
// flat-filling one real trading hour (Fri 21:00-22:00 UTC) during EDT
// months, never the reverse (never flat-fills real market-closed time).
// A correct fix needs either a DST-aware clock or the real per-symbol
// TradingSession config this module's own comment above already says it
// deliberately doesn't have access to.
fn market_closed(t: DateTime<Utc>) -> bool {
    match t.weekday() {
        Weekday::Sat => true,
        Weekday::Fri => t.hour() >= 21,
        Weekday::Sun => t.hour() < 22,
        _ => false,
    }
}

// hotfix/terminal-live-bugs round 2 -- market_closed() above is a FX/
// metals weekend rule; applying it unconditionally to every symbol was
// itself wrong for the handful of crypto pairs this platform lists
// (SYMBOL_DEFS in lib/market-simulator.ts), which trade continuously and
// have no weekend close at all. This crate has no live per-symbol
// category/session lookup (see the module doc above), so this is a static
// allowlist matching that same client-side list -- keep it in sync if a
// new crypto symbol is ever added. A real fix is the same TradingSession-
// config lookup noted above, scoped per symbol instead of a hardcoded list.
fn is_continuously_traded(symbol: &str) -> bool {
    matches!(symbol, "BTCUSD" | "ETHUSD")
}

// Caps how many flat-fill bars a single tick can generate -- protects
// against a pathological gap (the engine down for days, or a stale
// tracker entry) turning one flush cycle into tens of thousands of
// inserts. A gap this large is exactly what the EA's own 15-minute
// CopyRates backfill (mt5-ea/VyXTraderPriceFeed.mq5) exists to repair
// with real data anyway -- this cap just bounds the live path's own
// worst case, not the eventual correctness of the history.
const MAX_GAP_FILLS_PER_TICK: usize = 500;

struct LastBucket {
    start: DateTime<Utc>,
    close: Decimal,
}

pub struct GapFillTracker {
    last: Mutex<HashMap<(String, Timeframe), LastBucket>>,
}

impl GapFillTracker {
    pub fn new() -> Self {
        Self { last: Mutex::new(HashMap::new()) }
    }

    /// Call once per real CandleUpdate before persisting it. Returns any
    /// synthetic flat-fill bars for buckets skipped since the last one
    /// recorded for this exact (symbol, timeframe) -- empty on the very
    /// first tick ever seen for a pair (nothing to compare against) or
    /// for a non-fixed-duration timeframe (W1/Mn1/Y1 -- gaps at that
    /// scale aren't worth this). Always records `update`'s own bucket as
    /// the new last-known one, whether or not any fills were produced.
    pub fn fill_gaps_and_record(&self, update: &CandleUpdate) -> Vec<CandleUpdate> {
        let mut fills = Vec::new();
        let Some(step_ms) = fixed_ms(update.timeframe) else {
            return fills;
        };

        let mut guard = match self.last.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let key = (update.symbol.clone(), update.timeframe);

        if let Some(prev) = guard.get(&key) {
            let mut cursor = prev.start + Duration::milliseconds(step_ms);
            let carry_close = prev.close;
            let mut count = 0usize;
            while cursor < update.bucket_start && count < MAX_GAP_FILLS_PER_TICK {
                if is_continuously_traded(&update.symbol) || !market_closed(cursor) {
                    fills.push(CandleUpdate {
                        symbol: update.symbol.clone(),
                        timeframe: update.timeframe,
                        bucket_start: cursor,
                        open: carry_close,
                        high: carry_close,
                        low: carry_close,
                        close: carry_close,
                    });
                }
                cursor += Duration::milliseconds(step_ms);
                count += 1;
            }
        }

        guard.insert(key, LastBucket { start: update.bucket_start, close: update.close });
        fills
    }

    /// hotfix/terminal-live-bugs round 5 -- "flat-fill written promptly,
    /// not lazily." fill_gaps_and_record above only ever runs when a real
    /// tick arrives, so a genuinely quiet symbol (or one whose tick rate
    /// is slower than a bucket period) could sit with an incomplete
    /// series for however long until the next real tick happens to land
    /// -- a client fetching history in that window sees the hole. Called
    /// on its own timer (see ingest::spawn_periodic_flush's sweep loop),
    /// not from the tick path, so it needs its own read of "now" rather
    /// than a tick's own bucket.
    ///
    /// Deliberately does NOT claim the bucket containing `now` itself --
    /// that one is still open and a real tick landing in it a moment
    /// later must still be the one to own it, not a synthetic sweep
    /// value. Only fully-closed buckets strictly before `now`'s own
    /// bucket are ever filled or recorded as the new "last known" point,
    /// so a subsequent real tick's own fill_gaps_and_record call sees a
    /// consistent, non-overlapping continuation.
    pub fn sweep_stale_buckets(&self, now: DateTime<Utc>, broker_offset_sec: i64) -> Vec<CandleUpdate> {
        let mut fills = Vec::new();
        let mut guard = match self.last.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };

        for ((symbol, timeframe), last) in guard.iter_mut() {
            let Some(step_ms) = fixed_ms(*timeframe) else {
                continue;
            };
            let now_bucket = crate::bucket_start(*timeframe, now, broker_offset_sec);
            let step = Duration::milliseconds(step_ms);
            let mut cursor = last.start + step;
            let carry_close = last.close;
            let mut count = 0usize;
            let mut advanced_to = last.start;

            while cursor < now_bucket && count < MAX_GAP_FILLS_PER_TICK {
                if is_continuously_traded(symbol) || !market_closed(cursor) {
                    fills.push(CandleUpdate {
                        symbol: symbol.clone(),
                        timeframe: *timeframe,
                        bucket_start: cursor,
                        open: carry_close,
                        high: carry_close,
                        low: carry_close,
                        close: carry_close,
                    });
                }
                advanced_to = cursor;
                cursor += step;
                count += 1;
            }

            if advanced_to > last.start {
                last.start = advanced_to; // close stays carry_close -- nothing real happened
            }
        }

        fills
    }
}

impl Default for GapFillTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rust_decimal_macros::dec;

    fn update(symbol: &str, tf: Timeframe, bucket_start: DateTime<Utc>, close: Decimal) -> CandleUpdate {
        CandleUpdate { symbol: symbol.to_string(), timeframe: tf, bucket_start, open: close, high: close, low: close, close }
    }

    #[test]
    fn first_tick_ever_for_a_pair_produces_no_fills() {
        let tracker = GapFillTracker::new();
        let now = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap(); // Wednesday
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, now, dec!(1.1)));
        assert!(fills.is_empty());
    }

    #[test]
    fn consecutive_buckets_produce_no_fills() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        let t1 = t0 + Duration::minutes(1);
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t1, dec!(1.2)));
        assert!(fills.is_empty());
    }

    #[test]
    fn a_quiet_period_mid_week_fills_every_skipped_minute_flat() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap(); // Wednesday
        let t3 = t0 + Duration::minutes(3);
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1000)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t3, dec!(1.1050)));

        assert_eq!(fills.len(), 2);
        assert_eq!(fills[0].bucket_start, t0 + Duration::minutes(1));
        assert_eq!(fills[1].bucket_start, t0 + Duration::minutes(2));
        for f in &fills {
            assert_eq!(f.open, dec!(1.1000));
            assert_eq!(f.high, dec!(1.1000));
            assert_eq!(f.low, dec!(1.1000));
            assert_eq!(f.close, dec!(1.1000));
        }
    }

    #[test]
    fn the_weekend_is_never_flat_filled() {
        let tracker = GapFillTracker::new();
        // Friday 21:00 UTC -> Monday 01:00 UTC, H1 timeframe: real market
        // close is Friday 21:00 through Sunday 21:00 inclusive (excluded
        // below); the market is genuinely open again Sunday 22:00 UTC, so
        // Sun 22:00 / Sun 23:00 / Mon 00:00 are real fills, not weekend.
        let fri = Utc.with_ymd_and_hms(2026, 8, 14, 21, 0, 0).unwrap(); // Friday
        let mon = Utc.with_ymd_and_hms(2026, 8, 17, 1, 0, 0).unwrap(); // Monday
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, fri, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, mon, dec!(1.2)));

        for f in &fills {
            assert!(!market_closed(f.bucket_start), "produced a fill during market close: {:?}", f.bucket_start);
        }
        let fill_starts: Vec<DateTime<Utc>> = fills.iter().map(|f| f.bucket_start).collect();
        assert_eq!(
            fill_starts,
            vec![
                Utc.with_ymd_and_hms(2026, 8, 16, 22, 0, 0).unwrap(), // Sunday 22:00 -- market reopens
                Utc.with_ymd_and_hms(2026, 8, 16, 23, 0, 0).unwrap(),
                Utc.with_ymd_and_hms(2026, 8, 17, 0, 0, 0).unwrap(),
            ]
        );
    }

    #[test]
    fn friday_2100_to_2200_utc_is_now_treated_as_closed_too() {
        // hotfix/terminal-live-bugs round 2 -- the boundary moved from
        // hour>=22 to hour>=21 (DST-safe: real EST close is 21:00 UTC).
        // Anchor the tracker's last-known bucket at Fri 20:00 so the very
        // next hour, Fri 21:00, is the first one this test can actually
        // observe being excluded (the anchor bucket itself is never
        // checked against market_closed).
        let tracker = GapFillTracker::new();
        let fri_2000 = Utc.with_ymd_and_hms(2026, 8, 14, 20, 0, 0).unwrap();
        let fri_2200 = Utc.with_ymd_and_hms(2026, 8, 14, 22, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, fri_2000, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, fri_2200, dec!(1.1)));
        assert!(fills.is_empty(), "Fri 21:00 UTC should be excluded as closed, got: {:?}", fills);
    }

    #[test]
    fn crypto_symbols_are_never_weekend_excluded() {
        // BTCUSD/ETHUSD trade continuously -- applying the FX/metals
        // weekend rule to them would flat-fill right past a real gap in
        // their own history instead of leaving it as a genuine hole, the
        // opposite of what this module exists to prevent.
        let tracker = GapFillTracker::new();
        let fri = Utc.with_ymd_and_hms(2026, 8, 14, 21, 0, 0).unwrap();
        let mon = Utc.with_ymd_and_hms(2026, 8, 17, 1, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("BTCUSD", Timeframe::H1, fri, dec!(62000)));
        let fills = tracker.fill_gaps_and_record(&update("BTCUSD", Timeframe::H1, mon, dec!(63000)));

        // Every hour strictly between fri and mon gets filled -- none
        // excluded for being "weekend," unlike EURUSD's equivalent test.
        let expected_count = ((mon - fri).num_hours() - 1) as usize;
        assert_eq!(fills.len(), expected_count);
        assert!(fills.iter().any(|f| f.bucket_start.weekday() == Weekday::Sat));
    }

    #[test]
    fn different_symbols_and_timeframes_are_tracked_independently() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1)));
        // A different symbol's first-ever tick, even at a bucket far past
        // EURUSD's, must not be treated as a gap for EURUSD.
        let fills = tracker.fill_gaps_and_record(&update("GBPUSD", Timeframe::M1, t0 + Duration::minutes(10), dec!(1.3)));
        assert!(fills.is_empty());
    }

    #[test]
    fn non_fixed_duration_timeframes_are_never_gap_filled() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 3, 0, 0, 0).unwrap();
        let t0_plus_5_weeks = t0 + Duration::weeks(5);
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::W1, t0, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::W1, t0_plus_5_weeks, dec!(1.2)));
        assert!(fills.is_empty());
    }

    #[test]
    fn a_pathological_gap_is_capped_rather_than_generating_unbounded_rows() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 0, 0, 0).unwrap(); // Wednesday
        let far_future = t0 + Duration::days(30); // ~43,200 minutes for M1
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, far_future, dec!(1.2)));
        assert!(fills.len() <= MAX_GAP_FILLS_PER_TICK);
    }

    // round 5 -- "flat-fill written promptly, not lazily": these cover
    // sweep_stale_buckets, the timer-driven counterpart to
    // fill_gaps_and_record that doesn't wait for the next real tick.

    #[test]
    fn sweep_fills_every_closed_bucket_strictly_before_now_but_leaves_the_current_one_open() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap(); // Wednesday
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1000)));

        // 3.5 minutes later: buckets 10:01 and 10:02 are fully closed and
        // fillable; 10:03 (the bucket containing `now`) must NOT be
        // claimed -- a real tick landing in it moments later still owns it.
        let now = t0 + Duration::seconds(210);
        let fills = tracker.sweep_stale_buckets(now, 0);

        assert_eq!(fills.len(), 2);
        assert_eq!(fills[0].bucket_start, t0 + Duration::minutes(1));
        assert_eq!(fills[1].bucket_start, t0 + Duration::minutes(2));
        for f in &fills {
            assert_eq!(f.close, dec!(1.1000));
        }
    }

    #[test]
    fn a_real_tick_landing_in_the_bucket_the_sweep_left_open_is_not_treated_as_a_gap() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1000)));

        let now = t0 + Duration::seconds(150); // mid-way through the 10:02 bucket
        let sweep_fills = tracker.sweep_stale_buckets(now, 0);
        assert_eq!(sweep_fills.len(), 1); // just 10:01
        assert_eq!(sweep_fills[0].bucket_start, t0 + Duration::minutes(1));

        // A real tick lands later within that same still-open 10:02 bucket
        // -- candle_updates_for_tick always hands fill_gaps_and_record an
        // already-floored bucket_start (10:02:00), never the raw tick
        // timestamp (10:02:50), so the test must too.
        let real_tick_bucket = t0 + Duration::minutes(2);
        let real_fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, real_tick_bucket, dec!(1.1050)));
        assert!(real_fills.is_empty(), "the sweep already advanced past 10:01 -- the real tick's own bucket (10:02) is not a gap");
    }

    #[test]
    fn sweep_produces_nothing_when_no_bucket_has_fully_closed_since_the_last_real_tick() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1)));
        let now = t0 + Duration::seconds(30); // still inside the same M1 bucket
        assert!(tracker.sweep_stale_buckets(now, 0).is_empty());
    }

    #[test]
    fn sweep_never_fabricates_a_bar_during_a_real_weekend_close() {
        let tracker = GapFillTracker::new();
        let fri = Utc.with_ymd_and_hms(2026, 8, 14, 20, 58, 0).unwrap(); // Friday, just before close
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, fri, dec!(1.1)));
        let mon = Utc.with_ymd_and_hms(2026, 8, 17, 1, 0, 0).unwrap();
        let fills = tracker.sweep_stale_buckets(mon, 0);
        for f in &fills {
            assert!(!market_closed(f.bucket_start), "sweep produced a fill during market close: {:?}", f.bucket_start);
        }
    }

    #[test]
    fn sweep_ignores_pairs_it_has_never_seen_a_real_tick_for() {
        let tracker = GapFillTracker::new();
        // Nothing recorded at all -- sweeping must not panic or fabricate
        // history for a symbol/timeframe with no baseline.
        let fills = tracker.sweep_stale_buckets(Utc::now(), 0);
        assert!(fills.is_empty());
    }
}
