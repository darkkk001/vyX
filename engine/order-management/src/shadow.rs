//! Rust cutover Stage 5: the shadow's decision record (docs/RUST-CUTOVER-PLAN.md §5.1).
//!
//! In `ENGINE_ORDER_MANAGEMENT=shadow` the monitor runs the SAME evaluation as at cutover (monitor.rs with
//! `Mode::Shadow`) but acts on nothing: a would-close is applied in memory with book::close_money (the same
//! function the real close uses), and every decision lands HERE instead of in the book. The web keeps acting;
//! the reconciler (reconcile.rs) pairs its real closes with these would-closes.
//!
//! Store: table `shadow_decision` in the engine host's LOCAL Postgres (the market-data database on the VPS),
//! never Neon. `Recorder::connect` refuses a non-local URL. Without a store the recorder keeps decisions in
//! memory only (tests, and a VPS without the local database) and logs them.
//!
//! Dedupe: a position under stop-out stays open until the web closes it, so the shadow sees the same decision
//! on every pass. One row per decision (`dedupe_key`); later sightings bump `last_seen` / `seen_count`, and the
//! first sighting's numbers (level, price, P&L) are kept: that is the moment the engine would have acted.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// How long the per-account level samples are kept (the reconciler looks one window either side of a web action).
const SAMPLE_KEEP_MINUTES: i64 = 10;

/// One evaluation's view of an account: when, its margin level (None = no used margin), and its thresholds.
#[derive(Debug, Clone, Copy)]
struct Sample {
    at: DateTime<Utc>,
    level: Option<Decimal>,
    stop_out: Decimal,
    call: Decimal,
}

#[derive(Debug, Clone, PartialEq, Eq, Copy)]
pub enum Kind {
    StopLoss,
    TakeProfit,
    StopOut,
    MarginCallIn,
    MarginCallOut,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::StopLoss => "stop_loss",
            Kind::TakeProfit => "take_profit",
            Kind::StopOut => "stop_out",
            Kind::MarginCallIn => "margin_call_in",
            Kind::MarginCallOut => "margin_call_out",
        }
    }
    pub fn is_close(self) -> bool {
        matches!(self, Kind::StopLoss | Kind::TakeProfit | Kind::StopOut)
    }
}

/// One would-be action. Closes carry the position and the simulated money; edges carry the level.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub kind: Kind,
    pub account_id: String,
    pub position_id: Option<String>,
    /// the account's margin level when the evaluation started (None = no used margin)
    pub level_before: Option<Decimal>,
    /// the level that decided it (stop-out / margin call)
    pub level: Option<Decimal>,
    pub close_price: Option<Decimal>,
    pub pnl: Option<Decimal>,
    pub balance_after: Option<Decimal>,
    pub credit_after: Option<Decimal>,
    pub write_off: Option<Decimal>,
    /// symbol -> [bid, ask] the evaluation used (the SNAPSHOT replay input)
    pub prices: serde_json::Value,
}

impl Decision {
    /// A close happens once per position; a margin-call edge once per episode (the caller passes the episode).
    pub fn dedupe_key(&self, episode: Option<u64>) -> String {
        match (&self.position_id, self.kind.is_close()) {
            (Some(p), true) => format!("{}:{}", self.kind.as_str(), p),
            _ => format!("{}:{}:{}", self.kind.as_str(), self.account_id, episode.unwrap_or(0)),
        }
    }
}

pub struct Recorder {
    store: Option<PgPool>,
    /// dedupe key -> sightings, for the in-memory mode and for tests
    seen: Mutex<HashMap<String, (Decision, u32)>>,
    /// account -> (last recorded edge, episode counter)
    edges: Mutex<HashMap<String, (Kind, u64)>>,
    /// account -> recent evaluations (memory only): the reconciler's SNAPSHOT evidence
    samples: Mutex<HashMap<String, VecDeque<Sample>>>,
}

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS shadow_decision (
  id            BIGSERIAL PRIMARY KEY,
  dedupe_key    TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  position_id   TEXT,
  level_before  NUMERIC,
  level         NUMERIC,
  close_price   NUMERIC,
  pnl           NUMERIC,
  balance_after NUMERIC,
  credit_after  NUMERIC,
  write_off     NUMERIC,
  prices        JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS shadow_decision_first_seen ON shadow_decision (first_seen);
CREATE INDEX IF NOT EXISTS shadow_decision_position ON shadow_decision (position_id);
"#;

/// Create the store's tables, or, for a role that may not CREATE in the schema (the VPS's `engine` role on
/// market_data: USAGE only), accept them when deploy/shadow-store.sql already created them as postgres.
pub async fn ensure_schema(pool: &PgPool, schema: &str, tables: &[&str]) -> Result<(), String> {
    match sqlx::raw_sql(schema).execute(pool).await {
        Ok(_) => Ok(()),
        Err(create_err) => {
            for t in tables {
                if let Err(e) = sqlx::query(&format!("SELECT 1 FROM {t} LIMIT 0")).execute(pool).await {
                    return Err(format!("cannot create the shadow tables ({create_err}) and {t} is not usable ({e}): run deploy/shadow-store.sql as postgres"));
                }
            }
            Ok(())
        }
    }
}

// ---- Stage 5 startup guards (user, 2026-09-25): shadow must not be able to act, by construction ----
//
// 1. READ-ONLY book connection: the shadow monitor and the reconciler read the book through their OWN pool from
//    VYX_SHADOW_DATABASE_URL, a Neon role that cannot write any money table (verified at startup, not assumed), and
//    every session on it is default_transaction_read_only. The engine's main pool stays as it is (it must still
//    write price alerts / notifications). The URL must point at the SAME Neon endpoint as DATABASE_URL, so the shadow
//    can never watch a different (e.g. the retired) database.
// 2. + 3. No post-close delivery configured: with shadow mode, VYX_POST_CLOSE_URL / VYX_POST_CLOSE_SECRET set is a
//    misconfiguration and shadow refuses to start.
// A failed guard stops SHADOW only (order management stays OFF, loud ERROR): the engine keeps serving prices, candles
// and the risk hook, because refusing the whole process would take the price feed down for every trader.

/// Guard 2+3: shadow with a post-close delivery configured. Some(reason) = refuse.
pub fn shadow_env_violation(post_close_url: Option<&str>, post_close_secret: Option<&str>) -> Option<String> {
    let set = |v: Option<&str>| v.map(|s| !s.trim().is_empty()).unwrap_or(false);
    match (set(post_close_url), set(post_close_secret)) {
        (false, false) => None,
        (u, s) => Some(format!(
            "shadow mode with post-close delivery configured ({}{}{}): unset them, shadow must never deliver follow-ups",
            if u { "VYX_POST_CLOSE_URL" } else { "" },
            if u && s { " + " } else { "" },
            if s { "VYX_POST_CLOSE_SECRET" } else { "" }
        )),
    }
}

/// The Neon endpoint id of a connection URL ("ep-morning-glade-b23tui1g"), the pooler suffix removed; for a
/// non-Neon host, the host itself.
pub fn neon_endpoint(url: &str) -> Option<String> {
    let after_at = url.rsplit('@').next()?;
    let host = after_at.split(['/', ':', '?']).next()?.trim();
    if host.is_empty() {
        return None;
    }
    let first = host.split('.').next().unwrap_or(host);
    Some(first.strip_suffix("-pooler").unwrap_or(first).to_string())
}

/// "endpoint/database" of a connection URL: the identity two URLs must share to be the same database.
pub fn database_identity(url: &str) -> Option<String> {
    let endpoint = neon_endpoint(url)?;
    let after_at = url.rsplit('@').next()?;
    let db = after_at.split_once('/').map(|(_, rest)| rest.split(['?', '#']).next().unwrap_or("")).unwrap_or("");
    Some(format!("{endpoint}/{db}"))
}

/// The tables no shadow connection may be able to write.
pub const MONEY_TABLES: &[&str] = &["Position", "Account", "Transaction", "Order", "PostCloseEffect", "Notification", "AuditLog", "PriceAlert"];

/// Guard 1: the read-only book pool, or why shadow must not start (write on a money table, Account.passwordHash
/// readable, a non-read-only session, or another database).
pub async fn connect_read_only_book(shadow_url: Option<&str>, main_url: &str) -> Result<PgPool, String> {
    let url = shadow_url.map(str::trim).filter(|s| !s.is_empty()).ok_or("VYX_SHADOW_DATABASE_URL is not set: shadow needs its own read-only Neon role")?;
    let (a, b) = (database_identity(url), database_identity(main_url));
    if a.is_none() || a != b {
        return Err(format!("VYX_SHADOW_DATABASE_URL points at {:?} but DATABASE_URL at {:?}: shadow must read the same database the web acts on", a, b));
    }
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET default_transaction_read_only = on").execute(conn).await?;
                Ok(())
            })
        })
        .connect(url)
        .await
        .map_err(|e| format!("VYX_SHADOW_DATABASE_URL: cannot connect ({e})"))?;
    let tables: Vec<String> = MONEY_TABLES.iter().map(|t| format!("public.\"{t}\"")).collect();
    let (who, can_write): (String, Option<bool>) = sqlx::query_as(
        "SELECT current_user::text, bool_or(has_table_privilege(current_user, t, p)) FROM unnest($1::text[]) t, unnest(ARRAY['INSERT','UPDATE','DELETE']) p",
    )
    .bind(&tables)
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("VYX_SHADOW_DATABASE_URL: privilege check failed ({e})"))?;
    if can_write != Some(false) {
        return Err(format!("VYX_SHADOW_DATABASE_URL role '{who}' can write a money table ({}): use the read-only role (deploy/neon-shadow-readonly.sql)", MONEY_TABLES.join(", ")));
    }
    // least privilege (user 2026-09-25): a standing credential must not read secrets it has no use for
    let (reads_password,): (bool,) = sqlx::query_as(r#"SELECT has_column_privilege(current_user, 'public."Account"', 'passwordHash', 'SELECT')"#)
        .fetch_one(&pool).await.map_err(|e| format!("VYX_SHADOW_DATABASE_URL: column privilege check failed ({e})"))?;
    if reads_password {
        return Err(format!("VYX_SHADOW_DATABASE_URL role '{who}' can read Account.passwordHash: grant only the columns in deploy/neon-shadow-readonly.sql"));
    }
    let (ro,): (String,) = sqlx::query_as("SHOW transaction_read_only").fetch_one(&pool).await.map_err(|e| e.to_string())?;
    if ro != "on" {
        return Err("shadow book sessions are not read-only".into());
    }
    tracing::info!(role = %who, endpoint = ?a, "shadow book: read-only role verified (no write on any money table, read-only sessions)");
    Ok(pool)
}

/// Only a database on this machine may hold the shadow store (the plan: VPS-local, never Neon).
pub fn is_local_url(url: &str) -> bool {
    let after_at = url.rsplit('@').next().unwrap_or("");
    let host = after_at.split(['/', ':', '?']).next().unwrap_or("");
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

impl Recorder {
    pub fn in_memory() -> Self {
        Recorder { store: None, seen: Mutex::new(HashMap::new()), edges: Mutex::new(HashMap::new()), samples: Mutex::new(HashMap::new()) }
    }

    /// The local store: creates the table if needed. A non-local URL is refused (Err), never used.
    pub async fn connect(url: &str) -> Result<Self, String> {
        if !is_local_url(url) {
            return Err("shadow store must be a local database (127.0.0.1 / localhost), refusing".into());
        }
        let pool = PgPool::connect(url).await.map_err(|e| format!("shadow store connect: {e}"))?;
        ensure_schema(&pool, SCHEMA, &["shadow_decision"]).await?;
        Ok(Recorder { store: Some(pool), seen: Mutex::new(HashMap::new()), edges: Mutex::new(HashMap::new()), samples: Mutex::new(HashMap::new()) })
    }

    pub fn store(&self) -> Option<&PgPool> {
        self.store.as_ref()
    }

    /// Record a would-close (idempotent per position).
    pub async fn record(&self, d: Decision) {
        self.write(d, None).await;
    }

    /// Record a margin-call edge only when it CHANGES from the last one recorded for the account (the shadow sees
    /// "in margin call" on every pass of an episode). The first sighting of an account records In but not Out:
    /// an account that was never in a call has no edge to leave.
    pub async fn record_edge(&self, d: Decision) {
        let episode = {
            let mut edges = self.edges.lock().unwrap();
            let prev = edges.get(&d.account_id).copied();
            let changed = match prev {
                None => d.kind == Kind::MarginCallIn,
                Some((k, _)) => k != d.kind,
            };
            if !changed {
                return;
            }
            let ep = prev.map(|(_, n)| n).unwrap_or(0) + u64::from(d.kind == Kind::MarginCallIn);
            edges.insert(d.account_id.clone(), (d.kind, ep));
            ep
        };
        self.write(d, Some(episode)).await;
    }

    async fn write(&self, d: Decision, episode: Option<u64>) {
        let key = d.dedupe_key(episode);
        let first = {
            let mut seen = self.seen.lock().unwrap();
            match seen.get_mut(&key) {
                Some((_, n)) => {
                    *n += 1;
                    false
                }
                None => {
                    // bounded: an idle-for-days engine must not grow without limit (the store keeps history)
                    if seen.len() > 200_000 {
                        seen.clear();
                    }
                    seen.insert(key.clone(), (d.clone(), 1));
                    true
                }
            }
        };
        if first {
            tracing::info!(kind = d.kind.as_str(), account_id = %d.account_id, position_id = ?d.position_id, level = ?d.level, pnl = ?d.pnl, "shadow: would act");
        }
        let Some(pool) = &self.store else { return };
        let res = sqlx::query(
            r#"INSERT INTO shadow_decision (dedupe_key, kind, account_id, position_id, level_before, level, close_price, pnl, balance_after, credit_after, write_off, prices)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               ON CONFLICT (dedupe_key) DO UPDATE SET last_seen = now(), seen_count = shadow_decision.seen_count + 1"#,
        )
        .bind(&key)
        .bind(d.kind.as_str())
        .bind(&d.account_id)
        .bind(&d.position_id)
        .bind(d.level_before)
        .bind(d.level)
        .bind(d.close_price)
        .bind(d.pnl)
        .bind(d.balance_after)
        .bind(d.credit_after)
        .bind(d.write_off)
        .bind(&d.prices)
        .execute(pool)
        .await;
        if let Err(err) = res {
            tracing::warn!(error = %err, key, "shadow: could not store a decision (kept in memory)");
        }
    }

    /// Every shadow evaluation of an account: its level and thresholds now (kept SAMPLE_KEEP_MINUTES, memory only).
    pub fn sample(&self, account_id: &str, level: Option<Decimal>, stop_out: Decimal, call: Decimal) {
        self.sample_at(account_id, Utc::now(), level, stop_out, call);
    }
    pub fn sample_at(&self, account_id: &str, at: DateTime<Utc>, level: Option<Decimal>, stop_out: Decimal, call: Decimal) {
        let mut all = self.samples.lock().unwrap();
        let q = all.entry(account_id.to_string()).or_default();
        q.push_back(Sample { at, level, stop_out, call });
        let keep_from = at - ChronoDuration::minutes(SAMPLE_KEEP_MINUTES);
        while q.front().is_some_and(|s| s.at < keep_from) {
            q.pop_front();
        }
    }
    fn around<T>(&self, account_id: &str, at: DateTime<Utc>, window: ChronoDuration, f: impl Fn(&mut dyn Iterator<Item = &Sample>) -> T) -> T {
        let all = self.samples.lock().unwrap();
        let empty = VecDeque::new();
        let q = all.get(account_id).unwrap_or(&empty);
        let mut it = q.iter().filter(|s| s.at >= at - window && s.at <= at + window);
        f(&mut it)
    }
    /// Did the shadow evaluate this account at all around `at`?
    /// Every sample of the account around `at`: (ms relative to `at`, level, stop-out). For the WEB_ONLY detail: it shows
    /// whether the shadow looked at the account while the position was below its stop-out, or only before and after.
    pub fn samples_around(&self, account_id: &str, at: DateTime<Utc>, window: ChronoDuration) -> Vec<(i64, Option<Decimal>, Decimal)> {
        self.around(account_id, at, window, |it| it.map(|s| ((s.at - at).num_milliseconds(), s.level.map(|l| l.round_dp(2)), s.stop_out)).collect())
    }

    pub fn sampled_around(&self, account_id: &str, at: DateTime<Utc>, window: ChronoDuration) -> bool {
        self.around(account_id, at, window, |it| it.next().is_some())
    }
    /// The lowest level the shadow saw around `at`, with the stop-out level then.
    pub fn min_level_around(&self, account_id: &str, at: DateTime<Utc>, window: ChronoDuration) -> Option<(Decimal, Decimal)> {
        self.around(account_id, at, window, |it| it.filter_map(|s| s.level.map(|l| (l, s.stop_out))).min_by(|a, b| a.0.cmp(&b.0)))
    }
    /// The lowest level the shadow saw around `at`, with the margin-call level then.
    pub fn min_call_around(&self, account_id: &str, at: DateTime<Utc>, window: ChronoDuration) -> Option<(Decimal, Decimal)> {
        self.around(account_id, at, window, |it| it.filter_map(|s| s.level.map(|l| (l, s.call))).min_by(|a, b| a.0.cmp(&b.0)))
    }
    pub fn stop_out_level(&self, account_id: &str) -> Option<Decimal> {
        self.samples.lock().unwrap().get(account_id).and_then(|q| q.back()).map(|s| s.stop_out)
    }
    pub fn call_level(&self, account_id: &str) -> Option<Decimal> {
        self.samples.lock().unwrap().get(account_id).and_then(|q| q.back()).map(|s| s.call)
    }

    /// Every decision recorded in this process, with its sighting count (tests, the harness gate).
    pub fn decisions(&self) -> Vec<(Decision, u32)> {
        let mut v: Vec<_> = self.seen.lock().unwrap().values().cloned().collect();
        v.sort_by(|a, b| (a.0.account_id.clone(), a.0.position_id.clone(), a.0.kind.as_str()).cmp(&(b.0.account_id.clone(), b.0.position_id.clone(), b.0.kind.as_str())));
        v
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn guard_refuses_shadow_with_post_close_delivery() {
        assert_eq!(super::shadow_env_violation(None, None), None);
        assert_eq!(super::shadow_env_violation(Some("  "), Some("")), None);
        assert!(super::shadow_env_violation(None, Some("s3cret")).unwrap().contains("VYX_POST_CLOSE_SECRET"));
        assert!(super::shadow_env_violation(Some("http://x"), None).unwrap().contains("VYX_POST_CLOSE_URL"));
        assert!(super::shadow_env_violation(Some("http://x"), Some("s")).unwrap().contains("VYX_POST_CLOSE_URL + VYX_POST_CLOSE_SECRET"));
    }

    #[test]
    fn neon_endpoint_ignores_pooler_and_credentials() {
        let live = "postgresql://ro:pw@ep-morning-glade-b23tui1g-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
        let direct = "postgresql://neondb_owner:x@ep-morning-glade-b23tui1g.c-6.eu-central-1.aws.neon.tech/neondb";
        let dead = "postgresql://neondb_owner:x@ep-flat-boat-b1wjz20p-pooler.c-5.eu-central-1.aws.neon.tech/neondb";
        assert_eq!(super::neon_endpoint(live).as_deref(), Some("ep-morning-glade-b23tui1g"));
        assert_eq!(super::neon_endpoint(live), super::neon_endpoint(direct));
        assert_ne!(super::neon_endpoint(live), super::neon_endpoint(dead));
        assert_eq!(super::neon_endpoint("postgresql://u:p@127.0.0.1:5499/vyx_test").as_deref(), Some("127"));
        // same host, another database: NOT the same identity
        assert_ne!(super::database_identity("postgresql://ro@127.0.0.1:5499/vyx_test"), super::database_identity("postgresql://postgres@127.0.0.1:5499/vyx_load_web"));
        assert_eq!(super::database_identity(live), super::database_identity(direct));
        assert_eq!(super::database_identity(live).as_deref(), Some("ep-morning-glade-b23tui1g/neondb"));
    }

    use super::*;
    use rust_decimal_macros::dec;

    fn close(kind: Kind, pos: &str) -> Decision {
        Decision {
            kind,
            account_id: "a".into(),
            position_id: Some(pos.into()),
            level_before: Some(dec!(95)),
            level: Some(dec!(95)),
            close_price: Some(dec!(4280)),
            pnl: Some(dec!(-10)),
            balance_after: Some(dec!(90)),
            credit_after: Some(dec!(0)),
            write_off: None,
            prices: serde_json::json!({}),
        }
    }
    fn edge(kind: Kind) -> Decision {
        Decision { position_id: None, ..close(kind, "") }
    }

    #[test]
    fn only_a_local_database_may_hold_the_store() {
        assert!(is_local_url("postgresql://engine:x@127.0.0.1:5432/market_data"));
        assert!(is_local_url("postgresql://postgres@localhost/shadow"));
        assert!(!is_local_url("postgresql://neondb_owner:x@ep-morning-glade-b23tui1g.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require"));
        assert!(!is_local_url("postgresql://u:p@10.0.0.5:5432/db"));
    }

    #[tokio::test]
    async fn a_decision_seen_on_every_pass_is_one_record_with_a_count() {
        let r = Recorder::in_memory();
        for _ in 0..5 {
            r.record(close(Kind::StopOut, "p1")).await;
        }
        r.record(close(Kind::StopLoss, "p2")).await;
        let d = r.decisions();
        assert_eq!(d.len(), 2);
        assert_eq!(d.iter().find(|(x, _)| x.position_id.as_deref() == Some("p1")).unwrap().1, 5);
    }

    #[tokio::test]
    async fn margin_call_edges_are_recorded_on_change_only_and_numbered_per_episode() {
        let r = Recorder::in_memory();
        r.record_edge(edge(Kind::MarginCallOut)).await; // never in: nothing to leave
        r.record_edge(edge(Kind::MarginCallIn)).await; // episode 1 in
        r.record_edge(edge(Kind::MarginCallIn)).await; // same episode, every pass
        r.record_edge(edge(Kind::MarginCallOut)).await; // episode 1 out
        r.record_edge(edge(Kind::MarginCallIn)).await; // episode 2 in
        let keys: Vec<String> = r.decisions().iter().map(|(d, _)| d.kind.as_str().to_string()).collect();
        assert_eq!(keys.iter().filter(|k| *k == "margin_call_in").count(), 2);
        assert_eq!(keys.iter().filter(|k| *k == "margin_call_out").count(), 1);
    }
}
