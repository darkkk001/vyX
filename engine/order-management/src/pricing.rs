//! Broker-specific price quoting. Market Data Core's `LivePrice` is
//! deliberately broker-agnostic raw market data (see
//! ../../docs/market-data.md §3) — this is where the account's own pricing
//! rule gets applied on top of it before a fill happens.
//!
//! FLIP L2 (2026-11-02). This module used to hold its own `apply_spread_markup`,
//! which read ONLY `BrokerSymbol.spreadMarkup` and moved ONLY the ask. Both
//! halves of that had been overtaken by the engine's own quoting:
//!
//!   1. HIERARCHY. Quoting resolves account → group → broker
//!      (`market_data::ask_markup::resolve`, mirroring lib/ask-markup.ts). This
//!      path skipped the top two levels, so at `ENGINE_ORDER_MANAGEMENT=on` every
//!      GroupSymbolConfig / AccountSymbolConfig markup and every target-spread
//!      rule would silently vanish from the fill and the broker would charge its
//!      own default instead.
//!   2. SIDE. The symmetric change (2026-10-29) splits the markup across both
//!      sides and preserves the raw mid. This path still widened the ask alone, so
//!      a BUY would fill at the quoted price while a SELL filled at the RAW bid —
//!      a quote-vs-fill mismatch, in the client's favour on one side.
//!
//! There is now no way to apply a markup here except through a resolved
//! `AskRule`, so neither mistake can come back: the only entry point takes one.

use market_data::ask_markup::{self, AskRule};
use protocol::Tick;

/// The account's own two prices for this tick, from its resolved rule.
///
/// `None` (the broker does not carry the symbol at all — no `BrokerSymbol` row)
/// leaves the tick raw, which is the long-standing fallback of both fill sites and
/// of `PricingSnapshot::rule`. A rule that would cross the book is also left raw:
/// `account_quote` refuses it, and a fill must never price off a crossed quote.
pub fn quoted_tick(raw: &Tick, rule: Option<&AskRule>) -> Tick {
    let Some(rule) = rule else { return raw.clone() };
    let Some((bid, ask)) = ask_markup::account_quote(rule, raw.bid, raw.ask) else {
        return raw.clone();
    };
    Tick {
        symbol: raw.symbol.clone(),
        bid: bid.get(),
        ask: ask.get(),
        t0: raw.t0,
        clock_offset_ms: raw.clock_offset_ms,
        rtt_ms: raw.rtt_ms,
        tick_ms: raw.tick_ms,
        broker_offset_sec: raw.broker_offset_sec,
        bars: raw.bars.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;

    fn tick() -> Tick {
        Tick { symbol: "EURUSD".into(), bid: dec!(1.10000), ask: dec!(1.10020), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None, bars: Vec::new() }
    }

    #[test]
    fn no_rule_leaves_the_tick_untouched() {
        let quoted = quoted_tick(&tick(), None);
        assert_eq!((quoted.bid, quoted.ask), (dec!(1.10000), dec!(1.10020)));
    }

    #[test]
    fn zero_markup_leaves_the_tick_unchanged() {
        let quoted = quoted_tick(&tick(), Some(&AskRule::Markup { markup_pips: Decimal::ZERO, digits: 5 }));
        assert_eq!((quoted.bid, quoted.ask), (dec!(1.10000), dec!(1.10020)));
    }

    #[test]
    fn a_markup_moves_both_sides_by_half_and_keeps_the_mid() {
        // 5-digit symbol: pip = 0.0001, so 2 pips = 0.0002 of spread, 0.0001 per side.
        let raw = tick();
        let quoted = quoted_tick(&raw, Some(&AskRule::Markup { markup_pips: dec!(2), digits: 5 }));
        assert_eq!((quoted.bid, quoted.ask), (dec!(1.09990), dec!(1.10030)));
        assert_eq!(quoted.ask - quoted.bid, (raw.ask - raw.bid) + dec!(0.00020), "the spread widens by exactly the markup");
        assert_eq!(quoted.bid + quoted.ask, raw.bid + raw.ask, "the mid is preserved");
    }

    #[test]
    fn three_digit_symbol_uses_a_larger_pip() {
        // USDJPY-style: digits=3, pip = 0.01, so 1.5 pips = 0.015 of spread, 0.0075 per side,
        // each rounded AWAY from the client at 3 digits.
        let jpy = Tick { symbol: "USDJPY".into(), bid: dec!(150.000), ask: dec!(150.020), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None, bars: Vec::new() };
        let quoted = quoted_tick(&jpy, Some(&AskRule::Markup { markup_pips: dec!(1.5), digits: 3 }));
        assert_eq!((quoted.bid, quoted.ask), (dec!(149.992), dec!(150.028)));
    }

    #[test]
    fn a_target_rule_is_honoured_here_too_not_only_when_quoting() {
        // target 5 pips (0.0005) over a 2-pip raw spread: the quote straddles the raw mid at that width.
        // Under the old broker-only call this rule could not be expressed at all.
        let raw = tick();
        let quoted = quoted_tick(&raw, Some(&AskRule::Target { target_pips: dec!(5), fallback_pips: None, digits: 5 }));
        assert_eq!(quoted.ask - quoted.bid, dec!(0.00050));
        assert_eq!(quoted.bid + quoted.ask, raw.bid + raw.ask, "the mid is preserved");
    }

    #[test]
    fn a_negative_markup_can_never_tighten_the_book() {
        let raw = tick();
        let quoted = quoted_tick(&raw, Some(&AskRule::Markup { markup_pips: dec!(-500), digits: 5 }));
        assert!(quoted.bid <= raw.bid && quoted.ask >= raw.ask, "neither side may move in the client's favour");
    }
}
