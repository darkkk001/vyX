//! WHICH ACCOUNTS MAY ENTER THE ENGINE'S ORDER PATH (L2 Step 3, owner 2026-11-03).
//!
//! The cutover's first live exposure is one designated DEMO account. Everything else keeps filling on
//! the web, and must be unable to reach this path at all -- not "unlikely to", unable.
//!
//! WHY THIS IS THE BACKSTOP AND NOT THE ONLY GUARD. Three independent layers, in order of who is
//! trusted least:
//!
//!   1. the GATEWAY refuses to forward anything but the designated account, and separately asserts
//!      that account is `accountMode = DEMO` -- so a live id typed into its allow-list still refuses;
//!   2. the WEB's order route hands only that account to the engine (its guard is the route's first
//!      statement, so there is no path through it);
//!   3. THIS, inside the engine: anyone who holds the internal secret still cannot fill for an account
//!      that is not on the list. The gateway is not trusted to be the only check, because the engine's
//!      `/v1/orders/market` is reachable by anything with that secret.
//!
//! AND IT FAILS CLOSED AT START-UP, not here. `engine/server/src/main.rs` refuses to enable the order
//! path in `live` mode when `ENGINE_INGRESS_ACCOUNT_IDS` is empty -- so production cannot run with the
//! order half on and no list. This module therefore treats "no list installed" as UNRESTRICTED, which
//! is what the DB tests and parity harnesses need (they place orders for their own fixtures), and is
//! safe because no production process can reach that state.
//!
//! The list is set once, before the HTTP listener binds, for the same reason `db::use_prisma_book()`
//! is: no order can be taken before the rule that governs it is in place.

use std::sync::RwLock;

/// None = no restriction installed (tests, harnesses). Some(list) = only these accounts.
static ALLOWED: RwLock<Option<Vec<String>>> = RwLock::new(None);

/// Restrict the order path to `account_ids`. Called once at start-up, before the listener binds.
///
/// An EMPTY list is a real restriction meaning "nobody", not "everybody" -- the difference matters, and
/// `main.rs` refuses to start the order path with one rather than relying on it.
pub fn restrict_to(account_ids: Vec<String>) {
    *ALLOWED.write().unwrap_or_else(|p| p.into_inner()) = Some(account_ids);
}

/// Is this account allowed to use the engine's order path?
///
/// True when no restriction is installed. See the module doc for why that is the safe default HERE and
/// where the fail-closed decision actually lives.
pub fn allows(account_id: &str) -> bool {
    match &*ALLOWED.read().unwrap_or_else(|p| p.into_inner()) {
        None => true,
        Some(list) => list.iter().any(|id| id == account_id),
    }
}

/// Is a scope installed at all? The DEMO-only rule below applies only when one is -- an unrestricted
/// process (tests, harnesses) must keep filling for its own LIVE fixtures.
pub fn restricted() -> bool {
    ALLOWED.read().unwrap_or_else(|p| p.into_inner()).is_some()
}

/// Does `account_mode` satisfy the DEMO-only rule that comes with a scope?
///
/// SEPARATE FROM THE LIST, AND NOT OPTIONAL. The L2 Step 3 proof put a LIVE account ON the list and it
/// FILLED: the allow-list was the engine's only condition, so the one realistic mistake -- pasting the
/// wrong id into an environment variable -- went straight through. The list is a human artefact; this
/// is the database's own answer about the account, and it is why both are checked.
pub fn mode_allowed(account_mode: &str, allowlist_on: bool, engine_live_enabled: bool) -> bool {
    !restricted() || account_mode == "DEMO" || engine_live_allowed(account_mode, allowlist_on, engine_live_enabled)
}

/// THE live-cutover rule, and the only thing that lets a LIVE account onto this path
/// (docs/ENGINE-LIVE-ALLOWLIST.md, owner 2026-11-11). DORMANT: both columns default false, so this is
/// false for every account in the database today and `mode_allowed` above is byte-for-byte the rule it
/// has always been.
///
/// THREE conditions, all required, and the two flags are COLUMNS rather than anything this process can
/// be told: `Broker."engineLiveAllowlistOn"` is the broker-wide switch and `Account."engineLiveEnabled"`
/// is that one account's entry. Anything missing, NULL, unknown or false is NOT ALLOWED -- the caller
/// passes `false` for a column that is absent (see `db::allowlist_columns`), which is the same answer.
///
/// THE ENVIRONMENT LIST IS NOT PART OF THIS, deliberately. `ENGINE_INGRESS_ACCOUNT_IDS` stays what it
/// has always been -- the trial SCOPE -- and on its own it can never make a LIVE account eligible. That
/// separation is the whole point of the L2 Step 3 finding: a live id was pasted onto the list and FILLED,
/// because the list was the only condition. Now the list narrows, and these two columns admit.
///
/// The identical rule is `lib/risk-authority.ts engineLiveAllowed` in the web and `engineLiveAllowed` in
/// the gateway's `src/ingress-scope.ts`; all three are pinned to the same 324-case matrix in
/// `lib/engine-live-allowlist-cases.json`.
pub fn engine_live_allowed(account_mode: &str, allowlist_on: bool, engine_live_enabled: bool) -> bool {
    account_mode == "LIVE" && allowlist_on && engine_live_enabled
}

/// Is a restriction installed at all, and how many accounts does it name? For start-up logging and the
/// `/health`-style answers, so an operator can see the scope the process is actually running with
/// rather than the one they believe they configured.
pub fn scope() -> Option<usize> {
    ALLOWED.read().unwrap_or_else(|p| p.into_inner()).as_ref().map(|l| l.len())
}

/// Parses `ENGINE_INGRESS_ACCOUNT_IDS`: comma-separated account ids, blanks ignored.
pub fn parse_list(raw: &str) -> Vec<String> {
    raw.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_parses_the_way_an_operator_would_write_it() {
        assert_eq!(parse_list("a,b"), vec!["a", "b"]);
        assert_eq!(parse_list(" a , b ,"), vec!["a", "b"]);
        assert_eq!(parse_list(""), Vec::<String>::new());
        assert_eq!(parse_list("  ,  "), Vec::<String>::new());
        // one id, which is the shape Step 3 actually runs with
        assert_eq!(parse_list("cmvzzzovp000nl208tujjh7l4"), vec!["cmvzzzovp000nl208tujjh7l4"]);
    }

    /// The whole point: a list that names one account excludes every other, and an EMPTY list excludes
    /// everyone rather than letting everyone through.
    #[test]
    fn a_list_excludes_everything_it_does_not_name() {
        // these run in one process, so the global is set and read in one test rather than racing
        assert!(allows("anything"), "no restriction installed yet");
        restrict_to(vec!["demo-1".to_string()]);
        assert!(allows("demo-1"));
        assert!(!allows("live-1"), "a live account must not be allowed");
        assert!(!allows(""), "nor an empty id");
        assert!(!allows("demo-11"), "nor a prefix/suffix near-miss");
        assert_eq!(scope(), Some(1));

        restrict_to(Vec::new());
        assert!(!allows("demo-1"), "an EMPTY list means nobody, not everybody");
        assert_eq!(scope(), Some(0));
    }
}
