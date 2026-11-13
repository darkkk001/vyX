//! WHAT A LICENSE STATE DOES TO THE ENGINE'S TWO HALVES, and the handover that has to happen before
//! the risk half may stop (owner decision 2026-11-13).
//!
//! The bridge's license monitor publishes a state; the bridge gates hedging on it. The engine cannot
//! copy that, because the consequence is not the same. A stopped bridge stops hedging and its LP
//! positions are simply left alone -- no trader notices. A stopped engine stops EVALUATING RISK, so
//! every SL, TP and stop-out of every account it owns stops firing. That is not a kill switch, that is
//! an outage, and a commercial lever must never be able to cause one silently.
//!
//! The engine already has the two halves this needs, and they are already scoped separately -- the
//! ORDER half by account (`ingress`) and the RISK half by broker (`broker_scope`) -- so the states map
//! onto them:
//!
//! | license state | order half | risk half |
//! |---|---|---|
//! | ACTIVE, or within grace | on | on |
//! | SUSPENDED | **off** | **ON** -- SL/TP and stop-out keep firing, open positions can still close |
//! | STOPPED | off, at once | ON until the web has provably taken over, then off |
//!
//! SUSPENDED KEEPS RISK ON DELIBERATELY: a commercial suspension must not leave a client's open
//! position unprotected. Suspension stops new business, which is what it is for.
//!
//! ## The handover, and why it is ordered this way
//!
//! The ordering is the one hedge-intent durability uses: write the intent down, then act, then confirm,
//! and never let the irreversible step happen before the confirmation. Here:
//!
//!   1. RECORD THE INTENT, durably, before touching anything. A crash between the steps then leaves a
//!      readable trace instead of a mystery.
//!   2. RELEASE: make this engine's heartbeat not-alive. This is the whole release -- the web's takeover
//!      is already heartbeat-driven (`lib/risk-fallback.ts`: with a stale heartbeat every RUST account
//!      is WEB-owned), so there is nothing to flip on `Broker` and no new state anywhere. Setting
//!      `beatAt` into the past says "released" at once instead of waiting out `staleAfterSecs`.
//!   3. CONFIRM, positively: the web's `/api/internal/risk-fallback` answers `ran: true` only when it
//!      has actually run a full margin pass. Unreachable, 5xx, or `ran: false` is NOT a confirmation.
//!   4. ONLY THEN stop the risk half.
//!
//! IF THE CONFIRMATION NEVER COMES, THE RISK HALF STAYS ON. That is the point of the whole module: the
//! commercial lever has already taken effect (no new orders, from step 0), and refusing to abandon
//! open positions is the lesser evil against a silent risk outage. It is logged as an error and
//! reported in the heartbeat, and the handover keeps retrying.

use std::time::Duration;

/// What the two halves are doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Halves {
    pub orders: bool,
    pub risk: bool,
}

/// The license state, reduced to what the engine does about it. Mapped in the server from
/// `qb_license::monitor::State` so this module -- and its tests -- need no license client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Licensed {
    /// ACTIVE, or inside the grace window after an unreachable platform.
    Serving,
    /// SUSPENDED: reversible, commercial.
    OrdersHeld,
    /// STOPPED: revoked, expired, machine refused, or grace exhausted.
    Stopping,
    /// HOLDING: no good answer yet and no cached one, at start-up. Nothing has been taken, so there is
    /// nothing to hand over -- the engine simply does not begin.
    NotStarted,
}

/// Where the handover has got to. `Serving` and `Held` carry no handover; `HandingOver` is the only
/// state that can become `Released`, and only through a confirmation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    Serving,
    Held,
    /// Orders are already off. Risk is STILL ON. These are the steps done so far.
    HandingOver { intent_recorded: bool, released: bool, attempts: u32, last_error: Option<String> },
    /// The web confirmed it took over. Risk is off.
    Released,
    /// Start-up with no license answer: neither half ever started.
    NeverStarted,
}

impl Phase {
    /// The two halves implied by this phase. The ONLY phase with `risk: false` and a running engine is
    /// `Released`, which cannot be reached except through a confirmation.
    pub fn halves(&self) -> Halves {
        match self {
            Phase::Serving => Halves { orders: true, risk: true },
            Phase::Held => Halves { orders: false, risk: true },
            Phase::HandingOver { .. } => Halves { orders: false, risk: true },
            Phase::Released => Halves { orders: false, risk: false },
            Phase::NeverStarted => Halves { orders: false, risk: false },
        }
    }

    pub fn is_handing_over(&self) -> bool {
        matches!(self, Phase::HandingOver { .. })
    }

    /// MAY THE HEARTBEAT STILL BEAT? The release works by making the heartbeat not-alive, and the
    /// engine's own beat loop runs every few seconds -- so unless the loop stops, it would refresh the
    /// row a moment later and silently undo the release, leaving the engine holding authority it
    /// believes it has given away. That is the one way this design could fail quietly, so the answer
    /// lives here with the phase rather than in the loop.
    pub fn should_beat(&self) -> bool {
        match self {
            Phase::Serving | Phase::Held => true,
            // still beating until the release step actually ran: the web must not take over while this
            // engine is still the one acting
            Phase::HandingOver { released, .. } => !*released,
            Phase::Released | Phase::NeverStarted => false,
        }
    }
}

/// The three durable/remote steps, behind a trait so the ordering can be tested without a database or a
/// platform. Each returns `Err` with a reason that is logged and retried; none of them may be skipped.
pub trait Handover {
    /// Step 1: write the intent somewhere durable and readable (an AuditLog row). Idempotent.
    fn record_intent(&self) -> impl std::future::Future<Output = Result<(), String>> + Send;
    /// Step 2: give the authority up, in whatever way is right for THIS subject.
    ///
    /// Not always the heartbeat: the heartbeat is engine-wide, so putting it down releases every
    /// broker at once. A single broker is released by its own `riskAuthority`, which is the per-broker
    /// thing the web's owner rule reads (license_fleet has the reasoning).
    fn release_authority(&self) -> impl std::future::Future<Output = Result<(), String>> + Send;
    /// Step 3: ask the web to run its pass, and report whether it PROVABLY ran one (`ran: true`).
    /// Unreachable or `ran: false` is `Ok(false)`, not an error -- it simply is not a confirmation yet.
    fn confirm_web_took_over(&self) -> impl std::future::Future<Output = Result<bool, String>> + Send;
}

/// What one turn of the handover did, for the caller to log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Nothing,
    RecordedIntent,
    Released,
    Confirmed,
    /// Tried and did not get there; the risk half stays on.
    Waiting(String),
}

/// How long a handover may go unconfirmed before it is an error rather than a wait. The risk half stays
/// on either way -- this only changes how loudly it is reported.
pub const HANDOVER_ALARM_AFTER: Duration = Duration::from_secs(300);

/// Advance the phase for the license state we are now in, doing at most one remote step per call.
///
/// The license state is applied FIRST and unconditionally for the order half: a suspension or a stop
/// takes new orders off on the very first turn, before any handover work. Only the risk half waits.
pub async fn advance<H: Handover>(phase: Phase, state: Licensed, h: &H) -> (Phase, Step) {
    // HOLDING AFTER AUTHORITY WAS HELD IS A STOP IN EVERYTHING BUT NAME. Normalised here rather than
    // handled as a recursive call, so the one place that decides "does this need a handover?" is this
    // line and not a branch buried below.
    let state = match (state, &phase) {
        (Licensed::NotStarted, Phase::NeverStarted) => Licensed::NotStarted,
        (Licensed::NotStarted, _) => Licensed::Stopping,
        (s, _) => s,
    };
    match (state, phase) {
        // ---- back to serving. A stop is not sticky (the bridge's rule): the next ACTIVE answer
        // resumes both halves, even mid-handover. If the heartbeat was released, the engine's own beat
        // loop makes it fresh again, which is what hands authority back.
        (Licensed::Serving, _) => (Phase::Serving, Step::Nothing),

        // ---- suspended: orders off, risk on. Never any handover.
        (Licensed::OrdersHeld, _) => (Phase::Held, Step::Nothing),

        // ---- holding at start-up: nothing was ever taken. (Holding after serving was normalised to
        // Stopping above, so it reaches the handover arms below.)
        (Licensed::NotStarted, _) => (Phase::NeverStarted, Step::Nothing),

        // ---- stopped from a state that never held authority: nothing to hand over.
        (Licensed::Stopping, Phase::NeverStarted) => (Phase::NeverStarted, Step::Nothing),
        (Licensed::Stopping, Phase::Released) => (Phase::Released, Step::Nothing),

        // ---- stopped: begin the handover. Orders are off from this turn (Phase::HandingOver.halves()).
        (Licensed::Stopping, Phase::Serving | Phase::Held) => {
            let next = Phase::HandingOver { intent_recorded: false, released: false, attempts: 0, last_error: None };
            // deliberately no remote work on the turn that takes orders off: the order half must stop
            // immediately and must not wait behind a database write that might be slow.
            (next, Step::Nothing)
        }

        // ---- the handover itself, one step per turn, strictly in order.
        (Licensed::Stopping, Phase::HandingOver { intent_recorded, released, attempts, last_error }) => {
            if !intent_recorded {
                return match h.record_intent().await {
                    Ok(()) => (
                        Phase::HandingOver { intent_recorded: true, released, attempts: attempts + 1, last_error: None },
                        Step::RecordedIntent,
                    ),
                    Err(e) => (
                        Phase::HandingOver { intent_recorded: false, released, attempts: attempts + 1, last_error: Some(e.clone()) },
                        Step::Waiting(format!("could not record the stop intent: {e}")),
                    ),
                };
            }
            if !released {
                return match h.release_authority().await {
                    Ok(()) => (
                        Phase::HandingOver { intent_recorded, released: true, attempts: attempts + 1, last_error: None },
                        Step::Released,
                    ),
                    Err(e) => (
                        Phase::HandingOver { intent_recorded, released: false, attempts: attempts + 1, last_error: Some(e.clone()) },
                        Step::Waiting(format!("could not release the heartbeat: {e}")),
                    ),
                };
            }
            match h.confirm_web_took_over().await {
                Ok(true) => (Phase::Released, Step::Confirmed),
                Ok(false) => (
                    Phase::HandingOver { intent_recorded, released, attempts: attempts + 1, last_error },
                    Step::Waiting("the web has not run a pass as owner yet; the risk half stays on".into()),
                ),
                Err(e) => (
                    Phase::HandingOver { intent_recorded, released, attempts: attempts + 1, last_error: Some(e.clone()) },
                    Step::Waiting(format!("could not ask the web to take over: {e}")),
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        intent_ok: bool,
        release_ok: bool,
        confirm: Option<bool>, // None = error
        calls: Mutex<Vec<&'static str>>,
    }
    impl Fake {
        fn working() -> Self {
            Fake { intent_ok: true, release_ok: true, confirm: Some(true), calls: Mutex::new(vec![]) }
        }
        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }
    impl Handover for Fake {
        async fn record_intent(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("intent");
            if self.intent_ok { Ok(()) } else { Err("db down".into()) }
        }
        async fn release_authority(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("release");
            if self.release_ok { Ok(()) } else { Err("db down".into()) }
        }
        async fn confirm_web_took_over(&self) -> Result<bool, String> {
            self.calls.lock().unwrap().push("confirm");
            match self.confirm {
                Some(v) => Ok(v),
                None => Err("web unreachable".into()),
            }
        }
    }

    /// Drive to a fixed point, or give up -- a state machine that never settles is itself a bug.
    async fn settle<H: Handover>(mut phase: Phase, state: Licensed, h: &H) -> Phase {
        for _ in 0..12 {
            let (next, _) = advance(phase.clone(), state, h).await;
            if next == phase {
                return phase;
            }
            phase = next;
        }
        phase
    }

    #[tokio::test]
    async fn active_runs_both_halves() {
        let h = Fake::working();
        let (p, _) = advance(Phase::Serving, Licensed::Serving, &h).await;
        assert_eq!(p.halves(), Halves { orders: true, risk: true });
        assert!(h.calls().is_empty(), "serving must do no handover work");
    }

    #[tokio::test]
    async fn suspended_stops_orders_and_keeps_risk_on() {
        let h = Fake::working();
        let (p, _) = advance(Phase::Serving, Licensed::OrdersHeld, &h).await;
        assert_eq!(p.halves(), Halves { orders: false, risk: true }, "a commercial suspension must not leave positions unprotected");
        assert!(h.calls().is_empty(), "a suspension hands nothing over");
        // and it stays that way however long it lasts
        assert_eq!(settle(p, Licensed::OrdersHeld, &h).await.halves(), Halves { orders: false, risk: true });
    }

    #[tokio::test]
    async fn stopped_takes_orders_off_on_the_very_first_turn_without_waiting_for_anything() {
        let h = Fake::working();
        let (p, step) = advance(Phase::Serving, Licensed::Stopping, &h).await;
        assert_eq!(p.halves().orders, false, "the commercial lever must act at once");
        assert_eq!(p.halves().risk, true, "risk may not go off in the same breath");
        assert_eq!(step, Step::Nothing);
        assert!(h.calls().is_empty(), "the turn that stops orders must not wait on a database write");
    }

    #[tokio::test]
    async fn the_handover_runs_intent_then_release_then_confirm_in_that_order() {
        let h = Fake::working();
        let p = settle(Phase::Serving, Licensed::Stopping, &h).await;
        assert_eq!(p, Phase::Released);
        assert_eq!(h.calls(), vec!["intent", "release", "confirm"], "the order IS the safety property");
        assert_eq!(p.halves(), Halves { orders: false, risk: false });
    }

    #[tokio::test]
    async fn risk_stays_on_while_the_intent_cannot_be_recorded() {
        let h = Fake { intent_ok: false, release_ok: true, confirm: Some(true), ..Default::default() };
        let p = settle(Phase::Serving, Licensed::Stopping, &h).await;
        assert_eq!(p.halves(), Halves { orders: false, risk: true });
        assert!(!h.calls().contains(&"release"), "nothing may be released before the intent is durable");
        assert!(!h.calls().contains(&"confirm"));
    }

    #[tokio::test]
    async fn risk_stays_on_while_the_release_fails() {
        let h = Fake { intent_ok: true, release_ok: false, confirm: Some(true), ..Default::default() };
        let p = settle(Phase::Serving, Licensed::Stopping, &h).await;
        assert_eq!(p.halves(), Halves { orders: false, risk: true });
        assert!(!h.calls().contains(&"confirm"), "there is nothing to confirm until the release happened");
    }

    #[tokio::test]
    async fn risk_stays_on_for_ever_when_the_web_never_confirms() {
        // THE CENTRAL ASSERTION. An unreachable or unwilling web must not produce a silent risk outage.
        for confirm in [Some(false), None] {
            let h = Fake { intent_ok: true, release_ok: true, confirm, calls: Mutex::new(vec![]) };
            let p = settle(Phase::Serving, Licensed::Stopping, &h).await;
            assert_eq!(p.halves(), Halves { orders: false, risk: true }, "confirm={confirm:?}");
            assert!(p.is_handing_over(), "it must keep trying, not settle into stopped");
            assert!(h.calls().contains(&"confirm"));
        }
    }

    #[tokio::test]
    async fn only_a_positive_confirmation_turns_risk_off() {
        // ran:false then ran:true -- risk goes off exactly when the web says it ran, not before
        let h = Fake { intent_ok: true, release_ok: true, confirm: Some(false), calls: Mutex::new(vec![]) };
        let waiting = settle(Phase::Serving, Licensed::Stopping, &h).await;
        assert_eq!(waiting.halves().risk, true);
        let h2 = Fake::working();
        let (done, step) = advance(waiting, Licensed::Stopping, &h2).await;
        assert_eq!(step, Step::Confirmed);
        assert_eq!(done.halves(), Halves { orders: false, risk: false });
    }

    #[tokio::test]
    async fn a_stop_is_not_sticky_and_resuming_mid_handover_restores_both_halves() {
        let h = Fake { intent_ok: true, release_ok: true, confirm: Some(false), calls: Mutex::new(vec![]) };
        let mid = settle(Phase::Serving, Licensed::Stopping, &h).await;
        assert!(mid.is_handing_over());
        let (back, _) = advance(mid, Licensed::Serving, &h).await;
        assert_eq!(back, Phase::Serving);
        assert_eq!(back.halves(), Halves { orders: true, risk: true }, "the next ACTIVE answer resumes everything");
    }

    #[tokio::test]
    async fn holding_at_startup_never_starts_either_half_and_hands_nothing_over() {
        let h = Fake::working();
        let p = settle(Phase::NeverStarted, Licensed::NotStarted, &h).await;
        assert_eq!(p, Phase::NeverStarted);
        assert_eq!(p.halves(), Halves { orders: false, risk: false });
        assert!(h.calls().is_empty(), "an engine that never took authority has nothing to release");
    }

    #[tokio::test]
    async fn holding_after_serving_is_handled_as_a_stop_because_authority_is_already_held() {
        let h = Fake::working();
        // it was serving, so it holds authority; a holding state must hand over like a stop
        let p = settle(Phase::Serving, Licensed::NotStarted, &h).await;
        assert_eq!(p, Phase::Released);
        assert_eq!(h.calls(), vec!["intent", "release", "confirm"]);
    }

    #[tokio::test]
    async fn released_is_terminal_while_the_stop_lasts_and_does_no_further_work() {
        let h = Fake::working();
        let (p, step) = advance(Phase::Released, Licensed::Stopping, &h).await;
        assert_eq!(p, Phase::Released);
        assert_eq!(step, Step::Nothing);
        assert!(h.calls().is_empty());
    }

    #[tokio::test]
    async fn the_beat_stops_exactly_when_the_release_happens_and_not_before() {
        // Suspended keeps beating: it is still the owner and still acting.
        assert!(Phase::Held.should_beat());
        assert!(Phase::Serving.should_beat());
        // During the handover it keeps beating until the release step has actually run -- otherwise the
        // web would take over while this engine is still acting, and both would act at once.
        assert!(Phase::HandingOver { intent_recorded: true, released: false, attempts: 1, last_error: None }.should_beat());
        assert!(!Phase::HandingOver { intent_recorded: true, released: true, attempts: 2, last_error: None }.should_beat());
        assert!(!Phase::Released.should_beat());
        assert!(!Phase::NeverStarted.should_beat());

        // and the sequence as the handover really runs it
        let h = Fake::working();
        let (p1, _) = advance(Phase::Serving, Licensed::Stopping, &h).await; // orders off
        assert!(p1.should_beat(), "nothing released yet");
        let (p2, _) = advance(p1, Licensed::Stopping, &h).await; // intent
        assert!(p2.should_beat());
        let (p3, step) = advance(p2, Licensed::Stopping, &h).await; // release
        assert_eq!(step, Step::Released);
        assert!(!p3.should_beat(), "the beat must stop in the same turn as the release, or it undoes it");
    }

    #[tokio::test]
    async fn resuming_mid_handover_starts_beating_again() {
        // The beat is what hands authority BACK, so a resume must restore it.
        let h = Fake { intent_ok: true, release_ok: true, confirm: Some(false), calls: Mutex::new(vec![]) };
        let mid = settle(Phase::Serving, Licensed::Stopping, &h).await;
        assert!(!mid.should_beat());
        let (back, _) = advance(mid, Licensed::Serving, &h).await;
        assert!(back.should_beat(), "an ACTIVE answer must put this engine back in charge");
    }

    #[test]
    fn risk_is_off_in_exactly_two_phases_and_both_are_deliberate() {
        // A guard against someone later adding a phase that turns risk off by accident.
        let off: Vec<Phase> = [
            Phase::Serving,
            Phase::Held,
            Phase::HandingOver { intent_recorded: true, released: true, attempts: 9, last_error: None },
            Phase::Released,
            Phase::NeverStarted,
        ]
        .into_iter()
        .filter(|p| !p.halves().risk)
        .collect();
        assert_eq!(off, vec![Phase::Released, Phase::NeverStarted], "risk may only be off after a confirmed handover, or before it ever started");
    }
}
