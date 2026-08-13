//! Shared types passed between engine crates and across the NATS event bus.
//! Mirrors the state machine documented in ../../docs/architecture.md §5
//! and ../../docs/trading-engine.md §2.1 — this is the authoritative Rust
//! definition; the docs describe it, this enforces it at the type level.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderType {
    Market,
    Limit,
    Stop,
    // StopLimit, TrailingStop: new order types with no current-system
    // equivalent — see docs/trading-engine.md §2.2. Not added yet; add
    // when Phase 2 actually implements their trigger logic.
}

/// Superset of the existing Prisma `OrderStatus` enum
/// (PENDING -> ACCEPTED -> FILLED/REJECTED/CANCELLED). See
/// docs/trading-engine.md §2.1 for the full transition diagram.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderStatus {
    New,
    Validating,
    Accepted,
    Rejected,
    Routing,
    PartiallyFilled,
    Filled,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tick {
    pub symbol: String,
    pub bid: Decimal,
    pub ask: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fill {
    pub order_id: String,
    pub price: Decimal,
    pub volume: Decimal,
    pub remaining_volume: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskRejection {
    pub order_id: String,
    pub reason: String,
}

/// Events published to NATS by the Trading Core; the API Gateway
/// subscribes and fans these out over WebSocket. See docs/api.md §2.1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TradingEvent {
    OrderAccepted { order_id: String },
    OrderRejected(RiskRejection),
    OrderFilled(Fill),
    OrderPartiallyFilled(Fill),
    OrderCancelled { order_id: String },
    OrderExpired { order_id: String },
    MarginCall { account_id: String, margin_level: Decimal },
    StopOut { account_id: String, closed_position_ids: Vec<String> },
}
