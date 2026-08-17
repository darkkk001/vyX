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
    #[error("volume {volume} is outside the allowed range [{min_lot}, {max_lot}] or not a multiple of the lot step {lot_step}")]
    InvalidLotSize {
        volume: String,
        min_lot: String,
        max_lot: String,
        lot_step: String,
    },
    #[error("symbol exposure limit exceeded: {new_total} would exceed the broker's max of {max_exposure}")]
    ExposureLimitExceeded { new_total: String, max_exposure: String },
    #[error("account already has {current} open position(s), broker max is {max}")]
    MaxOpenPositionsExceeded { current: i64, max: i32 },
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

/// §2.1 step 2: a broker can disable a symbol (`BrokerSymbol.enabled`)
/// without deleting it — existing positions stay open, but no new order
/// should be acceptable against it.
pub fn check_symbol_enabled(enabled: bool) -> Result<(), RiskRejectReason> {
    if enabled {
        Ok(())
    } else {
        Err(RiskRejectReason::SymbolDisabled)
    }
}

/// §2.1's lot-bounds half of exposure limits: `BrokerSymbol.minLot`/
/// `maxLot`/`lotStep` are broker-configurable per symbol but nothing has
/// ever enforced them. Steps are counted from `min_lot`, not zero —
/// matching MT5 convention, where e.g. min_lot=0.01/lot_step=0.01 allows
/// 0.01, 0.02, 0.03... A `lot_step` of zero (a misconfigured broker) skips
/// the step check rather than dividing by zero; the range check alone
/// still applies.
pub fn check_lot_size(
    volume: Decimal,
    min_lot: Decimal,
    max_lot: Decimal,
    lot_step: Decimal,
) -> Result<(), RiskRejectReason> {
    let in_range = volume >= min_lot && volume <= max_lot;
    let on_step = lot_step.is_zero() || {
        let steps = (volume - min_lot) / lot_step;
        steps.fract().is_zero()
    };
    if in_range && on_step {
        Ok(())
    } else {
        Err(RiskRejectReason::InvalidLotSize {
            volume: volume.to_string(),
            min_lot: min_lot.to_string(),
            max_lot: max_lot.to_string(),
            lot_step: lot_step.to_string(),
        })
    }
}

/// §2.1 step 5, first half: `BrokerSymbol.maxExposure` caps an account's
/// total open volume in one symbol, summed across every open position —
/// not a per-order limit like `check_lot_size`. `max_exposure: None`
/// (broker never configured one) always passes, matching every other
/// broker-config check in this module's "missing config doesn't block
/// trading" convention.
pub fn check_symbol_exposure(
    current_open_volume: Decimal,
    order_volume: Decimal,
    max_exposure: Option<Decimal>,
) -> Result<(), RiskRejectReason> {
    let Some(max) = max_exposure else { return Ok(()) };
    let new_total = current_open_volume + order_volume;
    if new_total <= max {
        Ok(())
    } else {
        Err(RiskRejectReason::ExposureLimitExceeded {
            new_total: new_total.to_string(),
            max_exposure: max.to_string(),
        })
    }
}

/// §2.1 step 5, second half: `Broker.maxOpenPositionsPerAccount` caps how
/// many positions (any symbol) an account can hold open at once.
/// `current_open_count` is the count *before* the order under
/// consideration would open one more.
pub fn check_max_open_positions(
    current_open_count: i64,
    max_open_positions: Option<i32>,
) -> Result<(), RiskRejectReason> {
    let Some(max) = max_open_positions else { return Ok(()) };
    if current_open_count < max as i64 {
        Ok(())
    } else {
        Err(RiskRejectReason::MaxOpenPositionsExceeded { current: current_open_count, max })
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

    #[test]
    fn symbol_enabled_check() {
        assert!(check_symbol_enabled(true).is_ok());
        assert_eq!(check_symbol_enabled(false), Err(RiskRejectReason::SymbolDisabled));
    }

    #[test]
    fn lot_size_within_range_and_on_step_is_ok() {
        assert!(check_lot_size(dec!(0.01), dec!(0.01), dec!(100), dec!(0.01)).is_ok());
        assert!(check_lot_size(dec!(1.23), dec!(0.01), dec!(100), dec!(0.01)).is_ok());
        assert!(check_lot_size(dec!(100), dec!(0.01), dec!(100), dec!(0.01)).is_ok());
    }

    #[test]
    fn lot_size_rejects_below_min_or_above_max() {
        assert!(check_lot_size(dec!(0.005), dec!(0.01), dec!(100), dec!(0.01)).is_err());
        assert!(check_lot_size(dec!(100.01), dec!(0.01), dec!(100), dec!(0.01)).is_err());
    }

    #[test]
    fn lot_size_rejects_off_step() {
        // min_lot 0.01, step 0.01 -> 0.015 isn't a whole number of steps.
        assert!(check_lot_size(dec!(0.015), dec!(0.01), dec!(100), dec!(0.01)).is_err());
    }

    #[test]
    fn lot_size_zero_step_only_checks_range() {
        assert!(check_lot_size(dec!(0.5), dec!(0.01), dec!(100), Decimal::ZERO).is_ok());
    }

    #[test]
    fn symbol_exposure_no_limit_always_passes() {
        assert!(check_symbol_exposure(dec!(1000), dec!(1000), None).is_ok());
    }

    #[test]
    fn symbol_exposure_within_limit_is_ok() {
        assert!(check_symbol_exposure(dec!(3), dec!(2), Some(dec!(5))).is_ok());
    }

    #[test]
    fn symbol_exposure_rejects_when_new_total_exceeds_max() {
        assert!(check_symbol_exposure(dec!(4), dec!(2), Some(dec!(5))).is_err());
    }

    #[test]
    fn max_open_positions_no_limit_always_passes() {
        assert!(check_max_open_positions(1000, None).is_ok());
    }

    #[test]
    fn max_open_positions_rejects_at_or_above_max() {
        assert!(check_max_open_positions(4, Some(5)).is_ok());
        assert!(check_max_open_positions(5, Some(5)).is_err());
        assert!(check_max_open_positions(6, Some(5)).is_err());
    }
}
