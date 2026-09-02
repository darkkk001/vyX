//! Tick ingest orchestration — the entry point every producer calls
//! (today: the MT5 EA via the Next.js thin forwarder; Phase 5: a FIX feed
//! adapter too). Both would call this exact function with the same
//! `protocol::Tick` shape — see ../../docs/market-data.md §2 and
//! ../../docs/execution.md's Phase 5 note that the consumer shape doesn't
//! change when the feed source does.

use crate::{cache::TickCache, candle_updates_for_tick, db, gap_fill::GapFillTracker, stats::FeedStats, symbol_activity::SymbolActivity};
use chrono::{DateTime, Utc};
use protocol::Tick;
use sqlx::PgPool;
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

pub async fn ingest_ticks(
    nats: &async_nats::Client,
    cache: &TickCache,
    stats: &Arc<FeedStats>,
    symbol_activity: &SymbolActivity,
    ticks: &[Tick],
) -> Result<(), IngestError> {
    let now = Utc::now();
    let now_ms = now.timestamp_millis();

    for tick in ticks {
        cache.set(tick, resolve_tick_time(tick, now));
        symbol_activity.record(&tick.symbol, now_ms);
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

    Ok(())
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
    pool: PgPool,
    cache: Arc<TickCache>,
    live_price_interval: StdDuration,
    candle_interval: StdDuration,
    stats: Arc<FeedStats>,
    gap_fill: Arc<GapFillTracker>,
) {
    {
        let pool = pool.clone();
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
                flush_live_prices(&pool, &cache, &dirty, &stats).await;
            }
        });
    }

    {
        let pool = pool.clone();
        let stats = stats.clone();
        let gap_fill = gap_fill.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(candle_interval);
            loop {
                ticker.tick().await;
                let dirty = cache.take_dirty_candles();
                if dirty.is_empty() {
                    continue;
                }
                flush_candles(&pool, &cache, &dirty, &stats, &gap_fill).await;
            }
        });
    }

    spawn_gap_sweep(pool, stats, gap_fill);
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

fn spawn_gap_sweep(pool: PgPool, stats: Arc<FeedStats>, gap_fill: Arc<GapFillTracker>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(GAP_SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            let fills = gap_fill.sweep_stale_buckets(Utc::now());
            if fills.is_empty() {
                continue;
            }
            let started = Instant::now();
            let result = tokio::time::timeout(DB_FLUSH_TIMEOUT, async {
                let mut tx = pool.begin().await?;
                db::upsert_candles_batch(&mut tx, &fills).await?;
                tx.commit().await
            })
            .await;
            let lag_ms = started.elapsed().as_millis() as i64;
            match result {
                Ok(Ok(())) => stats.record_db_write(true, lag_ms),
                Ok(Err(err)) => {
                    stats.record_db_write(false, lag_ms);
                    stats.record_candle_write_failure();
                    // Not re-queued like flush_candles' own failure path --
                    // GapFillTracker already advanced past these buckets
                    // (sweep_stale_buckets' own doc comment), so a dropped
                    // write here just means these specific rows stay
                    // missing until the next sweep produces DIFFERENT
                    // (later) buckets; it can't retry the exact same ones
                    // without also re-deriving them from tracker state this
                    // module doesn't expose. Logged same as every other
                    // flush failure, rate-limited the same way.
                    if stats.should_log_candle_failure() {
                        tracing::warn!(?err, lag_ms, fills = fills.len(), "gap-sweep flush failed (rate-limited to 1 line/30s)");
                    }
                }
                Err(_) => {
                    stats.record_db_write(false, lag_ms);
                    stats.record_candle_write_failure();
                    if stats.should_log_candle_failure() {
                        tracing::warn!(timeout_ms = DB_FLUSH_TIMEOUT.as_millis() as i64, fills = fills.len(), "gap-sweep flush timed out (rate-limited to 1 line/30s)");
                    }
                }
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
async fn flush_live_prices(pool: &PgPool, cache: &TickCache, ticks: &[Tick], stats: &Arc<FeedStats>) {
    let started = Instant::now();
    // Re-resolved here (not carried from ingest_ticks' own call) since
    // take_dirty_live_prices only returns the Tick itself, not the
    // DateTime ingest_ticks resolved for it -- tick_ms lives on the Tick,
    // so this reproduces the identical result for a tick that has it, and
    // the same "old EA" fallback (now flush-time instead of ingest-time,
    // a difference of at most one flush interval -- immaterial next to
    // what this is a fallback FOR: an EA build with no staleness fix at
    // all) for one that doesn't.
    let flush_now = Utc::now();
    let result = tokio::time::timeout(DB_FLUSH_TIMEOUT, async {
        let mut tx = pool.begin().await?;
        // One batched round trip for the whole flush, not one per symbol
        // -- see db::upsert_live_prices_batch's own comment.
        let symbols: Vec<String> = ticks.iter().map(|t| t.symbol.clone()).collect();
        let bids: Vec<_> = ticks.iter().map(|t| t.bid).collect();
        let asks: Vec<_> = ticks.iter().map(|t| t.ask).collect();
        let tick_ats: Vec<DateTime<Utc>> = ticks.iter().map(|t| resolve_tick_time(t, flush_now)).collect();
        db::upsert_live_prices_batch(&mut tx, &symbols, &bids, &asks, &tick_ats).await?;
        tx.commit().await
    })
    .await;
    let lag_ms = started.elapsed().as_millis() as i64;

    match result {
        Ok(Ok(())) => stats.record_db_write(true, lag_ms),
        Ok(Err(err)) => {
            stats.record_db_write(false, lag_ms);
            re_mark_live_price_dirty(cache, ticks);
            if stats.should_log_live_price_failure() {
                tracing::warn!(?err, lag_ms, "live-price flush failed (rate-limited to 1 line/30s -- see /internal/feed-stats for the real db_fail count)");
            }
        }
        Err(_) => {
            stats.record_db_write(false, lag_ms);
            re_mark_live_price_dirty(cache, ticks);
            if stats.should_log_live_price_failure() {
                tracing::warn!(timeout_ms = DB_FLUSH_TIMEOUT.as_millis() as i64, "live-price flush timed out (rate-limited to 1 line/30s)");
            }
        }
    }
}

fn re_mark_live_price_dirty(cache: &TickCache, ticks: &[Tick]) {
    let symbols: Vec<String> = ticks.iter().map(|t| t.symbol.clone()).collect();
    cache.mark_live_price_dirty(&symbols);
}

// Same claim/retry-on-failure shape as flush_live_prices, via
// cache::TickCache::mark_candle_dirty.
async fn flush_candles(pool: &PgPool, cache: &TickCache, ticks: &[Tick], stats: &Arc<FeedStats>, gap_fill: &GapFillTracker) {
    let now = Utc::now();
    let started = Instant::now();
    let result = tokio::time::timeout(DB_FLUSH_TIMEOUT, async {
        // One batched round trip for the whole flush instead of one per
        // (tick x timeframe x gap-fill) -- see db::upsert_candles_batch's
        // own comment. Gap-fills and real updates share the same merge
        // (GREATEST/LEAST) semantics, so they collect into one Vec and go
        // in a single UNNEST insert; order within the batch doesn't
        // matter the way it did as sequential single-row writes (a gap
        // fill and the update whose gap it closes never touch the same
        // bucket, so there's no same-batch ordering to preserve).
        let mut all_updates = Vec::new();
        for tick in ticks {
            for update in candle_updates_for_tick(tick, now) {
                // fix/realtime-sync §4 -- flat-fills every bucket skipped
                // since the last one actually written for this
                // symbol+timeframe (a quiet period, or the engine having
                // been down), so the chart's categorical time axis never
                // shows a gap for anything other than a real market
                // close.
                all_updates.extend(gap_fill.fill_gaps_and_record(&update));
                all_updates.push(update);
            }
        }
        let mut tx = pool.begin().await?;
        db::upsert_candles_batch(&mut tx, &all_updates).await?;
        tx.commit().await
    })
    .await;
    let lag_ms = started.elapsed().as_millis() as i64;

    match result {
        Ok(Ok(())) => stats.record_db_write(true, lag_ms),
        Ok(Err(err)) => {
            stats.record_db_write(false, lag_ms);
            stats.record_candle_write_failure();
            re_mark_candle_dirty(cache, ticks);
            if stats.should_log_candle_failure() {
                tracing::warn!(?err, lag_ms, "candle flush failed (rate-limited to 1 line/30s -- see /internal/feed-stats for the real db_fail count)");
            }
        }
        Err(_) => {
            stats.record_db_write(false, lag_ms);
            stats.record_candle_write_failure();
            re_mark_candle_dirty(cache, ticks);
            if stats.should_log_candle_failure() {
                tracing::warn!(timeout_ms = DB_FLUSH_TIMEOUT.as_millis() as i64, "candle flush timed out (rate-limited to 1 line/30s)");
            }
        }
    }
}

fn re_mark_candle_dirty(cache: &TickCache, ticks: &[Tick]) {
    let symbols: Vec<String> = ticks.iter().map(|t| t.symbol.clone()).collect();
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
    use chrono::Duration;
    use rust_decimal_macros::dec;

    fn tick_with_ms(tick_ms: Option<i64>) -> Tick {
        Tick { symbol: "XAUUSD".into(), bid: dec!(2400.00), ask: dec!(2400.20), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms }
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
}
