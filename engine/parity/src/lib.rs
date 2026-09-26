//! Stage 0 parity harness, Rust side. Loads an `engine/parity/scenarios/*.json` scenario and runs
//! it through the engine's OWN decision code with no database:
//!
//! - equity / used margin: `order_management::calc::{equity, used_margin}` on a real
//!   `calc::AccountState` built from `db::OpenPositionWithMarket` rows,
//! - thresholds: `margin::resolve_thresholds`, decision: `margin::evaluate`,
//! - level: `risk::margin_level`, P&L / close price: `calc::{floating_pnl, position_close_price}`.
//!
//! What is NOT callable, and is therefore mirrored here (minimal, with the source line cited):
//! - `monitor.rs` `sl_tp_trigger` (line 53), `force_close_worst` (152) and `evaluate_account`
//!   (186) are private and async over a `PgPool`; their selection logic is reproduced in
//!   [`evaluate_account`] below.
//! - The price freshness predicate lives in SQL (`db.rs` line 894:
//!   `lp."updatedAt" > now() - interval '15 seconds'`); reproduced in [`fresh_for_engine`].
//!
//! Nothing here fixes a divergence -- Stage 0 only makes them visible.

pub mod db_mode;
pub mod load_mode;
pub mod shadow_gate;

use order_management::calc::{equity, floating_pnl, position_close_price, used_margin, AccountState};
use order_management::db::OpenPositionWithMarket;
use margin::{MarginThresholds, MonitorAction, ThresholdsByGroup};
use protocol::OrderSide;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    pub name: String,
    pub why: String,
    #[serde(default)]
    pub known_divergence: Vec<KnownDivergence>,
    pub broker: BrokerCfg,
    pub groups: Vec<GroupCfg>,
    pub accounts: Vec<AccountCfg>,
    pub symbols: Vec<SymbolCfg>,
    pub positions: Vec<PositionCfg>,
    #[serde(default)]
    pub prices: Vec<PriceCfg>,
    /// needs the database (mirror rules, coverage legs, the post-close follow-up): skipped by the pure-calc run.
    /// The seeding for those lives in scripts/parity/run-ts.ts only (`mirrors`, `coverage`, `coverageLeg`,
    /// `autoHedged`), which is why this struct does not carry them.
    #[serde(default)]
    pub db_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KnownDivergence {
    pub id: String,
    pub fields: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerCfg {
    pub negative_balance_protection: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupCfg {
    pub key: String,
    pub margin_call_level: Decimal,
    pub stop_out_level: Decimal,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountCfg {
    pub key: String,
    pub group: String,
    pub balance: Decimal,
    #[serde(default)]
    pub credit: Decimal,
    pub leverage: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolCfg {
    pub name: String,
    pub contract_size: Decimal,
    pub digits: u32,
    pub quote_currency: String,
    /// Prisma SymbolCategory; the harness seeds CRYPTO (always in session) when absent
    #[serde(default)]
    pub category: Option<String>,
    /// seed a configured session on another weekday, so the market is closed now (Stage 2 F4)
    #[serde(default)]
    pub session_closed_now: bool,
    /// BrokerSymbol.hedgedMarginPct (MT5 hedged margin); absent = 200 (no reduction)
    #[serde(default)]
    pub hedged_margin_pct: Option<Decimal>,
    /// BrokerSymbol.spreadMarkup in pips (2026-09-26: a SELL closes at the account's marked-up ask); absent = 0
    #[serde(default)]
    pub spread_markup: Option<Decimal>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionCfg {
    pub key: String,
    pub account: String,
    pub symbol: String,
    pub side: String,
    pub volume: Decimal,
    pub open_price: Decimal,
    #[serde(default)]
    pub sl_price: Option<Decimal>,
    #[serde(default)]
    pub tp_price: Option<Decimal>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceCfg {
    pub symbol: String,
    pub bid: Decimal,
    pub ask: Decimal,
    /// Age of the last real market tick (`LivePrice.tickAt`) -- what the web path gates on.
    pub age_seconds: f64,
    /// Age of the last row write (`LivePrice.updatedAt`); defaults to `age_seconds`. Differs
    /// when the feed heartbeats an unchanged price.
    #[serde(default)]
    pub updated_age_seconds: Option<f64>,
}

impl Scenario {
    pub fn from_json(text: &str) -> Result<Self, String> {
        let s: Scenario = serde_json::from_str(text).map_err(|e| format!("invalid scenario JSON: {e}"))?;
        s.validate()?;
        Ok(s)
    }

    /// Referential checks so a typo in a scenario fails loudly instead of silently evaluating a
    /// different book.
    pub fn validate(&self) -> Result<(), String> {
        let has_group = |k: &str| self.groups.iter().any(|g| g.key == k);
        let has_account = |k: &str| self.accounts.iter().any(|a| a.key == k);
        let has_symbol = |k: &str| self.symbols.iter().any(|s| s.name == k);
        for a in &self.accounts {
            if !has_group(&a.group) {
                return Err(format!("{}: account {} references unknown group {}", self.name, a.key, a.group));
            }
            if a.leverage < 1 {
                return Err(format!("{}: account {} leverage must be >= 1", self.name, a.key));
            }
        }
        let mut seen = std::collections::HashSet::new();
        for p in &self.positions {
            if !seen.insert(p.key.as_str()) {
                return Err(format!("{}: duplicate position key {}", self.name, p.key));
            }
            if !has_account(&p.account) {
                return Err(format!("{}: position {} references unknown account {}", self.name, p.key, p.account));
            }
            if !has_symbol(&p.symbol) {
                return Err(format!("{}: position {} references unknown symbol {}", self.name, p.key, p.symbol));
            }
            parse_side(&p.side).map_err(|e| format!("{}: position {}: {e}", self.name, p.key))?;
        }
        for px in &self.prices {
            if !has_symbol(&px.symbol) {
                return Err(format!("{}: price for unknown symbol {}", self.name, px.symbol));
            }
        }
        Ok(())
    }
}

pub fn parse_side(s: &str) -> Result<OrderSide, String> {
    match s {
        "BUY" => Ok(OrderSide::Buy),
        "SELL" => Ok(OrderSide::Sell),
        other => Err(format!("side must be BUY or SELL, got {other:?}")),
    }
}

/// Mirrors the engine's SQL freshness predicate (order-management/src/db.rs:894):
/// `lp."updatedAt" > now() - interval '15 seconds'` -- keyed on updatedAt, NOT tickAt.
pub fn fresh_for_engine(px: &PriceCfg) -> bool {
    px.updated_age_seconds.unwrap_or(px.age_seconds) < 15.0
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Txn {
    #[serde(rename = "type")]
    pub kind: String,
    pub amount: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountOutcome {
    pub margin_level_before: Option<String>,
    pub closed_position_ids: Vec<String>,
    pub close_reasons: Vec<String>,
    pub final_balance: String,
    pub final_credit: String,
    pub transactions: Vec<Txn>,
    pub margin_call_notified: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PositionState {
    pub status: String,
    pub volume: String,
    pub close_price: Option<String>,
    pub realized_pnl: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioOutcome {
    pub scenario: String,
    pub engine: &'static str,
    pub accounts: BTreeMap<String, AccountOutcome>,
    /// DB mode only (Stage 4.5): Notification / AuditLog counts and every position's final state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side_effects: Option<BTreeMap<String, i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub positions: Option<BTreeMap<String, PositionState>>,
}

fn account_state(sc: &Scenario, acct: &AccountCfg) -> AccountState {
    let positions = sc
        .positions
        .iter()
        .filter(|p| p.account == acct.key)
        .map(|p| {
            let sym = sc.symbols.iter().find(|s| s.name == p.symbol).expect("validated");
            let px = sc.prices.iter().find(|x| x.symbol == p.symbol).filter(|x| fresh_for_engine(x));
            OpenPositionWithMarket {
                id: p.key.clone(),
                symbol: p.symbol.clone(),
                side: parse_side(&p.side).expect("validated"),
                volume: p.volume,
                open_price: p.open_price,
                contract_size: sym.contract_size,
                bid: px.map(|x| x.bid),
                ask: px.map(|x| x.ask),
                sl_price: p.sl_price,
                tp_price: p.tp_price,
                fx_rate: Decimal::ONE, // Stage 0 pure-calc mode predates conversion (the gate is run-db.sh)
                hedged_margin_pct: sym.hedged_margin_pct.unwrap_or_else(order_management::calc::default_hedged_margin_pct),
                // the scenario's broker markup, no group / pricing-engine levels (market_data::ask_markup resolve with the
                // engine off and no group config = BrokerSymbol.spreadMarkup)
                ask_rule: sym.spread_markup.map(|markup_pips| market_data::ask_markup::AskRule::Markup { markup_pips, digits: sym.digits as i32 }),
            }
        })
        .collect();
    // calc.rs load_account_state: effective_balance = Account.balance + SUM(ledger_entries);
    // a freshly seeded scenario has no ledger entries.
    AccountState {
        effective_balance: acct.balance,
        credit: acct.credit,
        leverage: acct.leverage.max(1) as u32,
        positions,
    }
}

/// Mirror of monitor.rs:53 `sl_tp_trigger` (private).
fn sl_tp_trigger(p: &OpenPositionWithMarket) -> Option<&'static str> {
    let (bid, ask) = (p.bid?, p.ask?);
    let cp = position_close_price(p, bid, ask);
    match p.side {
        OrderSide::Buy => {
            if p.sl_price.is_some_and(|sl| cp <= sl) {
                return Some("stop_loss");
            }
            if p.tp_price.is_some_and(|tp| cp >= tp) {
                return Some("take_profit");
            }
        }
        OrderSide::Sell => {
            if p.sl_price.is_some_and(|sl| cp >= sl) {
                return Some("stop_loss");
            }
            if p.tp_price.is_some_and(|tp| cp <= tp) {
                return Some("take_profit");
            }
        }
    }
    None
}

fn money(d: Decimal) -> String {
    d.normalize().to_string()
}

/// One account through the engine's monitor pass (monitor.rs:186 `evaluate_account`), minus I/O.
pub fn evaluate_account(sc: &Scenario, acct: &AccountCfg, by_group: &ThresholdsByGroup) -> AccountOutcome {
    let mut state = account_state(sc, acct);
    let starting_balance = state.effective_balance;
    let margin_level_before = risk::margin_level(equity(&state), used_margin(&state)).map(money);
    let mut closed = Vec::new();
    let mut reasons = Vec::new();
    let mut txns = Vec::new();
    let mut margin_call = false;

    let thresholds: MarginThresholds = margin::resolve_thresholds(Some(&acct.group), by_group).expect("every scenario group is loaded");

    if !state.positions.is_empty() {
        // Pass 1 -- monitor.rs close_sl_tp_triggered (~line 91): collect triggered, close in
        // REVERSE index order (line 109, `.into_iter().rev()`).
        let triggered: Vec<(usize, &'static str, Decimal)> = state
            .positions
            .iter()
            .enumerate()
            .filter_map(|(i, p)| {
                let reason = sl_tp_trigger(p)?;
                let cp = position_close_price(p, p.bid?, p.ask?);
                Some((i, reason, floating_pnl(p.side, p.open_price, cp, p.contract_size, p.volume)))
            })
            .collect();
        for (idx, reason, pnl) in triggered.into_iter().rev() {
            let p = state.positions.remove(idx);
            state.effective_balance += pnl;
            closed.push(p.id);
            reasons.push(reason.to_string());
            txns.push(Txn { kind: "TRADE_PNL".into(), amount: money(pnl) });
        }

        // Pass 2 -- monitor.rs:224 onwards: bounded loop, margin::evaluate each iteration.
        let max_iterations = state.positions.len();
        for _ in 0..max_iterations {
            match margin::evaluate(equity(&state), used_margin(&state), thresholds) {
                MonitorAction::Ok => break,
                MonitorAction::MarginCall => {
                    margin_call = true; // TradingEvent::MarginCall would be published
                    break;
                }
                MonitorAction::StopOut => {
                    // force_close_worst (monitor.rs:152): min floating P&L among positions WITH a
                    // price (`min_by` at line 166 -- first minimum wins on a tie).
                    let worst = state
                        .positions
                        .iter()
                        .enumerate()
                        .filter_map(|(i, p)| {
                            let cp = position_close_price(p, p.bid?, p.ask?);
                            Some((i, floating_pnl(p.side, p.open_price, cp, p.contract_size, p.volume)))
                        })
                        .min_by(|a, b| a.1.cmp(&b.1));
                    let Some((idx, pnl)) = worst else {
                        break; // CloseAttempt::NoCloseablePosition
                    };
                    let p = state.positions.remove(idx);
                    state.effective_balance += pnl;
                    closed.push(p.id);
                    reasons.push("stop_out".into());
                    txns.push(Txn { kind: "TRADE_PNL".into(), amount: money(pnl) });
                }
            }
        }
    }

    // The engine writes realized P&L as ledger_entries on top of Account.balance and has no
    // negative-balance protection, so the final balance is the plain sum.
    let final_balance = starting_balance + txns.iter().map(|t| t.amount.parse::<Decimal>().unwrap()).sum::<Decimal>();
    AccountOutcome {
        margin_level_before,
        closed_position_ids: closed,
        close_reasons: reasons,
        final_balance: money(final_balance),
        final_credit: money(acct.credit), // Stage 0 pure mode does not model credit consumption
        transactions: txns,
        margin_call_notified: margin_call,
    }
}

pub fn evaluate(sc: &Scenario) -> ScenarioOutcome {
    // monitor.rs run_once -> db::load_group_thresholds: every group's own configured levels.
    let by_group: ThresholdsByGroup = sc
        .groups
        .iter()
        .map(|g| (g.key.clone(), MarginThresholds { call_level: g.margin_call_level, stop_out_level: g.stop_out_level }))
        .collect();
    let accounts = sc.accounts.iter().map(|a| (a.key.clone(), evaluate_account(sc, a, &by_group))).collect();
    ScenarioOutcome { scenario: sc.name.clone(), engine: "rust", accounts, side_effects: None, positions: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scenario_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scenarios")
    }

    const MINIMAL: &str = r#"{
      "name": "t", "why": "unit",
      "broker": {"negativeBalanceProtection": true},
      "groups": [{"key": "std", "marginCallLevel": "100", "stopOutLevel": "50"}],
      "accounts": [{"key": "a1", "group": "std", "balance": "1000", "credit": "0", "leverage": 100}],
      "symbols": [{"name": "XAUUSD", "contractSize": "100", "digits": 2, "quoteCurrency": "USD"}],
      "positions": [{"key": "p1", "account": "a1", "symbol": "XAUUSD", "side": "BUY", "volume": "1", "openPrice": "2000", "slPrice": null}],
      "prices": [{"symbol": "XAUUSD", "bid": "1992", "ask": "1992.5", "ageSeconds": 0}]
    }"#;

    #[test]
    fn every_checked_in_scenario_loads_and_validates() {
        let mut n = 0;
        for entry in std::fs::read_dir(scenario_dir()).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let sc = Scenario::from_json(&std::fs::read_to_string(&path).unwrap())
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            assert_eq!(format!("{}.json", sc.name), path.file_name().unwrap().to_str().unwrap(), "file name must equal scenario name");
            n += 1;
        }
        assert!(n >= 10, "expected at least 10 scenarios, found {n}");
    }

    #[test]
    fn loader_parses_decimals_exactly_and_defaults_optional_fields() {
        let sc = Scenario::from_json(MINIMAL).unwrap();
        assert_eq!(sc.prices[0].ask, "1992.5".parse::<Decimal>().unwrap());
        assert!(sc.known_divergence.is_empty());
        assert_eq!(sc.positions[0].tp_price, None);
        assert_eq!(sc.prices[0].updated_age_seconds, None);
    }

    #[test]
    fn loader_rejects_dangling_references_and_bad_sides() {
        let bad_group = MINIMAL.replace(r#""group": "std""#, r#""group": "nope""#);
        assert!(Scenario::from_json(&bad_group).unwrap_err().contains("unknown group"));
        let bad_side = MINIMAL.replace(r#""side": "BUY""#, r#""side": "LONG""#);
        assert!(Scenario::from_json(&bad_side).unwrap_err().contains("BUY or SELL"));
    }

    #[test]
    fn freshness_follows_updated_at_like_the_engine_sql() {
        let mut px = Scenario::from_json(MINIMAL).unwrap().prices[0].clone();
        assert!(fresh_for_engine(&px));
        px.age_seconds = 60.0;
        assert!(!fresh_for_engine(&px));
        px.updated_age_seconds = Some(1.0); // heartbeat: tick old, row write recent
        assert!(fresh_for_engine(&px));
    }

    #[test]
    fn a_sell_with_a_broker_markup_closes_at_the_marked_up_ask() {
        let sc = Scenario::from_json(&std::fs::read_to_string(scenario_dir().join("27-sell-markup-sl-at-account-ask.json")).unwrap()).unwrap();
        let out = evaluate(&sc);
        // SELL 1 lot XAUUSD from 4290.00, SL 4299.25; raw ask 4299.13 (not hit), account ask 4299.28 (+1.5 pips): hit.
        // P&L = (4290.00 - 4299.28) x 100 x 1 = -928
        let a = &out.accounts["a1"];
        assert_eq!(a.closed_position_ids, vec!["p1".to_string()]);
        assert_eq!(a.close_reasons, vec!["stop_loss".to_string()]);
        assert_eq!(a.transactions, vec![Txn { kind: "TRADE_PNL".into(), amount: "-928".into() }]);
        // the same scenario without the markup: nothing closes
        let raw = Scenario::from_json(&std::fs::read_to_string(scenario_dir().join("27-sell-markup-sl-at-account-ask.json")).unwrap().replace(r#""spreadMarkup": "1.5""#, r#""spreadMarkup": "0""#)).unwrap();
        assert!(evaluate(&raw).accounts["a1"].closed_position_ids.is_empty());
    }

    #[test]
    fn minimal_stop_out_closes_the_only_position() {
        let out = evaluate(&Scenario::from_json(MINIMAL).unwrap());
        let a = &out.accounts["a1"];
        assert_eq!(a.closed_position_ids, vec!["p1".to_string()]);
        assert_eq!(a.final_balance, "200");
        assert_eq!(a.transactions, vec![Txn { kind: "TRADE_PNL".into(), amount: "-800".into() }]);
    }
}
