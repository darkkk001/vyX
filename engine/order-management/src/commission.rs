//! Which level's `commissionPerLot` a fill is charged at.
//!
//! The twin of [`market_data::ask_markup::resolve`] for the per-lot fee, and deliberately the same
//! SHAPE, because it is the same hierarchy and the same pricing-engine switch: see that function's
//! early `if !l.pricing_engine` return, which this mirrors line for line.
//!
//! Pinned by `docs/contracts/ask-markup-vectors.json`'s `commissionResolution` array (13 cases,
//! generated from the web's own `lib/ask-markup.ts`), asserted in
//! `tests/commission_resolution.rs`. The contract's own words:
//!
//!   Pricing engine OFF: GroupSymbolConfig.commissionPerLot > BrokerSymbol.commissionPerLot
//!                       (an AccountSymbolConfig row is IGNORED).
//!   Pricing engine ON:  AccountSymbolConfig > GroupSymbolConfig > BrokerSymbol.
//!   Per field, a null falls through EVEN WHEN THE ROW EXISTS. An explicit 0 is a real zero.
//!   No account-type level (D4: AccountType.commissionPerLot is not resolved).
//!
//! WHY THIS EXISTS AT ALL (2026-11-10). Until now the engine read `commissionPerLot` from
//! `BrokerSymbol` and nowhere else -- `db.rs`'s one-round-trip open snapshot selected
//! `COALESCE(bs."commissionPerLot", 0)` while selecting the MARKUP from all three levels beside it,
//! and the pending-fill path read it from `get_broker_symbol_config`. So a group that priced
//! commission instead of spread (futurixglobal's "Zero" group: 0.10 per lot across 15 symbols) was
//! charged NOTHING on an engine fill while the web charged it correctly. It was never a regression --
//! `git log -S` finds no commit where the engine ever read a group commission -- and no test caught it
//! because the only commission contract (`open-chain-vector.json`) hands the per-lot rate in as an
//! argument on both sides, pinning the ledger CHAIN and never the LEVEL.

use rust_decimal::Decimal;

/// The levels a fill's per-lot commission is resolved from, read together in one go.
///
/// `broker` is not an `Option`: the open snapshot COALESCEs a missing `BrokerSymbol` row to 0, which is
/// the bottom of the hierarchy and the "no commission configured" default. The two above it ARE
/// `Option`, and that is load-bearing rather than incidental -- `None` is a SQL NULL (no row, or a row
/// whose column is null) and falls through, while `Some(0)` is an explicit zero the broker set on
/// purpose and wins. COALESCEing either of them would silently turn "VIP pays nothing" into "fall back
/// to the broker's rate", which is the contract's "an explicit 0 on the account-symbol beats the group
/// (VIP zero, not unset)" case.
#[derive(Clone, Copy, Debug)]
pub struct CommissionLevels {
    /// `Broker.pricingEngineEnabled`. OFF, the account-symbol level does not exist for pricing.
    pub pricing_engine: bool,
    pub account_symbol: Option<Decimal>,
    pub group: Option<Decimal>,
    pub broker: Decimal,
}

/// The per-lot rate this fill is charged at. `charge = rate * volume`, unrounded, and
/// `db::record_commission` already declines to write a charge that is `<= 0`.
pub fn resolve_per_lot(l: &CommissionLevels) -> Decimal {
    if !l.pricing_engine {
        // The account-symbol level is not consulted at all -- not "falls through", IGNORED. Same as
        // ask_markup::resolve, which reads only the group when the engine is off.
        return l.group.unwrap_or(l.broker);
    }
    l.account_symbol.or(l.group).unwrap_or(l.broker)
}
