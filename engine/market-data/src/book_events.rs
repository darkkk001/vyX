//! Reload on change (2026-09-26): the web announces every book change on NATS (lib/nats.ts SUBJECTS, relayed by the
//! gateway): a fill, a cancel, an SL / TP edit, a resting-order edit, a close, a balance or account change, a config
//! change. The risk hook's levels and the margin trigger's book used to learn about a change only on their 5 s poll, so
//! a just-set SL / TP was not watched for up to 5 s. The server subscribes to these subjects and feeds this debouncer,
//! which turns each burst of announcements into ONE reload request (a bulk close is dozens of events). The 5 s poll
//! stays as the safety net.
//!
//! Safety cadence with two guards (owner, 2026-09-26): with the book idle the 5 s safety poll was the last thing
//! keeping Neon awake (38 commits/min on a closed-market weekend while crypto ticks). The safety reload now follows
//! the book gate: 5 s while something held can move (Gate::Run) or while the event feed is NOT known to be complete,
//! 10 minutes otherwise. The feed is "healthy" only while it provably loses nothing:
//! - Guard 1: every (re)connection of the NATS client triggers an immediate full reload, and the feed stays unhealthy
//!   until a sequenced event proves the stream again (announcements sent while disconnected are gone for good).
//! - Guard 2: the gateway stamps every book-change event with `book_epoch` (random per gateway boot) and `book_seq`
//!   (+1 per event) and repeats (epoch, seq, subject) on ONE subject, `book.seq`, so the engine sees them in publish
//!   order on a single subscription. A gap (seq > last + 1) or a new epoch (gateway restarted) is a lost event: an
//!   immediate full reload, logged. An older gateway sends no sequence: the feed never becomes healthy -> 5 s.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::activity::Gate;

/// The gateway's sequence subject: one message per stamped book-change event, `{book_epoch, book_seq, subject}`.
pub const BOOK_SEQ_SUBJECT: &str = "book.seq";
/// Safety reload while something held can move, or while the event feed is not provably complete.
pub const SAFETY_FAST: Duration = Duration::from_secs(5);
/// Safety reload while the book is idle and every change provably arrives as an event (Neon can suspend: > 5 min).
pub const SAFETY_IDLE: Duration = Duration::from_secs(600);

/// The owner's cadence table: book gate x feed health -> the safety reload interval.
pub fn safety_interval(gate: Gate, feed_healthy: bool) -> Duration {
    if gate == Gate::Run || !feed_healthy {
        SAFETY_FAST
    } else {
        SAFETY_IDLE
    }
}

/// What one `book.seq` marker means for the feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeqObservation {
    /// the first sequenced event since the (re)subscription: the feed is now healthy
    First,
    InOrder,
    /// one or more events never arrived: reload everything now
    Gap { expected: u64, got: u64 },
    /// the gateway restarted (new epoch): events in between may be lost -- reload everything now
    EpochChanged,
    /// seq <= last in the same epoch: a duplicate or a late one, nothing to do
    Duplicate,
    /// no sequence (an older gateway): the feed cannot be proven complete -> unhealthy
    Unsequenced,
}

impl SeqObservation {
    pub fn needs_full_reload(&self) -> bool {
        matches!(self, SeqObservation::Gap { .. } | SeqObservation::EpochChanged)
    }
}

/// (epoch, last seq) of the gateway's book-change stream as this engine has seen it since its (re)subscription.
#[derive(Debug, Default)]
pub struct SequenceTracker {
    epoch: Option<String>,
    last: u64,
    healthy: bool,
}

impl SequenceTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn healthy(&self) -> bool {
        self.healthy
    }

    /// A disconnect: whatever was published meanwhile is lost; unhealthy until a sequenced event arrives again.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn observe(&mut self, epoch: Option<&str>, seq: Option<u64>) -> SeqObservation {
        let (Some(epoch), Some(seq)) = (epoch, seq) else {
            self.reset();
            return SeqObservation::Unsequenced;
        };
        match self.epoch.as_deref() {
            None => {
                self.epoch = Some(epoch.to_string());
                self.last = seq;
                self.healthy = true;
                SeqObservation::First
            }
            Some(e) if e != epoch => {
                self.epoch = Some(epoch.to_string());
                self.last = seq;
                self.healthy = true;
                SeqObservation::EpochChanged
            }
            Some(_) if seq <= self.last => SeqObservation::Duplicate,
            Some(_) if seq == self.last + 1 => {
                self.last = seq;
                SeqObservation::InOrder
            }
            Some(_) => {
                let expected = self.last + 1;
                self.last = seq;
                SeqObservation::Gap { expected, got: seq }
            }
        }
    }
}

/// The feed's health as the reload loops read it, plus the transitions (logged once each).
#[derive(Default)]
pub struct BookFeed {
    tracker: Mutex<SequenceTracker>,
    healthy: AtomicBool,
    /// full reloads forced by a lost event or a reconnect (for tests / diagnostics)
    pub forced_reloads: std::sync::atomic::AtomicU64,
}

impl BookFeed {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }

    fn set_healthy(&self, now: bool, why: &str) {
        let was = self.healthy.swap(now, Ordering::AcqRel);
        if was != now {
            if now {
                tracing::info!(why, "book events: feed healthy (sequenced) -- idle safety reload every 10 min");
            } else {
                tracing::warn!(why, "book events: feed NOT healthy -- safety reload every 5 s");
            }
        }
    }

    /// One `book.seq` marker (JSON `{book_epoch, book_seq, subject}`). Returns whether a full reload is due now.
    pub fn observe_marker(&self, payload: &[u8]) -> bool {
        let v: serde_json::Value = serde_json::from_slice(payload).unwrap_or(serde_json::Value::Null);
        let epoch = v.get("book_epoch").and_then(|e| e.as_str());
        let seq = v.get("book_seq").and_then(|s| s.as_u64());
        let obs = self.tracker.lock().unwrap_or_else(|p| p.into_inner()).observe(epoch, seq);
        match &obs {
            SeqObservation::Gap { expected, got } => {
                tracing::warn!(expected, got, lost = got - expected, "book events: sequence GAP -- lost event(s), full reload now")
            }
            SeqObservation::EpochChanged => tracing::warn!("book events: gateway epoch changed (restart) -- full reload now"),
            _ => {}
        }
        let healthy = self.tracker.lock().unwrap_or_else(|p| p.into_inner()).healthy();
        self.set_healthy(healthy, if healthy { "sequenced event" } else { "unsequenced event" });
        if obs.needs_full_reload() {
            self.forced_reloads.fetch_add(1, Ordering::Relaxed);
        }
        obs.needs_full_reload()
    }

    /// The NATS client lost its connection: anything published meanwhile is gone.
    pub fn on_disconnect(&self) {
        self.tracker.lock().unwrap_or_else(|p| p.into_inner()).reset();
        self.set_healthy(false, "NATS disconnected");
    }

    /// The NATS client (re)connected: the caller reloads everything now (Guard 1).
    pub fn on_reconnect(&self) {
        self.forced_reloads.fetch_add(1, Ordering::Relaxed);
        tracing::info!("book events: NATS (re)connected -- full reload now; feed healthy again on the next sequenced event");
    }
}

/// Guard 1: watches the NATS client's connection state (polled every `every`): a drop marks the feed unhealthy; a
/// return calls `on_reconnect` (the full reload) and `feed.on_reconnect`. `connected` reads the client's state.
pub fn spawn_connection_watch(
    connected: Arc<dyn Fn() -> bool + Send + Sync>,
    feed: Arc<BookFeed>,
    every: Duration,
    on_reconnect: Arc<dyn Fn() + Send + Sync>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut was = connected();
        loop {
            tokio::time::sleep(every).await;
            let now = connected();
            if was && !now {
                feed.on_disconnect();
            } else if !was && now {
                feed.on_reconnect();
                on_reconnect();
            }
            was = now;
        }
    })
}

/// The web's book-change subjects (lib/nats.ts SUBJECTS: order.* / position.* / account.* / config.changed).
pub const BOOK_CHANGE_SUBJECTS: &[&str] = &["order.>", "position.>", "account.>", "config.changed"];

/// The debounce the server uses: announcements closer together than this make one reload.
pub const DEBOUNCE: Duration = Duration::from_millis(150);

/// Calls `on_change` once per burst: after the first announcement, as soon as `debounce` passes with no new one, and
/// at the latest 4 x `debounce` after the burst began (a steady stream of events still reloads). Runs until the
/// sender side is dropped.
pub fn spawn_debounced(mut rx: UnboundedReceiver<String>, debounce: Duration, on_change: Arc<dyn Fn() + Send + Sync>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while rx.recv().await.is_some() {
            let deadline = tokio::time::Instant::now() + debounce * 4;
            loop {
                let wait = debounce.min(deadline.saturating_duration_since(tokio::time::Instant::now()));
                if wait.is_zero() {
                    break;
                }
                match tokio::time::timeout(wait, rx.recv()).await {
                    Ok(Some(_)) => continue, // another announcement in the burst
                    Ok(None) => {
                        on_change();
                        return;
                    }
                    Err(_) => break, // quiet for `debounce`
                }
            }
            on_change();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn counter() -> (Arc<AtomicUsize>, Arc<dyn Fn() + Send + Sync>) {
        let n = Arc::new(AtomicUsize::new(0));
        let m = n.clone();
        (n, Arc::new(move || {
            m.fetch_add(1, Ordering::SeqCst);
        }))
    }

    #[tokio::test]
    async fn a_burst_of_announcements_makes_one_reload_soon_after_it_ends() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (n, f) = counter();
        spawn_debounced(rx, Duration::from_millis(50), f);
        for s in ["position.modified", "order.filled", "position.closed_bulk"] {
            tx.send(s.to_string()).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(n.load(Ordering::SeqCst), 0, "still inside the debounce");
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(n.load(Ordering::SeqCst), 1, "one reload for the burst");
        tx.send("position.modified".into()).unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(n.load(Ordering::SeqCst), 2, "a later announcement reloads again");
    }

    #[test]
    fn the_safety_cadence_table() {
        for g in [Gate::FeedQuiet, Gate::FlatBook, Gate::BookClosed] {
            assert_eq!(safety_interval(g, true), SAFETY_IDLE, "{g:?} + healthy -> 10 min");
            assert_eq!(safety_interval(g, false), SAFETY_FAST, "{g:?} + unhealthy -> 5 s");
        }
        assert_eq!(safety_interval(Gate::Run, true), SAFETY_FAST, "running -> 5 s even when healthy");
        assert_eq!(safety_interval(Gate::Run, false), SAFETY_FAST);
        assert_eq!(SAFETY_IDLE, Duration::from_secs(600));
    }

    #[test]
    fn the_sequence_tracker() {
        let mut t = SequenceTracker::new();
        assert!(!t.healthy(), "unhealthy until the first sequenced event");
        assert_eq!(t.observe(None, None), SeqObservation::Unsequenced, "an older gateway");
        assert!(!t.healthy());
        assert_eq!(t.observe(Some("e1"), Some(57)), SeqObservation::First);
        assert!(t.healthy());
        assert_eq!(t.observe(Some("e1"), Some(58)), SeqObservation::InOrder);
        assert_eq!(t.observe(Some("e1"), Some(58)), SeqObservation::Duplicate, "same seq again");
        assert_eq!(t.observe(Some("e1"), Some(40)), SeqObservation::Duplicate, "a late one");
        assert_eq!(t.observe(Some("e1"), Some(61)), SeqObservation::Gap { expected: 59, got: 61 });
        assert!(SeqObservation::Gap { expected: 59, got: 61 }.needs_full_reload());
        assert_eq!(t.observe(Some("e1"), Some(62)), SeqObservation::InOrder, "resynchronised after the gap");
        assert_eq!(t.observe(Some("e2"), Some(1)), SeqObservation::EpochChanged, "gateway restart");
        assert!(SeqObservation::EpochChanged.needs_full_reload());
        assert_eq!(t.observe(Some("e2"), Some(2)), SeqObservation::InOrder);
        assert_eq!(t.observe(None, None), SeqObservation::Unsequenced, "downgraded gateway");
        assert!(!t.healthy(), "an unsequenced event makes the feed unprovable");
        t.observe(Some("e3"), Some(9));
        t.reset();
        assert!(!t.healthy(), "a disconnect resets the proof");
    }

    #[test]
    fn book_feed_reads_the_marker_and_counts_forced_reloads() {
        let f = BookFeed::new();
        let m = |e: &str, s: u64| serde_json::to_vec(&serde_json::json!({ "book_epoch": e, "book_seq": s, "subject": "position.modified" })).unwrap();
        assert!(!f.observe_marker(&m("e", 1)), "first: no reload");
        assert!(f.is_healthy());
        assert!(!f.observe_marker(&m("e", 2)));
        assert!(f.observe_marker(&m("e", 4)), "gap: reload");
        assert!(f.observe_marker(&m("f", 1)), "new epoch: reload");
        assert!(!f.observe_marker(b"not json"), "garbage: no reload, but unhealthy");
        assert!(!f.is_healthy());
        f.on_disconnect();
        assert!(!f.is_healthy());
        assert_eq!(f.forced_reloads.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn a_reconnect_forces_a_full_reload_and_a_disconnect_makes_the_feed_unhealthy() {
        let connected = Arc::new(AtomicBool::new(true));
        let feed = BookFeed::new();
        feed.observe_marker(br#"{"book_epoch":"e","book_seq":1}"#);
        assert!(feed.is_healthy());
        let (n, f) = counter();
        let c = connected.clone();
        spawn_connection_watch(Arc::new(move || c.load(Ordering::SeqCst)), feed.clone(), Duration::from_millis(10), f);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(n.load(Ordering::SeqCst), 0, "steady connection: nothing");
        connected.store(false, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(!feed.is_healthy(), "disconnect -> unhealthy (5 s cadence)");
        assert_eq!(n.load(Ordering::SeqCst), 0);
        connected.store(true, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(n.load(Ordering::SeqCst), 1, "reconnect -> one full reload");
        assert!(!feed.is_healthy(), "still unhealthy until a sequenced event proves the stream");
        feed.observe_marker(br#"{"book_epoch":"e","book_seq":9}"#);
        assert!(feed.is_healthy());
    }

    #[tokio::test]
    async fn a_steady_stream_still_reloads_within_four_debounces() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (n, f) = counter();
        spawn_debounced(rx, Duration::from_millis(40), f);
        let t0 = tokio::time::Instant::now();
        while t0.elapsed() < Duration::from_millis(250) {
            tx.send("order.filled".into()).unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(n.load(Ordering::SeqCst) >= 1, "reloaded despite never going quiet");
    }
}
