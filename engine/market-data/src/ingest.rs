//! Tick ingest orchestration — the entry point every producer calls
//! (today: the MT5 EA via the Next.js thin forwarder; Phase 5: a FIX feed
//! adapter too). Both would call this exact function with the same
//! `protocol::Tick` shape — see ../../docs/market-data.md §2 and
//! ../../docs/execution.md's Phase 5 note that the consumer shape doesn't
//! change when the feed source does.

use crate::{cache::TickCache, candle_updates_for_tick, db, stats::FeedStats};
use chrono::Utc;
use protocol::Tick;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::{Duration as StdDuration, Instant};

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
pub async fn ingest_ticks(
    nats: &async_nats::Client,
    cache: &TickCache,
    stats: &Arc<FeedStats>,
    ticks: &[Tick],
) -> Result<(), IngestError> {
    let now = Utc::now();

    for tick in ticks {
        cache.set(tick, now);
        match tick.t0 {
            Some(t0) => stats.record_latency_ms(now.timestamp_millis() - t0),
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
pub fn spawn_periodic_flush(
    pool: PgPool,
    cache: Arc<TickCache>,
    live_price_interval: StdDuration,
    candle_interval: StdDuration,
    stats: Arc<FeedStats>,
) {
    {
        let pool = pool.clone();
        let cache = cache.clone();
        let stats = stats.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(live_price_interval);
            loop {
                ticker.tick().await;
                let snapshot = cache.snapshot();
                if snapshot.is_empty() {
                    continue;
                }
                flush_live_prices(&pool, &snapshot, &stats).await;
            }
        });
    }

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(candle_interval);
        loop {
            ticker.tick().await;
            let snapshot = cache.snapshot();
            if snapshot.is_empty() {
                continue;
            }
            flush_candles(&pool, &snapshot, &stats).await;
        }
    });
}

// Never returns an error to the caller -- a failed/timed-out flush is
// counted (stats::FeedStats::record_db_write) and rate-limit-logged
// (should_log_live_price_failure), then dropped: the next interval tick
// re-snapshots the cache's current (last-write-wins) state and tries
// again, so nothing needs retrying here. This is the "on failure
// increment a counter, drop the batch, never block ingest" behavior from
// the Contabo audit -- ingest_ticks above never calls this function at
// all, so a slow/wedged flush can't backpressure the hot path regardless.
async fn flush_live_prices(pool: &PgPool, ticks: &[Tick], stats: &Arc<FeedStats>) {
    let started = Instant::now();
    let result = tokio::time::timeout(DB_FLUSH_TIMEOUT, async {
        let mut tx = pool.begin().await?;
        for tick in ticks {
            db::upsert_live_price(&mut tx, &tick.symbol, tick.bid, tick.ask).await?;
        }
        tx.commit().await
    })
    .await;
    let lag_ms = started.elapsed().as_millis() as i64;

    match result {
        Ok(Ok(())) => stats.record_db_write(true, lag_ms),
        Ok(Err(err)) => {
            stats.record_db_write(false, lag_ms);
            if stats.should_log_live_price_failure() {
                tracing::warn!(?err, lag_ms, "live-price flush failed (rate-limited to 1 line/30s -- see /internal/feed-stats for the real db_fail count)");
            }
        }
        Err(_) => {
            stats.record_db_write(false, lag_ms);
            if stats.should_log_live_price_failure() {
                tracing::warn!(timeout_ms = DB_FLUSH_TIMEOUT.as_millis() as i64, "live-price flush timed out (rate-limited to 1 line/30s)");
            }
        }
    }
}

async fn flush_candles(pool: &PgPool, ticks: &[Tick], stats: &Arc<FeedStats>) {
    let now = Utc::now();
    let started = Instant::now();
    let result = tokio::time::timeout(DB_FLUSH_TIMEOUT, async {
        let mut tx = pool.begin().await?;
        for tick in ticks {
            for update in candle_updates_for_tick(tick, now) {
                db::upsert_candle(&mut tx, &update).await?;
            }
        }
        tx.commit().await
    })
    .await;
    let lag_ms = started.elapsed().as_millis() as i64;

    match result {
        Ok(Ok(())) => stats.record_db_write(true, lag_ms),
        Ok(Err(err)) => {
            stats.record_db_write(false, lag_ms);
            stats.record_candle_write_failure();
            if stats.should_log_candle_failure() {
                tracing::warn!(?err, lag_ms, "candle flush failed (rate-limited to 1 line/30s -- see /internal/feed-stats for the real db_fail count)");
            }
        }
        Err(_) => {
            stats.record_db_write(false, lag_ms);
            stats.record_candle_write_failure();
            if stats.should_log_candle_failure() {
                tracing::warn!(timeout_ms = DB_FLUSH_TIMEOUT.as_millis() as i64, "candle flush timed out (rate-limited to 1 line/30s)");
            }
        }
    }
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
