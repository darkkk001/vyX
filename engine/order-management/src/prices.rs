//! Where OMS reads the current market price from -- decided in exactly one
//! place and used by every money-affecting path in this crate: MARKET /
//! pending order placement, the pending-order trigger's margin check, the
//! margin monitor's SL/TP + stop-out evaluation, manual close and SL/TP
//! modify. "Which store, which column, how stale is too stale" must never
//! be answered differently by two of those paths again.
//!
//! Wrong-field audit 2026-09-18 item 1.2: `db::get_open_positions_with_market`
//! used to `LEFT JOIN "LivePrice"` on the *trade* pool (Neon) filtered on
//! `"updatedAt"`. Since the market-data store split (`MARKET_DATA_WRITE=local`,
//! see market_data::sink) LivePrice is written only to the market-data
//! store, so that join returned NULL bid/ask for every position: SL/TP
//! never fired, stop-out found no closeable position, equity ignored
//! floating loss, and the pending trigger's margin check over-permitted.
//! Positions still come from the trade pool; prices come from here.
//!
//! Lookup order (the same one `place_market_order` has always used):
//! 1. the in-process `TickCache` -- the freshest view there is, it is what
//!    `ingest_price_feed` writes before anything is flushed to Postgres;
//! 2. the market-data reader pool (`MarketDataPools::reader()`), through
//!    `market_data::db::get_live_price`, whose SQL filters on `"tickAt"`
//!    (the tick's own time) and never `"updatedAt"` (bumped by every EA
//!    heartbeat even when the price is frozen). Only reached for a symbol
//!    that hasn't ticked in-process yet, e.g. right after a restart.
//!
//! Both layers apply the same 15 s window (`tick_freshness`); a stale or
//! missing price is `None`, which every consumer treats as "no price"
//! (skip for P&L / SL-TP, still count for margin) rather than trading
//! against a frozen number.

use chrono::Duration as ChronoDuration;
use market_data::cache::TickCache;
use protocol::Tick;
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;

/// Same 15 s staleness window `market_data::db::get_live_price`'s own SQL
/// enforces -- kept as one function so the in-memory cache and the
/// Postgres fallback can never silently drift apart.
pub fn tick_freshness() -> ChronoDuration {
    ChronoDuration::seconds(15)
}

/// A `Tick` built from a stored LivePrice row -- only bid/ask/symbol are
/// known; the EA-side timing fields are diagnostics the DB row doesn't
/// carry and nothing in this crate reads them.
fn tick_from_row(symbol: &str, bid: Decimal, ask: Decimal) -> Tick {
    Tick {
        symbol: symbol.to_string(),
        bid,
        ask,
        t0: None,
        clock_offset_ms: None,
        rtt_ms: None,
        tick_ms: None,
        broker_offset_sec: None,
    }
}

/// Cheap to clone (an `Arc` and a `PgPool`, which is itself an `Arc`) so
/// every spawned task and every HTTP handler can hold its own handle.
#[derive(Clone)]
pub struct PriceSource {
    cache: Arc<TickCache>,
    market_data_reader: PgPool,
}

impl PriceSource {
    /// `market_data_reader` must be `MarketDataPools::reader()` -- the
    /// store LivePrice is actually written to -- never the trade pool.
    pub fn new(cache: Arc<TickCache>, market_data_reader: PgPool) -> Self {
        Self { cache, market_data_reader }
    }

    /// The current fresh tick for one symbol, or `None` when neither the
    /// cache nor the market-data store has one newer than
    /// `tick_freshness`. A DB error on the fallback is propagated -- the
    /// caller decides whether that fails one order or skips one account.
    pub async fn current_tick(&self, symbol: &str) -> Result<Option<Tick>, sqlx::Error> {
        if let Some(tick) = self.cache.get_if_fresh(symbol, tick_freshness()) {
            return Ok(Some(tick));
        }
        Ok(market_data::db::get_live_price(&self.market_data_reader, symbol)
            .await?
            .map(|(bid, ask)| tick_from_row(symbol, bid, ask)))
    }

    /// Fresh ticks for a set of symbols (duplicates collapsed, so an
    /// account holding ten XAUUSD positions costs one lookup, not ten),
    /// keyed by symbol. Symbols with no fresh price are simply absent.
    /// Takes an owned slice rather than a borrowed iterator: the
    /// returned future is `tokio::spawn`ed through the monitor, and a
    /// generic `IntoIterator<Item = &str>` here trips rustc's
    /// "implementation of Send is not general enough" on that path.
    pub async fn current_ticks(&self, symbols: &[String]) -> Result<HashMap<String, Tick>, sqlx::Error> {
        let mut ticks = HashMap::new();
        for symbol in symbols {
            if ticks.contains_key(symbol) {
                continue;
            }
            if let Some(tick) = self.current_tick(symbol).await? {
                ticks.insert(symbol.clone(), tick);
            }
        }
        Ok(ticks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use rust_decimal_macros::dec;

    // connect_lazy never touches the network (it only needs a Tokio
    // context) -- the cache-hit paths below must resolve without ever
    // reaching it, which is exactly what these tests pin down.
    fn unreachable_pool() -> PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(200))
            .connect_lazy("postgres://u:p@127.0.0.1:1/x")
            .unwrap()
    }

    #[tokio::test]
    async fn fresh_cache_entry_is_served_without_touching_the_store() {
        let cache = Arc::new(TickCache::new());
        cache.set(&tick_from_row("XAUUSD", dec!(2400.10), dec!(2400.30)), Utc::now());
        let prices = PriceSource::new(cache, unreachable_pool());

        let tick = prices.current_tick("XAUUSD").await.unwrap().expect("cache hit");
        assert_eq!((tick.bid, tick.ask), (dec!(2400.10), dec!(2400.30)));
    }

    #[tokio::test]
    async fn stale_cache_entry_falls_through_to_the_market_data_store() {
        let cache = Arc::new(TickCache::new());
        cache.set(&tick_from_row("XAUUSD", dec!(2400.10), dec!(2400.30)), Utc::now() - ChronoDuration::seconds(16));
        let prices = PriceSource::new(cache, unreachable_pool());

        // The fallback pool is unreachable, so a stale cache entry must
        // surface as the store's error, never as the frozen cached price.
        assert!(prices.current_tick("XAUUSD").await.is_err());
    }

    #[tokio::test]
    async fn batch_lookup_collapses_duplicate_symbols_and_omits_unknown_ones() {
        let cache = Arc::new(TickCache::new());
        cache.set(&tick_from_row("XAUUSD", dec!(2400.10), dec!(2400.30)), Utc::now());
        cache.set(&tick_from_row("EURUSD", dec!(1.10000), dec!(1.10020)), Utc::now());
        let prices = PriceSource::new(cache, unreachable_pool());

        let symbols: Vec<String> = ["XAUUSD", "XAUUSD", "EURUSD"].iter().map(|s| s.to_string()).collect();
        let ticks = prices.current_ticks(&symbols).await.unwrap();
        assert_eq!(ticks.len(), 2);
        assert_eq!(ticks["XAUUSD"].bid, dec!(2400.10));
        assert_eq!(ticks["EURUSD"].ask, dec!(1.10020));
    }
}
