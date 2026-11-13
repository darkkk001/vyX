//! THE CONTROL PLANE'S RULE, ENGINE-SIDE (owner 2026-11-13; the web's half is `lib/engine-registry.ts`
//! and migration `20261113130000_engine_registry`).
//!
//! The console registers engines (`Engine`: id = this process's `ENGINE_ID`, region, gateway, status,
//! `lastBeatAt`, `staleAfterSecs`) and assigns brokers to them (`Broker.engineId`). This module is the
//! engine's side of the same rule, and it is deliberately a mirror rather than a second opinion.
//!
//! THREE THINGS THIS ENGINE DOES NOT DO, each for a reason:
//!
//! 1. IT DOES NOT QUERY THE CONTROL DATABASE for its own assignment. The `engine_broker_scope` view
//!    exists so the server can answer `which brokers does engine X serve?`, and the engine asks
//!    `/api/engine/config` for the answer. If the engine read the view itself it would need credentials
//!    on the control plane and would pin itself to that schema; with the pull, the view can change
//!    shape tomorrow and only the route changes. (The view also already encodes "PLANNED and RETIRED
//!    list nothing", so the two sides cannot drift on that either.)
//!
//! 2. IT DOES NOT WRITE `Engine.lastBeatAt` ITSELF. Its one heartbeat is the status report to
//!    `/api/internal/engine-status`, and THAT route writes the row -- because the web's owner rule
//!    (`loadRiskOwners`, `assertRiskActorInTx`) reads that row, and a heartbeat that the engine wrote
//!    directly while the report failed would tell the web "this engine is fine" when the platform
//!    cannot hear from it at all. One beat, one path, one meaning.
//!
//! 3. IT DOES NOT ASSUME IT IS SERVING. Between config pulls, the last good answer stands only for
//!    `GRACE`; after that the engine serves nothing. `assign_to(vec![])` would not do -- an empty list
//!    collapses to "no assignment", which means serve EVERYTHING -- so standing down goes through
//!    `broker_scope::serve_nothing()`, by name.
//!
//! The web's `engineAliveForBroker` and this module are two halves of one rule:
//!
//! | engine status | web (`engineAliveForBroker`) | engine (here) |
//! |---|---|---|
//! | ACTIVE / DRAINING, beat fresh | the engine owns its brokers | serves the assigned brokers |
//! | PLANNED / RETIRED | the web owns them | serves nothing |
//! | beat stale | the web owns them | (the beat stops when it serves nothing) |
//!
//! They meet at the heartbeat: the engine stands down, so its beats stop, so the web takes over. The
//! engine standing down FIRST is what makes that safe -- see `license_gate` for the same ordering
//! applied to a license stop, where the handover is confirmed before anything is given up.

use std::time::Duration;

/// How long the last good config answer stands after the control plane stops answering. Owner's
/// figure. Deliberately longer than a pull interval and shorter than the heartbeat staleness the web
/// judges by, so an engine stands down before the web has to notice it went quiet.
pub const CONFIG_GRACE: Duration = Duration::from_secs(60);

/// The status the control plane reports for this engine. Unknown strings are NOT treated as serving:
/// a status this build does not understand is a reason to stand down, not to guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineStatus {
    Planned,
    Active,
    Draining,
    Retired,
    /// A value this build does not know. Serves nothing.
    Unknown,
}

impl EngineStatus {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_uppercase().as_str() {
            "PLANNED" => Self::Planned,
            "ACTIVE" => Self::Active,
            "DRAINING" => Self::Draining,
            "RETIRED" => Self::Retired,
            _ => Self::Unknown,
        }
    }

    /// The `SERVING` set of `lib/engine-registry.ts`: ACTIVE and DRAINING, and nothing else. DRAINING
    /// serves on purpose -- that is the state a migration passes through, and dropping its brokers
    /// mid-drain is exactly what must not happen.
    pub fn serves(self) -> bool {
        matches!(self, Self::Active | Self::Draining)
    }
}

/// What `/api/engine/config` last told us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigAnswer {
    pub status: EngineStatus,
    /// `engine_broker_scope` for this engine id, as the SERVER read it. Already empty for a PLANNED or
    /// RETIRED engine, because the view lists only ACTIVE and DRAINING.
    pub assigned_brokers: Vec<String>,
}

/// What the engine should serve right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// Serve exactly these brokers.
    Brokers(Vec<String>),
    /// Serve nothing, and why.
    Nothing(&'static str),
}

impl Scope {
    pub fn serves_anything(&self) -> bool {
        matches!(self, Scope::Brokers(b) if !b.is_empty())
    }
}

/// The decision, from the last good answer and how old it is.
///
/// `age` is the time since that answer was RECEIVED, not since it was issued: the question is how long
/// this engine has been out of contact, which is what the grace is about.
pub fn scope_for(last: Option<&ConfigAnswer>, age: Duration, grace: Duration) -> Scope {
    let Some(answer) = last else {
        // Never got one. An engine that has never been told what it serves serves nothing -- it must
        // not fall back on "no assignment", which would mean every broker.
        return Scope::Nothing("no configuration has been received yet");
    };
    if age > grace {
        return Scope::Nothing("the control plane has not answered within the grace window");
    }
    if !answer.status.serves() {
        return match answer.status {
            EngineStatus::Retired => Scope::Nothing("this engine is RETIRED"),
            EngineStatus::Planned => Scope::Nothing("this engine is PLANNED and has not been brought into service"),
            _ => Scope::Nothing("the control plane reported a status this build does not recognise"),
        };
    }
    if answer.assigned_brokers.is_empty() {
        // ACTIVE with nothing assigned is a real and legitimate state (a new engine, or one drained to
        // empty). It serves nothing -- which is NOT the same as having no assignment.
        return Scope::Nothing("no broker is assigned to this engine");
    }
    Scope::Brokers(answer.assigned_brokers.clone())
}

/// Install the decision into the process-wide scope the queries read.
///
/// The one place that turns a decision into the thing every scoped statement uses, so there is one
/// place to look when asking "why is this engine serving that?".
pub fn install(scope: &Scope) {
    match scope {
        Scope::Brokers(ids) => protocol::broker_scope::assign_to(ids.clone()),
        Scope::Nothing(_) => protocol::broker_scope::serve_nothing(),
    }
}

/// May the engine send its heartbeat? Only while it is actually serving something.
///
/// This is what closes the loop with the web: an engine that has stood down stops beating, its
/// `Engine.lastBeatAt` goes stale, and `engineAliveForBroker` hands its brokers to the web. If a
/// stood-down engine kept beating, the web would go on believing the engine owns accounts that nothing
/// is evaluating -- the silent risk outage this whole design exists to prevent.
pub fn should_beat(scope: &Scope) -> bool {
    scope.serves_anything()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(status: &str, brokers: &[&str]) -> ConfigAnswer {
        ConfigAnswer {
            status: EngineStatus::parse(status),
            assigned_brokers: brokers.iter().map(|s| s.to_string()).collect(),
        }
    }
    const FRESH: Duration = Duration::from_secs(5);
    const STALE: Duration = Duration::from_secs(61);

    #[test]
    fn an_active_engine_serves_exactly_what_the_control_plane_assigned() {
        let s = scope_for(Some(&answer("ACTIVE", &["b1", "b2"])), FRESH, CONFIG_GRACE);
        assert_eq!(s, Scope::Brokers(vec!["b1".into(), "b2".into()]));
        assert!(should_beat(&s));
    }

    #[test]
    fn a_draining_engine_keeps_serving_because_that_is_what_draining_means() {
        let s = scope_for(Some(&answer("DRAINING", &["b1"])), FRESH, CONFIG_GRACE);
        assert_eq!(s, Scope::Brokers(vec!["b1".into()]));
        assert!(should_beat(&s), "dropping a draining engine's brokers mid-migration is the failure this avoids");
    }

    #[test]
    fn a_retired_engine_serves_nothing_even_if_brokers_are_still_listed() {
        // The view would not list them, but the engine must not depend on that to be safe.
        let s = scope_for(Some(&answer("RETIRED", &["b1", "b2"])), FRESH, CONFIG_GRACE);
        assert_eq!(s, Scope::Nothing("this engine is RETIRED"));
        assert!(!should_beat(&s), "a retired engine must stop beating so the web takes its brokers");
    }

    #[test]
    fn a_planned_engine_serves_nothing() {
        let s = scope_for(Some(&answer("PLANNED", &["b1"])), FRESH, CONFIG_GRACE);
        assert!(!s.serves_anything());
        assert!(!should_beat(&s));
    }

    #[test]
    fn a_status_this_build_does_not_know_serves_nothing_rather_than_guessing() {
        let s = scope_for(Some(&answer("SOMETHING_NEW", &["b1"])), FRESH, CONFIG_GRACE);
        assert!(!s.serves_anything());
        assert_eq!(EngineStatus::parse("SOMETHING_NEW"), EngineStatus::Unknown);
    }

    #[test]
    fn the_last_good_answer_stands_inside_the_grace_and_not_a_moment_longer() {
        let a = answer("ACTIVE", &["b1"]);
        assert!(scope_for(Some(&a), Duration::from_secs(59), CONFIG_GRACE).serves_anything());
        assert!(scope_for(Some(&a), CONFIG_GRACE, CONFIG_GRACE).serves_anything(), "exactly at the grace is still inside it");
        let out = scope_for(Some(&a), STALE, CONFIG_GRACE);
        assert_eq!(out, Scope::Nothing("the control plane has not answered within the grace window"));
        assert!(!should_beat(&out), "out of contact and still beating would tell the web a lie");
    }

    #[test]
    fn having_never_been_told_anything_serves_nothing_not_everything() {
        // The trap this guards: "no assignment" means serve EVERY broker, which is the dormant default
        // and the opposite of what an engine with no answer should do.
        let s = scope_for(None, FRESH, CONFIG_GRACE);
        assert_eq!(s, Scope::Nothing("no configuration has been received yet"));
        assert!(!should_beat(&s));
    }

    #[test]
    fn an_active_engine_with_nothing_assigned_serves_nothing() {
        let s = scope_for(Some(&answer("ACTIVE", &[])), FRESH, CONFIG_GRACE);
        assert_eq!(s, Scope::Nothing("no broker is assigned to this engine"));
        assert!(!should_beat(&s));
    }

    #[test]
    fn install_puts_serve_nothing_and_an_assignment_into_different_states() {
        // The distinction the whole module rests on, asserted against the real process-wide scope.
        protocol::broker_scope::clear();
        install(&Scope::Brokers(vec!["b1".into()]));
        assert_eq!(protocol::broker_scope::assigned(), Some(vec!["b1".to_string()]));
        assert!(!protocol::broker_scope::is_serving_nothing());

        install(&Scope::Nothing("retired"));
        assert!(protocol::broker_scope::is_serving_nothing(), "standing down must not read as 'no assignment'");
        assert_eq!(protocol::broker_scope::assigned(), Some(vec![]));
        assert!(protocol::broker_scope::is_assigned(), "serving nothing IS an assignment, just an empty one");

        protocol::broker_scope::clear();
        assert_eq!(protocol::broker_scope::assigned(), None, "and 'no assignment' is a third thing again");
        assert!(!protocol::broker_scope::is_serving_nothing());
    }

    #[test]
    fn the_engine_only_beats_while_it_serves_something() {
        // The loop that closes with the web: stood down -> no beat -> lastBeatAt goes stale ->
        // engineAliveForBroker hands the brokers back.
        for s in [
            Scope::Nothing("retired"),
            Scope::Nothing("grace"),
            Scope::Brokers(vec![]),
        ] {
            assert!(!should_beat(&s), "{s:?}");
        }
        assert!(should_beat(&Scope::Brokers(vec!["b1".into()])));
    }
}
