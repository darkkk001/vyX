//! L2 Step 1c item (C) — the broker-day boundary, pinned across both languages.
//!
//! The daily-loss limit resets on the broker's trading day, and the two sides reach it from opposite
//! ends: the ENGINE computes broker-local midnight from the live EA offset
//! (`market_data::bucket_start(D1, now, offset)`, which is also what buckets D1 candles), and the WEB
//! reads the start of the latest D1 candle the engine wrote, falling back to a fixed 22:00 UTC
//! (`lib/trading-day.ts`). If they disagree, an account's limit resets at two different instants
//! depending on which path checked it.
//!
//! `docs/contracts/broker-day-vectors.json` is generated from the web's own functions.

use chrono::{DateTime, Duration, Utc};
use market_data::{bucket_start, Timeframe};

fn vectors() -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/contracts/broker-day-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("broker-day-vectors.json")).unwrap()
}

fn at(v: &serde_json::Value) -> DateTime<Utc> {
    v.as_str().expect("a UTC timestamp").parse().expect("parseable")
}

const GMT_PLUS_2: i64 = 2 * 3600;
const GMT_PLUS_3: i64 = 3 * 3600;

/// The latest `hour`:00 UTC at or before `now` -- the same shape as the web's `fallbackDayStart`,
/// which is this with hour = 22.
fn latest_utc_hour(now: DateTime<Utc>, hour: u32) -> DateTime<Utc> {
    let today = now.date_naive().and_hms_opt(hour, 0, 0).unwrap().and_utc();
    if today > now { today - Duration::days(1) } else { today }
}

/// A GMT+2 broker server (the winter offset) has its local midnight at exactly 22:00 UTC, which is the
/// web's own fixed fallback. So the engine at +2h must land on the web's `fallbackDayStart` instant,
/// case for case -- that is the cross-language pin.
#[test]
fn the_engines_broker_day_matches_the_webs_fallback_at_the_winter_offset() {
    for c in vectors()["fallbackDayStart"].as_array().unwrap() {
        let now = at(&c["now"]);
        let want = at(&c["start"]);
        assert_eq!(bucket_start(Timeframe::D1, now, GMT_PLUS_2), want, "GMT+2 at {}", c["now"]);
        // The summer offset is NOT simply "an hour earlier than the winter one". Inside the 21:00-22:00
        // UTC hour a GMT+3 server's day has ALREADY rolled over while a GMT+2 server's has not, so the
        // two boundaries are 23 hours apart there, not 1. Assert it directly: the latest 21:00 UTC at
        // or before `now`.
        assert_eq!(bucket_start(Timeframe::D1, now, GMT_PLUS_3), latest_utc_hour(now, 21), "GMT+3 at {}", c["now"]);
        assert_eq!(bucket_start(Timeframe::D1, now, GMT_PLUS_2), latest_utc_hour(now, 22), "GMT+2, independently, at {}", c["now"]);
    }
}

/// Offset 0 reduces to naive UTC midnight -- `broker_day_start`'s own documented guarantee, and what
/// makes a missing EA offset a safe default rather than a guess.
#[test]
fn no_offset_reduces_the_broker_day_to_utc_midnight() {
    for c in vectors()["fallbackDayStart"].as_array().unwrap() {
        let now = at(&c["now"]);
        let expected = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();
        assert_eq!(bucket_start(Timeframe::D1, now, 0), expected, "offset 0 at {}", c["now"]);
    }
}

/// The invariants that make it a day boundary at all, asserted independently of any vector: the start
/// is at or before `now`, strictly less than 24 h before it, and a day later moves it by exactly a day.
#[test]
fn the_broker_day_is_a_day_whatever_the_offset() {
    for offset in [0, GMT_PLUS_2, GMT_PLUS_3, -5 * 3600] {
        for c in vectors()["fallbackDayStart"].as_array().unwrap() {
            let now = at(&c["now"]);
            let start = bucket_start(Timeframe::D1, now, offset);
            assert!(start <= now, "offset {offset} at {}: start is after now", c["now"]);
            assert!(now - start < Duration::hours(24), "offset {offset} at {}: start is over a day old", c["now"]);
            assert_eq!(
                bucket_start(Timeframe::D1, now + Duration::days(1), offset),
                start + Duration::days(1),
                "offset {offset} at {}: a day later must move the boundary exactly a day",
                c["now"]
            );
        }
    }
}

/// `rollDayStart`: a known day start stepped forward whole days until it contains `now`, never
/// backwards. The engine computes the boundary directly rather than rolling, so this asserts the two
/// agree on the result -- rolling the web's known start must reach the engine's answer.
#[test]
fn rolling_the_webs_known_day_start_reaches_the_engines_boundary() {
    let mut compared = 0;
    for c in vectors()["rollDayStart"].as_array().unwrap() {
        let now = at(&c["now"]);
        let rolled = at(&c["start"]);
        // `rollDayStart` clamps its step count at zero, so a known start LATER than `now` comes back
        // unchanged -- a boundary in the future. That is the web's documented behaviour for a candle
        // that should not exist yet, not a boundary the engine ever computes, so it is not comparable.
        if rolled > now {
            continue;
        }
        // the web's own known starts here are 22:00 UTC, i.e. a GMT+2 server's local midnight
        assert_eq!(bucket_start(Timeframe::D1, now, GMT_PLUS_2), rolled, "roll at {} from {}", c["now"], c["knownStart"]);
        compared += 1;
    }
    assert!(compared >= 3, "only {compared} roll cases were comparable");
}
