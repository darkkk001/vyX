//! NATS event publishing — see ../../docs/api.md §2.1 (the Gateway
//! subscribes to these and fans them out over WebSocket) and
//! ../../docs/trading-engine.md §2.3 for the event/subject list.
//!
//! Published only after a transaction's `commit()` succeeds (see
//! `place_market_order` in lib.rs) — an event about a transaction that
//! might still roll back would be a lie about system state.

use protocol::TradingEvent;

pub async fn connect(nats_url: &str) -> Result<async_nats::Client, async_nats::ConnectError> {
    async_nats::connect(nats_url).await
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
