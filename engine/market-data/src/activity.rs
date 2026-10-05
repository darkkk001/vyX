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
//! What counts as "a fresh tick" here (2026-10-05, the weekend the gate never closed): a REAL symbol whose QUOTE moved
//! within the window (TickCache::any_moved_at). Not a heartbeat resend of an unchanged quote -- whatever time that
//! resend resolves to (no tick_ms, a future-dated tick_ms the ingest replaces with the arrival time, a broker offset
//! recomputed between resends) -- and never a synthetic v* symbol (the shadow bot's 24/7 feed): those kept every gate
//! open all weekend with only closed metals held. The prices every decision uses, and their own freshness, are not
//! touched by this.
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
    /// The wire value of GET /internal/prices' `x-vyx-idle-gate` header (risk_hook::idle_gate_header).
    pub fn header_value(self) -> &'static str {
        match self {
            Gate::Run => "running",
            Gate::FeedQuiet => "feed-quiet",
            Gate::FlatBook => "flat-book",
            Gate::BookClosed => "book-closed",
        }
    }

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
    if !cache.any_moved_at(now, fresh) {
        return Gate::FeedQuiet;
    }
    match book {
        None => Gate::Run,
        Some(symbols) if symbols.is_empty() => Gate::FlatBook,
        Some(symbols) if !cache.any_of_moved_at(symbols, now, fresh) => Gate::BookClosed,
        Some(_) => Gate::Run,
    }
}

/// Whether a book reload is worth a query: something ticked within RELOAD_QUIET_SECS (a position can only open, and a
/// level only fire, on a fresh price).
pub fn reload_due(cache: &TickCache, now: DateTime<Utc>) -> bool {
    cache.any_moved_at(now, Duration::seconds(RELOAD_QUIET_SECS))
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

    /// The weekend of 3-4 Oct 2026 (owner evidence: 18 METALS positions on 4 accounts, metals closed all weekend, yet the
    /// shadow pass, the backstop and the reloads ran all weekend). Replays what the feed can send for a frozen Friday quote
    /// through the ingest's own time resolution (ingest::resolve_tick_time + TickCache::set, exactly ingest_ticks): a
    /// heartbeat resend every 5 s for an hour, while crypto and the synthetic v* feed really move. Every shape of resend
    /// must leave a book holding only gold closed.
    #[test]
    fn a_weekend_of_heartbeats_never_opens_the_gate_of_a_book_holding_closed_metals() {
        use chrono::TimeZone;
        use rust_decimal::Decimal;
        let friday_close = Utc.with_ymd_and_hms(2026, 10, 2, 20, 59, 58).unwrap();
        let saturday = Utc.with_ymd_and_hms(2026, 10, 3, 5, 40, 0).unwrap();
        let gold = |tick_ms: Option<i64>, offset: Option<i64>| -> Tick {
            serde_json::from_value(serde_json::json!({ "symbol": "XAUUSD", "bid": "3871.20", "ask": "3871.45", "tick_ms": tick_ms, "broker_offset_sec": offset })).unwrap()
        };
        let moving = |symbol: &str, k: i64, at: DateTime<Utc>| -> Tick {
            let bid = Decimal::from(60_000 + k);
            serde_json::from_value(serde_json::json!({ "symbol": symbol, "bid": bid, "ask": bid + Decimal::ONE, "tick_ms": at.timestamp_millis() })).unwrap()
        };
        let fri_ms = friday_close.timestamp_millis();
        // (name, the resend at time t): what the EA sends for XAUUSD at t
        type Resend = Box<dyn Fn(DateTime<Utc>) -> Tick>;
        let shapes: Vec<(&str, Resend)> = vec![
            // two feed instances on the box (the single-instance lock is v1.43+): a current EA and an older build without
            // tick_ms, resending the same frozen quote alternately
            ("two feeds, alternating", Box::new(move |t: DateTime<Utc>| if t.timestamp() % 10 == 0 { gold(None, None) } else { gold(Some(fri_ms), Some(0)) })),
            // a correct EA: tick_ms frozen at the real last tick
            ("frozen tick_ms", Box::new(move |_| gold(Some(fri_ms), Some(0)))),
            // an EA build without tick_ms (or a second, older feed instance on the box): arrival time
            ("no tick_ms", Box::new(move |_| gold(None, None))),
            // a broker offset under-estimated by 3 h after a weekend restart: tick_ms 3 h in the FUTURE, which the
            // ingest refuses and replaces with the arrival time
            ("future tick_ms (bad offset)", Box::new(move |_| gold(Some(fri_ms + 3 * 3_600_000), Some(-3 * 3600)))),
            // TimeTradeServer() frozen at Friday's close after a restart: the offset is recomputed every clock sync
            // (60 s), so tick_ms creeps along with the wall clock while the server tick time stays Friday's
            ("offset recomputed every sync", Box::new(move |t: DateTime<Utc>| {
                let synced = t - Duration::seconds(t.timestamp() % 60);
                let offset = -(synced - friday_close).num_seconds();
                gold(Some(fri_ms - offset * 1000), Some(offset))
            })),
        ];
        let held = set(&["XAUUSD"]);
        for (name, resend) in shapes {
            let c = TickCache::new();
            // Friday's last real tick
            let first = gold(Some(fri_ms), Some(0));
            c.set(&first, crate::ingest::resolve_tick_time(&first, friday_close));
            let mut k = 0;
            let mut t = saturday;
            while t < saturday + Duration::hours(1) {
                let hb = resend(t);
                c.set(&hb, crate::ingest::resolve_tick_time(&hb, t));
                for sym in ["BTCUSD", "vGOLD"] {
                    let m = moving(sym, k, t);
                    c.set(&m, crate::ingest::resolve_tick_time(&m, t));
                }
                k += 1;
                // checked between resends as well as right on them
                for probe in [t, t + Duration::milliseconds(2_500)] {
                    assert_eq!(book_gate(&c, Some(&held), probe), Gate::BookClosed, "{name}: gold is closed at {probe}");
                }
                t += Duration::seconds(5);
            }
        }
    }

    #[test]
    fn synthetic_ticks_alone_never_open_any_gate_or_reload() {
        let now = Utc::now();
        let c = cache(&[("vGOLD", 0), ("vEUR", 1)], now);
        assert_eq!(book_gate(&c, None, now), Gate::FeedQuiet, "v* only: the feed counts as quiet");
        assert_eq!(book_gate(&c, Some(&set(&["vGOLD"])), now), Gate::FeedQuiet);
        assert!(!reload_due(&c, now), "v* ticks do not keep the reloads going");
        // a real symbol moving opens it; a book holding only v* is closed to the timers (fires still evaluate it)
        let c = cache(&[("vGOLD", 0), ("XAUUSD", 1)], now);
        assert_eq!(book_gate(&c, Some(&set(&["XAUUSD", "vGOLD"])), now), Gate::Run);
        assert_eq!(book_gate(&c, Some(&set(&["vGOLD"])), now), Gate::BookClosed);
        assert!(reload_due(&c, now));
    }

    #[test]
    fn a_live_quote_still_opens_the_gate_and_a_moving_quote_without_tick_ms_too() {
        let now = Utc::now();
        let c = TickCache::new();
        let t = |bid: &str| -> Tick { serde_json::from_value(serde_json::json!({ "symbol": "XAUUSD", "bid": bid, "ask": "4000" })).unwrap() };
        c.set(&t("3999.1"), now - Duration::seconds(40));
        c.set(&t("3999.2"), now - Duration::seconds(3)); // the quote moved 3 s ago (no tick_ms: arrival time)
        assert_eq!(book_gate(&c, Some(&set(&["XAUUSD"])), now), Gate::Run);
        // the same quote resent for 20 s: its move is now 20 s old -> closed, although the resend arrived just now
        c.set(&t("3999.2"), now + Duration::seconds(17));
        assert_eq!(book_gate(&c, Some(&set(&["XAUUSD"])), now + Duration::seconds(17)), Gate::FeedQuiet, "nothing moved anywhere");
    }

    #[test]
    fn the_log_reports_whether_to_run() {
        let log = GateLog::new("test");
        assert!(!log.observe(Gate::FeedQuiet));
        assert!(!log.observe(Gate::FeedQuiet));
        assert!(log.observe(Gate::Run));
    }
}
