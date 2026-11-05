//! L2 cutover STAGE 0 — the order-path parity oracle.
//!
//! Proves that the price the ENGINE's order path would fill at is byte-identical to the price the
//! WEB fills at, for the same inputs. No database, no mode flip, no production code touched: this is
//! the pass/fail oracle every later cutover stage is measured against (see
//! C:\vyx\handoff\l2-cutover-design.md §6, Stage 0).
//!
//! HOW IT IS A CROSS-LANGUAGE PROOF
//!
//! The expectations are not written here. They come from docs/contracts/ask-markup-vectors.json,
//! which scripts/contracts/gen-ask-markup-vectors.ts generates FROM THE WEB'S OWN FUNCTIONS
//! (lib/ask-markup.ts), and which lib/ask-markup.test.ts fails on if the file and the web ever
//! disagree. So asserting against that file is asserting against the web's live behaviour, and a
//! divergence breaks on one side or the other rather than hiding.
//!
//! WHAT IS ACTUALLY COMPOSED HERE
//!
//! The engine's fill price is not one function. It is a composition the cutover will run per order:
//!
//!   1. the account's rule is resolved  (market_data::ask_markup::resolve -- covered by
//!      tests/ask_markup_db.rs against a real database, and by the vectors' own `resolution` cases)
//!   2. the raw tick is priced for that account  (order_management::pricing::quoted_tick)
//!   3. a side is picked                        (execution::execute_market_order)
//!
//! Step 3 is deliberately trivial (execution/src/lib.rs: "this function only decides price" -- BUY
//! takes the ask, SELL the bid), which is exactly why steps 2 and 3 have to be asserted TOGETHER:
//! the whole risk is that the right tick is built and then the wrong side read off it, or that the
//! quote is right while a stale ask-only path is still in the way. Testing `quoted_tick` alone would
//! miss both.
//!
//! WHAT THIS DOES NOT PROVE
//!
//! - Latency. The design's failover deadline (§5b.6) needs the engine's real fill latency
//!   distribution, which needs a live fill; it cannot be measured from a pure function.
//! - The database resolution half of step 1 (tests/ask_markup_db.rs covers that).
//! - Anything about WHICH rows get written. That is Stages 3-5.

use market_data::ask_markup::AskRule;
use order_management::pricing::quoted_tick;
use protocol::{OrderSide, Tick};
use rust_decimal::Decimal;
use std::str::FromStr;

fn vectors() -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/contracts/ask-markup-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("ask-markup-vectors.json")).unwrap()
}

fn dec(v: &serde_json::Value) -> Decimal {
    Decimal::from_str(v.as_str().expect("a decimal string")).unwrap()
}

fn dec_opt(v: &serde_json::Value) -> Option<Decimal> {
    v.as_str().map(|s| Decimal::from_str(s).unwrap())
}

/// The web writes decimals normalised (decimal.js toString: no trailing zeros), so compare in that
/// form rather than on scale -- 4299.21 and 4299.2100 are the same price.
fn s(d: Decimal) -> String {
    d.normalize().to_string()
}

fn rule_of(v: &serde_json::Value, digits: i32) -> AskRule {
    match v["mode"].as_str().expect("mode") {
        "markup" => AskRule::Markup { markup_pips: dec(&v["markupPips"]), digits },
        "target" => AskRule::Target {
            target_pips: dec(&v["targetPips"]),
            fallback_pips: dec_opt(&v["fallbackPips"]),
            digits,
        },
        other => panic!("unknown rule mode {other} in the contract file"),
    }
}

fn raw_tick(bid: Decimal, ask: Decimal) -> Tick {
    Tick {
        symbol: "PARITY".into(),
        bid,
        ask,
        t0: None,
        clock_offset_ms: None,
        rtt_ms: None,
        tick_ms: None,
        broker_offset_sec: None,
        bars: Vec::new(), tick_count: None,
    }
}

/// The engine's order path, end to end, for one side.
fn engine_fill(raw: &Tick, rule: &AskRule, side: OrderSide) -> Decimal {
    let quoted = quoted_tick(raw, Some(rule));
    execution::execute_market_order("parity", "parity", side, Decimal::ONE, &quoted, execution::ExecutionStrategy::Internal).price
}

#[test]
fn the_engine_order_path_fills_at_exactly_the_web_price_for_every_contract_vector() {
    let v = vectors();
    let cases = v["prices"].as_array().expect("prices");
    // Pinned on purpose, like the resolution test in market-data: if the web regenerates the file
    // with more or fewer cases, this test must be re-read rather than quietly covering less.
    assert_eq!(cases.len(), 9, "the contract file changed: re-check the engine order path against it");

    let mut checked = 0;
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let digits = c["digits"].as_i64().unwrap() as i32;
        let rule = rule_of(&c["rule"], digits);
        let raw = raw_tick(dec(&c["bid"]), dec(&c["ask"]));
        let e = &c["expected"];

        // A MARKET BUY opens at the account's ASK; a MARKET SELL at the account's BID. These two
        // expectations are the web's own accountAsk / accountBid for the same raw tick and rule.
        assert_eq!(
            s(engine_fill(&raw, &rule, OrderSide::Buy)),
            e["accountAsk"].as_str().unwrap(),
            "{name}: a BUY must fill at the web's accountAsk"
        );
        assert_eq!(
            s(engine_fill(&raw, &rule, OrderSide::Sell)),
            e["accountBid"].as_str().unwrap(),
            "{name}: a SELL must fill at the web's accountBid"
        );
        checked += 1;
    }
    assert_eq!(checked, 9);
}

#[test]
fn the_fill_never_moves_in_the_clients_favour_against_the_raw_tick() {
    // The invariant behind the numbers, asserted independently of them: a markup may only ever widen
    // the book. A sign error or a rounding mode flipped the wrong way would still satisfy a
    // hand-written expectation table; it cannot satisfy this.
    for c in vectors()["prices"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let digits = c["digits"].as_i64().unwrap() as i32;
        let rule = rule_of(&c["rule"], digits);
        let raw = raw_tick(dec(&c["bid"]), dec(&c["ask"]));

        let buy = engine_fill(&raw, &rule, OrderSide::Buy);
        let sell = engine_fill(&raw, &rule, OrderSide::Sell);
        assert!(buy >= raw.ask, "{name}: a BUY filled BELOW the raw ask ({buy} < {})", raw.ask);
        assert!(sell <= raw.bid, "{name}: a SELL filled ABOVE the raw bid ({sell} > {})", raw.bid);
        assert!(buy > sell, "{name}: the quote crossed ({buy} <= {sell})");
    }
}

#[test]
fn no_rule_at_all_fills_at_the_raw_tick() {
    // The fallback both fill sites have always had (a symbol the broker does not carry). It must stay
    // raw rather than become zero or panic, because that is the path a missing BrokerSymbol row takes.
    let raw = raw_tick(dec(&serde_json::json!("4298.96")), dec(&serde_json::json!("4299.13")));
    let quoted = quoted_tick(&raw, None);
    assert_eq!(
        execution::execute_market_order("p", "p", OrderSide::Buy, Decimal::ONE, &quoted, execution::ExecutionStrategy::Internal).price,
        raw.ask
    );
    assert_eq!(
        execution::execute_market_order("p", "p", OrderSide::Sell, Decimal::ONE, &quoted, execution::ExecutionStrategy::Internal).price,
        raw.bid
    );
}
