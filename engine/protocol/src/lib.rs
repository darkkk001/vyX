//! Shared types passed between engine crates and across the NATS event bus.
//! Mirrors the state machine documented in ../../docs/architecture.md §5
//! and ../../docs/trading-engine.md §2.1 — this is the authoritative Rust
//! definition; the docs describe it, this enforces it at the type level.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

// SCREAMING_SNAKE_CASE on the wire to match the existing Next.js API's
// JSON convention ("BUY"/"SELL", see app/api/trade/orders/route.ts) —
// the Rust variant names stay idiomatic PascalCase, only the serde
// representation changes, so this crate's Rust call sites are unaffected.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrderSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
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
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
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
    // Origin timestamp, ms since epoch, set by the producer at capture
    // time (mt5-ea/VyXTraderPriceFeed.mq5's OnTimer) -- optional since
    // not every producer sets it (older EA builds, tests). Used purely
    // for the market_data::stats latency audit, never for ordering or
    // business logic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t0: Option<i64>,
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
    /// Position auto-closed because price crossed the trader's own
    /// stop-loss/take-profit level — distinct from `StopOut`, which is
    /// margin-ratio-driven and independent of any per-position SL/TP the
    /// trader set. See docs/risk-engine.md §2.2 / order_management::monitor.
    StopLossHit { account_id: String, position_id: String },
    TakeProfitHit { account_id: String, position_id: String },
}
