//! In-process shared tick state — the "RUST MEMORY... current prices"
//! layer the master architecture spec calls for. Before this existed,
//! `order-management::place_market_order`/`place_pending_order` each did
//! a synchronous Postgres SELECT (`db::get_live_price`) on every single
//! order just to read the current price, even though the same tick was
//! already flowing through this exact process (ingested here, published
//! to NATS, and already subscribed-to in-process by
//! `engine/server`'s tick-driven triggers). This cache is what lets order
//! placement read that price from memory instead.

use std::collections::HashMap;
use std::sync::RwLock;

use chrono::{DateTime, Duration, Utc};
use protocol::Tick;
use rust_decimal::Decimal;

/// One symbol's candle observation for a flush cycle: the latest tick of the segment (its
/// bid is the bucket close) plus the TRUE open/high/low accumulated across EVERY tick of
/// that segment -- not just the single latest tick. This is what fixes the live-forming
/// bar: an intra-second spike that happened and reversed between two flushes is captured
/// in high/low here, then widened into the bucket by the DB's GREATEST/LEAST upsert,
/// instead of being lost because only the last tick was point-sampled.
///
/// `at` is the represented time of `tick` as resolved at ingest (`ingest::resolve_tick_time`
/// -- the tick's own tick_ms, else the moment it arrived). The flush buckets THIS sample
/// against `at`, never against the flush cycle's wall clock, and a sample never spans a
/// UTC minute: `TickCache::set` closes the running segment and starts a new one the moment
/// a tick's minute differs from the segment's, so a flush window that straddles a minute
/// boundary yields one sample per minute, each carrying only its own minute's ticks. Before
/// this, the whole window was bucketed by its LAST tick's time -- a spike at 12:00:59.8
/// flushed at 12:01:00.2 landed in the 12:01 bar (and the 12:00 bar never got it), on
/// every minute boundary, for every symbol.
pub struct CandleSample {
    pub tick: Tick,
    pub at: DateTime<Utc>,
    pub open: Decimal,
    pub high: Decimal,
    pub low: Decimal,
}

/// Every timeframe this engine buckets (lib::TIMEFRAMES) starts on a whole UTC minute
/// (broker offsets are whole hours, or at worst :30), so a segment that never crosses a
/// UTC minute never crosses ANY bucket boundary either.
fn minute_of(at: DateTime<Utc>) -> i64 {
    at.timestamp_millis().div_euclid(60_000)
}

struct TickEntry {
    tick: Tick,
    at: DateTime<Utc>,
    // Candle OHLC accumulated across ticks of the CURRENT segment: since the last
    // `take_dirty_candles`, or since the last UTC-minute rollover, whichever is later.
    // close is always `tick.bid` (the latest); open is the first tick of the segment;
    // high/low are the running extremes; candle_minute is the UTC minute every tick of
    // the segment belongs to. The segment resets (open/high/low re-seed from the next
    // tick) once it has been taken, or is moved to `closed_segments` and re-seeded when a
    // tick from a later minute arrives -- see `set` / `take_dirty_candles`.
    candle_open: Decimal,
    candle_high: Decimal,
    candle_low: Decimal,
    candle_minute: i64,
    // Segments completed by a minute rollover but not yet taken by a flush, oldest first.
    // In practice at most one (the flush cadence is ~1s, a rollover happens once a minute),
    // and drained on every take, so this never grows.
    closed_segments: Vec<CandleSample>,
    // Independent per-consumer dirty bits, not one shared flag: LivePrice
    // and Candle flush on different cadences (ingest::spawn_periodic_flush),
    // so a LivePrice flush clearing a single shared flag would make the
    // next Candle cycle think there was nothing new, and vice versa. A new
    // tick always sets both `true` regardless of their previous value
    // (`set` below) -- one incoming tick updates every currently-open
    // Candle bucket across every timeframe simultaneously
    // (candle_updates_for_tick), so a single per-symbol `candle_dirty` bit
    // already means "every open bucket for this symbol needs (re)writing";
    // there's no per-timeframe/per-bucket case this collapses that a
    // finer-grained flag would have handled differently.
    live_price_dirty: bool,
    candle_dirty: bool,
    // The per-tick risk trigger's own bit (ingest::spawn_risk_trigger, 2026-09-29): it used to ride on
    // live_price_dirty and run only after a SUCCESSFUL LivePrice write, so a write that failed or timed out
    // (2 s) hid the tick from the trigger while the web, reading this cache, still acted on it (S3 WEB_ONLY:
    // a slow ramp's stop-out-crossing tick never reached the trigger). Independent of every persistence flag.
    risk_dirty: bool,
    // The idle gate's own clock (2026-10-05, weekend gate): when this symbol's QUOTE last moved -- the resolved time of
    // the first tick carrying the current (bid, ask, broker-server tick time). A heartbeat resend of an unchanged quote
    // does not move it, whatever time the resend resolves to: an EA build without tick_ms, a tick_ms the engine had to
    // reject as future-dated (a wrong broker offset after a weekend restart), or a broker offset recomputed between two
    // resends all used to make a FROZEN Friday quote look fresh every 5 s (the heartbeat) -- `at` falls back to the
    // arrival time in each of those cases. Only the gate reads this; prices and their freshness (`at`, tick_ms) for
    // every decision are untouched.
    quote_key: QuoteKey,
    moved_at: DateTime<Utc>,
}

/// (bid, ask, the broker server's own tick time in ms = tick_ms + broker_offset_sec x 1000). The server time is used,
/// not tick_ms, so an EA recomputing its broker offset between two resends of the same tick is still "the same quote".
type QuoteKey = (Decimal, Decimal, Option<i64>);

/// A new quote: bid or ask changed, or both sides carry a server tick time and it changed. A resend that carries no
/// time (an older EA, or a second feed instance without tick_ms alongside a current one) never counts as a move by
/// itself, so two feeds resending one frozen quote cannot keep it "moving".
fn quote_moved(old: &QuoteKey, new: &QuoteKey) -> bool {
    old.0 != new.0 || old.1 != new.1 || matches!((old.2, new.2), (Some(a), Some(b)) if a != b)
}

fn quote_key(tick: &Tick) -> QuoteKey {
    (tick.bid, tick.ask, tick.tick_ms.map(|ms| ms.saturating_add(tick.broker_offset_sec.unwrap_or(0).saturating_mul(1000))))
}

pub struct TickCache {
    inner: RwLock<HashMap<String, TickEntry>>,
}

impl TickCache {
    pub fn new() -> Self {
        Self { inner: RwLock::new(HashMap::new()) }
    }

    pub fn set(&self, tick: &Tick, at: DateTime<Utc>) {
        // Poisoning would mean some other writer panicked mid-update;
        // recovering the lock (rather than propagating the panic here)
        // is the right call for a cache -- a stale/missing entry just
        // means the caller falls back to Postgres, never a hard failure.
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let minute = minute_of(at);
        match guard.get_mut(&tick.symbol) {
            Some(e) => {
                // Accumulate the candle OHLC across the current segment. If candle_dirty is
                // set AND this tick is in the segment's minute, we're mid-segment -> widen
                // high/low. If the segment was just taken (candle_dirty false), this tick
                // starts a fresh one -> re-seed. If the segment is still untaken but this
                // tick's minute is later, the segment is complete: park it in
                // closed_segments (with its own last tick + time, so the flush buckets it
                // into ITS minute) and re-seed for the new minute. close is the latest
                // tick's bid, carried in `e.tick`.
                if e.candle_dirty && minute == e.candle_minute {
                    if tick.bid > e.candle_high {
                        e.candle_high = tick.bid;
                    }
                    if tick.bid < e.candle_low {
                        e.candle_low = tick.bid;
                    }
                } else {
                    if e.candle_dirty && minute > e.candle_minute {
                        e.closed_segments.push(CandleSample {
                            tick: e.tick.clone(),
                            at: e.at,
                            open: e.candle_open,
                            high: e.candle_high,
                            low: e.candle_low,
                        });
                    }
                    e.candle_open = tick.bid;
                    e.candle_high = tick.bid;
                    e.candle_low = tick.bid;
                    e.candle_minute = minute;
                }
                let key = quote_key(tick);
                if quote_moved(&e.quote_key, &key) {
                    e.quote_key = key;
                    e.moved_at = at;
                }
                e.tick = tick.clone();
                e.at = at;
                e.live_price_dirty = true;
                e.candle_dirty = true;
                e.risk_dirty = true;
            }
            None => {
                guard.insert(
                    tick.symbol.clone(),
                    TickEntry {
                        tick: tick.clone(),
                        at,
                        candle_open: tick.bid,
                        candle_high: tick.bid,
                        candle_low: tick.bid,
                        candle_minute: minute,
                        closed_segments: Vec::new(),
                        live_price_dirty: true,
                        candle_dirty: true,
                        risk_dirty: true,
                        quote_key: quote_key(tick),
                        moved_at: at,
                    },
                );
            }
        }
    }

    // Same 15s staleness rule `db::get_live_price`'s SQL already enforces
    // (`WHERE "updatedAt" > now() - interval '15 seconds'`) -- callers
    // pass `max_age` explicitly rather than this module hardcoding it, so
    // the two stay obviously in sync at the call site instead of by
    // coincidence.
    /// The latest tick of `symbol` and when the engine received it, whatever its age: the entry GET
    /// /internal/prices serves the web (order_management::book::PriceSource::Ticks reads the same one).
    pub fn latest(&self, symbol: &str) -> Option<(Tick, DateTime<Utc>)> {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.get(symbol).map(|e| (e.tick.clone(), e.at))
    }

    pub fn get_if_fresh(&self, symbol: &str, max_age: Duration) -> Option<Tick> {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let entry = guard.get(symbol)?;
        if Utc::now() - entry.at <= max_age {
            Some(entry.tick.clone())
        } else {
            None
        }
    }

    // Read only by GET /internal/feed-stats's `queue_len` (a plain count of
    // known symbols, regardless of dirty state) -- unrelated to the
    // dirty-flush path below, never clears anything.
    pub fn snapshot(&self) -> Vec<Tick> {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.values().map(|entry| entry.tick.clone()).collect()
    }

    // Read by GET /internal/feed-stats's per_symbol breakdown -- every
    // symbol's latest known tick regardless of age or dirty state, plus
    // its age in ms as of `now` (passed in, not read internally, for the
    // same testability reason every other timestamp comparison in this
    // module takes `now`/`max_age` as a parameter instead of calling
    // Utc::now() itself). Unrelated to the dirty-flush path below -- this
    // is a read-only diagnostic snapshot, never clears anything.
    pub fn snapshot_with_age(&self, now: DateTime<Utc>) -> Vec<(Tick, i64)> {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard
            .values()
            .map(|entry| (entry.tick.clone(), (now - entry.at).num_milliseconds()))
            .collect()
    }

    /// True when any symbol's latest tick is at most `max_age` old as of `now` (the tick's own time, as
    /// `get_if_fresh` measures it: a weekend heartbeat re-sending a frozen price does not count).
    /// The idle gate's rule (crate::activity): true when at least one REAL symbol's quote MOVED (see TickEntry::moved_at)
    /// at most `max_age` before `now`. Synthetic v* symbols (crate::synthetic: the shadow bot's 24/7 feed) never count,
    /// and neither does a heartbeat resend of an unchanged quote.
    pub fn any_moved_at(&self, now: DateTime<Utc>, max_age: Duration) -> bool {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.iter().any(|(s, e)| !crate::synthetic::is_synthetic(s) && now - e.moved_at <= max_age)
    }

    /// Whether `symbol`'s quote moved at most `max_age` before `now` (unknown symbol: false). Synthetic symbols are not
    /// special here: the risk trigger asks this per tick, and the v* feed's quotes really move.
    pub fn moved_within(&self, symbol: &str, now: DateTime<Utc>, max_age: Duration) -> bool {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.get(symbol).is_some_and(|e| now - e.moved_at <= max_age)
    }

    /// As `any_moved_at`, over `symbols` only (synthetic ones are skipped).
    pub fn any_of_moved_at<'a>(&self, symbols: impl IntoIterator<Item = &'a String>, now: DateTime<Utc>, max_age: Duration) -> bool {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        symbols
            .into_iter()
            .filter(|s| !crate::synthetic::is_synthetic(s))
            .any(|s| guard.get(s).is_some_and(|e| now - e.moved_at <= max_age))
    }

    pub fn any_fresh_at(&self, now: DateTime<Utc>, max_age: Duration) -> bool {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.values().any(|e| now - e.at <= max_age)
    }

    /// True when at least one of `symbols` has a tick at most `max_age` old as of `now`.
    pub fn any_of_fresh_at<'a>(&self, symbols: impl IntoIterator<Item = &'a String>, now: DateTime<Utc>, max_age: Duration) -> bool {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        symbols.into_iter().any(|s| guard.get(s).is_some_and(|e| now - e.at <= max_age))
    }

    // Claims every symbol currently marked dirty for LivePrice persistence
    // and clears the flag in the same lock acquisition, so a tick landing
    // right after this returns can't be silently lost: `set` above always
    // writes `live_price_dirty = true` on the next tick regardless of the
    // flag's current value, so that symbol is simply picked up again next
    // cycle. If the flush this powers then fails, the caller calls
    // `mark_live_price_dirty` for exactly the symbols it attempted --
    // always safe to do redundantly, since dirty is an OR, not a counter.
    pub fn take_dirty_live_prices(&self) -> Vec<Tick> {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard
            .values_mut()
            .filter(|e| e.live_price_dirty)
            .map(|e| {
                e.live_price_dirty = false;
                e.tick.clone()
            })
            .collect()
    }

    /// Claims every symbol that ticked since the last claim, for the per-tick risk trigger
    /// (ingest::spawn_risk_trigger), clearing its bit in the same lock acquisition (the same no-loss argument as
    /// take_dirty_live_prices). Never touched by any persistence path: a failed or slow database write cannot hold
    /// a tick back from risk evaluation.
    pub fn take_dirty_risk(&self) -> Vec<Tick> {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard
            .values_mut()
            .filter(|e| e.risk_dirty)
            .map(|e| {
                e.risk_dirty = false;
                e.tick.clone()
            })
            .collect()
    }

    /// Re-marks the given symbols dirty for LivePrice -- called after a
    /// failed/timed-out flush so the next cycle retries them instead of
    /// silently dropping the update `take_dirty_live_prices` already
    /// cleared. A symbol no longer present in the cache (evicted somehow)
    /// is a harmless no-op.
    pub fn mark_live_price_dirty(&self, symbols: &[String]) {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        for symbol in symbols {
            if let Some(entry) = guard.get_mut(symbol) {
                entry.live_price_dirty = true;
            }
        }
    }

    /// Same claim-and-clear shape as `take_dirty_live_prices`, for the independent Candle
    /// dirty bit -- but returns the accumulated OHLC (CandleSample), not just the latest
    /// tick, so the flush writes the true intra-window high/low, not a point sample. A
    /// symbol whose window crossed a UTC minute yields its parked closed segment(s) first
    /// (oldest first) and then the current one, each self-contained within its minute.
    /// Clearing candle_dirty also ends the current segment: the next `set` for this
    /// symbol re-seeds open/high/low.
    pub fn take_dirty_candles(&self) -> Vec<CandleSample> {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut out = Vec::new();
        for e in guard.values_mut().filter(|e| e.candle_dirty) {
            e.candle_dirty = false;
            out.append(&mut e.closed_segments);
            out.push(CandleSample { tick: e.tick.clone(), at: e.at, open: e.candle_open, high: e.candle_high, low: e.candle_low });
        }
        out
    }

    /// Same retry-on-failure shape as `mark_live_price_dirty`, for Candle.
    pub fn mark_candle_dirty(&self, symbols: &[String]) {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        for symbol in symbols {
            if let Some(entry) = guard.get_mut(symbol) {
                entry.candle_dirty = true;
            }
        }
    }
}

impl Default for TickCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn tick(symbol: &str) -> Tick {
        Tick { symbol: symbol.to_string(), bid: rust_decimal::Decimal::ONE, ask: rust_decimal::Decimal::TWO, t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None, bars: Vec::new() }
    }

    #[test]
    fn missing_symbol_returns_none() {
        let cache = TickCache::new();
        assert!(cache.get_if_fresh("EURUSD", Duration::seconds(15)).is_none());
    }

    #[test]
    fn fresh_tick_is_returned() {
        let cache = TickCache::new();
        cache.set(&tick("EURUSD"), Utc::now());
        assert_eq!(cache.get_if_fresh("EURUSD", Duration::seconds(15)).unwrap().bid, rust_decimal::Decimal::ONE);
    }

    #[test]
    fn stale_tick_is_not_returned() {
        let cache = TickCache::new();
        cache.set(&tick("EURUSD"), Utc::now() - Duration::seconds(30));
        assert!(cache.get_if_fresh("EURUSD", Duration::seconds(15)).is_none());
    }

    #[test]
    fn set_overwrites_the_previous_value_for_the_same_symbol() {
        let cache = TickCache::new();
        cache.set(&tick("EURUSD"), Utc::now() - Duration::seconds(30));
        cache.set(&tick("EURUSD"), Utc::now());
        assert!(cache.get_if_fresh("EURUSD", Duration::seconds(15)).is_some());
    }

    #[test]
    fn take_dirty_candles_captures_the_intra_window_high_low_not_just_the_last_tick() {
        // The live-forming-bar fix: a fast spike that happens and reverses between two flushes
        // must be captured in high/low, not lost to point-sampling only the latest tick.
        let cache = TickCache::new();
        let mk = |bid: i64| { let mut t = tick("XAUUSD"); t.bid = Decimal::from(bid); t };
        let now = Utc::now();
        cache.set(&mk(100), now); // open
        cache.set(&mk(110), now); // spike high -- point-sampling would lose this
        cache.set(&mk(95), now);  // dip low
        cache.set(&mk(101), now); // close (latest)
        let s = cache.take_dirty_candles();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].open, Decimal::from(100));
        assert_eq!(s[0].high, Decimal::from(110), "intra-window spike high must be captured");
        assert_eq!(s[0].low, Decimal::from(95), "intra-window dip low must be captured");
        assert_eq!(s[0].tick.bid, Decimal::from(101), "close is the latest tick");
    }

    #[test]
    fn a_window_that_crosses_a_minute_boundary_yields_one_sample_per_minute() {
        // The straddle bug: a spike in the last second of 12:00 flushed at 12:01:00.2 must
        // land in the 12:00 sample (bucketed by ITS time), not be attributed to 12:01 --
        // and 12:01 must open at its own first tick, not carry 12:00's range.
        let cache = TickCache::new();
        let mk = |bid: i64| { let mut t = tick("XAUUSD"); t.bid = Decimal::from(bid); t };
        let m0 = Utc.with_ymd_and_hms(2026, 8, 12, 12, 0, 0).unwrap();
        cache.set(&mk(100), m0 + Duration::milliseconds(58_500)); // 12:00:58.5 open
        cache.set(&mk(110), m0 + Duration::milliseconds(59_200)); // 12:00:59.2 spike
        cache.set(&mk(95), m0 + Duration::milliseconds(59_800));  // 12:00:59.8 dip (12:00 close)
        cache.set(&mk(101), m0 + Duration::milliseconds(60_100)); // 12:01:00.1 -> new minute
        cache.set(&mk(103), m0 + Duration::milliseconds(60_400)); // 12:01:00.4
        let s = cache.take_dirty_candles();
        assert_eq!(s.len(), 2, "one sample per minute the window touched");
        assert_eq!(s[0].at, m0 + Duration::milliseconds(59_800), "the 12:00 segment is stamped with its own last tick's time");
        assert_eq!((s[0].open, s[0].high, s[0].low, s[0].tick.bid), (Decimal::from(100), Decimal::from(110), Decimal::from(95), Decimal::from(95)));
        assert_eq!(s[1].at, m0 + Duration::milliseconds(60_400));
        assert_eq!((s[1].open, s[1].high, s[1].low, s[1].tick.bid), (Decimal::from(101), Decimal::from(103), Decimal::from(101), Decimal::from(103)), "12:01 opens at its own first tick and carries none of 12:00's range");
        assert!(cache.take_dirty_candles().is_empty(), "closed segments are drained by the take");
    }

    #[test]
    fn a_minute_rollover_after_a_take_does_not_resurrect_the_taken_segment() {
        let cache = TickCache::new();
        let mk = |bid: i64| { let mut t = tick("XAUUSD"); t.bid = Decimal::from(bid); t };
        let m0 = Utc.with_ymd_and_hms(2026, 8, 12, 12, 0, 0).unwrap();
        cache.set(&mk(100), m0 + Duration::milliseconds(59_000));
        let _ = cache.take_dirty_candles();
        cache.set(&mk(102), m0 + Duration::milliseconds(60_100)); // first tick of 12:01, previous segment already taken
        let s = cache.take_dirty_candles();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].open, Decimal::from(102));
    }

    #[test]
    fn a_new_window_after_a_take_re_seeds_open_high_low() {
        let cache = TickCache::new();
        let mk = |bid: i64| { let mut t = tick("XAUUSD"); t.bid = Decimal::from(bid); t };
        cache.set(&mk(100), Utc::now());
        cache.set(&mk(110), Utc::now());
        let _ = cache.take_dirty_candles(); // ends the window
        cache.set(&mk(102), Utc::now());
        cache.set(&mk(103), Utc::now());
        let s = cache.take_dirty_candles();
        assert_eq!(s[0].open, Decimal::from(102), "a fresh window re-seeds open from its first tick");
        assert_eq!(s[0].high, Decimal::from(103), "a fresh window must not carry the previous window's high");
        assert_eq!(s[0].low, Decimal::from(102));
    }

    #[test]
    fn a_fresh_tick_is_dirty_for_both_live_price_and_candle() {
        let cache = TickCache::new();
        cache.set(&tick("EURUSD"), Utc::now());
        assert_eq!(cache.take_dirty_live_prices().len(), 1);
        assert_eq!(cache.take_dirty_candles().len(), 1);
    }

    #[test]
    fn taking_dirty_live_prices_does_not_clear_the_independent_candle_flag() {
        let cache = TickCache::new();
        cache.set(&tick("EURUSD"), Utc::now());
        cache.take_dirty_live_prices();
        assert_eq!(cache.take_dirty_candles().len(), 1, "candle dirty flag must be independent of live-price's");
    }

    #[test]
    fn a_second_take_with_no_new_tick_in_between_is_empty() {
        let cache = TickCache::new();
        cache.set(&tick("EURUSD"), Utc::now());
        assert_eq!(cache.take_dirty_live_prices().len(), 1);
        assert!(cache.take_dirty_live_prices().is_empty(), "nothing changed since the last take -- an unchanged symbol must not be flushed again");
    }

    #[test]
    fn a_new_tick_after_a_take_is_dirty_again() {
        let cache = TickCache::new();
        cache.set(&tick("EURUSD"), Utc::now());
        cache.take_dirty_live_prices();
        cache.set(&tick("EURUSD"), Utc::now());
        assert_eq!(cache.take_dirty_live_prices().len(), 1);
    }

    #[test]
    fn re_marking_dirty_after_a_failed_flush_makes_it_flush_again_next_cycle() {
        let cache = TickCache::new();
        cache.set(&tick("EURUSD"), Utc::now());
        let taken = cache.take_dirty_live_prices();
        assert_eq!(taken.len(), 1);
        // Simulate the flush failing: the caller re-marks dirty rather than
        // silently dropping the update.
        cache.mark_live_price_dirty(&["EURUSD".to_string()]);
        assert_eq!(cache.take_dirty_live_prices().len(), 1, "a failed flush's symbols must be retried on the next cycle");
    }

    #[test]
    fn marking_a_symbol_not_in_the_cache_dirty_is_a_harmless_no_op() {
        let cache = TickCache::new();
        cache.mark_live_price_dirty(&["GHOST".to_string()]);
        cache.mark_candle_dirty(&["GHOST".to_string()]);
        assert!(cache.take_dirty_live_prices().is_empty());
        assert!(cache.take_dirty_candles().is_empty());
    }

    #[test]
    fn only_the_dirty_symbol_is_taken_others_stay_untouched() {
        let cache = TickCache::new();
        cache.set(&tick("EURUSD"), Utc::now());
        cache.set(&tick("GBPUSD"), Utc::now());
        cache.take_dirty_live_prices(); // clears both
        cache.set(&tick("EURUSD"), Utc::now()); // re-dirties only EURUSD
        let taken = cache.take_dirty_live_prices();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].symbol, "EURUSD");
    }
}
