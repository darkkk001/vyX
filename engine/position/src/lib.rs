//! Position tracking — applies OMS fills to open/increase/reduce/close a
//! position and maintains live P&L. Mirrors the existing Prisma `Position`
//! model's shape (see ../../docs/database.md §3) but is Rust-owned once a
//! broker cuts over. Phase 2 work — this crate is a placeholder so the
//! workspace members list (../Cargo.toml) and inter-crate dependency graph
//! exist ahead of that implementation, per ../../docs/architecture.md §7's
//! phase ordering (Phase 1 = workspace scaffold, Phase 2 = the modules
//! themselves).

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PositionStatus {
    Open,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub id: String,
    pub account_id: String,
    pub symbol: String,
    pub side: protocol::OrderSide,
    pub volume: Decimal,
    pub open_price: Decimal,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
    pub status: PositionStatus,
}
