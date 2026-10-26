//! Stage 6 risk mode: the workers behind the fire channel (market_data::risk_hook::LiveSender), in two lanes
//! (owner 2026-10-26, the stop-out-under-load fix, part A).
//!
//! Before: ONE worker took every fire in arrival order, in batches run 8 accounts at a time, each chunk waiting for its
//! slowest account. Under load (2026-10-26: 450 positions, one account closing 405 of them one after another) a
//! stop-out fire waited behind SL / TP evaluations for 12-37 s; the market reversed meanwhile and the account was
//! never stopped out although its equity had crossed zero twice.
//!
//! Now:
//! - **two lanes**, each with its OWN connections and its own concurrency: margin fires (stop-out / margin-call edge)
//!   in the stop-out lane, SL / TP touches and resting-order crossings in the touch lane. The touch lane can never take
//!   the stop-out lane's connections or slots;
//! - **per-account work, no batch**: a fire runs as soon as its lane has a free slot. One evaluation per account at a
//!   time, across BOTH lanes (two evaluations of one account would only queue on its row lock and re-read each other's
//!   closes). A fire for an account whose fire is still queued is merged into it (a margin fire moves it to the
//!   stop-out lane: it never waits for a touch slot); a fire for an account being evaluated is merged into the fire
//!   that runs right after, in the lane of the most urgent fire merged into it. Merging keeps the newest tick of each
//!   symbol together with ITS receive time;
//! - **load reading**: per lane, fires waiting, evaluations running, the oldest wait; served in /health and logged.
//!   A stop-out fire waiting over a second is an alert.
//!
//! Each evaluation is still the one canonical routine (monitor::evaluate_live_fire): what is decided and written does
//! not change here, only when it runs. An account's own closes still run one after another inside its evaluation
//! (part B, the set-based close, changes that).

use crate::{book, monitor};
use market_data::risk_hook::{FireSource, LiveFire, LiveSender};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, Semaphore};

/// A stop-out fire waiting longer than this is an alert (owner 2026-10-26).
pub const STOP_OUT_STALE: Duration = Duration::from_secs(1);
/// While an alert stands, it is repeated this often.
const ALERT_REPEAT: Duration = Duration::from_secs(10);
/// How often the watchdog reads the lanes.
const WATCH_EVERY: Duration = Duration::from_millis(250);
/// A reading is logged at most this often, and only when something waited or ran since the last one.
const LOG_EVERY: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Lane {
    StopOut,
    Touch,
}

impl Lane {
    pub fn of(source: FireSource) -> Lane {
        match source {
            FireSource::Margin => Lane::StopOut,
            FireSource::SlTp | FireSource::Pending => Lane::Touch,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Lane::StopOut => "stopout",
            Lane::Touch => "touch",
        }
    }
}

/// One lane's connections and how many accounts it evaluates at once (at most its pool size).
#[derive(Clone)]
pub struct LaneConfig {
    pub pool: PgPool,
    pub parallel: usize,
}

/// A fire's urgency when fires are merged: a margin fire outranks a touch, which outranks a resting-order crossing.
fn rank(source: FireSource) -> u8 {
    match source {
        FireSource::Margin => 2,
        FireSource::SlTp => 1,
        FireSource::Pending => 0,
    }
}

/// Folds `more` into `into`: per symbol the NEWER tick wins (a tie keeps the one already there) and its receive time
/// comes with it, so the delay of a close priced at that tick is measured from that tick (before 2026-10-27 the batch
/// kept the first fire's receive time next to a newer tick). The merged fire takes the more urgent source.
pub fn merge_fire(into: &mut LiveFire, more: LiveFire) {
    for (symbol, tick) in more.ticks {
        let newer = into.ticks.get(&symbol).is_none_or(|have| tick.2 > have.2);
        if newer {
            match more.received.get(&symbol) {
                Some(r) => {
                    into.received.insert(symbol.clone(), *r);
                }
                None => {
                    into.received.remove(&symbol);
                }
            }
            into.ticks.insert(symbol, tick);
        }
    }
    if rank(more.source) > rank(into.source) {
        into.source = more.source;
    }
}

/// One account's place in the lanes.
struct Slot {
    /// the lane of the evaluation queued or running now
    lane: Lane,
    /// the fire queued for a slot of its lane (None = its evaluation is running), and since when it waits
    queued: Option<(LiveFire, Instant)>,
    /// fires that arrived during the running evaluation, merged, and when the first of them arrived
    next: Option<(LiveFire, Instant)>,
    /// wakes the account's task when its queued fire moved to the stop-out lane (a margin fire merged into it)
    moved: Arc<Notify>,
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaneReading {
    /// fires not yet started: queued for a slot, or merged behind the account's running evaluation
    pub waiting: usize,
    /// evaluations running now
    pub running: usize,
    /// the oldest of those waits, ms (0 = nothing waits)
    pub oldest_wait_ms: u64,
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reading {
    pub stop_out: LaneReading,
    pub touch: LaneReading,
    /// evaluations finished since the engine started
    pub evaluations: u64,
    /// the longest one, ms
    pub max_evaluation_ms: u64,
}

impl Reading {
    /// The stop-out lane has a fire waiting longer than STOP_OUT_STALE.
    pub fn stop_out_stale(&self) -> bool {
        self.stop_out.oldest_wait_ms > STOP_OUT_STALE.as_millis() as u64
    }

    /// The /health header value: `stopout=ok waiting=0 running=0 oldest_ms=0; touch waiting=3 running=8 oldest_ms=1200`.
    pub fn header(&self) -> String {
        format!(
            "stopout={} waiting={} running={} oldest_ms={}; touch waiting={} running={} oldest_ms={}",
            if self.stop_out_stale() { "stale" } else { "ok" },
            self.stop_out.waiting,
            self.stop_out.running,
            self.stop_out.oldest_wait_ms,
            self.touch.waiting,
            self.touch.running,
            self.touch.oldest_wait_ms
        )
    }
}

/// What offer() did with a fire.
#[derive(Debug, PartialEq, Eq)]
enum Offered {
    /// the account was idle: the caller starts its task
    Start,
    /// merged into the account's queued or next fire
    Merged,
}

/// The lanes' shared state: every account with a fire queued or running, and the counters.
pub struct LiveLoad {
    slots: Mutex<HashMap<String, Slot>>,
    /// (evaluations finished, the longest in ms)
    stats: Mutex<(u64, u64)>,
}

impl LiveLoad {
    fn new() -> Self {
        LiveLoad { slots: Mutex::new(HashMap::new()), stats: Mutex::new((0, 0)) }
    }

    /// A fire arrived at `now`. An idle account gets a slot with the fire queued (Start); otherwise the fire is merged
    /// into the account's queued fire (moving it to the stop-out lane when it is a margin fire) or, while an evaluation
    /// runs, into the fire that runs next.
    fn offer(&self, fire: LiveFire, now: Instant) -> Offered {
        let mut slots = self.slots.lock().unwrap();
        match slots.get_mut(&fire.account_id) {
            Some(slot) => {
                match (&mut slot.queued, &mut slot.next) {
                    (Some((queued, _)), _) => {
                        merge_fire(queued, fire);
                        let lane = Lane::of(queued.source);
                        if lane != slot.lane {
                            slot.lane = lane;
                            slot.moved.notify_one();
                        }
                    }
                    (None, Some((next, _))) => merge_fire(next, fire),
                    (None, None) => slot.next = Some((fire, now)),
                }
                Offered::Merged
            }
            None => {
                let lane = Lane::of(fire.source);
                slots.insert(fire.account_id.clone(), Slot { lane, queued: Some((fire, now)), next: None, moved: Arc::new(Notify::new()) });
                Offered::Start
            }
        }
    }

    /// The account's queued lane and the notify that tells its task the lane changed.
    fn queued_lane(&self, account_id: &str) -> Option<(Lane, Arc<Notify>)> {
        self.slots.lock().unwrap().get(account_id).map(|s| (s.lane, s.moved.clone()))
    }

    /// The task got a slot of `lane`: takes the queued fire to run it, or None when the queued fire moved to another
    /// lane meanwhile (the task then waits for that lane).
    fn start(&self, account_id: &str, lane: Lane) -> Option<LiveFire> {
        let mut slots = self.slots.lock().unwrap();
        let slot = slots.get_mut(account_id)?;
        if slot.lane != lane {
            return None;
        }
        slot.queued.take().map(|(f, _)| f)
    }

    /// The account's evaluation finished: the fire merged meanwhile, if any, is queued next in its lane (its wait counts
    /// from when it arrived; true = there is one), else the account leaves the lanes (false).
    fn finished(&self, account_id: &str, took: Duration) -> bool {
        {
            let mut stats = self.stats.lock().unwrap();
            stats.0 += 1;
            stats.1 = stats.1.max(took.as_millis() as u64);
        }
        let mut slots = self.slots.lock().unwrap();
        let Some(slot) = slots.get_mut(account_id) else { return false };
        match slot.next.take() {
            Some((fire, arrived)) => {
                slot.lane = Lane::of(fire.source);
                slot.queued = Some((fire, arrived));
                true
            }
            None => {
                slots.remove(account_id);
                false
            }
        }
    }

    pub fn reading(&self, now: Instant) -> Reading {
        let slots = self.slots.lock().unwrap();
        let mut r = Reading::default();
        let wait_ms = |since: Instant| now.saturating_duration_since(since).as_millis() as u64;
        for slot in slots.values() {
            match &slot.queued {
                Some((_, since)) => {
                    let l = lane_mut(&mut r, slot.lane);
                    l.waiting += 1;
                    l.oldest_wait_ms = l.oldest_wait_ms.max(wait_ms(*since));
                }
                None => lane_mut(&mut r, slot.lane).running += 1,
            }
            if let Some((next, arrived)) = &slot.next {
                let l = lane_mut(&mut r, Lane::of(next.source));
                l.waiting += 1;
                l.oldest_wait_ms = l.oldest_wait_ms.max(wait_ms(*arrived));
            }
        }
        let stats = self.stats.lock().unwrap();
        r.evaluations = stats.0;
        r.max_evaluation_ms = stats.1;
        r
    }
}

fn lane_mut(r: &mut Reading, lane: Lane) -> &mut LaneReading {
    match lane {
        Lane::StopOut => &mut r.stop_out,
        Lane::Touch => &mut r.touch,
    }
}

static LOAD: OnceLock<Arc<LiveLoad>> = OnceLock::new();

/// The running engine's lanes, for /health: None outside risk mode.
pub fn reading() -> Option<Reading> {
    LOAD.get().map(|l| l.reading(Instant::now()))
}

/// What a finished evaluation hands back: `after` once it may have changed the book (a close, a resting-order fill
/// before it, an error), `idle` once the account has nothing queued any more (the margin trigger's backoff counts from
/// there: margin_watch::MarginWatch::engine_evaluated).
#[derive(Clone)]
pub struct Callbacks {
    pub after: Arc<dyn Fn() + Send + Sync>,
    pub idle: Arc<dyn Fn(&str) + Send + Sync>,
}

/// Starts the lanes and returns the sender every engine fire goes to, and the lanes' state. `beat_pool` writes the
/// risk heartbeat before each evaluation (the engine is alive and about to act; the idle gate may have stopped the timer).
pub fn spawn(
    beat_pool: PgPool,
    stop_out: LaneConfig,
    touch: LaneConfig,
    prices: book::PriceSource,
    pricing: Option<Arc<market_data::pricing::PricingCache>>,
    callbacks: Callbacks,
) -> (LiveSender, Arc<LiveLoad>) {
    let load = Arc::new(LiveLoad::new());
    let lanes = Arc::new(Lanes {
        stop_out: (stop_out.pool, Arc::new(Semaphore::new(stop_out.parallel.max(1)))),
        touch: (touch.pool, Arc::new(Semaphore::new(touch.parallel.max(1)))),
        prices,
        pricing,
        callbacks,
        load: load.clone(),
        beat_pool,
    });
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LiveFire>();
    tokio::spawn(async move {
        // the dispatcher only books each fire and never awaits the database, so a slow one never holds the next fire
        while let Some(fire) = rx.recv().await {
            let account_id = fire.account_id.clone();
            if lanes.load.offer(fire, Instant::now()) == Offered::Start {
                tokio::spawn(Arc::clone(&lanes).run_account(account_id));
            }
        }
    });
    (tx, load)
}

/// spawn() plus the watchdog (the stale alert and a periodic log line), registered for /health. Once per engine.
pub fn spawn_watched(
    beat_pool: PgPool,
    stop_out: LaneConfig,
    touch: LaneConfig,
    prices: book::PriceSource,
    pricing: Option<Arc<market_data::pricing::PricingCache>>,
    callbacks: Callbacks,
) -> LiveSender {
    let (tx, load) = spawn(beat_pool, stop_out, touch, prices, pricing, callbacks);
    let _ = LOAD.set(load.clone());
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(WATCH_EVERY);
        let mut alert = Alert::default();
        let mut last_log = Instant::now();
        let mut busy_since_log = false;
        loop {
            ticker.tick().await;
            let now = Instant::now();
            let r = load.reading(now);
            busy_since_log |= r.stop_out.waiting + r.stop_out.running + r.touch.waiting + r.touch.running > 0;
            match alert.step(&r, now) {
                Some(AlertStep::Raise) => tracing::error!(lanes = %r.header(), "RISK LANES: a stop-out fire has waited over 1 s (stop-out lane stale)"),
                Some(AlertStep::Repeat) => tracing::error!(lanes = %r.header(), "RISK LANES: the stop-out lane is still stale"),
                Some(AlertStep::Clear) => tracing::warn!(lanes = %r.header(), "RISK LANES: the stop-out lane is back under 1 s"),
                None => {}
            }
            if busy_since_log && now.duration_since(last_log) >= LOG_EVERY {
                tracing::info!(lanes = %r.header(), evaluations = r.evaluations, max_evaluation_ms = r.max_evaluation_ms, "risk lanes");
                last_log = now;
                busy_since_log = false;
            }
        }
    });
    tx
}

#[derive(Debug, PartialEq, Eq)]
enum AlertStep {
    Raise,
    Repeat,
    Clear,
}

/// The stale stop-out alert: raised once, repeated every ALERT_REPEAT while it stands, cleared once.
#[derive(Default)]
struct Alert {
    since: Option<Instant>,
    last: Option<Instant>,
}

impl Alert {
    fn step(&mut self, r: &Reading, now: Instant) -> Option<AlertStep> {
        match (r.stop_out_stale(), self.since) {
            (true, None) => {
                self.since = Some(now);
                self.last = Some(now);
                Some(AlertStep::Raise)
            }
            (true, Some(_)) if self.last.is_none_or(|l| now.duration_since(l) >= ALERT_REPEAT) => {
                self.last = Some(now);
                Some(AlertStep::Repeat)
            }
            (false, Some(_)) => {
                self.since = None;
                self.last = None;
                Some(AlertStep::Clear)
            }
            _ => None,
        }
    }
}

struct Lanes {
    stop_out: (PgPool, Arc<Semaphore>),
    touch: (PgPool, Arc<Semaphore>),
    prices: book::PriceSource,
    pricing: Option<Arc<market_data::pricing::PricingCache>>,
    callbacks: Callbacks,
    load: Arc<LiveLoad>,
    beat_pool: PgPool,
}

impl Lanes {
    /// One account: its queued fire, then every fire merged while it ran, one at a time, each in its own lane.
    async fn run_account(self: Arc<Self>, account_id: String) {
        loop {
            let Some((lane, moved)) = self.load.queued_lane(&account_id) else { break };
            let (pool, slots) = match lane {
                Lane::StopOut => &self.stop_out,
                Lane::Touch => &self.touch,
            };
            // wait for a slot of the lane, unless the queued fire moves to the stop-out lane meanwhile
            let permit = tokio::select! {
                p = Arc::clone(slots).acquire_owned() => p.expect("the lane semaphore is never closed"),
                _ = moved.notified() => continue,
            };
            let Some(fire) = self.load.start(&account_id, lane) else { continue };
            // the engine is alive and about to act: assert it BEFORE the evaluation reads who owns the account (after an idle
            // gap the heartbeat is stale and the account would read as the web's); at most one write a second
            crate::authority::touch(&self.beat_pool, Duration::from_secs(1)).await;
            let pending = fire.source == FireSource::Pending;
            let started = Instant::now();
            let task = book::with_book_sources(self.prices.clone(), self.pricing.clone(), monitor::evaluate_live_fire_owned(pool.clone(), fire));
            // its own task: a panic in the evaluation is reported here and never leaves the account stuck in the lanes
            let changed = match tokio::spawn(task).await {
                Ok(Ok(report)) => pending || report.is_some_and(|r| !r.closed.is_empty()),
                Ok(Err(err)) => {
                    tracing::warn!(%account_id, lane = lane.as_str(), %err, "live fire: evaluation failed (the pass will retry)");
                    true
                }
                Err(err) => {
                    tracing::error!(%account_id, lane = lane.as_str(), %err, "live fire: evaluation task panicked");
                    true
                }
            };
            drop(permit);
            if changed {
                (self.callbacks.after)();
            }
            if !self.load.finished(&account_id, started.elapsed()) {
                break;
            }
        }
        (self.callbacks.idle)(&account_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn at(s: i64) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp(1_800_000_000 + s, 0).unwrap()
    }

    fn fire(account: &str, source: FireSource, ticks: &[(&str, i64, i64)]) -> LiveFire {
        LiveFire {
            account_id: account.to_string(),
            ticks: ticks.iter().map(|(s, t, _)| (s.to_string(), (dec!(1), dec!(2), at(*t)))).collect(),
            received: ticks.iter().map(|(s, _, r)| (s.to_string(), at(*r))).collect(),
            source,
        }
    }

    /// A Notify with a stored permit is ready at the first poll.
    fn ready_now<F: std::future::Future>(f: std::pin::Pin<&mut F>) -> bool {
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        f.poll(&mut cx).is_ready()
    }

    #[test]
    fn a_merged_newer_tick_brings_its_own_receive_time() {
        let mut f = fire("a", FireSource::SlTp, &[("XAUUSD", 10, 11), ("EURUSD", 10, 11)]);
        merge_fire(&mut f, fire("a", FireSource::SlTp, &[("XAUUSD", 20, 21), ("EURUSD", 5, 6)]));
        assert_eq!(f.ticks["XAUUSD"].2, at(20), "the newer XAUUSD tick wins");
        assert_eq!(f.received["XAUUSD"], at(21), "with ITS receive time, not the first fire's");
        assert_eq!(f.ticks["EURUSD"].2, at(10), "an older EURUSD tick does not replace the newer one");
        assert_eq!(f.received["EURUSD"], at(11));
    }

    #[test]
    fn a_merged_margin_fire_makes_the_next_evaluation_a_stop_out_lane_one() {
        let mut f = fire("a", FireSource::SlTp, &[("XAUUSD", 10, 11)]);
        merge_fire(&mut f, fire("a", FireSource::Margin, &[("XAUUSD", 9, 10)]));
        assert_eq!(f.source, FireSource::Margin);
        assert_eq!(Lane::of(f.source), Lane::StopOut);
        merge_fire(&mut f, fire("a", FireSource::Pending, &[]));
        assert_eq!(f.source, FireSource::Margin, "a less urgent fire never downgrades it");
    }

    #[test]
    fn one_evaluation_per_account_and_the_fires_meanwhile_merge_into_the_next() {
        let load = LiveLoad::new();
        let t0 = Instant::now();
        assert_eq!(load.offer(fire("a", FireSource::SlTp, &[("XAUUSD", 1, 1)]), t0), Offered::Start, "idle account: starts");
        assert_eq!(load.offer(fire("b", FireSource::Margin, &[("XAUUSD", 1, 1)]), t0), Offered::Start, "another account is never held by it");
        assert!(load.start("a", Lane::Touch).is_some());
        assert!(load.start("b", Lane::StopOut).is_some());
        assert_eq!(load.offer(fire("a", FireSource::Margin, &[("XAUUSD", 2, 2)]), t0 + Duration::from_millis(100)), Offered::Merged, "merged behind a's run");
        assert_eq!(load.offer(fire("a", FireSource::SlTp, &[("XAUUSD", 3, 3)]), t0 + Duration::from_millis(200)), Offered::Merged);
        let r = load.reading(t0 + Duration::from_millis(1600));
        assert_eq!(r.touch.running, 1);
        assert_eq!(r.stop_out.running, 1);
        assert_eq!(r.stop_out.waiting, 1, "a's merged margin fire waits in the stop-out lane");
        assert_eq!(r.stop_out.oldest_wait_ms, 1500, "from the first merged fire's arrival");
        assert!(r.stop_out_stale());
        assert!(load.finished("a", Duration::from_millis(1500)), "the merged fire runs next");
        assert_eq!(load.queued_lane("a").map(|(l, _)| l), Some(Lane::StopOut));
        assert!(load.start("a", Lane::Touch).is_none(), "not from the touch lane");
        let next = load.start("a", Lane::StopOut).expect("from the stop-out lane");
        assert_eq!(next.source, FireSource::Margin);
        assert_eq!(next.ticks["XAUUSD"].2, at(3), "with the newest tick");
        assert!(!load.finished("b", Duration::from_millis(5)), "nothing merged: b leaves the lanes");
        assert!(!load.finished("a", Duration::from_millis(5)));
        let r = load.reading(t0 + Duration::from_secs(2));
        assert_eq!(r, Reading { evaluations: 3, max_evaluation_ms: 1500, ..Reading::default() }, "empty again");
    }

    #[test]
    fn a_margin_fire_merged_into_a_queued_touch_fire_moves_it_to_the_stop_out_lane() {
        let load = LiveLoad::new();
        let t0 = Instant::now();
        assert_eq!(load.offer(fire("a", FireSource::SlTp, &[("XAUUSD", 1, 1)]), t0), Offered::Start);
        let (lane, moved) = load.queued_lane("a").unwrap();
        assert_eq!(lane, Lane::Touch);
        assert_eq!(load.offer(fire("a", FireSource::Margin, &[("XAUUSD", 2, 2)]), t0), Offered::Merged);
        assert_eq!(load.queued_lane("a").map(|(l, _)| l), Some(Lane::StopOut), "the queued fire is now a stop-out one");
        let woke = moved.notified();
        tokio::pin!(woke);
        assert!(ready_now(woke.as_mut()), "its task is woken to wait for the stop-out lane instead");
        assert!(load.start("a", Lane::Touch).is_none(), "a touch slot can no longer start it");
        let f = load.start("a", Lane::StopOut).unwrap();
        assert_eq!(f.ticks["XAUUSD"].2, at(2));
        let r = load.reading(t0);
        assert_eq!((r.stop_out.running, r.touch.running), (1, 0));
    }

    #[test]
    fn the_header_says_stale_only_past_one_second() {
        let mut r = Reading::default();
        r.stop_out.oldest_wait_ms = 1000;
        assert!(r.header().starts_with("stopout=ok "));
        r.stop_out.oldest_wait_ms = 1001;
        assert!(r.header().starts_with("stopout=stale "));
        assert_eq!(Reading::default().header(), "stopout=ok waiting=0 running=0 oldest_ms=0; touch waiting=0 running=0 oldest_ms=0");
    }

    #[test]
    fn the_alert_is_raised_once_repeated_every_10_s_and_cleared_once() {
        let mut a = Alert::default();
        let mut stale = Reading::default();
        stale.stop_out.oldest_wait_ms = 1500;
        let t0 = Instant::now();
        assert_eq!(a.step(&Reading::default(), t0), None);
        assert_eq!(a.step(&stale, t0), Some(AlertStep::Raise));
        assert_eq!(a.step(&stale, t0 + Duration::from_secs(5)), None);
        assert_eq!(a.step(&stale, t0 + Duration::from_secs(10)), Some(AlertStep::Repeat));
        assert_eq!(a.step(&Reading::default(), t0 + Duration::from_secs(11)), Some(AlertStep::Clear));
        assert_eq!(a.step(&Reading::default(), t0 + Duration::from_secs(12)), None);
    }
}
