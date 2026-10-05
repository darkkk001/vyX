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
//!   rides along as the fallback) of AccountSymbolConfig, then GroupSymbolConfig, then BrokerSymbol.spreadMarkup.
//!   D4 (web 2026-10-01, engine D8): account types no longer take part in pricing -- AccountType.spreadMarkup and
//!   AccountTypeSymbolConfig are not read (the web's lib/ask-markup.ts / pricing-engine.ts dropped them in 58b077a).
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

/// One broker's pricing switches (lib/pricing-engine.ts): the engine flag, and its coverage account (always raw).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrokerPricing {
    pub pricing_engine: bool,
    pub coverage_account: Option<String>,
}

/// The pricing configuration every ask rule is resolved from, held in memory (2026-10-05, Neon load): the broker
/// switches, the COVERAGE groups and the three per-symbol levels. Before, every book query joined Broker / Group /
/// BrokerSymbol / GroupSymbolConfig / AccountSymbolConfig for every row (`LEVELS_JOINS`, removed): ~2.3 M scans each
/// in 45 h. The account's broker and group are NOT held here -- they come from the book row itself (the Account it
/// joins anyway), so an account moved to another group prices by its new group at once; only the configuration of
/// those levels is cached, reloaded when the web announces a change (config.changed / account.updated, see
/// crate::pricing).
#[derive(Clone, Debug, Default)]
pub struct PricingSnapshot {
    brokers: std::collections::HashMap<String, BrokerPricing>,
    coverage_groups: std::collections::HashSet<String>,
    /// (brokerId, symbolId) -> BrokerSymbol.spreadMarkup (NOT NULL); a missing key = no BrokerSymbol row
    broker_symbol: std::collections::HashMap<(String, String), Decimal>,
    /// (groupId, symbolId) -> GroupSymbolConfig
    group_symbol: std::collections::HashMap<(String, String), Level>,
    /// (accountId, symbolId) -> AccountSymbolConfig
    account_symbol: std::collections::HashMap<(String, String), Level>,
}

/// What a book row must carry to resolve its ask rule from a snapshot: the ACCOUNT's broker and group (not the
/// position's), the symbol's id and digits.
#[derive(Clone, Copy, Debug)]
pub struct RuleKey<'a> {
    pub account_id: &'a str,
    pub broker_id: &'a str,
    pub group_id: Option<&'a str>,
    pub symbol_id: &'a str,
    pub digits: i32,
}

/// Which rows a scoped load reads (the fallback when no cache is in scope: tests, harnesses).
#[derive(Clone, Debug, Default)]
pub struct PricingScope {
    pub broker_ids: Vec<String>,
    pub group_ids: Vec<String>,
    pub account_ids: Vec<String>,
}

impl PricingScope {
    /// The scope of these keys (deduplicated).
    pub fn of<'a>(keys: impl IntoIterator<Item = RuleKey<'a>>) -> Self {
        let mut s = PricingScope::default();
        for k in keys {
            if !s.broker_ids.iter().any(|b| b == k.broker_id) {
                s.broker_ids.push(k.broker_id.to_string());
            }
            if let Some(g) = k.group_id {
                if !s.group_ids.iter().any(|x| x == g) {
                    s.group_ids.push(g.to_string());
                }
            }
            if !s.account_ids.iter().any(|a| a == k.account_id) {
                s.account_ids.push(k.account_id.to_string());
            }
        }
        s
    }
}

impl PricingSnapshot {
    /// The levels of one (account, symbol), exactly what the old `LEVELS_JOINS` row gave: a missing broker = engine off
    /// and no coverage account (its LEFT JOIN's COALESCE), a missing group = not coverage and no group level.
    pub fn levels(&self, k: RuleKey<'_>) -> AskLevels {
        let broker = self.brokers.get(k.broker_id);
        let key = |a: &str| (a.to_string(), k.symbol_id.to_string());
        AskLevels {
            pricing_engine: broker.is_some_and(|b| b.pricing_engine),
            coverage: k.group_id.is_some_and(|g| self.coverage_groups.contains(g))
                || broker.and_then(|b| b.coverage_account.as_deref()) == Some(k.account_id),
            digits: k.digits,
            broker: self.broker_symbol.get(&key(k.broker_id)).copied(),
            group: k.group_id.and_then(|g| self.group_symbol.get(&key(g)).copied()).unwrap_or_default(),
            account_symbol: self.account_symbol.get(&key(k.account_id)).copied().unwrap_or_default(),
        }
    }

    /// The account's ask rule for the symbol (None = the raw ask).
    pub fn rule(&self, k: RuleKey<'_>) -> Option<AskRule> {
        resolve(&self.levels(k))
    }

    /// Reads the pricing configuration on `conn`: every row (`scope` None), or only `scope`'s. Five plain reads of the
    /// config tables, no join with the book; the caller owns the snapshot (a cache reload runs them in one read-only
    /// transaction, a scoped book read inside its own).
    pub async fn load(conn: &mut sqlx::PgConnection, scope: Option<&PricingScope>) -> Result<Self, sqlx::Error> {
        let (brokers, groups, accounts) = match scope {
            Some(s) => (Some(s.broker_ids.clone()), Some(s.group_ids.clone()), Some(s.account_ids.clone())),
            None => (None, None, None),
        };
        let mut snap = PricingSnapshot::default();
        let rows: Vec<(String, bool, Option<String>)> = sqlx::query_as(
            r#"SELECT id, "pricingEngineEnabled", "coverageAccountId" FROM "Broker" WHERE $1::text[] IS NULL OR id = ANY($1)"#,
        )
        .bind(&brokers)
        .fetch_all(&mut *conn)
        .await?;
        for (id, pricing_engine, coverage_account) in rows {
            snap.brokers.insert(id, BrokerPricing { pricing_engine, coverage_account });
        }
        let rows: Vec<(String,)> =
            sqlx::query_as(r#"SELECT id FROM "Group" WHERE category::text = 'COVERAGE' AND ($1::text[] IS NULL OR id = ANY($1))"#)
                .bind(&groups)
                .fetch_all(&mut *conn)
                .await?;
        snap.coverage_groups = rows.into_iter().map(|(id,)| id).collect();
        let rows: Vec<(String, String, Decimal)> = sqlx::query_as(
            r#"SELECT "brokerId", "symbolId", "spreadMarkup" FROM "BrokerSymbol" WHERE $1::text[] IS NULL OR "brokerId" = ANY($1)"#,
        )
        .bind(&brokers)
        .fetch_all(&mut *conn)
        .await?;
        snap.broker_symbol = rows.into_iter().map(|(b, s, m)| ((b, s), m)).collect();
        let rows: Vec<(String, String, Option<Decimal>, Option<Decimal>)> = sqlx::query_as(
            r#"SELECT "groupId", "symbolId", "spreadMarkup", "targetTotalSpreadPips" FROM "GroupSymbolConfig" WHERE $1::text[] IS NULL OR "groupId" = ANY($1)"#,
        )
        .bind(&groups)
        .fetch_all(&mut *conn)
        .await?;
        snap.group_symbol = rows.into_iter().map(|(g, s, markup, target)| ((g, s), Level { markup, target })).collect();
        let rows: Vec<(String, String, Option<Decimal>, Option<Decimal>)> = sqlx::query_as(
            r#"SELECT "accountId", "symbolId", "spreadMarkup", "targetTotalSpreadPips" FROM "AccountSymbolConfig" WHERE $1::text[] IS NULL OR "accountId" = ANY($1)"#,
        )
        .bind(&accounts)
        .fetch_all(&mut *conn)
        .await?;
        snap.account_symbol = rows.into_iter().map(|(a, s, markup, target)| ((a, s), Level { markup, target })).collect();
        Ok(snap)
    }

    /// Configured rows held (diagnostics: the reload log line).
    pub fn len(&self) -> usize {
        self.brokers.len() + self.coverage_groups.len() + self.broker_symbol.len() + self.group_symbol.len() + self.account_symbol.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The ask rules of a set of book rows: from `snapshot` when given (the cache), else read on `conn` for exactly these
/// rows' brokers / groups / accounts (tests and harnesses without a cache: the configuration as it is NOW, inside the
/// caller's own snapshot, as the old per-row joins read it).
pub async fn rules_for(
    conn: &mut sqlx::PgConnection,
    snapshot: Option<&PricingSnapshot>,
    keys: &[RuleKey<'_>],
) -> Result<Vec<Option<AskRule>>, sqlx::Error> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let loaded;
    let snap = match snapshot {
        Some(s) => s,
        None => {
            loaded = PricingSnapshot::load(conn, Some(&PricingScope::of(keys.iter().copied()))).await?;
            &loaded
        }
    };
    Ok(keys.iter().map(|k| snap.rule(*k)).collect())
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
        // D8: exactly the web's current contract (12 cases since D4 dropped the account-type ones); a changed file must
        // change this number on purpose, and no case may carry an account-type level any more
        assert_eq!(cases.len(), 12, "the contract file changed: re-check the engine against it");
        for c in cases {
            assert!(c.get("accountType").is_none() && c.get("accountTypeSymbol").is_none(), "account types take no part in pricing (D4)");
            let name = c["name"].as_str().unwrap();
            let l = AskLevels {
                pricing_engine: c["pricingEngineEnabled"].as_bool().unwrap(),
                coverage: c["coverage"].as_bool().unwrap(),
                digits: c["digits"].as_i64().unwrap() as i32,
                broker: dec_opt(&c["broker"]),
                group: level(&c["group"]),
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
        assert_eq!(cases.len(), 9, "the contract file changed: re-check the engine against it");
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
