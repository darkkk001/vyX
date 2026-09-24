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
//! VALUE / ENGINE_ONLY / WEB_ONLY are UNEXPLAINED: each resets the soak clock (shadow_state.clock_started_at) and is
//! logged at ERROR with both sides.
//!
//! Soak exit (user, 2026-09-24): at least 30 real risk actions paired MATCH / TIMING, and 7 consecutive days with no
//! unexplained class. The daily summary goes to the log (primary) and to shadow_daily (for the backoffice page).

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
"#;

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
}

#[derive(Debug, Default, Clone)]
pub struct RunReport {
    pub classified: Vec<(Class, String)>,
}

impl Reconciler {
    pub async fn new(book: PgPool, recorder: Arc<Recorder>) -> Result<Self, String> {
        let store = recorder.store().cloned().ok_or("reconciler needs the shadow store (local database)")?;
        crate::shadow::ensure_schema(&store, SCHEMA, &["shadow_pair", "shadow_state", "shadow_daily"]).await?;
        Ok(Reconciler { book, store, recorder, window_secs: WINDOW_SECS, settle_secs: 5 })
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

    /// The soak clock: when the current run of clean days started (set on first run, reset by an unexplained class).
    pub async fn clock_started_at(&self) -> DateTime<Utc> {
        match self.state("clock_started_at").await.and_then(|v| DateTime::parse_from_rfc3339(&v).ok()) {
            Some(t) => t.with_timezone(&Utc),
            None => {
                let now = Utc::now();
                self.set_state("clock_started_at", &now.to_rfc3339()).await;
                now
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn write_pair(&self, class: Class, kind: &str, account_id: &str, position_id: Option<&str>, web_ref: Option<&str>, decision_key: Option<&str>,
        web_at: Option<DateTime<Utc>>, shadow_at: Option<DateTime<Utc>>, known_fan_in: bool, detail: serde_json::Value, report: &mut RunReport) {
        let skew = match (web_at, shadow_at) {
            (Some(w), Some(s)) => Some((w - s).num_milliseconds()),
            _ => None,
        };
        let res = sqlx::query(
            r#"INSERT INTO shadow_pair (class, kind, account_id, position_id, web_ref, decision_key, web_at, shadow_at, skew_ms, known_fan_in, detail)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING"#,
        )
        .bind(class.as_str()).bind(kind).bind(account_id).bind(position_id).bind(web_ref).bind(decision_key).bind(web_at).bind(shadow_at).bind(skew).bind(known_fan_in).bind(&detail)
        .execute(&self.store)
        .await;
        match res {
            Ok(r) if r.rows_affected() == 1 => {
                report.classified.push((class, account_id.to_string()));
                if class.unexplained() {
                    tracing::error!(class = class.as_str(), kind, account_id, ?position_id, ?skew, %detail, "shadow reconcile: UNEXPLAINED difference, soak clock reset");
                    self.set_state("clock_started_at", &Utc::now().to_rfc3339()).await;
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
        self.clock_started_at().await;

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
                    let detail = serde_json::json!({ "webNote": note, "webPrice": close_price, "webPnl": amount, "shadowEvaluatedAccountAround": evaluated, "lateShadowDecision": other.map(|o| o.0) });
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
            let decision: Option<(String, DateTime<Utc>)> = sqlx::query_as(
                "SELECT dedupe_key, first_seen FROM shadow_decision WHERE kind = 'margin_call_in' AND account_id = $1 AND first_seen BETWEEN $2 AND $3 ORDER BY first_seen LIMIT 1",
            )
            .bind(account).bind(*at - window).bind(*at + window).fetch_optional(&self.store).await?;
            let fan = self.fan_in(account).await;
            match decision {
                Some((key, first)) => {
                    let class = by_skew((*at - first).num_milliseconds());
                    self.write_pair(class, "margin_call_in", account, None, Some(nid), Some(&key), Some(*at), Some(first), fan, serde_json::json!({ "webBody": body }), &mut report).await;
                }
                None => {
                    let near = self.recorder.min_call_around(account, *at, window).map(|(lvl, call)| at_edge(lvl, call)).unwrap_or(false)
                        || level_in(body).zip(self.recorder.call_level(account)).is_some_and(|(w, c)| at_edge(w, c));
                    let class = if near { Class::Snapshot } else { Class::WebOnly };
                    self.write_pair(class, "margin_call_in", account, None, Some(nid), None, Some(*at), None, fan, serde_json::json!({ "webBody": body }), &mut report).await;
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
                let class = if near { Class::Snapshot } else { Class::EngineOnly };
                self.write_pair(class, kind, account, None, None, Some(key), None, Some(*first), fan, serde_json::json!({ "shadowLevel": level }), &mut report).await;
            }
        }
        Ok(report)
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
        let clock = Utc::now() - self.clock_started_at().await;
        let clock_days = Decimal::new(clock.num_minutes(), 0) / Decimal::new(1440, 0);
        let counts_json: serde_json::Map<String, serde_json::Value> = counts.iter().map(|(c, n)| (c.clone(), serde_json::json!(n))).collect();
        let summary = serde_json::json!({
            "day": day.to_string(), "counts": counts_json, "skewP50Ms": pct(0.5), "skewP95Ms": pct(0.95), "skewMaxMs": skews.last().map(|r| r.0),
            "pairedTotal": paired, "clockDays": clock_days.round_dp(2).to_string(), "exitMet": paired >= 30 && clock_days >= Decimal::new(7, 0),
        });
        let _ = sqlx::query(
            r#"INSERT INTO shadow_daily (day, counts, skew_p50_ms, skew_p95_ms, skew_max_ms, paired_total, clock_days) VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (day) DO UPDATE SET counts = $2, skew_p50_ms = $3, skew_p95_ms = $4, skew_max_ms = $5, paired_total = $6, clock_days = $7, created_at = now()"#,
        )
        .bind(day).bind(serde_json::Value::Object(counts_json)).bind(pct(0.5)).bind(pct(0.95)).bind(skews.last().map(|r| r.0)).bind(paired).bind(clock_days.round_dp(2))
        .execute(&self.store).await;
        tracing::info!(summary = %summary, "shadow daily summary");
        Ok(summary)
    }
}

/// Every `every`: one reconcile run; after each UTC midnight, the previous day's summary.
pub fn spawn(reconciler: Reconciler, every: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(every);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last_day = Utc::now().date_naive();
        loop {
            ticker.tick().await;
            if let Err(err) = reconciler.run_once().await {
                tracing::warn!(error = %err, "shadow reconcile run failed");
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
