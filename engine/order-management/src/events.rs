//! NATS event publishing — see ../../docs/api.md §2.1 (the Gateway
//! subscribes to these and fans them out over WebSocket) and
//! ../../docs/trading-engine.md §2.3 for the event/subject list.
//!
//! Published only after a transaction's `commit()` succeeds (see
//! `place_market_order` in lib.rs) — an event about a transaction that
//! might still roll back would be a lie about system state.

use market_data::stats::FeedStats;
use protocol::TradingEvent;
use std::sync::Arc;

// hotfix/terminal-live-bugs round 3 -- default subscription_capacity is
// already 65,536 (async-nats' own default), but the tick-driven-triggers
// subscriber (engine/server's spawn_tick_driven_triggers) processed each
// message inline before pulling the next one off this channel, so a
// prolonged burst (50 ticks/s against slower-than-that DB round trips)
// could still fill even that. Doubling it buys more headroom while that
// same fix (processing in a spawned task instead of inline) addresses the
// actual cause; this alone would only delay, not prevent, the same
// overflow under sustained load.
const SUBSCRIPTION_CAPACITY: usize = 131_072;

/// `feed_stats` gets a real-time counter of NATS-reported slow-consumer
/// events (see market_data::stats::FeedStats's own doc comment on
/// nats_slow_consumer_total) -- async-nats already logs these via its own
/// unconditional `tracing::info!` regardless of this callback, but a log
/// line alone doesn't show up in /internal/feed-stats or trip any
/// alerting on it before ticks start silently dropping (a full
/// per-subscription channel drops the message, per async-nats' own
/// try_send-or-drop semantics -- it never blocks the publisher or queues
/// past capacity).
pub async fn connect(nats_url: &str, feed_stats: Arc<FeedStats>) -> Result<async_nats::Client, async_nats::ConnectError> {
    async_nats::ConnectOptions::new()
        .subscription_capacity(SUBSCRIPTION_CAPACITY)
        .event_callback(move |event| {
            let feed_stats = feed_stats.clone();
            async move {
                if let async_nats::Event::SlowConsumer(_) = event {
                    feed_stats.record_nats_slow_consumer();
                }
            }
        })
        .connect(nats_url)
        .await
}

fn subject_for(event: &TradingEvent) -> &'static str {
    match event {
        TradingEvent::OrderAccepted { .. } => "order.accepted",
        TradingEvent::OrderRejected(_) => "order.rejected",
        TradingEvent::OrderFilled(_) => "order.filled",
        TradingEvent::OrderPartiallyFilled(_) => "order.partially_filled",
        TradingEvent::OrderCancelled { .. } => "order.cancelled",
        TradingEvent::OrderExpired { .. } => "order.expired",
        TradingEvent::MarginCall { .. } => "margin.call",
        TradingEvent::StopOut { .. } => "margin.stop_out",
        TradingEvent::StopLossHit { .. } => "position.stop_loss_hit",
        TradingEvent::TakeProfitHit { .. } => "position.take_profit_hit",
        TradingEvent::PositionClosed { .. } => "position.closed",
        TradingEvent::PositionModified { .. } => "position.modified",
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PublishError {
    #[error("failed to serialize event: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("failed to publish to NATS: {0}")]
    Publish(#[from] async_nats::PublishError),
}

pub async fn publish(client: &async_nats::Client, event: &TradingEvent) -> Result<(), PublishError> {
    let subject = subject_for(event);
    let payload = serde_json::to_vec(event)?;
    client.publish(subject, payload.into()).await?;
    Ok(())
}
