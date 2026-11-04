//! Trading-session gate (Rust cutover Stage 2, F4 in docs/RUST-CUTOVER-PLAN.md): a line-for-line port of
//! lib/risk.ts `checkTradingSession` and its helpers, so the engine treats a symbol whose market is closed
//! exactly like the web does: as having no usable price (no SL/TP, no stop-out off a frozen quote).
//!
//! All times are UTC. Categories are Prisma's `SymbolCategory` names (FOREX, METALS, INDICES, CRYPTO, ...).

use chrono::{DateTime, Datelike, TimeZone, Timelike, Utc};

/// One configured `"TradingSession"` row of a BrokerSymbol: `day_of_week` 0 = Sunday .. 6 = Saturday,
/// `open_time` / `close_time` "HH:MM" UTC, open inclusive, close exclusive.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionWindow {
    pub day_of_week: i32,
    pub open_time: String,
    pub close_time: String,
}

fn is_continuously_traded(category: &str) -> bool {
    category == "CRYPTO"
}

fn nth_sunday_of_month_utc(year: i32, month0: u32, n: u32) -> DateTime<Utc> {
    let first = Utc.with_ymd_and_hms(year, month0 + 1, 1, 0, 0, 0).single().expect("valid date");
    let first_sunday = 1 + ((7 - first.weekday().num_days_from_sunday()) % 7);
    Utc.with_ymd_and_hms(year, month0 + 1, first_sunday + (n - 1) * 7, 0, 0, 0).single().expect("valid date")
}

/// lib/risk.ts usEasternIsDst: 2nd Sunday of March 07:00 UTC .. 1st Sunday of November 06:00 UTC.
pub fn us_eastern_is_dst(now: DateTime<Utc>) -> bool {
    let y = now.year();
    let start = nth_sunday_of_month_utc(y, 2, 2) + chrono::Duration::hours(7);
    let end = nth_sunday_of_month_utc(y, 10, 1) + chrono::Duration::hours(6);
    now >= start && now < end
}

/// lib/risk.ts nyCloseHourUtc: the NY 17:00 hour in UTC (21 in US summer time, 22 in winter).
pub fn ny_close_hour_utc(now: DateTime<Utc>) -> u32 {
    if us_eastern_is_dst(now) { 21 } else { 22 }
}

/// lib/risk.ts `dailyBreakHours` (owner 2026-10-23, option A, from two weeks of feed data).
///
/// METALS pause one hour from the NY-17:00 anchor. So does SpotCrude. **SpotBrent pauses three**
/// (17:00 New York to 01:00 London). Everything else has no break.
///
/// L2 Step 1b: this used to be `category == "METALS"` with a fixed one-hour window, so the engine
/// treated SpotBrent and SpotCrude as having no break at all and could not have expressed a three-hour
/// one. Found by the parity oracle (docs/contracts/trading-session-vectors.json), not by reading.
pub fn daily_break_hours(category: &str, symbol_name: Option<&str>) -> u32 {
    match category {
        "METALS" => 1,
        "COMMODITIES" => {
            if symbol_name.unwrap_or("").to_lowercase().starts_with("spotbrent") {
                3
            } else {
                1
            }
        }
        _ => 0,
    }
}

pub fn has_daily_break(category: &str, symbol_name: Option<&str>) -> bool {
    daily_break_hours(category, symbol_name) > 0
}

/// lib/risk.ts `isInDailyBreak` / `dailyBreakStart`.
///
/// Whole hours since the anchor, compared against the category's own break length -- which is how a
/// break that runs past midnight UTC works (Brent in winter: 22:00 -> 01:00). Sunday..Thursday:
/// SUNDAY COUNTS (owner 2026-10-26), because a break symbol's week opens at the anchor PLUS its break,
/// and before that rule an XAUUSD order at Sunday 21:30 UTC was accepted against Friday's frozen price.
pub fn is_in_daily_break(now: DateTime<Utc>, category: &str, symbol_name: Option<&str>) -> bool {
    let hours = daily_break_hours(category, symbol_name);
    if hours == 0 {
        return false;
    }
    // whole hours since today's (or last night's) anchor
    let into = (now.hour() + 24 - ny_close_hour_utc(now)) % 24;
    if into >= hours {
        return false;
    }
    // the day the break STARTED, which is not today's once it has crossed midnight UTC
    let start = now - chrono::Duration::hours(into as i64);
    let day = start.weekday().num_days_from_sunday();
    day <= 4
}

/// lib/risk.ts isDefaultFxSessionClosed = lib/market-week.ts isWeeklyClosed: Friday 17:00 New York -> Sunday 17:00
/// New York, i.e. Saturday all day, Friday from the NY-close hour, Sunday before it -- 21:00 UTC while US daylight
/// time is in force, 22:00 UTC otherwise (docs/contracts/market-week-vectors.json). 2026-09-27 fix: this was still
/// the fixed Friday >= 21:00 / Sunday < 22:00 UTC rule, so on a summer Sunday 21:00-22:00 the engine (and its Stage 5
/// shadow) treated the market as closed while the web traded it, and in winter it closed an hour early on Friday.
pub fn is_default_fx_session_closed(now: DateTime<Utc>) -> bool {
    let day = now.weekday().num_days_from_sunday();
    let hour = now.hour();
    let close = ny_close_hour_utc(now);
    day == 6 || (day == 5 && hour >= close) || (day == 0 && hour < close)
}

fn to_minutes(hhmm: &str) -> Option<u32> {
    let (h, m) = hhmm.split_once(':')?;
    Some(h.trim().parse::<u32>().ok()? * 60 + m.trim().parse::<u32>().ok()?)
}

/// lib/risk.ts `checkTradingSession`, as a bool: true = MARKET_CLOSED.
///
/// `symbol_name` is needed by the commodity break (`daily_break_hours`), which is why it is not
/// optional in the way a caller could forget -- pass what the order is actually for.
pub fn is_market_closed(sessions: &[SessionWindow], now: DateTime<Utc>, category: &str, symbol_name: Option<&str>) -> bool {
    if is_continuously_traded(category) {
        return false;
    }
    if sessions.is_empty() {
        return is_default_fx_session_closed(now) || is_in_daily_break(now, category, symbol_name);
    }
    let day = now.weekday().num_days_from_sunday() as i32;
    let minutes = now.hour() * 60 + now.minute();
    !sessions.iter().any(|s| session_covers(s, day, minutes))
}

/// lib/risk.ts `sessionCovers`. `dayOfWeek` is the day the window OPENS; `openTime` is inclusive and
/// `closeTime` exclusive, and the three branches are not interchangeable:
///
/// - `close > open`: the ordinary same-day window, e.g. 08:00-17:00. `"24:00"` parses to 1440, which
///   is greater than any real minute, so an all-day window is just this branch.
/// - `close < open`: the window CROSSES MIDNIGHT, e.g. Mon 22:00-02:00 = Monday 22:00 to Tuesday
///   02:00. So it covers two different UTC days, and on the second one the row's own `dayOfWeek` is
///   yesterday's.
/// - `close == open`: refused by the sessions editor as ambiguous (empty, or 24 h?), so never open.
///
/// L2 Step 1b: the engine implemented ONLY the first branch, and returned early whenever the row's day
/// was not today -- so every cross-midnight window was treated as closed for its whole length, on both
/// days. A broker with a Mon 22:00-02:00 session had the engine refuse orders the web accepted for four
/// hours a day. Found by the parity oracle, not by reading the two side by side.
fn session_covers(s: &SessionWindow, day: i32, minutes: u32) -> bool {
    // a malformed time is NaN on the web, which makes every comparison false: never open
    let (Some(open), Some(close)) = (to_minutes(&s.open_time), to_minutes(&s.close_time)) else {
        return false;
    };
    if close > open {
        return s.day_of_week == day && minutes >= open && minutes < close;
    }
    if close < open {
        return (s.day_of_week == day && minutes >= open) || ((s.day_of_week + 1) % 7 == day && minutes < close);
    }
    false
}

#[cfg(test)]
mod tests {
    /// docs/contracts/market-week-vectors.json -- the same file the web (lib/market-week.test.ts), the terminal and the
    /// engine's candle gap-fill are pinned to: every case, for a symbol without configured sessions.
    #[test]
    fn the_default_weekly_close_matches_the_market_week_vectors() {
        let file: serde_json::Value = serde_json::from_str(include_str!("../../../docs/contracts/market-week-vectors.json")).unwrap();
        let cases = file["cases"].as_array().unwrap();
        assert!(cases.len() >= 20);
        for c in cases {
            let at: DateTime<Utc> = c["utc"].as_str().unwrap().parse().unwrap();
            let closed = c["closed"].as_bool().unwrap();
            assert_eq!(is_default_fx_session_closed(at), closed, "{} ({})", c["utc"], c["why"]);
            assert_eq!(is_market_closed(&[], at, "FOREX", None), closed, "FOREX {}", c["utc"]);
            assert!(!is_market_closed(&[], at, "CRYPTO", None), "crypto never closes {}", c["utc"]);
        }
    }

    use super::*;

    // Every case below is lib/risk.test.ts's own, same instants, same expectations.
    fn at(y: i32, month0: u32, d: u32, h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, month0 + 1, d, h, m, 0).single().unwrap()
    }
    fn w(day: i32, open: &str, close: &str) -> SessionWindow {
        SessionWindow { day_of_week: day, open_time: open.into(), close_time: close.into() }
    }

    #[test]
    fn default_fx_session() {
        // summer (US daylight time): Friday 21:00 UTC close, Sunday 21:00 UTC reopen
        assert!(!is_default_fx_session_closed(at(2026, 8, 4, 20, 59))); // Fri 20:59
        assert!(is_default_fx_session_closed(at(2026, 8, 4, 21, 0))); // Fri 21:00
        assert!(is_default_fx_session_closed(at(2026, 8, 5, 12, 0))); // Sat
        assert!(is_default_fx_session_closed(at(2026, 8, 6, 20, 59))); // Sun 20:59
        assert!(!is_default_fx_session_closed(at(2026, 8, 6, 21, 0))); // Sun 21:00 reopen (was closed until 22:00: the bug)
        assert!(!is_default_fx_session_closed(at(2026, 8, 2, 12, 0))); // Wed
        // winter: Friday 22:00 UTC close, Sunday 22:00 UTC reopen
        assert!(!is_default_fx_session_closed(at(2026, 11, 4, 21, 30))); // Fri 2026-12-04 21:30 (was closed: the bug)
        assert!(is_default_fx_session_closed(at(2026, 11, 4, 22, 0))); // Fri 22:00
        assert!(is_default_fx_session_closed(at(2026, 11, 6, 21, 59))); // Sun 21:59
        assert!(!is_default_fx_session_closed(at(2026, 11, 6, 22, 0))); // Sun 22:00 reopen
    }

    #[test]
    fn check_trading_session() {
        assert!(is_market_closed(&[], at(2026, 8, 4, 22, 30), "METALS", Some("XAUUSD")));
        assert!(is_market_closed(&[], at(2026, 8, 6, 20, 59), "METALS", Some("XAUUSD"))); // summer Sunday before the 21:00 reopen
        // L2 Step 1b: this used to assert gold was OPEN at summer Sunday 21:01, which was the rule when
        // the break was Monday..Thursday only. Owner 2026-10-26 made SUNDAY count, so a break symbol's
        // week opens at the anchor PLUS its break -- gold at 22:00 UTC in summer, not 21:00. The web's
        // own vectors say closed here (docs/contracts/trading-session-vectors.json,
        // 2026-07-05T21:30:00Z), so the engine matching them is the fix, not a regression.
        assert!(is_market_closed(&[], at(2026, 8, 6, 21, 1), "METALS", Some("XAUUSD"))); // summer Sunday, still inside the break
        assert!(!is_market_closed(&[], at(2026, 8, 6, 22, 0), "METALS", Some("XAUUSD"))); // and open once the break ends
        assert!(is_market_closed(&[], at(2026, 11, 6, 21, 59), "METALS", Some("XAUUSD"))); // winter Sunday before the 22:00 reopen
        assert!(!is_market_closed(&[], at(2026, 8, 5, 12, 0), "CRYPTO", None));
        assert!(!is_market_closed(&[w(6, "00:00", "23:59")], at(2026, 8, 5, 12, 0), "METALS", Some("XAUUSD")));
        assert!(is_market_closed(&[w(3, "09:00", "17:00")], at(2026, 8, 2, 20, 0), "METALS", Some("XAUUSD")));
        assert!(is_market_closed(&[], at(2026, 8, 5, 12, 0), "INDICES", None));
    }

    #[test]
    fn metals_daily_break_and_us_dst() {
        assert!(us_eastern_is_dst(at(2026, 8, 16, 12, 0)));
        assert!(!us_eastern_is_dst(at(2026, 0, 14, 12, 0)));
        assert!(!us_eastern_is_dst(at(2026, 2, 8, 6, 59)));
        assert!(us_eastern_is_dst(at(2026, 2, 8, 7, 0)));
        assert!(us_eastern_is_dst(at(2026, 10, 1, 5, 59)));
        assert!(!us_eastern_is_dst(at(2026, 10, 1, 6, 0)));
        assert_eq!(ny_close_hour_utc(at(2026, 8, 16, 12, 0)), 21);
        assert_eq!(ny_close_hour_utc(at(2026, 0, 14, 12, 0)), 22);

        let wed_summer_break = at(2026, 8, 16, 21, 30);
        assert!(is_in_daily_break(wed_summer_break, "METALS", Some("XAUUSD")));
        assert!(is_market_closed(&[], wed_summer_break, "METALS", Some("XAUUSD")));
        assert!(!is_market_closed(&[], at(2026, 8, 16, 22, 30), "METALS", Some("XAUUSD")));
        assert!(!is_market_closed(&[], at(2026, 8, 16, 20, 59), "METALS", Some("XAUUSD")));
        assert!(is_market_closed(&[], at(2026, 0, 14, 22, 30), "METALS", Some("XAUUSD")));
        assert!(!is_market_closed(&[], at(2026, 0, 14, 21, 30), "METALS", Some("XAUUSD")));
        assert!(!is_market_closed(&[], wed_summer_break, "FOREX", None));
        assert!(!is_market_closed(&[], wed_summer_break, "CRYPTO", None));
        assert!(!is_market_closed(&[w(3, "00:00", "23:59")], wed_summer_break, "METALS", Some("XAUUSD")));
        assert!(!is_in_daily_break(at(2026, 8, 18, 21, 30), "METALS", Some("XAUUSD"))); // Friday
    }

    #[test]
    fn malformed_session_time_is_never_open() {
        assert!(is_market_closed(&[w(3, "nine", "17:00")], at(2026, 8, 2, 12, 0), "METALS", Some("XAUUSD")));
    }
}
