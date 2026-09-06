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

struct TickEntry {
    tick: Tick,
    at: DateTime<Utc>,
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
        guard.insert(
            tick.symbol.clone(),
            TickEntry { tick: tick.clone(), at, live_price_dirty: true, candle_dirty: true },
        );
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

    /// Same claim-and-clear shape as `take_dirty_live_prices`, for the
    /// independent Candle dirty bit.
    pub fn take_dirty_candles(&self) -> Vec<Tick> {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard
            .values_mut()
            .filter(|e| e.candle_dirty)
            .map(|e| {
                e.candle_dirty = false;
                e.tick.clone()
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
