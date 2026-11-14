//! The socket under [`crate::hedge_bridge::HedgeLink`]: loopback JSON-over-TCP to QoreBridge.
//!
//! WHO CONNECTS TO WHOM. The engine is the CONNECTOR, not the listener, and the contract decides that: the
//! engine sends `hello` carrying the token and the broker id, and the bridge answers ok or error. A listener
//! would have the greeting travelling the wrong way. The address is loopback -- both processes are on the
//! same VPS -- so there is no TLS here and no reason for any: nothing leaves the host.
//!
//! WHAT IS SPLIT FROM WHAT, AND WHY. Three layers, because the awkward parts are not the socket:
//!
//!   1. `HedgeLink` (hedge_bridge.rs) decides. Pure, no IO.
//!   2. [`run_session`] moves bytes for ONE connection, and is generic over its reader and writer, so the
//!      tests drive it through an in-memory duplex and assert on real wire bytes without a network.
//!   3. [`run`] supervises: connect, run a session, back off, reconnect, for ever.
//!
//! The database writes a session produces are not done inside it either -- they go out as [`StoreOp`] on a
//! channel and a separate task applies them. That keeps a slow Neon write from stalling the read loop (a
//! stalled read loop means unacked results, which means the bridge resending), and it is what lets the
//! session tests assert the DB side without a database.
//!
//! DORMANT. Nothing spawns [`run`]. [`SocketConfig::from_env`] returns `None` unless `VYX_HEDGE_SOCKET_ADDR`
//! is set, so even a wired-up caller stays off until an operator sets it.

use crate::hedge_bridge::{decode_line, encode, Action, HedgeLink, IntentMsg, ResultMsg};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// A database write a session asked for. Applied by someone else, off the read loop.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreOp {
    /// The bridge accepted this intent: stop re-offering it.
    MarkAccepted(String),
    /// One leg's outcome.
    PersistResult(ResultMsg),
}

/// Why a session ended. Every one of these is the supervisor's cue to reconnect; only the shapes differ, and
/// they differ in how long it should wait first.
#[derive(Debug)]
pub enum SessionEnd {
    /// The bridge closed the connection, or the host did.
    Closed,
    /// The bridge refused the handshake. Reconnecting fast will not help -- a bad token stays bad.
    Refused(String),
    /// A read or write failed.
    Io(std::io::Error),
    /// Nothing to offer and nowhere to put it: the offer channel is gone, so the engine is shutting down.
    OfferChannelClosed,
}

impl SessionEnd {
    /// A refusal is a configuration problem, so it waits the long backoff instead of hammering.
    pub fn is_refusal(&self) -> bool {
        matches!(self, SessionEnd::Refused(_))
    }
}

#[derive(Debug, Clone)]
pub struct SocketConfig {
    /// `127.0.0.1:<port>`. Loopback by contract.
    pub addr: String,
    pub token: String,
    pub broker_id: String,
    /// How often to send `ping` when the wire is quiet.
    pub ping_interval: Duration,
    /// First reconnect wait; doubles up to `backoff_max`.
    pub backoff_min: Duration,
    pub backoff_max: Duration,
}

impl SocketConfig {
    /// `VYX_HEDGE_SOCKET_ADDR` (required -- its absence is what keeps this dormant), `VYX_HEDGE_SOCKET_TOKEN`,
    /// `VYX_HEDGE_BROKER_ID`, `VYX_HEDGE_PING_SECS` (default 20).
    pub fn from_env() -> Option<Self> {
        let addr = std::env::var("VYX_HEDGE_SOCKET_ADDR").ok().filter(|v| !v.trim().is_empty())?;
        let token = std::env::var("VYX_HEDGE_SOCKET_TOKEN").unwrap_or_default();
        let broker_id = std::env::var("VYX_HEDGE_BROKER_ID").unwrap_or_default();
        let ping: u64 = std::env::var("VYX_HEDGE_PING_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
        Some(Self {
            addr: addr.trim().to_string(),
            token,
            broker_id,
            ping_interval: Duration::from_secs(ping.max(1)),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
        })
    }

    /// Loopback only. A hedge socket pointed at another host would be sending intents off the box in clear,
    /// so this is refused rather than merely discouraged.
    pub fn is_loopback(&self) -> bool {
        let host = self.addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(&self.addr);
        let host = host.trim_start_matches('[').trim_end_matches(']');
        host == "127.0.0.1" || host == "localhost" || host == "::1"
    }
}

/// Run ONE connection until it ends.
///
/// Generic over the reader and writer so the tests can drive a real session over `tokio::io::duplex` and
/// assert on the bytes. The loop does three things and nothing else: read a line and feed it to the link,
/// take an offered intent and feed it to the link, and send a ping when the wire has been quiet.
pub async fn run_session<R, W>(
    reader: R,
    mut writer: W,
    link: &mut HedgeLink,
    offers: &mut mpsc::Receiver<IntentMsg>,
    store: &mpsc::Sender<StoreOp>,
    ping_interval: Duration,
) -> SessionEnd
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    // the handshake is the first thing on the wire
    for action in link.connect() {
        if let Err(e) = apply(&mut writer, store, action, link).await {
            return e;
        }
    }

    let mut lines = BufReader::new(reader).lines();
    let mut ping = tokio::time::interval(ping_interval);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await; // the first tick is immediate; skip it so a fresh session does not open with a ping

    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    // A LINE WE CANNOT PARSE DOES NOT END THE SESSION. Dropping the connection would make
                    // the bridge resend everything, including the results we already stored, for the sake
                    // of one bad line. It is logged and skipped.
                    let msg = match decode_line(&line) {
                        Ok(msg) => msg,
                        Err(e) => {
                            tracing::warn!(error = %e, "hedge socket: a line did not parse; skipped");
                            continue;
                        }
                    };
                    for action in link.on_message(msg) {
                        if let Err(end) = apply(&mut writer, store, action, link).await {
                            return end;
                        }
                    }
                }
                Ok(None) => return SessionEnd::Closed,
                Err(e) => return SessionEnd::Io(e),
            },

            offered = offers.recv() => match offered {
                Some(intent) => {
                    for action in link.offer(intent) {
                        if let Err(end) = apply(&mut writer, store, action, link).await {
                            return end;
                        }
                    }
                }
                None => return SessionEnd::OfferChannelClosed,
            },

            _ = ping.tick() => {
                let now = chrono::Utc::now().to_rfc3339();
                if let Err(end) = apply(&mut writer, store, link.ping(now), link).await {
                    return end;
                }
            }
        }
    }
}

/// Carry out one action. `Err` means the session is over.
async fn apply<W>(
    writer: &mut W,
    store: &mpsc::Sender<StoreOp>,
    action: Action,
    link: &mut HedgeLink,
) -> Result<(), SessionEnd>
where
    W: AsyncWrite + Unpin,
{
    match action {
        Action::Send(msg) => {
            let line = match encode(&msg) {
                Ok(line) => line,
                Err(e) => {
                    // Our own message would not serialise. That is a bug here, not a wire problem, and
                    // dropping the connection would not fix it.
                    tracing::error!(error = %e, "hedge socket: could not encode an outbound message");
                    return Ok(());
                }
            };
            writer.write_all(line.as_bytes()).await.map_err(SessionEnd::Io)?;
            writer.flush().await.map_err(SessionEnd::Io)?;
            Ok(())
        }
        Action::MarkAccepted(intent_id) => {
            // A full channel must not block the read loop, and losing the mark is recoverable: the intent
            // stays PENDING and is offered once more on the next connect, where the bridge dedupes it.
            if store.try_send(StoreOp::MarkAccepted(intent_id.clone())).is_err() {
                tracing::warn!(intent_id = %intent_id, "hedge socket: store queue full; the accept mark will be redone on reconnect");
            }
            Ok(())
        }
        Action::PersistResult(result) => {
            if store.try_send(StoreOp::PersistResult(result.clone())).is_err() {
                // This one is NOT recoverable by itself: we have acked the leg, so the bridge will not
                // resend it. Say so loudly.
                tracing::error!(
                    intent_id = %result.intent_id,
                    leg_id = ?result.leg_id,
                    "hedge socket: store queue full; a leg result was acked but not queued for writing"
                );
            }
            Ok(())
        }
        Action::HandshakeRefused(why) => {
            link.disconnected();
            Err(SessionEnd::Refused(why))
        }
        Action::Ready => {
            tracing::info!(unaccepted = link.unaccepted_count(), "hedge socket: handshake done");
            Ok(())
        }
        Action::Protocol(note) => {
            tracing::warn!(note = %note, "hedge socket: protocol note");
            Ok(())
        }
    }
}

/// Seconds to wait before reconnecting after `failures` consecutive failures.
pub fn reconnect_delay(failures: u32, min: Duration, max: Duration) -> Duration {
    let factor = 1u64 << failures.min(6);
    std::cmp::min(min.saturating_mul(factor as u32), max)
}

/// Supervise the link for ever: connect, run a session, back off, reconnect.
///
/// `seed` is called after every successful handshake to re-offer what the database still says is
/// un-accepted. That read -- not this task's memory -- is the resend of record: a process that died with
/// intents in flight has nothing in memory to resend, and the rows are the only thing that survived.
pub async fn run<F, Fut>(config: SocketConfig, offers: mpsc::Receiver<IntentMsg>, store: mpsc::Sender<StoreOp>, seed: F)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Vec<IntentMsg>>,
{
    if !config.is_loopback() {
        tracing::error!(addr = %config.addr, "hedge socket: refusing a non-loopback address");
        return;
    }
    let mut offers = offers;
    let mut failures: u32 = 0;

    loop {
        let stream = match tokio::net::TcpStream::connect(&config.addr).await {
            Ok(s) => s,
            Err(e) => {
                failures = failures.saturating_add(1);
                let wait = reconnect_delay(failures, config.backoff_min, config.backoff_max);
                tracing::warn!(error = %e, addr = %config.addr, ?wait, "hedge socket: connect failed");
                tokio::time::sleep(wait).await;
                continue;
            }
        };
        // Nagle off: an intent is a short line and the fill is already waiting on it.
        let _ = stream.set_nodelay(true);

        let mut link = HedgeLink::new(config.token.clone(), config.broker_id.clone());
        // Everything the database still owes the bridge, queued BEFORE the handshake so the link sends it
        // the moment the bridge says ok.
        for intent in seed().await {
            link.offer(intent);
        }

        let (reader, writer) = stream.into_split();
        let end = run_session(reader, writer, &mut link, &mut offers, &store, config.ping_interval).await;

        if matches!(end, SessionEnd::OfferChannelClosed) {
            tracing::info!("hedge socket: the offer channel closed; stopping");
            return;
        }
        failures = if end.is_refusal() { failures.saturating_add(1).max(4) } else { failures.saturating_add(1) };
        let wait = reconnect_delay(failures, config.backoff_min, config.backoff_max);
        tracing::warn!(?end, ?wait, "hedge socket: session ended; reconnecting");
        tokio::time::sleep(wait).await;
    }
}

/// Apply what the sessions ask for, off their read loops.
///
/// ONE TASK, NOT ONE PER OP, and sequentially: these writes are small, they are ordered per leg anyway, and
/// a pool connection held here is one the order path cannot have. A write that fails is logged and dropped
/// rather than retried in place -- for an accept mark the next reconnect redoes it, and for a result the row
/// is reconstructible from the bridge's own record, so blocking the queue to retry would cost more than it
/// saves.
pub async fn drain_store(pool: sqlx::PgPool, mut ops: mpsc::Receiver<StoreOp>) {
    while let Some(op) = ops.recv().await {
        match op {
            StoreOp::MarkAccepted(intent_id) => {
                if let Err(e) = crate::hedge_outbox::mark_accepted(&pool, &intent_id).await {
                    tracing::warn!(error = %e, intent_id = %intent_id, "hedge store: could not mark the intent accepted; the next reconnect will re-offer it");
                }
            }
            StoreOp::PersistResult(result) => {
                // The requested volume lives on the intent, not in the result message, and HedgeResult
                // wants it so a partial can be read as a partial without a join.
                let requested: rust_decimal::Decimal = match sqlx::query_as::<_, (rust_decimal::Decimal,)>(
                    r#"SELECT volume FROM "HedgeIntent" WHERE id = $1"#,
                )
                .bind(&result.intent_id)
                .fetch_optional(&pool)
                .await
                {
                    Ok(Some((v,))) => v,
                    Ok(None) => {
                        // A result for an intent we have no row for. Not droppable in silence: either the
                        // bridge is talking about someone else's intent, or a row we must have is gone.
                        tracing::error!(
                            intent_id = %result.intent_id,
                            leg_id = ?result.leg_id,
                            "hedge store: a result arrived for an intent with no row"
                        );
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, intent_id = %result.intent_id, "hedge store: could not read the intent volume");
                        continue;
                    }
                };
                if let Err(e) = crate::hedge_outbox::persist_result(&pool, &result, requested).await {
                    tracing::error!(error = %e, intent_id = %result.intent_id, leg_id = ?result.leg_id, "hedge store: could not write the leg result");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hedge_bridge::ResultStatus;
    use tokio::io::AsyncBufReadExt;

    fn intent(id: &str) -> IntentMsg {
        IntentMsg {
            intent_id: id.into(),
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

    /// One end of a duplex, playing the bridge: read the engine's lines, write replies.
    struct FakeBridge {
        lines: tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
        writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    }

    impl FakeBridge {
        async fn next(&mut self) -> serde_json::Value {
            let line = self.lines.next_line().await.unwrap().expect("the engine sent nothing");
            serde_json::from_str(&line).unwrap()
        }
        async fn say(&mut self, raw: &str) {
            self.writer.write_all(format!("{raw}\n").as_bytes()).await.unwrap();
            self.writer.flush().await.unwrap();
        }
    }

    /// Stand up a real session over an in-memory duplex. Returns the bridge end, the offer sender, the store
    /// receiver, and the session's join handle.
    #[allow(clippy::type_complexity)]
    fn session() -> (
        FakeBridge,
        mpsc::Sender<IntentMsg>,
        mpsc::Receiver<StoreOp>,
        tokio::task::JoinHandle<SessionEnd>,
    ) {
        let (engine_side, bridge_side) = tokio::io::duplex(64 * 1024);
        let (engine_r, engine_w) = tokio::io::split(engine_side);
        let (bridge_r, bridge_w) = tokio::io::split(bridge_side);

        let (offer_tx, mut offer_rx) = mpsc::channel::<IntentMsg>(16);
        let (store_tx, store_rx) = mpsc::channel::<StoreOp>(16);

        let handle = tokio::spawn(async move {
            let mut link = HedgeLink::new("tok", "brk");
            run_session(
                engine_r,
                engine_w,
                &mut link,
                &mut offer_rx,
                &store_tx,
                Duration::from_secs(3600), // far away: these tests are not about pings
            )
            .await
        });

        (
            FakeBridge { lines: BufReader::new(bridge_r).lines(), writer: bridge_w },
            offer_tx,
            store_rx,
            handle,
        )
    }

    #[tokio::test]
    async fn the_session_greets_first_and_the_reply_opens_it() {
        let (mut bridge, _offers, _store, _h) = session();
        let hello = bridge.next().await;
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["token"], "tok");
        assert_eq!(hello["broker_id"], "brk");
        assert_eq!(hello["v"], crate::hedge_bridge::PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn an_offered_intent_reaches_the_wire_after_the_handshake() {
        let (mut bridge, offers, _store, _h) = session();
        bridge.next().await; // hello
        bridge.say(r#"{"type":"hello","ok":true}"#).await;
        offers.send(intent("H1")).await.unwrap();

        let sent = bridge.next().await;
        assert_eq!(sent["type"], "intent");
        assert_eq!(sent["intent_id"], "H1");
        assert_eq!(sent["volume"], "0.01", "a decimal string, not a float");
        assert_eq!(sent["reduce"], false);
    }

    /// An intent offered before the bridge answers is held, not lost -- the fill has already happened.
    #[tokio::test]
    async fn an_intent_offered_before_the_reply_goes_out_when_it_arrives() {
        let (mut bridge, offers, _store, _h) = session();
        bridge.next().await; // hello
        offers.send(intent("H1")).await.unwrap();
        // give the session a moment to take it off the channel while still in the handshake
        tokio::time::sleep(Duration::from_millis(30)).await;
        bridge.say(r#"{"type":"hello","ok":true}"#).await;

        let sent = bridge.next().await;
        assert_eq!(sent["type"], "intent");
        assert_eq!(sent["intent_id"], "H1");
    }

    #[tokio::test]
    async fn accepted_becomes_a_store_op() {
        let (mut bridge, offers, mut store, _h) = session();
        bridge.next().await;
        bridge.say(r#"{"type":"hello","ok":true}"#).await;
        offers.send(intent("H1")).await.unwrap();
        bridge.next().await; // the intent

        bridge.say(r#"{"type":"accepted","intent_id":"H1"}"#).await;
        assert_eq!(store.recv().await.unwrap(), StoreOp::MarkAccepted("H1".into()));
    }

    #[tokio::test]
    async fn a_result_is_queued_for_writing_and_acked_on_the_wire_by_leg() {
        let (mut bridge, offers, mut store, _h) = session();
        bridge.next().await;
        bridge.say(r#"{"type":"hello","ok":true}"#).await;
        offers.send(intent("H1")).await.unwrap();
        bridge.next().await;

        // ONE LINE, and that is not cosmetic: the framing is one message per line, so a JSON document
        // split across lines is three broken frames, not one message. (serde_json itself accepts internal
        // newlines, which is why the hedge_bridge tests can afford to be pretty-printed -- they call
        // decode_line directly and never cross the wire.)
        bridge
            .say(r#"{"type":"result","intent_id":"H1","leg_id":"H1_0","status":"FILLED","filled_qty":"0.01","avg_px":"1.10344","lp_id":"lp-1","lp_order_ids":["o-1"],"reason":null,"completed_at":"2026-11-14T00:00:01Z"}"#)
            .await;

        match store.recv().await.unwrap() {
            StoreOp::PersistResult(r) => {
                assert_eq!(r.leg_id.as_deref(), Some("H1_0"));
                assert_eq!(r.status, ResultStatus::Filled);
            }
            other => panic!("expected a result to store, got {other:?}"),
        }

        let ack = bridge.next().await;
        assert_eq!(ack["type"], "result_ack");
        assert_eq!(ack["intent_id"], "H1");
        assert_eq!(ack["leg_id"], "H1_0", "the ack names the leg it answers");
    }

    /// The per-leg resend, over a real socket this time: only the leg whose ack was lost comes back, and the
    /// engine acks that leg without queueing a second write for it.
    #[tokio::test]
    async fn a_resent_leg_is_acked_again_and_not_written_twice() {
        let (mut bridge, offers, mut store, _h) = session();
        bridge.next().await;
        bridge.say(r#"{"type":"hello","ok":true}"#).await;
        offers.send(intent("H1")).await.unwrap();
        bridge.next().await;

        // one line per message -- see the note in the test above
        let leg = |n: u32| {
            format!(
                r#"{{"type":"result","intent_id":"H1","leg_id":"H1_{n}","status":"PARTIAL","filled_qty":"0.004","avg_px":"1.10344","lp_id":"lp-{n}","lp_order_ids":[],"reason":null,"completed_at":"2026-11-14T00:00:0{n}Z"}}"#
            )
        };
        for n in 0..3 {
            bridge.say(&leg(n)).await;
        }
        let mut stored = Vec::new();
        for _ in 0..3 {
            if let StoreOp::PersistResult(r) = store.recv().await.unwrap() {
                stored.push(r.leg_id.unwrap());
            }
        }
        assert_eq!(stored, vec!["H1_0", "H1_1", "H1_2"]);
        for n in 0..3 {
            let ack = bridge.next().await;
            assert_eq!(ack["leg_id"], format!("H1_{n}"));
        }

        // the bridge never saw the ack for leg 1, so it resends that leg alone
        bridge.say(&leg(1)).await;
        let ack = bridge.next().await;
        assert_eq!(ack["type"], "result_ack");
        assert_eq!(ack["leg_id"], "H1_1", "acked again, by leg");
        assert!(store.try_recv().is_err(), "and NOT queued for writing a second time");
    }

    #[tokio::test]
    async fn a_refused_handshake_ends_the_session_with_the_reason() {
        let (mut bridge, _offers, _store, h) = session();
        bridge.next().await;
        bridge.say(r#"{"type":"hello","ok":false,"error":"bad token"}"#).await;
        let end = h.await.unwrap();
        assert!(end.is_refusal(), "the supervisor must take the long backoff, not reconnect at once");
        match end {
            SessionEnd::Refused(why) => assert_eq!(why, "bad token"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// A line that does not parse must not cost the connection: dropping it would make the bridge resend
    /// everything, including legs already stored.
    #[tokio::test]
    async fn a_line_that_does_not_parse_is_skipped_and_the_session_lives() {
        let (mut bridge, offers, mut store, _h) = session();
        bridge.next().await;
        bridge.say(r#"{"type":"hello","ok":true}"#).await;

        bridge.say("this is not json").await;
        bridge.say(r#"{"type":"nonsense_message"}"#).await;
        bridge.say("").await;

        // still alive: an intent offered now still goes out, and an accept still lands
        offers.send(intent("H1")).await.unwrap();
        assert_eq!(bridge.next().await["intent_id"], "H1");
        bridge.say(r#"{"type":"accepted","intent_id":"H1"}"#).await;
        assert_eq!(store.recv().await.unwrap(), StoreOp::MarkAccepted("H1".into()));
    }

    /// THE FRAMING IS THE CONTRACT, and this test exists because getting it wrong cost real time: a result
    /// written as pretty-printed JSON is three broken frames, every one of them skipped, and the session
    /// looks alive while the result never lands. `decode_line` would have accepted the same bytes as one
    /// document -- serde_json allows internal newlines -- so only a test that crosses the wire catches it.
    #[tokio::test]
    async fn a_message_split_across_lines_is_not_a_message() {
        let (mut bridge, offers, mut store, _h) = session();
        bridge.next().await;
        bridge.say(r#"{"type":"hello","ok":true}"#).await;
        offers.send(intent("H1")).await.unwrap();
        bridge.next().await; // the intent

        // the same document as the passing test above, but pretty-printed
        bridge
            .say(
                "{\"type\":\"result\",\"intent_id\":\"H1\",\"leg_id\":\"H1_0\",\"status\":\"FILLED\",\n \
                 \"filled_qty\":\"0.01\",\"avg_px\":\"1.1\",\"lp_id\":\"lp-1\",\"lp_order_ids\":[],\n \
                 \"reason\":null,\"completed_at\":\"2026-11-14T00:00:01Z\"}",
            )
            .await;

        // nothing is stored, because no frame parsed
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(store.try_recv().is_err(), "a split document must not be read as a result");

        // and the session is still usable: the skipped frames did not cost the connection
        bridge.say(r#"{"type":"accepted","intent_id":"H1"}"#).await;
        assert_eq!(store.recv().await.unwrap(), StoreOp::MarkAccepted("H1".into()));
    }

    #[tokio::test]
    async fn the_bridge_hanging_up_ends_the_session_so_the_supervisor_reconnects() {
        let (bridge, _offers, _store, h) = session();
        drop(bridge); // the bridge end goes away
        assert!(matches!(h.await.unwrap(), SessionEnd::Closed | SessionEnd::Io(_)));
    }

    #[tokio::test]
    async fn a_pong_is_harmless() {
        let (mut bridge, offers, mut store, _h) = session();
        bridge.next().await;
        bridge.say(r#"{"type":"hello","ok":true}"#).await;
        bridge.say(r#"{"type":"pong","ts":"t"}"#).await;
        offers.send(intent("H1")).await.unwrap();
        assert_eq!(bridge.next().await["intent_id"], "H1");
        bridge.say(r#"{"type":"accepted","intent_id":"H1"}"#).await;
        assert_eq!(store.recv().await.unwrap(), StoreOp::MarkAccepted("H1".into()));
    }

    #[tokio::test]
    async fn a_quiet_wire_gets_a_ping() {
        let (engine_side, bridge_side) = tokio::io::duplex(64 * 1024);
        let (engine_r, engine_w) = tokio::io::split(engine_side);
        let (bridge_r, bridge_w) = tokio::io::split(bridge_side);
        let (_offer_tx, mut offer_rx) = mpsc::channel::<IntentMsg>(4);
        let (store_tx, _store_rx) = mpsc::channel::<StoreOp>(4);
        tokio::spawn(async move {
            let mut link = HedgeLink::new("tok", "brk");
            run_session(engine_r, engine_w, &mut link, &mut offer_rx, &store_tx, Duration::from_millis(40)).await
        });
        let mut bridge = FakeBridge { lines: BufReader::new(bridge_r).lines(), writer: bridge_w };
        assert_eq!(bridge.next().await["type"], "hello");
        bridge.say(r#"{"type":"hello","ok":true}"#).await;
        let ping = bridge.next().await;
        assert_eq!(ping["type"], "ping");
        assert!(ping["ts"].as_str().is_some_and(|t| !t.is_empty()));
    }

    // ---- config and backoff ----

    #[test]
    fn the_socket_is_dormant_until_an_address_is_set() {
        // The absence of the address is the off switch, so this is the assertion that keeps the branch
        // dormant no matter what else is wired up.
        temp_env_unset("VYX_HEDGE_SOCKET_ADDR");
        assert!(SocketConfig::from_env().is_none());
    }

    fn temp_env_unset(key: &str) {
        // Tests in this module run in one process; only this test touches the variable.
        std::env::remove_var(key);
    }

    #[test]
    fn only_loopback_is_accepted() {
        let cfg = |addr: &str| SocketConfig {
            addr: addr.into(),
            token: String::new(),
            broker_id: String::new(),
            ping_interval: Duration::from_secs(20),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
        };
        assert!(cfg("127.0.0.1:18600").is_loopback());
        assert!(cfg("localhost:18600").is_loopback());
        assert!(cfg("[::1]:18600").is_loopback());
        // intents must not leave the box
        assert!(!cfg("10.0.0.5:18600").is_loopback());
        assert!(!cfg("bridge.example.com:18600").is_loopback());
        assert!(!cfg("0.0.0.0:18600").is_loopback());
    }

    #[test]
    fn the_backoff_climbs_and_then_stops_climbing() {
        let min = Duration::from_secs(1);
        let max = Duration::from_secs(60);
        assert_eq!(reconnect_delay(0, min, max), Duration::from_secs(1));
        assert_eq!(reconnect_delay(1, min, max), Duration::from_secs(2));
        assert_eq!(reconnect_delay(3, min, max), Duration::from_secs(8));
        assert_eq!(reconnect_delay(6, min, max), Duration::from_secs(60), "capped");
        assert_eq!(reconnect_delay(99, min, max), max, "and stays capped");
    }
}
