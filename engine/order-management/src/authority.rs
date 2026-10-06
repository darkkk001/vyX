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

/// The same rule as a SQL predicate over `"Account" a` and `"Broker" b` (both columns are NOT NULL enums / booleans).
pub const RUST_OWNED_SQL: &str = r#"(b."riskAuthority"::text = 'RUST' AND (b."riskAuthorityDemoOnly" = false OR a."accountMode"::text = 'DEMO'))"#;

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
    let row: Option<(String, bool, String)> = sqlx::query_as(
        r#"SELECT b."riskAuthority"::text, b."riskAuthorityDemoOnly", a."accountMode"::text
           FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" WHERE a.id = $1"#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(authority, demo_only, mode)| risk_owner_of(Some(&authority), Some(demo_only), Some(&mode))))
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
    Ok(row.map(|(authority, demo_only, mode)| risk_owner_of(Some(&authority), Some(demo_only), Some(&mode))))
}

/// Accounts holding an OPEN position that the database says the engine owns, in accountId byte order (the pass order of
/// book::account_ids_with_open_positions, filtered by the rule).
pub async fn rust_owned_account_ids_with_open_positions(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let sql = format!(
        r#"SELECT p."accountId" FROM "Position" p JOIN "Account" a ON a.id = p."accountId" JOIN "Broker" b ON b.id = a."brokerId"
           WHERE p.status = 'OPEN' AND {RUST_OWNED_SQL} GROUP BY p."accountId" ORDER BY p."accountId" COLLATE "C""#
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
    Ok(role)
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
