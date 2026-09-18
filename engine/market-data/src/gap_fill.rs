//! Flat-fill for missing candle buckets — fix/realtime-sync §4. The
//! engine only ever creates a bucket when a tick actually arrives
//! (`candle_updates_for_tick`), so a quiet period (a symbol with no
//! trades, or the engine itself briefly down) leaves a real hole on a
//! categorical time axis. This tracks the last bucket actually written
//! per (symbol, timeframe) and, when a new real tick's bucket has
//! advanced by more than one step, synthesizes flat bars (open = high =
//! low = close = the previous close, matching how every real charting
//! platform represents "no trades this period") for every bucket in
//! between — except across a real market close, where a gap is correct,
//! not missing data.

use crate::{fixed_ms, CandleUpdate, Timeframe};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Timelike, Utc, Weekday};
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Mutex;

// The Nth Sunday of `month` in `year` -- the only date arithmetic
// us_eastern_is_dst below needs, so this crate can compute the real US
// DST transition dates itself without pulling in chrono-tz (a whole IANA
// timezone database) for one rule. Per the actual US law (Energy Policy
// Act of 2005): DST runs from the 2nd Sunday of March to the 1st Sunday
// of November.
fn nth_sunday_of_month(year: i32, month: u32, nth: u32) -> NaiveDate {
    let first = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
    let first_sunday_day = 1 + (7 - first.weekday().num_days_from_sunday()) % 7;
    NaiveDate::from_ymd_opt(year, month, first_sunday_day + (nth - 1) * 7).unwrap()
}

// Whether `t` falls in US Eastern DST (EDT, UTC-4) rather than Standard
// time (EST, UTC-5) -- exact, not approximated, since the whole point is
// the two differ by a real hour and this module gates on that hour. Only
// the DATE matters here (not the 2am-local transition instant): the
// nearest real Friday/Sunday boundary this function is ever evaluated
// against is always at least several days from either transition date,
// so date-level precision is exact for this use, not just close enough.
fn us_eastern_is_dst(t: DateTime<Utc>) -> bool {
    let year = t.year();
    let dst_start = nth_sunday_of_month(year, 3, 2); // 2nd Sunday of March
    let dst_end = nth_sunday_of_month(year, 11, 1); // 1st Sunday of November
    let date = t.date_naive();
    date >= dst_start && date < dst_end
}

// Standard global FX weekend close, the same window every major venue
// observes regardless of broker -- deliberately NOT Broker.tradingHaltedAt
// or the per-BrokerSymbol TradingSession config (app/api/manage/symbols'
// own trading-hours feature): those are a broker's own business-rule
// restriction layered on top of whether the underlying market is even
// open, and this crate's ticks are broker-agnostic raw market data (see
// ingest.rs's own module doc) with no broker context to read that config
// against anyway. A gap here means "the real market was shut," not
// "this particular broker chose not to allow trading."
//
// hotfix/terminal-live-bugs round 2 -- production still had flat bars
// across a real Sat/Sun close (08-29 -> 08-30), so whatever built this
// exclusion never actually reached the Contabo binary (see the round-2
// deploy notes: this needs a real `cargo build --release -p server` +
// service restart, not just a git pull). The boundary is NY 17:00; in UTC
// that is 22:00 in winter/EST (UTC-5) and 21:00 in summer/EDT (UTC-4) --
// see ny_close_hour_utc below, which computes it from us_eastern_is_dst so
// it is correct in both seasons and both callers (this module's synthetic
// fill AND ingest.rs's real-tick gate agree with the calendar, not a
// hand-picked constant).
//
// 2026-09-17 fix -- the DST direction here had been INVERTED (summer
// mapped to 22:00, winter to 21:00, the opposite of the real UTC offsets),
// an hour wrong every week in both seasons; corrected in ny_close_hour_utc,
// with the tests re-pinned to the real forex close (Fri 5pm ET = 22:00 UTC
// EST / 21:00 UTC EDT).
// UTC hour of 17:00 America/New_York on date `t` -- the anchor shared by
// the FX weekly close/reopen AND the daily metals settlement break. EDT
// (summer) is UTC-4 so 17:00 -> 21:00 UTC; EST (winter) is UTC-5 so
// 17:00 -> 22:00 UTC. (Confirmed against the industry-standard forex close:
// Friday 5pm ET = 22:00 UTC in EST / 21:00 UTC in EDT.)
//
// 2026-09-17 fix -- this was inverted (`if dst { 22 } else { 21 }`), which
// mapped summer to 22:00 and winter to 21:00, an hour wrong in BOTH
// seasons: it manufactured an extra closed-hour candle on one side of the
// weekend and dropped a real trading hour on the other, every week. The
// matching tests encoded the same inversion and so passed while wrong.
fn ny_close_hour_utc(t: DateTime<Utc>) -> u32 {
    if us_eastern_is_dst(t) {
        21
    } else {
        22
    }
}

fn market_closed(t: DateTime<Utc>) -> bool {
    // Both the Friday close and the Sunday reopen are the same NY-17:00
    // anchor, one week apart, so both move together with DST.
    let close_hour = ny_close_hour_utc(t);
    match t.weekday() {
        Weekday::Sat => true,
        Weekday::Fri => t.hour() >= close_hour,
        Weekday::Sun => t.hour() < close_hour,
        _ => false,
    }
}

// Instruments that take a ~1-hour daily settlement break at 17:00 New York
// (metals: gold/silver/platinum/palladium), unlike spot FX which is
// continuous 24/5. Static match, same "no per-symbol session lookup in
// this crate yet" constraint as is_continuously_traded -- keep in sync
// until the real TradingSession-config lookup lands (Phase 3). Indices can
// be added here once listed.
fn has_daily_break(symbol: &str) -> bool {
    matches!(symbol, "XAUUSD" | "XAGUSD" | "XPTUSD" | "XPDUSD")
}

// The daily settlement break window for has_daily_break symbols: 17:00 ->
// 18:00 New York, i.e. the single UTC hour beginning at the same NY-17:00
// anchor the weekend close uses (so it tracks DST identically). Weekdays
// Mon-Thu only -- Friday 17:00 onward and the whole weekend are already
// closed by market_closed. Without this, the nightly gold break was
// flat-filled (and stale heartbeat resends written) as real candles --
// exactly the "candles during a market-closed period" symptom on XAUUSD.
fn in_daily_break(t: DateTime<Utc>) -> bool {
    let break_hour = ny_close_hour_utc(t);
    matches!(
        t.weekday(),
        Weekday::Mon | Weekday::Tue | Weekday::Wed | Weekday::Thu
    ) && t.hour() == break_hour
}

// hotfix/terminal-live-bugs round 2 -- market_closed() above is a FX/
// metals weekend rule; applying it unconditionally to every symbol was
// itself wrong for the handful of crypto pairs this platform lists,
// which trade continuously and have no weekend close at all. This crate
// has no live per-symbol category/session lookup (see the module doc
// above), so this is a static allowlist -- keep it in sync if a new
// crypto symbol is ever added.
//
// 2026-09-06 fix: this list had drifted -- SOLUSD and XRPUSD were added
// to the real Symbol.category = CRYPTO catalog (lib/risk.ts's own
// isContinuouslyTraded on the Next.js side had the identical bug, fixed
// in the same commit, live-confirmed against Futurix Global) without
// this one being updated, so this crate's own candle history would have
// started flat-filling real gaps across their weekends the moment either
// symbol's ticks reached it. Needs a real `cargo build --release -p
// market-data` (or whichever binary embeds this crate) + Contabo
// service restart to take effect -- a git pull alone does not update the
// running binary, per this file's own round-2 deploy note above. A real
// fix is the same TradingSession-config lookup noted above, scoped per
// symbol instead of a hardcoded list -- Phase 3 scope, not this patch.
fn is_continuously_traded(symbol: &str) -> bool {
    matches!(symbol, "BTCUSD" | "ETHUSD" | "SOLUSD" | "XRPUSD")
}

// The one place "is this symbol's market open at this instant" gets
// decided -- both call sites below (the synthetic gap-fill paths) and
// ingest.rs's real-tick write path (the ACTUAL source of weekend flat
// candles, not this module -- a stale MT5 heartbeat resend of Friday's
// last price arriving during the weekend was written as a completely
// real, ungated Candle row; only the synthetic fill below was ever
// gated) now share this single function instead of each repeating
// `is_continuously_traded(..) || !market_closed(..)` -- exactly the kind
// of duplicated rule that already drifted once (is_continuously_traded's
// own comment, the SOLUSD/XRPUSD catalog gap). `pub(crate)` since
// ingest.rs needs it too; market_closed/is_continuously_traded themselves
// stay private -- this is the one function anything outside this module
// should ever call.
pub(crate) fn market_open(symbol: &str, t: DateTime<Utc>) -> bool {
    if is_continuously_traded(symbol) {
        return true;
    }
    if market_closed(t) {
        return false;
    }
    // An otherwise-open weekday minute is still closed if this instrument
    // is in its daily settlement break (metals). Spot FX has no break and
    // is unaffected.
    !(has_daily_break(symbol) && in_daily_break(t))
}

// Caps how many flat-fill bars a single tick can generate -- protects
// against a pathological gap (the engine down for days, or a stale
// tracker entry) turning one flush cycle into tens of thousands of
// inserts. A gap this large is exactly what the EA's own 15-minute
// CopyRates backfill (mt5-ea/VyXTraderPriceFeed.mq5) exists to repair
// with real data anyway -- this cap just bounds the live path's own
// worst case, not the eventual correctness of the history.
const MAX_GAP_FILLS_PER_TICK: usize = 500;

struct LastBucket {
    start: DateTime<Utc>,
    close: Decimal,
}

pub struct GapFillTracker {
    last: Mutex<HashMap<(String, Timeframe), LastBucket>>,
}

impl GapFillTracker {
    pub fn new() -> Self {
        Self { last: Mutex::new(HashMap::new()) }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, HashMap<(String, Timeframe), LastBucket>> {
        match self.last.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// fix/candle-gaps §3 -- seed the tracker's last-known bucket per
    /// (symbol, timeframe) from an explicit list (the DB rows, in
    /// `seed_from_db`, or test fixtures). Only the fixed-duration
    /// timeframes this tracker actually gap-fills are kept. Returns how
    /// many baselines were installed.
    pub fn seed(&self, entries: &[(String, Timeframe, DateTime<Utc>, Decimal)]) -> usize {
        let mut guard = self.guard();
        let mut n = 0;
        for (symbol, tf, start, close) in entries {
            if fixed_ms(*tf).is_none() {
                continue;
            }
            guard.insert((symbol.clone(), *tf), LastBucket { start: *start, close: *close });
            n += 1;
        }
        n
    }

    /// fix/candle-gaps §3 -- boot-time seed from the reader store, so the
    /// FIRST tick after a restart flat-fills the whole downtime gap
    /// instead of starting from an empty map (which produced no fills at
    /// all -- the bug that left the restart hole on the chart). Fail-soft
    /// at the caller: a DB error here just means the pre-fix empty-tracker
    /// behavior for this boot, never a failure to start the feed.
    pub async fn seed_from_db(&self, pool: &PgPool) -> Result<usize, sqlx::Error> {
        let rows = crate::db::fetch_last_buckets(pool).await?;
        let entries: Vec<(String, Timeframe, DateTime<Utc>, Decimal)> = rows
            .into_iter()
            .filter_map(|r| crate::timeframe_from_str(&r.timeframe).map(|tf| (r.symbol, tf, r.bucket_start, r.close)))
            .collect();
        Ok(self.seed(&entries))
    }

    /// PURE (fix/candle-gaps §1). The synthetic flat-fill bars for every
    /// market-open bucket skipped since the last one recorded for this
    /// exact (symbol, timeframe) -- WITHOUT advancing the tracker. The
    /// advance is now a separate, commit-gated step (`record_committed`),
    /// so a flush whose DB write fails leaves the pointer where it was and
    /// the very next flush re-derives (and re-fills) the same buckets
    /// rather than silently skipping past a bucket that never persisted
    /// (the exact defect that lost a bucket on every Postgres stall).
    /// Empty on the first tick ever for a pair (no baseline) or a
    /// non-fixed timeframe (W1/Mn1/Y1).
    pub fn fills_for(&self, update: &CandleUpdate) -> Vec<CandleUpdate> {
        let mut fills = Vec::new();
        let Some(step_ms) = fixed_ms(update.timeframe) else {
            return fills;
        };
        let guard = self.guard();
        let key = (update.symbol.clone(), update.timeframe);
        if let Some(prev) = guard.get(&key) {
            let mut cursor = prev.start + Duration::milliseconds(step_ms);
            let carry_close = prev.close;
            let mut count = 0usize;
            while cursor < update.bucket_start && count < MAX_GAP_FILLS_PER_TICK {
                if market_open(&update.symbol, cursor) {
                    fills.push(CandleUpdate {
                        symbol: update.symbol.clone(),
                        timeframe: update.timeframe,
                        bucket_start: cursor,
                        open: carry_close,
                        high: carry_close,
                        low: carry_close,
                        close: carry_close,
                        open_authoritative: false,
                    });
                }
                cursor += Duration::milliseconds(step_ms);
                count += 1;
            }
        }
        fills
    }

    /// fix/candle-gaps §1 -- advance the last-durably-stored pointer to the
    /// greatest bucket per (symbol, timeframe) in a batch the DB has just
    /// CONFIRMED committed. Monotonic (only ever moves a pointer forward),
    /// so the concurrent flush and sweep tasks -- which each read a
    /// lock-consistent baseline, write, then call this -- can never make
    /// the tracker regress; whichever commits the later bucket wins and the
    /// other's overlapping rows were idempotent upserts. `committed` is
    /// expected already de-duplicated by bucket (ingest::merge_dedup).
    pub fn record_committed(&self, committed: &[CandleUpdate]) {
        if committed.is_empty() {
            return;
        }
        let mut guard = self.guard();
        let mut maxes: HashMap<(String, Timeframe), (DateTime<Utc>, Decimal)> = HashMap::new();
        for u in committed {
            if fixed_ms(u.timeframe).is_none() {
                continue;
            }
            let k = (u.symbol.clone(), u.timeframe);
            match maxes.get(&k) {
                Some((s, _)) if *s >= u.bucket_start => {}
                _ => {
                    maxes.insert(k, (u.bucket_start, u.close));
                }
            }
        }
        for ((symbol, tf), (start, close)) in maxes {
            advance_one(&mut guard, symbol, tf, start, close);
        }
    }

    /// Test / convenience wrapper preserving the original atomic
    /// compute-and-record semantics (this module's own unit tests, and any
    /// caller not gating the advance on a DB commit). The production flush
    /// path (ingest::flush_candles) uses the `fills_for` + `record_committed`
    /// split so the advance is commit-gated.
    pub fn fill_gaps_and_record(&self, update: &CandleUpdate) -> Vec<CandleUpdate> {
        let fills = self.fills_for(update);
        let mut committed = fills.clone();
        committed.push(update.clone());
        self.record_committed(&committed);
        fills
    }

    /// PURE (fix/candle-gaps §1) -- the timer-driven counterpart to
    /// `fills_for`: the flat-fills for every fully-closed bucket strictly
    /// before `now`'s own bucket, for every tracked (symbol, timeframe),
    /// PLUS the per-key advance target each implies, WITHOUT mutating.
    /// Same "does not claim the currently-open bucket" rule as before -- a
    /// real tick landing in it a moment later must still own it. The
    /// caller writes the fills and, only on a confirmed commit, calls
    /// `apply_advances(&plan.advances)`, so a failed sweep write leaves the
    /// pointers put and the next sweep retries the same buckets (the old
    /// sweep advanced FIRST, which is exactly why a dropped sweep write
    /// left a permanent hole).
    pub fn plan_sweep(&self, now: DateTime<Utc>, broker_offset_sec: i64) -> SweepPlan {
        let mut fills = Vec::new();
        let mut advances = Vec::new();
        let guard = self.guard();
        for ((symbol, timeframe), last) in guard.iter() {
            let Some(step_ms) = fixed_ms(*timeframe) else {
                continue;
            };
            let now_bucket = crate::bucket_start(*timeframe, now, broker_offset_sec);
            let step = Duration::milliseconds(step_ms);
            let mut cursor = last.start + step;
            let carry_close = last.close;
            let mut count = 0usize;
            let mut advanced_to = last.start;
            while cursor < now_bucket && count < MAX_GAP_FILLS_PER_TICK {
                if market_open(symbol, cursor) {
                    fills.push(CandleUpdate {
                        symbol: symbol.clone(),
                        timeframe: *timeframe,
                        bucket_start: cursor,
                        open: carry_close,
                        high: carry_close,
                        low: carry_close,
                        close: carry_close,
                        open_authoritative: false,
                    });
                }
                advanced_to = cursor;
                cursor += step;
                count += 1;
            }
            if advanced_to > last.start {
                advances.push((symbol.clone(), *timeframe, advanced_to, carry_close));
            }
        }
        SweepPlan { fills, advances }
    }

    /// fix/candle-gaps §1 -- commits the advances a `plan_sweep` implied,
    /// monotonically, only after that sweep's own DB write is confirmed.
    /// Close stays the carry close (nothing real happened across a swept
    /// region).
    pub fn apply_advances(&self, advances: &[(String, Timeframe, DateTime<Utc>, Decimal)]) {
        if advances.is_empty() {
            return;
        }
        let mut guard = self.guard();
        for (symbol, tf, start, close) in advances {
            advance_one(&mut guard, symbol.clone(), *tf, *start, *close);
        }
    }

    /// Test / convenience wrapper preserving the original atomic
    /// compute-and-advance sweep semantics for this module's own unit
    /// tests. Production (ingest::spawn_gap_sweep) uses plan_sweep +
    /// apply_advances so the advance is commit-gated.
    pub fn sweep_stale_buckets(&self, now: DateTime<Utc>, broker_offset_sec: i64) -> Vec<CandleUpdate> {
        let plan = self.plan_sweep(now, broker_offset_sec);
        self.apply_advances(&plan.advances);
        plan.fills
    }
}

/// The output of `GapFillTracker::plan_sweep`: the flat-fill bars to write
/// and, separately, the per-(symbol, timeframe) pointer advances to commit
/// only once those writes are confirmed (fix/candle-gaps §1).
pub struct SweepPlan {
    pub fills: Vec<CandleUpdate>,
    pub advances: Vec<(String, Timeframe, DateTime<Utc>, Decimal)>,
}

/// Monotonic per-key advance shared by `record_committed` and
/// `apply_advances`: never moves a pointer backward (so concurrent flush /
/// sweep commits can't make the tracker regress); on the same bucket it
/// only refreshes the carry close (a later flush of a still-open bucket
/// carries a newer close). Non-fixed timeframes are never tracked.
fn advance_one(guard: &mut HashMap<(String, Timeframe), LastBucket>, symbol: String, tf: Timeframe, start: DateTime<Utc>, close: Decimal) {
    if fixed_ms(tf).is_none() {
        return;
    }
    match guard.get_mut(&(symbol.clone(), tf)) {
        Some(cur) if start > cur.start => {
            cur.start = start;
            cur.close = close;
        }
        Some(cur) if start == cur.start => {
            cur.close = close;
        }
        Some(_) => {}
        None => {
            guard.insert((symbol, tf), LastBucket { start, close });
        }
    }
}

impl Default for GapFillTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rust_decimal_macros::dec;

    fn update(symbol: &str, tf: Timeframe, bucket_start: DateTime<Utc>, close: Decimal) -> CandleUpdate {
        CandleUpdate { symbol: symbol.to_string(), timeframe: tf, bucket_start, open: close, high: close, low: close, close, open_authoritative: false }
    }

    #[test]
    fn january_1_is_never_dst() {
        // Deep winter, any year -- nowhere near either transition date, no
        // boundary ambiguity to get wrong.
        assert!(!us_eastern_is_dst(Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap()));
        assert!(!us_eastern_is_dst(Utc.with_ymd_and_hms(2027, 1, 1, 12, 0, 0).unwrap()));
    }

    #[test]
    fn july_1_is_always_dst() {
        // Deep summer, any year -- same reasoning as january_1 above.
        assert!(us_eastern_is_dst(Utc.with_ymd_and_hms(2026, 7, 1, 12, 0, 0).unwrap()));
        assert!(us_eastern_is_dst(Utc.with_ymd_and_hms(2027, 7, 1, 12, 0, 0).unwrap()));
    }

    #[test]
    fn dst_start_is_the_second_sunday_of_march() {
        let start = nth_sunday_of_month(2026, 3, 2);
        assert_eq!(start.weekday(), Weekday::Sun);
        // The Sunday immediately before it is a different Sunday, 7 days
        // earlier, and must NOT itself be the 2nd Sunday.
        assert_eq!(start - chrono::Duration::days(7), nth_sunday_of_month(2026, 3, 1));
        assert!(!us_eastern_is_dst(start.and_hms_opt(6, 0, 0).unwrap().and_utc() - Duration::days(1)));
        assert!(us_eastern_is_dst(start.and_hms_opt(6, 0, 0).unwrap().and_utc()));
    }

    #[test]
    fn dst_end_is_the_first_sunday_of_november() {
        let end = nth_sunday_of_month(2026, 11, 1);
        assert_eq!(end.weekday(), Weekday::Sun);
        assert!(us_eastern_is_dst(end.and_hms_opt(6, 0, 0).unwrap().and_utc() - Duration::days(1)));
        assert!(!us_eastern_is_dst(end.and_hms_opt(6, 0, 0).unwrap().and_utc()));
    }

    #[test]
    fn sunday_reopen_boundary_shifts_with_dst_the_same_way_friday_close_does() {
        // Winter/EST: NY 17:00 = 22:00 UTC, so the weekly reopen is 22:00 UTC.
        // Sun 21:00 stays closed and Sun 22:00 is the first open bucket.
        let tracker = GapFillTracker::new();
        let sat_2000 = Utc.with_ymd_and_hms(2026, 1, 17, 20, 0, 0).unwrap(); // Saturday
        let mon_0000 = Utc.with_ymd_and_hms(2026, 1, 19, 0, 0, 0).unwrap(); // Monday
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, sat_2000, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, mon_0000, dec!(1.1)));
        let fill_starts: Vec<DateTime<Utc>> = fills.iter().map(|f| f.bucket_start).collect();
        assert!(fill_starts.contains(&Utc.with_ymd_and_hms(2026, 1, 18, 22, 0, 0).unwrap()), "Sun 22:00 UTC should be open in winter/EST, got: {:?}", fill_starts);
        assert!(!fill_starts.contains(&Utc.with_ymd_and_hms(2026, 1, 18, 21, 0, 0).unwrap()), "Sun 21:00 UTC should still be closed in winter/EST, got: {:?}", fill_starts);
    }

    #[test]
    fn first_tick_ever_for_a_pair_produces_no_fills() {
        let tracker = GapFillTracker::new();
        let now = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap(); // Wednesday
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, now, dec!(1.1)));
        assert!(fills.is_empty());
    }

    #[test]
    fn consecutive_buckets_produce_no_fills() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        let t1 = t0 + Duration::minutes(1);
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t1, dec!(1.2)));
        assert!(fills.is_empty());
    }

    #[test]
    fn a_quiet_period_mid_week_fills_every_skipped_minute_flat() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap(); // Wednesday
        let t3 = t0 + Duration::minutes(3);
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1000)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t3, dec!(1.1050)));

        assert_eq!(fills.len(), 2);
        assert_eq!(fills[0].bucket_start, t0 + Duration::minutes(1));
        assert_eq!(fills[1].bucket_start, t0 + Duration::minutes(2));
        for f in &fills {
            assert_eq!(f.open, dec!(1.1000));
            assert_eq!(f.high, dec!(1.1000));
            assert_eq!(f.low, dec!(1.1000));
            assert_eq!(f.close, dec!(1.1000));
        }
    }

    #[test]
    fn the_weekend_is_never_flat_filled() {
        let tracker = GapFillTracker::new();
        // Friday 21:00 UTC -> Monday 01:00 UTC, H1, in summer/EDT: real FX
        // close is NY 17:00 = 21:00 UTC, so Fri 21:00 through the weekend is
        // shut and the market reopens Sunday 21:00 UTC -- Sun 21:00 / 22:00 /
        // 23:00 / Mon 00:00 are the real fills, nothing during the weekend.
        let fri = Utc.with_ymd_and_hms(2026, 8, 14, 21, 0, 0).unwrap(); // Friday
        let mon = Utc.with_ymd_and_hms(2026, 8, 17, 1, 0, 0).unwrap(); // Monday
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, fri, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, mon, dec!(1.2)));

        for f in &fills {
            assert!(!market_closed(f.bucket_start), "produced a fill during market close: {:?}", f.bucket_start);
        }
        let fill_starts: Vec<DateTime<Utc>> = fills.iter().map(|f| f.bucket_start).collect();
        assert_eq!(
            fill_starts,
            vec![
                Utc.with_ymd_and_hms(2026, 8, 16, 21, 0, 0).unwrap(), // Sunday 21:00 -- summer/EDT reopen
                Utc.with_ymd_and_hms(2026, 8, 16, 22, 0, 0).unwrap(),
                Utc.with_ymd_and_hms(2026, 8, 16, 23, 0, 0).unwrap(),
                Utc.with_ymd_and_hms(2026, 8, 17, 0, 0, 0).unwrap(),
            ]
        );
    }

    // Pins BOTH seasons of the Friday close boundary to the real forex
    // close (NY 17:00): 22:00 UTC in EST/winter, 21:00 UTC in EDT/summer.
    // So the 21:00-22:00 UTC hour is STILL OPEN in winter (close is an hour
    // later, at 22:00) and ALREADY CLOSED in summer (21:00 is the close).
    // 2026-09-17: these two tests previously asserted the inverted seasons
    // (matching the inverted close_hour) and so passed while wrong.
    #[test]
    fn friday_21_to_22_utc_is_still_open_in_winter_est() {
        // 2026-01-16 -- January/EST -- real close is NY 17:00 = 22:00 UTC, so
        // the 21:00 bucket is still a live trading hour and must be filled.
        let tracker = GapFillTracker::new();
        let fri_2000 = Utc.with_ymd_and_hms(2026, 1, 16, 20, 0, 0).unwrap();
        let fri_2200 = Utc.with_ymd_and_hms(2026, 1, 16, 22, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, fri_2000, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, fri_2200, dec!(1.1)));
        assert_eq!(fills.len(), 1, "Fri 21:00 UTC in EST/winter is real market-open time, should be filled, got: {:?}", fills);
        assert_eq!(fills[0].bucket_start, Utc.with_ymd_and_hms(2026, 1, 16, 21, 0, 0).unwrap());
    }

    #[test]
    fn friday_21_to_22_utc_is_closed_in_summer_edt() {
        // 2026-08-14 -- August/EDT -- real close is NY 17:00 = 21:00 UTC, so
        // the 21:00 bucket is already the weekend close and must be excluded.
        let tracker = GapFillTracker::new();
        let fri_2000 = Utc.with_ymd_and_hms(2026, 8, 14, 20, 0, 0).unwrap();
        let fri_2200 = Utc.with_ymd_and_hms(2026, 8, 14, 22, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, fri_2000, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, fri_2200, dec!(1.1)));
        assert!(fills.is_empty(), "Fri 21:00 UTC in EDT/summer is the weekend close, should be excluded, got: {:?}", fills);
    }

    #[test]
    fn metals_daily_break_is_excluded_for_xau_but_not_fx() {
        // Gold takes a ~1h daily settlement break at 17:00 New York -- 22:00
        // UTC in winter/EST, 21:00 UTC in summer/EDT. XAUUSD must NOT flat-
        // fill (or write) that hour; spot FX (EURUSD) has no break.
        let wed_2200_winter = Utc.with_ymd_and_hms(2026, 1, 14, 22, 0, 0).unwrap(); // Wed, EST
        assert!(!market_open("XAUUSD", wed_2200_winter), "XAU should be in its daily break at 22:00 UTC winter");
        assert!(market_open("EURUSD", wed_2200_winter), "EURUSD has no daily break and stays open (winter)");
        let wed_2100_summer = Utc.with_ymd_and_hms(2026, 8, 12, 21, 0, 0).unwrap(); // Wed, EDT
        assert!(!market_open("XAUUSD", wed_2100_summer), "XAU should be in its daily break at 21:00 UTC summer");
        assert!(market_open("EURUSD", wed_2100_summer), "EURUSD has no daily break and stays open (summer)");

        // and the synthetic flat-fill path skips the XAU break bucket
        let tracker = GapFillTracker::new();
        let wed_2100 = Utc.with_ymd_and_hms(2026, 1, 14, 21, 0, 0).unwrap();
        let wed_2300 = Utc.with_ymd_and_hms(2026, 1, 14, 23, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("XAUUSD", Timeframe::H1, wed_2100, dec!(2000)));
        let fills = tracker.fill_gaps_and_record(&update("XAUUSD", Timeframe::H1, wed_2300, dec!(2000)));
        let starts: Vec<DateTime<Utc>> = fills.iter().map(|f| f.bucket_start).collect();
        assert!(!starts.contains(&wed_2200_winter), "XAU daily break 22:00 UTC (winter) should be excluded, got: {:?}", starts);
    }

    #[test]
    fn crypto_symbols_are_never_weekend_excluded() {
        // BTCUSD/ETHUSD trade continuously -- applying the FX/metals
        // weekend rule to them would flat-fill right past a real gap in
        // their own history instead of leaving it as a genuine hole, the
        // opposite of what this module exists to prevent.
        let tracker = GapFillTracker::new();
        let fri = Utc.with_ymd_and_hms(2026, 8, 14, 21, 0, 0).unwrap();
        let mon = Utc.with_ymd_and_hms(2026, 8, 17, 1, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("BTCUSD", Timeframe::H1, fri, dec!(62000)));
        let fills = tracker.fill_gaps_and_record(&update("BTCUSD", Timeframe::H1, mon, dec!(63000)));

        // Every hour strictly between fri and mon gets filled -- none
        // excluded for being "weekend," unlike EURUSD's equivalent test.
        let expected_count = ((mon - fri).num_hours() - 1) as usize;
        assert_eq!(fills.len(), expected_count);
        assert!(fills.iter().any(|f| f.bucket_start.weekday() == Weekday::Sat));
    }

    #[test]
    fn market_open_is_false_for_a_non_crypto_symbol_during_the_weekend() {
        // The shared decision ingest.rs's real-tick write path now gates
        // on too -- a stale MT5 heartbeat resend during Saturday must not
        // read as "market open" for an FX/metals symbol.
        let saturday = Utc.with_ymd_and_hms(2026, 8, 15, 12, 0, 0).unwrap();
        assert!(!market_open("EURUSD", saturday));
    }

    #[test]
    fn market_open_is_true_for_a_continuously_traded_symbol_during_the_weekend() {
        let saturday = Utc.with_ymd_and_hms(2026, 8, 15, 12, 0, 0).unwrap();
        assert!(market_open("BTCUSD", saturday));
    }

    #[test]
    fn market_open_is_true_for_a_non_crypto_symbol_on_a_weekday() {
        let wednesday = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        assert!(market_open("EURUSD", wednesday));
    }

    #[test]
    fn is_continuously_traded_covers_the_full_current_crypto_catalog() {
        // 2026-09-06 regression test: this list drifted once already
        // (SOLUSD/XRPUSD added to the real catalog without this crate's
        // copy being updated) -- pins all four current crypto symbols,
        // plus a non-crypto control, so the next drift fails loudly here
        // instead of silently flat-filling a real symbol's weekend gaps.
        assert!(is_continuously_traded("BTCUSD"));
        assert!(is_continuously_traded("ETHUSD"));
        assert!(is_continuously_traded("SOLUSD"));
        assert!(is_continuously_traded("XRPUSD"));
        assert!(!is_continuously_traded("XAUUSD"));
    }

    #[test]
    fn different_symbols_and_timeframes_are_tracked_independently() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1)));
        // A different symbol's first-ever tick, even at a bucket far past
        // EURUSD's, must not be treated as a gap for EURUSD.
        let fills = tracker.fill_gaps_and_record(&update("GBPUSD", Timeframe::M1, t0 + Duration::minutes(10), dec!(1.3)));
        assert!(fills.is_empty());
    }

    #[test]
    fn non_fixed_duration_timeframes_are_never_gap_filled() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 3, 0, 0, 0).unwrap();
        let t0_plus_5_weeks = t0 + Duration::weeks(5);
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::W1, t0, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::W1, t0_plus_5_weeks, dec!(1.2)));
        assert!(fills.is_empty());
    }

    #[test]
    fn a_pathological_gap_is_capped_rather_than_generating_unbounded_rows() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 0, 0, 0).unwrap(); // Wednesday
        let far_future = t0 + Duration::days(30); // ~43,200 minutes for M1
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1)));
        let fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, far_future, dec!(1.2)));
        assert!(fills.len() <= MAX_GAP_FILLS_PER_TICK);
    }

    // round 5 -- "flat-fill written promptly, not lazily": these cover
    // sweep_stale_buckets, the timer-driven counterpart to
    // fill_gaps_and_record that doesn't wait for the next real tick.

    #[test]
    fn sweep_fills_every_closed_bucket_strictly_before_now_but_leaves_the_current_one_open() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap(); // Wednesday
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1000)));

        // 3.5 minutes later: buckets 10:01 and 10:02 are fully closed and
        // fillable; 10:03 (the bucket containing `now`) must NOT be
        // claimed -- a real tick landing in it moments later still owns it.
        let now = t0 + Duration::seconds(210);
        let fills = tracker.sweep_stale_buckets(now, 0);

        assert_eq!(fills.len(), 2);
        assert_eq!(fills[0].bucket_start, t0 + Duration::minutes(1));
        assert_eq!(fills[1].bucket_start, t0 + Duration::minutes(2));
        for f in &fills {
            assert_eq!(f.close, dec!(1.1000));
        }
    }

    #[test]
    fn a_real_tick_landing_in_the_bucket_the_sweep_left_open_is_not_treated_as_a_gap() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1000)));

        let now = t0 + Duration::seconds(150); // mid-way through the 10:02 bucket
        let sweep_fills = tracker.sweep_stale_buckets(now, 0);
        assert_eq!(sweep_fills.len(), 1); // just 10:01
        assert_eq!(sweep_fills[0].bucket_start, t0 + Duration::minutes(1));

        // A real tick lands later within that same still-open 10:02 bucket
        // -- candle_updates_for_tick always hands fill_gaps_and_record an
        // already-floored bucket_start (10:02:00), never the raw tick
        // timestamp (10:02:50), so the test must too.
        let real_tick_bucket = t0 + Duration::minutes(2);
        let real_fills = tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, real_tick_bucket, dec!(1.1050)));
        assert!(real_fills.is_empty(), "the sweep already advanced past 10:01 -- the real tick's own bucket (10:02) is not a gap");
    }

    #[test]
    fn sweep_produces_nothing_when_no_bucket_has_fully_closed_since_the_last_real_tick() {
        let tracker = GapFillTracker::new();
        let t0 = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::M1, t0, dec!(1.1)));
        let now = t0 + Duration::seconds(30); // still inside the same M1 bucket
        assert!(tracker.sweep_stale_buckets(now, 0).is_empty());
    }

    #[test]
    fn sweep_never_fabricates_a_bar_during_a_real_weekend_close() {
        let tracker = GapFillTracker::new();
        let fri = Utc.with_ymd_and_hms(2026, 8, 14, 20, 58, 0).unwrap(); // Friday, just before close
        tracker.fill_gaps_and_record(&update("EURUSD", Timeframe::H1, fri, dec!(1.1)));
        let mon = Utc.with_ymd_and_hms(2026, 8, 17, 1, 0, 0).unwrap();
        let fills = tracker.sweep_stale_buckets(mon, 0);
        for f in &fills {
            assert!(!market_closed(f.bucket_start), "sweep produced a fill during market close: {:?}", f.bucket_start);
        }
    }

    #[test]
    fn sweep_ignores_pairs_it_has_never_seen_a_real_tick_for() {
        let tracker = GapFillTracker::new();
        // Nothing recorded at all -- sweeping must not panic or fabricate
        // history for a symbol/timeframe with no baseline.
        let fills = tracker.sweep_stale_buckets(Utc::now(), 0);
        assert!(fills.is_empty());
    }

    // fix/candle-gaps §1 -- the commit-gated split. These prove the exact
    // property the old side-effecting fill_gaps_and_record broke: a flush
    // whose DB write fails must NOT advance the pointer, so the missed
    // bucket comes back on the next flush instead of being skipped forever.

    #[test]
    fn a_failed_flush_does_not_advance_the_pointer_so_the_next_flush_refills_the_missed_bucket() {
        let t = GapFillTracker::new();
        let base = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap(); // Wednesday
        // Cycle A: 10:00 commits -- the baseline.
        t.record_committed(&[update("XAUUSD", Timeframe::M1, base, dec!(2400))]);
        // Cycle B: a real 10:01 tick. fills_for is computed (empty -- 10:01
        // is adjacent to 10:00) but its write FAILS, so record_committed is
        // deliberately NOT called. The pointer must stay at 10:00.
        let _b = t.fills_for(&update("XAUUSD", Timeframe::M1, base + Duration::minutes(1), dec!(2401)));
        // Cycle C at 10:02, after the minute rolled over and 10:01 never
        // persisted: the pointer is still 10:00, so 10:01 is re-derived.
        let c = t.fills_for(&update("XAUUSD", Timeframe::M1, base + Duration::minutes(2), dec!(2402)));
        assert_eq!(c.len(), 1, "the un-committed 10:01 bucket must be re-filled, not skipped");
        assert_eq!(c[0].bucket_start, base + Duration::minutes(1));
    }

    #[test]
    fn record_committed_is_monotonic_and_never_regresses_the_pointer() {
        let t = GapFillTracker::new();
        let base = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        t.record_committed(&[update("XAUUSD", Timeframe::M1, base + Duration::minutes(5), dec!(2405))]);
        // A late/stale commit for an earlier bucket (e.g. a slow sweep that
        // planned from an old baseline) must not move the pointer back.
        t.record_committed(&[update("XAUUSD", Timeframe::M1, base + Duration::minutes(2), dec!(2402))]);
        let fills = t.fills_for(&update("XAUUSD", Timeframe::M1, base + Duration::minutes(8), dec!(2408)));
        assert_eq!(fills.len(), 2, "must fill from 10:05 (the max committed), not the stale 10:02");
        assert_eq!(fills[0].bucket_start, base + Duration::minutes(6));
    }

    #[test]
    fn a_seeded_tracker_flat_fills_the_restart_gap_on_the_first_tick() {
        // fix/candle-gaps §3 -- after a restart the tracker is seeded from
        // the DB's last bucket; the first tick well after the downtime must
        // flat-fill every market-open bucket in between rather than produce
        // nothing (the empty-tracker behavior that left the restart hole).
        let t = GapFillTracker::new();
        let last_before_restart = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap(); // Wednesday
        assert_eq!(t.seed(&[("XAUUSD".to_string(), Timeframe::M1, last_before_restart, dec!(2400))]), 1);
        let first = update("XAUUSD", Timeframe::M1, last_before_restart + Duration::minutes(4), dec!(2405));
        let fills = t.fills_for(&first);
        assert_eq!(fills.len(), 3, "10:01 / 10:02 / 10:03 must be flat-filled across the restart gap");
        assert_eq!(fills[0].bucket_start, last_before_restart + Duration::minutes(1));
        for f in &fills {
            assert_eq!(f.close, dec!(2400), "the restart gap carries the last pre-restart close");
        }
    }

    #[test]
    fn plan_sweep_does_not_mutate_until_apply_advances_is_called() {
        // The pure/commit split for the sweep path: planning twice from the
        // same baseline yields the same fills (nothing advanced); only
        // apply_advances moves the pointer.
        let t = GapFillTracker::new();
        let base = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        t.record_committed(&[update("XAUUSD", Timeframe::M1, base, dec!(2400))]);
        let now = base + Duration::seconds(210); // 10:03:30 -- 10:01/10:02 closed
        let plan_a = t.plan_sweep(now, 0);
        let plan_b = t.plan_sweep(now, 0);
        assert_eq!(plan_a.fills.len(), 2);
        assert_eq!(plan_b.fills.len(), 2, "plan_sweep must not advance the pointer -- a failed sweep write retries the same buckets");
        t.apply_advances(&plan_a.advances);
        assert!(t.plan_sweep(now, 0).fills.is_empty(), "after apply_advances the swept buckets are behind the pointer");
    }
}
