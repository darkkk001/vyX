//! Quote-currency -> account-currency conversion (Rust cutover Stage 2, F2): a port of lib/fx.ts, same
//! rule, same test cases. A position's P&L and its margin notional come out in the symbol's QUOTE currency
//! (USDJPY in JPY); every money figure is multiplied by `conversion_rate(quote, account)` before it is added
//! to a balance, an equity or a used margin. Same currency is exactly 1 and needs no price.
//!
//! Rate = the MID of the conversion pair's latest quote: the pair itself, its inverse, or a cross through
//! USD. Freshness is not required (a few minutes' drift is a fraction of a percent; no conversion is wrong by
//! the whole exchange rate). A missing rate is None, and the caller treats that position as unpriced.

use rust_decimal::Decimal;

/// bid / ask of one symbol's latest quote
pub type Quote = (Decimal, Decimal);

fn mid(q: Option<Quote>) -> Option<Decimal> {
    let (bid, ask) = q?;
    let m = (bid + ask) / Decimal::TWO;
    (m > Decimal::ZERO).then_some(m)
}

fn direct<F: Fn(&str) -> Option<Quote>>(from: &str, to: &str, lookup: &F) -> Option<Decimal> {
    if let Some(d) = mid(lookup(&format!("{from}{to}"))) {
        return Some(d);
    }
    mid(lookup(&format!("{to}{from}"))).map(|inv| Decimal::ONE / inv)
}

/// Multiply an amount in `from` by this to get `to`. None = no price to convert with.
pub fn conversion_rate<F: Fn(&str) -> Option<Quote>>(from: &str, to: &str, lookup: F) -> Option<Decimal> {
    let f = from.trim().to_uppercase();
    let t = to.trim().to_uppercase();
    if f == t {
        return Some(Decimal::ONE);
    }
    if let Some(d) = direct(&f, &t, &lookup) {
        return Some(d);
    }
    if f != "USD" && t != "USD" {
        let a = direct(&f, "USD", &lookup)?;
        let b = direct("USD", &t, &lookup)?;
        return Some(a * b);
    }
    None
}

/// Every symbol `conversion_rate` may read for from -> to (none when they match).
pub fn conversion_symbols_for(from: &str, to: &str) -> Vec<String> {
    let f = from.trim().to_uppercase();
    let t = to.trim().to_uppercase();
    if f == t {
        return Vec::new();
    }
    let mut out = vec![format!("{f}{t}"), format!("{t}{f}")];
    if f != "USD" && t != "USD" {
        out.extend([format!("{f}USD"), format!("USD{f}"), format!("{t}USD"), format!("USD{t}")]);
    }
    out
}

/// A realized P&L in the account currency, rounded exactly like lib/position-close.ts: unchanged when the rate
/// is 1, otherwise to 4 dp half away from zero (decimal.js ROUND_HALF_UP, what Prisma.Decimal uses).
pub fn convert_pnl(quote_pnl: Decimal, rate: Decimal) -> Decimal {
    if rate == Decimal::ONE {
        quote_pnl
    } else {
        (quote_pnl * rate).round_dp_with_strategy(4, rust_decimal::RoundingStrategy::MidpointAwayFromZero)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;
    use std::collections::HashMap;

    // lib/fx.test.ts, case for case
    fn book(quotes: &[(&str, Decimal, Decimal)]) -> impl Fn(&str) -> Option<Quote> {
        let m: HashMap<String, Quote> = quotes.iter().map(|(s, b, a)| (s.to_string(), (*b, *a))).collect();
        move |s| m.get(s).copied()
    }

    #[test]
    fn same_currency_is_exactly_one() {
        assert_eq!(conversion_rate("USD", "usd", book(&[])), Some(Decimal::ONE));
    }

    #[test]
    fn direct_pair_mid() {
        assert_eq!(conversion_rate("GBP", "USD", book(&[("GBPUSD", dec!(1.35000), dec!(1.35020))])), Some(dec!(1.3501)));
    }

    #[test]
    fn inverse_pair() {
        let r = conversion_rate("JPY", "USD", book(&[("USDJPY", dec!(149.990), dec!(150.010))])).unwrap();
        assert_eq!((r * dec!(150)).round_dp(10), Decimal::ONE);
    }

    #[test]
    fn cross_through_usd() {
        let r = conversion_rate("JPY", "EUR", book(&[("USDJPY", dec!(150), dec!(150)), ("EURUSD", dec!(1.2), dec!(1.2))])).unwrap();
        assert_eq!(r.round_dp(12), (Decimal::ONE / dec!(150) / dec!(1.2)).round_dp(12));
    }

    #[test]
    fn nothing_to_convert_with_and_zero_quote() {
        assert_eq!(conversion_rate("JPY", "USD", book(&[])), None);
        assert_eq!(conversion_rate("JPY", "USD", book(&[("USDJPY", dec!(0), dec!(0))])), None);
    }

    #[test]
    fn usdjpy_ten_pip_win_is_usd() {
        let pnl_jpy = (dec!(150.100) - dec!(150.000)) * dec!(100000);
        let r = conversion_rate("JPY", "USD", book(&[("USDJPY", dec!(150.000), dec!(150.000))])).unwrap();
        assert_eq!((pnl_jpy * r).round_dp(2), dec!(66.67));
        assert_eq!(convert_pnl(pnl_jpy, r), dec!(66.6667));
    }

    #[test]
    fn symbols_it_may_read() {
        assert!(conversion_symbols_for("USD", "USD").is_empty());
        assert_eq!(conversion_symbols_for("JPY", "USD"), vec!["JPYUSD", "USDJPY"]);
        assert_eq!(conversion_symbols_for("JPY", "EUR"), vec!["JPYEUR", "EURJPY", "JPYUSD", "USDJPY", "EURUSD", "USDEUR"]);
    }

    #[test]
    fn convert_pnl_rounds_half_away_from_zero_like_decimal_js() {
        assert_eq!(convert_pnl(dec!(-150000), Decimal::ONE / dec!(148.5)), dec!(-1010.1010));
        assert_eq!(convert_pnl(dec!(0.00005), dec!(2)), dec!(0.0001)); // 0.0001 exactly, no rounding
        assert_eq!(convert_pnl(dec!(0.000025), dec!(2)), dec!(0.0001)); // 0.00005 -> away from zero
        assert_eq!(convert_pnl(dec!(123.45), Decimal::ONE), dec!(123.45)); // rate 1: untouched
    }
}
