//! Market Data Core — see ../../docs/market-data.md.
//!
//! Ports the ingest/bucketing logic from lib/price-feed.ts unchanged; only
//! the process it runs in and its consumers change (adds a NATS publish
//! and a synchronous read path for the Execution module — see
//! ../../docs/market-data.md §2).

use chrono::{DateTime, Datelike, TimeZone, Utc};
use protocol::Tick;

pub mod alerts;
pub mod broker_offset;
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
/// exactly when `broker_offset_sec` is 0: weeks start Monday, months/years
/// start on the 1st. D1/W1/Mn1/Y1 all resolve to a "day" boundary using
/// `broker_offset_sec` (see `broker_day_start`'s own doc comment for why
/// that's the broker's day, not naive UTC).
///
/// 2026-09-07 fix -- H4 is pulled out of the naive fast path alongside D1
/// now too, for the identical reason: MT5's own H4 bars are anchored to
/// the broker's day start (6 fixed buckets per broker day -- 00:00,
/// 04:00, 08:00... broker-LOCAL, not UTC), exactly like D1/W1/Mn1/Y1, and
/// the EA's history backfill (`HistoryBackfillPeriods` in the .mq5, which
/// includes PERIOD_H4) already sends H4 bars converted to that same
/// broker-boundary-aligned UTC bucketStart. This crate's live-tick path
/// kept bucketing H4 at naive UTC 4-hour marks (0/4/8/12/16/20 UTC),
/// which only coincidentally agrees with the broker-aligned grid when
/// broker_offset_sec happens to be an exact multiple of 4 hours -- for
/// any other whole-hour offset (the vast majority of real brokers: +2,
/// +3, +5, ...) the two grids never collide, producing a second,
/// spurious H4 row for literally every bucket, exactly the D1 bug one
/// level down. Verified against production: 12,772 overlapping H4 rows
/// across 30/30 symbols.
///
/// M1/M5/M30/H1 genuinely don't need this: any whole-hour
/// `broker_offset_sec` (every real broker configuration seen in this
/// codebase) is itself always an exact multiple of each of their periods
/// (60s/300s/1800s/3600s all evenly divide 3600s*N), so shifting by it
/// and flooring lands on the identical instant whether or not the shift
/// is applied -- there is no grid to collide with. Only 4h (and D1's own
/// 24h) can disagree with a whole-hour offset that isn't itself a
/// multiple of 4 (respectively 24). A hypothetical non-whole-hour broker
/// offset (e.g. a genuine UTC+X:30 trade-server clock) would reopen this
/// for H1 and below too -- no such broker has been observed in this
/// codebase's history, so that's flagged, not fixed, here.
pub fn bucket_start(tf: Timeframe, now: DateTime<Utc>, broker_offset_sec: i64) -> DateTime<Utc> {
    if let Some(ms) = fixed_ms(tf) {
        if tf != Timeframe::D1 && tf != Timeframe::H4 {
            let floored = (now.timestamp_millis() / ms) * ms;
            return Utc.timestamp_millis_opt(floored).unwrap();
        }
    }

    match tf {
        Timeframe::D1 => broker_day_start(now, broker_offset_sec),
        Timeframe::H4 => broker_period_start(now, broker_offset_sec, fixed_ms(Timeframe::H4).unwrap()),
        Timeframe::W1 => {
            let shifted = now + chrono::Duration::seconds(broker_offset_sec);
            let days_since_monday = shifted.weekday().num_days_from_monday();
            let monday_local = (shifted - chrono::Duration::days(days_since_monday as i64))
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .unwrap();
            Utc.from_utc_datetime(&monday_local) - chrono::Duration::seconds(broker_offset_sec)
        }
        Timeframe::Mn1 => {
            let shifted = now + chrono::Duration::seconds(broker_offset_sec);
            let first_of_month_local = shifted.date_naive().with_day(1).unwrap().and_hms_opt(0, 0, 0).unwrap();
            Utc.from_utc_datetime(&first_of_month_local) - chrono::Duration::seconds(broker_offset_sec)
        }
        Timeframe::Y1 => {
            let shifted = now + chrono::Duration::seconds(broker_offset_sec);
            let first_of_year_local = chrono::NaiveDate::from_ymd_opt(shifted.year(), 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap();
            Utc.from_utc_datetime(&first_of_year_local) - chrono::Duration::seconds(broker_offset_sec)
        }
        _ => unreachable!("fixed_ms (minus D1 and H4, handled above) covers every other variant"),
    }
}

/// The UTC instant of the broker's own most recent midnight <= `now`,
/// given `broker_offset_sec` (protocol::Tick's broker_offset_sec, the
/// EA's BrokerOffsetSec = TimeTradeServer() - TimeGMT(), recomputed by
/// the EA on every clock sync so a DST shift is picked up live -- see
/// that variable's own comment in the EA). Pepperstone is UTC+3, so its
/// real daily bar boundary is 21:00 UTC, not midnight UTC.
///
/// Bucketing D1 at naive UTC midnight (this function's own previous
/// behavior -- equivalent to always calling this with offset=0) silently
/// produced a SECOND, competing D1 row for every real trading day: the
/// EA's CopyRates history backfill already correctly writes broker-
/// boundary-aligned bars via `ingest_history` (it converts before
/// sending), but this crate's own live-tick aggregation kept bucketing at
/// UTC midnight, so the two never landed on the same `bucketStart` and
/// the documented "broker bars beat our aggregates, last write wins"
/// upsert precedence (`db::upsert_candles_authoritative_batch`) never
/// actually took effect -- both rows just coexisted forever.
/// `scripts/fix-broker-day-candles.ts` reconciles the historical damage
/// this already did; this function is what stops it from continuing.
///
/// offset=0 (no tick has ever carried one -- an old EA build, or a test)
/// reduces to exactly the old naive-UTC-midnight math, so this is a
/// zero-behavior-change fix until a real offset is actually observed.
fn broker_day_start(now: DateTime<Utc>, broker_offset_sec: i64) -> DateTime<Utc> {
    let offset = chrono::Duration::seconds(broker_offset_sec);
    let broker_local_midnight = (now + offset).date_naive().and_hms_opt(0, 0, 0).unwrap();
    Utc.from_utc_datetime(&broker_local_midnight) - offset
}

/// The UTC instant of the broker's own most recent fixed-`period_ms`
/// boundary <= `now` -- the same "shift by the broker's offset, floor,
/// shift back" idea as `broker_day_start` above, generalized to any
/// period that evenly divides a day (today: only H4's 14,400,000ms,
/// alongside D1's 86,400,000ms which still goes through `broker_day_start`
/// itself for its date-based/DST-transition-friendly arithmetic -- both
/// produce the identical instant for D1's own period; this one exists
/// for H4, kept as a separate small function rather than rewriting
/// `broker_day_start` in terms of it, so D1's own well-exercised tests
/// keep exercising the exact code path they always have).
///
/// Plain integer division, not `div_euclid` -- safe here because
/// `now.timestamp_millis() + offset_ms` stays a large positive number for
/// any real date this app will ever see (a broker offset is at most
/// +-24h, utterly dwarfed by the epoch-millis value itself), so truncating
/// and flooring division agree.
fn broker_period_start(now: DateTime<Utc>, broker_offset_sec: i64, period_ms: i64) -> DateTime<Utc> {
    let offset_ms = broker_offset_sec * 1000;
    let floored = ((now.timestamp_millis() + offset_ms) / period_ms) * period_ms - offset_ms;
    Utc.timestamp_millis_opt(floored).unwrap()
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
pub fn candle_updates_for_tick(tick: &Tick, now: DateTime<Utc>, broker_offset_sec: i64) -> Vec<CandleUpdate> {
    TIMEFRAMES
        .iter()
        .map(|&tf| CandleUpdate {
            symbol: tick.symbol.clone(),
            timeframe: tf,
            bucket_start: bucket_start(tf, now, broker_offset_sec),
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
        let start = bucket_start(Timeframe::M1, now, 0);
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 0).unwrap());
    }

    #[test]
    fn week_starts_monday() {
        // 2026-08-13 is a Thursday.
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 45).unwrap();
        let start = bucket_start(Timeframe::W1, now, 0);
        assert_eq!(start.weekday(), Weekday::Mon);
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 8, 10, 0, 0, 0).unwrap());
    }

    #[test]
    fn month_and_year_start_on_the_1st() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 45).unwrap();
        assert_eq!(
            bucket_start(Timeframe::Mn1, now, 0),
            Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap()
        );
        assert_eq!(
            bucket_start(Timeframe::Y1, now, 0),
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()
        );
    }

    /// Only M1 had a dedicated test before this -- the other 5
    /// fixed-millisecond timeframes were untested (docs/testing.md §2's
    /// Market Data Core gate: candle-bucketing correctness).
    #[test]
    fn fixed_timeframes_floor_correctly() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 37, 45).unwrap();
        assert_eq!(bucket_start(Timeframe::M5, now, 0), Utc.with_ymd_and_hms(2026, 8, 13, 10, 35, 0).unwrap());
        assert_eq!(bucket_start(Timeframe::M30, now, 0), Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 0).unwrap());
        assert_eq!(bucket_start(Timeframe::H1, now, 0), Utc.with_ymd_and_hms(2026, 8, 13, 10, 0, 0).unwrap());
        assert_eq!(bucket_start(Timeframe::H4, now, 0), Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap());
        assert_eq!(bucket_start(Timeframe::D1, now, 0), Utc.with_ymd_and_hms(2026, 8, 13, 0, 0, 0).unwrap());
    }

    /// candle_updates_for_tick had zero test coverage -- this is the
    /// function every DB writer actually consumes per tick, not just
    /// bucket_start in isolation.
    #[test]
    fn candle_updates_for_tick_covers_every_timeframe() {
        use rust_decimal_macros::dec;

        let tick = Tick { symbol: "EURUSD".into(), bid: dec!(1.10000), ask: dec!(1.10020), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None };
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 45).unwrap();
        let updates = candle_updates_for_tick(&tick, now, 0);

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

        let tick = Tick { symbol: "EURUSD".into(), bid: dec!(1.10000), ask: dec!(1.10020), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None };
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 45).unwrap();
        let updates = candle_updates_for_tick(&tick, now, 0);

        let m1 = updates.iter().find(|u| u.timeframe == Timeframe::M1).unwrap();
        assert_eq!(m1.bucket_start, bucket_start(Timeframe::M1, now, 0));

        let w1 = updates.iter().find(|u| u.timeframe == Timeframe::W1).unwrap();
        assert_eq!(w1.bucket_start, bucket_start(Timeframe::W1, now, 0));
    }

    // ---- broker-day-boundary tests (the D1-duplicate-bar fix) ----

    /// Pepperstone-shaped: UTC+3, no DST in effect. 2026-08-13 08:00 UTC is
    /// 11:00 broker-local, so today's broker midnight is 2026-08-12 21:00
    /// UTC (yesterday, UTC-wise) -- the exact "21:00Z" shape the duplicate
    /// rows in production actually had.
    #[test]
    fn d1_aligns_to_the_broker_day_boundary_for_a_utc_plus_3_broker() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap();
        let offset_sec = 3 * 3600;
        let start = bucket_start(Timeframe::D1, now, offset_sec);
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 8, 12, 21, 0, 0).unwrap());

        // The rollover instant itself is broker midnight (00:00
        // broker-local) converted to UTC: 00:00 - 3h = 21:00 UTC the
        // previous UTC day. A tick one minute before that (20:59
        // broker-local) must still belong to the PREVIOUS broker day...
        let just_before = Utc.with_ymd_and_hms(2026, 8, 12, 20, 59, 0).unwrap();
        assert_eq!(
            bucket_start(Timeframe::D1, just_before, offset_sec),
            Utc.with_ymd_and_hms(2026, 8, 11, 21, 0, 0).unwrap()
        );
        // ...while a tick AT that same instant (Aug 12 21:00 UTC = Aug 13
        // 00:00 broker-local) has already rolled to the next broker day,
        // landing on the exact same bucket `start` (computed above from a
        // point later that same broker-day) resolves to.
        let just_after = Utc.with_ymd_and_hms(2026, 8, 12, 21, 0, 0).unwrap();
        assert_eq!(bucket_start(Timeframe::D1, just_after, offset_sec), start);
    }

    /// offset=0 (no tick has ever carried a real broker_offset_sec) must
    /// reduce to exactly the old naive-UTC-midnight math -- this is the
    /// "zero behavior change until a real offset is observed" guarantee
    /// broker_day_start's own doc comment makes.
    #[test]
    fn zero_offset_matches_the_old_naive_utc_midnight_behavior() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 30, 45).unwrap();
        assert_eq!(bucket_start(Timeframe::D1, now, 0), Utc.with_ymd_and_hms(2026, 8, 13, 0, 0, 0).unwrap());
    }

    /// A broker DST transition (e.g. UTC+3 -> UTC+2) moves the observed
    /// offset the very next tick that carries it -- there is no stored
    /// "offset as of this historical date," only "the offset the most
    /// recent tick reported," so a tick arriving right after the shift
    /// must immediately bucket at the NEW boundary, not the old one.
    #[test]
    fn a_dst_shift_moves_the_boundary_on_the_very_next_tick() {
        let now = Utc.with_ymd_and_hms(2026, 10, 26, 22, 30, 0).unwrap(); // just after a Sunday DST changeover
        let pre_dst_offset_sec = 3 * 3600; // UTC+3
        let post_dst_offset_sec = 2 * 3600; // UTC+2

        let pre = bucket_start(Timeframe::D1, now, pre_dst_offset_sec);
        let post = bucket_start(Timeframe::D1, now, post_dst_offset_sec);
        assert_ne!(pre, post, "the D1 boundary must move when the observed broker offset changes");
        assert_eq!(post, Utc.with_ymd_and_hms(2026, 10, 26, 22, 0, 0).unwrap());
        assert_eq!(pre, Utc.with_ymd_and_hms(2026, 10, 26, 21, 0, 0).unwrap());
    }

    // ---- broker-day-boundary tests (the H4-duplicate-bar fix, 2026-09-07) ----

    /// Same Pepperstone-shaped UTC+3 broker as the D1 test above. Broker
    /// midnight is 21:00 UTC, so broker-local H4 buckets land at
    /// 21:00/01:00/05:00/09:00/13:00/17:00 UTC -- NOT the naive
    /// 00:00/04:00/08:00/12:00/16:00/20:00 UTC grid the old code produced
    /// (offset by 3h, and 3 doesn't divide 4, so the two grids never
    /// collide -- exactly the reported bug: 12,772 overlapping H4 rows
    /// across 30/30 symbols).
    #[test]
    fn h4_aligns_to_the_broker_day_boundary_for_a_utc_plus_3_broker() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap(); // 11:00 broker-local
        let offset_sec = 3 * 3600;
        let start = bucket_start(Timeframe::H4, now, offset_sec);
        // 11:00 broker-local falls in the broker's [08:00, 12:00) bucket;
        // 08:00 broker-local - 3h = 05:00 UTC.
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 8, 13, 5, 0, 0).unwrap());

        // One minute before the rollover (broker-local 07:59, still in the
        // previous [04:00, 08:00) broker bucket) must still resolve to the
        // PREVIOUS bucket...
        let just_before = Utc.with_ymd_and_hms(2026, 8, 13, 4, 59, 0).unwrap();
        assert_eq!(
            bucket_start(Timeframe::H4, just_before, offset_sec),
            Utc.with_ymd_and_hms(2026, 8, 13, 1, 0, 0).unwrap()
        );
        // ...while a tick AT that exact rollover instant (broker-local
        // 08:00:00) has already rolled into the bucket `start` above
        // resolves to.
        let just_after = Utc.with_ymd_and_hms(2026, 8, 13, 5, 0, 0).unwrap();
        assert_eq!(bucket_start(Timeframe::H4, just_after, offset_sec), start);
    }

    /// The exact production incident, reproduced directly: two ticks one
    /// bucket apart under the OLD (naive, offset-ignoring) math land on
    /// different `bucket_start`s than under the fix, proving the dual-grid
    /// collision this closes -- not just that the new math is internally
    /// consistent, but that it actually disagrees with what production
    /// was doing before.
    #[test]
    fn h4_old_naive_math_and_the_fix_disagree_for_a_non_multiple_of_4_offset() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap();
        let offset_sec = 3 * 3600;
        let naive = Utc.timestamp_millis_opt((now.timestamp_millis() / 14_400_000) * 14_400_000).unwrap();
        let fixed = bucket_start(Timeframe::H4, now, offset_sec);
        assert_ne!(naive, fixed, "a non-multiple-of-4h broker offset must move the H4 boundary");
        assert_eq!(naive, Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap()); // the spurious naive-UTC row
        assert_eq!(fixed, Utc.with_ymd_and_hms(2026, 8, 13, 5, 0, 0).unwrap()); // the broker-authoritative row
    }

    /// offset=0 must reduce to exactly the old naive-UTC math -- same
    /// "zero behavior change until a real offset is observed" guarantee
    /// as D1's own equivalent test.
    #[test]
    fn h4_zero_offset_matches_the_old_naive_utc_behavior() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 37, 45).unwrap();
        assert_eq!(bucket_start(Timeframe::H4, now, 0), Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap());
    }

    /// An offset that IS an exact multiple of 4h (e.g. a UTC+4 or UTC+8
    /// broker) never disagreed with the naive grid in the first place --
    /// confirms the fix doesn't move anything for the brokers who were
    /// never actually affected.
    #[test]
    fn h4_offset_that_is_a_multiple_of_4h_matches_the_naive_grid_too() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 37, 45).unwrap();
        let offset_sec = 4 * 3600;
        assert_eq!(bucket_start(Timeframe::H4, now, offset_sec), Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap());
    }

    /// M1/M5/M30/H1 spot check with the same UTC+3 offset that breaks H4
    /// above -- confirms these are genuinely unaffected (any whole-hour
    /// offset is itself a multiple of each of their periods), not just
    /// "untested."
    #[test]
    fn sub_h4_fixed_timeframes_are_unaffected_by_a_whole_hour_broker_offset() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 10, 37, 45).unwrap();
        let offset_sec = 3 * 3600;
        for tf in [Timeframe::M1, Timeframe::M5, Timeframe::M30, Timeframe::H1] {
            assert_eq!(
                bucket_start(tf, now, offset_sec),
                bucket_start(tf, now, 0),
                "{tf:?} must not move under a whole-hour broker offset"
            );
        }
    }

    /// W1/Mn1 spot checks with a nonzero broker offset -- same broker-day
    /// substitution as D1 (Monday/1st-of-month is defined by the broker's
    /// own local date, not UTC's), just at a coarser calendar grain.
    #[test]
    fn w1_and_mn1_use_the_broker_local_date_with_a_nonzero_offset() {
        // 2026-08-13 08:00 UTC = 2026-08-13 11:00 broker-local (UTC+3) --
        // still Thursday broker-side, so this week's Monday is 2026-08-10,
        // and its broker-midnight is 2026-08-09 21:00 UTC.
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap();
        let offset_sec = 3 * 3600;
        assert_eq!(
            bucket_start(Timeframe::W1, now, offset_sec),
            Utc.with_ymd_and_hms(2026, 8, 9, 21, 0, 0).unwrap()
        );

        // 2026-08-31 22:30 UTC = 2026-09-01 01:30 broker-local (UTC+3) --
        // already September broker-side even though it's still August UTC,
        // so Mn1 must bucket to September's broker-midnight (2026-08-31
        // 21:00 UTC), not August's.
        let near_month_end = Utc.with_ymd_and_hms(2026, 8, 31, 22, 30, 0).unwrap();
        assert_eq!(
            bucket_start(Timeframe::Mn1, near_month_end, offset_sec),
            Utc.with_ymd_and_hms(2026, 8, 31, 21, 0, 0).unwrap()
        );
    }
}
