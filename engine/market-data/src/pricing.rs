//! The pricing cache (2026-10-05, Neon load): the configuration every account ask rule is resolved from
//! (crate::ask_markup::PricingSnapshot), held in memory and shared by the risk hook, the margin trigger and the book
//! reads of order management (shadow / live). Before, each of those joined Broker / Group / BrokerSymbol /
//! GroupSymbolConfig / AccountSymbolConfig (and before D8 AccountType / AccountTypeSymbolConfig) into EVERY book query.
//!
//! Reloaded:
//! - when the web announces a configuration change: `config.changed` (every backoffice pricing / symbols / groups /
//!   dealing write, lib/config-events.ts) and `account.updated` (an account's own pricing, group or type,
//!   lib/account-events.ts) -- debounced like the book reloads (crate::book_events::spawn_debounced);
//! - on a lost book event or a NATS reconnect (the server's full reload);
//! - as a safety net every SAFETY_IDLE (10 min) while anything real moves (crate::activity::reload_due): a change the web
//!   does not announce (the super-admin broker switch) is picked up within 10 minutes, and a quiet weekend reads nothing.
//!
//! The account's broker and group are not cached (they come with each book row), so moving an account to another group
//! prices it by the new group's levels at once.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use sqlx::PgPool;
use tokio::sync::Notify;

use crate::ask_markup::PricingSnapshot;
use crate::cache::TickCache;

/// The web's subjects that announce a pricing-relevant change (lib/nats.ts ConfigChanged / AccountUpdated).
pub const PRICING_CHANGE_SUBJECTS: &[&str] = &["config.changed", "account.updated"];

pub struct PricingCache {
    snap: RwLock<Option<Arc<PricingSnapshot>>>,
    reload_now: Notify,
    loaded: AtomicBool,
    /// how many reloads have run (tests, diagnostics)
    pub reload_count: AtomicU64,
}

impl PricingCache {
    pub fn new() -> Arc<Self> {
        Arc::new(PricingCache { snap: RwLock::new(None), reload_now: Notify::new(), loaded: AtomicBool::new(false), reload_count: AtomicU64::new(0) })
    }

    /// A cache holding `snap` (tests, harnesses).
    pub fn with_snapshot(snap: PricingSnapshot) -> Arc<Self> {
        let c = Self::new();
        c.set(snap);
        c
    }

    /// The current snapshot; None until the first load.
    pub fn snapshot(&self) -> Option<Arc<PricingSnapshot>> {
        self.snap.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set(&self, snap: PricingSnapshot) {
        *self.snap.write().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(snap));
        self.loaded.store(true, Ordering::Release);
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded.load(Ordering::Acquire)
    }

    /// Reads the whole configuration on `conn` (one read-only snapshot when the caller runs it in one) and installs it.
    pub async fn load_on(&self, conn: &mut sqlx::PgConnection) -> Result<Arc<PricingSnapshot>, sqlx::Error> {
        self.reload_count.fetch_add(1, Ordering::Relaxed);
        let snap = PricingSnapshot::load(conn, None).await?;
        let n = snap.len();
        self.set(snap);
        tracing::debug!(rows = n, "pricing cache: reloaded");
        Ok(self.snapshot().expect("just set"))
    }

    /// A full reload in one REPEATABLE READ, READ ONLY transaction (the five reads see one commit).
    pub async fn reload(&self, pool: &PgPool) -> Result<Arc<PricingSnapshot>, sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY").execute(&mut *tx).await?;
        let snap = self.load_on(&mut tx).await;
        let _ = tx.rollback().await;
        snap
    }

    /// The snapshot, loading it on `conn` first if it was never loaded (start-up: a read that comes before the loop's
    /// first load).
    pub async fn snapshot_or_load(&self, conn: &mut sqlx::PgConnection) -> Result<Arc<PricingSnapshot>, sqlx::Error> {
        match self.snapshot() {
            Some(s) => Ok(s),
            None => self.load_on(conn).await,
        }
    }

    /// As snapshot_or_load, on a pool.
    pub async fn snapshot_or_reload(&self, pool: &PgPool) -> Result<Arc<PricingSnapshot>, sqlx::Error> {
        match self.snapshot() {
            Some(s) => Ok(s),
            None => self.reload(pool).await,
        }
    }

    /// A configuration change was announced (or an event lost): reload now. Several requests make one reload.
    pub fn request_reload(&self) {
        self.reload_now.notify_one();
    }

    /// Keeps the cache current: the first load at once (retried every second until it succeeds), a reload on every
    /// request_reload, and a safety reload every `safety` while anything real moves (crate::activity::reload_due).
    pub fn spawn_reload_loop(self: &Arc<Self>, pool: PgPool, cache: Arc<TickCache>, safety: Duration) -> tokio::task::JoinHandle<()> {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut asked = true;
            let mut last: Option<tokio::time::Instant> = None;
            loop {
                let due = last.is_none_or(|l| l.elapsed() >= safety);
                // a failed reload that was asked for is retried next second (never left to the 10 min safety reload)
                let mut retry = false;
                if asked || !me.is_loaded() || (due && crate::activity::reload_due(&cache, chrono::Utc::now())) {
                    match me.reload(&pool).await {
                        Ok(s) => {
                            if last.is_none() {
                                tracing::info!(rows = s.len(), "pricing cache loaded");
                            }
                            last = Some(tokio::time::Instant::now());
                        }
                        Err(err) => {
                            tracing::warn!(error = %err, "pricing cache: reload failed (keeping the last snapshot)");
                            retry = asked;
                        }
                    }
                }
                asked = tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(1)) => retry,
                    _ = me.reload_now.notified() => true,
                };
            }
        })
    }
}
