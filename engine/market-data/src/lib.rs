//! Market Data Core — see ../../docs/market-data.md.
//!
//! Ports the ingest/bucketing logic from lib/price-feed.ts unchanged; only
//! the process it runs in and its consumers change (adds a NATS publish
//! and a synchronous read path for the Execution module — see
//! ../../docs/market-data.md §2).

use chrono::{DateTime, Datelike, TimeZone, Utc};
use protocol::Tick;

pub mod cache;
pub mod db;
pub mod gap_fill;
pub mod ingest;
pub mod retention;
pub mod stats;
pub mod symbol_activity;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Timeframe {
    M1,
    M5,
    M30,
    H1,
    H4,
    D1,
    W1,
    Mn1,
    Y1,
}

pub const TIMEFRAMES: [Timeframe; 9] = [
    Timeframe::M1,
    Timeframe::M5,
    Timeframe::M30,
    Timeframe::H1,
    Timeframe::H4,
    Timeframe::D1,
    Timeframe::W1,
    Timeframe::Mn1,
    Timeframe::Y1,
];

/// fix/realtime-sync §4's EA backfill (mt5-ea/VyXTraderPriceFeed.mq5)
/// sends a plain string per timeframe -- the inverse of db.rs's own
/// timeframe_to_str. Note the brief that drove this feature mentions
/// "M15" among the EA's backfill timeframes, but this engine (and the
/// Postgres CandleTimeframe enum it's generated from) has never had an
/// M15 variant -- only M1/M5/M30. Treated as an unrecognized string here
/// (None, silently skipped by the ingest route) rather than silently
/// adding a tenth timeframe end-to-end (client TIMEFRAMES array, this
/// enum, and a Prisma migration) as a side effect of a bug-fix PR.
pub fn timeframe_from_str(s: &str) -> Option<Timeframe> {
    match s {
        "M1" => Some(Timeframe::M1),
        "M5" => Some(Timeframe::M5),
        "M30" => Some(Timeframe::M30),
        "H1" => Some(Timeframe::H1),
        "H4" => Some(Timeframe::H4),
        "D1" => Some(Timeframe::D1),
        "W1" => Some(Timeframe::W1),
        "MN1" | "Mn1" => Some(Timeframe::Mn1),
        "Y1" => Some(Timeframe::Y1),
        _ => None,
    }
}

/// Fixed-millisecond spacing for M1..D1. W1/Mn1/Y1 need real calendar math
/// (see `bucket_start`) — ported 1:1 from lib/price-feed.ts's FIXED_MS.
/// `pub(crate)` for gap_fill.rs's own use -- gaps are only worth
/// synthesizing for fixed-duration timeframes (see that module's doc
/// comment).
pub(crate) fn fixed_ms(tf: Timeframe) -> Option<i64> {
    match tf {
        Timeframe::M1 => Some(60_000),
        Timeframe::M5 => Some(300_000),
        Timeframe::M30 => Some(1_800_000),
        Timeframe::H1 => Some(3_600_000),
        Timeframe::H4 => Some(14_400_000),
        Timeframe::D1 => Some(86_400_000),
        _ => None,
    }
}

/// Calendar-aware bucket start, matching lib/price-feed.ts's `bucketStart`
/// exactly: weeks start Monday UTC, months/years start on the 1st UTC.
pub fn bucket_start(tf: Timeframe, now: DateTime<Utc>) -> DateTime<Utc> {
    if let Some(ms) = fixed_ms(tf) {
        let floored = (now.timestamp_millis() / ms) * ms;
        return Utc.timestamp_millis_opt(floored).unwrap();
    }

    match tf {
        Timeframe::W1 => {
            let days_since_monday = now.weekday().num_days_from_monday();
            (now - chrono::Duration::days(days_since_monday as i64))
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
        }
        Timeframe::Mn1 => Utc
            .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
            .unwrap(),
        Timeframe::Y1 => Utc.with_ymd_and_hms(now.year(), 1, 1, 0, 0, 0).unwrap(),
        _ => unreachable!("fixed_ms covers every other variant"),
    }
}

#[derive(Debug, Clone)]
pub struct CandleUpdate {
    pub symbol: String,
    pub timeframe: Timeframe,
    pub bucket_start: DateTime<Utc>,
    pub open: rust_decimal::Decimal,
    pub high: rust_decimal::Decimal,
    pub low: rust_decimal::Decimal,
    pub close: rust_decimal::Decimal,
}

/// Given a tick and "now", produces the candle upsert for every timeframe.
/// Persistence (the ON CONFLICT ... GREATEST/LEAST upsert) and the
/// LivePrice write are left to the caller — this crate computes, it
/// doesn't own the Postgres connection pool. See ../../docs/database.md §2
/// for why Market Data Core is the sole writer of these tables regardless
/// of which layer issues the actual SQL.
pub fn candle_updates_for_tick(tick: &Tick, now: DateTime<Utc>) -> Vec<CandleUpdate> {
    TIMEFRAMES
        .iter()
        .map(|&tf| CandleUpdate {
            symbol: tick.symbol.clone(),
            timeframe: tf,
            bucket_start: bucket_start(tf, now),
            open: tick.bid,
            high: tick.bid,
            low: tick.bid,
            close: tick.bid,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Weekday;

    #[test]
    fn m1_floors_to_the_minute() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 45).unwrap();
        let start = bucket_start(Timeframe::M1, now);
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 0).unwrap());
    }

    #[test]
    fn week_starts_monday() {
        // 2026-08-13 is a Thursday.
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 45).unwrap();
        let start = bucket_start(Timeframe::W1, now);
        assert_eq!(start.weekday(), Weekday::Mon);
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 8, 10, 0, 0, 0).unwrap());
    }

    #[test]
    fn month_and_year_start_on_the_1st() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 45).unwrap();
        assert_eq!(
            bucket_start(Timeframe::Mn1, now),
            Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap()
        );
        assert_eq!(
            bucket_start(Timeframe::Y1, now),
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()
        );
    }

    /// Only M1 had a dedicated test before this -- the other 5
    /// fixed-millisecond timeframes were untested (docs/testing.md §2's
    /// Market Data Core gate: candle-bucketing correctness).
    #[test]
    fn fixed_timeframes_floor_correctly() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 37, 45).unwrap();
        assert_eq!(bucket_start(Timeframe::M5, now), Utc.with_ymd_and_hms(2026, 8, 13, 10, 35, 0).unwrap());
        assert_eq!(bucket_start(Timeframe::M30, now), Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 0).unwrap());
        assert_eq!(bucket_start(Timeframe::H1, now), Utc.with_ymd_and_hms(2026, 8, 13, 10, 0, 0).unwrap());
        assert_eq!(bucket_start(Timeframe::H4, now), Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap());
        assert_eq!(bucket_start(Timeframe::D1, now), Utc.with_ymd_and_hms(2026, 8, 13, 0, 0, 0).unwrap());
    }

    /// candle_updates_for_tick had zero test coverage -- this is the
    /// function every DB writer actually consumes per tick, not just
    /// bucket_start in isolation.
    #[test]
    fn candle_updates_for_tick_covers_every_timeframe() {
        use rust_decimal_macros::dec;

        let tick = Tick { symbol: "EURUSD".into(), bid: dec!(1.10000), ask: dec!(1.10020), t0: None, clock_offset_ms: None, rtt_ms: None };
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 45).unwrap();
        let updates = candle_updates_for_tick(&tick, now);

        assert_eq!(updates.len(), TIMEFRAMES.len());
        for update in &updates {
            assert_eq!(update.symbol, "EURUSD");
            assert_eq!(update.open, tick.bid);
            assert_eq!(update.high, tick.bid);
            assert_eq!(update.low, tick.bid);
            assert_eq!(update.close, tick.bid);
        }
    }

    #[test]
    fn candle_updates_for_tick_bucket_starts_match_bucket_start_directly() {
        use rust_decimal_macros::dec;

        let tick = Tick { symbol: "EURUSD".into(), bid: dec!(1.10000), ask: dec!(1.10020), t0: None, clock_offset_ms: None, rtt_ms: None };
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 45).unwrap();
        let updates = candle_updates_for_tick(&tick, now);

        let m1 = updates.iter().find(|u| u.timeframe == Timeframe::M1).unwrap();
        assert_eq!(m1.bucket_start, bucket_start(Timeframe::M1, now));

        let w1 = updates.iter().find(|u| u.timeframe == Timeframe::W1).unwrap();
        assert_eq!(w1.bucket_start, bucket_start(Timeframe::W1, now));
    }
}
