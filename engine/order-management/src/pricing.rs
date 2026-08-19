//! Broker-specific price quoting. Market Data Core's `LivePrice` is
//! deliberately broker-agnostic raw market data (see
//! ../../docs/market-data.md §3) — this is where a broker's own
//! `BrokerSymbol.spreadMarkup` actually gets applied on top of it before
//! a fill happens, closing a gap where that field existed in the schema
//! and was described in comments ("applied on top when quoting a
//! trader") but nothing ever actually read it.

use protocol::Tick;
use rust_decimal::Decimal;

/// 1 pip in price units for a symbol with this many decimal digits — the
/// standard FX convention where `digits` counts one fractional place
/// past the pip (a 5-digit broker: pip = 0.0001, the 5th digit is a
/// pipette). `digits <= 0` would be a broken `Symbol` row; treated as 1
/// digit (whole-unit pip) rather than panicking on bad data.
fn pip_size(digits: i32) -> Decimal {
    Decimal::new(1, digits.saturating_sub(1).max(0) as u32)
}

/// Widens the ask by `spread_markup` pips — bid stays raw. This is the
/// broker's actual revenue mechanism: a BUY fills worse by the markup,
/// a SELL (which fills at bid) is unaffected. Chosen over a symmetric
/// bid/ask split as the more common retail-broker convention.
pub fn apply_spread_markup(raw: &Tick, spread_markup: Decimal, digits: i32) -> Tick {
    if spread_markup.is_zero() {
        return raw.clone();
    }
    Tick {
        symbol: raw.symbol.clone(),
        bid: raw.bid,
        ask: raw.ask + spread_markup * pip_size(digits),
        t0: raw.t0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn tick() -> Tick {
        Tick { symbol: "EURUSD".into(), bid: dec!(1.10000), ask: dec!(1.10020), t0: None }
    }

    #[test]
    fn zero_markup_leaves_the_tick_unchanged() {
        let quoted = apply_spread_markup(&tick(), Decimal::ZERO, 5);
        assert_eq!(quoted.bid, dec!(1.10000));
        assert_eq!(quoted.ask, dec!(1.10020));
    }

    #[test]
    fn markup_widens_ask_only_bid_stays_raw() {
        // 5-digit symbol: pip = 0.0001, so 2 pips = 0.0002.
        let quoted = apply_spread_markup(&tick(), dec!(2), 5);
        assert_eq!(quoted.bid, dec!(1.10000));
        assert_eq!(quoted.ask, dec!(1.10040));
    }

    #[test]
    fn three_digit_symbol_uses_a_larger_pip() {
        // e.g. USDJPY-style: digits=3, pip = 0.01.
        let jpy_tick = Tick { symbol: "USDJPY".into(), bid: dec!(150.000), ask: dec!(150.020), t0: None };
        let quoted = apply_spread_markup(&jpy_tick, dec!(1.5), 3);
        assert_eq!(quoted.ask, dec!(150.035));
    }
}
