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

fn has_daily_break(category: &str) -> bool {
    category == "METALS"
}

/// lib/risk.ts isInDailyBreak: METALS, Monday..Thursday, during the NY-close hour.
pub fn is_in_daily_break(now: DateTime<Utc>, category: &str) -> bool {
    if !has_daily_break(category) {
        return false;
    }
    let day = now.weekday().num_days_from_sunday();
    (1..=4).contains(&day) && now.hour() == ny_close_hour_utc(now)
}

/// lib/risk.ts isDefaultFxSessionClosed: Saturday all day, Friday >= 21:00 UTC, Sunday < 22:00 UTC.
pub fn is_default_fx_session_closed(now: DateTime<Utc>) -> bool {
    let day = now.weekday().num_days_from_sunday();
    let hour = now.hour();
    day == 6 || (day == 5 && hour >= 21) || (day == 0 && hour < 22)
}

fn to_minutes(hhmm: &str) -> Option<u32> {
    let (h, m) = hhmm.split_once(':')?;
    Some(h.trim().parse::<u32>().ok()? * 60 + m.trim().parse::<u32>().ok()?)
}

/// lib/risk.ts checkTradingSession, as a bool: true = MARKET_CLOSED.
pub fn is_market_closed(sessions: &[SessionWindow], now: DateTime<Utc>, category: &str) -> bool {
    if is_continuously_traded(category) {
        return false;
    }
    if sessions.is_empty() {
        return is_default_fx_session_closed(now) || is_in_daily_break(now, category);
    }
    let day = now.weekday().num_days_from_sunday() as i32;
    let minutes = now.hour() * 60 + now.minute();
    let open = sessions.iter().any(|s| {
        if s.day_of_week != day {
            return false;
        }
        // a malformed time is NaN on the web, which makes both comparisons false: never open
        match (to_minutes(&s.open_time), to_minutes(&s.close_time)) {
            (Some(o), Some(c)) => minutes >= o && minutes < c,
            _ => false,
        }
    });
    !open
}

#[cfg(test)]
mod tests {
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
        assert!(is_default_fx_session_closed(at(2026, 8, 4, 22, 30))); // Fri 22:30
        assert!(is_default_fx_session_closed(at(2026, 8, 5, 12, 0))); // Sat
        assert!(is_default_fx_session_closed(at(2026, 8, 6, 21, 59))); // Sun 21:59
        assert!(!is_default_fx_session_closed(at(2026, 8, 6, 22, 1))); // Sun 22:01
        assert!(!is_default_fx_session_closed(at(2026, 8, 2, 12, 0))); // Wed
    }

    #[test]
    fn check_trading_session() {
        assert!(is_market_closed(&[], at(2026, 8, 4, 22, 30), "METALS"));
        assert!(is_market_closed(&[], at(2026, 8, 6, 21, 59), "METALS"));
        assert!(!is_market_closed(&[], at(2026, 8, 6, 22, 1), "METALS"));
        assert!(!is_market_closed(&[], at(2026, 8, 5, 12, 0), "CRYPTO"));
        assert!(!is_market_closed(&[w(6, "00:00", "23:59")], at(2026, 8, 5, 12, 0), "METALS"));
        assert!(is_market_closed(&[w(3, "09:00", "17:00")], at(2026, 8, 2, 20, 0), "METALS"));
        assert!(is_market_closed(&[], at(2026, 8, 5, 12, 0), "INDICES"));
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
        assert!(is_in_daily_break(wed_summer_break, "METALS"));
        assert!(is_market_closed(&[], wed_summer_break, "METALS"));
        assert!(!is_market_closed(&[], at(2026, 8, 16, 22, 30), "METALS"));
        assert!(!is_market_closed(&[], at(2026, 8, 16, 20, 59), "METALS"));
        assert!(is_market_closed(&[], at(2026, 0, 14, 22, 30), "METALS"));
        assert!(!is_market_closed(&[], at(2026, 0, 14, 21, 30), "METALS"));
        assert!(!is_market_closed(&[], wed_summer_break, "FOREX"));
        assert!(!is_market_closed(&[], wed_summer_break, "CRYPTO"));
        assert!(!is_market_closed(&[w(3, "00:00", "23:59")], wed_summer_break, "METALS"));
        assert!(!is_in_daily_break(at(2026, 8, 18, 21, 30), "METALS")); // Friday
    }

    #[test]
    fn malformed_session_time_is_never_open() {
        assert!(is_market_closed(&[w(3, "nine", "17:00")], at(2026, 8, 2, 12, 0), "METALS"));
    }
}
