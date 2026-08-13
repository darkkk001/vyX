//! Tick ingest orchestration — the entry point every producer calls
//! (today: the MT5 EA via the Next.js thin forwarder; Phase 5: a FIX feed
//! adapter too). Both would call this exact function with the same
//! `protocol::Tick` shape — see ../../docs/market-data.md §2 and
//! ../../docs/execution.md's Phase 5 note that the consumer shape doesn't
//! change when the feed source does.

use crate::{candle_updates_for_tick, db};
use chrono::Utc;
use protocol::Tick;
use sqlx::PgPool;

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

/// Writes LivePrice + every timeframe's Candle for each tick in one
/// transaction (matching lib/price-feed.ts's `prisma.$transaction`), then
/// publishes each tick to NATS after the commit succeeds — same
/// "publish only after commit" rule as
/// ../../order-management/src/events.rs, so a subscriber never hears
/// about a write that could still roll back.
pub async fn ingest_ticks(
    pool: &PgPool,
    nats: &async_nats::Client,
    ticks: &[Tick],
) -> Result<(), IngestError> {
    let now = Utc::now();
    let mut tx = pool.begin().await?;

    for tick in ticks {
        db::upsert_live_price(&mut tx, &tick.symbol, tick.bid, tick.ask).await?;
        for update in candle_updates_for_tick(tick, now) {
            db::upsert_candle(&mut tx, &update).await?;
        }
    }

    tx.commit().await?;

    for tick in ticks {
        publish_tick(nats, tick).await;
    }

    Ok(())
}

/// Best-effort — a tick that fails to broadcast over NATS shouldn't undo
/// (or block on) a Postgres write that already committed. Subject is
/// per-symbol (`price.tick.{symbol}`) so the Gateway can subscribe with
/// the wildcard `price.tick.*`; this isn't a `protocol::TradingEvent`
/// (ticks aren't a trading event and don't need its `#[serde(tag="type")]`
/// dispatch).
async fn publish_tick(nats: &async_nats::Client, tick: &Tick) {
    let subject = format!("price.tick.{}", tick.symbol);
    let payload = match serde_json::to_vec(tick) {
        Ok(bytes) => bytes,
        Err(err) => {
            tracing::warn!(?err, symbol = %tick.symbol, "failed to serialize tick for NATS");
            return;
        }
    };
    if let Err(err) = nats.publish(subject, payload.into()).await {
        tracing::warn!(?err, symbol = %tick.symbol, "failed to publish tick to NATS");
    }
}
