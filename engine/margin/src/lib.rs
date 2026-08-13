//! Ongoing margin monitoring — see ../../docs/risk-engine.md §2.2.
//! Separate crate from `risk` because this is a continuous, price-tick-
//! driven loop (margin call / stop-out) rather than a synchronous
//! pre-trade gate — `risk` handles the gate, this handles the monitor.
//! The loop itself needs a live price feed and Postgres access (Phase 2);
//! this crate currently holds only the pure decision logic so it's
//! unit-testable without either dependency.

use risk::margin_level;
use rust_decimal::Decimal;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorAction {
    Ok,
    MarginCall,
    StopOut,
}

/// Broker-configurable thresholds, per ../../docs/risk-engine.md §2.2.
/// Defaults match the doc's suggested sane defaults (100% call, 50%
/// stop-out) — actual broker-level config storage is Phase 2 work.
#[derive(Debug, Clone, Copy)]
pub struct MarginThresholds {
    pub call_level: Decimal,
    pub stop_out_level: Decimal,
}

impl Default for MarginThresholds {
    fn default() -> Self {
        Self {
            call_level: Decimal::from(100),
            stop_out_level: Decimal::from(50),
        }
    }
}

pub fn evaluate(equity: Decimal, used_margin: Decimal, thresholds: MarginThresholds) -> MonitorAction {
    match margin_level(equity, used_margin) {
        None => MonitorAction::Ok, // flat account, nothing to monitor
        Some(level) if level < thresholds.stop_out_level => MonitorAction::StopOut,
        Some(level) if level < thresholds.call_level => MonitorAction::MarginCall,
        Some(_) => MonitorAction::Ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn ok_above_call_level() {
        let action = evaluate(dec!(2000), dec!(1000), MarginThresholds::default());
        assert_eq!(action, MonitorAction::Ok);
    }

    #[test]
    fn margin_call_between_thresholds() {
        // level = 75% — below 100 call, above 50 stop-out
        let action = evaluate(dec!(750), dec!(1000), MarginThresholds::default());
        assert_eq!(action, MonitorAction::MarginCall);
    }

    #[test]
    fn stop_out_below_floor() {
        let action = evaluate(dec!(300), dec!(1000), MarginThresholds::default());
        assert_eq!(action, MonitorAction::StopOut);
    }
}
