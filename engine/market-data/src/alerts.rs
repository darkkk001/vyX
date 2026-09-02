//! Real, server-evaluated price alerts (Phase 1 trust pack §3) --
//! replaces WebTrader.tsx's old client-side-only mock (an in-memory
//! array that reset on every page reload and was only ever checked by
//! the browser tab that set it). Holds every ACTIVE alert in memory,
//! keyed by symbol, and checks it against every real tick this engine
//! ingests (ingest.rs's own ingest_ticks) -- the same process that
//! already sees every tick, not the trader's own local feed. Loaded once
//! at boot from every ACTIVE PriceAlert row and hot-reloaded via NATS
//! (`cfg.alerts.{brokerId}`) whenever app/api/trade/alerts creates or
//! cancels one, so a new alert takes effect within one NATS round trip,
//! not a restart.

use rust_decimal::Decimal;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertCondition {
    Above,
    Below,
    Crosses,
}

#[derive(Debug, Clone)]
pub struct PriceAlert {
    pub id: String,
    pub account_id: String,
    pub broker_id: String,
    pub symbol: String,
    pub condition: AlertCondition,
    pub price: Decimal,
}

#[derive(Debug, Clone)]
pub struct TriggeredAlert {
    pub alert: PriceAlert,
    pub triggered_price: Decimal,
}

/// Matches the Postgres `AlertCondition` enum's exact values (Prisma
/// schema, migration 20260831120000_price_alerts) -- the one place this
/// crate's own AlertCondition converts to/from the DB/wire representation,
/// shared by db.rs's load/persist and engine/server's own NATS payloads
/// (cfg.alerts.{brokerId} hot-reload, alert.triggered publish) so both
/// sides of every hop agree on the same three strings.
pub fn condition_to_str(c: AlertCondition) -> &'static str {
    match c {
        AlertCondition::Above => "ABOVE",
        AlertCondition::Below => "BELOW",
        AlertCondition::Crosses => "CROSSES",
    }
}

pub fn condition_from_str(s: &str) -> Option<AlertCondition> {
    match s {
        "ABOVE" => Some(AlertCondition::Above),
        "BELOW" => Some(AlertCondition::Below),
        "CROSSES" => Some(AlertCondition::Crosses),
        _ => None,
    }
}

/// Pure -- the actual ABOVE/BELOW/CROSSES semantics, gap-through safe:
/// every branch is an inequality or a sign-change comparison, never
/// exact equality, so a tick that jumps clean over the target without
/// ever landing on it exactly still triggers. `prev_price` is `None` on
/// the very first tick this engine has ever seen for a symbol (nothing
/// to compare against yet) -- ABOVE/BELOW can still fire on that first
/// tick (a pure level check needs no history), CROSSES cannot (a
/// direction change needs two points) and returns false until a second
/// tick arrives.
pub fn evaluate_alert(
    condition: AlertCondition,
    target: Decimal,
    prev_price: Option<Decimal>,
    current_price: Decimal,
) -> bool {
    match condition {
        AlertCondition::Above => current_price >= target,
        AlertCondition::Below => current_price <= target,
        AlertCondition::Crosses => match prev_price {
            None => false,
            Some(prev) => (prev < target && current_price >= target) || (prev > target && current_price <= target),
        },
    }
}

/// In-memory alert book -- see this module's own doc comment for the
/// load/hot-reload/check-per-tick lifecycle.
pub struct AlertCache {
    by_symbol: Mutex<HashMap<String, Vec<PriceAlert>>>,
    // Per-symbol last-seen price, for CROSSES's own prev/current
    // comparison -- independent of market_data::cache::TickCache (that
    // one holds a full Tick plus dirty-flush bookkeeping this only needs
    // the bare price for).
    last_price: Mutex<HashMap<String, Decimal>>,
}

impl AlertCache {
    pub fn new() -> Self {
        Self { by_symbol: Mutex::new(HashMap::new()), last_price: Mutex::new(HashMap::new()) }
    }

    /// Boot-time load -- replaces the entire book with exactly what's
    /// ACTIVE in Postgres right now. Also used to recover after a
    /// suspected hot-reload gap (a full resync), not just at startup.
    pub fn load(&self, alerts: Vec<PriceAlert>) {
        let mut guard = self.by_symbol.lock().unwrap_or_else(|e| e.into_inner());
        guard.clear();
        for alert in alerts {
            guard.entry(alert.symbol.clone()).or_default().push(alert);
        }
    }

    /// Hot-reload add -- a new alert created via POST /api/trade/alerts,
    /// forwarded over `cfg.alerts.{brokerId}`.
    pub fn add(&self, alert: PriceAlert) {
        let mut guard = self.by_symbol.lock().unwrap_or_else(|e| e.into_inner());
        guard.entry(alert.symbol.clone()).or_default().push(alert);
    }

    /// Hot-reload remove -- a cancel (DELETE /api/trade/alerts/:id) or
    /// this cache's own check_tick firing one (see that method's own
    /// comment on why a fired alert is removed here rather than merely
    /// marked).
    pub fn remove(&self, alert_id: &str) {
        let mut guard = self.by_symbol.lock().unwrap_or_else(|e| e.into_inner());
        for alerts in guard.values_mut() {
            alerts.retain(|a| a.id != alert_id);
        }
    }

    #[cfg(test)]
    fn count_for_symbol(&self, symbol: &str) -> usize {
        let guard = self.by_symbol.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(symbol).map(|v| v.len()).unwrap_or(0)
    }

    /// Total active alerts across every symbol -- the gauge half of
    /// GET /internal/alert-stats (engine/server/src/main.rs's
    /// alert_stats handler); AlertMetrics below only tracks cumulative
    /// counters, since "how many right now" is already exactly what this
    /// cache's own book holds, not something to duplicate in a separate
    /// counter that could drift out of sync with it.
    pub fn count_total(&self) -> usize {
        let guard = self.by_symbol.lock().unwrap_or_else(|e| e.into_inner());
        guard.values().map(|v| v.len()).sum()
    }

    /// Called once per tick (ingest.rs) -- checks every active alert for
    /// this symbol and returns whichever fired. A fired alert is removed
    /// from the in-memory book immediately (not just returned) since
    /// TRIGGERED is a one-shot terminal status -- without this, the same
    /// alert would fire again on literally the next tick since nothing
    /// else marks "already fired" state. The caller (ingest.rs) is
    /// responsible for persisting the TRIGGERED status/timestamp/price to
    /// Postgres and publishing `alert.triggered` -- this method only
    /// owns the in-memory decision.
    pub fn check_tick(&self, symbol: &str, current_price: Decimal) -> Vec<TriggeredAlert> {
        let prev_price = {
            let mut last = self.last_price.lock().unwrap_or_else(|e| e.into_inner());
            let prev = last.get(symbol).copied();
            last.insert(symbol.to_string(), current_price);
            prev
        };

        let mut guard = self.by_symbol.lock().unwrap_or_else(|e| e.into_inner());
        let Some(alerts) = guard.get_mut(symbol) else {
            return Vec::new();
        };

        let mut triggered = Vec::new();
        alerts.retain(|alert| {
            if evaluate_alert(alert.condition, alert.price, prev_price, current_price) {
                triggered.push(TriggeredAlert { alert: alert.clone(), triggered_price: current_price });
                false // remove -- fired, one-shot
            } else {
                true
            }
        });
        triggered
    }
}

impl Default for AlertCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Cumulative alert-pipeline counters -- same "in-memory atomics, no
/// Prometheus" convention as market_data::stats::FeedStats (see that
/// module's own doc comment on why, at this scale). Read via
/// GET /internal/alert-stats (engine/server/src/main.rs), same
/// shared-secret guard as /internal/feed-stats. Separate struct from
/// AlertCache itself (rather than folding counters into it) since these
/// are pure bookkeeping with no bearing on which alerts are actually
/// watched -- AlertCache stays the single source of truth for that,
/// queried live via count_total() rather than mirrored into a counter
/// here that could drift out of sync with it.
pub struct AlertMetrics {
    triggered_total: AtomicU64,
    // A trigger that fired in-memory (removed from AlertCache, one-shot)
    // but failed to persist to Postgres -- see engine/server's
    // ingest_price_feed handler, which deliberately does not publish
    // alert.triggered when this happens. Real ops signal: every count
    // here is an alert a trader will never be notified fired, until the
    // next full AlertCache::load() resync (a boot, or a manual recovery)
    // picks it back up from Postgres's still-ACTIVE row.
    persist_failures_total: AtomicU64,
    hot_reload_add_total: AtomicU64,
    hot_reload_cancel_total: AtomicU64,
    // Any cfg.alerts.* message this engine couldn't act on: unparseable
    // JSON, a missing required field, an unrecognized condition/action.
    // Doesn't distinguish which -- the point of this counter is only "is
    // the hot-reload pipeline healthy", the *cause* is what engine.log's
    // own tracing::warn! lines (already emitted at each of these sites)
    // are for.
    hot_reload_malformed_total: AtomicU64,
}

impl AlertMetrics {
    pub fn new() -> Self {
        Self {
            triggered_total: AtomicU64::new(0),
            persist_failures_total: AtomicU64::new(0),
            hot_reload_add_total: AtomicU64::new(0),
            hot_reload_cancel_total: AtomicU64::new(0),
            hot_reload_malformed_total: AtomicU64::new(0),
        }
    }

    pub fn record_triggered(&self) {
        self.triggered_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_persist_failure(&self) {
        self.persist_failures_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_hot_reload_add(&self) {
        self.hot_reload_add_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_hot_reload_cancel(&self) {
        self.hot_reload_cancel_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_hot_reload_malformed(&self) {
        self.hot_reload_malformed_total.fetch_add(1, Ordering::Relaxed);
    }

    /// `active_alerts_total` is the caller's own AlertCache.count_total()
    /// reading, not this struct's -- see this struct's own doc comment.
    pub fn snapshot(&self, active_alerts_total: usize) -> AlertMetricsSnapshot {
        AlertMetricsSnapshot {
            active_alerts_total,
            triggered_total: self.triggered_total.load(Ordering::Relaxed),
            persist_failures_total: self.persist_failures_total.load(Ordering::Relaxed),
            hot_reload_add_total: self.hot_reload_add_total.load(Ordering::Relaxed),
            hot_reload_cancel_total: self.hot_reload_cancel_total.load(Ordering::Relaxed),
            hot_reload_malformed_total: self.hot_reload_malformed_total.load(Ordering::Relaxed),
        }
    }
}

impl Default for AlertMetrics {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize)]
pub struct AlertMetricsSnapshot {
    pub active_alerts_total: usize,
    pub triggered_total: u64,
    pub persist_failures_total: u64,
    pub hot_reload_add_total: u64,
    pub hot_reload_cancel_total: u64,
    pub hot_reload_malformed_total: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn alert(id: &str, symbol: &str, condition: AlertCondition, price: Decimal) -> PriceAlert {
        PriceAlert {
            id: id.to_string(),
            account_id: "acct-1".to_string(),
            broker_id: "broker-1".to_string(),
            symbol: symbol.to_string(),
            condition,
            price,
        }
    }

    mod evaluate_alert_tests {
        use super::*;

        #[test]
        fn above_fires_the_moment_price_reaches_or_exceeds_target() {
            assert!(!evaluate_alert(AlertCondition::Above, dec!(2000), None, dec!(1999)));
            assert!(evaluate_alert(AlertCondition::Above, dec!(2000), None, dec!(2000)));
            assert!(evaluate_alert(AlertCondition::Above, dec!(2000), None, dec!(2001)));
        }

        #[test]
        fn above_fires_on_a_gap_through_the_target_without_ever_touching_it_exactly() {
            // A real tick jumping from 1995 to 2005 never equals 2000 --
            // this is the "incl. gap-through" case from the brief.
            assert!(evaluate_alert(AlertCondition::Above, dec!(2000), Some(dec!(1995)), dec!(2005)));
        }

        #[test]
        fn below_fires_the_moment_price_reaches_or_drops_below_target() {
            assert!(!evaluate_alert(AlertCondition::Below, dec!(2000), None, dec!(2001)));
            assert!(evaluate_alert(AlertCondition::Below, dec!(2000), None, dec!(2000)));
            assert!(evaluate_alert(AlertCondition::Below, dec!(2000), None, dec!(1999)));
        }

        #[test]
        fn below_fires_on_a_gap_through_the_target() {
            assert!(evaluate_alert(AlertCondition::Below, dec!(2000), Some(dec!(2005)), dec!(1995)));
        }

        #[test]
        fn crosses_never_fires_on_the_first_tick_ever_seen_no_history_to_compare() {
            assert!(!evaluate_alert(AlertCondition::Crosses, dec!(2000), None, dec!(2000)));
            assert!(!evaluate_alert(AlertCondition::Crosses, dec!(2000), None, dec!(1999)));
        }

        #[test]
        fn crosses_fires_moving_up_through_the_target() {
            assert!(evaluate_alert(AlertCondition::Crosses, dec!(2000), Some(dec!(1999)), dec!(2001)));
        }

        #[test]
        fn crosses_fires_moving_down_through_the_target() {
            assert!(evaluate_alert(AlertCondition::Crosses, dec!(2000), Some(dec!(2001)), dec!(1999)));
        }

        #[test]
        fn crosses_fires_on_a_gap_through_the_target_in_either_direction() {
            // Never actually touches 2000 in either case -- the gap-through
            // case CROSSES specifically exists to handle correctly.
            assert!(evaluate_alert(AlertCondition::Crosses, dec!(2000), Some(dec!(1990)), dec!(2010)));
            assert!(evaluate_alert(AlertCondition::Crosses, dec!(2000), Some(dec!(2010)), dec!(1990)));
        }

        #[test]
        fn crosses_does_not_fire_when_staying_on_the_same_side() {
            assert!(!evaluate_alert(AlertCondition::Crosses, dec!(2000), Some(dec!(1990)), dec!(1995)));
            assert!(!evaluate_alert(AlertCondition::Crosses, dec!(2000), Some(dec!(2010)), dec!(2005)));
        }

        #[test]
        fn crosses_landing_exactly_on_the_target_counts_as_having_crossed() {
            assert!(evaluate_alert(AlertCondition::Crosses, dec!(2000), Some(dec!(1990)), dec!(2000)));
            assert!(evaluate_alert(AlertCondition::Crosses, dec!(2000), Some(dec!(2010)), dec!(2000)));
        }
    }

    mod alert_cache_tests {
        use super::*;

        #[test]
        fn a_fired_alert_is_removed_and_never_fires_again_on_the_next_tick() {
            let cache = AlertCache::new();
            cache.add(alert("a1", "XAUUSD", AlertCondition::Above, dec!(2000)));

            let first = cache.check_tick("XAUUSD", dec!(2001));
            assert_eq!(first.len(), 1);
            assert_eq!(first[0].alert.id, "a1");
            assert_eq!(cache.count_for_symbol("XAUUSD"), 0);

            let second = cache.check_tick("XAUUSD", dec!(2002));
            assert!(second.is_empty(), "an already-fired alert must never fire twice");
        }

        #[test]
        fn only_the_matching_symbol_is_checked_others_are_untouched() {
            let cache = AlertCache::new();
            cache.add(alert("a1", "XAUUSD", AlertCondition::Above, dec!(2000)));
            cache.add(alert("a2", "EURUSD", AlertCondition::Above, dec!(1.10)));

            let fired = cache.check_tick("XAUUSD", dec!(2500));
            assert_eq!(fired.len(), 1);
            assert_eq!(fired[0].alert.id, "a1");
            assert_eq!(cache.count_for_symbol("EURUSD"), 1, "EURUSD's own alert must be untouched by an XAUUSD tick");
        }

        #[test]
        fn multiple_alerts_on_the_same_symbol_fire_independently() {
            let cache = AlertCache::new();
            cache.add(alert("a1", "XAUUSD", AlertCondition::Above, dec!(2000)));
            cache.add(alert("a2", "XAUUSD", AlertCondition::Above, dec!(3000)));

            let fired = cache.check_tick("XAUUSD", dec!(2500));
            assert_eq!(fired.len(), 1);
            assert_eq!(fired[0].alert.id, "a1");
            assert_eq!(cache.count_for_symbol("XAUUSD"), 1, "a2 hasn't hit its own target yet");

            let fired2 = cache.check_tick("XAUUSD", dec!(3500));
            assert_eq!(fired2.len(), 1);
            assert_eq!(fired2[0].alert.id, "a2");
        }

        #[test]
        fn remove_takes_a_cancelled_alert_out_before_it_can_ever_fire() {
            let cache = AlertCache::new();
            cache.add(alert("a1", "XAUUSD", AlertCondition::Above, dec!(2000)));
            cache.remove("a1");

            let fired = cache.check_tick("XAUUSD", dec!(2500));
            assert!(fired.is_empty());
        }

        #[test]
        fn load_replaces_the_whole_book_boot_time_semantics() {
            let cache = AlertCache::new();
            cache.add(alert("stale", "XAUUSD", AlertCondition::Above, dec!(1)));
            cache.load(vec![alert("fresh", "XAUUSD", AlertCondition::Above, dec!(2000))]);

            assert_eq!(cache.count_for_symbol("XAUUSD"), 1);
            let fired = cache.check_tick("XAUUSD", dec!(2500));
            assert_eq!(fired[0].alert.id, "fresh");
        }

        #[test]
        fn crosses_works_end_to_end_through_the_cache_using_its_own_last_price_tracking() {
            let cache = AlertCache::new();
            cache.add(alert("a1", "XAUUSD", AlertCondition::Crosses, dec!(2000)));

            // First tick ever for this symbol in this cache -- no prior
            // price to compare against, so no cross detected yet even
            // though this tick is already above the target.
            assert!(cache.check_tick("XAUUSD", dec!(2001)).is_empty());
            // Still above target, same side as the previous tick -- no
            // cross (moving further away, not through).
            assert!(cache.check_tick("XAUUSD", dec!(2002)).is_empty());
            // Now genuinely crosses down through 2000 (prev 2002 -> now 1999).
            let fired = cache.check_tick("XAUUSD", dec!(1999));
            assert_eq!(fired.len(), 1);
            assert_eq!(fired[0].alert.id, "a1");
        }

        #[test]
        fn count_total_sums_every_symbol_not_just_one() {
            let cache = AlertCache::new();
            cache.add(alert("a1", "XAUUSD", AlertCondition::Above, dec!(2000)));
            cache.add(alert("a2", "XAUUSD", AlertCondition::Above, dec!(3000)));
            cache.add(alert("a3", "EURUSD", AlertCondition::Above, dec!(1.10)));
            assert_eq!(cache.count_total(), 3);

            cache.check_tick("XAUUSD", dec!(2500)); // fires a1 only
            assert_eq!(cache.count_total(), 2);
        }
    }

    mod alert_metrics_tests {
        use super::*;

        #[test]
        fn counters_start_at_zero_and_active_alerts_total_reflects_whatever_the_caller_passes() {
            let metrics = AlertMetrics::new();
            let snap = metrics.snapshot(0);
            assert_eq!(snap.active_alerts_total, 0);
            assert_eq!(snap.triggered_total, 0);
            assert_eq!(snap.persist_failures_total, 0);
            assert_eq!(snap.hot_reload_add_total, 0);
            assert_eq!(snap.hot_reload_cancel_total, 0);
            assert_eq!(snap.hot_reload_malformed_total, 0);

            let snap2 = metrics.snapshot(7);
            assert_eq!(snap2.active_alerts_total, 7);
        }

        #[test]
        fn each_counter_accumulates_independently() {
            let metrics = AlertMetrics::new();
            metrics.record_triggered();
            metrics.record_triggered();
            metrics.record_persist_failure();
            metrics.record_hot_reload_add();
            metrics.record_hot_reload_add();
            metrics.record_hot_reload_add();
            metrics.record_hot_reload_cancel();
            metrics.record_hot_reload_malformed();

            let snap = metrics.snapshot(1);
            assert_eq!(snap.triggered_total, 2);
            assert_eq!(snap.persist_failures_total, 1);
            assert_eq!(snap.hot_reload_add_total, 3);
            assert_eq!(snap.hot_reload_cancel_total, 1);
            assert_eq!(snap.hot_reload_malformed_total, 1);
        }
    }
}
