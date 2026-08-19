//! Execution — see ../../docs/execution.md. Phase 2 default is the
//! internalized/B-book strategy (§2.1): broker is the counterparty, fills
//! come from the Market Data Core's current bid/ask, never a
//! client-supplied price (that trust was the documented MVP shortcut in
//! today's Next.js path — see ../../docs/execution.md §1 — and is exactly
//! what this module replaces).

use protocol::{Fill, OrderSide, Tick};
use rust_decimal::Decimal;

#[derive(Debug, Clone, Copy)]
pub enum ExecutionStrategy {
    /// Broker is the counterparty; fills at current bid/ask. The only
    /// strategy implemented for Phase 2 — see ../../docs/execution.md §2.1.
    Internal,
    // Aggregated(venues): external LP/FIX routing — explicitly out of
    // scope, see ../../docs/execution.md §2.2. Not implemented; kept as a
    // documented non-variant so this enum's eventual shape is discoverable
    // from the code, without pretending it exists today.
}

/// MARKET BUY fills at ask, MARKET SELL fills at bid, full volume, one
/// fill — no partial fills or slippage model for Phase 2 (see
/// ../../docs/execution.md §2.1.2). `order_id`/`volume` come from the
/// order OMS is routing; this function only decides price.
pub fn execute_market_order(
    order_id: &str,
    side: OrderSide,
    volume: Decimal,
    current: &Tick,
    strategy: ExecutionStrategy,
) -> Fill {
    match strategy {
        ExecutionStrategy::Internal => {
            let price = match side {
                OrderSide::Buy => current.ask,
                OrderSide::Sell => current.bid,
            };
            Fill {
                order_id: order_id.to_string(),
                price,
                volume,
                remaining_volume: Decimal::ZERO,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn tick() -> Tick {
        Tick {
            symbol: "EURUSD".into(),
            bid: dec!(1.10000),
            ask: dec!(1.10020),
            t0: None,
        }
    }

    #[test]
    fn buy_fills_at_ask() {
        let fill = execute_market_order("o1", OrderSide::Buy, dec!(1), &tick(), ExecutionStrategy::Internal);
        assert_eq!(fill.price, dec!(1.10020));
        assert_eq!(fill.remaining_volume, Decimal::ZERO);
    }

    #[test]
    fn sell_fills_at_bid() {
        let fill = execute_market_order("o1", OrderSide::Sell, dec!(1), &tick(), ExecutionStrategy::Internal);
        assert_eq!(fill.price, dec!(1.10000));
    }
}
