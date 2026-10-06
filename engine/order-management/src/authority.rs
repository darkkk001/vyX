//! Rust cutover Stage 6: WHO acts on an account's risk (SL / TP, stop-out, margin-call notice, resting-order triggers).
//!
//! One rule, in three places that must agree (parity tests keep them so):
//! - `lib/risk-authority.ts riskOwnerOf(broker, accountMode)` (the web),
//! - [`risk_owner_of`] below (the engine),
//! - [`RUST_OWNED_SQL`] (the engine's pass listing and the tests' oracle).
//!
//! RUST only when the broker's `riskAuthority` is exactly `RUST` AND (`riskAuthorityDemoOnly` is `false`, or the account
//! is a DEMO account). A missing / unknown value is WEB. `riskAuthorityDemoOnly` missing counts
//! as demo-only. An account mode that is neither `DEMO` nor `LIVE` is WEB.
//!
//! Handoff (docs/STAGE6-PLAN.md): an ownership read is never trusted past the transaction that acts on it. The acting
//! transaction (a close, a margin-call edge) reads the owner INSIDE itself, with the account row locked and the broker
//! row locked `FOR SHARE` ([`lock_owner_in_tx`]): a flip is an `UPDATE "Broker"`, which waits for every acting
//! transaction in flight and is seen by every one that starts after it commits. The web does the same
//! (lib/risk-owner.ts). So at any instant exactly one side can pass the check, whatever the caches say. The caches
//! ([`AuthorityCache`]) only decide where a fire is ROUTED (engine or web call), and the engine's pass lists the
//! database's own answer ([`rust_owned_account_ids_with_open_positions`]), so a stale cache can delay an action by one
//! pass but never double it or lose it.
//!
//! The engine-down watchdog (docs/STAGE6-PLAN.md section 14): the rule above says who owns an account WHILE THE ENGINE IS ALIVE.
//! The engine proves it is alive by a heartbeat row ("RiskEngineHeartbeat", name `risk`, written by [`beat`]) and `staleAfterSecs`
//! (default 30, one value in the row, read by both sides). A heartbeat older than that by the DATABASE clock (or no row) means the
//! engine is DOWN: every account is WEB-owned, on both sides, in the prefilters and inside every acting transaction
//! ([`lock_owner_in_tx`] locks the heartbeat row FOR SHARE: the engine's next beat waits for an action already decided on a stale
//! reading). When the engine returns it beats first, so what it acts on afterwards is what the web left it.

use market_data::risk_hook::RiskOwnerOracle;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiskOwner {
    Web,
    Rust,
}

impl RiskOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            RiskOwner::Web => "WEB",
            RiskOwner::Rust => "RUST",
        }
    }
}

/// The ownership rule, exactly `riskOwnerOf` of lib/risk-authority.ts. `None` = missing.
pub fn risk_owner_of(authority: Option<&str>, demo_only: Option<bool>, account_mode: Option<&str>) -> RiskOwner {
    if authority != Some("RUST") {
        return RiskOwner::Web;
    }
    // an account mode the rule does not know never hands risk to the engine
    let demo = match account_mode {
        Some("DEMO") => true,
        Some("LIVE") => false,
        _ => return RiskOwner::Web,
    };
    let demo_only = demo_only != Some(false);
    if !demo_only || demo {
        RiskOwner::Rust
    } else {
        RiskOwner::Web
    }
}

/// The rule with the engine's liveness counted: a stale or missing heartbeat hands every account to the web.
pub fn effective_owner(authority: Option<&str>, demo_only: Option<bool>, account_mode: Option<&str>, engine_alive: bool) -> RiskOwner {
    if engine_alive {
        risk_owner_of(authority, demo_only, account_mode)
    } else {
        RiskOwner::Web
    }
}

/// The same rule as a SQL predicate over `"Account" a` and `"Broker" b` (both columns are NOT NULL enums / booleans).
pub const RUST_OWNED_SQL: &str = r#"(b."riskAuthority"::text = 'RUST' AND (b."riskAuthorityDemoOnly" = false OR a."accountMode"::text = 'DEMO'))"#;

/// The heartbeat is fresh by the database's own clock (one clock for both sides). `clock_timestamp()`, never `now()`: a transaction's
/// `now()` is the time it STARTED, which would make a long-running transaction judge a stale heartbeat fresh.
pub const ENGINE_ALIVE_SQL: &str = r#"EXISTS (SELECT 1 FROM "RiskEngineHeartbeat" h WHERE h.name = 'risk' AND clock_timestamp() - h."beatAt" <= make_interval(secs => h."staleAfterSecs"))"#;

// ---- enforcement -----------------------------------------------------------------------------------------------

static ENFORCED: AtomicBool = AtomicBool::new(false);

/// Set by the server in every live order-management mode: from then on a live evaluation acts only on accounts the
/// database says are RUST-owned, and every close / margin-call write re-checks that inside its transaction. Not set
/// (unit tests, the single-engine parity and load harnesses that predate Stage 6) = the engine acts on every account it is
/// handed, exactly as before. Process-wide and one-way on purpose: nothing can switch it off at run time.
pub fn enforce() {
    ENFORCED.store(true, Ordering::SeqCst);
}

pub fn enforced() -> bool {
    ENFORCED.load(Ordering::SeqCst)
}

/// The actor a live write checks itself as: the engine, when ownership is enforced.
pub fn live_actor() -> Option<RiskOwner> {
    enforced().then_some(RiskOwner::Rust)
}

// ---- the database's answer --------------------------------------------------------------------------------------

/// One account's owner as the database says now (None = no such account). Plain read, no lock: a PREFILTER. Acting
/// code re-checks with [`lock_owner_in_tx`].
pub async fn owner_of_account(pool: &PgPool, account_id: &str) -> Result<Option<RiskOwner>, sqlx::Error> {
    let sql = format!(
        r#"SELECT b."riskAuthority"::text, b."riskAuthorityDemoOnly", a."accountMode"::text, {ENGINE_ALIVE_SQL}
           FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" WHERE a.id = $1"#
    );
    let row: Option<(String, bool, String, bool)> = sqlx::query_as(&sql).bind(account_id).fetch_optional(pool).await?;
    Ok(row.map(|(authority, demo_only, mode, alive)| effective_owner(Some(&authority), Some(demo_only), Some(&mode), alive)))
}

/// The owner as the database says, read INSIDE the acting transaction with the account row locked (`FOR NO KEY UPDATE`:
/// the lock a later `FOR UPDATE` of the same transaction upgrades without a deadlock, and a concurrent mode change waits)
/// and the broker row `FOR SHARE` (a concurrent flip waits for this transaction; a later one is seen). None = no such account.
pub async fn lock_owner_in_tx(tx: &mut sqlx::PgTransaction<'_>, account_id: &str) -> Result<Option<RiskOwner>, sqlx::Error> {
    let row: Option<(String, bool, String)> = sqlx::query_as(
        r#"SELECT b."riskAuthority"::text, b."riskAuthorityDemoOnly", a."accountMode"::text
           FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" WHERE a.id = $1
           FOR NO KEY UPDATE OF a FOR SHARE OF b"#,
    )
    .bind(account_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((authority, demo_only, mode)) = row else { return Ok(None) };
    let owner = risk_owner_of(Some(&authority), Some(demo_only), Some(&mode));
    if owner == RiskOwner::Rust {
        // the watchdog: the engine keeps the account only while its own heartbeat is fresh. The row is locked FOR SHARE (the lock order
        // Position, Account, Broker, heartbeat; a beat takes no other lock, so no cycle): a beat waits for this transaction, so the reading
        // below cannot turn fresh under an action decided on it. A stale / missing heartbeat = the web owns the account.
        let alive: Option<(bool,)> = sqlx::query_as(
            r#"SELECT clock_timestamp() - "beatAt" <= make_interval(secs => "staleAfterSecs") FROM "RiskEngineHeartbeat" WHERE name = 'risk' FOR SHARE"#,
        )
        .fetch_optional(&mut **tx)
        .await?;
        return Ok(Some(effective_owner(Some(&authority), Some(demo_only), Some(&mode), alive.is_some_and(|(a,)| a))));
    }
    Ok(Some(owner))
}

/// Accounts holding an OPEN position that the database says the engine owns, in accountId byte order (the pass order of
/// book::account_ids_with_open_positions, filtered by the rule).
pub async fn rust_owned_account_ids_with_open_positions(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let sql = format!(
        r#"SELECT p."accountId" FROM "Position" p JOIN "Account" a ON a.id = p."accountId" JOIN "Broker" b ON b.id = a."brokerId"
           WHERE p.status = 'OPEN' AND {RUST_OWNED_SQL} AND {ENGINE_ALIVE_SQL} GROUP BY p."accountId" ORDER BY p."accountId" COLLATE "C""#
    );
    let rows: Vec<(String,)> = sqlx::query_as(&sql).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

// ---- the start-up check of risk mode ----------------------------------------------------------------------------------

/// Risk mode acts on the real book, so its pool must be able to: the session writable (not the shadow's read-only role, not
/// a replica), the money tables writable by this role, the outbox writable, and the Stage 6 columns present. Returns the
/// reason when something is missing (the server then refuses risk mode, loudly, like SHADOW REFUSED).
pub async fn verify_risk_pool(pool: &PgPool) -> Result<String, String> {
    let (role, read_only, recovery, can_write): (String, String, bool, bool) = sqlx::query_as(
        r#"SELECT current_user::text, current_setting('transaction_read_only'), pg_is_in_recovery(),
                  has_table_privilege(current_user, '"Position"', 'UPDATE') AND has_table_privilege(current_user, '"Account"', 'UPDATE')
                  AND has_table_privilege(current_user, '"Transaction"', 'INSERT') AND has_table_privilege(current_user, '"AuditLog"', 'INSERT')
                  AND has_table_privilege(current_user, '"PostCloseEffect"', 'INSERT')"#,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| format!("could not check the pool's privileges: {e}"))?;
    if read_only != "off" {
        return Err(format!("the pool's session is read-only (role {role}): risk mode needs the write pool, not the shadow's read-only role"));
    }
    if recovery {
        return Err("the pool points at a replica (pg_is_in_recovery)".into());
    }
    if !can_write {
        return Err(format!("role {role} cannot write Position / Account / Transaction / AuditLog / PostCloseEffect"));
    }
    let (columns,): (i64,) = sqlx::query_as(
        r#"SELECT count(*) FROM information_schema.columns WHERE table_name = 'Broker' AND column_name IN ('riskAuthority', 'riskAuthorityDemoOnly')"#,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    if columns != 2 {
        return Err("Broker.riskAuthority / riskAuthorityDemoOnly are missing (the Stage 6 migration is not applied)".into());
    }
    let (beat_ok,): (bool,) = sqlx::query_as(
        r#"SELECT to_regclass('"RiskEngineHeartbeat"') IS NOT NULL
                  AND has_table_privilege(current_user, '"RiskEngineHeartbeat"', 'INSERT') AND has_table_privilege(current_user, '"RiskEngineHeartbeat"', 'UPDATE')"#,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    if !beat_ok {
        return Err("the RiskEngineHeartbeat table is missing or not writable by this role (migration 20261007100000_risk_engine_heartbeat): without a heartbeat nobody counts the engine as alive".into());
    }
    Ok(role)
}

// ---- the startup flip marker ------------------------------------------------------------------------------------------

/// Stage 6 (owner answer (e), 2026-10-06): the engine stays in `ENGINE_ORDER_MANAGEMENT=shadow` until the flip. A live mode (`1` / `true` /
/// `on` / `yes` = the legacy order management, `risk` = Stage 6) on a process without an explicit marker is most likely a mistake (a stray
/// environment variable, a copied service file), so the server logs a WARNING at startup. The marker is `VYX_RISK_FLIP_INTENT=<broker
/// subdomain>:<YYYY-MM-DD>` (e.g. `futurixglobal:2026-10-12`): who is being flipped and when. It does not authorise anything by itself (the
/// per-broker flag in the database is the switch); it records that a person meant it. Returns the warning, or None when there is nothing to say.
pub fn flip_marker_warning(mode: Option<&str>, intent: Option<&str>) -> Option<String> {
    let mode = mode.map(|m| m.trim().to_ascii_lowercase()).unwrap_or_default();
    if !matches!(mode.as_str(), "1" | "true" | "on" | "yes" | "risk") {
        return None;
    }
    let intent = intent.map(str::trim).unwrap_or("");
    if flip_marker_valid(intent) {
        return None;
    }
    let why = if intent.is_empty() { "VYX_RISK_FLIP_INTENT is not set".to_string() } else { format!("VYX_RISK_FLIP_INTENT={intent:?} is not <broker subdomain>:<YYYY-MM-DD>") };
    Some(format!(
        "WARNING: ENGINE_ORDER_MANAGEMENT={mode} is a LIVE mode (the engine writes to the book) but {why}. Until the flip the engine stays in shadow. If this flip is intended, set VYX_RISK_FLIP_INTENT=<broker subdomain>:<YYYY-MM-DD> (e.g. futurixglobal:2026-10-12); if not, set ENGINE_ORDER_MANAGEMENT=shadow and restart."
    ))
}

fn flip_marker_valid(intent: &str) -> bool {
    let Some((who, date)) = intent.split_once(':') else { return false };
    let b = date.as_bytes();
    !who.is_empty()
        && who.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

// ---- the heartbeat (engine side of the watchdog) ----------------------------------------------------------------------

/// The seconds between two beats of the timer (VYX_RISK_HEARTBEAT_SECS overrides). Ten beats fit in the default staleness of 30 s.
pub const DEFAULT_BEAT_SECS: u64 = 3;

static BEAT_EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
/// ms since BEAT_EPOCH of the last beat this process committed (0 = never): rate-limits [`touch`].
static LAST_BEAT_MS: AtomicU64 = AtomicU64::new(0);

fn since_epoch_ms() -> u64 {
    BEAT_EPOCH.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
}

/// The drill switch (runbook section 7): while the file named by `VYX_RISK_HEARTBEAT_PAUSE_FILE` exists the engine writes NO heartbeat (neither the
/// timer nor [`touch`]), so it counts as down for the web and for its own transactions after `staleAfterSecs`, while its market data and everything
/// else keep running. Unset = the switch does not exist. It can only move ownership toward the WEB (the safe direction).
fn paused() -> bool {
    match std::env::var("VYX_RISK_HEARTBEAT_PAUSE_FILE").ok().filter(|p| !p.trim().is_empty()) {
        Some(path) if std::path::Path::new(path.trim()).exists() => {
            static WARNED: AtomicBool = AtomicBool::new(false);
            if !WARNED.swap(true, Ordering::Relaxed) {
                tracing::warn!(%path, "risk heartbeat PAUSED by the drill file: the engine counts as down for the web after staleAfterSecs until the file is removed");
            }
            true
        }
        _ => false,
    }
}

/// Writes the heartbeat NOW: one upsert of the row `risk` (`beatAt = clock_timestamp()`, the database's clock, the one both sides judge by).
/// Waits for any transaction holding the row FOR SHARE (an action decided on the previous reading): by design.
pub async fn beat(pool: &PgPool) -> Result<(), sqlx::Error> {
    if paused() {
        return Ok(());
    }
    let instance = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    sqlx::query(
        r#"INSERT INTO "RiskEngineHeartbeat" (name, "beatAt", "engineVersion", instance) VALUES ('risk', clock_timestamp(), $1, $2)
           ON CONFLICT (name) DO UPDATE SET "beatAt" = clock_timestamp(), "engineVersion" = EXCLUDED."engineVersion", instance = EXCLUDED.instance"#,
    )
    .bind(env!("CARGO_PKG_VERSION"))
    .bind(instance)
    .execute(pool)
    .await?;
    LAST_BEAT_MS.store(since_epoch_ms(), Ordering::Relaxed);
    Ok(())
}

/// "The engine is alive and about to act": beats unless this process beat within `min_gap`. Called before a fire batch and a pass, so
/// the first evaluation after a quiet spell (the idle gate stops the timer's beats, to let Neon sleep) is never refused as stale. Never
/// called from inside an evaluation: the in-transaction check judges the heartbeat as it is.
pub async fn touch(pool: &PgPool, min_gap: Duration) {
    let last = LAST_BEAT_MS.load(Ordering::Relaxed);
    if last != 0 && since_epoch_ms().saturating_sub(last) < min_gap.as_millis() as u64 {
        return;
    }
    if let Err(err) = beat(pool).await {
        tracing::error!(%err, "risk heartbeat: could not write (the engine counts as down for the web once it is stale)");
    }
}

/// The timer: a beat every `every` while the idle gate is open (the feed moves AND the book holds something that can move: the engine has
/// work), nothing otherwise. Idle = no beat on purpose: a beat every few seconds forever would keep the live Neon compute awake all weekend
/// (the 2026-09-26 lesson), and while nothing can move the question "who acts" has no consequence; the first fire or pass after the quiet
/// [`touch`]es. The first beat is written at once, unconditionally (startup).
pub fn spawn_heartbeat(pool: PgPool, gate: crate::monitor::ShadowGate, every: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        static LOG: market_data::activity::GateLog = market_data::activity::GateLog::new("risk heartbeat");
        if let Err(err) = beat(&pool).await {
            tracing::error!(%err, "risk heartbeat: the first beat failed");
        }
        let mut ticker = tokio::time::interval(every);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if !LOG.observe(gate.gate()) {
                continue;
            }
            if let Err(err) = beat(&pool).await {
                tracing::error!(%err, "risk heartbeat: beat failed (stale for the web after the configured seconds)");
            }
        }
    })
}

// ---- the routing cache -------------------------------------------------------------------------------------------

/// The brokers that are RUST (`riskAuthority = 'RUST'`) with their demo-only scope, in memory: where a fire is routed
/// (the engine, or the web call). A broker not in it is WEB. Correctness never depends on it (see the module doc): the
/// pass and the acting transactions read the database. Reloaded on `config.changed` (market_data::book_events
/// debounce), on a book-feed loss / reconnect (the server's full reload), and every `safety` while anything real moves
/// (the owner flips with SQL: no event announces it).
pub struct AuthorityCache {
    brokers: RwLock<Option<HashMap<String, bool>>>,
    reload_now: Notify,
    /// how many reloads have run (tests, diagnostics)
    pub reload_count: AtomicU64,
}

impl AuthorityCache {
    pub fn new() -> Arc<Self> {
        Arc::new(AuthorityCache { brokers: RwLock::new(None), reload_now: Notify::new(), reload_count: AtomicU64::new(0) })
    }

    /// A cache holding exactly these RUST brokers (broker id -> demo-only), tests.
    pub fn with_rust_brokers(brokers: &[(&str, bool)]) -> Arc<Self> {
        let c = Self::new();
        c.set(brokers.iter().map(|(id, d)| (id.to_string(), *d)).collect());
        c
    }

    pub fn set(&self, rust_brokers: HashMap<String, bool>) {
        *self.brokers.write().unwrap_or_else(|p| p.into_inner()) = Some(rust_brokers);
    }

    pub fn is_loaded(&self) -> bool {
        self.brokers.read().unwrap_or_else(|p| p.into_inner()).is_some()
    }

    /// The owner of an account of `broker_id` in `mode` as this cache knows it; WEB until loaded.
    pub fn owner(&self, broker_id: &str, account_mode: &str) -> RiskOwner {
        match self.brokers.read().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|m| m.get(broker_id)) {
            Some(demo_only) => risk_owner_of(Some("RUST"), Some(*demo_only), Some(account_mode)),
            None => RiskOwner::Web,
        }
    }

    pub async fn reload(&self, pool: &PgPool) -> Result<usize, sqlx::Error> {
        self.reload_count.fetch_add(1, Ordering::Relaxed);
        let rows: Vec<(String, bool)> =
            sqlx::query_as(r#"SELECT id, "riskAuthorityDemoOnly" FROM "Broker" WHERE "riskAuthority"::text = 'RUST'"#).fetch_all(pool).await?;
        let n = rows.len();
        self.set(rows.into_iter().collect());
        Ok(n)
    }

    /// A configuration change was announced (or an event lost): reload now.
    pub fn request_reload(&self) {
        self.reload_now.notify_one();
    }

    /// Keeps the cache current: the first load at once (retried every second until it works), a reload on every
    /// request, and a safety reload every `safety` once the feed moves (market_data::activity::reload_due), so a flip made
    /// with SQL while the market was quiet is picked up on the first tick after it.
    pub fn spawn_reload_loop(self: &Arc<Self>, pool: PgPool, cache: Arc<market_data::cache::TickCache>, safety: Duration) -> tokio::task::JoinHandle<()> {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut asked = true;
            let mut last: Option<tokio::time::Instant> = None;
            let mut announced: Option<usize> = None;
            loop {
                let due = last.is_none_or(|l| l.elapsed() >= safety);
                let mut retry = false;
                if asked || !me.is_loaded() || (due && market_data::activity::reload_due(&cache, chrono::Utc::now())) {
                    match me.reload(&pool).await {
                        Ok(n) => {
                            if announced != Some(n) {
                                tracing::warn!(rust_brokers = n, "risk authority: {n} broker(s) are RUST-owned (the engine acts on their accounts per the demo-only scope)");
                                announced = Some(n);
                            }
                            last = Some(tokio::time::Instant::now());
                        }
                        Err(err) => {
                            tracing::error!(%err, "risk authority: could not read Broker.riskAuthority (is the Stage 6 migration applied?); the engine treats every broker as WEB until it can");
                            retry = true;
                        }
                    }
                }
                let nap = if retry { Duration::from_secs(1) } else { safety.min(Duration::from_secs(1)) };
                asked = tokio::select! {
                    _ = tokio::time::sleep(nap) => false,
                    _ = me.reload_now.notified() => true,
                };
            }
        })
    }
}

impl RiskOwnerOracle for AuthorityCache {
    fn engine_owns(&self, broker_id: &str, account_mode: &str) -> bool {
        self.owner(broker_id, account_mode) == RiskOwner::Rust
    }
}

// ---- the risk action trace (tests and the load harness) ---------------------------------------------------------

static TRACE: std::sync::OnceLock<Option<Mutex<std::fs::File>>> = std::sync::OnceLock::new();

/// Records every risk ACTION this process takes (a close, a margin-call notice written or cleared) as one JSON line in
/// the file named by `VYX_RISK_ACTION_TRACE`; nothing when the variable is unset (production). The split proofs read it
/// to attribute each action to the side that took it (lib/risk-owner.ts writes the same format for the web).
pub fn trace_action(actor: RiskOwner, kind: &str, account_id: &str, reference: &str) {
    let file = TRACE.get_or_init(|| {
        let path = std::env::var("VYX_RISK_ACTION_TRACE").ok().filter(|p| !p.trim().is_empty())?;
        std::fs::OpenOptions::new().create(true).append(true).open(path).ok().map(Mutex::new)
    });
    if let Some(f) = file {
        use std::io::Write;
        let line = serde_json::json!({ "actor": actor.as_str(), "kind": kind, "accountId": account_id, "ref": reference, "ts": chrono::Utc::now().timestamp_millis() });
        let _ = writeln!(f.lock().unwrap_or_else(|p| p.into_inner()), "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        authority: Option<String>,
        #[serde(rename = "demoOnly", default)]
        demo_only: Option<bool>,
        mode: Option<String>,
        owner: String,
    }

    /// The SAME cases lib/risk-authority.test.ts runs against `riskOwnerOf` (lib/risk-authority-cases.json): the two
    /// implementations cannot drift apart without one of the two suites failing.
    #[test]
    fn the_rust_rule_matches_the_shared_cases_the_web_rule_is_tested_on() {
        let cases: Vec<Case> = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../lib/risk-authority-cases.json"))).unwrap();
        assert!(cases.len() >= 100, "the matrix is the full cross product: {}", cases.len());
        let mut rust = 0;
        for c in &cases {
            let got = risk_owner_of(c.authority.as_deref(), c.demo_only, c.mode.as_deref());
            assert_eq!(got.as_str(), c.owner, "authority {:?} demoOnly {:?} mode {:?}", c.authority, c.demo_only, c.mode);
            rust += (got == RiskOwner::Rust) as usize;
        }
        assert!(rust > 0 && rust < cases.len());
    }

    #[test]
    fn a_stale_engine_hands_every_account_to_the_web() {
        for mode in [Some("DEMO"), Some("LIVE")] {
            assert_eq!(effective_owner(Some("RUST"), Some(false), mode, true), RiskOwner::Rust);
            assert_eq!(effective_owner(Some("RUST"), Some(false), mode, false), RiskOwner::Web, "stale heartbeat: WEB");
        }
        assert_eq!(effective_owner(Some("WEB"), Some(true), Some("DEMO"), true), RiskOwner::Web);
    }

    #[test]
    fn the_startup_warning_fires_for_a_live_mode_without_the_flip_marker() {
        // live modes without the marker: a warning that names the mode and the fix
        for mode in ["1", "risk", "RISK", " risk ", "true", "on", "yes"] {
            let w = flip_marker_warning(Some(mode), None).unwrap_or_else(|| panic!("no warning for mode {mode:?}"));
            assert!(w.starts_with("WARNING:") && w.contains("VYX_RISK_FLIP_INTENT") && w.contains("shadow"), "{w}");
        }
        assert!(flip_marker_warning(Some("risk"), Some("")).is_some(), "an empty marker is no marker");
        assert!(flip_marker_warning(Some("risk"), Some("futurixglobal")).unwrap().contains("is not <broker subdomain>:<YYYY-MM-DD>"), "a marker without a date");
        assert!(flip_marker_warning(Some("risk"), Some("futurixglobal:12-10-2026")).is_some(), "a wrong date shape");
        // no warning: the marker is there, or the mode is not live
        assert_eq!(flip_marker_warning(Some("risk"), Some("futurixglobal:2026-10-12")), None);
        assert_eq!(flip_marker_warning(Some("1"), Some(" futurixglobal:2026-10-12 ")), None);
        for mode in [None, Some(""), Some("shadow"), Some("0"), Some("off"), Some("false")] {
            assert_eq!(flip_marker_warning(mode, None), None, "mode {mode:?} is not live");
        }
    }

    #[test]
    fn the_cache_follows_the_rule_and_is_web_until_loaded() {
        let c = AuthorityCache::new();
        assert_eq!(c.owner("b1", "DEMO"), RiskOwner::Web, "not loaded: WEB");
        c.set([("b1".to_string(), true), ("b2".to_string(), false)].into());
        assert_eq!(c.owner("b1", "DEMO"), RiskOwner::Rust);
        assert_eq!(c.owner("b1", "LIVE"), RiskOwner::Web, "demo-only broker: its LIVE accounts stay with the web");
        assert_eq!(c.owner("b2", "LIVE"), RiskOwner::Rust);
        assert_eq!(c.owner("b2", "DEMO"), RiskOwner::Rust);
        assert_eq!(c.owner("b3", "DEMO"), RiskOwner::Web, "a broker not listed is WEB");
        assert!(c.engine_owns("b2", "LIVE") && !c.engine_owns("b3", "LIVE"));
    }
}
