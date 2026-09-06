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
    // EA's own clock-vs-engine-UTC offset and the round-trip time it was
    // measured with (GET /internal/time handshake, see the EA's
    // SyncClockOffset) -- sent on every tick in a batch (the EA only
    // re-measures every 60s and reuses the same value meanwhile) purely
    // so market_data::stats can surface the handshake quality in
    // /internal/feed-stats. Not used to adjust t0 itself -- the EA has
    // already applied its own offset before t0 is computed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clock_offset_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<i64>,
    // The REAL last-tick time, UTC epoch ms -- MT5's own SymbolInfoTick's
    // time_msc for this symbol, corrected from broker-server time to UTC
    // (mt5-ea/VyXTraderPriceFeed.mq5's BrokerOffsetSec, the same
    // correction already applied to CopyRates bar times). Unlike t0 above
    // (recomputed fresh on every send, including heartbeat resends of an
    // unchanged price -- "when did I send this," not "when did the
    // market actually last move"), this field carries the ORIGINAL tick's
    // own timestamp even on a heartbeat resend, since the EA only updates
    // its tracked time_msc when SymbolInfoTick reports a real change. This
    // is what a genuine staleness check (LivePrice.tickAt,
    // lib/risk.ts's checkPriceFreshness) needs: t0 alone can't tell a
    // live, unchanged-but-current price apart from a frozen weekend one,
    // since both produce a fresh-looking t0 on every heartbeat.
    // Optional for the same reason t0 is -- an EA build that predates this
    // field, or a test constructing a bare Tick, doesn't set it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tick_ms: Option<i64>,
    // EA's BrokerOffsetSec (TimeTradeServer() - TimeGMT(), seconds) --
    // the broker-server-to-UTC offset, recomputed by the EA on every
    // clock sync so a DST shift is picked up without an EA restart (see
    // BrokerOffsetSec's own comment in the EA). Already used to convert
    // CopyRates bar times and tick_ms above to real UTC on the EA side;
    // sent here too, on every tick, so the live aggregation path
    // (market_data::bucket_start) can align D1/W1/Mn1/Y1 candle buckets
    // to the broker's own day boundary instead of naive UTC midnight --
    // see bucket_start's own doc comment for why that was wrong (it
    // silently produced a second, competing D1 bar for every real
    // trading day once the broker's server time doesn't line up with
    // UTC midnight, which for a UTC+3 broker like Pepperstone is always).
    // Optional for the same reason tick_ms is -- an EA build that
    // predates this field doesn't set it, and the tracker that consumes
    // this just keeps using the last value it did see (or 0, pure UTC,
    // today's behavior, if none has ever arrived).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broker_offset_sec: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fill {
    pub order_id: String,
    pub account_id: String,
    pub price: Decimal,
    pub volume: Decimal,
    pub remaining_volume: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskRejection {
    pub order_id: String,
    pub account_id: String,
    pub reason: String,
}

/// Events published to NATS by the Trading Core; the API Gateway
/// subscribes and fans these out over WebSocket. See docs/api.md §2.1.
///
/// Every variant carries `account_id` (directly or via `Fill`/
/// `RiskRejection`) so the Gateway can route a message to only the
/// WebSocket connections for that account without a DB lookup per event
/// — see services/api-gateway/src/ws.ts's `attachTradingEventStream`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TradingEvent {
    OrderAccepted { order_id: String, account_id: String },
    OrderRejected(RiskRejection),
    OrderFilled(Fill),
    OrderPartiallyFilled(Fill),
    OrderCancelled { order_id: String, account_id: String },
    OrderExpired { order_id: String, account_id: String },
    MarginCall { account_id: String, margin_level: Decimal },
    StopOut { account_id: String, closed_position_ids: Vec<String> },
    /// Position auto-closed because price crossed the trader's own
    /// stop-loss/take-profit level — distinct from `StopOut`, which is
    /// margin-ratio-driven and independent of any per-position SL/TP the
    /// trader set. See docs/risk-engine.md §2.2 / order_management::monitor.
    StopLossHit { account_id: String, position_id: String },
    TakeProfitHit { account_id: String, position_id: String },
    /// Trader- or dealer-initiated close (full or partial) — distinct from
    /// `StopLossHit`/`TakeProfitHit`/`StopOut`, which are all
    /// system-initiated. Published by the legacy Next.js close route too
    /// (docs/webtrader-stm-architecture-review.md §4.3) since the Rust
    /// engine has no manual-close route yet.
    PositionClosed { account_id: String, position_id: String },
    /// SL/TP edited on an open position.
    PositionModified { account_id: String, position_id: String },
}
