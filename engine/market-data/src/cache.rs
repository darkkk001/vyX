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

/// One symbol's candle observation for a flush cycle: the latest tick (its bid is the
/// bucket close, and it carries the symbol + tick_ms the flush buckets against) plus the
/// TRUE open/high/low accumulated across EVERY tick since the last flush -- not just the
/// single latest tick. This is what fixes the live-forming bar: an intra-second spike that
/// happened and reversed between two flushes is captured in high/low here, then widened
/// into the bucket by the DB's GREATEST/LEAST upsert, instead of being lost because only
/// the last tick was point-sampled.
pub struct CandleSample {
    pub tick: Tick,
    pub open: Decimal,
    pub high: Decimal,
    pub low: Decimal,
}

struct TickEntry {
    tick: Tick,
    at: DateTime<Utc>,
    // Candle OHLC accumulated across ticks since the last `take_dirty_candles`. close is
    // always `tick.bid` (the latest); open is the first tick of the current accumulation
    // window; high/low are the running extremes. The window resets (open/high/low re-seed
    // from the next tick) once the accumulation has been taken -- see `set` / `take_dirty_candles`.
    candle_open: Decimal,
    candle_high: Decimal,
    candle_low: Decimal,
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
        match guard.get_mut(&tick.symbol) {
            Some(e) => {
                // Accumulate the candle OHLC across this window. If candle_dirty is already
                // set, we're mid-window -> widen high/low; if it was just taken (false), this
                // tick starts a fresh window -> re-seed open/high/low from it. close is the
                // latest tick's bid, carried in `e.tick`.
                if e.candle_dirty {
                    if tick.bid > e.candle_high {
                        e.candle_high = tick.bid;
                    }
                    if tick.bid < e.candle_low {
                        e.candle_low = tick.bid;
                    }
                } else {
                    e.candle_open = tick.bid;
                    e.candle_high = tick.bid;
                    e.candle_low = tick.bid;
                }
                e.tick = tick.clone();
                e.at = at;
                e.live_price_dirty = true;
                e.candle_dirty = true;
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
                        live_price_dirty: true,
                        candle_dirty: true,
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
    /// tick, so the flush writes the true intra-window high/low, not a point sample.
    /// Clearing candle_dirty also ends the accumulation window: the next `set` for this
    /// symbol re-seeds open/high/low.
    pub fn take_dirty_candles(&self) -> Vec<CandleSample> {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard
            .values_mut()
            .filter(|e| e.candle_dirty)
            .map(|e| {
                e.candle_dirty = false;
                CandleSample { tick: e.tick.clone(), open: e.candle_open, high: e.candle_high, low: e.candle_low }
            })
            .collect()
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

    fn tick(symbol: &str) -> Tick {
        Tick { symbol: symbol.to_string(), bid: rust_decimal::Decimal::ONE, ask: rust_decimal::Decimal::TWO, t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None }
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
