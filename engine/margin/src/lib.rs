//! Ongoing margin monitoring — see ../../docs/risk-engine.md §2.2.
//! Separate crate from `risk` because this is a continuous, price-tick-
//! driven loop (margin call / stop-out) rather than a synchronous
//! pre-trade gate — `risk` handles the gate, this handles the monitor.
//! The loop itself needs a live price feed and Postgres access (Phase 2);
//! this crate currently holds only the pure decision logic so it's
//! unit-testable without either dependency.

use risk::margin_level;
use rust_decimal::Decimal;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorAction {
    Ok,
    MarginCall,
    StopOut,
}

/// Broker-configurable thresholds, per ../../docs/risk-engine.md §2.2.
/// The Default impl below is ONLY the documented fallback for an account
/// with no group at all (`Account.groupId IS NULL` — a real, valid state
/// for any account created before Group existed, or never assigned one;
/// see the Prisma schema's own comment on that field) — it must never be
/// silently substituted for a GROUPED account's own real, broker-
/// configured `marginCallLevel`/`stopOutLevel`. That was the actual bug:
/// every account evaluated against this compiled-in 100/50 regardless of
/// group config, because nothing ever loaded the real per-group values.
/// See `resolve_thresholds` below, which is the only sanctioned way to
/// get a `MarginThresholds` for a specific account from here on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarginThresholds {
    pub call_level: Decimal,
    pub stop_out_level: Decimal,
}

impl Default for MarginThresholds {
    fn default() -> Self {
        Self {
            call_level: Decimal::from(100),
            stop_out_level: Decimal::from(50),
        }
    }
}

/// Per-group thresholds, keyed by `Group.id`, as loaded from the live
/// `"Group"` table's own `marginCallLevel`/`stopOutLevel` columns — see
/// order-management::db::load_group_thresholds for the actual query.
/// Kept as a plain type alias (not a newtype) so a caller can build one
/// straight from a DB row map without going through this crate.
pub type ThresholdsByGroup = HashMap<String, MarginThresholds>;

/// The one function that decides what thresholds a specific account
/// evaluates against. Three outcomes, not two — deliberately distinct
/// from "just return a MarginThresholds":
/// - `group_id` is `Some` and present in `by_group`: `Some(t)`, that
///   group's own real configured values. The normal, correct case.
/// - `group_id` is `Some` but NOT present in `by_group`: `None`. The
///   loader hasn't (yet, or ever) populated this group — evaluating
///   anyway would silently fall back to *something* (a stale cached
///   value, or worse, the compiled default), which is exactly the bug
///   this whole fix exists to close. A caller must treat `None` as "do
///   not evaluate this account right now," not paper over it.
/// - `group_id` is `None`: `Some(MarginThresholds::default())` — the
///   account genuinely has no group (see this module's own doc comment
///   on the Default impl); this is the one place returning the compiled
///   default is correct, not a bug.
pub fn resolve_thresholds(group_id: Option<&str>, by_group: &ThresholdsByGroup) -> Option<MarginThresholds> {
    match group_id {
        Some(id) => by_group.get(id).copied(),
        None => Some(MarginThresholds::default()),
    }
}

/// Startup/live-order guard (combined batch risk item 2): every group
/// that at least one account actually belongs to must have a real,
/// loaded threshold entry before the engine may accept live orders --
/// `known_group_ids` is every DISTINCT `Account.groupId` currently in
/// use (from `order-management::db`), `by_group` is what the loader
/// actually got back. Returns the first group id found missing, if any,
/// so the caller can log/reject with a specific, actionable reason
/// rather than a bare bool.
pub fn missing_group_thresholds<'a>(known_group_ids: &'a [String], by_group: &ThresholdsByGroup) -> Option<&'a str> {
    known_group_ids.iter().find(|id| !by_group.contains_key(id.as_str())).map(|s| s.as_str())
}

pub fn evaluate(equity: Decimal, used_margin: Decimal, thresholds: MarginThresholds) -> MonitorAction {
    match margin_level(equity, used_margin) {
        None => MonitorAction::Ok, // flat account, nothing to monitor
        Some(level) if level < thresholds.stop_out_level => MonitorAction::StopOut,
        Some(level) if level < thresholds.call_level => MonitorAction::MarginCall,
        Some(_) => MonitorAction::Ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    // Combined batch risk item 2: this is the test that must fail if a
    // grouped account ever silently evaluates against the compiled
    // default again instead of its own group's real configured values --
    // the actual bug this whole change closes (MarginThresholds::default()
    // was passed to every account regardless of group).
    #[test]
    fn resolves_group_configured_thresholds_not_the_compiled_default() {
        let mut by_group = ThresholdsByGroup::new();
        by_group.insert("g1".into(), MarginThresholds { call_level: dec!(150), stop_out_level: dec!(80) });
        let resolved = resolve_thresholds(Some("g1"), &by_group).expect("group is loaded");
        assert_eq!(resolved.call_level, dec!(150));
        assert_eq!(resolved.stop_out_level, dec!(80));
        assert_ne!(resolved, MarginThresholds::default());
    }

    #[test]
    fn missing_group_in_cache_is_none_not_a_silent_default() {
        let by_group = ThresholdsByGroup::new(); // empty -- loader hasn't populated "g1" yet
        assert_eq!(resolve_thresholds(Some("g1"), &by_group), None);
    }

    #[test]
    fn ungrouped_account_uses_the_documented_default() {
        let by_group = ThresholdsByGroup::new();
        assert_eq!(resolve_thresholds(None, &by_group), Some(MarginThresholds::default()));
    }

    #[test]
    fn guard_flags_a_group_no_account_thresholds_were_loaded_for() {
        let known = vec!["g1".to_string(), "g2".to_string()];
        let mut by_group = ThresholdsByGroup::new();
        by_group.insert("g1".into(), MarginThresholds::default());
        // g2 missing -- e.g. a partial/failed load.
        assert_eq!(missing_group_thresholds(&known, &by_group), Some("g2"));
    }

    #[test]
    fn guard_passes_when_every_known_group_is_loaded() {
        let known = vec!["g1".to_string()];
        let mut by_group = ThresholdsByGroup::new();
        by_group.insert("g1".into(), MarginThresholds::default());
        assert_eq!(missing_group_thresholds(&known, &by_group), None);
    }

    #[test]
    fn ok_above_call_level() {
        let action = evaluate(dec!(2000), dec!(1000), MarginThresholds::default());
        assert_eq!(action, MonitorAction::Ok);
    }

    #[test]
    fn margin_call_between_thresholds() {
        // level = 75% — below 100 call, above 50 stop-out
        let action = evaluate(dec!(750), dec!(1000), MarginThresholds::default());
        assert_eq!(action, MonitorAction::MarginCall);
    }

    #[test]
    fn stop_out_below_floor() {
        let action = evaluate(dec!(300), dec!(1000), MarginThresholds::default());
        assert_eq!(action, MonitorAction::StopOut);
    }

    /// `< thresholds.call_level`, not `<=` -- exactly at the call level is
    /// still Ok. Implied by the code, previously unasserted.
    #[test]
    fn exactly_at_call_level_is_ok() {
        let action = evaluate(dec!(1000), dec!(1000), MarginThresholds::default()); // level = 100
        assert_eq!(action, MonitorAction::Ok);
    }

    /// Same "< not <=" semantic at the stop-out boundary -- exactly at
    /// the stop-out level is still just a MarginCall, not a StopOut.
    #[test]
    fn exactly_at_stop_out_level_is_margin_call() {
        let action = evaluate(dec!(500), dec!(1000), MarginThresholds::default()); // level = 50
        assert_eq!(action, MonitorAction::MarginCall);
    }

    #[test]
    fn flat_account_is_ok() {
        let action = evaluate(dec!(5000), dec!(0), MarginThresholds::default());
        assert_eq!(action, MonitorAction::Ok);
    }

    /// Every other test uses MarginThresholds::default() -- this proves
    /// a broker-specific threshold configuration actually changes the
    /// outcome, not just that the default happens to work.
    #[test]
    fn custom_thresholds_are_respected() {
        let thresholds = MarginThresholds { call_level: dec!(150), stop_out_level: dec!(80) };
        // level = 120: Ok under the default (100/50) thresholds, but
        // MarginCall under these broker-specific ones.
        let action = evaluate(dec!(1200), dec!(1000), thresholds);
        assert_eq!(action, MonitorAction::MarginCall);
    }
}
