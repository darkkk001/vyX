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

pub struct TickCache {
    inner: RwLock<HashMap<String, (Tick, DateTime<Utc>)>>,
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
        guard.insert(tick.symbol.clone(), (tick.clone(), at));
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
        let (tick, at) = guard.get(symbol)?;
        if Utc::now() - *at <= max_age {
            Some(tick.clone())
        } else {
            None
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
        Tick { symbol: symbol.to_string(), bid: rust_decimal::Decimal::ONE, ask: rust_decimal::Decimal::TWO }
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
}
