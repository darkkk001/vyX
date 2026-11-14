//! A-book hedge routing, decided by the ENGINE (owner 2026-11-14).
//!
//! SUPERSEDES THE STAGE-5 RULE. Until now the engine deliberately wrote no `"HedgeIntent"`: it queued a
//! `"PostCloseEffect"` and the web turned that into an intent (design option (b), asserted in authority.rs
//! and the order_book_* tests). The owner has moved the decision here, so the engine both decides the route
//! and writes the intent. The old assertions are inverted on this branch rather than deleted, so the change
//! of rule is visible in the diff instead of silent.
//!
//! The decision itself is a faithful port of the web's `lib/hedge-route.ts` `hedgeRouteOf`. It is kept as a
//! pure function of three inputs so the two implementations can be compared case by case, and every branch
//! below names the web line it mirrors. Porting rather than re-deriving matters because the two sides must
//! agree exactly: a position the web calls LIQUIDITY_PROVIDER and the engine calls NONE opens unhedged, and
//! in silence.

use uuid::Uuid;

/// Which way a client position is hedged. Mirrors `HedgeRoute` in lib/hedge-route.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HedgeRoute {
    /// An A-book group's position: the deal leaves a `"HedgeIntent"` that QoreBridge fills at the LP.
    LiquidityProvider,
    /// The broker's own book: a leg on the broker's hedge (coverage) account. Never QoreBridge.
    HedgeAccount,
    /// The hedge account's own legs, and any position whose two stamps disagree.
    None,
}

impl HedgeRoute {
    /// Only this route produces an intent for the bridge.
    pub fn goes_to_bridge(self) -> bool {
        matches!(self, HedgeRoute::LiquidityProvider)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            HedgeRoute::LiquidityProvider => "LIQUIDITY_PROVIDER",
            HedgeRoute::HedgeAccount => "HEDGE_ACCOUNT",
            HedgeRoute::None => "NONE",
        }
    }
}

/// `hedgeRouteOf(position)` from lib/hedge-route.ts, argument for argument.
///
/// `on_hedge_account` wins over everything (the account is `Broker.coverageAccountId`, or its group is
/// COVERAGE): its legs carry bookType A_BOOK, and an account sitting in an A-book group would otherwise send
/// its own legs to QoreBridge, hedging the hedge.
pub fn hedge_route_of(group_category_at_open: Option<&str>, book_type: &str, on_hedge_account: bool) -> HedgeRoute {
    // if (position.onHedgeAccount) return "NONE";
    if on_hedge_account {
        return HedgeRoute::None;
    }
    // if (position.groupCategoryAtOpen === "A_BOOK") return "LIQUIDITY_PROVIDER";
    if group_category_at_open == Some("A_BOOK") {
        return HedgeRoute::LiquidityProvider;
    }
    // if (position.groupCategoryAtOpen === "COVERAGE" || position.bookType !== "B_BOOK") return "NONE";
    if group_category_at_open == Some("COVERAGE") || book_type != "B_BOOK" {
        return HedgeRoute::None;
    }
    // return "HEDGE_ACCOUNT";
    HedgeRoute::HedgeAccount
}

/// `hedgeRouteOfCategory` -- the route a group's NEW positions take.
pub fn hedge_route_of_category(category: &str) -> HedgeRoute {
    match category {
        "A_BOOK" => HedgeRoute::LiquidityProvider,
        "COVERAGE" => HedgeRoute::None,
        _ => HedgeRoute::HedgeAccount,
    }
}

/// `autoHedgesOnFill` -- auto-hedge on the hedge account is DEALING groups only.
pub fn auto_hedges_on_fill(category: Option<&str>) -> bool {
    category == Some("DEALING")
}

// ---------------------------------------------------------------------------------------------------------
// FIX-safe intent ids
// ---------------------------------------------------------------------------------------------------------
//
// THE RULE IS THE BRIDGE'S, COPIED NOT GUESSED. qb-core/src/routing.rs:141 (`IntentRow::parse`):
//
//     pub const MAX_INTENT_ID: usize = 37;   // "legs append `_<n>` and a ClOrdID holds 40 characters"
//     let id_ok = !id.is_empty()
//         && id.len() <= MAX_INTENT_ID
//         && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
//
// WHY THE ENGINE DOES NOT LEAN ON THAT CHECK. An id that fails it is set aside by the bridge -- logged and
// skipped. That is the right thing for the bridge to do with input it does not trust, but from the engine's
// side it means one bad id becomes a silently un-hedged position: no intent reaches an LP and nothing fails
// loudly. So the engine mints ids that CANNOT be unsafe and asserts it at the point of minting. The guard
// below is the bridge's exact predicate, so the two can be compared; what the engine mints is a strict
// subset of it.

/// The bridge's cap on an intent id (qb-core routing.rs `MAX_INTENT_ID`).
pub const MAX_INTENT_ID: usize = 37;

/// What a ClOrdID holds. `MAX_INTENT_ID` is this minus the room a leg suffix needs.
pub const CLORDID_CAP: usize = 40;

/// The characters the engine mints from: uppercase hex plus the `H` prefix. A strict subset of the bridge's
/// alphabet, chosen so an id is unambiguous in a log and case-insensitive comparisons cannot collide.
const MINT_ALPHABET: &[u8] = b"0123456789ABCDEFH";

/// Minted length: `H` + 24 hex (96 bits). Short on purpose -- every leg appends `_<n>` and the total must
/// stay inside `CLORDID_CAP`, so a base of 25 leaves 15 characters of suffix headroom where the bridge's own
/// cap would leave only 3.
pub const INTENT_ID_LEN: usize = 25;

/// The bridge's predicate, character for character (qb-core routing.rs `IntentRow::parse`).
pub fn is_bridge_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_INTENT_ID
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Mint a new intent id. Safe by construction: the only source of characters is an uppercase-hex UUID and
/// the `H` prefix, both inside the bridge's alphabet, at a length that leaves room for the leg suffix.
///
/// The check is a real `assert!`, not a `debug_assert!`, on purpose: a release build must not be the one
/// place where the guarantee stops holding, and the cost is a single pass over 25 bytes per intent.
pub fn mint_intent_id() -> String {
    let hex = Uuid::new_v4().simple().to_string().to_uppercase();
    let id = format!("H{}", &hex[..INTENT_ID_LEN - 1]);
    // Two things are asserted, not one. `is_bridge_safe_id` is the bridge's own predicate, which is what
    // actually matters; the alphabet check is the stricter claim this function makes about itself, and
    // checking it here is what keeps MINT_ALPHABET load-bearing instead of a comment that can drift from
    // the code under it.
    assert!(
        is_bridge_safe_id(&id)
            && id.len() == INTENT_ID_LEN
            && id.bytes().all(|b| MINT_ALPHABET.contains(&b)),
        "minted an intent id the bridge would set aside; the position would go un-hedged in silence"
    );
    id
}

/// The id of leg `n` of an intent: what the bridge builds by appending `_<n>`.
///
/// Asserted rather than returned as a Result: the engine controls both halves, so a leg id that does not fit
/// is a bug here, not a condition to handle at runtime.
pub fn leg_id(intent_id: &str, n: u32) -> String {
    let leg = format!("{intent_id}_{n}");
    assert!(
        leg.len() <= CLORDID_CAP && is_bridge_safe_id(intent_id),
        "leg id {leg:?} does not fit a ClOrdID ({CLORDID_CAP}); the leg would be set aside"
    );
    leg
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every branch of lib/hedge-route.ts hedgeRouteOf, in the order that file states them.
    #[test]
    fn the_route_matches_the_web_case_for_case() {
        // the hedge account's own legs win over everything, whatever the stamps say
        assert_eq!(hedge_route_of(Some("A_BOOK"), "A_BOOK", true), HedgeRoute::None);
        assert_eq!(hedge_route_of(Some("DEALING"), "B_BOOK", true), HedgeRoute::None);

        // A_BOOK category is the ONLY thing that sends a position to the bridge
        assert_eq!(hedge_route_of(Some("A_BOOK"), "A_BOOK", false), HedgeRoute::LiquidityProvider);
        // ... and it still does when the two stamps disagree (category A_BOOK, bookType B_BOOK): its intents
        // are written, so the hedge account must refuse it
        assert_eq!(hedge_route_of(Some("A_BOOK"), "B_BOOK", false), HedgeRoute::LiquidityProvider);

        // COVERAGE is never routed
        assert_eq!(hedge_route_of(Some("COVERAGE"), "B_BOOK", false), HedgeRoute::None);
        // bookType A_BOOK under any other category: QoreBridge does not see it and the hedge account must not
        // take it either
        assert_eq!(hedge_route_of(Some("DEALING"), "A_BOOK", false), HedgeRoute::None);

        // the broker's own book
        assert_eq!(hedge_route_of(Some("DEALING"), "B_BOOK", false), HedgeRoute::HedgeAccount);
        assert_eq!(hedge_route_of(Some("B_BOOK"), "B_BOOK", false), HedgeRoute::HedgeAccount);
        assert_eq!(hedge_route_of(Some("REVERSAL"), "B_BOOK", false), HedgeRoute::HedgeAccount);

        // a position from before the category stamp is judged by its bookType alone
        assert_eq!(hedge_route_of(None, "B_BOOK", false), HedgeRoute::HedgeAccount);
        assert_eq!(hedge_route_of(None, "A_BOOK", false), HedgeRoute::None);
    }

    #[test]
    fn only_the_liquidity_provider_route_reaches_the_bridge() {
        assert!(hedge_route_of(Some("A_BOOK"), "A_BOOK", false).goes_to_bridge());
        assert!(!hedge_route_of(Some("DEALING"), "B_BOOK", false).goes_to_bridge());
        assert!(!hedge_route_of(Some("COVERAGE"), "B_BOOK", false).goes_to_bridge());
    }

    #[test]
    fn the_category_route_and_auto_hedge_match_the_web() {
        assert_eq!(hedge_route_of_category("A_BOOK"), HedgeRoute::LiquidityProvider);
        assert_eq!(hedge_route_of_category("COVERAGE"), HedgeRoute::None);
        assert_eq!(hedge_route_of_category("DEALING"), HedgeRoute::HedgeAccount);
        assert_eq!(hedge_route_of_category("B_BOOK"), HedgeRoute::HedgeAccount);

        assert!(auto_hedges_on_fill(Some("DEALING")));
        assert!(!auto_hedges_on_fill(Some("A_BOOK")));
        assert!(!auto_hedges_on_fill(None));
    }

    /// The guard is the bridge's predicate, so it must ACCEPT everything the bridge accepts. These would be
    /// wrong to call unsafe: the bridge takes them.
    #[test]
    fn the_guard_accepts_exactly_what_the_bridge_accepts() {
        assert!(is_bridge_safe_id("abc"), "lowercase is allowed by the bridge");
        assert!(is_bridge_safe_id("A-B"), "hyphen is allowed");
        assert!(is_bridge_safe_id("A_B"), "underscore is allowed -- it is the leg separator");
        assert!(is_bridge_safe_id("0"), "one character is allowed");
        assert!(is_bridge_safe_id(&"A".repeat(MAX_INTENT_ID)), "exactly at the cap");
        assert!(is_bridge_safe_id("cmwf7ve0h000gjy08u1gi7vf3"), "a web cuid passes the bridge rule");
    }

    /// ... and REFUSE what the bridge sets aside.
    #[test]
    fn an_unsafe_id_is_refused() {
        assert!(!is_bridge_safe_id(""), "empty");
        assert!(!is_bridge_safe_id("H0001\u{1}"), "SOH is the FIX field separator");
        assert!(!is_bridge_safe_id("H=0001"), "= is the FIX tag separator");
        assert!(!is_bridge_safe_id("H 0001"), "space");
        assert!(!is_bridge_safe_id("H\n0001"), "newline");
        assert!(!is_bridge_safe_id("H\t0001"), "tab");
        assert!(!is_bridge_safe_id("H.0001"), "dot");
        assert!(!is_bridge_safe_id("H/0001"), "slash");
        assert!(!is_bridge_safe_id("H:0001"), "colon");
        assert!(!is_bridge_safe_id("Hcaf\u{e9}"), "multi-byte UTF-8");
        assert!(!is_bridge_safe_id(&"A".repeat(MAX_INTENT_ID + 1)), "one over the cap");
    }

    /// The id the engine mints is safe every time, and short enough that its legs are too.
    #[test]
    fn every_minted_id_is_safe_and_leaves_room_for_its_legs() {
        for _ in 0..1000 {
            let id = mint_intent_id();
            assert!(is_bridge_safe_id(&id), "{id} is not bridge-safe");
            assert_eq!(id.len(), INTENT_ID_LEN);
            assert!(id.starts_with('H'));
            assert!(id.bytes().all(|b| MINT_ALPHABET.contains(&b)), "{id} left the mint alphabet");
        }
        // the whole reason the base is short: a leg id must still fit a ClOrdID
        let id = mint_intent_id();
        for n in [0u32, 1, 9, 10, 99, 100, 999, 999_999] {
            let leg = leg_id(&id, n);
            assert!(leg.len() <= CLORDID_CAP, "leg {leg} is longer than a ClOrdID");
            assert!(is_bridge_safe_id(&leg), "leg {leg} is not bridge-safe");
        }
    }

    /// A base id minted at the bridge's own cap would leave only three characters for the suffix. This is the
    /// case the short base exists to avoid, stated so the reason survives a future edit of INTENT_ID_LEN.
    #[test]
    fn the_short_base_is_what_buys_the_leg_headroom() {
        assert!(INTENT_ID_LEN <= MAX_INTENT_ID, "the base must itself be acceptable to the bridge");
        let headroom = CLORDID_CAP - INTENT_ID_LEN;
        assert!(headroom >= 5, "a leg suffix needs room: got {headroom} characters");
        // at the bridge's cap the headroom would be 3, which is "_99" and no further
        assert_eq!(CLORDID_CAP - MAX_INTENT_ID, 3);
    }

    #[test]
    fn minted_ids_do_not_repeat() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..5000 {
            assert!(
                seen.insert(mint_intent_id()),
                "intent ids are the idempotency key; a repeat would dedupe a real intent away"
            );
        }
    }
}
