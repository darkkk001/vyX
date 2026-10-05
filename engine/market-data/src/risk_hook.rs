//! SL / TP execution trigger (2026-09-14).
//!
//! The legacy trading path executes SL / TP / stop-out in the web app
//! (lib/risk-monitor.ts `evaluateAccountRisk`). That code has two callers:
//! the Vercel cron `/api/internal/margin-monitor` (once a minute, and it
//! only trusts a LivePrice row younger than 15 s) and `/api/price-feed`
//! (per tick) -- but since the feed moved to this engine the web route is
//! never hit, so production sampled every open position's SL / TP ONCE A
//! MINUTE. A touch between two samples (a TP the trader dragged to 27,
//! price 27.05 for twenty seconds, back to 26) was simply missed.
//!
//! This hook closes that gap from the engine side without moving the
//! execution: it keeps the open positions' SL / TP levels (read from the
//! Prisma `Position` table every few seconds and on demand), and after
//! every LivePrice flush checks the flushed ticks against them. The first
//! tick that touches a level fires `GET {url}?symbols=X` (the same
//! margin-monitor route, bearer CRON_SECRET) so the web app evaluates that
//! symbol's accounts NOW, against the row this very flush just wrote.
//! Rate-limited per symbol (one call per second) so a price sitting on a
//! level cannot flood Vercel.
//!
//! Configured by `VYX_RISK_HOOK_URL` (e.g. https://vyxtrader.com/api/internal/margin-monitor)
//! and `VYX_RISK_HOOK_SECRET` (= the web app's CRON_SECRET); unset = off.
//!
//! Full-book backstop (2026-09-23). The level check above only ever fires for a position
//! with an SL or TP; it computes no margin, so a stop-out on a position without levels
//! (the one that matters most) was caught only by the Vercel cron. The backstop calls the
//! same route WITHOUT `symbols` every `VYX_RISK_HOOK_BACKSTOP_SECS` (default 60, 0 = off):
//! the route's full pass (every account with an open position: SL / TP, stop-out, margin
//! call), so real-time protection no longer depends on a Vercel cron existing at all.
//! Idle cost is one index-backed `count` on the route side when nothing is open.
//!
//! Per-tick margin trigger (2026-09-24). The level check fires only for positions WITH an SL / TP, so a
//! stop-out waited for the backstop (up to 60 s; production 2026-09-24: an account at 80 % against a 99 %
//! stop-out for most of a minute). A `MarginWatch` (order_management::margin_watch, plugged in by the server
//! because this crate cannot depend on order-management) recomputes, after every flush, the margin level of
//! each account holding a flushed symbol and names the symbols whose accounts are at or below stop-out (or
//! crossed margin call); they go through the same `?symbols=` call and the same per-symbol rate limit. The
//! web still decides and closes; this only asks it NOW.
//!
//! SL / TP shadow snapshot (2026-09-26, Stage 5): with a shadow running, every SL / TP touch is handed to it as a
//! SNAPSHOT -- the account, the position and the tick that crossed -- through a non-blocking send, and the web call goes
//! out at once, exactly as without a shadow: the live path never waits for the shadow. The shadow evaluates that
//! position as it stood at the touch (order_management::monitor, book::Pin), even when the web has closed it by the
//! time the shadow reads. Without it the web closed the position within ~1 s and the shadow, which sees SL / TP only in
//! its periodic pass, never decided anything: a WEB_ONLY that reset the soak clock (2026-09-26 06:10:29 UTC,
//! #100002473 / #100002472). Resting-order triggers are not handed off (the shadow does not evaluate them).
//!
//! Reload on change (2026-09-26): the levels are reloaded at once when the web announces a book change (the server
//! subscribes to its NATS events and calls `request_reload`), not only on the 5 s poll, so a just-set SL is watched
//! before the next tick can cross it.
//!
//! Idle gate (2026-09-26, crate::activity): the backstop skips its pass while the feed is quiet, the book is flat or
//! none of its symbols has a fresh tick, and the reload stops querying once nothing has ticked for a minute. The web
//! route could not have acted on any of those passes (every decision needs a price at most 15 s old).

use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

use protocol::Tick;

use crate::activity::{self, GateLog};
use crate::ask_markup::{self as ask_markup, AskRule};
use crate::cache::TickCache;

/// One account the margin trigger wants the web to evaluate, under the flushed symbol that moved it (targeted calls,
/// 2026-10-05). `account_id` empty = the trigger cannot name the account: the web evaluates every holder of the symbol.
/// `urgent` = at or below stop-out, or a margin-call edge: sent on this trigger pass, never held for the per-symbol
/// coalesce window. Not urgent = inside the near-level band (MarginWatch's VYX_RISK_BAND_PCT): coalesced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarginTarget {
    pub account_id: String,
    pub symbol: String,
    pub urgent: bool,
}

/// The per-tick margin trigger (see the module doc). Pure in-memory on the flush path: no I/O.
pub trait MarginWatch: Send + Sync {
    /// After a LivePrice flush: the flushed symbols whose accounts the web must evaluate now.
    fn symbols_to_evaluate(&self, flushed: &[Tick], cache: &TickCache) -> Vec<String>;
    /// The accounts the web must evaluate now, each under its flushed symbol (targeted calls). `now` = the trigger
    /// pass's moment (tests replay it). The default names no account: every symbol becomes a whole-symbol evaluation,
    /// all of them urgent, which is exactly the per-symbol behaviour.
    fn targets_to_evaluate(&self, flushed: &[Tick], cache: &TickCache, _now: Instant) -> Vec<MarginTarget> {
        self.symbols_to_evaluate(flushed, cache).into_iter().map(|symbol| MarginTarget { account_id: String::new(), symbol, urgent: true }).collect()
    }
    /// A margin-triggered evaluation came back (closes may have happened): refresh the watched book.
    fn evaluated(&self);
    /// The symbols of every open position in the watched book; None until the book has loaded once.
    fn book_symbols(&self) -> Option<HashSet<String>> {
        None
    }
}

/// One SL / TP touch as the risk hook saw it (the shadow snapshot, see the module doc): the position, its account, and
/// the tick that crossed. `tick_at` = the tick's own time (tick_ms, else when the hook saw it); `at` = when the hook saw
/// it (the moment the snapshot pins the account to).
#[derive(Clone, Debug, PartialEq)]
pub struct SlTpTouch {
    pub account_id: String,
    pub position_id: String,
    pub symbol: String,
    pub bid: Decimal,
    pub ask: Decimal,
    pub tick_at: chrono::DateTime<chrono::Utc>,
    pub at: chrono::DateTime<chrono::Utc>,
}

/// Where the risk hook hands SL / TP touches to the shadow (never awaited: a send on an unbounded channel).
pub type SnapshotSender = tokio::sync::mpsc::UnboundedSender<Vec<SlTpTouch>>;

#[derive(Clone, Debug)]
struct Level {
    /// the position and its account (the shadow snapshot names them)
    position_id: String,
    account_id: String,
    is_buy: bool,
    sl: Option<Decimal>,
    tp: Option<Decimal>,
    /// The position's account ask rule (crate::ask_markup, 2026-09-26): a SELL's levels are checked against the
    /// account's ask, the price it closes at. None = the raw ask.
    ask_rule: Option<AskRule>,
}

/// A resting LIMIT / STOP order's entry (audit 2026-09-24 Batch 4): pending orders trigger SERVER-side. The tick that
/// crosses the entry fires the same `?symbols=` call; the web (lib/pending-trigger.ts) re-checks the trigger on its
/// own price and fills. A BUY trades at the ask -- its ACCOUNT's ask (2026-09-26: the fill already used it, the
/// trigger now does too) -- a SELL at the bid.
#[derive(Clone, Debug, PartialEq)]
struct PendingLevel {
    /// the resting order and its account (targeted calls name the order: the web triggers only it)
    order_id: String,
    account_id: String,
    is_buy: bool,
    is_limit: bool,
    entry: Decimal,
    ask_rule: Option<AskRule>,
}

impl PendingLevel {
    fn triggered(&self, bid: Decimal, raw_ask: Decimal) -> bool {
        let ask = if self.is_buy { self.ask_rule.as_ref().map_or(raw_ask, |r| ask_markup::account_ask(r, bid, raw_ask)) } else { raw_ask };
        match (self.is_buy, self.is_limit) {
            (true, true) => ask <= self.entry,   // BUY LIMIT: buy when the ask falls to the entry
            (true, false) => ask >= self.entry,  // BUY STOP: buy when the ask rises to the entry
            (false, true) => bid >= self.entry,  // SELL LIMIT: sell when the bid rises to the entry
            (false, false) => bid <= self.entry, // SELL STOP: sell when the bid falls to the entry
        }
    }
}

/// How the hook calls the web (2026-10-05, owner: the per-tick hook was 97 % of the web's traffic, 17.2 calls/s with
/// markets open).
///
/// Targeted (the default): a call names the accounts (`accounts=`) and resting orders (`orders=`) that need the web, not
/// just the symbol, so the web evaluates those and nothing else:
/// - an SL / TP this tick crossed, a resting order whose entry it crossed (the touch's position account / the order);
/// - from the margin trigger: an account at or below stop-out or crossing margin call (urgent), or inside the
///   near-level band above margin call (MarginWatch, VYX_RISK_BAND_PCT).
/// Per symbol, the first call goes out at once and later ones within `coalesce` are held and merged into ONE trailing call
/// at the window's end, so the final state is always sent and never dropped (the old one-per-second limit dropped them).
/// Urgent margin targets never wait: they go out on the trigger pass that found them (the 250 ms trigger), together with
/// whatever that symbol had queued. A touch that is STILL touched after it was sent (the web kept the order, refused the
/// close) is re-sent after 1, 2, 4 ... `max_backoff` s, not every second, and forgotten once its symbol ticks without
/// touching it. The 5 s backstop full pass underneath is unchanged.
///
/// Legacy (`VYX_RISK_HOOK_TARGETED=0`): the exact pre-2026-10-05 behaviour (whole symbols, one per second, extras
/// dropped): the switch back without a redeploy.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HookPolicy {
    pub targeted: bool,
    pub coalesce: Duration,
    pub max_backoff: Duration,
}

impl Default for HookPolicy {
    fn default() -> Self {
        HookPolicy { targeted: true, coalesce: Duration::from_millis(1000), max_backoff: Duration::from_secs(30) }
    }
}

impl HookPolicy {
    /// VYX_RISK_HOOK_TARGETED (1 = default, 0 = legacy) and VYX_RISK_HOOK_COALESCE_MS (default 1000), each reported
    /// loudly when set but unusable (the default is used then).
    pub fn from_env() -> HookPolicy {
        let get = |k: &str| std::env::var_os(k).map(|v| v.to_string_lossy().into_owned());
        let (policy, problems) = Self::parse(get("VYX_RISK_HOOK_TARGETED"), get("VYX_RISK_HOOK_COALESCE_MS"));
        for p in problems {
            tracing::error!("{p}");
        }
        policy
    }

    pub fn parse(targeted: Option<String>, coalesce_ms: Option<String>) -> (HookPolicy, Vec<String>) {
        let mut policy = HookPolicy::default();
        let mut problems = Vec::new();
        if let Some(raw) = targeted {
            match raw.trim() {
                "1" | "true" => policy.targeted = true,
                "0" | "false" => policy.targeted = false,
                _ => problems.push(format!("VYX_RISK_HOOK_TARGETED={raw:?} is not 0 or 1; USING 1 (targeted). Write it as: set VYX_RISK_HOOK_TARGETED=0")),
            }
        }
        if let Some(raw) = coalesce_ms {
            match raw.trim().parse::<u64>() {
                Ok(ms) if ms > 0 => policy.coalesce = Duration::from_millis(ms),
                _ => problems.push(format!("VYX_RISK_HOOK_COALESCE_MS={raw:?} is not a positive whole number of milliseconds; USING 1000. Write it as: set VYX_RISK_HOOK_COALESCE_MS=1000")),
            }
        }
        (policy, problems)
    }

    fn backoff(&self, fires: u32) -> Duration {
        if fires == 0 {
            return Duration::ZERO;
        }
        Duration::from_secs(1u64 << (fires - 1).min(10)).min(self.max_backoff)
    }
}

/// What one web call carries for its symbols (targeted mode).
#[derive(Default, Debug, Clone)]
struct Targets {
    /// an account could not be named (or too many): the web evaluates every holder of these symbols
    whole: bool,
    accounts: std::collections::BTreeSet<String>,
    orders: std::collections::BTreeSet<String>,
    /// the SL / TP touches in this call (the shadow snapshot goes out when the call does)
    touches: Vec<SlTpTouch>,
    /// a margin target is in it: refresh the watched book once the web answered
    margin: bool,
}

impl Targets {
    fn is_empty(&self) -> bool {
        !self.whole && self.accounts.is_empty() && self.orders.is_empty()
    }
    fn merge(&mut self, other: Targets) {
        self.whole |= other.whole;
        self.accounts.extend(other.accounts);
        self.orders.extend(other.orders);
        for t in other.touches {
            if !self.touches.iter().any(|x| x.position_id == t.position_id) {
                self.touches.push(t);
            }
        }
        self.margin |= other.margin;
    }
}

/// The per-symbol coalesce state (targeted mode).
#[derive(Default, Debug)]
struct SymbolQueue {
    last_sent: Option<tokio::time::Instant>,
    queued: Targets,
    trailing: bool,
}

/// A touch that was sent and may still be touched: its re-send backoff.
#[derive(Debug)]
struct Retry {
    symbol: String,
    fires: u32,
    last: tokio::time::Instant,
}

/// An SL / TP level as replays hand it to RiskHook::replace_book (reload() reads the same from the database).
#[derive(Clone, Debug)]
pub struct LevelSpec {
    pub symbol: String,
    pub position_id: String,
    pub account_id: String,
    pub is_buy: bool,
    pub sl: Option<Decimal>,
    pub tp: Option<Decimal>,
    pub ask_rule: Option<AskRule>,
}

/// A resting LIMIT / STOP order as replays hand it to RiskHook::replace_book.
#[derive(Clone, Debug)]
pub struct PendingSpec {
    pub symbol: String,
    pub order_id: String,
    pub account_id: String,
    pub is_buy: bool,
    pub is_limit: bool,
    pub entry: Decimal,
    pub ask_rule: Option<AskRule>,
}

/// The most accounts / orders one call names; beyond it the call evaluates the whole symbol (always correct).
pub const MAX_TARGETS_PER_CALL: usize = 200;

pub struct RiskHook {
    url: String,
    secret: String,
    client: reqwest::Client,
    levels: Mutex<HashMap<String, Vec<Level>>>,
    pending: Mutex<HashMap<String, Vec<PendingLevel>>>,
    last_fired: Mutex<HashMap<String, tokio::time::Instant>>,
    margin_watch: std::sync::OnceLock<Arc<dyn MarginWatch>>,
    /// The levels / pending entries have been read at least once (the idle gate never skips the first load).
    loaded: AtomicBool,
    /// Stage 5: where SL / TP touches go to the shadow (set only when the shadow runs).
    shadow_snapshot: std::sync::OnceLock<SnapshotSender>,
    /// a book change was announced: reload now (request_reload)
    reload_now: Notify,
    /// the shared pricing cache (account ask rules); unset = read per reload (tests)
    pricing: std::sync::OnceLock<Arc<crate::pricing::PricingCache>>,
    /// how many reloads have run (tests, diagnostics: a lost event must force one, an in-order stream must not)
    pub reload_count: std::sync::atomic::AtomicU64,
    /// targeted / legacy, coalesce window, re-send backoff cap (HookPolicy)
    policy: HookPolicy,
    /// targeted mode: per-symbol coalesce state, and the re-send backoff of touches already sent ("p:" position, "o:" order)
    queues: Mutex<HashMap<String, SymbolQueue>>,
    retries: Mutex<HashMap<String, Retry>>,
    /// replays / tests: every call's path + query goes here INSTEAD of over HTTP (the route then counts as answered)
    recorder: std::sync::OnceLock<tokio::sync::mpsc::UnboundedSender<String>>,
}

impl RiskHook {
    /// None when the env is not set (the hook is opt-in per deployment).
    pub fn from_env() -> Option<Arc<RiskHook>> {
        let url = std::env::var("VYX_RISK_HOOK_URL").ok().filter(|s| !s.trim().is_empty())?;
        let secret = std::env::var("VYX_RISK_HOOK_SECRET").ok().filter(|s| !s.trim().is_empty())?;
        let policy = HookPolicy::from_env();
        let hook = Self::with_policy(url, secret, Duration::from_secs(12), policy)?;
        tracing::info!(
            url = %hook.url,
            targeted = policy.targeted,
            coalesce_ms = policy.coalesce.as_millis() as u64,
            "risk hook enabled: SL/TP evaluation fires on the tick that touches a level"
        );
        Some(hook)
    }

    /// A hook calling `url` with bearer `secret` (from_env; tests). None only if the HTTP client cannot be built.
    pub fn new(url: String, secret: String, timeout: Duration) -> Option<Arc<RiskHook>> {
        Self::with_policy(url, secret, timeout, HookPolicy::default())
    }

    /// As new, with an explicit HookPolicy (from_env; replays compare legacy and targeted).
    pub fn with_policy(url: String, secret: String, timeout: Duration, policy: HookPolicy) -> Option<Arc<RiskHook>> {
        let client = reqwest::Client::builder().timeout(timeout).build().ok()?;
        Some(Arc::new(RiskHook {
            policy,
            queues: Mutex::new(HashMap::new()),
            retries: Mutex::new(HashMap::new()),
            recorder: std::sync::OnceLock::new(),
            url,
            secret,
            client,
            levels: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            last_fired: Mutex::new(HashMap::new()),
            margin_watch: std::sync::OnceLock::new(),
            loaded: AtomicBool::new(false),
            shadow_snapshot: std::sync::OnceLock::new(),
            reload_now: Notify::new(),
            pricing: std::sync::OnceLock::new(),
            reload_count: std::sync::atomic::AtomicU64::new(0),
        }))
    }

    /// The calling policy (targeted / legacy, coalesce window).
    pub fn policy(&self) -> HookPolicy {
        self.policy
    }

    /// Stage 5: hand every SL / TP touch to the shadow as a snapshot (once; a second call is ignored). Never waited on.
    pub fn set_shadow_snapshot(&self, tx: SnapshotSender) {
        let _ = self.shadow_snapshot.set(tx);
    }

    /// True when an SL / TP level of this position is being watched (tests, diagnostics).
    pub fn watches(&self, position_id: &str) -> bool {
        self.levels.lock().unwrap().values().any(|ls| ls.iter().any(|l| l.position_id == position_id))
    }

    /// A book change was announced (a new or edited SL / TP, a resting order, a close): reload the levels now instead
    /// of at the next 5 s poll. Several requests before the reload runs make one reload.
    pub fn request_reload(&self) {
        self.reload_now.notify_one();
    }

    /// Plug in the per-tick margin trigger (once; a second call is ignored).
    pub fn set_margin_watch(&self, watch: Arc<dyn MarginWatch>) {
        let _ = self.margin_watch.set(watch);
    }

    /// Plug in the shared pricing cache (once; a second call is ignored). Without one (tests) every reload reads the
    /// pricing configuration of the rows it loaded, in the same snapshot.
    pub fn set_pricing(&self, pricing: Arc<crate::pricing::PricingCache>) {
        let _ = self.pricing.set(pricing);
    }

    /// Reload the open positions' levels (symbol -> [side, sl, tp, account ask rule]) and the resting orders' entries from
    /// the Prisma tables. The account ask rule comes from the pricing cache (2026-10-05): the two reads join only Symbol
    /// and Account, never the pricing tables.
    pub async fn reload(&self, pool: &PgPool) {
        self.reload_count.fetch_add(1, Ordering::Relaxed);
        match self.load(pool).await {
            Ok((levels, pending)) => {
                *self.levels.lock().unwrap() = levels;
                *self.pending.lock().unwrap() = pending;
                self.loaded.store(true, Ordering::Relaxed);
            }
            Err(err) => tracing::warn!(error = %err, "risk hook: could not reload SL/TP levels / pending order entries"),
        }
    }

    #[allow(clippy::type_complexity)]
    async fn load(&self, pool: &PgPool) -> Result<(HashMap<String, Vec<Level>>, HashMap<String, Vec<PendingLevel>>), sqlx::Error> {
        use sqlx::Row;
        let mut conn = pool.acquire().await?;
        let level_rows = sqlx::query(
            r#"SELECT s.name, s.id AS symbol_id, s.digits, p.id AS position_id, p."accountId" AS account_id, p.side::text AS side,
                      p."slPrice" AS sl, p."tpPrice" AS tp, a."brokerId" AS a_broker, a."groupId" AS a_group
               FROM "Position" p JOIN "Symbol" s ON s.id = p."symbolId" JOIN "Account" a ON a.id = p."accountId"
               WHERE p.status = 'OPEN' AND (p."slPrice" IS NOT NULL OR p."tpPrice" IS NOT NULL)"#,
        )
        .fetch_all(&mut *conn)
        .await?;
        // resting LIMIT / STOP orders (the web's own "Order" table: PENDING, not the engine's orders table), with the
        // order's account ask rule for a BUY entry
        let pending_rows = sqlx::query(
            r#"SELECT s.name, s.id AS symbol_id, s.digits, o.id AS order_id, o."accountId" AS account_id, o.side::text AS side, o.type::text AS kind,
                      o."requestedPrice" AS entry, a."brokerId" AS a_broker, a."groupId" AS a_group
               FROM "Order" o JOIN "Symbol" s ON s.id = o."symbolId" JOIN "Account" a ON a.id = o."accountId"
               WHERE o.status = 'PENDING' AND o.type IN ('LIMIT', 'STOP') AND o."requestedPrice" IS NOT NULL"#,
        )
        .fetch_all(&mut *conn)
        .await?;
        // (account, broker, group, symbol, digits) of every row, levels first
        let mut keys: Vec<(String, String, Option<String>, String, i32)> = Vec::with_capacity(level_rows.len() + pending_rows.len());
        for r in level_rows.iter().chain(pending_rows.iter()) {
            keys.push((r.try_get("account_id")?, r.try_get("a_broker")?, r.try_get("a_group")?, r.try_get("symbol_id")?, r.try_get("digits")?));
        }
        let rule_keys: Vec<ask_markup::RuleKey<'_>> = keys
            .iter()
            .map(|(a, b, g, s, d)| ask_markup::RuleKey { account_id: a, broker_id: b, group_id: g.as_deref(), symbol_id: s, digits: *d })
            .collect();
        let snap = match self.pricing.get() {
            Some(cache) => Some(cache.snapshot_or_load(&mut conn).await?),
            None => None,
        };
        let rules = ask_markup::rules_for(&mut conn, snap.as_deref(), &rule_keys).await?;
        let mut rules = rules.into_iter();
        let mut levels: HashMap<String, Vec<Level>> = HashMap::new();
        for r in &level_rows {
            let side: String = r.try_get("side")?;
            let ask_rule = rules.next().flatten();
            levels.entry(r.try_get("name")?).or_default().push(Level {
                position_id: r.try_get("position_id")?,
                account_id: r.try_get("account_id")?,
                is_buy: side == "BUY",
                sl: r.try_get("sl")?,
                tp: r.try_get("tp")?,
                ask_rule,
            });
        }
        let mut pending: HashMap<String, Vec<PendingLevel>> = HashMap::new();
        for r in &pending_rows {
            let side: String = r.try_get("side")?;
            let kind: String = r.try_get("kind")?;
            let ask_rule = rules.next().flatten();
            pending.entry(r.try_get("name")?).or_default().push(PendingLevel {
                order_id: r.try_get("order_id")?,
                account_id: r.try_get("account_id")?,
                is_buy: side == "BUY",
                is_limit: kind == "LIMIT",
                entry: r.try_get("entry")?,
                ask_rule,
            });
        }
        Ok((levels, pending))
    }

    /// The `x-vyx-idle-gate` value of GET /internal/prices (2026-09-26): the book gate exactly as this hook's backstop
    /// computes it, so the web's Vercel cron can skip its full pass without touching Neon. "unknown" when the book is not
    /// known (no margin trigger, or its book not loaded yet): the web then runs as before.
    pub fn idle_gate_header(&self, cache: &TickCache, now: chrono::DateTime<chrono::Utc>) -> &'static str {
        match self.book_symbols() {
            Some(book) => activity::book_gate(cache, Some(&book), now).header_value(),
            None => "unknown",
        }
    }

    /// What the book holds, for the idle gate: the margin trigger's open-position symbols plus every symbol a resting
    /// order or an SL / TP level waits on. None = unknown (no margin trigger, or its book not loaded yet), in which
    /// case the gate only skips while the whole feed is quiet.
    pub fn book_symbols(&self) -> Option<HashSet<String>> {
        let mut symbols = self.margin_watch.get()?.book_symbols()?;
        symbols.extend(self.pending.lock().unwrap().keys().cloned());
        symbols.extend(self.levels.lock().unwrap().keys().cloned());
        Some(symbols)
    }

    /// Symbols among the flushed ticks whose bid / ask touches an open level.
    #[cfg(test)]
    fn touched(&self, ticks: &[Tick]) -> Vec<String> {
        self.touched_with_positions(ticks, chrono::Utc::now()).0
    }

    /// The touched symbols (SL / TP levels and resting-order entries), and every SL / TP touch as a snapshot for the
    /// shadow (never a resting order). `now` = when the hook sees these ticks.
    fn touched_with_positions(&self, ticks: &[Tick], now: chrono::DateTime<chrono::Utc>) -> (Vec<String>, Vec<SlTpTouch>) {
        let levels = self.levels.lock().unwrap();
        let mut out = Vec::new();
        let mut touches: Vec<SlTpTouch> = Vec::new();
        for t in ticks {
            let Some(ls) = levels.get(&t.symbol) else { continue };
            for l in ls {
                // close price: a BUY closes at the raw bid, a SELL at its account's ask (lib/ask-markup.ts)
                let cp = if l.is_buy { t.bid } else { ask_markup::close_price(protocol::OrderSide::Sell, t.bid, t.ask, l.ask_rule.as_ref()) };
                let sl_hit = l.sl.map_or(false, |sl| if l.is_buy { cp <= sl } else { cp >= sl });
                let tp_hit = l.tp.map_or(false, |tp| if l.is_buy { cp >= tp } else { cp <= tp });
                if !(sl_hit || tp_hit) {
                    continue;
                }
                if !out.contains(&t.symbol) {
                    out.push(t.symbol.clone());
                }
                if !touches.iter().any(|x| x.position_id == l.position_id) {
                    touches.push(SlTpTouch {
                        account_id: l.account_id.clone(),
                        position_id: l.position_id.clone(),
                        symbol: t.symbol.clone(),
                        bid: t.bid,
                        ask: t.ask,
                        tick_at: t.tick_ms.and_then(chrono::DateTime::from_timestamp_millis).unwrap_or(now),
                        at: now,
                    });
                }
            }
        }
        drop(levels);
        // a resting LIMIT / STOP whose entry this tick crosses (server-side trigger, Batch 4)
        let pending = self.pending.lock().unwrap();
        for t in ticks {
            if out.contains(&t.symbol) {
                continue;
            }
            if pending.get(&t.symbol).map_or(false, |ps| ps.iter().any(|p| p.triggered(t.bid, t.ask))) {
                out.push(t.symbol.clone());
            }
        }
        (out, touches)
    }

    /// Pending-order touches of these ticks: (symbol, order id, account id) of every resting order whose entry a tick
    /// crosses (targeted mode names the order).
    fn touched_orders(&self, ticks: &[Tick]) -> Vec<(String, String, String)> {
        let pending = self.pending.lock().unwrap();
        let mut out: Vec<(String, String, String)> = Vec::new();
        for t in ticks {
            let Some(ps) = pending.get(&t.symbol) else { continue };
            for p in ps {
                if p.triggered(t.bid, t.ask) && !out.iter().any(|(_, o, _)| *o == p.order_id) {
                    out.push((t.symbol.clone(), p.order_id.clone(), p.account_id.clone()));
                }
            }
        }
        out
    }

    /// Replays / tests: replace the watched SL / TP levels and resting orders (what reload() reads from the database).
    pub fn replace_book(&self, levels: Vec<LevelSpec>, orders: Vec<PendingSpec>) {
        let mut l: HashMap<String, Vec<Level>> = HashMap::new();
        for s in levels {
            l.entry(s.symbol).or_default().push(Level { position_id: s.position_id, account_id: s.account_id, is_buy: s.is_buy, sl: s.sl, tp: s.tp, ask_rule: s.ask_rule });
        }
        let mut p: HashMap<String, Vec<PendingLevel>> = HashMap::new();
        for s in orders {
            p.entry(s.symbol).or_default().push(PendingLevel { order_id: s.order_id, account_id: s.account_id, is_buy: s.is_buy, is_limit: s.is_limit, entry: s.entry, ask_rule: s.ask_rule });
        }
        *self.levels.lock().unwrap() = l;
        *self.pending.lock().unwrap() = p;
        self.loaded.store(true, Ordering::Relaxed);
    }

    /// Replays / tests: record every call's path + query on `tx` instead of calling the route.
    pub fn set_recorder(&self, tx: tokio::sync::mpsc::UnboundedSender<String>) {
        let _ = self.recorder.set(tx);
    }

    /// After a LivePrice flush: fire the evaluation for every symbol whose ticks touched an SL / TP, or put
    /// an account holding it at or below stop-out / across margin call (max once a second each).
    pub fn after_flush(self: &Arc<Self>, ticks: &[Tick], cache: &TickCache) {
        self.after_flush_at(ticks, cache, tokio::time::Instant::now());
    }

    /// after_flush at an explicit moment (replays run on tokio's paused clock).
    pub fn after_flush_at(self: &Arc<Self>, ticks: &[Tick], cache: &TickCache, at: tokio::time::Instant) {
        // A resend of a quote that has not moved for FRESH_SECS (a closed market's heartbeat) carries nothing new: the web
        // would refuse it as stale (its tickAt rule) or closed (its session rule), so it is not evaluated again and again.
        // (2026-10-05: a frozen Friday quote sitting beyond a level re-fired the web and the shadow on every 5 s heartbeat
        // all weekend.) A quote that moved within the window is evaluated as before, resends included (a retry).
        let now = chrono::Utc::now();
        let live: Vec<Tick> = ticks.iter().filter(|t| cache.moved_within(&t.symbol, now, chrono::Duration::seconds(activity::FRESH_SECS))).cloned().collect();
        let ticks = live.as_slice();
        if ticks.is_empty() {
            return;
        }
        if self.policy.targeted {
            self.after_flush_targeted(ticks, cache, now, at);
        } else {
            self.after_flush_legacy(ticks, cache, now, at);
        }
    }

    /// Targeted mode (HookPolicy): name the accounts / orders, coalesce per symbol, back off what stays touched.
    fn after_flush_targeted(self: &Arc<Self>, ticks: &[Tick], cache: &TickCache, now: chrono::DateTime<chrono::Utc>, at: tokio::time::Instant) {
        let (_, touches) = self.touched_with_positions(ticks, now);
        let orders = self.touched_orders(ticks);
        let ticked: HashSet<&str> = ticks.iter().map(|t| t.symbol.as_str()).collect();

        // what is touched now; a retry whose symbol ticked without touching it is forgotten (the next touch is new)
        let mut by_symbol: HashMap<String, Targets> = HashMap::new();
        {
            let mut retries = self.retries.lock().unwrap();
            let touched_keys: HashSet<String> =
                touches.iter().map(|t| format!("p:{}", t.position_id)).chain(orders.iter().map(|(_, o, _)| format!("o:{o}"))).collect();
            retries.retain(|k, r| touched_keys.contains(k) || !ticked.contains(r.symbol.as_str()));
            let mut due = |key: String, symbol: &str| -> bool {
                match retries.get_mut(&key) {
                    Some(r) if at.duration_since(r.last) < self.policy.backoff(r.fires) => false,
                    Some(r) => {
                        r.fires += 1;
                        r.last = at;
                        true
                    }
                    None => {
                        retries.insert(key, Retry { symbol: symbol.to_string(), fires: 1, last: at });
                        true
                    }
                }
            };
            for t in touches {
                if due(format!("p:{}", t.position_id), &t.symbol) {
                    let e = by_symbol.entry(t.symbol.clone()).or_default();
                    e.accounts.insert(t.account_id.clone());
                    e.touches.push(t);
                }
            }
            for (symbol, order, account) in orders {
                if due(format!("o:{order}"), &symbol) {
                    let _ = account;
                    by_symbol.entry(symbol).or_default().orders.insert(order);
                }
            }
        }
        let mut urgent: HashSet<String> = HashSet::new();
        if let Some(w) = self.margin_watch.get() {
            for m in w.targets_to_evaluate(ticks, cache, at.into_std()) {
                let e = by_symbol.entry(m.symbol.clone()).or_default();
                e.margin = true;
                if m.account_id.is_empty() {
                    e.whole = true;
                } else {
                    e.accounts.insert(m.account_id);
                }
                if m.urgent {
                    urgent.insert(m.symbol);
                }
            }
        }
        if by_symbol.is_empty() {
            return;
        }

        // per symbol: urgent or outside the window -> now (with whatever was queued); else queue for the trailing call
        let mut send_now: Vec<(String, Targets)> = Vec::new();
        {
            let mut queues = self.queues.lock().unwrap();
            for (symbol, targets) in by_symbol {
                let q = queues.entry(symbol.clone()).or_default();
                let open = q.last_sent.is_none_or(|l| at.duration_since(l) >= self.policy.coalesce);
                if urgent.contains(&symbol) || open {
                    let mut all = std::mem::take(&mut q.queued);
                    all.merge(targets);
                    q.last_sent = Some(at);
                    send_now.push((symbol, all));
                } else {
                    q.queued.merge(targets);
                    if !q.trailing {
                        q.trailing = true;
                        let due = q.last_sent.map_or(at, |l| l + self.policy.coalesce);
                        let hook = Arc::clone(self);
                        tokio::spawn(async move {
                            tokio::time::sleep_until(due).await;
                            let batch = {
                                let mut queues = hook.queues.lock().unwrap();
                                let q = queues.entry(symbol.clone()).or_default();
                                q.trailing = false;
                                let batch = std::mem::take(&mut q.queued);
                                if !batch.is_empty() {
                                    q.last_sent = Some(due);
                                }
                                batch
                            };
                            if !batch.is_empty() {
                                hook.send_targeted(vec![(symbol, batch)]);
                            }
                        });
                    }
                }
            }
        }
        if !send_now.is_empty() {
            self.send_targeted(send_now);
        }
    }

    /// One targeted web call for these symbols (two when some must be evaluated whole): the shadow snapshot of their
    /// SL / TP touches first (a send, never a wait), then the call.
    fn send_targeted(self: &Arc<Self>, batch: Vec<(String, Targets)>) {
        let mut whole = Targets::default();
        let mut whole_syms: Vec<String> = Vec::new();
        let mut named = Targets::default();
        let mut named_syms: Vec<String> = Vec::new();
        for (symbol, t) in batch {
            let overflow = t.accounts.len() > MAX_TARGETS_PER_CALL || t.orders.len() > MAX_TARGETS_PER_CALL;
            if t.whole || overflow {
                whole.merge(t);
                whole_syms.push(symbol);
            } else {
                named.merge(t);
                named_syms.push(symbol);
            }
        }
        if named.accounts.len() > MAX_TARGETS_PER_CALL || named.orders.len() > MAX_TARGETS_PER_CALL {
            whole.merge(named);
            whole_syms.append(&mut named_syms);
            named = Targets::default();
        }
        let mut calls: Vec<(String, Targets)> = Vec::new();
        if !whole_syms.is_empty() {
            calls.push((format!("symbols={}", whole_syms.join(",")), whole));
        }
        if !named_syms.is_empty() {
            let mut q = format!("symbols={}&accounts={}", named_syms.join(","), named.accounts.iter().cloned().collect::<Vec<_>>().join(","));
            if !named.orders.is_empty() {
                q.push_str(&format!("&orders={}", named.orders.iter().cloned().collect::<Vec<_>>().join(",")));
            }
            calls.push((q, named));
        }
        for (query, t) in calls {
            if let Some(tx) = self.shadow_snapshot.get() {
                if !t.touches.is_empty() {
                    let _ = tx.send(t.touches.clone());
                }
            }
            self.call(query, t.margin);
        }
    }

    /// GET {url}?{query} (bearer secret), spawned; then, for a margin-triggered call, ask the watch to refresh its book.
    fn call(self: &Arc<Self>, query: String, by_margin: bool) {
        if let Some(rec) = self.recorder.get() {
            let path = self.url.splitn(4, '/').nth(3).map_or(String::new(), |p| format!("/{p}"));
            let _ = rec.send(format!("{path}?{query}"));
            if by_margin {
                if let Some(w) = self.margin_watch.get() {
                    w.evaluated();
                }
            }
            return;
        }
        let hook = Arc::clone(self);
        tokio::spawn(async move {
            let url = format!("{}?{}", hook.url, query);
            match hook.client.get(&url).bearer_auth(&hook.secret).send().await {
                Ok(resp) if resp.status().is_success() => tracing::info!(call = %query, margin = by_margin, "risk hook fired"),
                Ok(resp) => tracing::warn!(status = %resp.status(), "risk hook rejected"),
                Err(err) => tracing::warn!(error = %err, "risk hook failed"),
            }
            if by_margin {
                if let Some(w) = hook.margin_watch.get() {
                    w.evaluated();
                }
            }
        });
    }

    /// Legacy mode: the pre-2026-10-05 behaviour, unchanged (whole symbols, at most one call per symbol per second, a
    /// touch inside that second dropped).
    fn after_flush_legacy(self: &Arc<Self>, ticks: &[Tick], cache: &TickCache, now: chrono::DateTime<chrono::Utc>, at: tokio::time::Instant) {
        let (mut symbols, touches) = self.touched_with_positions(ticks, now);
        // the margin trigger's symbols (targets_to_evaluate at this pass's moment; legacy runs with no near-level band, so
        // every target is a stop-out / margin-call edge, exactly what symbols_to_evaluate returned)
        let margin: Vec<String> = self
            .margin_watch
            .get()
            .map(|w| {
                let mut out: Vec<String> = Vec::new();
                for m in w.targets_to_evaluate(ticks, cache, at.into_std()) {
                    if !out.contains(&m.symbol) {
                        out.push(m.symbol);
                    }
                }
                out
            })
            .unwrap_or_default();
        let by_margin = !margin.is_empty();
        for s in margin {
            if !symbols.contains(&s) {
                symbols.push(s);
            }
        }
        if symbols.is_empty() {
            return;
        }
        {
            let mut last = self.last_fired.lock().unwrap();
            symbols.retain(|s| match last.get(s) {
                Some(t) if at.duration_since(*t) < Duration::from_secs(1) => false,
                _ => {
                    last.insert(s.clone(), at);
                    true
                }
            });
        }
        if symbols.is_empty() {
            return;
        }
        // Stage 5: the SL / TP touches of the symbols actually called, to the shadow as snapshots -- a send, never a
        // wait: the web call below goes out at once whether or not a shadow runs
        if let Some(tx) = self.shadow_snapshot.get() {
            let handed: Vec<SlTpTouch> = touches.into_iter().filter(|t| symbols.contains(&t.symbol)).collect();
            if !handed.is_empty() {
                let _ = tx.send(handed);
            }
        }
        self.call(format!("symbols={}", symbols.join(",")), by_margin);
    }

    /// `VYX_RISK_HOOK_BACKSTOP_SECS` (default 60); None when set to 0 (backstop off).
    pub fn backstop_interval_from_env() -> Option<Duration> {
        let (every, problem) = Self::parse_backstop(std::env::var_os("VYX_RISK_HOOK_BACKSTOP_SECS").map(|v| v.to_string_lossy().into_owned()));
        if let Some(problem) = problem {
            tracing::error!("{problem}");
        }
        every
    }

    /// The backstop interval from the raw env value, plus a message when the value was SET but unusable.
    /// It used to fall back to 60 silently (2026-09-24: a `set` line in start-engine.cmd that did not come
    /// through as a plain number left the backstop at 60 with nothing in the log). Unset = 60, quietly.
    pub fn parse_backstop(raw: Option<String>) -> (Option<Duration>, Option<String>) {
        let Some(raw) = raw else { return (Some(Duration::from_secs(60)), None) };
        match raw.trim().parse::<u64>() {
            Ok(0) => (None, None),
            Ok(secs) => (Some(Duration::from_secs(secs)), None),
            Err(_) => {
                let chars: Vec<String> = raw.chars().map(|c| format!("U+{:04X}", c as u32)).collect();
                (
                    Some(Duration::from_secs(60)),
                    Some(format!(
                        "VYX_RISK_HOOK_BACKSTOP_SECS={raw:?} is not a whole number of seconds (characters: {}); USING 60. Write it as: set VYX_RISK_HOOK_BACKSTOP_SECS=5 (no quotes, no spaces around =, ASCII digits)",
                        chars.join(" ")
                    )),
                )
            }
        }
    }

    /// One full pass: the route without `symbols` evaluates every account holding an open position.
    /// Returns whether the route accepted it.
    pub async fn fire_full_pass(&self) -> bool {
        match self.client.get(&self.url).bearer_auth(&self.secret).send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::debug!("risk hook backstop: full pass ok");
                true
            }
            Ok(resp) => {
                tracing::warn!(status = %resp.status(), "risk hook backstop rejected");
                false
            }
            Err(err) => {
                tracing::warn!(error = %err, "risk hook backstop failed");
                false
            }
        }
    }

    /// The full-book backstop (see the module doc): a full pass every `every`, the first at start, skipped while the
    /// idle gate is closed (crate::activity). Passes are awaited one after another, so a slow route delays the next
    /// instead of piling up.
    pub fn spawn_backstop_loop(self: &Arc<Self>, every: Duration, cache: Arc<TickCache>) {
        let hook = Arc::clone(self);
        tokio::spawn(async move {
            static LOG: GateLog = GateLog::new("risk hook backstop");
            let mut ticker = tokio::time::interval(every);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let book = hook.book_symbols();
                if LOG.observe(activity::book_gate(&cache, book.as_ref(), chrono::Utc::now())) {
                    hook.fire_full_pass().await;
                }
            }
        });
    }

    /// The book gate of what this hook watches (market_data::activity), for the safety-reload cadence.
    pub fn book_gate(&self, cache: &TickCache) -> activity::Gate {
        let book = self.book_symbols();
        activity::book_gate(cache, book.as_ref(), chrono::Utc::now())
    }

    /// Keep the levels current at a fixed safety interval (tests); see spawn_reload_loop_with.
    pub fn spawn_reload_loop(self: &Arc<Self>, pool: PgPool, every: Duration, cache: Arc<TickCache>) {
        self.spawn_reload_loop_with(pool, cache, Arc::new(move || every));
    }

    /// Keep the levels current: a safety reload once `interval()` has passed since the last one while anything ticks
    /// (crate::activity::reload_due; always the first time), and at once on request_reload (a book change announced by
    /// the web, a lost event, a reconnect), whatever the idle gate says. `interval` is re-read every second, so a
    /// cadence change (crate::book_events::safety_interval: 5 s / 10 min) applies within a second.
    pub fn spawn_reload_loop_with(self: &Arc<Self>, pool: PgPool, cache: Arc<TickCache>, interval: Arc<dyn Fn() -> Duration + Send + Sync>) {
        let hook = Arc::clone(self);
        tokio::spawn(async move {
            let mut asked = false;
            let mut last: Option<tokio::time::Instant> = None;
            loop {
                let due = last.is_none_or(|l| l.elapsed() >= interval());
                if asked || !hook.loaded.load(Ordering::Relaxed) || (due && activity::reload_due(&cache, chrono::Utc::now())) {
                    hook.reload(&pool).await;
                    last = Some(tokio::time::Instant::now());
                }
                let nap = interval().min(Duration::from_secs(1));
                asked = tokio::select! {
                    _ = tokio::time::sleep(nap) => false,
                    _ = hook.reload_now.notified() => true,
                };
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use rust_decimal_macros::dec;

    #[test]
    fn pending_entries_trigger_on_the_side_they_trade() {
        let buy_limit = super::PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: true, is_limit: true, entry: dec!(100), ask_rule: None };
        assert!(buy_limit.triggered(dec!(99.8), dec!(100.0)));
        assert!(!buy_limit.triggered(dec!(99.9), dec!(100.1)));
        let buy_stop = super::PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: true, is_limit: false, entry: dec!(100), ask_rule: None };
        assert!(buy_stop.triggered(dec!(99.9), dec!(100.1)));
        assert!(!buy_stop.triggered(dec!(99.7), dec!(99.9)));
        let sell_limit = super::PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: false, is_limit: true, entry: dec!(100), ask_rule: None };
        assert!(sell_limit.triggered(dec!(100.0), dec!(100.2)));
        assert!(!sell_limit.triggered(dec!(99.9), dec!(100.1)));
        let sell_stop = super::PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: false, is_limit: false, entry: dec!(100), ask_rule: None };
        assert!(sell_stop.triggered(dec!(99.9), dec!(100.1)));
        assert!(!sell_stop.triggered(dec!(100.1), dec!(100.3)));
    }

    #[test]
    fn a_buy_entry_triggers_on_its_account_ask_a_sell_entry_on_the_raw_bid() {
        use crate::ask_markup::AskRule;
        // +1.5 pips on a 2-digit symbol = +0.15
        let rule = Some(AskRule::Markup { markup_pips: dec!(1.5), digits: 2 });
        // BUY STOP at 100.10: raw ask 100.00 has not reached it, the account ask 100.15 has
        let buy_stop = super::PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: true, is_limit: false, entry: dec!(100.10), ask_rule: rule };
        assert!(buy_stop.triggered(dec!(99.90), dec!(100.00)));
        // BUY LIMIT at 100.00: raw ask 99.95 would fill it raw; the account ask 100.10 is above the entry
        let buy_limit = super::PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: true, is_limit: true, entry: dec!(100.00), ask_rule: rule };
        assert!(!buy_limit.triggered(dec!(99.80), dec!(99.95)));
        // a SELL entry never reads the ask
        let sell_stop = super::PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: false, is_limit: false, entry: dec!(99.90), ask_rule: rule };
        assert!(!sell_stop.triggered(dec!(99.95), dec!(100.00)));
    }

    #[test]
    fn a_sell_level_is_touched_at_its_account_ask() {
        use crate::ask_markup::AskRule;
        let h = hook("http://127.0.0.1:1/x".into());
        // SELL SL at 4299.25: raw ask 4299.13 has not reached it, the account ask 4299.28 (+1.5 pips) has
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![Level { position_id: "p1".into(), account_id: "a1".into(), is_buy: false, sl: Some(dec!(4299.25)), tp: None, ask_rule: Some(AskRule::Markup { markup_pips: dec!(1.5), digits: 2 }) }]);
        let t: Tick = serde_json::from_value(serde_json::json!({ "symbol": "XAUUSD", "bid": "4298.96", "ask": "4299.13" })).unwrap();
        assert_eq!(h.touched(std::slice::from_ref(&t)), vec!["XAUUSD".to_string()]);
        // the same level on the raw ask (no rule) is not touched
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![Level { position_id: "p1".into(), account_id: "a1".into(), is_buy: false, sl: Some(dec!(4299.25)), tp: None, ask_rule: None }]);
        assert!(h.touched(std::slice::from_ref(&t)).is_empty());
    }

    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    /// A one-route HTTP server that records each request's first line + authorization header
    /// and answers `status`.
    async fn mock_route(status: u16) -> (String, mpsc::UnboundedReceiver<(String, String)>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/internal/margin-monitor", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let line = req.lines().next().unwrap_or("").to_string();
                    let auth = req
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().starts_with("authorization:").then(|| l[14..].trim().to_string()))
                        .unwrap_or_default();
                    let _ = tx.send((line, auth));
                    let body = "{}";
                    let resp = format!("HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (url, rx)
    }

    fn hook(url: String) -> Arc<RiskHook> {
        Arc::new(RiskHook {
            url,
            secret: "s3cret".into(),
            client: reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap(),
            levels: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            last_fired: Mutex::new(HashMap::new()),
            margin_watch: std::sync::OnceLock::new(),
            loaded: AtomicBool::new(false),
            shadow_snapshot: std::sync::OnceLock::new(),
            reload_now: Notify::new(),
            pricing: std::sync::OnceLock::new(),
            reload_count: std::sync::atomic::AtomicU64::new(0),
            policy: HookPolicy { targeted: false, ..HookPolicy::default() },
            queues: Mutex::new(HashMap::new()),
            retries: Mutex::new(HashMap::new()),
            recorder: std::sync::OnceLock::new(),
        })
    }

    /// A cache with one tick of `symbol` received `age_secs` ago.
    fn cache_ticked(symbol: &str, age_secs: i64) -> Arc<TickCache> {
        let c = TickCache::new();
        c.set(&tick(symbol), chrono::Utc::now() - chrono::Duration::seconds(age_secs));
        Arc::new(c)
    }

    #[test]
    fn a_backstop_value_that_is_set_but_not_a_number_is_reported_not_silently_60() {
        let p = |v: &str| RiskHook::parse_backstop(Some(v.to_string()));
        assert_eq!(RiskHook::parse_backstop(None), (Some(Duration::from_secs(60)), None));
        assert_eq!(p("5"), (Some(Duration::from_secs(5)), None));
        assert_eq!(p(" 5 \r"), (Some(Duration::from_secs(5)), None));
        assert_eq!(p("0"), (None, None));
        for bad in ["\"5\"", "5s", "\u{6F5}", "5\u{A0}x", ""] {
            let (every, problem) = p(bad);
            assert_eq!(every, Some(Duration::from_secs(60)), "{bad:?}");
            let msg = problem.unwrap_or_else(|| panic!("{bad:?} must be reported"));
            assert!(msg.contains("USING 60") && msg.contains("VYX_RISK_HOOK_BACKSTOP_SECS="), "{msg}");
        }
        // the character dump shows what the eye cannot: an Arabic-Indic five
        assert!(p("\u{6F5}").1.unwrap().contains("U+06F5"));
    }

    struct StubWatch {
        symbols: Vec<String>,
        evaluated: std::sync::atomic::AtomicUsize,
    }

    impl MarginWatch for StubWatch {
        fn symbols_to_evaluate(&self, _flushed: &[Tick], _cache: &TickCache) -> Vec<String> {
            self.symbols.clone()
        }
        fn evaluated(&self) {
            self.evaluated.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn tick(symbol: &str) -> Tick {
        serde_json::from_value(serde_json::json!({ "symbol": symbol, "bid": "4280", "ask": "4280.3" })).unwrap()
    }

    #[tokio::test]
    async fn a_margin_trigger_fires_the_symbol_without_any_sl_tp_and_then_asks_for_a_reload() {
        let (url, mut rx) = mock_route(200).await;
        let h = hook(url);
        let watch = Arc::new(StubWatch { symbols: vec!["XAUUSD".into()], evaluated: Default::default() });
        h.set_margin_watch(watch.clone());
        // no SL / TP levels at all: only the margin watch can fire this
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));
        let (line, auth) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("fired").unwrap();
        assert_eq!(line, "GET /api/internal/margin-monitor?symbols=XAUUSD HTTP/1.1");
        assert_eq!(auth, "Bearer s3cret");
        for _ in 0..50 {
            if watch.evaluated.load(std::sync::atomic::Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(watch.evaluated.load(std::sync::atomic::Ordering::SeqCst), 1);
        // the per-symbol limit still holds: a second flush within the second does not call again
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));
        assert!(tokio::time::timeout(Duration::from_millis(300), rx.recv()).await.is_err());
    }

    /// A heartbeat resend of a quote that has not moved for 15 s is not evaluated (a closed market's frozen quote beyond a
    /// level used to re-fire the web and the shadow on every heartbeat); the same tick with a quote that moved just now is.
    #[tokio::test]
    async fn a_heartbeat_of_a_quote_frozen_beyond_a_level_does_not_re_fire() {
        let (url, mut rx) = mock_route(200).await;
        let h = hook(url);
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![lvl("pos-1", "acc-1", false, Some(dec!(4280.2)), None, None)]);
        let watch = Arc::new(StubWatch { symbols: vec!["XAUUSD".into()], evaluated: Default::default() });
        h.set_margin_watch(watch);
        let (tx, mut shadow) = tokio::sync::mpsc::unbounded_channel::<Vec<SlTpTouch>>();
        h.set_shadow_snapshot(tx);
        // the quote last moved 20 s ago; the resend arrives now (no tick_ms: the arrival time)
        let frozen = cache_ticked("XAUUSD", 20);
        frozen.set(&tick("XAUUSD"), chrono::Utc::now());
        h.after_flush(&[tick("XAUUSD")], &frozen);
        assert!(tokio::time::timeout(Duration::from_millis(300), rx.recv()).await.is_err(), "frozen: no web call");
        assert!(shadow.try_recv().is_err(), "frozen: no shadow evaluation");
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));
        tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.expect("a moving quote fires").unwrap();
        assert!(shadow.try_recv().is_ok());
    }

    /// The gate is v*-blind (86a4adc): a book holding only v* never opens the timers. The FIRES still evaluate it: a
    /// moving v* quote that touches an SL calls the web, snapshots the shadow and runs the margin trigger.
    #[tokio::test]
    async fn a_moving_synthetic_quote_still_fires_although_it_never_opens_a_gate() {
        let (url, mut rx) = mock_route(200).await;
        let h = hook(url);
        h.levels.lock().unwrap().insert("vGOLD".into(), vec![lvl("pos-v", "acc-v", false, Some(dec!(4280.2)), None, None)]);
        let watch = Arc::new(StubWatch { symbols: vec!["vGOLD".into()], evaluated: Default::default() });
        h.set_margin_watch(watch.clone());
        let (tx, mut shadow) = tokio::sync::mpsc::unbounded_channel::<Vec<SlTpTouch>>();
        h.set_shadow_snapshot(tx);
        let cache = cache_ticked("vGOLD", 0);
        let book: std::collections::HashSet<String> = ["vGOLD".to_string()].into();
        assert_eq!(crate::activity::book_gate(&cache, Some(&book), chrono::Utc::now()), crate::activity::Gate::FeedQuiet, "v* never opens a timer");
        assert!(!crate::activity::reload_due(&cache, chrono::Utc::now()));
        h.after_flush(&[tick("vGOLD")], &cache);
        let (line, _) = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.expect("the v* touch fires the web").unwrap();
        assert!(line.contains("symbols=vGOLD"), "{line}");
        let touches = shadow.try_recv().expect("the v* touch is snapshotted for the shadow");
        assert_eq!(touches[0].position_id, "pos-v");
        for _ in 0..50 {
            if watch.evaluated.load(std::sync::atomic::Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(watch.evaluated.load(std::sync::atomic::Ordering::SeqCst), 1, "the margin trigger evaluated vGOLD");
    }

    #[tokio::test]
    async fn without_a_margin_watch_or_a_touched_level_nothing_fires() {
        let (url, mut rx) = mock_route(200).await;
        hook(url).after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));
        assert!(tokio::time::timeout(Duration::from_millis(300), rx.recv()).await.is_err());
    }

    #[tokio::test]
    async fn full_pass_calls_the_route_without_symbols_with_the_bearer_secret() {
        let (url, mut rx) = mock_route(200).await;
        assert!(hook(url).fire_full_pass().await);
        let (line, auth) = rx.recv().await.unwrap();
        // no ?symbols= -> the route's full-book branch (every account with an open position)
        assert_eq!(line, "GET /api/internal/margin-monitor HTTP/1.1");
        assert_eq!(auth, "Bearer s3cret");
    }

    #[tokio::test]
    async fn a_rejected_or_unreachable_full_pass_reports_false_and_does_not_panic() {
        let (url, _rx) = mock_route(401).await;
        assert!(!hook(url).fire_full_pass().await);
        assert!(!hook("http://127.0.0.1:1/api/internal/margin-monitor".into()).fire_full_pass().await);
    }

    #[tokio::test]
    async fn the_backstop_loop_fires_at_start_and_then_on_every_interval_without_a_cron() {
        let (url, mut rx) = mock_route(200).await;
        let started = Instant::now();
        hook(url).spawn_backstop_loop(Duration::from_millis(300), cache_ticked("XAUUSD", 0));
        for _ in 0..3 {
            let (line, _) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("backstop pass").unwrap();
            assert!(!line.contains("symbols"), "{line}");
        }
        // first pass immediately, then one per 300 ms: three passes take ~600 ms, not three at once
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(550) && took < Duration::from_secs(3), "{took:?}");
    }

    #[tokio::test]
    async fn a_failing_route_does_not_stop_the_backstop_loop() {
        let (url, mut rx) = mock_route(500).await;
        hook(url).spawn_backstop_loop(Duration::from_millis(100), cache_ticked("XAUUSD", 0));
        for _ in 0..3 {
            tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("loop kept running").unwrap();
        }
    }

    #[tokio::test]
    async fn the_backstop_skips_while_the_feed_is_quiet() {
        let (url, mut rx) = mock_route(200).await;
        // the last XAUUSD tick is a weekend-old heartbeat: nothing can be decided, so nothing is asked
        hook(url).spawn_backstop_loop(Duration::from_millis(50), cache_ticked("XAUUSD", 3600));
        assert!(tokio::time::timeout(Duration::from_millis(400), rx.recv()).await.is_err());
    }

    #[test]
    fn the_idle_gate_header_says_whether_the_book_can_move() {
        let now = chrono::Utc::now();
        let h = hook("http://127.0.0.1:1/x".into());
        // no margin trigger: the book is unknown
        assert_eq!(h.idle_gate_header(&cache_ticked("XAUUSD", 0), now), "unknown");
        let unloaded = hook("http://127.0.0.1:1/x".into());
        unloaded.set_margin_watch(Arc::new(BookWatch(None)));
        assert_eq!(unloaded.idle_gate_header(&cache_ticked("XAUUSD", 0), now), "unknown");
        // flat book while something ticks
        let flat = hook("http://127.0.0.1:1/x".into());
        flat.set_margin_watch(Arc::new(BookWatch(Some(HashSet::new()))));
        assert_eq!(flat.idle_gate_header(&cache_ticked("BTCUSD", 0), now), "flat-book");
        // the book holds XAUUSD, only BTCUSD ticks (a crypto weekend)
        let held = hook("http://127.0.0.1:1/x".into());
        held.set_margin_watch(Arc::new(BookWatch(Some(["XAUUSD".to_string()].into()))));
        let c = TickCache::new();
        c.set(&tick("BTCUSD"), now);
        c.set(&tick("XAUUSD"), now - chrono::Duration::hours(40));
        assert_eq!(held.idle_gate_header(&c, now), "book-closed");
        // nothing ticks at all
        assert_eq!(held.idle_gate_header(&cache_ticked("XAUUSD", 3600), now), "feed-quiet");
        // the held symbol ticks
        assert_eq!(held.idle_gate_header(&cache_ticked("XAUUSD", 1), now), "running");
        // a resting order's symbol counts as held
        let pend = hook("http://127.0.0.1:1/x".into());
        pend.set_margin_watch(Arc::new(BookWatch(Some(HashSet::new()))));
        pend.pending.lock().unwrap().insert("BTCUSD".into(), vec![PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: true, is_limit: true, entry: Decimal::ONE, ask_rule: None }]);
        assert_eq!(pend.idle_gate_header(&cache_ticked("BTCUSD", 0), now), "running");
    }

    struct BookWatch(Option<HashSet<String>>);
    impl MarginWatch for BookWatch {
        fn symbols_to_evaluate(&self, _flushed: &[Tick], _cache: &TickCache) -> Vec<String> {
            Vec::new()
        }
        fn evaluated(&self) {}
        fn book_symbols(&self) -> Option<HashSet<String>> {
            self.0.clone()
        }
    }

    #[tokio::test]
    async fn the_backstop_skips_a_flat_book_and_a_book_whose_symbols_are_stale() {
        let (url, mut rx) = mock_route(200).await;
        // flat: the watch has loaded an empty book, no resting order
        let flat = hook(url.clone());
        flat.set_margin_watch(Arc::new(BookWatch(Some(HashSet::new()))));
        flat.spawn_backstop_loop(Duration::from_millis(50), cache_ticked("BTCUSD", 0));
        // closed: the book holds XAUUSD, only BTCUSD ticks (a crypto weekend)
        let closed = hook(url.clone());
        closed.set_margin_watch(Arc::new(BookWatch(Some(["XAUUSD".to_string()].into()))));
        let c = TickCache::new();
        c.set(&tick("BTCUSD"), chrono::Utc::now());
        c.set(&tick("XAUUSD"), chrono::Utc::now() - chrono::Duration::hours(40));
        closed.spawn_backstop_loop(Duration::from_millis(50), Arc::new(c));
        assert!(tokio::time::timeout(Duration::from_millis(400), rx.recv()).await.is_err());
        // a resting order on a ticking symbol reopens the gate even with no position open
        let pending = hook(url);
        pending.set_margin_watch(Arc::new(BookWatch(Some(HashSet::new()))));
        pending.pending.lock().unwrap().insert("BTCUSD".into(), vec![PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: true, is_limit: true, entry: Decimal::ONE, ask_rule: None }]);
        pending.spawn_backstop_loop(Duration::from_millis(50), cache_ticked("BTCUSD", 0));
        let (line, _) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("pass").unwrap();
        assert!(!line.contains("symbols"), "{line}");
    }

    /// The weekend of 3-4 Oct 2026: closed metals held (with an SL level), gold's frozen Friday quote resent every 5 s by
    /// the feed in every shape it can take (no tick_ms, a future-dated tick_ms, two feeds), crypto and v* really moving.
    /// The backstop must not call the web once.
    #[tokio::test]
    async fn a_weekend_of_gold_heartbeats_makes_zero_backstop_calls() {
        let (url, mut rx) = mock_route(200).await;
        let now = chrono::Utc::now();
        let friday = now - chrono::Duration::hours(40);
        let gold = |tick_ms: Option<i64>, offset: Option<i64>| -> Tick {
            serde_json::from_value(serde_json::json!({ "symbol": "XAUUSD", "bid": "3871.20", "ask": "3871.45", "tick_ms": tick_ms, "broker_offset_sec": offset })).unwrap()
        };
        let c = TickCache::new();
        let first = gold(Some(friday.timestamp_millis()), Some(0));
        c.set(&first, crate::ingest::resolve_tick_time(&first, friday));
        for (i, back) in [20i64, 15, 10, 5, 0].into_iter().enumerate() {
            let at = now - chrono::Duration::seconds(back);
            let hb = match i % 3 {
                0 => gold(None, None),
                1 => gold(Some(friday.timestamp_millis() + 3 * 3_600_000), Some(-3 * 3600)),
                _ => gold(Some(friday.timestamp_millis()), Some(0)),
            };
            c.set(&hb, crate::ingest::resolve_tick_time(&hb, at));
            for (k, sym) in ["BTCUSD", "vGOLD"].into_iter().enumerate() {
                let bid = Decimal::from(60_000 + i as i64 * 10 + k as i64);
                let t: Tick = serde_json::from_value(serde_json::json!({ "symbol": sym, "bid": bid, "ask": bid + Decimal::ONE, "tick_ms": at.timestamp_millis() })).unwrap();
                c.set(&t, crate::ingest::resolve_tick_time(&t, at));
            }
        }
        let h = hook(url);
        h.set_margin_watch(Arc::new(BookWatch(Some(["XAUUSD".to_string()].into()))));
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![lvl("p1", "a1", true, Some(dec!(3800)), None, None)]);
        let c = Arc::new(c);
        assert_eq!(h.book_gate(&c), activity::Gate::BookClosed);
        assert_eq!(h.idle_gate_header(&c, chrono::Utc::now()), "book-closed", "the web's cron is told to skip too");
        h.spawn_backstop_loop(Duration::from_millis(50), c);
        assert!(tokio::time::timeout(Duration::from_millis(500), rx.recv()).await.is_err(), "no backstop call on a closed weekend");
    }

    #[tokio::test]
    async fn an_unloaded_book_is_unknown_so_only_a_quiet_feed_skips() {
        let (url, mut rx) = mock_route(200).await;
        let h = hook(url);
        h.set_margin_watch(Arc::new(BookWatch(None)));
        h.spawn_backstop_loop(Duration::from_millis(50), cache_ticked("XAUUSD", 0));
        tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("pass").unwrap();
    }

    fn lvl(position: &str, account: &str, is_buy: bool, sl: Option<Decimal>, tp: Option<Decimal>, ask_rule: Option<AskRule>) -> Level {
        Level { position_id: position.into(), account_id: account.into(), is_buy, sl, tp, ask_rule }
    }

    #[test]
    fn a_touch_is_snapshotted_with_its_position_account_and_tick() {
        let h = hook("http://127.0.0.1:1/x".into());
        h.levels.lock().unwrap().insert(
            "XAUUSD".into(),
            vec![
                lvl("p-buy-sl", "a1", true, Some(dec!(4299.00)), None, None),             // bid 4298.96 <= 4299.00: hit
                lvl("p-buy-tp", "a2", true, None, Some(dec!(4298.90)), None),             // bid >= 4298.90: hit
                lvl("p-buy-far", "a3", true, Some(dec!(4290)), Some(dec!(4310)), None),   // neither
                lvl("p-sell-sl", "a1", false, Some(dec!(4299.10)), None, None),           // raw ask 4299.13 >= 4299.10: hit
                lvl("p-sell-tp", "a4", false, None, Some(dec!(4299.20)), None),           // raw ask <= 4299.20: hit
                lvl("p-sell-far", "a5", false, Some(dec!(4300)), Some(dec!(4290)), None),
                // the account ask rule: 4299.13 + 0.15 = 4299.28 >= SL 4299.25 (the raw ask would not reach it)
                lvl("p-sell-markup", "a6", false, Some(dec!(4299.25)), None, Some(AskRule::Markup { markup_pips: dec!(1.5), digits: 2 })),
            ],
        );
        // a resting order on another symbol: touched as a symbol, never snapshotted
        h.pending.lock().unwrap().insert("EURUSD".into(), vec![PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: false, is_limit: true, entry: dec!(1.1), ask_rule: None }]);
        let gold: Tick = serde_json::from_value(serde_json::json!({ "symbol": "XAUUSD", "bid": "4298.96", "ask": "4299.13", "tick_ms": 1_790_000_000_000i64 })).unwrap();
        let eur: Tick = serde_json::from_value(serde_json::json!({ "symbol": "EURUSD", "bid": "1.2", "ask": "1.2001" })).unwrap();
        let now = chrono::Utc::now();
        let (symbols, touches) = h.touched_with_positions(&[gold, eur], now);
        assert_eq!(symbols, vec!["XAUUSD".to_string(), "EURUSD".to_string()]);
        let names: Vec<(&str, &str)> = touches.iter().map(|t| (t.position_id.as_str(), t.account_id.as_str())).collect();
        assert_eq!(names, vec![("p-buy-sl", "a1"), ("p-buy-tp", "a2"), ("p-sell-sl", "a1"), ("p-sell-tp", "a4"), ("p-sell-markup", "a6")]);
        let t = &touches[0];
        assert_eq!((t.symbol.as_str(), t.bid, t.ask, t.at), ("XAUUSD", dec!(4298.96), dec!(4299.13), now));
        assert_eq!(t.tick_at, chrono::DateTime::from_timestamp_millis(1_790_000_000_000).unwrap(), "the tick's own time");
    }

    #[tokio::test]
    async fn an_sl_touch_is_handed_to_the_shadow_and_the_web_is_called_without_waiting() {
        let (url, mut rx) = mock_route(200).await;
        let h = hook(url);
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![lvl("pos-1", "acc-1", false, Some(dec!(4280.2)), None, None)]);
        // the shadow side of the channel is NEVER read in this test: nothing may wait for it
        let (tx, mut shadow) = tokio::sync::mpsc::unbounded_channel::<Vec<SlTpTouch>>();
        h.set_shadow_snapshot(tx);
        let started = Instant::now();
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0)); // ask 4280.3 >= SL 4280.2
        let (line, _) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("web called").unwrap();
        assert_eq!(line, "GET /api/internal/margin-monitor?symbols=XAUUSD HTTP/1.1");
        assert!(started.elapsed() < Duration::from_millis(500), "the web call went out at once: {:?}", started.elapsed());
        let handed = shadow.try_recv().expect("the snapshot was handed to the shadow");
        assert_eq!(handed.len(), 1);
        assert_eq!((handed[0].position_id.as_str(), handed[0].account_id.as_str(), handed[0].ask), ("pos-1", "acc-1", dec!(4280.3)));
    }

    #[tokio::test]
    async fn a_resting_order_trigger_is_not_snapshotted() {
        let (url, mut rx) = mock_route(200).await;
        let h = hook(url);
        h.pending.lock().unwrap().insert("XAUUSD".into(), vec![PendingLevel { order_id: "o".into(), account_id: "a".into(), is_buy: false, is_limit: true, entry: dec!(4270), ask_rule: None }]);
        let (tx, mut shadow) = tokio::sync::mpsc::unbounded_channel::<Vec<SlTpTouch>>();
        h.set_shadow_snapshot(tx);
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0)); // bid 4280 >= SELL LIMIT 4270
        tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.expect("web called at once").unwrap();
        assert!(shadow.try_recv().is_err(), "no snapshot for a resting order");
    }

    #[tokio::test]
    async fn a_rate_limited_symbol_is_not_snapshotted_twice() {
        let (url, mut rx) = mock_route(200).await;
        let h = hook(url);
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![lvl("pos-1", "acc-1", false, Some(dec!(4280.2)), None, None)]);
        let (tx, mut shadow) = tokio::sync::mpsc::unbounded_channel::<Vec<SlTpTouch>>();
        h.set_shadow_snapshot(tx);
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0)); // inside the per-symbol 1 s limit: no call, no snapshot
        tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.expect("web called").unwrap();
        assert!(shadow.try_recv().is_ok());
        assert!(shadow.try_recv().is_err(), "one snapshot per call");
    }

    /// Manual e2e: a real margin-monitor route (local `next dev` on a scratch DB) and nothing but the
    /// backstop loop driving it -- no cron, no tick. Run with VYX_RISK_HOOK_URL / VYX_RISK_HOOK_SECRET
    /// set and `-- --ignored`; the caller checks the DB afterwards.
    #[tokio::test]
    #[ignore]
    async fn e2e_backstop_drives_a_real_margin_monitor_route() {
        let hook = RiskHook::from_env().expect("VYX_RISK_HOOK_URL / VYX_RISK_HOOK_SECRET");
        hook.spawn_backstop_loop(Duration::from_secs(5), cache_ticked("XAUUSD", 0));
        tokio::time::sleep(Duration::from_secs(12)).await;
        // the route still accepts the backstop's auth after the loop's own passes
        assert!(hook.fire_full_pass().await);
    }

    #[test]
    fn backstop_interval_env_defaults_to_60s_and_zero_turns_it_off() {
        std::env::remove_var("VYX_RISK_HOOK_BACKSTOP_SECS");
        assert_eq!(RiskHook::backstop_interval_from_env(), Some(Duration::from_secs(60)));
        std::env::set_var("VYX_RISK_HOOK_BACKSTOP_SECS", "0");
        assert_eq!(RiskHook::backstop_interval_from_env(), None);
        std::env::set_var("VYX_RISK_HOOK_BACKSTOP_SECS", "15");
        assert_eq!(RiskHook::backstop_interval_from_env(), Some(Duration::from_secs(15)));
        std::env::set_var("VYX_RISK_HOOK_BACKSTOP_SECS", "junk");
        assert_eq!(RiskHook::backstop_interval_from_env(), Some(Duration::from_secs(60)));
        std::env::remove_var("VYX_RISK_HOOK_BACKSTOP_SECS");
    }

    // ---- targeted calls (2026-10-05) -------------------------------------------------------------------------------

    fn targeted() -> (Arc<RiskHook>, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let h = RiskHook::with_policy("http://engine.test/api/internal/margin-monitor".into(), "s".into(), Duration::from_secs(1), HookPolicy::default()).unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        h.set_recorder(tx);
        (h, rx)
    }

    fn quote(symbol: &str, bid: &str, ask: &str) -> Tick {
        serde_json::from_value(serde_json::json!({ "symbol": symbol, "bid": bid, "ask": ask })).unwrap()
    }

    /// The tick, in a cache where it just moved (a live market).
    fn flushed(t: &Tick) -> TickCache {
        let c = TickCache::new();
        c.set(t, chrono::Utc::now());
        c
    }

    fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(c) = rx.try_recv() {
            out.push(c);
        }
        out
    }

    fn spec(symbol: &str, position: &str, account: &str, is_buy: bool, sl: Option<Decimal>) -> LevelSpec {
        LevelSpec { symbol: symbol.into(), position_id: position.into(), account_id: account.into(), is_buy, sl, tp: None, ask_rule: None }
    }

    struct Targets(Vec<MarginTarget>);
    impl MarginWatch for Targets {
        fn symbols_to_evaluate(&self, _flushed: &[Tick], _cache: &TickCache) -> Vec<String> {
            Vec::new()
        }
        fn targets_to_evaluate(&self, _flushed: &[Tick], _cache: &TickCache, _now: Instant) -> Vec<MarginTarget> {
            self.0.clone()
        }
        fn evaluated(&self) {}
    }

    #[test]
    fn the_hook_policy_env_defaults_to_targeted_1_s_and_reports_a_bad_value() {
        assert_eq!(HookPolicy::parse(None, None), (HookPolicy::default(), vec![]));
        assert!(HookPolicy::default().targeted);
        assert_eq!(HookPolicy::parse(Some("0".into()), Some("500".into())).0, HookPolicy { targeted: false, coalesce: Duration::from_millis(500), ..HookPolicy::default() });
        let (p, problems) = HookPolicy::parse(Some("off".into()), Some("1s".into()));
        assert_eq!(p, HookPolicy::default());
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert_eq!(HookPolicy::default().backoff(1), Duration::from_secs(1));
        assert_eq!(HookPolicy::default().backoff(3), Duration::from_secs(4));
        assert_eq!(HookPolicy::default().backoff(9), Duration::from_secs(30));
    }

    #[tokio::test(start_paused = true)]
    async fn an_sl_touch_names_its_account_and_goes_out_at_once_with_its_snapshot() {
        let (h, mut rx) = targeted();
        let (stx, mut shadow) = tokio::sync::mpsc::unbounded_channel::<Vec<SlTpTouch>>();
        h.set_shadow_snapshot(stx);
        h.replace_book(vec![spec("XAUUSD", "pos-1", "acc-1", true, Some(dec!(4280))), spec("XAUUSD", "pos-2", "acc-2", true, Some(dec!(4000)))], vec![]);
        let t = quote("XAUUSD", "4279", "4279.3");
        h.after_flush_at(&[t.clone()], &flushed(&t), tokio::time::Instant::now());
        assert_eq!(drain(&mut rx), vec!["/api/internal/margin-monitor?symbols=XAUUSD&accounts=acc-1".to_string()]);
        let snap = shadow.try_recv().expect("snapshot");
        assert_eq!(snap.iter().map(|s| s.position_id.as_str()).collect::<Vec<_>>(), vec!["pos-1"]);
    }

    /// The old one-per-second limit DROPPED a second touch inside the second; now it is held and sent at the window's end.
    #[tokio::test(start_paused = true)]
    async fn a_second_touch_inside_the_window_is_sent_at_its_end_never_dropped() {
        let (h, mut rx) = targeted();
        h.replace_book(vec![spec("XAUUSD", "pos-1", "acc-1", true, Some(dec!(4280))), spec("XAUUSD", "pos-2", "acc-2", true, Some(dec!(4278)))], vec![]);
        let t0 = tokio::time::Instant::now();
        let a = quote("XAUUSD", "4279", "4279.3");
        h.after_flush_at(&[a.clone()], &flushed(&a), t0);
        tokio::time::advance(Duration::from_millis(300)).await;
        let b = quote("XAUUSD", "4277", "4277.3");
        h.after_flush_at(&[b.clone()], &flushed(&b), t0 + Duration::from_millis(300));
        assert_eq!(drain(&mut rx), vec!["/api/internal/margin-monitor?symbols=XAUUSD&accounts=acc-1".to_string()], "the second waits");
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert_eq!(drain(&mut rx), vec!["/api/internal/margin-monitor?symbols=XAUUSD&accounts=acc-2".to_string()], "trailing call at the window's end");
    }

    #[tokio::test(start_paused = true)]
    async fn a_touch_that_stays_touched_is_re_sent_with_backoff_not_every_second_and_resets_once_released() {
        let (h, mut rx) = targeted();
        h.replace_book(vec![spec("EURUSD", "pos-1", "acc-1", true, Some(dec!(1.1)))], vec![]);
        let t0 = tokio::time::Instant::now();
        let below = quote("EURUSD", "1.0999", "1.1001");
        let mut sent_at = Vec::new();
        // 20 s of 4 ticks a second, every one of them still beyond the SL (the web refuses the close)
        for step in 0..80u64 {
            let at = t0 + Duration::from_millis(step * 250);
            tokio::time::advance(if step == 0 { Duration::ZERO } else { Duration::from_millis(250) }).await;
            h.after_flush_at(&[below.clone()], &flushed(&below), at);
            tokio::task::yield_now().await;
            if !drain(&mut rx).is_empty() {
                sent_at.push(step * 250);
            }
        }
        // at once, then 1, 2, 4, 8 s after each previous send
        assert_eq!(sent_at, vec![0, 1000, 3000, 7000, 15000], "{sent_at:?}");
        // released (a tick above the SL), then touched again: a new touch, sent at once
        let above = quote("EURUSD", "1.1005", "1.1007");
        let at = t0 + Duration::from_millis(20_000);
        h.after_flush_at(&[above.clone()], &flushed(&above), at);
        tokio::time::advance(Duration::from_millis(1250)).await;
        h.after_flush_at(&[below.clone()], &flushed(&below), at + Duration::from_millis(1250));
        tokio::task::yield_now().await;
        assert_eq!(drain(&mut rx).len(), 1, "a new touch after a release goes out at once");
    }

    #[tokio::test(start_paused = true)]
    async fn a_crossed_resting_order_is_named_by_id_with_no_account_evaluation() {
        let (h, mut rx) = targeted();
        let order = PendingSpec { symbol: "EURUSD".into(), order_id: "ord-1".into(), account_id: "acc-9".into(), is_buy: false, is_limit: true, entry: dec!(1.1), ask_rule: None };
        h.replace_book(vec![], vec![order]);
        let t = quote("EURUSD", "1.1001", "1.1003");
        h.after_flush_at(&[t.clone()], &flushed(&t), tokio::time::Instant::now());
        assert_eq!(drain(&mut rx), vec!["/api/internal/margin-monitor?symbols=EURUSD&accounts=&orders=ord-1".to_string()]);
    }

    #[tokio::test(start_paused = true)]
    async fn an_urgent_margin_target_never_waits_for_the_window_and_takes_the_queue_along() {
        let (h, mut rx) = targeted();
        h.replace_book(vec![spec("XAUUSD", "pos-1", "acc-1", true, Some(dec!(4280))), spec("XAUUSD", "pos-2", "acc-2", true, Some(dec!(4278)))], vec![]);
        let t0 = tokio::time::Instant::now();
        let a = quote("XAUUSD", "4279", "4279.3");
        h.after_flush_at(&[a.clone()], &flushed(&a), t0);
        assert_eq!(drain(&mut rx).len(), 1);
        // 250 ms later: a second SL touch (queued) and an account at its stop-out (urgent)
        h.set_margin_watch(Arc::new(Targets(vec![MarginTarget { account_id: "acc-so".into(), symbol: "XAUUSD".into(), urgent: true }])));
        tokio::time::advance(Duration::from_millis(250)).await;
        let b = quote("XAUUSD", "4277", "4277.3");
        h.after_flush_at(&[b.clone()], &flushed(&b), t0 + Duration::from_millis(250));
        assert_eq!(drain(&mut rx), vec!["/api/internal/margin-monitor?symbols=XAUUSD&accounts=acc-2,acc-so".to_string()], "on the trigger pass, not 750 ms later");
    }

    #[tokio::test(start_paused = true)]
    async fn a_margin_trigger_that_names_no_account_evaluates_the_whole_symbol() {
        let (h, mut rx) = targeted();
        h.set_margin_watch(Arc::new(StubWatch { symbols: vec!["XAUUSD".into()], evaluated: Default::default() }));
        let t = quote("XAUUSD", "4279", "4279.3");
        h.after_flush_at(&[t.clone()], &flushed(&t), tokio::time::Instant::now());
        assert_eq!(drain(&mut rx), vec!["/api/internal/margin-monitor?symbols=XAUUSD".to_string()]);
    }

    #[tokio::test(start_paused = true)]
    async fn more_accounts_than_one_call_names_falls_back_to_the_whole_symbol() {
        let (h, mut rx) = targeted();
        let many: Vec<MarginTarget> = (0..=MAX_TARGETS_PER_CALL).map(|i| MarginTarget { account_id: format!("acc-{i}"), symbol: "XAUUSD".into(), urgent: true }).collect();
        h.set_margin_watch(Arc::new(Targets(many)));
        let t = quote("XAUUSD", "4279", "4279.3");
        h.after_flush_at(&[t.clone()], &flushed(&t), tokio::time::Instant::now());
        assert_eq!(drain(&mut rx), vec!["/api/internal/margin-monitor?symbols=XAUUSD".to_string()]);
    }

    #[tokio::test(start_paused = true)]
    async fn legacy_mode_keeps_the_old_whole_symbol_once_a_second_behaviour() {
        let h = RiskHook::with_policy("http://engine.test/api/internal/margin-monitor".into(), "s".into(), Duration::from_secs(1), HookPolicy { targeted: false, ..HookPolicy::default() }).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        h.set_recorder(tx);
        h.replace_book(vec![spec("XAUUSD", "pos-1", "acc-1", true, Some(dec!(4280))), spec("XAUUSD", "pos-2", "acc-2", true, Some(dec!(4278)))], vec![]);
        let t0 = tokio::time::Instant::now();
        let a = quote("XAUUSD", "4279", "4279.3");
        h.after_flush_at(&[a.clone()], &flushed(&a), t0);
        let b = quote("XAUUSD", "4277", "4277.3");
        h.after_flush_at(&[b.clone()], &flushed(&b), t0 + Duration::from_millis(300));
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert_eq!(drain(&mut rx), vec!["/api/internal/margin-monitor?symbols=XAUUSD".to_string()], "one call, the second touch dropped (the old rule)");
    }
}
