//! Per-symbol tick-rate tracking for GET /internal/feed-stats's
//! `per_symbol[]` breakdown -- separate from `TickCache` (which only ever
//! needs the latest tick per symbol) and `FeedStats` (which is aggregate,
//! not per-symbol). A sliding 60s window per symbol, not a periodic
//! reset-every-60s counter, so `ticks_60s` reads correctly no matter when
//! within the window it's read.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

const WINDOW_MS: i64 = 60_000;

pub struct SymbolActivity {
    // symbol -> tick arrival times (ms since epoch), oldest-first, pruned
    // to the last WINDOW_MS on every record()/count_last_60s() call.
    inner: Mutex<HashMap<String, VecDeque<i64>>>,
}

impl SymbolActivity {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }

    pub fn record(&self, symbol: &str, now_ms: i64) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let deque = guard.entry(symbol.to_string()).or_default();
        deque.push_back(now_ms);
        Self::prune(deque, now_ms);
    }

    pub fn count_last_60s(&self, symbol: &str, now_ms: i64) -> u64 {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match guard.get_mut(symbol) {
            Some(deque) => {
                Self::prune(deque, now_ms);
                deque.len() as u64
            }
            None => 0,
        }
    }

    fn prune(deque: &mut VecDeque<i64>, now_ms: i64) {
        while let Some(&front) = deque.front() {
            if now_ms - front > WINDOW_MS {
                deque.pop_front();
            } else {
                break;
            }
        }
    }
}

impl Default for SymbolActivity {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_only_ticks_within_the_last_60s() {
        let activity = SymbolActivity::new();
        activity.record("XAUUSD", 0);
        activity.record("XAUUSD", 30_000);
        activity.record("XAUUSD", 61_000); // prunes the t=0 sample on read
        assert_eq!(activity.count_last_60s("XAUUSD", 61_000), 2);
    }

    #[test]
    fn unknown_symbol_counts_zero() {
        let activity = SymbolActivity::new();
        assert_eq!(activity.count_last_60s("EURUSD", 1_000), 0);
    }

    #[test]
    fn symbols_are_independent() {
        let activity = SymbolActivity::new();
        activity.record("XAUUSD", 1_000);
        activity.record("XAUUSD", 2_000);
        activity.record("EURUSD", 1_000);
        assert_eq!(activity.count_last_60s("XAUUSD", 2_000), 2);
        assert_eq!(activity.count_last_60s("EURUSD", 2_000), 1);
    }
}
