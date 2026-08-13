//! Ledger — replaces the existing single-row Prisma `Transaction` model
//! for brokers cut over to the Rust core (see ../../docs/database.md §5:
//! open question, double-entry vs single-row-per-transaction schema not
//! yet decided). This crate is a placeholder until that schema decision
//! is made — deliberately not guessing at a shape here.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntryType {
    Deposit,
    Withdrawal,
    RealizedPnl,
    Commission,
    Swap,
    CreditAdjustment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub id: String,
    pub account_id: String,
    pub entry_type: EntryType,
    pub amount: Decimal,
    pub related_position_id: Option<String>,
}
