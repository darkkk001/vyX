//! The account's ask (owner decision 2026-09-26): every ask-side execution uses the account's marked-up ask -- a BUY
//! open AND a SELL close, including a SELL's SL / TP trigger, its stop-out, and every valuation of an open SELL at the
//! price it would close at. A BUY closes at the raw bid; the bid is never marked up.
//!
//! The Rust port of lib/ask-markup.ts, pinned to it by docs/contracts/ask-markup-vectors.json (the test below reads the
//! file). Lives here, not in order-management, because market-data's risk hook needs it too (SL / TP levels and resting
//! BUY entries are checked against the account's ask) and cannot depend on order-management.
//!
//! Resolution, per (account, symbol), exactly the web's fill path (lib/pricing-engine.ts resolveFillPricing):
//! - no BrokerSymbol row: no rule (the raw ask), as the web's loadAskRules skips the pair;
//! - the broker's coverage account (its group is COVERAGE, or Broker.coverageAccountId): raw, always;
//! - pricing engine off: GroupSymbolConfig.spreadMarkup, else BrokerSymbol.spreadMarkup (a target is never read);
//! - pricing engine on: the first level that sets a spread (markup or target; target wins within a level, its markup
//!   rides along as the fallback) of AccountSymbolConfig, AccountTypeSymbolConfig, then AccountType.spreadMarkup (flat,
//!   markup only), then GroupSymbolConfig, then BrokerSymbol.spreadMarkup.
//!
//! Price: pip = 10^-(digits-1) (digits <= 1: 1). markup mode: ask + markup x pip. target mode: markup = target - the live
//! raw spread in pips, floored at 0 -> ask + markup x pip.

use protocol::OrderSide;
use rust_decimal::Decimal;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskRule {
    Markup { markup_pips: Decimal, digits: i32 },
    Target { target_pips: Decimal, fallback_pips: Option<Decimal>, digits: i32 },
}

/// 1 pip in price units (lib/group-pricing.ts pipSize, pricing.rs pip_size).
pub fn pip_size(digits: i32) -> Decimal {
    Decimal::new(1, digits.saturating_sub(1).max(0) as u32)
}

/// One per-symbol config level: a markup and / or a target, in pips.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Level {
    pub markup: Option<Decimal>,
    pub target: Option<Decimal>,
}

/// Everything the rule of one (account, symbol) depends on, as read from the book.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AskLevels {
    pub pricing_engine: bool,
    pub coverage: bool,
    pub digits: i32,
    /// BrokerSymbol.spreadMarkup; None = no BrokerSymbol row for this broker and symbol.
    pub broker: Option<Decimal>,
    pub group: Level,
    /// AccountType.spreadMarkup (the flat level: markup only).
    pub account_type: Option<Decimal>,
    pub account_type_symbol: Level,
    pub account_symbol: Level,
}

fn level_rule(l: &Level, digits: i32) -> Option<AskRule> {
    if let Some(target_pips) = l.target {
        return Some(AskRule::Target { target_pips, fallback_pips: l.markup, digits });
    }
    l.markup.map(|markup_pips| AskRule::Markup { markup_pips, digits })
}

/// The rule, or None (the raw ask) when the broker does not carry the symbol.
pub fn resolve(l: &AskLevels) -> Option<AskRule> {
    let broker = l.broker?;
    let digits = l.digits;
    if l.coverage {
        return Some(AskRule::Markup { markup_pips: Decimal::ZERO, digits });
    }
    if !l.pricing_engine {
        return Some(AskRule::Markup { markup_pips: l.group.markup.unwrap_or(broker), digits });
    }
    Some(
        level_rule(&l.account_symbol, digits)
            .or_else(|| level_rule(&l.account_type_symbol, digits))
            .or_else(|| l.account_type.map(|markup_pips| AskRule::Markup { markup_pips, digits }))
            .or_else(|| level_rule(&l.group, digits))
            .unwrap_or(AskRule::Markup { markup_pips: broker, digits }),
    )
}

/// The markup in pips this rule applies at this tick (lib/pricing-engine.ts resolveEffectiveSpreadMarkup).
pub fn markup_pips_at(rule: &AskRule, bid: Decimal, ask: Decimal) -> Decimal {
    match *rule {
        AskRule::Markup { markup_pips, .. } => markup_pips,
        AskRule::Target { target_pips, digits, .. } => {
            let base = (ask - bid) / pip_size(digits);
            let diff = target_pips - base;
            if diff.is_sign_negative() && !diff.is_zero() { Decimal::ZERO } else { diff }
        }
    }
}

/// The account's ask: raw ask + markup x pip (the BUY fill price, pricing.rs apply_spread_markup's formula).
pub fn account_ask(rule: &AskRule, bid: Decimal, ask: Decimal) -> Decimal {
    let m = markup_pips_at(rule, bid, ask);
    if m.is_zero() {
        return ask;
    }
    let digits = match *rule {
        AskRule::Markup { digits, .. } | AskRule::Target { digits, .. } => digits,
    };
    ask + m * pip_size(digits)
}

/// The price an open position closes at for its account: a BUY at the raw bid, a SELL at the account's ask (no rule =
/// the raw ask).
pub fn close_price(side: OrderSide, bid: Decimal, ask: Decimal, rule: Option<&AskRule>) -> Decimal {
    match side {
        OrderSide::Buy => bid,
        OrderSide::Sell => rule.map_or(ask, |r| account_ask(r, bid, ask)),
    }
}

/// The joins a query adds to read the levels of its rows' (account, symbol). The query must alias the account `a` and
/// the symbol `s`; every joined table is prefixed `am_` so it never clashes with the query's own aliases.
pub const LEVELS_JOINS: &str = r#"
    LEFT JOIN "Broker" am_b ON am_b.id = a."brokerId"
    LEFT JOIN "Group" am_g ON am_g.id = a."groupId"
    LEFT JOIN "BrokerSymbol" am_bs ON am_bs."brokerId" = a."brokerId" AND am_bs."symbolId" = s.id
    LEFT JOIN "GroupSymbolConfig" am_gsc ON am_gsc."groupId" = a."groupId" AND am_gsc."symbolId" = s.id
    LEFT JOIN "AccountType" am_at ON am_at.id = a."accountTypeId"
    LEFT JOIN "AccountTypeSymbolConfig" am_atsc ON am_atsc."accountTypeId" = a."accountTypeId" AND am_atsc."symbolId" = s.id
    LEFT JOIN "AccountSymbolConfig" am_asc ON am_asc."accountId" = a.id AND am_asc."symbolId" = s.id "#;

/// The columns those joins provide, read back by `levels_from_row`.
pub const LEVELS_COLUMNS: &str = r#"
    COALESCE(am_b."pricingEngineEnabled", false) AS am_engine,
    (COALESCE(am_g.category::text = 'COVERAGE', false) OR COALESCE(am_b."coverageAccountId" = a.id, false)) AS am_coverage,
    s.digits AS am_digits,
    am_bs."spreadMarkup" AS am_broker,
    am_gsc."spreadMarkup" AS am_g_m, am_gsc."targetTotalSpreadPips" AS am_g_t,
    am_at."spreadMarkup" AS am_at_m,
    am_atsc."spreadMarkup" AS am_ats_m, am_atsc."targetTotalSpreadPips" AS am_ats_t,
    am_asc."spreadMarkup" AS am_as_m, am_asc."targetTotalSpreadPips" AS am_as_t "#;

/// The levels of one row of a query that selected `LEVELS_COLUMNS` (with `LEVELS_JOINS`).
pub fn levels_from_row(row: &sqlx::postgres::PgRow) -> Result<AskLevels, sqlx::Error> {
    use sqlx::Row;
    let lvl = |m: &str, t: &str| -> Result<Level, sqlx::Error> { Ok(Level { markup: row.try_get(m)?, target: row.try_get(t)? }) };
    Ok(AskLevels {
        pricing_engine: row.try_get("am_engine")?,
        coverage: row.try_get("am_coverage")?,
        digits: row.try_get("am_digits")?,
        broker: row.try_get("am_broker")?,
        group: lvl("am_g_m", "am_g_t")?,
        account_type: row.try_get("am_at_m")?,
        account_type_symbol: lvl("am_ats_m", "am_ats_t")?,
        account_symbol: lvl("am_as_m", "am_as_t")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;
    use std::str::FromStr;

    fn vectors() -> serde_json::Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/contracts/ask-markup-vectors.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("ask-markup-vectors.json")).unwrap()
    }
    fn dec_opt(v: &serde_json::Value) -> Option<Decimal> {
        v.as_str().map(|s| Decimal::from_str(s).unwrap())
    }
    fn level(v: &serde_json::Value) -> Level {
        if v.is_null() {
            return Level::default();
        }
        Level { markup: dec_opt(&v["spreadMarkup"]), target: dec_opt(&v["targetTotalSpreadPips"]) }
    }
    /// The web writes decimals normalised (decimal.js toString: no trailing zeros).
    fn s(d: Decimal) -> String {
        d.normalize().to_string()
    }

    #[test]
    fn every_resolution_case_of_the_vectors() {
        let v = vectors();
        let cases = v["resolution"].as_array().unwrap();
        assert!(cases.len() >= 14);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let l = AskLevels {
                pricing_engine: c["pricingEngineEnabled"].as_bool().unwrap(),
                coverage: c["coverage"].as_bool().unwrap(),
                digits: c["digits"].as_i64().unwrap() as i32,
                broker: dec_opt(&c["broker"]),
                group: level(&c["group"]),
                account_type: if c["accountType"].is_null() { None } else { dec_opt(&c["accountType"]["spreadMarkup"]) },
                account_type_symbol: level(&c["accountTypeSymbol"]),
                account_symbol: level(&c["accountSymbol"]),
            };
            let got = resolve(&l).unwrap();
            let e = &c["expected"];
            match got {
                AskRule::Markup { markup_pips, .. } => {
                    assert_eq!(e["mode"], "markup", "{name}");
                    assert_eq!(s(markup_pips), e["markupPips"].as_str().unwrap(), "{name}");
                }
                AskRule::Target { target_pips, fallback_pips, .. } => {
                    assert_eq!(e["mode"], "target", "{name}");
                    assert_eq!(s(target_pips), e["targetPips"].as_str().unwrap(), "{name}");
                    assert_eq!(fallback_pips.map(s), e["fallbackPips"].as_str().map(str::to_string), "{name}");
                }
            }
        }
    }

    #[test]
    fn every_price_case_of_the_vectors() {
        let v = vectors();
        let cases = v["prices"].as_array().unwrap();
        assert!(cases.len() >= 9);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let digits = c["digits"].as_i64().unwrap() as i32;
            let r = &c["rule"];
            let rule = if r["mode"] == "markup" {
                AskRule::Markup { markup_pips: dec_opt(&r["markupPips"]).unwrap(), digits }
            } else {
                AskRule::Target { target_pips: dec_opt(&r["targetPips"]).unwrap(), fallback_pips: dec_opt(&r["fallbackPips"]), digits }
            };
            let (bid, ask) = (dec_opt(&c["bid"]).unwrap(), dec_opt(&c["ask"]).unwrap());
            let e = &c["expected"];
            assert_eq!(s(markup_pips_at(&rule, bid, ask)), e["markupPips"].as_str().unwrap(), "{name}: markupPips");
            assert_eq!(s(account_ask(&rule, bid, ask)), e["accountAsk"].as_str().unwrap(), "{name}: accountAsk");
            assert_eq!(s(close_price(OrderSide::Buy, bid, ask, Some(&rule))), e["buyClose"].as_str().unwrap(), "{name}: buyClose");
            assert_eq!(s(close_price(OrderSide::Sell, bid, ask, Some(&rule))), e["sellClose"].as_str().unwrap(), "{name}: sellClose");
        }
    }

    #[test]
    fn no_broker_symbol_means_no_rule_and_no_rule_means_the_raw_ask() {
        assert_eq!(resolve(&AskLevels { broker: None, pricing_engine: true, group: Level { markup: Some(dec!(9)), target: None }, ..Default::default() }), None);
        assert_eq!(close_price(OrderSide::Sell, dec!(1), dec!(1.5), None), dec!(1.5));
    }
}
