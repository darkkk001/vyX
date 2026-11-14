//! The engine's side of the hedge socket: loopback JSON-over-TCP to QoreBridge on the same VPS.
//!
//! SHAPE. The wire contract is a locked owner decision, so the message types below are a transcription of it
//! and nothing more. What is NOT transcription -- the sequencing, the resend rules, the dedupe -- lives in
//! `HedgeLink`, a pure state machine that takes an inbound message and returns the actions to take. It
//! touches no socket and no database, which is what makes the awkward cases (reconnect mid-flight, a result
//! for an intent we never sent, a duplicate accepted) testable without standing anything up.
//!
//! DURABILITY IS NOT THIS MODULE'S JOB. The intent is already durable before it is ever offered here: it is
//! written in the SAME transaction as the fill (see `hedge_outbox`). This module decides what to put on the
//! wire and what to do with what comes back; if the process dies mid-flight the row is still there and is
//! re-offered on the next connect. That ordering is deliberate -- an intent that existed only in this
//! module's queue would be an un-hedged position after a restart, with nothing to show it ever existed.
//!
//! WHAT A RECONNECT MEANS ON EACH SIDE:
//!   - the engine resends every INTENT it has not seen `accepted` for, deduped by `intent_id`;
//!   - the bridge resends every LEG it has not seen a `result_ack` for, deduped by `leg_id`;
//!   - so a resend is free in both directions.
//!
//! The two keys are different on purpose. An intent is offered once and accepted once, so the intent id is
//! the whole story there. A result is per leg -- one intent can split across several LPs -- so `accepted`
//! and `result_ack` cannot share a key: a per-intent ack could not say which of three outstanding legs it
//! answered. `result_ack` therefore carries `intent_id` AND `leg_id`, mirroring `result`.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Bumped only when the message set changes shape. The bridge answers `hello` with an error when it does not
/// speak this version, which is better than both sides guessing.
pub const PROTOCOL_VERSION: u32 = 1;

// ---------------------------------------------------------------------------------------------------------
// the wire contract
// ---------------------------------------------------------------------------------------------------------
//
// THE DISCRIMINATOR IS `op`, AND IT IS THE BRIDGE'S CHOICE, NOT OURS (bridge, 2026-11-14). This started as
// `type` on the engine side while the bridge had always used `op`, so neither side could parse the other and
// nothing connected at all. The failure was silent in the worst way: no error, no refusal, just intents
// resent for ever and never accepted -- safe (no double hedge, nothing mis-routed) but completely inert.
//
// The name is pinned by `the_discriminator_is_op_because_that_is_what_the_bridge_reads`. A rename here is a
// protocol break, not a refactor: change it only alongside the bridge, and bump PROTOCOL_VERSION.

/// Engine -> bridge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum EngineToBridge {
    Hello { v: u32, token: String, broker_id: String },
    Intent(IntentMsg),
    /// Acknowledges ONE leg's result, and mirrors `result` exactly: `intent_id` plus the `leg_id` that
    /// result carried, `null` included.
    ///
    /// WHY IT IS PER-LEG (owner 2026-11-14). It used to carry `intent_id` alone. An intent can split across
    /// several LPs and each leg gets its own `result`, so an ack keyed only on the intent could not say WHICH
    /// leg it answered: with three legs outstanding the bridge either treated one ack as covering all three
    /// and dropped two results it had never had confirmed, or kept resending legs that were already stored.
    /// Keyed by leg, "what the bridge still owes" is exact.
    ResultAck { intent_id: String, leg_id: Option<String> },
    Ping { ts: String },
}

/// Bridge -> engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BridgeToEngine {
    /// The reply to `hello`: `ok` true, or false with `error` saying why.
    Hello { ok: bool, #[serde(default)] error: Option<String> },
    Accepted { intent_id: String },
    Result(ResultMsg),
    Pong { #[serde(default)] ts: Option<String> },
}

/// One intent offered to the bridge. `intent_id` is the idempotency key on both sides.
///
/// `volume` is a decimal STRING in lots, never a float: a hedge leg that is off by a representation error is
/// a real position that does not match the client's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntentMsg {
    pub intent_id: String,
    pub deal_id: Option<String>,
    pub position_id: String,
    pub group_id: String,
    pub symbol: String,
    pub side: String,
    pub volume: String,
    pub reduce: bool,
    pub client_price: Option<String>,
    pub created_at: String,
}

/// One LEG's outcome. An intent can be split across several LPs, so there is one of these per leg and
/// `leg_id` is what distinguishes them.
///
/// `leg_id` is null for the un-hedgeable case: the bridge could not place the intent anywhere, so there is no
/// leg to name. That arrives as `ESCALATED` with a reason beginning "set aside: ".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResultMsg {
    pub intent_id: String,
    pub leg_id: Option<String>,
    pub status: ResultStatus,
    pub filled_qty: String,
    pub avg_px: Option<String>,
    pub lp_id: Option<String>,
    #[serde(default)]
    pub lp_order_ids: Vec<String>,
    pub reason: Option<String>,
    pub completed_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ResultStatus {
    Filled,
    Partial,
    Escalated,
}

impl ResultStatus {
    /// The leg is done and will not change again.
    pub fn is_terminal(self) -> bool {
        true
    }

    /// Nothing was placed anywhere: the intent is set aside and a human has to look.
    pub fn is_escalation(self) -> bool {
        matches!(self, ResultStatus::Escalated)
    }
}

/// The prefix the bridge puts on an un-hedgeable intent's reason.
pub const SET_ASIDE_PREFIX: &str = "set aside: ";

impl ResultMsg {
    /// True for the un-hedgeable shape: ESCALATED, no leg, a "set aside: ..." reason.
    pub fn is_set_aside(&self) -> bool {
        self.status.is_escalation()
            && self.leg_id.is_none()
            && self.reason.as_deref().is_some_and(|r| r.starts_with(SET_ASIDE_PREFIX))
    }
}

// ---------------------------------------------------------------------------------------------------------
// the state machine
// ---------------------------------------------------------------------------------------------------------

/// What the caller should do after feeding the link a message or an event.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Put this on the wire.
    Send(EngineToBridge),
    /// Mark the intent accepted by the bridge. It stays durable until its result lands, but it is no longer
    /// resent on reconnect.
    MarkAccepted(String),
    /// Persist this leg's outcome (one `"HedgeResult"` row, keyed by leg id).
    PersistResult(ResultMsg),
    /// The handshake failed. The caller drops the connection and backs off; it does NOT retry in a tight loop.
    HandshakeRefused(String),
    /// The handshake succeeded; the link is ready to carry intents.
    Ready,
    /// Something arrived that the contract does not allow. Logged, never acted on.
    Protocol(String),
}

/// Connection phase. Nothing but `hello` may be sent before the bridge has answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Nothing sent yet.
    New,
    /// `hello` is on the wire, waiting for the reply.
    Greeting,
    /// Handshake done; intents may flow.
    Ready,
    /// Refused or dropped. The caller reconnects.
    Down,
}

/// The engine's half of one hedge link.
#[derive(Debug)]
pub struct HedgeLink {
    phase: Phase,
    token: String,
    broker_id: String,
    /// Offered, not yet `accepted`. These are what a reconnect resends.
    unaccepted: Vec<IntentMsg>,
    /// Legs already persisted, so a bridge resend is dropped instead of written twice.
    seen_legs: HashSet<String>,
    /// Set-aside results have no leg id, so they dedupe on the intent id instead.
    seen_set_aside: HashSet<String>,
}

impl HedgeLink {
    pub fn new(token: impl Into<String>, broker_id: impl Into<String>) -> Self {
        Self {
            phase: Phase::New,
            token: token.into(),
            broker_id: broker_id.into(),
            unaccepted: Vec::new(),
            seen_legs: HashSet::new(),
            seen_set_aside: HashSet::new(),
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn unaccepted_count(&self) -> usize {
        self.unaccepted.len()
    }

    /// Open (or reopen) the link: greet, and once the bridge says ok, everything still unaccepted goes back on
    /// the wire. The resend is the whole point of keeping `unaccepted` across a reconnect.
    pub fn connect(&mut self) -> Vec<Action> {
        self.phase = Phase::Greeting;
        vec![Action::Send(EngineToBridge::Hello {
            v: PROTOCOL_VERSION,
            token: self.token.clone(),
            broker_id: self.broker_id.clone(),
        })]
    }

    /// The socket dropped. Accepted intents stay accepted; unaccepted ones stay queued for the next connect.
    pub fn disconnected(&mut self) {
        self.phase = Phase::Down;
    }

    /// Offer an intent. Before the handshake it is queued rather than refused: the fill has already happened
    /// and the row is already durable, so there is nothing to gain by dropping it here.
    pub fn offer(&mut self, intent: IntentMsg) -> Vec<Action> {
        if self.unaccepted.iter().any(|i| i.intent_id == intent.intent_id) {
            // the same intent twice is the idempotency key doing its job, not an error
            return Vec::new();
        }
        self.unaccepted.push(intent.clone());
        if self.phase == Phase::Ready {
            vec![Action::Send(EngineToBridge::Intent(intent))]
        } else {
            Vec::new()
        }
    }

    /// Feed one inbound message.
    pub fn on_message(&mut self, msg: BridgeToEngine) -> Vec<Action> {
        match msg {
            BridgeToEngine::Hello { ok, error } => self.on_hello(ok, error),
            BridgeToEngine::Accepted { intent_id } => self.on_accepted(intent_id),
            BridgeToEngine::Result(result) => self.on_result(result),
            BridgeToEngine::Pong { .. } => Vec::new(),
        }
    }

    fn on_hello(&mut self, ok: bool, error: Option<String>) -> Vec<Action> {
        if self.phase != Phase::Greeting {
            return vec![Action::Protocol("a hello reply arrived outside the handshake".into())];
        }
        if !ok {
            self.phase = Phase::Down;
            return vec![Action::HandshakeRefused(
                error.unwrap_or_else(|| "the bridge refused the handshake without saying why".into()),
            )];
        }
        self.phase = Phase::Ready;
        let mut actions = vec![Action::Ready];
        // everything still unaccepted goes back out, in the order it was offered
        for intent in &self.unaccepted {
            actions.push(Action::Send(EngineToBridge::Intent(intent.clone())));
        }
        actions
    }

    fn on_accepted(&mut self, intent_id: String) -> Vec<Action> {
        let before = self.unaccepted.len();
        self.unaccepted.retain(|i| i.intent_id != intent_id);
        if self.unaccepted.len() == before {
            // a duplicate accepted after a resend is expected and harmless; say so rather than acting
            return vec![Action::Protocol(format!(
                "accepted for {intent_id}, which is not waiting (a duplicate after a resend, or not ours)"
            ))];
        }
        vec![Action::MarkAccepted(intent_id)]
    }

    fn on_result(&mut self, result: ResultMsg) -> Vec<Action> {
        // DEDUPE. The bridge resends results it has not seen an ack for, so the same leg can arrive more than
        // once. A leg is identified by its leg id; a set-aside has none, so it dedupes on the intent id.
        let fresh = match &result.leg_id {
            Some(leg) => self.seen_legs.insert(leg.clone()),
            None => self.seen_set_aside.insert(result.intent_id.clone()),
        };

        // The ack goes out either way: if we only acked fresh results, a lost ack would make the bridge resend
        // forever. It names the leg it answers, so acking a resend of leg 2 cannot be read as acking legs 1
        // and 3 as well.
        let ack = Action::Send(EngineToBridge::ResultAck {
            intent_id: result.intent_id.clone(),
            leg_id: result.leg_id.clone(),
        });

        if !fresh {
            return vec![ack];
        }

        // A result ends the intent's life on the wire whether or not we saw `accepted` for it -- the bridge
        // clearly has it.
        self.unaccepted.retain(|i| i.intent_id != result.intent_id);
        vec![Action::PersistResult(result), ack]
    }

    /// A keepalive.
    pub fn ping(&self, ts: impl Into<String>) -> Action {
        Action::Send(EngineToBridge::Ping { ts: ts.into() })
    }
}

// ---------------------------------------------------------------------------------------------------------
// codec: newline-delimited JSON
// ---------------------------------------------------------------------------------------------------------

/// Encode one message as a line. A message never contains a raw newline, because serde_json escapes them.
pub fn encode<T: Serialize>(msg: &T) -> Result<String, serde_json::Error> {
    Ok(format!("{}\n", serde_json::to_string(msg)?))
}

/// Decode one line.
pub fn decode_line(line: &str) -> Result<BridgeToEngine, serde_json::Error> {
    serde_json::from_str(line.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(id: &str) -> IntentMsg {
        IntentMsg {
            intent_id: id.to_string(),
            deal_id: Some(format!("{id}-deal")),
            position_id: format!("{id}-pos"),
            group_id: "grp".into(),
            symbol: "EURUSD".into(),
            side: "BUY".into(),
            volume: "0.01".into(),
            reduce: false,
            client_price: Some("1.10342".into()),
            created_at: "2026-11-14T00:00:00Z".into(),
        }
    }

    fn ready_link() -> HedgeLink {
        let mut link = HedgeLink::new("tok", "brk");
        link.connect();
        link.on_message(BridgeToEngine::Hello { ok: true, error: None });
        link
    }

    #[test]
    fn the_handshake_is_the_first_thing_on_the_wire() {
        let mut link = HedgeLink::new("tok", "brk");
        let actions = link.connect();
        assert_eq!(
            actions,
            vec![Action::Send(EngineToBridge::Hello { v: PROTOCOL_VERSION, token: "tok".into(), broker_id: "brk".into() })]
        );
        assert_eq!(link.phase(), Phase::Greeting);
    }

    #[test]
    fn a_refused_handshake_takes_the_link_down_and_says_why() {
        let mut link = HedgeLink::new("tok", "brk");
        link.connect();
        let actions = link.on_message(BridgeToEngine::Hello { ok: false, error: Some("unknown broker".into()) });
        assert_eq!(actions, vec![Action::HandshakeRefused("unknown broker".into())]);
        assert_eq!(link.phase(), Phase::Down, "the caller must back off, not spin");
    }

    #[test]
    fn a_refusal_without_a_reason_still_says_something_useful() {
        let mut link = HedgeLink::new("tok", "brk");
        link.connect();
        let actions = link.on_message(BridgeToEngine::Hello { ok: false, error: None });
        match &actions[0] {
            Action::HandshakeRefused(why) => assert!(!why.is_empty()),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// An intent offered before the handshake is NOT dropped: the fill already happened.
    #[test]
    fn an_intent_offered_early_waits_for_the_handshake_then_goes_out() {
        let mut link = HedgeLink::new("tok", "brk");
        link.connect();
        assert_eq!(link.offer(intent("H1")), Vec::new(), "nothing on the wire before the bridge said ok");
        assert_eq!(link.unaccepted_count(), 1, "but it is queued, not lost");

        let actions = link.on_message(BridgeToEngine::Hello { ok: true, error: None });
        assert_eq!(actions[0], Action::Ready);
        assert_eq!(actions[1], Action::Send(EngineToBridge::Intent(intent("H1"))));
    }

    #[test]
    fn accepted_stops_the_intent_being_resent() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        assert_eq!(link.unaccepted_count(), 1);
        let actions = link.on_message(BridgeToEngine::Accepted { intent_id: "H1".into() });
        assert_eq!(actions, vec![Action::MarkAccepted("H1".into())]);
        assert_eq!(link.unaccepted_count(), 0);
    }

    /// The reconnect rule, which is the reason `unaccepted` survives a drop at all.
    #[test]
    fn a_reconnect_resends_exactly_the_unaccepted_intents() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        link.offer(intent("H2"));
        link.offer(intent("H3"));
        link.on_message(BridgeToEngine::Accepted { intent_id: "H2".into() });

        link.disconnected();
        assert_eq!(link.phase(), Phase::Down);

        link.connect();
        let actions = link.on_message(BridgeToEngine::Hello { ok: true, error: None });
        let sent: Vec<_> = actions
            .iter()
            .filter_map(|a| match a {
                Action::Send(EngineToBridge::Intent(i)) => Some(i.intent_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(sent, vec!["H1", "H3"], "the accepted one must not be offered again");
    }

    #[test]
    fn offering_the_same_intent_twice_is_a_no_op() {
        let mut link = ready_link();
        assert_eq!(link.offer(intent("H1")).len(), 1);
        assert_eq!(link.offer(intent("H1")), Vec::new(), "the idempotency key doing its job");
        assert_eq!(link.unaccepted_count(), 1);
    }

    #[test]
    fn a_duplicate_accepted_is_noted_not_acted_on() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        link.on_message(BridgeToEngine::Accepted { intent_id: "H1".into() });
        let again = link.on_message(BridgeToEngine::Accepted { intent_id: "H1".into() });
        assert!(matches!(again.as_slice(), [Action::Protocol(_)]));
    }

    fn result(intent_id: &str, leg: Option<&str>, status: ResultStatus) -> ResultMsg {
        ResultMsg {
            intent_id: intent_id.into(),
            leg_id: leg.map(str::to_string),
            status,
            filled_qty: "0.01".into(),
            avg_px: Some("1.10344".into()),
            lp_id: Some("lp-1".into()),
            lp_order_ids: vec!["o-1".into()],
            reason: None,
            completed_at: "2026-11-14T00:00:01Z".into(),
        }
    }

    #[test]
    fn a_result_is_persisted_and_acked_by_leg() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        let actions = link.on_message(BridgeToEngine::Result(result("H1", Some("H1_0"), ResultStatus::Filled)));
        assert_eq!(actions[0], Action::PersistResult(result("H1", Some("H1_0"), ResultStatus::Filled)));
        assert_eq!(
            actions[1],
            Action::Send(EngineToBridge::ResultAck { intent_id: "H1".into(), leg_id: Some("H1_0".into()) })
        );
    }

    /// Each leg's ack names THAT leg. This is the property the per-leg ack exists for: with an intent-only
    /// ack these three messages were indistinguishable.
    #[test]
    fn each_leg_gets_its_own_ack_naming_that_leg() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        let mut acked = Vec::new();
        for leg in ["H1_0", "H1_1", "H1_2"] {
            for action in link.on_message(BridgeToEngine::Result(result("H1", Some(leg), ResultStatus::Partial))) {
                if let Action::Send(EngineToBridge::ResultAck { intent_id, leg_id }) = action {
                    assert_eq!(intent_id, "H1");
                    acked.push(leg_id.expect("a leg result is acked with its leg id"));
                }
            }
        }
        assert_eq!(acked, vec!["H1_0", "H1_1", "H1_2"], "one ack per leg, each naming its own leg");
    }

    /// The reconnect case the owner asked for: the bridge resends ONLY the leg whose per-leg ack never
    /// arrived, and the engine answers that leg -- without rewriting the legs it already stored.
    #[test]
    fn only_the_leg_whose_ack_was_lost_is_resent_and_it_is_acked_again_by_leg() {
        let mut link = ready_link();
        link.offer(intent("H1"));

        // three legs land; the engine acks all three, but suppose the ack for H1_1 is lost on the way back
        for leg in ["H1_0", "H1_1", "H1_2"] {
            link.on_message(BridgeToEngine::Result(result("H1", Some(leg), ResultStatus::Partial)));
        }

        link.disconnected();
        link.connect();
        let greeted = link.on_message(BridgeToEngine::Hello { ok: true, error: None });
        assert!(
            !greeted.iter().any(|a| matches!(a, Action::Send(EngineToBridge::Intent(_)))),
            "the intent is finished -- a reconnect must not offer it again"
        );

        // the bridge resends H1_1 alone, because that is the only leg it has no ack for
        let again = link.on_message(BridgeToEngine::Result(result("H1", Some("H1_1"), ResultStatus::Partial)));
        assert_eq!(
            again,
            vec![Action::Send(EngineToBridge::ResultAck { intent_id: "H1".into(), leg_id: Some("H1_1".into()) })],
            "acked again, by leg, and NOT persisted a second time"
        );
        assert!(!again.iter().any(|a| matches!(a, Action::PersistResult(_))));
    }

    /// A set-aside has no leg, so its ack carries none either -- the ack mirrors the result it answers.
    #[test]
    fn a_set_aside_is_acked_with_a_null_leg() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        let mut r = result("H1", None, ResultStatus::Escalated);
        r.reason = Some(format!("{SET_ASIDE_PREFIX}no route"));
        let actions = link.on_message(BridgeToEngine::Result(r));
        assert!(actions.contains(&Action::Send(EngineToBridge::ResultAck {
            intent_id: "H1".into(),
            leg_id: None
        })));
    }

    /// Two legs of the SAME intent must not ack each other away: storing leg 0 says nothing about leg 1.
    #[test]
    fn acking_one_leg_does_not_answer_another_leg_of_the_same_intent() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        link.on_message(BridgeToEngine::Result(result("H1", Some("H1_0"), ResultStatus::Filled)));

        // leg 1 has never been seen: it must still be persisted, not dropped as a duplicate of the intent
        let leg1 = link.on_message(BridgeToEngine::Result(result("H1", Some("H1_1"), ResultStatus::Filled)));
        assert!(
            leg1.iter().any(|a| matches!(a, Action::PersistResult(r) if r.leg_id.as_deref() == Some("H1_1"))),
            "leg 1 is a different leg and must be stored"
        );
        assert!(leg1.contains(&Action::Send(EngineToBridge::ResultAck {
            intent_id: "H1".into(),
            leg_id: Some("H1_1".into())
        })));
    }

    /// One intent, several LPs, one result per leg -- all of them stored.
    #[test]
    fn every_leg_of_a_split_intent_is_persisted_separately() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        let mut persisted = Vec::new();
        for leg in ["H1_0", "H1_1", "H1_2"] {
            for action in link.on_message(BridgeToEngine::Result(result("H1", Some(leg), ResultStatus::Partial))) {
                if let Action::PersistResult(r) = action {
                    persisted.push(r.leg_id.unwrap());
                }
            }
        }
        assert_eq!(persisted, vec!["H1_0", "H1_1", "H1_2"]);
    }

    /// A resent result must not be written twice, but must still be acked -- otherwise a lost ack makes the
    /// bridge resend for ever.
    #[test]
    fn a_resent_result_is_acked_again_but_stored_once() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        let first = link.on_message(BridgeToEngine::Result(result("H1", Some("H1_0"), ResultStatus::Filled)));
        assert_eq!(first.len(), 2, "persist + ack");

        let again = link.on_message(BridgeToEngine::Result(result("H1", Some("H1_0"), ResultStatus::Filled)));
        assert_eq!(
            again,
            vec![Action::Send(EngineToBridge::ResultAck { intent_id: "H1".into(), leg_id: Some("H1_0".into()) })]
        );
        assert!(!again.iter().any(|a| matches!(a, Action::PersistResult(_))), "stored once");
    }

    /// The un-hedgeable case: ESCALATED, no leg, "set aside: ...".
    #[test]
    fn an_un_hedgeable_intent_comes_back_set_aside_and_dedupes_on_the_intent_id() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        let mut r = result("H1", None, ResultStatus::Escalated);
        r.reason = Some(format!("{SET_ASIDE_PREFIX}no LP quotes EURUSD right now"));
        r.filled_qty = "0".into();
        r.avg_px = None;
        r.lp_id = None;
        r.lp_order_ids = Vec::new();
        assert!(r.is_set_aside());

        let first = link.on_message(BridgeToEngine::Result(r.clone()));
        assert!(matches!(first[0], Action::PersistResult(_)));

        // it has no leg id, so the dedupe key is the intent id
        let again = link.on_message(BridgeToEngine::Result(r));
        assert!(!again.iter().any(|a| matches!(a, Action::PersistResult(_))), "stored once");
    }

    #[test]
    fn a_result_ends_the_intent_even_if_accepted_was_lost() {
        let mut link = ready_link();
        link.offer(intent("H1"));
        assert_eq!(link.unaccepted_count(), 1);
        // no `accepted` ever arrived, but a result proves the bridge has it
        link.on_message(BridgeToEngine::Result(result("H1", Some("H1_0"), ResultStatus::Filled)));
        assert_eq!(link.unaccepted_count(), 0, "it must not be resent on the next reconnect");
    }

    #[test]
    fn a_hello_reply_outside_the_handshake_is_a_protocol_note() {
        let mut link = ready_link();
        let actions = link.on_message(BridgeToEngine::Hello { ok: true, error: None });
        assert!(matches!(actions.as_slice(), [Action::Protocol(_)]));
    }

    #[test]
    fn a_pong_is_accepted_and_does_nothing() {
        let mut link = ready_link();
        assert_eq!(link.on_message(BridgeToEngine::Pong { ts: Some("t".into()) }), Vec::new());
    }

    // ---- the wire format itself ----

    /// The discriminator key itself, pinned in BOTH directions.
    ///
    /// This is the test the `type` / `op` mismatch would have needed. It cannot see the bridge, so it cannot
    /// prove agreement -- what it does is make the name a deliberate decision: anyone who renames the tag
    /// has to change this line and read why. The key is asserted by looking it up, not by substring match,
    /// so a message that happens to contain the text "op" elsewhere cannot make it pass.
    #[test]
    fn the_discriminator_is_op_because_that_is_what_the_bridge_reads() {
        let engine_side = [
            encode(&EngineToBridge::Hello { v: PROTOCOL_VERSION, token: "t".into(), broker_id: "b".into() }).unwrap(),
            encode(&EngineToBridge::Intent(intent("H1"))).unwrap(),
            encode(&EngineToBridge::ResultAck { intent_id: "H1".into(), leg_id: Some("H1_0".into()) }).unwrap(),
            encode(&EngineToBridge::Ping { ts: "t".into() }).unwrap(),
        ];
        let expected = ["hello", "intent", "result_ack", "ping"];
        for (line, want) in engine_side.iter().zip(expected) {
            let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
            assert_eq!(v.get("op").and_then(|o| o.as_str()), Some(want), "wrong or missing `op` in {line}");
            assert!(v.get("type").is_none(), "`type` must not be emitted: the bridge reads `op` ({line})");
        }

        // and the inbound direction decodes from `op`, not `type`
        assert!(decode_line(r#"{"op":"hello","ok":true}"#).is_ok());
        assert!(
            decode_line(r#"{"type":"hello","ok":true}"#).is_err(),
            "a `type`-tagged line is not our contract; accepting it would hide the very mismatch this pins"
        );
    }

    #[test]
    fn every_message_round_trips_through_json() {
        let hello = EngineToBridge::Hello { v: PROTOCOL_VERSION, token: "t".into(), broker_id: "b".into() };
        let line = encode(&hello).unwrap();
        assert!(line.ends_with('\n'), "the framing is one message per line");
        assert!(line.contains(r#""op":"hello""#));

        let i = EngineToBridge::Intent(intent("H1"));
        assert!(encode(&i).unwrap().contains(r#""op":"intent""#));

        // the ack carries BOTH keys on the wire, mirroring `result`
        let ack = encode(&EngineToBridge::ResultAck { intent_id: "H1".into(), leg_id: Some("H1_0".into()) }).unwrap();
        assert!(ack.contains(r#""op":"result_ack""#));
        assert!(ack.contains(r#""intent_id":"H1""#));
        assert!(ack.contains(r#""leg_id":"H1_0""#));
        // and a set-aside ack says so explicitly rather than omitting the field
        let null_leg = encode(&EngineToBridge::ResultAck { intent_id: "H1".into(), leg_id: None }).unwrap();
        assert!(null_leg.contains(r#""leg_id":null"#), "an absent leg must be explicit, not missing");

        let ping = EngineToBridge::Ping { ts: "t".into() };
        assert!(encode(&ping).unwrap().contains(r#""op":"ping""#));
    }

    #[test]
    fn the_bridge_messages_decode_from_the_contract_shape() {
        let ok = decode_line(r#"{"op":"hello","ok":true}"#).unwrap();
        assert_eq!(ok, BridgeToEngine::Hello { ok: true, error: None });

        let refused = decode_line(r#"{"op":"hello","ok":false,"error":"bad token"}"#).unwrap();
        assert_eq!(refused, BridgeToEngine::Hello { ok: false, error: Some("bad token".into()) });

        let accepted = decode_line(r#"{"op":"accepted","intent_id":"H1"}"#).unwrap();
        assert_eq!(accepted, BridgeToEngine::Accepted { intent_id: "H1".into() });

        let r = decode_line(
            r#"{"op":"result","intent_id":"H1","leg_id":"H1_0","status":"FILLED","filled_qty":"0.01",
                "avg_px":"1.10344","lp_id":"lp-1","lp_order_ids":["o-1","o-2"],"reason":null,
                "completed_at":"2026-11-14T00:00:01Z"}"#,
        )
        .unwrap();
        match r {
            BridgeToEngine::Result(r) => {
                assert_eq!(r.status, ResultStatus::Filled);
                assert_eq!(r.leg_id.as_deref(), Some("H1_0"));
                assert_eq!(r.lp_order_ids, vec!["o-1", "o-2"]);
            }
            other => panic!("expected a result, got {other:?}"),
        }
    }

    #[test]
    fn a_set_aside_result_decodes_with_a_null_leg() {
        let r = decode_line(
            r#"{"op":"result","intent_id":"H1","leg_id":null,"status":"ESCALATED","filled_qty":"0",
                "avg_px":null,"lp_id":null,"reason":"set aside: no route","completed_at":"2026-11-14T00:00:01Z"}"#,
        )
        .unwrap();
        match r {
            BridgeToEngine::Result(r) => {
                assert!(r.is_set_aside());
                assert!(r.lp_order_ids.is_empty(), "absent lp_order_ids defaults to empty, not an error");
            }
            other => panic!("expected a result, got {other:?}"),
        }
    }

    #[test]
    fn volume_stays_a_decimal_string_on_the_wire() {
        let line = encode(&EngineToBridge::Intent(intent("H1"))).unwrap();
        assert!(line.contains(r#""volume":"0.01""#), "a float here would be a hedge that does not match");
        assert!(!line.contains(r#""volume":0.01"#));
    }
}
