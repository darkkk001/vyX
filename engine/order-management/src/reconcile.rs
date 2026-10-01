//! Rust cutover Stage 5 reconciler (docs/RUST-CUTOVER-PLAN.md §5.3): pairs what the WEB really did with what the
//! shadow would have done, once a minute, and classifies every difference.
//!
//! Web side (read only, from the book database): the risk closes it booked (TRADE_PNL rows whose note is
//! "Stop loss hit (automatic)" / "Take profit hit (automatic)" / "Stop-out (automatic): ...") and its margin-call
//! notices (trader-facing MARGIN_CALL notifications; the web leaves no record when an account LEAVES a margin
//! call, so only the "in" edge can be paired). Read on a cursor (createdAt, id); nothing is written to the book.
//!
//! Shadow side: shadow_decision (shadow.rs), in the same LOCAL database this module writes its results to.
//!
//! Classes, per pair (table shadow_pair):
//! - MATCH: same position (or account, for a margin call), same kind, within 5 s;
//! - TIMING: same decision, further apart (skew recorded; a fan-in account is flagged "known", §4.11.5);
//! - SNAPSHOT: the sides differ, but the shadow's own level samples put the account at the edge (within 2 % of the
//!   threshold) around the web's moment: a price-timing difference, explained;
//! - PREEMPTED: the shadow would have closed a position the web closed for ANOTHER reason first (manual, dealer,
//!   coverage, mirror), explained;
//! - VALUE: same position, different decision (another kind, or the same close price with another P&L);
//! - ENGINE_ONLY / WEB_ONLY: one side acted and the other did not within the window.
//! Margin-call pairing (2026-09-26, the 12 ENGINE_ONLY margin_call_in rows of 2026-09-25 on 50005708, an account sitting
//! at its 100 % call level): both sides edge-detect independently and sample at different moments, so an account
//! flapping around the level produces a different number of "in" edges on each side. (1) A web notice pairs with the
//! NEAREST shadow edge in the window that no other notice has taken (it used to take the earliest, even one already
//! paired, and the second pair was silently dropped). (2) A shadow edge left alone is SNAPSHOT when the web sent a
//! margin-call notice for the account within the window. (3) It is also SNAPSHOT when the web's own record says the
//! account was still inside a margin-call episode then: the web notifies once per episode and, since 2026-09-26, writes
//! a MARGIN_CALL_CLEARED notification when it ends one -- a notice newer than the last clear before the edge is an
//! open episode. Before the first MARGIN_CALL_CLEARED row exists anywhere the episode cannot be known and (3) never
//! applies.
//! Overlapping episodes (2026-10-01, account 50005708 flapping across 100 % 11 times in 2.5 min; one web notice came
//! out WEB_ONLY): a web notice left without an edge of its own is explained (SNAPSHOT) when the SHADOW had the account
//! in a margin call around it -- (4) any shadow "in" edge within the window, even one another notice took, or (5) its
//! samples were in a call / crossed the call level within the window, or the sample closest to the level sat within
//! EDGE_PCT of it (it used to test the LOWEST sample, which an account bouncing 97-104 % never passes). A notice pairs
//! with its nearest unused edge only when it is also that edge's nearest notice (no cascade). And a lone
//! shadow edge is also explained when (6) the web CLEARED a margin call for the account within the window (the web
//! was in one there: the shadow saw a flap the web merged). Stop-out / SL / TP pairing is unchanged.
//!
//! VALUE / ENGINE_ONLY / WEB_ONLY are UNEXPLAINED: each resets the soak clock and is logged at ERROR with both sides.
//! The clock (2026-09-29, owner) is DERIVED, never overwritten: max(the soak start shadow_state.clock_started_at, the
//! newest unexplained pair NOT excused). The soak start is set on the first run; deleting the key starts a clean clock.
//! An excuse (shadow_excuse: pair, reason, who, when) lifts a known harness artifact's reset; ONLY the owner writes
//! it (the engine role has SELECT on that table and nothing else, deploy/shadow-store.sql), every excuse is logged
//! once by the reconciler, and deleting an excuse puts the reset back.
//!
//! Soak exit (user, 2026-09-24, widened 2026-09-25, counted per broker 2026-09-29): at least 30 risk actions paired
//! MATCH / TIMING SINCE THE CLOCK STARTED on REAL brokers (a "zz" test tenant such as the shadow bot's zzshadowbot is
//! reported apart and never counts; is_test_broker), 7 consecutive
//! days with no unexplained class, and inside that clean run the shadow was ALIVE through at least 2 weekend reopens
//! and 1 NFP window (see coverage_event: recorded while reconciling, so an engine that was down does not count). The daily summary goes to the log (primary) and to shadow_daily (for the backoffice page).

use crate::shadow::Recorder;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::str::FromStr;
use std::sync::Arc;

/// Beyond this apart, a web action and a shadow decision are not the same event.
pub const WINDOW_SECS: i64 = 60;
/// Within this, a pair is a MATCH (the web's per-tick trigger ~1-2 s, its backstop 5 s).
pub const MATCH_SECS: i64 = 5;
/// A level this close to the threshold (relative) makes a one-sided decision a price-timing difference.
const EDGE_PCT: &str = "0.02";

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS shadow_pair (
  id            BIGSERIAL PRIMARY KEY,
  class         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  position_id   TEXT,
  web_ref       TEXT UNIQUE,
  decision_key  TEXT UNIQUE,
  web_at        TIMESTAMPTZ,
  shadow_at     TIMESTAMPTZ,
  skew_ms       BIGINT,
  known_fan_in  BOOLEAN NOT NULL DEFAULT false,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shadow_pair_created ON shadow_pair (created_at);
CREATE TABLE IF NOT EXISTS shadow_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shadow_daily (
  day            DATE PRIMARY KEY,
  counts         JSONB NOT NULL,
  skew_p50_ms    BIGINT,
  skew_p95_ms    BIGINT,
  skew_max_ms    BIGINT,
  paired_total   BIGINT NOT NULL,
  clock_days     NUMERIC NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE shadow_daily ADD COLUMN IF NOT EXISTS weekend_opens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shadow_daily ADD COLUMN IF NOT EXISTS nfp_windows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shadow_daily ADD COLUMN IF NOT EXISTS exit_met BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shadow_pair ADD COLUMN IF NOT EXISTS broker TEXT;
CREATE TABLE IF NOT EXISTS shadow_excuse (
  pair_id     BIGINT PRIMARY KEY REFERENCES shadow_pair (id),
  reason      TEXT NOT NULL CHECK (length(btrim(reason)) >= 10),
  excused_by  TEXT NOT NULL CHECK (length(btrim(excused_by)) >= 2),
  excused_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE shadow_daily ADD COLUMN IF NOT EXISTS paired_real BIGINT NOT NULL DEFAULT 0;
ALTER TABLE shadow_daily ADD COLUMN IF NOT EXISTS paired_bot BIGINT NOT NULL DEFAULT 0;
ALTER TABLE shadow_daily ADD COLUMN IF NOT EXISTS paired_unknown BIGINT NOT NULL DEFAULT 0;
ALTER TABLE shadow_daily ADD COLUMN IF NOT EXISTS excused INTEGER NOT NULL DEFAULT 0;
"#;

/// Test tenants (the shadow bot's zzshadowbot, the seed tests' zz* tenants) start with this: their pairs are reported
/// apart and never count toward the soak exit's 30 real risk actions.
pub const TEST_BROKER_PREFIX: &str = "zz";
pub fn is_test_broker(subdomain: &str) -> bool {
    subdomain.starts_with(TEST_BROKER_PREFIX)
}

/// A market event the soak must live through (user exit gate, 2026-09-25), or None. Checked on every reconcile run;
/// the first sighting is recorded in shadow_state, so it only counts if the shadow was running during it.
/// - weekend reopen: the first hour after the weekly reopen, Sunday 17:00 New York = the shared market-week rule
///   (docs/contracts/market-week-vectors.json, lib/market-week.ts): 21:00-22:00 UTC during US daylight time, 22:00-23:00
///   UTC otherwise (owner, 2026-09-26: never a fixed 22:00);
/// - NFP: the first Friday of the month, 08:30 New York = 12:30 UTC in US daylight time, 13:30 UTC otherwise, and the
///   hour after it (the same us_eastern_is_dst).
pub fn coverage_event(now: DateTime<Utc>) -> Option<String> {
    use chrono::{Datelike, Timelike, Weekday};
    if now.weekday() == Weekday::Sun && now.hour() == crate::session::ny_close_hour_utc(now) {
        return Some(format!("weekend_open:{}", now.date_naive()));
    }
    if now.weekday() == Weekday::Fri && now.day() <= 7 {
        let start = if crate::session::us_eastern_is_dst(now) { 12 * 60 + 30 } else { 13 * 60 + 30 };
        let m = now.hour() * 60 + now.minute();
        if m >= start && m < start + 60 {
            return Some(format!("nfp:{}", now.date_naive()));
        }
    }
    None
}

/// Idle gate for the reconciler (2026-09-26, Neon load): whether a run -- which reads the book database (Neon) -- is
/// due. Pure, testable. A run is skipped only when ALL hold: the book's idle gate is closed (feed quiet, flat book or
/// no held symbol ticking: the web cannot act on a price, so no new risk action can appear), no shadow decision is
/// waiting to be paired, the gate has been closed longer than the catch-up (so a web action from just before the close,
/// readable only after the pairing window + settle time, was paired), and no coverage event (weekend reopen, NFP) is
/// on: the soak exit needs the shadow reconciling through those.
pub fn run_due(gate: market_data::activity::Gate, pending: bool, closed_for: Option<std::time::Duration>, catchup: std::time::Duration, in_coverage: bool) -> bool {
    in_coverage || gate == market_data::activity::Gate::Run || pending || closed_for.is_none_or(|c| c <= catchup)
}

/// The soak exit, in one place: 30 paired, 7 clean days, 2 weekend reopens and 1 NFP window lived through.
pub fn exit_met(paired: i64, clock_days: Decimal, weekend_opens: i64, nfp_windows: i64) -> bool {
    paired >= 30 && clock_days >= Decimal::new(7, 0) && weekend_opens >= 2 && nfp_windows >= 1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Match,
    Timing,
    Snapshot,
    Preempted,
    Value,
    EngineOnly,
    WebOnly,
}

impl Class {
    pub fn as_str(self) -> &'static str {
        match self {
            Class::Match => "MATCH",
            Class::Timing => "TIMING",
            Class::Snapshot => "SNAPSHOT",
            Class::Preempted => "PREEMPTED",
            Class::Value => "VALUE",
            Class::EngineOnly => "ENGINE_ONLY",
            Class::WebOnly => "WEB_ONLY",
        }
    }
    pub fn unexplained(self) -> bool {
        matches!(self, Class::Value | Class::EngineOnly | Class::WebOnly)
    }
}

/// The web's kind from its TRADE_PNL note (the notes are the web's and the engine's, byte for byte).
pub fn web_kind(note: &str) -> Option<&'static str> {
    if note.starts_with("Stop loss hit (automatic)") {
        Some("stop_loss")
    } else if note.starts_with("Take profit hit (automatic)") {
        Some("take_profit")
    } else if note.starts_with("Stop-out (automatic)") {
        Some("stop_out")
    } else {
        None
    }
}

/// "... margin level 95.52% ..." -> 95.52
pub fn level_in(text: &str) -> Option<Decimal> {
    let i = text.find("margin level ")? + "margin level ".len();
    let rest = text[i..].strip_prefix("is ").unwrap_or(&text[i..]); // the margin-call notice says "margin level is X%"
    let end = rest.find('%')?;
    Decimal::from_str(rest[..end].trim()).ok()
}

/// MATCH / TIMING from the time apart (either direction).
pub fn by_skew(skew_ms: i64) -> Class {
    if skew_ms.abs() <= MATCH_SECS * 1000 {
        Class::Match
    } else {
        Class::Timing
    }
}

/// A shadow decision close to its web counterpart: same kind -> MATCH / TIMING, unless the same close price
/// booked a different P&L (VALUE); another kind -> VALUE.
pub fn classify_pair(web_kind: &str, shadow_kind: &str, skew_ms: i64, web_price: Option<Decimal>, shadow_price: Option<Decimal>, web_pnl: Option<Decimal>, shadow_pnl: Option<Decimal>) -> Class {
    if web_kind != shadow_kind {
        return Class::Value;
    }
    if let (Some(wp), Some(sp), Some(wl), Some(sl)) = (web_price, shadow_price, web_pnl, shadow_pnl) {
        if wp == sp && (wl - sl).abs() > Decimal::new(1, 2) {
            return Class::Value;
        }
    }
    by_skew(skew_ms)
}

/// True when a level sat within EDGE_PCT of the threshold (either side): the two engines can disagree on price
/// timing alone.
pub fn at_edge(level: Decimal, threshold: Decimal) -> bool {
    let pct = Decimal::from_str(EDGE_PCT).unwrap();
    (level - threshold).abs() <= threshold * pct
}

pub struct Reconciler {
    book: PgPool,
    store: PgPool,
    recorder: Arc<Recorder>,
    /// pairing window (WINDOW_SECS in production; the load-harness gate runs for seconds, not minutes)
    window_secs: i64,
    /// a web row must be this old before it is read (its transaction and follow-ups settled)
    settle_secs: i64,
    /// account -> its broker's subdomain (read once from the book; None = not found)
    brokers: std::sync::Mutex<std::collections::HashMap<String, Option<String>>>,
}

#[derive(Debug, Default, Clone)]
pub struct RunReport {
    pub classified: Vec<(Class, String)>,
}

impl Reconciler {
    pub async fn new(book: PgPool, recorder: Arc<Recorder>) -> Result<Self, String> {
        let store = recorder.store().cloned().ok_or("reconciler needs the shadow store (local database)")?;
        crate::shadow::ensure_schema(&store, SCHEMA, &["shadow_pair", "shadow_state", "shadow_daily", "shadow_excuse"]).await?;
        // the 2026-09-29 columns must be there (the VPS engine role cannot add them: deploy/shadow-store.sql as postgres);
        // refusing here is loud ("shadow reconciler NOT running"), a missing column would silently drop every pair
        for probe in ["SELECT broker FROM shadow_pair LIMIT 0", "SELECT pair_id, reason, excused_by, excused_at FROM shadow_excuse LIMIT 0", "SELECT paired_real, paired_bot, paired_unknown, excused FROM shadow_daily LIMIT 0"] {
            if let Err(e) = sqlx::query(probe).execute(&store).await {
                return Err(format!("shadow store is missing the soak-gate columns ({e}): run deploy/shadow-store.sql as postgres"));
            }
        }
        Ok(Reconciler { book, store, recorder, window_secs: WINDOW_SECS, settle_secs: 5, brokers: Default::default() })
    }

    /// How long runs continue after the idle gate closes: the pairing window + the settle time + a margin + one run,
    /// so a web action from the last moment before the close is read and paired before the reconciler sleeps.
    pub fn catchup(&self, every: std::time::Duration) -> std::time::Duration {
        std::time::Duration::from_secs((self.window_secs + self.settle_secs + 5).max(0) as u64) + every
    }

    /// Is a shadow decision still waiting to be paired? Local store only (never the book). Decisions older than the
    /// pairing horizon (window + settle + margin + `extra`) that are still unpaired are ones step 3 deliberately leaves
    /// to the web side and will not change while the book is idle, so they do not keep the reconciler awake.
    pub async fn waiting_decisions(&self, extra: std::time::Duration) -> Result<bool, sqlx::Error> {
        let horizon = (self.window_secs + self.settle_secs + 5) as f64 + extra.as_secs_f64();
        let (any,): (bool,) = sqlx::query_as(
            r#"SELECT EXISTS (SELECT 1 FROM shadow_decision d LEFT JOIN shadow_pair p ON p.decision_key = d.dedupe_key
                              WHERE p.id IS NULL AND d.kind IN ('stop_loss','take_profit','stop_out','margin_call_in')
                                AND d.first_seen > now() - make_interval(secs => $1))"#,
        )
        .bind(horizon)
        .fetch_one(&self.store)
        .await?;
        Ok(any)
    }

    /// One timer tick of the gated loop: decides (run_due) and, when due, runs. `closed_for` = how long the idle gate has
    /// been closed (None while it is open). Returns None when the run was skipped: nothing was sent to the book pool.
    pub async fn tick(&self, gate: market_data::activity::Gate, closed_for: Option<std::time::Duration>, every: std::time::Duration, now: DateTime<Utc>) -> Result<Option<RunReport>, sqlx::Error> {
        let catchup = self.catchup(every);
        let in_coverage = coverage_event(now).is_some();
        let decided_without_store = in_coverage || gate == market_data::activity::Gate::Run || closed_for.is_none_or(|c| c <= catchup);
        let pending = if decided_without_store { false } else { self.waiting_decisions(every * 2).await.unwrap_or(true) };
        if !run_due(gate, pending, closed_for, catchup, in_coverage) {
            return Ok(None);
        }
        self.run_once().await.map(Some)
    }

    /// Shorter timings for the scratch gate (Stage 5 §5.5), where the whole run takes seconds.
    pub fn with_timing(mut self, window_secs: i64, settle_secs: i64) -> Self {
        self.window_secs = window_secs;
        self.settle_secs = settle_secs;
        self
    }

    async fn state(&self, key: &str) -> Option<String> {
        sqlx::query_as::<_, (String,)>("SELECT value FROM shadow_state WHERE key = $1").bind(key).fetch_optional(&self.store).await.ok().flatten().map(|r| r.0)
    }
    async fn set_state(&self, key: &str, value: &str) {
        let _ = sqlx::query("INSERT INTO shadow_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2").bind(key).bind(value).execute(&self.store).await;
    }

    /// The soak start (shadow_state.clock_started_at): set on the first run, or again after the owner deletes the key
    /// (a clean clock). Never moved by a pair.
    pub async fn soak_started_at(&self) -> DateTime<Utc> {
        match self.state("clock_started_at").await.and_then(|v| DateTime::parse_from_rfc3339(&v).ok()) {
            Some(t) => t.with_timezone(&Utc),
            None => {
                let now = Utc::now();
                self.set_state("clock_started_at", &now.to_rfc3339()).await;
                now
            }
        }
    }

    /// The soak clock: when the current run of clean days started = the soak start, or the newest unexplained pair that
    /// the owner has NOT excused, whichever is later. Derived on every read, so an excuse lifts a reset and deleting the
    /// excuse restores it.
    pub async fn clock_started_at(&self) -> DateTime<Utc> {
        let start = self.soak_started_at().await;
        let latest: Result<(Option<DateTime<Utc>>,), sqlx::Error> = sqlx::query_as(
            r#"SELECT max(p.created_at) FROM shadow_pair p
               WHERE p.class IN ('VALUE', 'ENGINE_ONLY', 'WEB_ONLY')
                 AND NOT EXISTS (SELECT 1 FROM shadow_excuse e WHERE e.pair_id = p.id)"#,
        )
        .fetch_one(&self.store)
        .await;
        match latest {
            Ok((Some(t),)) if t > start => t,
            Ok(_) => start,
            Err(err) => {
                tracing::warn!(%err, "shadow soak: could not read the unexplained pairs; clock = the soak start");
                start
            }
        }
    }

    /// The account's broker subdomain, read once from the book (the same read-only connection the shadow uses).
    async fn broker_of(&self, account_id: &str) -> Option<String> {
        if let Some(b) = self.brokers.lock().unwrap().get(account_id) {
            return b.clone();
        }
        let row: Result<Option<(String,)>, sqlx::Error> = sqlx::query_as(r#"SELECT b.subdomain FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" WHERE a.id = $1"#)
            .bind(account_id)
            .fetch_optional(&self.book)
            .await;
        match row {
            Ok(r) => {
                let b = r.map(|x| x.0);
                self.brokers.lock().unwrap().insert(account_id.to_string(), b.clone());
                b
            }
            Err(err) => {
                tracing::warn!(%err, account_id, "shadow reconcile: could not read the account's broker (pair stored without it)");
                None
            }
        }
    }

    /// Every excuse the owner has written that this reconciler has not announced yet: logged once each (WARN), with the
    /// pair it covers, so no excuse goes by unseen.
    async fn announce_excuses(&self) {
        let rows: Result<Vec<(i64, String, String, String, String, String, DateTime<Utc>)>, sqlx::Error> = sqlx::query_as(
            r#"SELECT e.pair_id, p.class, p.kind, p.account_id, e.reason, e.excused_by, e.excused_at
               FROM shadow_excuse e JOIN shadow_pair p ON p.id = e.pair_id
               WHERE NOT EXISTS (SELECT 1 FROM shadow_state s WHERE s.key = 'excuse_logged:' || e.pair_id)
               ORDER BY e.excused_at"#,
        )
        .fetch_all(&self.store)
        .await;
        match rows {
            Ok(rows) => {
                for (pair_id, class, kind, account_id, reason, excused_by, excused_at) in rows {
                    tracing::warn!(pair_id, class, kind, account_id, reason, excused_by, %excused_at, "shadow soak: pair EXCUSED by the owner, it no longer resets the clock");
                    self.set_state(&format!("excuse_logged:{pair_id}"), &Utc::now().to_rfc3339()).await;
                }
            }
            Err(err) => tracing::warn!(%err, "shadow soak: could not read the excuses"),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn write_pair(&self, class: Class, kind: &str, account_id: &str, position_id: Option<&str>, web_ref: Option<&str>, decision_key: Option<&str>,
        web_at: Option<DateTime<Utc>>, shadow_at: Option<DateTime<Utc>>, known_fan_in: bool, detail: serde_json::Value, report: &mut RunReport) {
        let skew = match (web_at, shadow_at) {
            (Some(w), Some(s)) => Some((w - s).num_milliseconds()),
            _ => None,
        };
        let broker = self.broker_of(account_id).await;
        let res = sqlx::query(
            r#"INSERT INTO shadow_pair (class, kind, account_id, position_id, web_ref, decision_key, web_at, shadow_at, skew_ms, known_fan_in, detail, broker)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING"#,
        )
        .bind(class.as_str()).bind(kind).bind(account_id).bind(position_id).bind(web_ref).bind(decision_key).bind(web_at).bind(shadow_at).bind(skew).bind(known_fan_in).bind(&detail).bind(&broker)
        .execute(&self.store)
        .await;
        match res {
            Ok(r) if r.rows_affected() == 1 => {
                report.classified.push((class, account_id.to_string()));
                if class.unexplained() {
                    // the pair itself resets the clock (clock_started_at is derived from it); a known harness artifact
                    // can be excused by the owner (shadow_excuse), never by the engine
                    tracing::error!(class = class.as_str(), kind, account_id, ?position_id, ?skew, ?broker, %detail, "shadow reconcile: UNEXPLAINED difference, soak clock reset");
                } else {
                    tracing::info!(class = class.as_str(), kind, account_id, ?position_id, ?skew, "shadow reconcile");
                }
            }
            Ok(_) => {}
            Err(err) => tracing::warn!(error = %err, "shadow reconcile: could not store a pair"),
        }
    }

    /// Mirror targets and coverage accounts: their closes wait for a fan-in follow-up (§4.11.5 ceiling).
    async fn fan_in(&self, account_id: &str) -> bool {
        sqlx::query_as::<_, (bool,)>(
            r#"SELECT EXISTS (SELECT 1 FROM "MirrorRule" WHERE "targetAccountId" = $1)
                   OR EXISTS (SELECT 1 FROM "Account" a JOIN "Group" g ON g.id = a."groupId" WHERE a.id = $1 AND g.category::text = 'COVERAGE')"#,
        )
        .bind(account_id).fetch_one(&self.book).await.map(|r| r.0).unwrap_or(false)
    }

    /// One run: new web actions since the cursor, then shadow decisions nobody paired within the window.
    pub async fn run_once(&self) -> Result<RunReport, sqlx::Error> {
        let mut report = RunReport::default();
        let window = ChronoDuration::seconds(self.window_secs);
        let settle = self.settle_secs as f64;
        self.soak_started_at().await;
        self.announce_excuses().await;
        if let Some(event) = coverage_event(Utc::now()) {
            let _ = sqlx::query("INSERT INTO shadow_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING")
                .bind(format!("event:{event}")).bind(Utc::now().to_rfc3339()).execute(&self.store).await;
        }

        // ---- 1. web risk closes since the cursor (settled: at least 5 s old) ----
        let cursor_at = self.state("web_close_cursor_at").await.and_then(|v| DateTime::parse_from_rfc3339(&v).ok()).map(|t| t.with_timezone(&Utc))
            .unwrap_or_else(|| Utc::now() - ChronoDuration::minutes(2));
        let cursor_id = self.state("web_close_cursor_id").await.unwrap_or_default();
        #[allow(clippy::type_complexity)]
        let closes: Vec<(String, String, String, String, DateTime<Utc>, Decimal, Option<Decimal>)> = sqlx::query_as(
            r#"SELECT t.id, t."accountId", t."referenceId", t.note, t."createdAt", t.amount, p."closePrice"
               FROM "Transaction" t LEFT JOIN "Position" p ON p.id = t."referenceId"
               WHERE t.type = 'TRADE_PNL' AND t."referenceType" = 'Position'
                 AND (t.note LIKE 'Stop loss hit (automatic)%' OR t.note LIKE 'Take profit hit (automatic)%' OR t.note LIKE 'Stop-out (automatic)%')
                 AND (t."createdAt", t.id) > ($1, $2) AND t."createdAt" < now() - make_interval(secs => $3)
               ORDER BY t."createdAt", t.id LIMIT 500"#,
        )
        .bind(cursor_at).bind(&cursor_id).bind(settle).fetch_all(&self.book).await?;
        for (txn, account, position, note, at, amount, close_price) in &closes {
            let Some(kind) = web_kind(note) else { continue };
            let decision: Option<(String, String, DateTime<Utc>, Option<Decimal>, Option<Decimal>)> = sqlx::query_as(
                "SELECT dedupe_key, kind, first_seen, close_price, pnl FROM shadow_decision WHERE position_id = $1 AND kind IN ('stop_loss','take_profit','stop_out') ORDER BY first_seen LIMIT 1",
            )
            .bind(position).fetch_optional(&self.store).await?;
            let fan = self.fan_in(account).await;
            match decision {
                Some((key, skind, first, sprice, spnl)) if (*at - first).num_seconds().abs() <= self.window_secs || skind != kind => {
                    let class = classify_pair(kind, &skind, (*at - first).num_milliseconds(), *close_price, sprice, Some(*amount), spnl);
                    let detail = serde_json::json!({ "webNote": note, "webPrice": close_price, "webPnl": amount, "shadowKind": skind, "shadowPrice": sprice, "shadowPnl": spnl });
                    self.write_pair(class, kind, account, Some(position), Some(txn), Some(&key), Some(*at), Some(first), fan, detail, &mut report).await;
                }
                other => {
                    // no shadow decision in the window: price timing at the edge, or a real miss
                    let near = if kind == "stop_out" {
                        let web_level = level_in(note);
                        self.recorder.min_level_around(account, *at, window).map(|(lvl, so)| at_edge(lvl, so) || web_level.is_some_and(|w| at_edge(w, so))).unwrap_or(false)
                    } else {
                        false
                    };
                    let evaluated = self.recorder.sampled_around(account, *at, window);
                    let class = if near { Class::Snapshot } else { Class::WebOnly };
                    let samples: Vec<serde_json::Value> = self.recorder.samples_around(account, *at, window).into_iter()
                        .map(|(ms, level, so)| serde_json::json!({ "ms": ms, "level": level, "stopOut": so })).collect();
                    let detail = serde_json::json!({ "webNote": note, "webPrice": close_price, "webPnl": amount, "shadowEvaluatedAccountAround": evaluated, "lateShadowDecision": other.map(|o| o.0), "shadowSamples": samples });
                    self.write_pair(class, kind, account, Some(position), Some(txn), None, Some(*at), None, fan, detail, &mut report).await;
                }
            }
        }
        if let Some(last) = closes.last() {
            self.set_state("web_close_cursor_at", &last.4.to_rfc3339()).await;
            self.set_state("web_close_cursor_id", &last.0).await;
        }

        // ---- 2. web margin-call notices (trader copy) since their cursor ----
        let mc_at = self.state("web_mc_cursor_at").await.and_then(|v| DateTime::parse_from_rfc3339(&v).ok()).map(|t| t.with_timezone(&Utc))
            .unwrap_or_else(|| Utc::now() - ChronoDuration::minutes(2));
        let mc_id = self.state("web_mc_cursor_id").await.unwrap_or_default();
        let notices: Vec<(String, String, DateTime<Utc>, String)> = sqlx::query_as(
            r#"SELECT id, "accountId", "createdAt", body FROM "Notification"
               WHERE type = 'MARGIN_CALL' AND "accountId" IS NOT NULL AND ("createdAt", id) > ($1, $2) AND "createdAt" < now() - make_interval(secs => $3)
               ORDER BY "createdAt", id LIMIT 500"#,
        )
        .bind(mc_at).bind(&mc_id).bind(settle).fetch_all(&self.book).await?;
        for (nid, account, at, body) in &notices {
            // (1) the NEAREST edge in the window that no earlier notice has taken
            let decision: Option<(String, DateTime<Utc>)> = sqlx::query_as(
                r#"SELECT d.dedupe_key, d.first_seen FROM shadow_decision d
                   WHERE d.kind = 'margin_call_in' AND d.account_id = $1 AND d.first_seen BETWEEN $2 AND $3
                     AND NOT EXISTS (SELECT 1 FROM shadow_pair p WHERE p.decision_key = d.dedupe_key)
                   ORDER BY abs(extract(epoch FROM (d.first_seen - $4))), d.first_seen LIMIT 1"#,
            )
            .bind(account).bind(*at - window).bind(*at + window).bind(*at).fetch_optional(&self.store).await?;
            // ... and only when THIS notice is that edge's nearest web notice (2026-10-01): with the two sides counting a
            // flapping account's episodes differently, "nearest unused" alone cascades (each notice takes the next
            // episode's edge, 50 s apart). A notice whose nearest edge belongs to another notice is left to the
            // overlapping-episode rule below.
            let decision = match decision {
                Some((key, first)) => {
                    let (nearest,): (Option<String>,) = sqlx::query_as(
                        r#"SELECT id FROM "Notification" WHERE type = 'MARGIN_CALL' AND "accountId" = $1 AND "createdAt" BETWEEN $2 AND $3
                           ORDER BY abs(extract(epoch FROM ("createdAt" - $4))), "createdAt" LIMIT 1"#,
                    )
                    .bind(account).bind(first - window).bind(first + window).bind(first).fetch_optional(&self.book).await?.unwrap_or((None,));
                    if nearest.as_deref().is_none_or(|n| n == nid) { Some((key, first)) } else { None }
                }
                None => None,
            };
            let fan = self.fan_in(account).await;
            match decision {
                Some((key, first)) => {
                    let class = by_skew((*at - first).num_milliseconds());
                    self.write_pair(class, "margin_call_in", account, None, Some(nid), Some(&key), Some(*at), Some(first), fan, serde_json::json!({ "webBody": body }), &mut report).await;
                }
                None => {
                    // (4) the shadow had its own episode here (an edge another notice already took counts too)
                    let overlapping: Option<(String, DateTime<Utc>)> = sqlx::query_as(
                        r#"SELECT d.dedupe_key, d.first_seen FROM shadow_decision d
                           WHERE d.kind = 'margin_call_in' AND d.account_id = $1 AND d.first_seen BETWEEN $2 AND $3
                           ORDER BY abs(extract(epoch FROM (d.first_seen - $4))) LIMIT 1"#,
                    )
                    .bind(account).bind(*at - window).bind(*at + window).bind(*at).fetch_optional(&self.store).await?;
                    // (5) its samples were in a call / crossed the level / sat at it
                    let ev = self.recorder.call_evidence_around(account, *at, window);
                    let samples_explain = ev.is_some_and(|e| e.any_in || at_edge(e.closest.0, e.closest.1));
                    let body_at_edge = level_in(body).zip(self.recorder.call_level(account)).is_some_and(|(w, c)| at_edge(w, c));
                    let reason = if let Some((k, t)) = &overlapping {
                        Some(serde_json::json!({ "reason": "overlapping shadow margin-call episode", "shadowEdge": k, "shadowAt": t }))
                    } else if samples_explain {
                        let e = ev.unwrap();
                        Some(serde_json::json!({ "reason": if e.crossed() { "shadow samples crossed the call level" } else if e.any_in { "shadow samples in a margin call" } else { "shadow samples at the call level" },
                            "closestLevel": e.closest.0.round_dp(2), "callLevel": e.closest.1 }))
                    } else if body_at_edge {
                        Some(serde_json::json!({ "reason": "web level at the call level" }))
                    } else {
                        None
                    };
                    let class = if reason.is_some() { Class::Snapshot } else { Class::WebOnly };
                    let samples: Vec<serde_json::Value> = self.recorder.samples_around(account, *at, window).into_iter()
                        .map(|(ms, level, _)| serde_json::json!({ "ms": ms, "level": level })).collect();
                    let mut detail = serde_json::json!({ "webBody": body, "shadowSamples": samples });
                    if let Some(r) = reason {
                        detail["shadow"] = r;
                    }
                    self.write_pair(class, "margin_call_in", account, None, Some(nid), None, Some(*at), None, fan, detail, &mut report).await;
                }
            }
        }
        if let Some(last) = notices.last() {
            self.set_state("web_mc_cursor_at", &last.2.to_rfc3339()).await;
            self.set_state("web_mc_cursor_id", &last.0).await;
        }

        // ---- 3. shadow decisions the web never matched, once the window (plus settle time) has passed ----
        #[allow(clippy::type_complexity)]
        let lonely: Vec<(String, String, String, Option<String>, DateTime<Utc>, Option<Decimal>)> = sqlx::query_as(
            r#"SELECT d.dedupe_key, d.kind, d.account_id, d.position_id, d.first_seen, d.level FROM shadow_decision d
               LEFT JOIN shadow_pair p ON p.decision_key = d.dedupe_key
               WHERE p.id IS NULL AND d.kind IN ('stop_loss','take_profit','stop_out','margin_call_in') AND d.first_seen < now() - make_interval(secs => $1)
               ORDER BY d.first_seen LIMIT 500"#,
        )
        .bind((self.window_secs + self.settle_secs + 5) as f64).fetch_all(&self.store).await?;
        for (key, kind, account, position, first, level) in &lonely {
            let fan = self.fan_in(account).await;
            if let Some(pos) = position {
                // how the position actually ended (or not)
                let row: Option<(String, Option<DateTime<Utc>>, Option<String>)> = sqlx::query_as(
                    r#"SELECT p.status::text, p."closedAt", t.note FROM "Position" p
                       LEFT JOIN LATERAL (SELECT note FROM "Transaction" WHERE "referenceType" = 'Position' AND "referenceId" = p.id AND type = 'TRADE_PNL' ORDER BY "createdAt" DESC LIMIT 1) t ON true
                       WHERE p.id = $1"#,
                )
                .bind(pos).fetch_optional(&self.book).await?;
                let (class, detail) = match row {
                    Some((status, closed_at, note)) if status == "CLOSED" => {
                        match note.as_deref().and_then(web_kind) {
                            // closed by a web risk action: it was, or will be, paired from the web side
                            Some(_) => continue,
                            None => (Class::Preempted, serde_json::json!({ "webClosedAt": closed_at, "webNote": note })),
                        }
                    }
                    Some((status, _, _)) => {
                        let near = kind == "stop_out" && level.zip(self.recorder.stop_out_level(account)).is_some_and(|(l, so)| at_edge(l, so));
                        (if near { Class::Snapshot } else { Class::EngineOnly }, serde_json::json!({ "positionStatus": status, "shadowLevel": level }))
                    }
                    None => (Class::Preempted, serde_json::json!({ "position": "gone" })),
                };
                self.write_pair(class, kind, account, Some(pos), None, Some(key), None, Some(*first), fan, detail, &mut report).await;
            } else {
                let near = level.zip(self.recorder.call_level(account)).is_some_and(|(l, c)| at_edge(l, c));
                let web = if kind == "margin_call_in" && !near { self.web_margin_call_evidence(account, *first, window).await? } else { None };
                let class = if near || web.is_some() { Class::Snapshot } else { Class::EngineOnly };
                let mut detail = serde_json::json!({ "shadowLevel": level });
                if let Some(w) = web {
                    detail["web"] = w;
                }
                self.write_pair(class, kind, account, None, None, Some(key), None, Some(*first), fan, detail, &mut report).await;
            }
        }
        Ok(report)
    }

    /// Why a lone shadow margin-call "in" edge at `at` is explained by the web's own record, if it is (see the module
    /// doc): (2) the web sent a margin-call notice for the account within the window, or (3) the account was still inside
    /// a web margin-call episode then (its last notice before `at` is newer than its last MARGIN_CALL_CLEARED, and the
    /// web was already writing clears when that notice was sent).
    async fn web_margin_call_evidence(&self, account: &str, at: DateTime<Utc>, window: ChronoDuration) -> Result<Option<serde_json::Value>, sqlx::Error> {
        let near: Option<(String, DateTime<Utc>)> = sqlx::query_as(
            r#"SELECT id, "createdAt" FROM "Notification" WHERE type = 'MARGIN_CALL' AND "accountId" = $1 AND "createdAt" BETWEEN $2 AND $3
               ORDER BY abs(extract(epoch FROM ("createdAt" - $4))) LIMIT 1"#,
        )
        .bind(account).bind(at - window).bind(at + window).bind(at).fetch_optional(&self.book).await?;
        if let Some((id, when)) = near {
            return Ok(Some(serde_json::json!({ "reason": "web margin-call notice within the window", "webNotice": id, "webAt": when })));
        }
        // (6) the web LEFT a margin call within the window: it was in one there, and merged the shadow's flap
        let cleared: Option<(String, DateTime<Utc>)> = sqlx::query_as(
            r#"SELECT id, "createdAt" FROM "Notification" WHERE type = 'MARGIN_CALL_CLEARED' AND "accountId" = $1 AND "createdAt" BETWEEN $2 AND $3
               ORDER BY abs(extract(epoch FROM ("createdAt" - $4))) LIMIT 1"#,
        )
        .bind(account).bind(at - window).bind(at + window).bind(at).fetch_optional(&self.book).await?;
        if let Some((id, when)) = cleared {
            return Ok(Some(serde_json::json!({ "reason": "web left a margin call within the window", "webNotice": id, "webAt": when })));
        }
        let (tracking_since,): (Option<DateTime<Utc>>,) =
            sqlx::query_as(r#"SELECT min("createdAt") FROM "Notification" WHERE type = 'MARGIN_CALL_CLEARED'"#).fetch_one(&self.book).await?;
        let Some(tracking_since) = tracking_since else { return Ok(None) };
        let last_call: Option<(String, DateTime<Utc>)> = sqlx::query_as(
            r#"SELECT id, "createdAt" FROM "Notification" WHERE type = 'MARGIN_CALL' AND "accountId" = $1 AND "createdAt" <= $2 ORDER BY "createdAt" DESC LIMIT 1"#,
        )
        .bind(account).bind(at).fetch_optional(&self.book).await?;
        let Some((call_id, call_at)) = last_call else { return Ok(None) };
        if call_at < tracking_since {
            return Ok(None); // the episode began before the web recorded clears: unknown, not assumed open
        }
        let (last_clear,): (Option<DateTime<Utc>>,) = sqlx::query_as(
            r#"SELECT max("createdAt") FROM "Notification" WHERE type = 'MARGIN_CALL_CLEARED' AND "accountId" = $1 AND "createdAt" <= $2"#,
        )
        .bind(account).bind(at).fetch_one(&self.book).await?;
        if last_clear.is_some_and(|c| c >= call_at) {
            return Ok(None); // the web had closed that episode: the shadow's edge is a new one the web did not see
        }
        Ok(Some(serde_json::json!({ "reason": "inside an open web margin-call episode", "webEpisodeStart": call_at, "webNotice": call_id })))
    }

    /// The day's summary (UTC day): counts per class, skew p50 / p95 / max of the paired ones, the running total of
    /// real risk actions paired MATCH / TIMING, and the soak clock in days. Logged, and stored in shadow_daily.
    pub async fn summarize(&self, day: chrono::NaiveDate) -> Result<serde_json::Value, sqlx::Error> {
        let counts: Vec<(String, i64)> = sqlx::query_as("SELECT class, count(*) FROM shadow_pair WHERE created_at::date = $1 GROUP BY class ORDER BY class")
            .bind(day).fetch_all(&self.store).await?;
        let skews: Vec<(i64,)> = sqlx::query_as("SELECT abs(skew_ms) FROM shadow_pair WHERE created_at::date = $1 AND skew_ms IS NOT NULL ORDER BY 1")
            .bind(day).fetch_all(&self.store).await?;
        let pct = |p: f64| skews.get(((skews.len() as f64 - 1.0) * p).round() as usize).map(|r| r.0);
        let (paired,): (i64,) = sqlx::query_as("SELECT count(*) FROM shadow_pair WHERE class IN ('MATCH','TIMING')").fetch_one(&self.store).await?;
        let clock_start = self.clock_started_at().await;
        // the exit counts risk actions paired SINCE THE CLOCK STARTED, on real brokers only (test tenants apart)
        let by_origin: Vec<(String, i64)> = sqlx::query_as(
            r#"SELECT CASE WHEN broker IS NULL THEN 'unknown' WHEN starts_with(broker, $2) THEN 'bot' ELSE 'real' END, count(*)
               FROM shadow_pair WHERE class IN ('MATCH','TIMING') AND created_at >= $1 GROUP BY 1"#,
        )
        .bind(clock_start).bind(TEST_BROKER_PREFIX).fetch_all(&self.store).await?;
        let origin = |o: &str| by_origin.iter().find(|r| r.0 == o).map(|r| r.1).unwrap_or(0);
        let (paired_real, paired_bot, paired_unknown) = (origin("real"), origin("bot"), origin("unknown"));
        let (excused,): (i64,) = sqlx::query_as("SELECT count(*) FROM shadow_excuse").fetch_one(&self.store).await?;
        let clock = Utc::now() - clock_start;
        let clock_days = Decimal::new(clock.num_minutes(), 0) / Decimal::new(1440, 0);
        // coverage events lived through inside the CURRENT clean run (a reset clock drops the earlier ones)
        let events: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM shadow_state WHERE key LIKE 'event:%'").fetch_all(&self.store).await?;
        let in_run = |prefix: &str| {
            events.iter().filter(|(k, v)| k.starts_with(prefix) && DateTime::parse_from_rfc3339(v).map(|t| t.with_timezone(&Utc) >= clock_start).unwrap_or(false)).count() as i64
        };
        let (weekend_opens, nfp_windows) = (in_run("event:weekend_open:"), in_run("event:nfp:"));
        let exit = exit_met(paired_real, clock_days, weekend_opens, nfp_windows);
        let counts_json: serde_json::Map<String, serde_json::Value> = counts.iter().map(|(c, n)| (c.clone(), serde_json::json!(n))).collect();
        let summary = serde_json::json!({
            "day": day.to_string(), "counts": counts_json, "skewP50Ms": pct(0.5), "skewP95Ms": pct(0.95), "skewMaxMs": skews.last().map(|r| r.0),
            "pairedTotal": paired, "pairedReal": paired_real, "pairedBot": paired_bot, "pairedUnknown": paired_unknown, "excused": excused,
            "clockStartedAt": clock_start.to_rfc3339(), "clockDays": clock_days.round_dp(2).to_string(), "weekendOpens": weekend_opens, "nfpWindows": nfp_windows,
            "exitMet": exit,
        });
        let _ = sqlx::query(
            r#"INSERT INTO shadow_daily (day, counts, skew_p50_ms, skew_p95_ms, skew_max_ms, paired_total, clock_days, weekend_opens, nfp_windows, exit_met, paired_real, paired_bot, paired_unknown, excused)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
               ON CONFLICT (day) DO UPDATE SET counts = $2, skew_p50_ms = $3, skew_p95_ms = $4, skew_max_ms = $5, paired_total = $6, clock_days = $7, weekend_opens = $8, nfp_windows = $9, exit_met = $10,
                 paired_real = $11, paired_bot = $12, paired_unknown = $13, excused = $14, created_at = now()"#,
        )
        .bind(day).bind(serde_json::Value::Object(counts_json)).bind(pct(0.5)).bind(pct(0.95)).bind(skews.last().map(|r| r.0)).bind(paired).bind(clock_days.round_dp(2))
        .bind(weekend_opens as i32).bind(nfp_windows as i32).bind(exit).bind(paired_real).bind(paired_bot).bind(paired_unknown).bind(excused as i32)
        .execute(&self.store).await;
        tracing::info!(summary = %summary, "shadow daily summary");
        Ok(summary)
    }
}

/// Every `every`: one reconcile run; after each UTC midnight, the previous day's summary.
/// The reconciler loop. `gate` (the shadow pass's own idle-gate inputs: tick cache + margin-trigger book) lets runs sleep
/// while the book cannot move (run_due); None = run every tick, as before. The daily summary reads the local store only
/// and keeps its schedule either way.
pub fn spawn(reconciler: Reconciler, every: std::time::Duration, gate: Option<crate::monitor::ShadowGate>) {
    tokio::spawn(async move {
        static LOG: market_data::activity::GateLog = market_data::activity::GateLog::new("reconciler");
        let mut ticker = tokio::time::interval(every);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last_day = Utc::now().date_naive();
        let mut closed_since: Option<std::time::Instant> = None;
        loop {
            ticker.tick().await;
            let g = gate.as_ref().map(|g| g.gate()).unwrap_or(market_data::activity::Gate::Run);
            if g == market_data::activity::Gate::Run {
                closed_since = None;
            } else if closed_since.is_none() {
                closed_since = Some(std::time::Instant::now());
            }
            match reconciler.tick(g, closed_since.map(|t| t.elapsed()), every, Utc::now()).await {
                Ok(Some(_)) => {
                    LOG.observe(market_data::activity::Gate::Run);
                }
                Ok(None) => {
                    LOG.observe(g);
                }
                Err(err) => tracing::warn!(error = %err, "shadow reconcile run failed"),
            }
            let today = Utc::now().date_naive();
            if today != last_day {
                let _ = reconciler.summarize(last_day).await;
                last_day = today;
            }
        }
    });
}

#[cfg(test)]
mod exit_gate_tests {
    use super::*;
    use chrono::TimeZone;
    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> { Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap() }

    #[test]
    fn weekend_reopen_follows_the_shared_market_week_rule() {
        // summer Sunday (EDT): reopen 21:00 UTC -> the window is 21:00-21:59
        assert_eq!(coverage_event(at(2026, 9, 27, 20, 59)), None);
        assert_eq!(coverage_event(at(2026, 9, 27, 21, 0)).as_deref(), Some("weekend_open:2026-09-27"));
        assert_eq!(coverage_event(at(2026, 9, 27, 21, 59)).as_deref(), Some("weekend_open:2026-09-27"));
        assert_eq!(coverage_event(at(2026, 9, 27, 22, 0)), None);
        // clock-change Sunday 2026-11-01 (EST since 06:00 UTC): reopen 22:00 UTC
        assert_eq!(coverage_event(at(2026, 11, 1, 21, 0)), None);
        assert_eq!(coverage_event(at(2026, 11, 1, 22, 0)).as_deref(), Some("weekend_open:2026-11-01"));
        // winter Sunday: 22:00-22:59
        assert_eq!(coverage_event(at(2026, 11, 8, 22, 0)).as_deref(), Some("weekend_open:2026-11-08"));
        assert_eq!(coverage_event(at(2026, 11, 8, 22, 59)).as_deref(), Some("weekend_open:2026-11-08"));
        assert_eq!(coverage_event(at(2026, 11, 8, 23, 0)), None);
        assert_eq!(coverage_event(at(2026, 11, 8, 21, 30)), None);
        // spring clock-change Sunday 2027-03-14 (EDT since 07:00 UTC): 21:00 UTC
        assert_eq!(coverage_event(at(2027, 3, 14, 21, 0)).as_deref(), Some("weekend_open:2027-03-14"));
        assert_eq!(coverage_event(at(2027, 3, 14, 22, 0)), None);
    }

    /// Against docs/contracts/market-week-vectors.json: every Sunday case that is still closed is no reopen event, every
    /// Sunday case at or after the reopen (all within its first hour in the file) is one.
    #[test]
    fn weekend_reopen_matches_the_market_week_vectors() {
        use chrono::{Datelike, Weekday};
        let file: serde_json::Value = serde_json::from_str(include_str!("../../../docs/contracts/market-week-vectors.json")).unwrap();
        let mut sundays = 0;
        for c in file["cases"].as_array().unwrap() {
            let t: DateTime<Utc> = c["utc"].as_str().unwrap().parse().unwrap();
            if t.weekday() != Weekday::Sun {
                continue;
            }
            sundays += 1;
            let closed = c["closed"].as_bool().unwrap();
            let ev = coverage_event(t);
            if closed {
                assert!(!ev.as_deref().unwrap_or("").starts_with("weekend_open"), "{} ({}): closed, no reopen yet", c["utc"], c["why"]);
            } else {
                assert_eq!(ev, Some(format!("weekend_open:{}", t.date_naive())), "{} ({})", c["utc"], c["why"]);
            }
        }
        assert!(sundays >= 8, "the vectors cover the Sunday reopen in both seasons and both clock changes");
    }

    #[test]
    fn a_run_is_skipped_only_when_the_book_is_idle_nothing_waits_and_the_catch_up_is_done() {
        use market_data::activity::Gate;
        use std::time::Duration as D;
        let catchup = D::from_secs(130);
        // idle, nothing waiting, closed well past the catch-up: skip
        assert!(!run_due(Gate::BookClosed, false, Some(D::from_secs(600)), catchup, false));
        assert!(!run_due(Gate::FeedQuiet, false, Some(D::from_secs(600)), catchup, false));
        assert!(!run_due(Gate::FlatBook, false, Some(D::from_secs(600)), catchup, false));
        // a decision waiting to be paired: run
        assert!(run_due(Gate::BookClosed, true, Some(D::from_secs(600)), catchup, false));
        // inside the catch-up after the close: run
        assert!(run_due(Gate::BookClosed, false, Some(D::from_secs(60)), catchup, false));
        assert!(run_due(Gate::BookClosed, false, None, catchup, false));
        // the book can move: run
        assert!(run_due(Gate::Run, false, None, catchup, false));
        // a coverage window (weekend reopen / NFP): run even with the gate closed and nothing waiting
        assert!(run_due(Gate::FeedQuiet, false, Some(D::from_secs(3600)), catchup, true));
    }

    #[test]
    fn nfp_is_the_first_friday_0830_new_york() {
        // 2026-10-02 (first Friday, US daylight time): 12:30-13:30 UTC
        assert_eq!(coverage_event(at(2026, 10, 2, 12, 30)).as_deref(), Some("nfp:2026-10-02"));
        assert_eq!(coverage_event(at(2026, 10, 2, 13, 29)).as_deref(), Some("nfp:2026-10-02"));
        assert_eq!(coverage_event(at(2026, 10, 2, 12, 29)), None);
        assert_eq!(coverage_event(at(2026, 10, 9, 12, 45)), None); // second Friday
        // 2026-12-04 (standard time): 13:30-14:30 UTC
        assert_eq!(coverage_event(at(2026, 12, 4, 12, 45)), None);
        assert_eq!(coverage_event(at(2026, 12, 4, 13, 45)).as_deref(), Some("nfp:2026-12-04"));
    }

    #[test]
    fn exit_needs_all_four() {
        let d = |n: i64| Decimal::new(n, 0);
        assert!(exit_met(30, d(7), 2, 1));
        assert!(!exit_met(29, d(7), 2, 1));
        assert!(!exit_met(30, d(6), 2, 1));
        assert!(!exit_met(30, d(7), 1, 1));
        assert!(!exit_met(30, d(7), 2, 0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn web_notes_map_to_kinds_and_other_closes_do_not() {
        assert_eq!(web_kind("Stop-out (automatic): margin level 95.52% at or below 99%"), Some("stop_out"));
        assert_eq!(web_kind("Stop loss hit (automatic)"), Some("stop_loss"));
        assert_eq!(web_kind("Take profit hit (automatic)"), Some("take_profit"));
        assert_eq!(web_kind("Manual close by admin @ 4367.43"), None);
        assert_eq!(web_kind("Coverage auto-close: client #100002073 closed 0.01 of 0.01"), None);
    }

    #[test]
    fn the_level_is_read_from_the_web_note_and_notice() {
        assert_eq!(level_in("Stop-out (automatic): margin level 95.52% at or below 99%"), Some(dec!(95.52)));
        assert_eq!(level_in("Account 50005708's margin level is 82.47%, at or below the 100% margin-call level."), Some(dec!(82.47)));
        assert_eq!(level_in("x margin level 7%"), Some(dec!(7)));
    }

    #[test]
    fn pairs_classify_by_kind_price_and_time() {
        assert_eq!(classify_pair("stop_out", "stop_out", 1_200, None, None, None, None), Class::Match);
        assert_eq!(classify_pair("stop_out", "stop_out", -4_900, None, None, None, None), Class::Match);
        assert_eq!(classify_pair("stop_out", "stop_out", 30_000, None, None, None, None), Class::Timing);
        assert_eq!(classify_pair("stop_out", "stop_loss", 100, None, None, None, None), Class::Value);
        // same price, different P&L: a real difference
        assert_eq!(classify_pair("stop_out", "stop_out", 100, Some(dec!(4280)), Some(dec!(4280)), Some(dec!(-9.34)), Some(dec!(-9.30))), Class::Value);
        // different price (the sides saw different ticks): P&L differs naturally
        assert_eq!(classify_pair("stop_out", "stop_out", 100, Some(dec!(4280)), Some(dec!(4281)), Some(dec!(-9.34)), Some(dec!(-8.34))), Class::Match);
        assert!(Class::Value.unexplained() && Class::EngineOnly.unexplained() && Class::WebOnly.unexplained());
        assert!(!Class::Snapshot.unexplained() && !Class::Preempted.unexplained() && !Class::Timing.unexplained());
    }

    #[test]
    fn the_edge_is_two_percent_of_the_threshold_either_side() {
        assert!(at_edge(dec!(99.5), dec!(99)));
        assert!(at_edge(dec!(97.1), dec!(99)));
        assert!(!at_edge(dec!(96), dec!(99)));
        assert!(!at_edge(dec!(102), dec!(99)));
    }
}
