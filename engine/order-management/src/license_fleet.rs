//! TWO-TIER LICENSING (owner 2026-11-13): one gate for the engine, one for each broker it serves.
//!
//! - The ENGINE's own license (`app = engine`) is the outer gate. Invalid, and the engine is down --
//!   every broker, no exceptions.
//! - Each CONNECTED BROKER has its own license, and it is the existing one-license-one-broker model,
//!   unchanged. That is why `verifyBridgeGet` is NOT generalised: a broker license is verified exactly
//!   as a bridge license is, by the same per-broker path. Nothing about that model moves.
//!
//! The states and the handover are the ones `license_gate` already defines; this module does not invent
//! a second set. It applies them at two levels and combines them:
//!
//! | engine license | broker license | that broker's orders | that broker's risk |
//! |---|---|---|---|
//! | ACTIVE | ACTIVE | on | on |
//! | ACTIVE | SUSPENDED | off | ON -- only this broker |
//! | ACTIVE | STOPPED | off | handed to the web -- only this broker; the rest keep running |
//! | SUSPENDED | anything | off | on |
//! | STOPPED | anything | off | handed over, every broker |
//!
//! THE OUTER GATE CANNOT BE LOOSENED BY AN INNER ONE. The effective state of a broker is the more
//! restrictive of the two, never the broker's alone -- otherwise a broker with a healthy license would
//! keep trading under an engine whose own license was revoked.
//!
//! ## Why a per-broker handover cannot use the heartbeat
//!
//! The engine's heartbeat is ENGINE-WIDE: the web resolves ownership through `Broker.engineId ->
//! Engine.lastBeatAt`. So while the engine is still serving its other brokers it keeps beating, and a
//! stopped broker's accounts would still look to the web like this engine's business. Stopping the beat
//! is only the right release when the ENGINE stops.
//!
//! The per-broker release therefore acts on the per-broker thing the web's owner rule already reads:
//! `Broker.riskAuthority`. Setting that one broker to WEB is precisely "hand this broker's risk to the
//! web", it leaves the engine assignment (which an admin set, and which is a different question) alone,
//! and it needs no new state anywhere. The write is done SERVER-SIDE by the handover route, like every
//! other control-plane write -- the engine asks, it does not reach into the control database.
//!
//! Both releases keep the same ordering `license_gate` enforces: intent, release, positive
//! confirmation, and only then does anything stop evaluating risk.

use crate::license_gate::{advance, Halves, Handover, Licensed, Phase, Step};
use std::collections::BTreeMap;

/// Which licence a handover is acting for -- the whole engine, or one broker.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Subject {
    Engine,
    Broker(String),
}

/// How restrictive a state is. The combination rule is "the more restrictive wins", and this is the
/// order: serving < orders held < stopping < never started.
pub fn severity(l: Licensed) -> u8 {
    match l {
        Licensed::Serving => 0,
        Licensed::OrdersHeld => 1,
        Licensed::Stopping => 2,
        Licensed::NotStarted => 3,
    }
}

/// The state a broker is actually under: the more restrictive of the engine's and its own.
pub fn effective(engine: Licensed, broker: Licensed) -> Licensed {
    if severity(engine) >= severity(broker) { engine } else { broker }
}

/// Every licence this engine is gated by, and where each one's handover has got to.
#[derive(Debug, Default)]
pub struct Fleet {
    engine: Option<Phase>,
    brokers: BTreeMap<String, Phase>,
}

/// What one turn did, per subject, for the caller to log.
pub type Turn = Vec<(Subject, Step)>;

impl Fleet {
    pub fn new() -> Self {
        Self::default()
    }

    /// The phase of one broker; `Phase::NeverStarted` for a broker this engine has not been told about.
    pub fn broker_phase(&self, broker: &str) -> Phase {
        self.brokers.get(broker).cloned().unwrap_or(Phase::NeverStarted)
    }

    /// The phase a broker ENTERS the fleet with.
    ///
    /// `Serving`, not `NeverStarted`, and the difference is a real one: the single-subject gate treats
    /// `NeverStarted` as "never held authority, so there is nothing to hand over", which is right for a
    /// process that never started and wrong for a broker this engine is serving right now. A broker
    /// that appears in the control plane's list IS held -- it may have been held across a restart --
    /// so a stop on it must hand over rather than drop it silently. Entering as `Serving` is also the
    /// safe direction to be wrong in: the worst case is a handover nobody needed.
    fn entering(&self, broker: &str, known: bool) -> Phase {
        match self.brokers.get(broker) {
            Some(p) => p.clone(),
            None if known => Phase::Serving,
            None => Phase::NeverStarted,
        }
    }

    pub fn engine_phase(&self) -> Phase {
        self.engine.clone().unwrap_or(Phase::NeverStarted)
    }

    /// What this broker may do now.
    pub fn halves(&self, broker: &str) -> Halves {
        let engine = self.engine_phase().halves();
        let own = self.broker_phase(broker).halves();
        // the outer gate again, now on the result: either side saying no is a no
        Halves { orders: engine.orders && own.orders, risk: engine.risk && own.risk }
    }

    /// THE BROKERS WHOSE RISK THIS ENGINE STILL EVALUATES -- what `broker_scope` is installed with.
    ///
    /// A broker drops out of this the moment its handover is confirmed, and not before, which is the
    /// whole safety property: the engine goes on evaluating a broker it is losing until the web has
    /// provably taken it.
    pub fn risk_brokers(&self) -> Vec<String> {
        self.brokers.keys().filter(|b| self.halves(b).risk).cloned().collect()
    }

    /// May the engine still beat? Only while it evaluates something: an engine that has handed
    /// everything over must stop, so the web sees it stand down.
    pub fn should_beat(&self) -> bool {
        !self.risk_brokers().is_empty()
    }

    /// Is every subject's handover finished, so the process may exit?
    pub fn fully_released(&self) -> bool {
        self.risk_brokers().is_empty() && !matches!(self.engine_phase(), Phase::Serving | Phase::Held)
    }

    /// One turn for every licence: the engine first, then each broker under the combined state.
    ///
    /// `make` yields the handover for a subject -- one per subject, because a broker's release writes
    /// that broker's authority while the engine's release puts the whole heartbeat down.
    pub async fn advance_all<F, H>(&mut self, engine_state: Licensed, broker_states: &BTreeMap<String, Licensed>, make: F) -> Turn
    where
        F: Fn(&Subject) -> H,
        H: Handover,
    {
        let mut turn = Turn::new();

        // the outer gate moves first: a broker's turn below is taken under the state this produces.
        //
        // The engine enters as Serving for the same reason a broker does: the single-subject gate reads
        // NeverStarted as "never held authority, nothing to hand over", which is right for a process
        // that never started and wrong for one that is serving brokers right now. Being handed a list
        // of brokers to serve IS the evidence that it started.
        let before = match (&self.engine, broker_states.is_empty()) {
            (Some(p), _) => p.clone(),
            (None, false) => Phase::Serving,
            (None, true) => Phase::NeverStarted,
        };
        let (next, step) = advance(before, engine_state, &make(&Subject::Engine)).await;
        if step != Step::Nothing {
            turn.push((Subject::Engine, step));
        }
        self.engine = Some(next);

        // brokers this engine has been told about, plus any it is still handing over (a broker that
        // disappears from the list mid-handover must not be forgotten half-way)
        let mut ids: Vec<String> = broker_states.keys().cloned().collect();
        for id in self.brokers.keys() {
            if !broker_states.contains_key(id) && self.brokers[id].is_handing_over() {
                ids.push(id.clone());
            }
        }
        ids.sort();
        ids.dedup();

        for id in ids {
            let known = broker_states.contains_key(&id);
            let own = broker_states.get(&id).copied().unwrap_or(Licensed::Stopping);
            let state = effective(engine_state, own);
            let phase = self.entering(&id, known);
            let (next, step) = advance(phase, state, &make(&Subject::Broker(id.clone()))).await;
            if step != Step::Nothing {
                turn.push((Subject::Broker(id.clone()), step));
            }
            self.brokers.insert(id, next);
        }
        turn
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Calls(Mutex<Vec<String>>);
    struct Fake<'a> {
        subject: Subject,
        calls: &'a Calls,
        confirm: bool,
    }
    impl Handover for Fake<'_> {
        async fn record_intent(&self) -> Result<(), String> {
            self.note("intent");
            Ok(())
        }
        async fn release_authority(&self) -> Result<(), String> {
            self.note("release");
            Ok(())
        }
        async fn confirm_web_took_over(&self) -> Result<bool, String> {
            self.note("confirm");
            Ok(self.confirm)
        }
    }
    impl Fake<'_> {
        fn note(&self, what: &str) {
            let who = match &self.subject {
                Subject::Engine => "engine".to_string(),
                Subject::Broker(b) => b.clone(),
            };
            self.calls.0.lock().unwrap().push(format!("{who}:{what}"));
        }
    }

    fn states(pairs: &[(&str, Licensed)]) -> BTreeMap<String, Licensed> {
        pairs.iter().map(|(b, s)| (b.to_string(), *s)).collect()
    }

    async fn settle(fleet: &mut Fleet, engine: Licensed, brokers: &BTreeMap<String, Licensed>, calls: &Calls, confirm: bool) {
        for _ in 0..16 {
            let before = format!("{:?}", fleet);
            fleet.advance_all(engine, brokers, |s| Fake { subject: s.clone(), calls, confirm }).await;
            if format!("{:?}", fleet) == before {
                return;
            }
        }
    }

    #[tokio::test]
    async fn a_suspended_broker_stops_only_its_own_orders() {
        let calls = Calls::default();
        let mut f = Fleet::new();
        let st = states(&[("b1", Licensed::OrdersHeld), ("b2", Licensed::Serving)]);
        settle(&mut f, Licensed::Serving, &st, &calls, true).await;
        assert_eq!(f.halves("b1"), Halves { orders: false, risk: true }, "suspended: no new orders, positions still protected");
        assert_eq!(f.halves("b2"), Halves { orders: true, risk: true }, "the other broker is untouched");
        assert_eq!(f.risk_brokers(), vec!["b1".to_string(), "b2".to_string()]);
        assert!(calls.0.lock().unwrap().is_empty(), "a suspension hands nothing over");
    }

    #[tokio::test]
    async fn a_stopped_broker_hands_over_alone_and_the_others_keep_running() {
        let calls = Calls::default();
        let mut f = Fleet::new();
        let st = states(&[("b1", Licensed::Stopping), ("b2", Licensed::Serving)]);
        settle(&mut f, Licensed::Serving, &st, &calls, true).await;
        assert_eq!(f.halves("b1"), Halves { orders: false, risk: false }, "handed over");
        assert_eq!(f.halves("b2"), Halves { orders: true, risk: true }, "unaffected");
        assert_eq!(f.risk_brokers(), vec!["b2".to_string()], "broker_scope shrinks to the brokers still evaluated");
        assert!(f.should_beat(), "the engine is still serving b2, so it must keep beating");
        let c = calls.0.lock().unwrap().clone();
        assert_eq!(c, vec!["b1:intent", "b1:release", "b1:confirm"], "only b1's licence hands anything over");
    }

    #[tokio::test]
    async fn a_stopped_broker_is_still_evaluated_until_its_own_handover_is_confirmed() {
        // the central safety property, now per broker
        let calls = Calls::default();
        let mut f = Fleet::new();
        let st = states(&[("b1", Licensed::Stopping), ("b2", Licensed::Serving)]);
        settle(&mut f, Licensed::Serving, &st, &calls, false).await; // the web never confirms
        assert_eq!(f.halves("b1"), Halves { orders: false, risk: true }, "orders off at once, risk stays on");
        assert!(f.risk_brokers().contains(&"b1".to_string()), "b1 is still evaluated");
        assert!(f.broker_phase("b1").is_handing_over(), "and it keeps trying");
    }

    #[tokio::test]
    async fn a_suspended_engine_holds_every_brokers_orders_and_keeps_every_brokers_risk() {
        let calls = Calls::default();
        let mut f = Fleet::new();
        let st = states(&[("b1", Licensed::Serving), ("b2", Licensed::Serving)]);
        settle(&mut f, Licensed::OrdersHeld, &st, &calls, true).await;
        for b in ["b1", "b2"] {
            assert_eq!(f.halves(b), Halves { orders: false, risk: true }, "{b}");
        }
        assert!(calls.0.lock().unwrap().is_empty());
        assert!(f.should_beat());
    }

    #[tokio::test]
    async fn a_stopped_engine_hands_over_every_broker_and_then_stops_beating() {
        let calls = Calls::default();
        let mut f = Fleet::new();
        let st = states(&[("b1", Licensed::Serving), ("b2", Licensed::Serving)]);
        settle(&mut f, Licensed::Stopping, &st, &calls, true).await;
        assert!(f.risk_brokers().is_empty(), "nothing is evaluated any more");
        assert!(!f.should_beat(), "and the engine stands down so the web sees it");
        assert!(f.fully_released());
        let c = calls.0.lock().unwrap().clone();
        assert!(c.contains(&"engine:release".to_string()), "the engine's own release puts the heartbeat down");
        assert!(c.contains(&"b1:confirm".to_string()) && c.contains(&"b2:confirm".to_string()));
    }

    #[tokio::test]
    async fn a_healthy_broker_licence_cannot_outlive_a_revoked_engine_licence() {
        // the outer gate: the combination is the more restrictive, never the broker's own
        assert_eq!(effective(Licensed::Stopping, Licensed::Serving), Licensed::Stopping);
        assert_eq!(effective(Licensed::OrdersHeld, Licensed::Serving), Licensed::OrdersHeld);
        assert_eq!(effective(Licensed::Serving, Licensed::Stopping), Licensed::Stopping);
        assert_eq!(effective(Licensed::Serving, Licensed::Serving), Licensed::Serving);
        // and a broker suspension under a stopped engine is still a stop
        assert_eq!(effective(Licensed::Stopping, Licensed::OrdersHeld), Licensed::Stopping);
    }

    #[tokio::test]
    async fn the_engine_keeps_beating_while_any_broker_is_still_evaluated() {
        let calls = Calls::default();
        let mut f = Fleet::new();
        // b1 stops and is confirmed; b2 stops but is never confirmed
        let st = states(&[("b1", Licensed::Stopping), ("b2", Licensed::Stopping)]);
        settle(&mut f, Licensed::Serving, &st, &calls, false).await;
        assert!(f.should_beat(), "both are still evaluated, so the engine must not look stood down");
        assert_eq!(f.risk_brokers().len(), 2);
    }

    #[tokio::test]
    async fn a_broker_that_vanishes_mid_handover_is_not_forgotten() {
        // the control plane may stop listing a broker while its handover is in flight; dropping it
        // there would leave it evaluated by nobody and tracked by nobody
        let calls = Calls::default();
        let mut f = Fleet::new();
        let st = states(&[("b1", Licensed::Stopping)]);
        // one turn only: b1 is mid-handover
        f.advance_all(Licensed::Serving, &st, |s| Fake { subject: s.clone(), calls: &calls, confirm: false }).await;
        assert!(f.broker_phase("b1").is_handing_over());
        // now it disappears from the control plane's list entirely
        let empty = BTreeMap::new();
        settle(&mut f, Licensed::Serving, &empty, &calls, false).await;
        assert!(f.broker_phase("b1").is_handing_over(), "still tracked");
        assert!(f.halves("b1").risk, "and still evaluated, because nothing confirmed it was taken");
    }

    #[tokio::test]
    async fn a_broker_never_heard_of_is_served_nothing_rather_than_everything() {
        let f = Fleet::new();
        assert_eq!(f.halves("unknown"), Halves { orders: false, risk: false });
        assert!(f.risk_brokers().is_empty());
    }
}
