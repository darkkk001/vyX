//! Tick ingest orchestration — the entry point every producer calls
//! (today: the MT5 EA via the Next.js thin forwarder; Phase 5: a FIX feed
//! adapter too). Both would call this exact function with the same
//! `protocol::Tick` shape — see ../../docs/market-data.md §2 and
//! ../../docs/execution.md's Phase 5 note that the consumer shape doesn't
//! change when the feed source does.

use crate::{
    alerts::{AlertCache, TriggeredAlert},
    apply_broker_bars,
    broker_offset::BrokerOffsetTracker,
    cache::{CandleSample, TickCache},
    candle_updates_for_tick_ohlc, db,
    gap_fill::{market_open, GapFillTracker},
    stats::FeedStats,
    symbol_activity::SymbolActivity,
    CandleUpdate, Timeframe,
};
use chrono::{DateTime, Utc};
use crate::sink::{MarketDataPools, SinkName};
use protocol::Tick;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration as StdDuration, Instant};

// t0 is meant to be UTC epoch ms (protocol::Tick's own doc comment). A
// delta against this engine's own UTC clock outside this range means the
// EA sent something other than a real UTC timestamp (a broker-local
// clock, most likely -- see mt5-ea/VyXTraderPriceFeed.mq5's own comment
// on TimeGMT() vs TimeCurrent()) or genuine clock skew large enough to be
// noise, not signal. 60s is generous -- real EA-to-engine latency is
// milliseconds to low seconds at worst; this floor is about catching
// "wrong timestamp entirely," not tightly bounding real latency.
const T0_MAX_PLAUSIBLE_DELTA_MS: i64 = 60_000;

// A small negative delta is normal, not a bad timestamp. Once the EA's
// clock-sync handshake is working, its t0 is accurate to about the
// handshake's RTT, and real loopback latency is 0-1ms -- so the noise
// straddles zero and roughly half of it lands just below. Rejecting at 0
// threw away 17% of otherwise-good samples on this box (measured: p50 0ms,
// p95 1ms, 17.2% counted invalid). -100ms absorbs that jitter while still
// being far tighter than any real clock error worth flagging.
const T0_MIN_PLAUSIBLE_DELTA_MS: i64 = -100;

// Contabo audit: Candle/LivePrice upserts were observed taking 4-37s and
// dropping connections. A flush already runs off the hot path (see this
// module's own doc comment), but an unbounded await here still means a
// slow Postgres can pile up overlapping flush attempts indefinitely. 2s
// is generous for a single small batch upsert under normal conditions and
// short enough that a genuinely wedged connection gets abandoned well
// before the next tick of the same interval fires.
const DB_FLUSH_TIMEOUT: StdDuration = StdDuration::from_secs(2);

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

/// Updates the in-memory `TickCache` and publishes to NATS — no Postgres
/// at all. This is the entire hot path now; Postgres persistence
/// (LivePrice, Candle) is fully decoupled onto its own periodic cadence
/// via `spawn_periodic_flush`, not tied to individual ticks at all.
///
/// This used to write LivePrice synchronously here, once per tick
/// (candle writes were already moved off this path). That meant a live
/// feed pushing every second cost one Postgres write per symbol per
/// second regardless of whether anything was actually reading it that
/// often — on a usage-metered Postgres plan (operations/month), a single
/// broker's ~10-symbol feed alone worked out to tens of millions of
/// operations a month, unrelated to how many traders were connected
/// (confirmed live: this is what exhausted the plan's monthly operation
/// limit and paused the whole database). Nothing downstream of the cache
/// needed per-tick Postgres freshness -- `get_if_fresh` already serves
/// order placement straight from memory, and the NATS-fed WebSocket path
/// (services/api-gateway) never touched Postgres for ticks either.
// The REAL moment this tick's price is FROM, not when this process
// received it -- prefers Tick::tick_ms (the EA's own SymbolInfoTick time,
// carried through unchanged on a heartbeat resend of an unchanged price;
// see that field's own doc comment on protocol::Tick) and only falls back
// to `fallback` (the ingest-arrival time) for a tick with no tick_ms at
// all -- an EA build that predates this field, or a test. That fallback
// is exactly today's pre-existing behavior (arrival time stood in for
// tick time everywhere), so nothing gets WORSE for an unupgraded EA; it
// just doesn't get the fix until it's upgraded.
//
// A tick_ms claiming to be from the FUTURE (more than T0's own -100ms
// jitter tolerance ahead of `fallback`) can't be a real tick time -- a
// real tick is never later than the moment we're ingesting it -- and
// falls back rather than trusting it. No upper bound on how far in the
// PAST it can be: a large positive gap is exactly "this price is stale,"
// the real condition this whole fix exists to preserve rather than
// clamp away.
fn resolve_tick_time(tick: &Tick, fallback: DateTime<Utc>) -> DateTime<Utc> {
    match tick.tick_ms.and_then(chrono::DateTime::from_timestamp_millis) {
        Some(t) if (fallback - t).num_milliseconds() >= T0_MIN_PLAUSIBLE_DELTA_MS => t,
        _ => fallback,
    }
}

/// Phase 1 trust pack §3 -- `alert_cache` is checked in-memory only
/// (AlertCache::check_tick does no I/O), same "no Postgres on this path"
/// rule as everything else here; this function's own doc comment above.
/// Triggered alerts are returned rather than persisted here -- the
/// caller (engine/server's ingest_price_feed) owns the DB write + NATS
/// publish for whichever few actually fired, keeping this hot path's own
/// contract intact for the overwhelming common case (nothing triggers on
/// a given tick).
pub async fn ingest_ticks(
    nats: &async_nats::Client,
    cache: &TickCache,
    stats: &Arc<FeedStats>,
    symbol_activity: &SymbolActivity,
    alert_cache: &AlertCache,
    ticks: &[Tick],
) -> Result<Vec<TriggeredAlert>, IngestError> {
    let now = Utc::now();
    let now_ms = now.timestamp_millis();
    let mut triggered = Vec::new();

    for tick in ticks {
        cache.set(tick, resolve_tick_time(tick, now));
        symbol_activity.record(&tick.symbol, now_ms);
        triggered.extend(alert_cache.check_tick(&tick.symbol, tick.bid));
        if let (Some(offset_ms), Some(rtt_ms)) = (tick.clock_offset_ms, tick.rtt_ms) {
            stats.record_clock_info(offset_ms, rtt_ms);
        }
        match tick.t0 {
            Some(t0) => {
                let delta = now_ms - t0;
                if !(T0_MIN_PLAUSIBLE_DELTA_MS..=T0_MAX_PLAUSIBLE_DELTA_MS).contains(&delta) {
                    stats.record_invalid_t0();
                } else {
                    stats.record_latency_ms(delta);
                }
            }
            None => stats.record_missing_t0(),
        }
        if publish_tick(nats, tick).await {
            stats.record_nats_publish_success();
        } else {
            stats.record_nats_publish_failure();
        }
    }

    Ok(triggered)
}

/// Periodically flushes the in-memory `TickCache` to Postgres — LivePrice
/// on its own (short) cadence, Candle history on its own (longer) one,
/// independently, since Candle costs ~9x what LivePrice does per symbol
/// per flush (one row per timeframe) for something that doesn't need to
/// be nearly as fresh: the chart's currently-forming bar is already built
/// live, client-side, straight from the same tick stream (see
/// lib/market-simulator.ts's `applyBidAsk` on the Next.js side) — the
/// persisted Candle row only matters for a fresh page load or a restart,
/// neither of which needs sub-minute precision. LivePrice's own
/// remaining consumers (the legacy poll fallback, manage-side risk/margin
/// reads) are similarly untroubled by a few seconds of staleness — none
/// of them are the live path anymore either.
///
/// Same "spawn a loop with a fixed poll interval" shape as
/// order_management::monitor and order_management::swap already use for
/// their own periodic jobs — nothing new architecturally, just the same
/// pattern applied to tick persistence.
///
/// Each cycle only flushes symbols the cache's own dirty tracking
/// (`TickCache::take_dirty_live_prices`/`take_dirty_candles`) says have
/// received a tick since that flush's own last successful write — not
/// every symbol currently in the cache. Before this, every open bucket got
/// rewritten every cycle regardless of whether anything had actually
/// changed (measured: ~382 billed Postgres operations per row retained,
/// most of them identical repeats of the last-written value) — dirty
/// tracking brings this down to roughly the real tick rate.
pub fn spawn_periodic_flush(
    pools: Arc<MarketDataPools>,
    cache: Arc<TickCache>,
    live_price_interval: StdDuration,
    candle_interval: StdDuration,
    stats: Arc<FeedStats>,
    gap_fill: Arc<GapFillTracker>,
    broker_offset: Arc<BrokerOffsetTracker>,
    risk_hook: Option<Arc<crate::risk_hook::RiskHook>>,
) {
    {
        let pools = pools.clone();
        let cache = cache.clone();
        let stats = stats.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(live_price_interval);
            loop {
                ticker.tick().await;
                let dirty = cache.take_dirty_live_prices();
                if dirty.is_empty() {
                    continue;
                }
                let ok = flush_live_prices(&pools, &cache, &dirty, &stats).await;
                // the row is written: if one of these ticks touches an open SL / TP, have the web app
                // evaluate that symbol NOW (see risk_hook.rs) instead of at the next minute cron
                if ok {
                    if let Some(hook) = &risk_hook {
                        hook.after_flush(&dirty);
                    }
                }
            }
        });
    }

    {
        let pools = pools.clone();
        let stats = stats.clone();
        let gap_fill = gap_fill.clone();
        let broker_offset = broker_offset.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(candle_interval);
            // fix/candle-gaps §2 -- rows a previous cycle failed to commit,
            // carried into the next flush so the missed bucket is retried
            // with its real values (bounded; see flush_candles).
            let mut pending: Vec<CandleUpdate> = Vec::new();
            loop {
                ticker.tick().await;
                let dirty = cache.take_dirty_candles();
                if dirty.is_empty() && pending.is_empty() {
                    continue;
                }
                flush_candles(&pools, &cache, &dirty, &stats, &gap_fill, &broker_offset, &mut pending).await;
            }
        });
    }

    spawn_gap_sweep(pools, stats, gap_fill, broker_offset);
}

/// Runs one write (its own transaction, its own DB_FLUSH_TIMEOUT) against
/// every persistence target of the current MARKET_DATA_WRITE mode, one
/// after the other (Neon first, then local -- ~30 ms + ~2 ms, so
/// sequential costs nothing measurable and keeps the per-sink counters
/// unambiguous). Returns true only when every target succeeded; the
/// per-sink counters and the rate-limited log line name the side that
/// failed. See sink.rs for why re-applying a batch that already landed on
/// one side is harmless.
pub async fn write_to_targets<F, Fut>(pools: &MarketDataPools, stats: &FeedStats, what: &'static str, write: F) -> bool
where
    F: Fn(PgPool) -> Fut,
    Fut: Future<Output = Result<(), sqlx::Error>>,
{
    let mut all_ok = true;
    for (sink, pool) in pools.targets() {
        let started = Instant::now();
        let result = tokio::time::timeout(DB_FLUSH_TIMEOUT, write(pool.clone())).await;
        let lag_ms = started.elapsed().as_millis() as i64;
        match result {
            Ok(Ok(())) => stats.record_sink_write(sink, true, lag_ms),
            Ok(Err(err)) => {
                stats.record_sink_write(sink, false, lag_ms);
                all_ok = false;
                if sink == SinkName::Local || stats_should_log(stats, what) {
                    tracing::warn!(?err, lag_ms, sink = sink.as_str(), "{what} flush failed (rate-limited to 1 line/30s -- see /internal/feed-stats for the real counters)");
                }
            }
            Err(_) => {
                stats.record_sink_write(sink, false, lag_ms);
                all_ok = false;
                if sink == SinkName::Local || stats_should_log(stats, what) {
                    tracing::warn!(timeout_ms = DB_FLUSH_TIMEOUT.as_millis() as i64, sink = sink.as_str(), "{what} flush timed out (rate-limited to 1 line/30s)");
                }
            }
        }
    }
    all_ok
}

fn stats_should_log(stats: &FeedStats, what: &str) -> bool {
    if what == "live-price" {
        stats.should_log_live_price_failure()
    } else {
        stats.should_log_candle_failure()
    }
}

// hotfix/terminal-live-bugs round 5 -- "flat-fill written promptly, not
// lazily." flush_candles above only ever gap-fills the buckets skipped
// since the last real tick, and only runs at all when some symbol is
// actually dirty -- a symbol with no ticks for a while (or slower than
// GAP_SWEEP_INTERVAL) just sits with a hole until its next real tick
// happens to land, however far off that is. This is the same
// GapFillTracker, on its own timer, closing that hole on a schedule
// instead of waiting on the tick stream. 10s: frequent enough that even
// M1 (the smallest fixed timeframe) never sits more than one sweep cycle
// behind a bucket boundary, without adding meaningful write volume (the
// sweep only ever produces rows when a bucket has actually gone stale,
// which is the exception, not the steady state).
const GAP_SWEEP_INTERVAL: StdDuration = StdDuration::from_secs(10);

// fix/candle-gaps §2 -- cap on how many un-acked candle rows the pending
// retry buffer carries into the next flush during a sustained DB outage.
// ~30 symbols x 7 fixed timeframes ~= 210 rows per stalled bucket, so 5000
// covers a couple dozen consecutive stalled M1 buckets before the oldest
// are dropped -- and a dropped one is NOT lost: the gap-fill pointer never
// advanced past it (§1), so the next successful flush flat-fills it and the
// EA backfill later restores its real OHLC. It degrades to flat, never to
// missing.
const MAX_PENDING_RETRY: usize = 5000;

fn spawn_gap_sweep(pools: Arc<MarketDataPools>, stats: Arc<FeedStats>, gap_fill: Arc<GapFillTracker>, broker_offset: Arc<BrokerOffsetTracker>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(GAP_SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            // fix/candle-gaps §1: plan (pure) -> write -> advance the
            // pointers ONLY on a confirmed commit. A failed sweep write now
            // leaves the pointers put, so the next sweep retries the same
            // buckets instead of skipping past them -- the old sweep
            // advanced FIRST, which is exactly why a dropped sweep write
            // left a permanent hole (see this function's own prior comment).
            let plan = gap_fill.plan_sweep(Utc::now(), broker_offset.current());
            if plan.fills.is_empty() {
                // No rows to write, but a swept-through closed region (a
                // weekend) still advances the scan pointer so the next sweep
                // doesn't re-scan it every cycle.
                gap_fill.apply_advances(&plan.advances);
                continue;
            }
            let fills = Arc::new(plan.fills);
            let ok = write_to_targets(&pools, &stats, "gap-sweep", |pool| {
                let fills = fills.clone();
                async move {
                    let mut tx = pool.begin().await?;
                    db::upsert_candles_batch(&mut tx, &fills).await?;
                    tx.commit().await
                }
            })
            .await;
            if ok {
                gap_fill.apply_advances(&plan.advances);
            } else {
                stats.record_candle_write_failure();
            }
        }
    });
}

// On failure/timeout, re-marks every symbol in this batch dirty
// (cache::TickCache::mark_live_price_dirty) before returning -- otherwise
// take_dirty_live_prices already cleared the flag and an update would be
// silently lost rather than retried next cycle. Never returns an error to
// the caller either way -- a failed flush is counted
// (stats::FeedStats::record_db_write) and rate-limit-logged
// (should_log_live_price_failure), then dropped: the retry via the
// re-marked dirty flag is what stands in for "try again" here. This is
// the "on failure increment a counter, drop the batch, never block
// ingest" behavior from the Contabo audit -- ingest_ticks above never
// calls this function at all, so a slow/wedged flush can't backpressure
// the hot path regardless.
async fn flush_live_prices(pools: &MarketDataPools, cache: &TickCache, ticks: &[Tick], stats: &Arc<FeedStats>) -> bool {
    // Re-resolved here (not carried from ingest_ticks' own call) since
    // take_dirty_live_prices only returns the Tick itself, not the
    // DateTime ingest_ticks resolved for it -- tick_ms lives on the Tick,
    // so this reproduces the identical result for a tick that has it, and
    // the same "old EA" fallback (now flush-time instead of ingest-time,
    // a difference of at most one flush interval -- immaterial next to
    // what this is a fallback FOR: an EA build with no staleness fix at
    // all) for one that doesn't.
    let flush_now = Utc::now();
    // One batched round trip per target for the whole flush, not one per
    // symbol -- see db::upsert_live_prices_batch's own comment.
    let symbols: Arc<Vec<String>> = Arc::new(ticks.iter().map(|t| t.symbol.clone()).collect());
    let bids: Arc<Vec<_>> = Arc::new(ticks.iter().map(|t| t.bid).collect());
    let asks: Arc<Vec<_>> = Arc::new(ticks.iter().map(|t| t.ask).collect());
    let tick_ats: Arc<Vec<DateTime<Utc>>> = Arc::new(ticks.iter().map(|t| resolve_tick_time(t, flush_now)).collect());
    let ok = write_to_targets(pools, stats, "live-price", |pool| {
        let (symbols, bids, asks, tick_ats) = (symbols.clone(), bids.clone(), asks.clone(), tick_ats.clone());
        async move {
            let mut tx = pool.begin().await?;
            db::upsert_live_prices_batch(&mut tx, &symbols, &bids, &asks, &tick_ats).await?;
            tx.commit().await
        }
    })
    .await;
    if !ok {
        re_mark_live_price_dirty(cache, ticks);
    }
    ok
}

fn re_mark_live_price_dirty(cache: &TickCache, ticks: &[Tick]) {
    let symbols: Vec<String> = ticks.iter().map(|t| t.symbol.clone()).collect();
    cache.mark_live_price_dirty(&symbols);
}

// fix/candle-gaps §1+§2. Same claim/retry-on-failure shape as
// flush_live_prices (cache::TickCache::mark_candle_dirty), plus two
// integrity fixes over the old "advance the gap-fill pointer while merely
// BUILDING the batch" behavior that lost a bucket on every DB stall:
//   §1  the gap-fill pointer advances (gap_fill.record_committed) ONLY
//       after write_to_targets confirms the batch committed -- a failed /
//       timed-out write leaves it put, so the next flush re-derives and
//       re-fills the bucket that didn't persist instead of skipping it.
//   §2  `pending` carries the exact rows a failed write didn't land into
//       the NEXT flush (ahead of that flush's own updates), so the missed
//       bucket is retried with the real values it held, not just flat.
async fn flush_candles(pools: &MarketDataPools, cache: &TickCache, samples: &[CandleSample], stats: &Arc<FeedStats>, gap_fill: &GapFillTracker, broker_offset: &BrokerOffsetTracker, pending: &mut Vec<CandleUpdate>) {
    // One batched round trip per target for the whole flush instead of
    // one per (tick x timeframe x gap-fill) -- see
    // db::upsert_candles_batch's own comment. Rows a previous cycle failed
    // to commit go in FIRST (oldest observations), so merge_dedup's "last
    // write wins the close" fold keeps time order for a bucket a
    // within-minute stall touched more than once. The batch is built once,
    // outside any DB timeout, deduped, then applied to every target.
    let carried = std::mem::take(pending);
    let carried_keys: HashSet<(String, Timeframe, i64)> =
        carried.iter().map(|u| (u.symbol.clone(), u.timeframe, u.bucket_start.timestamp_millis())).collect();
    let all_updates = {
        let mut all_updates: Vec<CandleUpdate> = carried;
        for sample in samples {
            let tick = &sample.tick;
            // Records this tick's own broker_offset_sec if it has one
            // (see BrokerOffsetTracker's own doc comment) and returns the
            // value to bucket THIS tick's own candles against -- a batch
            // can contain ticks from before and after a fresh offset
            // arrives, and each one should use whatever was actually
            // known at the moment it's processed, not a single snapshot
            // read before the loop started.
            let offset_sec = broker_offset.observe(tick);
            // See FeedStats::record_offset_fallback_tick's own doc
            // comment -- checked directly against the tick's own field
            // (not e.g. "offset_sec == 0", which a broker genuinely on
            // UTC would trip on every tick for no reason) so this only
            // fires for an actual missing-field fallback.
            if tick.broker_offset_sec.is_none() {
                stats.record_offset_fallback_tick();
            }

            // 2026-09-07 fix -- the actual source of weekend flat candles,
            // not gap_fill.rs's own synthetic fill (that path was already
            // correctly gated, see market_open's own comment there). MT5
            // republishes its last real price as a heartbeat resend while
            // the market is closed -- the EA forwards that unchanged, and
            // until now this loop wrote it as a completely real,
            // ungated Candle row every time, regardless of session state.
            // Judged by the TICK's own represented time (resolve_tick_time,
            // "the real moment this tick's price is FROM"), never `now`
            // (this flush cycle's wall clock): a genuinely live tick right
            // at the session boundary could otherwise get wrongly dropped
            // by flush-cycle lag alone, and a stale weekend republish must
            // not be wrongly allowed just because of when it happened to
            // be flushed. LivePrice is unaffected either way -- it's a
            // fully separate flush job (flush_live_prices, its own
            // interval/dirty-tracking) that never goes through this loop,
            // so the watchlist's last-known price still updates from a
            // closed-market tick; only the candle write is skipped.
            let tick_time = sample.at;
            if !market_open(&tick.symbol, tick_time) {
                continue;
            }

            // fix/candle-merge -- bucket by the tick's OWN represented time,
            // the same value the session gate above uses, NOT this flush
            // cycle's wall clock `now`. Under Postgres flush lag (this file's
            // own 4-37s upsert notes) a batch resuming at, say, 10:01:00.2
            // would otherwise stamp a tick genuinely from 10:00:59.8 into the
            // 10:01 bucket, leaking one minute's range into the next and
            // leaving 10:00 to be flat-filled -- two real M1 candles rendering
            // as one fat candle + a flat doji.
            //
            // `sample.at` is that time as resolved when the tick was INGESTED
            // (resolve_tick_time in ingest_ticks -- tick_ms, else arrival
            // time), not re-resolved here: a tick with no tick_ms would
            // otherwise fall back to this flush's `now`, up to a flush
            // interval later than it really arrived, and cross a minute it
            // never belonged to. And since the cache closes a segment on
            // every UTC-minute rollover (cache::TickCache::set), the
            // open/high/low carried on this sample are guaranteed to be from
            // the same minute as `sample.at` -- a window straddling a minute
            // boundary arrives here as two samples, one per minute, instead
            // of the whole window being stamped into the LAST tick's minute
            // (which left the previous minute's bar without its final ticks
            // -- its true high/low -- and gave the next bar a wrong open).
            //
            // fix/candle-open-seed -- then overlay the broker's own forming
            // bars carried on the tick (Tick::bars): the bucket's open
            // becomes the broker's real open (flagged so the upsert replaces
            // it) and high/low widen to the broker's, per timeframe. The
            // sampled values above are only what an EA build without the
            // field (or a Y1 bucket, which MT5 has no period for) gets. See
            // apply_broker_bars for why a bar that doesn't line up with this
            // engine's own bucket is counted and skipped, never applied.
            let mut updates = candle_updates_for_tick_ohlc(tick, tick_time, offset_sec, sample.open, sample.high, sample.low);
            let outcome = apply_broker_bars(&mut updates, &tick.bars);
            stats.record_broker_bars(&tick.symbol, outcome, &tick.bars, &updates);
            for update in updates {
                // fix/realtime-sync §4 -- flat-fills every bucket skipped
                // since the last one actually written for this
                // symbol+timeframe (a quiet period, or the engine having
                // been down), so the chart's categorical time axis never
                // shows a gap for anything other than a real market close.
                // fix/candle-gaps §1: fills_for is now PURE (no advance) --
                // the advance is gap_fill.record_committed below, gated on
                // the write. §2: a carried (real) row for a bucket must
                // never be overwritten by this cycle's synthetic flat-fill
                // for the same bucket -- skip the flat, keep the real.
                for fill in gap_fill.fills_for(&update) {
                    let k = (fill.symbol.clone(), fill.timeframe, fill.bucket_start.timestamp_millis());
                    if !carried_keys.contains(&k) {
                        all_updates.push(fill);
                    }
                }
                all_updates.push(update);
            }
        }
        merge_dedup(all_updates)
    };
    if all_updates.is_empty() {
        return;
    }
    let all_updates = Arc::new(all_updates);
    let ok = write_to_targets(pools, stats, "candle", |pool| {
        let all_updates = all_updates.clone();
        async move {
            let mut tx = pool.begin().await?;
            db::upsert_candles_batch(&mut tx, &all_updates).await?;
            tx.commit().await
        }
    })
    .await;
    if ok {
        // fix/candle-gaps §1 -- advance the pointer ONLY now the DB has it.
        gap_fill.record_committed(&all_updates);
    } else {
        stats.record_candle_write_failure();
        re_mark_candle_dirty(cache, samples);
        // fix/candle-gaps §2 -- retain the exact rows that didn't land for
        // the next cycle, bounded so a long outage can't grow this without
        // limit (past the cap, §1's flat-fill + the EA backfill still close
        // the hole -- it degrades to flat, never to missing).
        let mut lost = Arc::try_unwrap(all_updates).unwrap_or_else(|a| (*a).clone());
        if lost.len() > MAX_PENDING_RETRY {
            lost.sort_by_key(|u| u.bucket_start);
            let drop = lost.len() - MAX_PENDING_RETRY;
            lost.drain(0..drop);
        }
        *pending = lost;
    }
}

/// fix/candle-gaps §2 -- folds duplicate (symbol, timeframe, bucketStart)
/// rows in a candle batch into one, reproducing exactly what sequential
/// upserts would do (open = first seen, high = max, low = min, close =
/// last seen). A single `INSERT ... ON CONFLICT` cannot touch the same
/// conflict key twice (Postgres errors "cannot affect row a second time"),
/// which the §2 pending-retry could otherwise trigger by carrying a bucket
/// this cycle also produces. Stable: distinct keys keep first-seen order.
fn merge_dedup(batch: Vec<CandleUpdate>) -> Vec<CandleUpdate> {
    if batch.len() < 2 {
        return batch;
    }
    let mut index: HashMap<(String, Timeframe, i64), usize> = HashMap::new();
    let mut out: Vec<CandleUpdate> = Vec::with_capacity(batch.len());
    for u in batch {
        let key = (u.symbol.clone(), u.timeframe, u.bucket_start.timestamp_millis());
        if let Some(&i) = index.get(&key) {
            let e = &mut out[i];
            if u.high > e.high {
                e.high = u.high;
            }
            if u.low < e.low {
                e.low = u.low;
            }
            e.close = u.close;
            // fix/candle-open-seed -- a broker-seeded open beats a sampled one
            // whichever order they were folded in; a later broker value wins
            // over an earlier broker value (same bar, MT5 does not change its
            // open, so they are equal in practice).
            if u.open_authoritative {
                e.open = u.open;
                e.open_authoritative = true;
            }
        } else {
            index.insert(key, out.len());
            out.push(u);
        }
    }
    out
}

fn re_mark_candle_dirty(cache: &TickCache, samples: &[CandleSample]) {
    let symbols: Vec<String> = samples.iter().map(|s| s.tick.symbol.clone()).collect();
    cache.mark_candle_dirty(&symbols);
}

/// Best-effort — a tick that fails to broadcast over NATS shouldn't block
/// anything else in the hot path. Subject is per-symbol
/// (`price.tick.{symbol}`) so the Gateway can subscribe with the
/// wildcard `price.tick.*`; this isn't a `protocol::TradingEvent` (ticks
/// aren't a trading event and don't need its `#[serde(tag="type")]`
/// dispatch). Returns whether the publish succeeded, so the caller can
/// feed `stats::FeedStats`.
async fn publish_tick(nats: &async_nats::Client, tick: &Tick) -> bool {
    let subject = format!("price.tick.{}", tick.symbol);
    let payload = match serde_json::to_vec(tick) {
        Ok(bytes) => bytes,
        Err(err) => {
            tracing::warn!(?err, symbol = %tick.symbol, "failed to serialize tick for NATS");
            return false;
        }
    };
    if let Err(err) = nats.publish(subject, payload.into()).await {
        tracing::warn!(?err, symbol = %tick.symbol, "failed to publish tick to NATS");
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};
    use rust_decimal_macros::dec;

    fn tick_with_ms(tick_ms: Option<i64>) -> Tick {
        Tick { symbol: "XAUUSD".into(), bid: dec!(2400.00), ask: dec!(2400.20), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms, broker_offset_sec: None, bars: Vec::new() }
    }

    // tick_ms round-trips through i64 milliseconds, which truncates
    // Utc::now()'s sub-millisecond precision -- expectations below go
    // through this same truncation so the comparison is meaningful rather
    // than incidentally failing on nanosecond jitter that has nothing to
    // do with the logic under test.
    fn truncate_to_ms(t: DateTime<Utc>) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(t.timestamp_millis()).unwrap()
    }

    // The exact scenario this fix closes: a frozen weekend price whose
    // tick_ms hasn't advanced in days must resolve to that OLD time, not
    // "now" -- that's what lets a downstream staleness check (tickAt >
    // now() - interval) actually see it as stale.
    #[test]
    fn a_tick_from_days_ago_resolves_to_its_own_old_time_not_now() {
        let now = Utc::now();
        let old = now - Duration::days(3);
        let tick = tick_with_ms(Some(old.timestamp_millis()));
        assert_eq!(resolve_tick_time(&tick, now), truncate_to_ms(old));
    }

    #[test]
    fn a_tick_with_no_tick_ms_falls_back_to_the_given_fallback() {
        let now = Utc::now();
        let tick = tick_with_ms(None);
        assert_eq!(resolve_tick_time(&tick, now), now);
    }

    #[test]
    fn a_tick_ms_within_normal_jitter_of_now_is_trusted() {
        let now = Utc::now();
        let tick = tick_with_ms(Some(now.timestamp_millis()));
        assert_eq!(resolve_tick_time(&tick, now), truncate_to_ms(now));
    }

    // A tick claiming to be from the future (beyond t0's own -100ms
    // jitter tolerance) can't be a real tick time -- falls back rather
    // than letting a bad/garbage tick_ms make a price look artificially
    // fresher than it is.
    #[test]
    fn an_implausibly_future_tick_ms_falls_back_instead_of_being_trusted() {
        let now = Utc::now();
        let future = now + Duration::seconds(30);
        let tick = tick_with_ms(Some(future.timestamp_millis()));
        assert_eq!(resolve_tick_time(&tick, now), now);
    }

    // No upper bound on how far in the past tick_ms can be -- that's
    // "stale," the exact condition this fix must preserve, not clamp.
    #[test]
    fn an_extremely_old_tick_ms_is_still_trusted_not_clamped() {
        let now = Utc::now();
        let ancient = now - Duration::days(400);
        let tick = tick_with_ms(Some(ancient.timestamp_millis()));
        assert_eq!(resolve_tick_time(&tick, now), truncate_to_ms(ancient));
    }

    // 2026-09-07 fix -- the actual weekend-flat-candle bug: flush_candles
    // used to gate NOTHING on session state, only gap_fill.rs's own
    // synthetic fills were ever excluded. These two tests compose
    // resolve_tick_time + market_open the exact same way flush_candles's
    // real fix now does, covering the two cases asked for: a stale
    // weekend republish must resolve to "not open" (so no candle gets
    // written), and a crypto tick at the identical wall-clock moment must
    // still resolve to "open" (so it keeps writing normally).
    fn tick_with_ms_for(symbol: &str, tick_ms: Option<i64>) -> Tick {
        Tick { symbol: symbol.into(), bid: dec!(1.1000), ask: dec!(1.1002), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms, broker_offset_sec: None, bars: Vec::new() }
    }

    #[test]
    fn a_stale_weekend_republish_is_judged_by_its_own_frozen_tick_time_not_now() {
        // MT5 republishes Friday's last real price as a heartbeat while
        // the market is genuinely closed -- tick_ms stays frozen at
        // Friday's close even though this flush cycle's own `now` is
        // Saturday. The fix must use the tick's own time for the session
        // check, not `now` -- asserted explicitly here, not just assumed.
        // 22:00 UTC, not 21:00 -- August is DST/EDT, when real NY-17:00
        // close is 22:00 UTC (see gap_fill.rs's us_eastern_is_dst); 21:00
        // that same Friday is genuinely still open market time.
        let friday_close = Utc.with_ymd_and_hms(2026, 8, 14, 22, 0, 0).unwrap();
        let saturday_now = Utc.with_ymd_and_hms(2026, 8, 15, 12, 0, 0).unwrap();
        let tick = tick_with_ms_for("EURUSD", Some(friday_close.timestamp_millis()));

        let tick_time = resolve_tick_time(&tick, saturday_now);
        assert_eq!(tick_time, friday_close, "must resolve to the tick's own frozen time, not the flush cycle's wall clock");
        assert!(!market_open(&tick.symbol, tick_time), "a stale Friday-close republish arriving Saturday must not be treated as market-open -- no candle should be written for it");
    }

    #[test]
    fn a_crypto_tick_at_the_same_weekend_moment_still_writes_normally() {
        let saturday = Utc.with_ymd_and_hms(2026, 8, 15, 12, 0, 0).unwrap();
        let tick = tick_with_ms_for("BTCUSD", Some(saturday.timestamp_millis()));

        let tick_time = resolve_tick_time(&tick, saturday);
        assert!(market_open(&tick.symbol, tick_time), "BTCUSD trades all weekend -- its tick must still be treated as market-open");
    }

    // fix/candle-gaps §2 -- merge_dedup must reproduce sequential-upsert
    // OHLC (open = first, high = max, low = min, close = last) so the
    // pending-retry can safely carry a bucket this cycle also produces
    // without tripping Postgres's "cannot affect row a second time".
    #[test]
    fn merge_dedup_folds_duplicate_buckets_like_sequential_upserts() {
        let base = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        let mk = |open: rust_decimal::Decimal, high: rust_decimal::Decimal, low: rust_decimal::Decimal, close: rust_decimal::Decimal| CandleUpdate {
            symbol: "XAUUSD".to_string(),
            timeframe: Timeframe::M1,
            bucket_start: base,
            open,
            high,
            low,
            close,
            open_authoritative: false,
        };
        let out = merge_dedup(vec![
            mk(dec!(2400), dec!(2401), dec!(2400), dec!(2401)),
            mk(dec!(2401), dec!(2402), dec!(2399), dec!(2399)),
        ]);
        assert_eq!(out.len(), 1, "the same bucket must collapse to one row");
        assert_eq!(out[0].open, dec!(2400), "open = first seen");
        assert_eq!(out[0].high, dec!(2402), "high = max across the fold");
        assert_eq!(out[0].low, dec!(2399), "low = min across the fold");
        assert_eq!(out[0].close, dec!(2399), "close = last seen");
    }

    // fix/candle-open-seed -- a broker-seeded open must survive the fold in
    // either order: a carried (pending) sampled row ahead of this cycle's
    // broker-seeded one, or the reverse.
    #[test]
    fn merge_dedup_keeps_the_broker_seeded_open_whichever_side_of_the_fold_it_is_on() {
        let base = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        let mk = |open: rust_decimal::Decimal, authoritative: bool| CandleUpdate {
            symbol: "XAUUSD".to_string(),
            timeframe: Timeframe::M1,
            bucket_start: base,
            open,
            high: dec!(2401),
            low: dec!(2399),
            close: dec!(2400),
            open_authoritative: authoritative,
        };
        let out = merge_dedup(vec![mk(dec!(2400.5), false), mk(dec!(2400.0), true)]);
        assert_eq!((out[0].open, out[0].open_authoritative), (dec!(2400.0), true), "broker open folded in after a sampled one wins");
        let out = merge_dedup(vec![mk(dec!(2400.0), true), mk(dec!(2400.5), false)]);
        assert_eq!((out[0].open, out[0].open_authoritative), (dec!(2400.0), true), "a sampled open folded in after a broker one does not demote it");
    }

    #[test]
    fn merge_dedup_keeps_distinct_buckets_in_first_seen_order() {
        let base = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        let mk = |m: i64| CandleUpdate {
            symbol: "XAUUSD".to_string(),
            timeframe: Timeframe::M1,
            bucket_start: base + Duration::minutes(m),
            open: dec!(2400),
            high: dec!(2400),
            low: dec!(2400),
            close: dec!(2400),
            open_authoritative: false,
        };
        let out = merge_dedup(vec![mk(2), mk(0), mk(1)]);
        let starts: Vec<_> = out.iter().map(|u| u.bucket_start).collect();
        assert_eq!(starts, vec![base + Duration::minutes(2), base, base + Duration::minutes(1)]);
    }
}

#[cfg(test)]
mod dual_write_tests {
    //! Real-Postgres check of the S1 dual-write path: skipped (not failed)
    //! unless MARKET_DATA_TEST_NEON_URL and MARKET_DATA_TEST_LOCAL_URL both
    //! point at databases carrying deploy/market_data.sql's schema.
    use super::*;
    use crate::sink::{MarketDataPools, WriteMode};
    use crate::Timeframe;
    use chrono::{Duration, TimeZone};
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;
    use sqlx::postgres::PgPoolOptions;

    async fn pools() -> Option<(PgPool, PgPool)> {
        let (Ok(neon), Ok(local)) = (std::env::var("MARKET_DATA_TEST_NEON_URL"), std::env::var("MARKET_DATA_TEST_LOCAL_URL")) else {
            eprintln!("skipping: MARKET_DATA_TEST_NEON_URL / MARKET_DATA_TEST_LOCAL_URL not set");
            return None;
        };
        Some((PgPool::connect(&neon).await.ok()?, PgPool::connect(&local).await.ok()?))
    }

    async fn count(pool: &PgPool, table: &str, symbol: &str) -> i64 {
        let q = format!(r#"SELECT count(*) FROM "{table}" WHERE symbol = $1"#);
        sqlx::query_scalar(&q).bind(symbol).fetch_one(pool).await.unwrap()
    }

    #[tokio::test]
    async fn both_mode_lands_the_same_rows_on_neon_and_local_and_local_mode_leaves_neon_alone() {
        let Some((neon, local)) = pools().await else { return };
        let symbol = format!("TESTDUAL{}", Utc::now().timestamp_millis() % 1_000_000);
        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol LIKE 'TESTDUAL%'"#).execute(p).await.unwrap();
            sqlx::query(r#"DELETE FROM "LivePrice" WHERE symbol LIKE 'TESTDUAL%'"#).execute(p).await.unwrap();
        }
        let stats = Arc::new(FeedStats::new());
        let cache = TickCache::new();
        let gap_fill = GapFillTracker::new();
        let broker_offset = BrokerOffsetTracker::new();
        let tick = Tick { symbol: symbol.clone(), bid: dec!(4500.10), ask: dec!(4500.30), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: Some(Utc::now().timestamp_millis() - 200), broker_offset_sec: None, bars: Vec::new() };
        cache.set(&tick, Utc::now());

        // both: every row on both sides, both counter trios advance
        let both = MarketDataPools::new(neon.clone(), Some(local.clone()), WriteMode::Both);
        assert!(flush_live_prices(&both, &cache, &[tick.clone()], &stats).await);
        flush_candles(&both, &cache, &[CandleSample { tick: tick.clone(), at: Utc::now(), open: tick.bid, high: tick.bid, low: tick.bid }], &stats, &gap_fill, &broker_offset, &mut Vec::new()).await;
        let snap = stats.snapshot();
        assert_eq!((snap.db_ok, snap.db_fail), (2, 0), "neon: one live-price + one candle flush");
        assert_eq!((snap.local_db_ok, snap.local_db_fail), (2, 0), "local: one live-price + one candle flush");
        assert_eq!(count(&neon, "LivePrice", &symbol).await, 1);
        assert_eq!(count(&local, "LivePrice", &symbol).await, 1);
        let neon_candles = count(&neon, "Candle", &symbol).await;
        assert!(neon_candles >= 1, "a live tick writes one bucket per timeframe");
        assert_eq!(count(&local, "Candle", &symbol).await, neon_candles);
        let (nb, lb): ((Decimal,), (Decimal,)) = (
            sqlx::query_as(r#"SELECT bid FROM "LivePrice" WHERE symbol = $1"#).bind(&symbol).fetch_one(&neon).await.unwrap(),
            sqlx::query_as(r#"SELECT bid FROM "LivePrice" WHERE symbol = $1"#).bind(&symbol).fetch_one(&local).await.unwrap(),
        );
        assert_eq!(nb, lb);
        // the reader is the local store, and returns the Prisma-shaped row order (oldest first)
        let rows = db::fetch_candles(both.reader(), &symbol, Timeframe::M1, 300, None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].close, dec!(4500.10));

        // local: a second tick reaches the local store only
        let tick2 = Tick { bid: dec!(4501.00), ask: dec!(4501.20), ..tick.clone() };
        cache.set(&tick2, Utc::now());
        let local_only = MarketDataPools::new(neon.clone(), Some(local.clone()), WriteMode::Local);
        assert!(flush_live_prices(&local_only, &cache, &[tick2.clone()], &stats).await);
        let (nb2,): (Decimal,) = sqlx::query_as(r#"SELECT bid FROM "LivePrice" WHERE symbol = $1"#).bind(&symbol).fetch_one(&neon).await.unwrap();
        let (lb2,): (Decimal,) = sqlx::query_as(r#"SELECT bid FROM "LivePrice" WHERE symbol = $1"#).bind(&symbol).fetch_one(&local).await.unwrap();
        assert_eq!(nb2, dec!(4500.10), "neon untouched in local mode");
        assert_eq!(lb2, dec!(4501.00));
        let snap = stats.snapshot();
        assert_eq!((snap.db_ok, snap.db_fail), (2, 0), "neon counters did not move");
        assert_eq!((snap.local_db_ok, snap.local_db_fail), (3, 0));

        // a broken local target fails the flush (re-mark for retry) while neon still lands
        let broken = PgPoolOptions::new().acquire_timeout(StdDuration::from_millis(300)).connect_lazy("postgres://nobody:x@127.0.0.1:1/none").unwrap();
        let half = MarketDataPools::new(neon.clone(), Some(broken), WriteMode::Both);
        assert!(!flush_live_prices(&half, &cache, &[tick2.clone()], &stats).await);
        let snap = stats.snapshot();
        assert_eq!((snap.db_ok, snap.db_fail), (3, 0));
        assert_eq!((snap.local_db_ok, snap.local_db_fail), (3, 1));
        assert_eq!(cache.take_dirty_live_prices().len(), 1, "the failed batch is dirty again for the next cycle");

        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1"#).bind(&symbol).execute(p).await.unwrap();
            sqlx::query(r#"DELETE FROM "LivePrice" WHERE symbol = $1"#).bind(&symbol).execute(p).await.unwrap();
        }
    }

    // fix/candle-gaps §1+§2 -- the real-Postgres proof that a dropped
    // candle write leaves NO missing M1 bucket. Replays what flush_candles
    // does across a stall at the gap_fill + upsert level (deterministic
    // buckets, not wall-clock minutes): a baseline commits, the next
    // bucket's write is dropped (buffered, pointer NOT advanced), then a
    // recovery flush carries it -> the served store has a contiguous
    // series and the recovered bucket keeps its REAL value, not a flat fill.
    #[tokio::test]
    async fn a_dropped_candle_write_is_recovered_with_no_missing_m1_bucket() {
        let Some((neon, local)) = pools().await else { return };
        let symbol = format!("TESTGAP{}", Utc::now().timestamp_millis() % 1_000_000);
        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1"#).bind(&symbol).execute(p).await.unwrap();
        }
        let gap = GapFillTracker::new();
        let base = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap(); // Wednesday
        let real = |m: i64, px: Decimal| CandleUpdate { symbol: symbol.clone(), timeframe: Timeframe::M1, bucket_start: base + Duration::minutes(m), open: px, high: px, low: px, close: px, open_authoritative: false };

        // 10:00 baseline lands and is recorded.
        let baseline = vec![real(0, dec!(2400))];
        {
            let mut tx = local.begin().await.unwrap();
            db::upsert_candles_batch(&mut tx, &baseline).await.unwrap();
            tx.commit().await.unwrap();
        }
        gap.record_committed(&baseline);

        // 10:01 flush is DROPPED: fills computed (empty -- adjacent), the
        // write fails, so record_committed is NOT called and the row is
        // buffered as pending. The pointer stays at 10:00.
        assert!(gap.fills_for(&real(1, dec!(2401))).is_empty());
        let pending = vec![real(1, dec!(2401))];

        // 10:02 recovery flush: carried 10:01 first; fills_for(10:02) from
        // the un-advanced 10:00 pointer WOULD flat-fill 10:01, but it's in
        // carried_keys so the flat is skipped; then push real 10:02.
        let mut batch = pending.clone();
        let carried_keys: HashSet<_> = pending.iter().map(|u| u.bucket_start).collect();
        for fill in gap.fills_for(&real(2, dec!(2402))) {
            if !carried_keys.contains(&fill.bucket_start) {
                batch.push(fill);
            }
        }
        batch.push(real(2, dec!(2402)));
        let batch = merge_dedup(batch);
        {
            let mut tx = local.begin().await.unwrap();
            db::upsert_candles_batch(&mut tx, &batch).await.unwrap();
            tx.commit().await.unwrap();
        }
        gap.record_committed(&batch);

        // The served store: 10:00 / 10:01 / 10:02, contiguous, no hole --
        // and 10:01 carries its real 2401 close, not a flat 2400.
        let rows = db::fetch_candles(&local, &symbol, Timeframe::M1, 300, None).await.unwrap();
        let starts: Vec<_> = rows.iter().map(|r| r.bucket_start).collect();
        assert_eq!(
            starts,
            vec![base, base + Duration::minutes(1), base + Duration::minutes(2)],
            "no missing M1 bucket after the dropped write"
        );
        assert_eq!(rows[1].close, dec!(2401), "the recovered bucket keeps its real value, not a flat fill");

        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1"#).bind(&symbol).execute(p).await.unwrap();
        }
    }

    async fn m1_row(pool: &PgPool, symbol: &str, bucket: DateTime<Utc>) -> Option<(Decimal, Decimal, Decimal, Decimal)> {
        sqlx::query_as(r#"SELECT open, high, low, close FROM "Candle" WHERE symbol = $1 AND timeframe = 'M1' AND "bucketStart" = $2"#)
            .bind(symbol)
            .bind(bucket)
            .fetch_optional(pool)
            .await
            .unwrap()
    }

    /// The bug behind "stored OHLC != broker": upsert_candles_batch used to
    /// bind `open` as open, high, low AND close, so the accumulated
    /// intra-window high/low (and the latest-tick close) never reached the
    /// row. Two flushes into one bucket must leave open = first, high = max
    /// of both, low = min of both, close = last.
    #[tokio::test]
    async fn upsert_candles_batch_stores_each_ohlc_field_and_widens_across_flushes() {
        let Some((neon, local)) = pools().await else { return };
        let symbol = format!("TESTOHLC{}", Utc::now().timestamp_millis() % 1_000_000);
        let bucket = Utc.with_ymd_and_hms(2026, 8, 12, 10, 0, 0).unwrap();
        let upd = |o: Decimal, h: Decimal, l: Decimal, c: Decimal| CandleUpdate { symbol: symbol.clone(), timeframe: Timeframe::M1, bucket_start: bucket, open: o, high: h, low: l, close: c, open_authoritative: false };
        for batch in [vec![upd(dec!(100), dec!(110), dec!(95), dec!(101))], vec![upd(dec!(101), dec!(105), dec!(90), dec!(99))]] {
            let mut tx = local.begin().await.unwrap();
            db::upsert_candles_batch(&mut tx, &batch).await.unwrap();
            tx.commit().await.unwrap();
        }
        assert_eq!(m1_row(&local, &symbol, bucket).await, Some((dec!(100), dec!(110), dec!(90), dec!(99))), "open = first flush's open, high/low = widest of both, close = latest");
        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1"#).bind(&symbol).execute(p).await.unwrap();
        }
    }

    /// End to end through the real hot path (cache.set -> take_dirty_candles
    /// -> flush_candles -> Postgres): one flush window whose ticks straddle
    /// a minute boundary. The spike/dip in 12:00's last second must land in
    /// the 12:00 row and 12:01 must open at its own first tick -- neither
    /// happened before: the window was bucketed by its last tick (12:01) and
    /// the DB only ever received the window's open price.
    #[tokio::test]
    async fn a_flush_window_straddling_a_minute_writes_each_minutes_true_ohlc_to_its_own_row() {
        let Some((neon, local)) = pools().await else { return };
        let symbol = format!("TESTSTRD{}", Utc::now().timestamp_millis() % 1_000_000);
        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1"#).bind(&symbol).execute(p).await.unwrap();
        }
        let stats = Arc::new(FeedStats::new());
        let cache = TickCache::new();
        let gap_fill = GapFillTracker::new();
        let broker_offset = BrokerOffsetTracker::new();
        let m0 = Utc.with_ymd_and_hms(2026, 8, 12, 12, 0, 0).unwrap(); // Wednesday, market open
        let m1 = m0 + Duration::minutes(1);
        let tick_at = |bid: Decimal, ms: i64| Tick { symbol: symbol.clone(), bid, ask: bid + dec!(0.2), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: Some(m0.timestamp_millis() + ms), broker_offset_sec: Some(0), bars: Vec::new() };
        // Exactly what ingest_ticks does per tick: resolve the represented time, then cache.set.
        let now = Utc::now();
        for (bid, ms) in [(dec!(2400.0), 58_500), (dec!(2410.0), 59_200), (dec!(2395.0), 59_800), (dec!(2402.0), 60_100), (dec!(2403.0), 60_400)] {
            let t = tick_at(bid, ms);
            cache.set(&t, resolve_tick_time(&t, now));
        }
        let samples = cache.take_dirty_candles();
        assert_eq!(samples.len(), 2, "the straddling window yields one sample per minute");
        let target = MarketDataPools::new(neon.clone(), Some(local.clone()), WriteMode::Local);
        flush_candles(&target, &cache, &samples, &stats, &gap_fill, &broker_offset, &mut Vec::new()).await;
        assert_eq!(stats.snapshot().local_db_fail, 0);

        assert_eq!(m1_row(&local, &symbol, m0).await, Some((dec!(2400.0), dec!(2410.0), dec!(2395.0), dec!(2395.0))), "12:00 keeps its own open and its last-second spike/dip, closing on its last tick");
        assert_eq!(m1_row(&local, &symbol, m1).await, Some((dec!(2402.0), dec!(2403.0), dec!(2402.0), dec!(2403.0))), "12:01 opens at its own first tick and carries none of 12:00's range");

        // A later flush in 12:01 widens that row only (GREATEST/LEAST) and never touches 12:00.
        let t = tick_at(dec!(2390.0), 61_000);
        cache.set(&t, resolve_tick_time(&t, now));
        let samples = cache.take_dirty_candles();
        flush_candles(&target, &cache, &samples, &stats, &gap_fill, &broker_offset, &mut Vec::new()).await;
        assert_eq!(m1_row(&local, &symbol, m1).await, Some((dec!(2402.0), dec!(2403.0), dec!(2390.0), dec!(2390.0))));
        assert_eq!(m1_row(&local, &symbol, m0).await, Some((dec!(2400.0), dec!(2410.0), dec!(2395.0), dec!(2395.0))), "a closed minute is never rewritten by the next minute's ticks");

        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1"#).bind(&symbol).execute(p).await.unwrap();
        }
    }

    async fn row(pool: &PgPool, symbol: &str, tf: &str, bucket: DateTime<Utc>) -> Option<(Decimal, Decimal, Decimal, Decimal)> {
        sqlx::query_as(r#"SELECT open, high, low, close FROM "Candle" WHERE symbol = $1 AND timeframe = $2::"CandleTimeframe" AND "bucketStart" = $3"#)
            .bind(symbol)
            .bind(tf)
            .bind(bucket)
            .fetch_optional(pool)
            .await
            .unwrap()
    }

    fn broker_bar(tf: &str, t: DateTime<Utc>, o: Decimal, h: Decimal, l: Decimal) -> protocol::BrokerBar {
        protocol::BrokerBar { tf: tf.to_string(), t: t.timestamp_millis(), o, h, l }
    }

    /// fix/candle-open-seed -- the bug behind "the forming candle's open is
    /// not Pepperstone's": the EA polls SymbolInfoTick every 50ms and only
    /// pushes the LATEST tick of each window, so the first tick this engine
    /// receives in a new minute is not the tick MT5 opened the bar with. Here
    /// MT5's 12:01 bar opened at 2402.0 (a tick at 12:01:00.010 the EA never
    /// pushed); the first push the engine sees is the 12:01:00.040 tick at
    /// 2402.5, carrying the broker's own bar-0 snapshot. The stored open must
    /// be the broker's 2402.0, not the sampled 2402.5 -- for M1 AND for the
    /// M5 bucket the minute sits in (whose open is a minute older still).
    #[tokio::test]
    async fn the_forming_bars_open_is_the_brokers_bar_open_not_the_first_tick_the_engine_sampled() {
        let Some((neon, local)) = pools().await else { return };
        let symbol = format!("TESTOPEN{}", Utc::now().timestamp_millis() % 1_000_000);
        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1"#).bind(&symbol).execute(p).await.unwrap();
        }
        let stats = Arc::new(FeedStats::new());
        let cache = TickCache::new();
        let gap_fill = GapFillTracker::new();
        let broker_offset = BrokerOffsetTracker::new();
        let m5 = Utc.with_ymd_and_hms(2026, 8, 12, 12, 0, 0).unwrap(); // Wednesday, market open
        let m1 = m5 + Duration::minutes(1);
        let target = MarketDataPools::new(neon.clone(), Some(local.clone()), WriteMode::Local);
        let now = Utc::now();

        // What the v1.40 EA pushes: the sampled tick plus MT5's own forming bars as of that tick.
        let bars = vec![
            broker_bar("M1", m1, dec!(2402.0), dec!(2402.5), dec!(2401.8)),
            broker_bar("M5", m5, dec!(2399.7), dec!(2402.6), dec!(2398.9)),
        ];
        let tick_at = |bid: Decimal, ms: i64, bars: Vec<protocol::BrokerBar>| Tick { symbol: symbol.clone(), bid, ask: bid + dec!(0.2), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: Some(m1.timestamp_millis() + ms), broker_offset_sec: Some(0), bars };
        let t = tick_at(dec!(2402.5), 40, bars.clone());
        cache.set(&t, resolve_tick_time(&t, now));
        let samples = cache.take_dirty_candles();
        flush_candles(&target, &cache, &samples, &stats, &gap_fill, &broker_offset, &mut Vec::new()).await;
        assert_eq!(stats.snapshot().local_db_fail, 0);

        assert_eq!(row(&local, &symbol, "M1", m1).await, Some((dec!(2402.0), dec!(2402.5), dec!(2401.8), dec!(2402.5))), "M1 opens at the broker's bar open (2402.0), not the first sampled tick (2402.5); high/low are the broker's");
        assert_eq!(row(&local, &symbol, "M5", m5).await, Some((dec!(2399.7), dec!(2402.6), dec!(2398.9), dec!(2402.5))), "M5 opens at the broker's M5 bar open, which this engine never saw a tick for");

        // A later flush in the same minute widens high/close and leaves the broker's open alone.
        let later = vec![
            broker_bar("M1", m1, dec!(2402.0), dec!(2403.0), dec!(2401.8)),
            broker_bar("M5", m5, dec!(2399.7), dec!(2403.0), dec!(2398.9)),
        ];
        let t = tick_at(dec!(2403.0), 5_000, later);
        cache.set(&t, resolve_tick_time(&t, now));
        let samples = cache.take_dirty_candles();
        flush_candles(&target, &cache, &samples, &stats, &gap_fill, &broker_offset, &mut Vec::new()).await;
        assert_eq!(row(&local, &symbol, "M1", m1).await, Some((dec!(2402.0), dec!(2403.0), dec!(2401.8), dec!(2403.0))));
        assert_eq!(row(&local, &symbol, "M5", m5).await, Some((dec!(2399.7), dec!(2403.0), dec!(2398.9), dec!(2403.0))));

        // The 300s shallow backfill then rewrites the forming bar wholesale
        // (ingest_history -> upsert_candles_authoritative_batch) with a
        // slightly wider range MT5 saw between pushes. Neither a following
        // live flush WITH broker bars nor one WITHOUT (an old EA) may
        // re-diverge that open, and the widened range must survive.
        let backfilled = CandleUpdate { symbol: symbol.clone(), timeframe: Timeframe::M1, bucket_start: m1, open: dec!(2402.0), high: dec!(2403.2), low: dec!(2401.7), close: dec!(2403.0), open_authoritative: true };
        {
            let mut tx = local.begin().await.unwrap();
            db::upsert_candles_authoritative_batch(&mut tx, &[backfilled]).await.unwrap();
            tx.commit().await.unwrap();
        }
        for (bid, ms, bars) in [
            (dec!(2403.1), 20_000, vec![broker_bar("M1", m1, dec!(2402.0), dec!(2403.2), dec!(2401.7))]),
            (dec!(2402.9), 25_000, vec![]),
        ] {
            let t = tick_at(bid, ms, bars);
            cache.set(&t, resolve_tick_time(&t, now));
            let samples = cache.take_dirty_candles();
            flush_candles(&target, &cache, &samples, &stats, &gap_fill, &broker_offset, &mut Vec::new()).await;
            let (o, h, l, c) = row(&local, &symbol, "M1", m1).await.unwrap();
            assert_eq!((o, h, l, c), (dec!(2402.0), dec!(2403.2), dec!(2401.7), bid), "after the authoritative backfill the open and widened range hold across live flushes with and without bars");
        }

        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1"#).bind(&symbol).execute(p).await.unwrap();
        }
    }

    /// fix/candle-open-seed, second seeding path -- the 10s gap sweep
    /// (ingest::spawn_gap_sweep -> GapFillTracker::plan_sweep) flat-fills
    /// every bucket strictly before `now`'s, so a minute whose only real
    /// ticks arrived in its last second and had not flushed yet when the
    /// sweep ran just after the boundary gets INSERTED as a flat bar (open =
    /// previous close) first. With insert-only open, the minute's real flush
    /// a moment later could never correct it. A tick carrying the broker's
    /// bar must win that race; a tick without one (an EA before v1.40) still
    /// loses it -- that is the pre-existing fallback, repaired only by the
    /// 300s backfill, and is asserted here so the difference is explicit.
    #[tokio::test]
    async fn a_gap_sweep_flat_fill_that_beats_the_minutes_first_tick_does_not_own_the_open() {
        let Some((neon, local)) = pools().await else { return };
        let stamp = Utc::now().timestamp_millis() % 1_000_000;
        let with_bars = format!("TESTSWEEPA{stamp}");
        let without_bars = format!("TESTSWEEPB{stamp}");
        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol LIKE 'TESTSWEEP%'"#).execute(p).await.unwrap();
        }
        let stats = Arc::new(FeedStats::new());
        let cache = TickCache::new();
        let gap_fill = GapFillTracker::new();
        let broker_offset = BrokerOffsetTracker::new();
        let m0 = Utc.with_ymd_and_hms(2026, 8, 12, 12, 0, 0).unwrap(); // Wednesday
        let m1 = m0 + Duration::minutes(1);
        let target = MarketDataPools::new(neon.clone(), Some(local.clone()), WriteMode::Local);

        // 12:00 committed for both symbols, close 2400 (the sweep's carry close).
        gap_fill.seed(&[(with_bars.clone(), Timeframe::M1, m0, dec!(2400.0)), (without_bars.clone(), Timeframe::M1, m0, dec!(2400.0))]);

        // Sweep at 12:02:00.2: 12:01 is "fully closed" and not yet in the DB -> flat-filled at 2400, exactly as spawn_gap_sweep does.
        let plan = gap_fill.plan_sweep(m0 + Duration::milliseconds(120_200), 0);
        let m1_fills: Vec<_> = plan.fills.iter().filter(|f| f.bucket_start == m1).collect();
        assert_eq!(m1_fills.len(), 2, "the sweep flat-fills 12:01 for both symbols");
        {
            let mut tx = local.begin().await.unwrap();
            db::upsert_candles_batch(&mut tx, &plan.fills).await.unwrap();
            tx.commit().await.unwrap();
        }
        gap_fill.apply_advances(&plan.advances);
        assert_eq!(m1_row(&local, &with_bars, m1).await, Some((dec!(2400.0), dec!(2400.0), dec!(2400.0), dec!(2400.0))), "flat fill landed first");

        // 12:01's real ticks (first at 12:01:59.5, broker bar open 2402.0) flush a moment after the sweep.
        let now = Utc::now();
        let mk = |sym: &str, bars: Vec<protocol::BrokerBar>| Tick { symbol: sym.to_string(), bid: dec!(2402.3), ask: dec!(2402.5), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: Some(m1.timestamp_millis() + 59_500), broker_offset_sec: Some(0), bars };
        let a = mk(&with_bars, vec![broker_bar("M1", m1, dec!(2402.0), dec!(2402.4), dec!(2401.9))]);
        let b = mk(&without_bars, vec![]);
        cache.set(&a, resolve_tick_time(&a, now));
        cache.set(&b, resolve_tick_time(&b, now));
        let samples = cache.take_dirty_candles();
        flush_candles(&target, &cache, &samples, &stats, &gap_fill, &broker_offset, &mut Vec::new()).await;
        assert_eq!(stats.snapshot().local_db_fail, 0);

        assert_eq!(m1_row(&local, &with_bars, m1).await, Some((dec!(2402.0), dec!(2402.4), dec!(2400.0), dec!(2402.3))), "the broker's open replaces the flat fill's (the flat 2400 low is the sweep's, widened only by the backfill -- unchanged)");
        assert_eq!(m1_row(&local, &without_bars, m1).await, Some((dec!(2400.0), dec!(2402.3), dec!(2400.0), dec!(2402.3))), "without a broker bar the flat fill keeps the open until the backfill: the documented old-EA fallback");

        for p in [&neon, &local] {
            sqlx::query(r#"DELETE FROM "Candle" WHERE symbol LIKE 'TESTSWEEP%'"#).execute(p).await.unwrap();
        }
    }
}
