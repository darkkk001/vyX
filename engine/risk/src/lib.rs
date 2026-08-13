//! Risk & Margin — see ../../docs/risk-engine.md. Pre-trade checks (§2.1)
//! are implemented here since they're pure functions with no I/O; the
//! ongoing margin-monitor loop (§2.2) needs a live price feed and Postgres
//! access and is Phase 2 work once market-data/position are wired up.

use rust_decimal::Decimal;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RiskRejectReason {
    #[error("insufficient free margin: required {required}, available {available}")]
    InsufficientMargin { required: String, available: String },
    #[error("account is not active")]
    AccountNotActive,
    #[error("symbol is not enabled for trading on this broker")]
    SymbolDisabled,
}

/// Standard forex margin formula, per ../../docs/risk-engine.md §2.1.3:
/// volume * contract_size * price / leverage.
pub fn required_margin(volume: Decimal, contract_size: Decimal, price: Decimal, leverage: u32) -> Decimal {
    volume * contract_size * price / Decimal::from(leverage)
}

/// Margin level = equity / used_margin * 100, per ../../docs/risk-engine.md
/// §2.2. Returns None when used_margin is zero (no open positions) since
/// margin level is meaningless — not a divide-by-zero bug to paper over.
pub fn margin_level(equity: Decimal, used_margin: Decimal) -> Option<Decimal> {
    if used_margin.is_zero() {
        None
    } else {
        Some(equity / used_margin * Decimal::from(100))
    }
}

pub fn check_free_margin(
    equity: Decimal,
    used_margin: Decimal,
    required: Decimal,
) -> Result<(), RiskRejectReason> {
    let free = equity - used_margin;
    if free >= required {
        Ok(())
    } else {
        Err(RiskRejectReason::InsufficientMargin {
            required: required.to_string(),
            available: free.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn required_margin_standard_lot_1_to_100() {
        // 1 lot EURUSD (contract size 100,000) at 1.10000, 1:100 leverage.
        let m = required_margin(dec!(1), dec!(100000), dec!(1.10000), 100);
        assert_eq!(m, dec!(1100.00000));
    }

    #[test]
    fn margin_level_none_when_flat() {
        assert_eq!(margin_level(dec!(1000), dec!(0)), None);
    }

    #[test]
    fn margin_level_computed_when_positions_open() {
        assert_eq!(margin_level(dec!(2000), dec!(1000)), Some(dec!(200)));
    }

    #[test]
    fn rejects_when_free_margin_insufficient() {
        let result = check_free_margin(dec!(1000), dec!(500), dec!(600));
        assert!(result.is_err());
    }

    #[test]
    fn accepts_when_free_margin_sufficient() {
        let result = check_free_margin(dec!(1000), dec!(200), dec!(600));
        assert!(result.is_ok());
    }
}
