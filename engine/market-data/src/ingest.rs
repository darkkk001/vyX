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

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

/// Writes LivePrice for each tick in one transaction, then updates the
/// in-memory `TickCache` and publishes each tick to NATS — both only
/// after the commit succeeds, same "publish only after commit" rule as
/// ../../order-management/src/events.rs, so neither a NATS subscriber nor
/// an order-placement cache read can ever observe a write that could
/// still roll back. The cache update happens here (the true ingest
/// point) rather than by having the process's own NATS subscription loop
/// a tick back to itself, which would be an unnecessary extra hop just
/// to update local state.
///
/// Candle history (9 timeframes per tick) used to be written in this
/// same transaction, awaited before the HTTP response returned — that
/// coupled historical persistence to the live-tick path `get_live_price`
/// (the 15s-freshness check every order route reads) never actually
/// needed, and multiplied the write cost ~10x per tick for no live-path
/// benefit. It's now spawned as a background task after the fast commit
/// instead — best-effort, same rationale as `publish_tick` below: a
/// candle write that fails or lags shouldn't hold up (or fail) the
/// LivePrice write the live path actually depends on.
pub async fn ingest_ticks(
    pool: &PgPool,
    nats: &async_nats::Client,
    cache: &TickCache,
    stats: &Arc<FeedStats>,
    ticks: &[Tick],
) -> Result<(), IngestError> {
    let now = Utc::now();
    let mut tx = pool.begin().await?;

    for tick in ticks {
        db::upsert_live_price(&mut tx, &tick.symbol, tick.bid, tick.ask).await?;
    }

    tx.commit().await?;

    for tick in ticks {
        cache.set(tick, now);
        match tick.t0 {
            Some(t0) => stats.record_latency_ms(now.timestamp_millis() - t0),
            None => stats.record_missing_t0(),
        }
        if !publish_tick(nats, tick).await {
            stats.record_nats_publish_failure();
        }
    }

    spawn_candle_writes(pool.clone(), ticks.to_vec(), now, stats.clone());

    Ok(())
}

/// Fire-and-forget: every timeframe's Candle for this batch of ticks, off
/// the live-tick response path entirely. `ticks`/`now` are owned (not
/// borrowed) so this can outlive the request that triggered it.
fn spawn_candle_writes(pool: PgPool, ticks: Vec<Tick>, now: chrono::DateTime<Utc>, stats: Arc<FeedStats>) {
    tokio::spawn(async move {
        let mut tx = match pool.begin().await {
            Ok(tx) => tx,
            Err(err) => {
                tracing::warn!(?err, "candle write: failed to begin transaction");
                stats.record_candle_write_failure();
                return;
            }
        };
        for tick in &ticks {
            for update in candle_updates_for_tick(tick, now) {
                if let Err(err) = db::upsert_candle(&mut tx, &update).await {
                    tracing::warn!(?err, symbol = %tick.symbol, "candle write: upsert_candle failed");
                    stats.record_candle_write_failure();
                    return;
                }
            }
        }
        if let Err(err) = tx.commit().await {
            tracing::warn!(?err, "candle write: commit failed");
            stats.record_candle_write_failure();
        }
    });
}

/// Best-effort — a tick that fails to broadcast over NATS shouldn't undo
/// (or block on) a Postgres write that already committed. Subject is
/// per-symbol (`price.tick.{symbol}`) so the Gateway can subscribe with
/// the wildcard `price.tick.*`; this isn't a `protocol::TradingEvent`
/// (ticks aren't a trading event and don't need its `#[serde(tag="type")]`
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
