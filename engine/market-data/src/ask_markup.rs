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
use rust_decimal::{Decimal, RoundingStrategy};

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

/// ONLY A GROUP MAY GO NEGATIVE (owner decision 2026-11-09). A negative markup is a deliberate
/// raw / zero-spread product, configured on a group through the group-pricing PATCH. Every other level --
/// `BrokerSymbol.spreadMarkup` and the per-account / per-account-type override -- still refuses one and is
/// clamped to zero here, so a hostile or fat-fingered value on those levels stays the no-op it has been
/// since 2026-10-29. Clamping at RESOLUTION rather than in the pricing maths is what keeps that promise in
/// one readable place: by the time a rule exists, its sign is already legitimate for the level it came from.
fn clamp_non_negative(v: Option<Decimal>) -> Option<Decimal> {
    v.map(|x| if x.is_sign_negative() { Decimal::ZERO } else { x })
}

fn level_rule(l: &Level, digits: i32, allow_negative: bool) -> Option<AskRule> {
    let markup = if allow_negative { l.markup } else { clamp_non_negative(l.markup) };
    if let Some(target_pips) = l.target {
        // a target spread is an absolute width, never negative; its fallback follows the level's own rule
        return Some(AskRule::Target { target_pips, fallback_pips: markup, digits });
    }
    markup.map(|markup_pips| AskRule::Markup { markup_pips, digits })
}

/// The rule, or None (the raw ask) when the broker does not carry the symbol.
pub fn resolve(l: &AskLevels) -> Option<AskRule> {
    let broker = l.broker?;
    let digits = l.digits;
    if l.coverage {
        return Some(AskRule::Markup { markup_pips: Decimal::ZERO, digits });
    }
    // the broker-symbol value may never be negative (see `level_rule`); only the group may
    let broker_nn = if broker.is_sign_negative() { Decimal::ZERO } else { broker };
    if !l.pricing_engine {
        return Some(AskRule::Markup { markup_pips: l.group.markup.unwrap_or(broker_nn), digits });
    }
    Some(
        level_rule(&l.account_symbol, digits, false)
            .or_else(|| level_rule(&l.group, digits, true))
            .unwrap_or(AskRule::Markup { markup_pips: broker_nn, digits }),
    )
}

/// The markup in pips this rule applies at this tick (lib/pricing-engine.ts resolveEffectiveSpreadMarkup).
///
/// A MARKUP-mode rule passes its value through unchanged, negative included -- that is what makes a raw / zero-spread
/// group expressible. A TARGET-mode rule keeps its own floor at zero (a target no wider than the live raw spread
/// leaves the quote raw, contract cases "target below the raw spread" and "target equal to the raw spread"): a target
/// spread is an absolute width, so a negative difference means "no markup", not "narrow the book".
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

/// This rule's own `digits`.
fn rule_digits(rule: &AskRule) -> i32 {
    match *rule {
        AskRule::Markup { digits, .. } | AskRule::Target { digits, .. } => digits,
    }
}

/// The smallest price this symbol can quote (one unit of its last digit) -- the floor a marked-down bid may not cross.
fn price_floor(digits: i32) -> Decimal {
    Decimal::new(1, digits.max(0) as u32)
}

/// What each side moves at this tick, in PRICE units: (ask part, bid part). The port of lib/group-pricing.ts `markupSplit`
/// (owner decision 2026-11-06): the markup in whole points of the last digit, rounded up only if not whole, the ask taking
/// the larger share, so the total spread is exactly raw + markup. `markup_pips_at` floors a target-mode markup at zero, so
/// a target no wider than the live raw spread leaves the quote exactly raw.
///
/// Unchanged for a NEGATIVE total (2026-11-09): `ceil` moves toward zero, so `askPart = ceil(total/2)` is the smaller
/// magnitude and the bid takes the rest -- e.g. -5 points splits as ask -2, bid -3 (contract case "negative: floor to
/// 0, half-tick mid ..."). The zero-spread floor lives in `account_pair`, not here; this function only splits.
pub fn markup_parts(rule: &AskRule, bid: Decimal, ask: Decimal) -> (Decimal, Decimal) {
    let m = markup_pips_at(rule, bid, ask);
    if m.is_zero() {
        return (Decimal::ZERO, Decimal::ZERO);
    }
    let digits = rule_digits(rule);
    let point = price_floor(digits);
    let total = (m * pip_size(digits) / point).ceil();
    let ask_points = (total / Decimal::TWO).ceil();
    (ask_points * point, (total - ask_points) * point)
}

/// A price that ALREADY carries this account's markup on its own side of the book.
///
/// Compile guard for the symmetric-markup change (owner decision 2026-10-29): a raw `bid` is no longer a valid close
/// price for a BUY, so the close / valuation path cannot be satisfied with a bare `Decimal` any more. Every site that
/// used to write `if is_buy { tick.bid }` is a type error until it goes through [`account_bid`] or [`close_price`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct AccountPrice(Decimal);

impl AccountPrice {
    /// The underlying price. Use at the edges only (writing a fill, comparing against a client level).
    pub fn get(self) -> Decimal {
        self.0
    }
}

impl std::fmt::Display for AccountPrice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Both account-side prices for one tick, with the ZERO-SPREAD FLOOR applied -- the one place the two sides are
/// decided together, so the cross check and the collapse cannot disagree with each other.
///
/// NEGATIVE MARKUP (owner decision 2026-11-09, raw / zero-spread groups). A negative markup narrows the spread instead
/// of widening it. `markup_parts` already yields the right halves for a negative total without change: the split is
/// `askPart = ceil(total/2)`, `bidPart = the rest`, and on a negative total `ceil` moves toward zero, so the BID takes
/// the larger magnitude -- the mirror of the positive case, from the same formula. What had to change is the two
/// CLAMPS: `account_ask` ended with `.max(ask)` and `account_bid` with `.min(bid)`, each of which exists to stop a
/// positive markup from ever quoting tighter than raw, and each of which would silently undo a negative markup
/// entirely. The clamp therefore moves from a markup floor to a SPREAD floor:
///
///   client spread = max(0, raw_spread + markup)
///
/// and when the candidates meet or cross, both sides collapse to the mid at the symbol's precision, ROUND HALF TO
/// EVEN. Half-to-even is not the convention the rest of this file uses (the ask rounds up and the bid down, both away
/// from the client); it is neutral by design, because at a zero spread there is no "away from the client" to round
/// towards. The two half-tick ties are pinned by the contract rather than inferred:
///   1.12270 / 1.12271 -> mid 1.122705 -> 1.12270   (down, to the even last digit)
///   1.12271 / 1.12272 -> mid 1.122715 -> 1.12272   (up, to the even last digit)
///
/// MARKUP >= 0 IS BYTE-FOR-BYTE UNCHANGED, and that is why the non-negative case is a separate early branch holding
/// the previous expressions verbatim rather than a unified formula: a normal group cannot be moved by one point by a
/// refactor it was never meant to be part of.
fn account_pair(rule: &AskRule, bid: Decimal, ask: Decimal) -> (Decimal, Decimal) {
    let (ask_part, bid_part) = markup_parts(rule, bid, ask);
    let d = rule_digits(rule);
    let du = d.max(0) as u32;

    // ---- markup >= 0: exactly as before -------------------------------------------------------------
    if ask_part + bid_part >= Decimal::ZERO {
        let a = if ask_part.is_zero() {
            ask
        } else {
            (ask + ask_part).round_dp_with_strategy(du, RoundingStrategy::ToPositiveInfinity).max(ask)
        };
        let b = if bid_part.is_zero() {
            bid
        } else {
            (bid - bid_part)
                .round_dp_with_strategy(du, RoundingStrategy::ToNegativeInfinity)
                .max(price_floor(d))
                .min(bid)
        };
        return (b, a);
    }

    // ---- markup < 0: the spread narrows ------------------------------------------------------------
    // Same rounding directions as above (ask up, bid down); the clamps are deliberately absent, since
    // they are what a negative markup has to get past.
    let ca = (ask + ask_part).round_dp_with_strategy(du, RoundingStrategy::ToPositiveInfinity);
    let cb = (bid - bid_part).round_dp_with_strategy(du, RoundingStrategy::ToNegativeInfinity);
    if cb < ca {
        return (cb.max(price_floor(d)), ca);
    }
    // met or crossed: the floor bites and both sides become the mid, half to even
    let mid = ((bid + ask) / Decimal::TWO)
        .round_dp_with_strategy(du, RoundingStrategy::MidpointNearestEven)
        .max(price_floor(d));
    (mid, mid)
}

/// The account's ask: raw ask + its share of the markup, at the symbol's precision, never tighter than the raw ask. The
/// price a BUY opens at and a SELL closes at.
pub fn account_ask(rule: &AskRule, bid: Decimal, ask: Decimal) -> AccountPrice {
    AccountPrice(account_pair(rule, bid, ask).1)
}

/// The account's bid: raw bid - its share of the markup, at the symbol's precision, never tighter than the raw bid, and
/// never at or below zero. The price a SELL opens at and a BUY closes at.
pub fn account_bid(rule: &AskRule, bid: Decimal, ask: Decimal) -> AccountPrice {
    AccountPrice(account_pair(rule, bid, ask).0)
}

/// Both account-side prices for one tick, with the crossed-book invariant checked. `None` when the quote would cross
/// or invert -- such a quote is never safe to fill or value against, and the caller must skip the tick rather than
/// act on it (the engine's risk paths must not panic on a bad configuration).
pub fn account_quote(rule: &AskRule, bid: Decimal, ask: Decimal) -> Option<(AccountPrice, AccountPrice)> {
    let (b, a) = (account_bid(rule, bid, ask), account_ask(rule, bid, ask));
    // `<=`, not `<`: a zero-spread quote is legitimate under a negative markup (both sides sit on the
    // mid). A genuinely INVERTED quote -- which the floor can no longer produce, but a bad raw tick
    // still can -- is refused exactly as before.
    if b.get() <= a.get() { Some((b, a)) } else { None }
}

/// The price an open position closes at for its account: a BUY at the account's BID, a SELL at the account's ask.
///
/// `rule` is REQUIRED (compile guard). Under the ask-only rule a BUY closed at the RAW bid, so every caller could pass
/// `None` and still be right for a BUY. Under the symmetric rule that is a wrong price, so the `Option` is gone: pass
/// `&AskRule::Markup { markup_pips: Decimal::ZERO, digits }` where the account genuinely has no markup.
pub fn close_price(side: OrderSide, bid: Decimal, ask: Decimal, rule: &AskRule) -> AccountPrice {
    match side {
        OrderSide::Buy => account_bid(rule, bid, ask),
        OrderSide::Sell => account_ask(rule, bid, ask),
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
        assert_eq!(cases.len(), 18, "the contract file changed: re-check the engine against it");
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
            // the whole-point split, and a BUY closes at the account's BID
            let (ask_part, bid_part) = markup_parts(&rule, bid, ask);
            assert_eq!(s(ask_part), e["askPart"].as_str().unwrap(), "{name}: askPart");
            assert_eq!(s(bid_part), e["bidPart"].as_str().unwrap(), "{name}: bidPart");
            assert_eq!(s(account_bid(&rule, bid, ask).get()), e["accountBid"].as_str().unwrap(), "{name}: accountBid");
            assert_eq!(s(account_ask(&rule, bid, ask).get()), e["accountAsk"].as_str().unwrap(), "{name}: accountAsk");
            assert_eq!(s(close_price(OrderSide::Buy, bid, ask, &rule).get()), e["buyClose"].as_str().unwrap(), "{name}: buyClose");
            assert_eq!(s(close_price(OrderSide::Sell, bid, ask, &rule).get()), e["sellClose"].as_str().unwrap(), "{name}: sellClose");
            // The book must never INVERT, on any vector. A zero spread (b == a) became legitimate with the
            // negative markup -- it is the floor working -- so the strict `<` only still holds where the
            // markup is non-negative, and that narrower guarantee is asserted rather than dropped.
            let (b, a) = account_quote(&rule, bid, ask).expect("account quote must not invert");
            assert!(b.get() <= a.get(), "{name}: inverted account book");
            if !markup_pips_at(&rule, bid, ask).is_sign_negative() {
                assert!(b.get() < a.get(), "{name}: a non-negative markup must never quote a zero spread");
            }
        }
    }

    #[test]
    fn no_broker_symbol_means_no_rule_and_a_zero_markup_means_raw_on_both_sides() {
        assert_eq!(resolve(&AskLevels { broker: None, pricing_engine: true, group: Level { markup: Some(dec!(9)), target: None }, ..Default::default() }), None);
        // close_price no longer takes an Option: "no rule" is stated as a zero markup, which leaves BOTH sides raw
        let raw = AskRule::Markup { markup_pips: Decimal::ZERO, digits: 2 };
        assert_eq!(close_price(OrderSide::Sell, dec!(1), dec!(1.5), &raw).get(), dec!(1.5));
        assert_eq!(close_price(OrderSide::Buy, dec!(1), dec!(1.5), &raw).get(), dec!(1));
    }

    #[test]
    fn whole_point_split_is_exact_and_never_crosses() {
        // XAUUSD, digits 2 (pip 0.1), markup 1.5 pips = 15 points: ask +8, bid -7, a total of exactly 15.
        let rule = AskRule::Markup { markup_pips: dec!(1.5), digits: 2 };
        let (bid, ask) = (dec!(4298.96), dec!(4299.13));
        assert_eq!(account_bid(&rule, bid, ask).get(), dec!(4298.89));
        assert_eq!(account_ask(&rule, bid, ask).get(), dec!(4299.21));
        assert_eq!(account_ask(&rule, bid, ask).get() - account_bid(&rule, bid, ask).get(), (ask - bid) + dec!(0.15));

        // the case that made Pro price like Standard: 0.1 pip on 5 digits is one point, and costs one point
        let pro = AskRule::Markup { markup_pips: dec!(0.1), digits: 5 };
        let (b, a) = (dec!(1.12270), dec!(1.12271));
        assert_eq!(account_ask(&pro, b, a).get() - account_bid(&pro, b, a).get(), (a - b) + dec!(0.00001));

        // a markup wider than the price itself degrades to the smallest quotable price, never zero or negative
        let huge = AskRule::Markup { markup_pips: dec!(600), digits: 2 };
        let (b, a) = (dec!(1.00), dec!(1.02));
        assert!(account_bid(&huge, b, a).get() > Decimal::ZERO);
        assert!(account_bid(&huge, b, a).get() < account_ask(&huge, b, a).get());
        assert!(account_quote(&huge, b, a).is_some());

        // a target no wider than the live raw spread leaves the quote exactly raw (markup floored at 0)
        let tight = AskRule::Target { target_pips: dec!(1), fallback_pips: None, digits: 2 };
        assert_eq!(account_bid(&tight, bid, ask).get(), bid);
        assert_eq!(account_ask(&tight, bid, ask).get(), ask);
    }
}
