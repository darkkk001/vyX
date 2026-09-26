//! Idle gate (Neon load, 2026-09-26): the engine's timers that query the book database -- the risk hook's
//! backstop (a full web margin-monitor pass), the risk hook / margin trigger reloads, and the Stage 5 shadow pass --
//! ran at full rate 24/7, so the database was queried every few seconds with the market closed and nothing open
//! (docs/audit/2026-09-24/neon-usage-report.md). They now skip work that cannot change anything:
//!
//! - FEED QUIET: no symbol has a tick younger than the freshness window. Every risk decision (web and engine) needs a
//!   price at most 15 s old by the tick's own time (lib/live-price.ts getFreshPrices, margin_watch FRESH), and a
//!   weekend heartbeat re-sends a frozen tick time, so nothing can be closed, and no order can open, while quiet.
//! - FLAT BOOK: the margin trigger's book (every account with an open position) is empty and no resting order waits.
//! - BOOK CLOSED: none of the symbols the book holds (or a resting order waits on) has a fresh tick -- e.g. a weekend
//!   with only crypto ticking and nobody holding crypto.
//!
//! Only WHEN work runs changes; what runs is untouched. A tick after a quiet spell makes the gates open again on the
//! next timer (the reload loops at most `every` later, the backstop / shadow on their next pass).

use chrono::{DateTime, Duration, Utc};
use std::collections::HashSet;
use std::sync::Mutex;

use crate::cache::TickCache;

/// The web's and the margin trigger's price freshness rule: a tick older than this cannot drive a decision.
pub const FRESH_SECS: i64 = 15;
/// A reload loop keeps reloading this long after the last tick anywhere, so a book change made right around the
/// close is still picked up before it goes quiet.
pub const RELOAD_QUIET_SECS: i64 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Run,
    FeedQuiet,
    FlatBook,
    BookClosed,
}

impl Gate {
    pub fn as_str(self) -> &'static str {
        match self {
            Gate::Run => "running",
            Gate::FeedQuiet => "feed quiet (no fresh tick on any symbol)",
            Gate::FlatBook => "flat book (no open position, no resting order)",
            Gate::BookClosed => "book closed (no fresh tick on any symbol the book holds)",
        }
    }
}

/// The gate for a pass over the book. `book` = the symbols the book holds, or None when unknown (no margin trigger,
/// or its book not loaded yet): then only the feed-quiet rule applies.
pub fn book_gate(cache: &TickCache, book: Option<&HashSet<String>>, now: DateTime<Utc>) -> Gate {
    let fresh = Duration::seconds(FRESH_SECS);
    if !cache.any_fresh_at(now, fresh) {
        return Gate::FeedQuiet;
    }
    match book {
        None => Gate::Run,
        Some(symbols) if symbols.is_empty() => Gate::FlatBook,
        Some(symbols) if !cache.any_of_fresh_at(symbols, now, fresh) => Gate::BookClosed,
        Some(_) => Gate::Run,
    }
}

/// Whether a book reload is worth a query: something ticked within RELOAD_QUIET_SECS (a position can only open, and a
/// level only fire, on a fresh price).
pub fn reload_due(cache: &TickCache, now: DateTime<Utc>) -> bool {
    cache.any_fresh_at(now, Duration::seconds(RELOAD_QUIET_SECS))
}

/// Logs a gate once per change (not once per timer), so a weekend is two log lines, not 34,000.
pub struct GateLog {
    name: &'static str,
    last: Mutex<Option<Gate>>,
}

impl GateLog {
    pub const fn new(name: &'static str) -> Self {
        GateLog { name, last: Mutex::new(None) }
    }

    /// Records `gate`; returns whether the work should run.
    pub fn observe(&self, gate: Gate) -> bool {
        let mut last = self.last.lock().unwrap_or_else(|p| p.into_inner());
        if *last != Some(gate) {
            if gate == Gate::Run {
                tracing::info!(timer = self.name, "idle gate: resumed");
            } else {
                tracing::info!(timer = self.name, reason = gate.as_str(), "idle gate: skipping until the book can move");
            }
            *last = Some(gate);
        }
        gate == Gate::Run
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Tick;

    fn tick(symbol: &str) -> Tick {
        serde_json::from_value(serde_json::json!({ "symbol": symbol, "bid": 1, "ask": 2 })).unwrap()
    }

    fn cache(entries: &[(&str, i64)], now: DateTime<Utc>) -> TickCache {
        let c = TickCache::new();
        for (s, age) in entries {
            c.set(&tick(s), now - Duration::seconds(*age));
        }
        c
    }

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_fresh_tick_anywhere_is_feed_quiet_whatever_the_book() {
        let now = Utc::now();
        let c = cache(&[("XAUUSD", 3600), ("EURUSD", 16)], now);
        assert_eq!(book_gate(&c, None, now), Gate::FeedQuiet);
        assert_eq!(book_gate(&c, Some(&set(&["XAUUSD"])), now), Gate::FeedQuiet);
        assert_eq!(book_gate(&TickCache::new(), None, now), Gate::FeedQuiet);
    }

    #[test]
    fn a_flat_book_skips_even_while_ticking() {
        let now = Utc::now();
        let c = cache(&[("XAUUSD", 1)], now);
        assert_eq!(book_gate(&c, Some(&HashSet::new()), now), Gate::FlatBook);
    }

    #[test]
    fn a_book_whose_symbols_are_all_stale_is_closed_while_other_symbols_tick() {
        let now = Utc::now();
        // weekend: crypto ticks, gold is frozen since Friday, the book holds gold only
        let c = cache(&[("BTCUSD", 1), ("XAUUSD", 50 * 3600)], now);
        assert_eq!(book_gate(&c, Some(&set(&["XAUUSD"])), now), Gate::BookClosed);
        assert_eq!(book_gate(&c, Some(&set(&["XAUUSD", "BTCUSD"])), now), Gate::Run);
    }

    #[test]
    fn an_unknown_book_runs_whenever_the_feed_ticks() {
        let now = Utc::now();
        assert_eq!(book_gate(&cache(&[("EURUSD", 15)], now), None, now), Gate::Run);
    }

    #[test]
    fn reloads_continue_for_a_minute_after_the_last_tick_then_stop() {
        let now = Utc::now();
        assert!(reload_due(&cache(&[("XAUUSD", 59)], now), now));
        assert!(!reload_due(&cache(&[("XAUUSD", 61)], now), now));
        assert!(!reload_due(&TickCache::new(), now));
    }

    #[test]
    fn the_log_reports_whether_to_run() {
        let log = GateLog::new("test");
        assert!(!log.observe(Gate::FeedQuiet));
        assert!(!log.observe(Gate::FeedQuiet));
        assert!(log.observe(Gate::Run));
    }
}
