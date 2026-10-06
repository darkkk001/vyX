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

/// The per-tick margin trigger (see the module doc). Pure in-memory on the flush path: no I/O.
pub trait MarginWatch: Send + Sync {
    /// After a LivePrice flush: the flushed symbols whose accounts the web must evaluate now.
    fn symbols_to_evaluate(&self, flushed: &[Tick], cache: &TickCache) -> Vec<String>;
    /// A margin-triggered evaluation came back (closes may have happened): refresh the watched book.
    fn evaluated(&self);
    /// The symbols of every open position in the watched book; None until the book has loaded once.
    fn book_symbols(&self) -> Option<HashSet<String>> {
        None
    }
}

/// Stage 6 (2026-10-06): who owns an account's risk. Implemented by order_management::authority::AuthorityCache (the
/// per-broker `riskAuthority` read from the database, the same rule as lib/risk-authority.ts riskOwnerOf). This crate
/// cannot depend on order-management, so the hook and the margin trigger only see this trait. `true` = the ENGINE acts on
/// the account (and the web does not); anything the oracle does not know is `false`, i.e. WEB (the fallback).
pub trait RiskOwnerOracle: Send + Sync {
    fn engine_owns(&self, broker_id: &str, account_mode: &str) -> bool;
}

/// What set an engine-owned evaluation off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FireSource {
    /// the per-tick margin trigger (stop-out / margin-call edge)
    Margin,
    /// a tick touched an open position's SL / TP
    SlTp,
    /// a resting order of the account was handed to the web's fill routine after its entry was crossed; the account
    /// (and any position the fill opened) is evaluated afterwards
    Pending,
}

/// A fire for an ENGINE-OWNED account (Stage 6): the account, and the tick prices that triggered it, symbol -> (bid, ask,
/// tick time). It carries NO position list: the engine re-reads the account's CURRENT positions inside the evaluation
/// (order_management::monitor::evaluate_live_fire), in one snapshot, and prices the symbols named here at the fired
/// tick (order_management::book::with_tick_hint). The unpinned counterpart of the shadow's pinned evaluation.
#[derive(Clone, Debug)]
pub struct LiveFire {
    pub account_id: String,
    pub ticks: HashMap<String, (Decimal, Decimal, chrono::DateTime<chrono::Utc>)>,
    pub source: FireSource,
}

/// Where engine-owned fires go (never awaited: a send on an unbounded channel).
pub type LiveSender = tokio::sync::mpsc::UnboundedSender<LiveFire>;

/// The engine side of the Stage 6 split, set only in risk mode: the owner oracle, the fire channel, and the web route
/// that fills resting orders of engine-owned accounts.
struct LiveEngine {
    oracle: Arc<dyn RiskOwnerOracle>,
    sender: LiveSender,
    /// GET {url}?symbols=X: lib/pending-trigger.ts evaluatePendingTriggers(symbols, "RUST"): the web's fill routine for
    /// resting orders of RUST-owned accounts only (the fill is an ORDER action, with every order gate, and stays web code)
    pending_url: String,
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
    /// the account's broker and mode: the Stage 6 owner rule's inputs
    broker_id: String,
    mode: String,
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
    is_buy: bool,
    is_limit: bool,
    entry: Decimal,
    ask_rule: Option<AskRule>,
    /// the order's account, broker and mode (Stage 6: who handles the crossing)
    account_id: String,
    broker_id: String,
    mode: String,
}

impl PendingLevel {
    /// An entry with no account (tests of the crossing rule alone).
    #[cfg(test)]
    fn bare(is_buy: bool, is_limit: bool, entry: Decimal, ask_rule: Option<AskRule>) -> Self {
        PendingLevel { is_buy, is_limit, entry, ask_rule, account_id: String::new(), broker_id: String::new(), mode: String::new() }
    }

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

pub struct RiskHook {
    url: String,
    secret: String,
    client: reqwest::Client,
    levels: Mutex<HashMap<String, Vec<Level>>>,
    pending: Mutex<HashMap<String, Vec<PendingLevel>>>,
    last_fired: Mutex<HashMap<String, Instant>>,
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
    /// Stage 6 risk mode: the owner oracle + fire channel. Unset = nothing is engine-owned: the hook behaves exactly as
    /// before Stage 6 (every touch and crossing goes to the web).
    live: std::sync::OnceLock<LiveEngine>,
    /// engine fires are limited per (account, symbol) to one a second, like the web call per symbol
    last_engine_fire: Mutex<HashMap<(String, String), Instant>>,
}

impl RiskHook {
    /// None when the env is not set (the hook is opt-in per deployment).
    pub fn from_env() -> Option<Arc<RiskHook>> {
        let url = std::env::var("VYX_RISK_HOOK_URL").ok().filter(|s| !s.trim().is_empty())?;
        let secret = std::env::var("VYX_RISK_HOOK_SECRET").ok().filter(|s| !s.trim().is_empty())?;
        let hook = Self::new(url, secret, Duration::from_secs(12))?;
        tracing::info!(url = %hook.url, "risk hook enabled: SL/TP evaluation fires on the tick that touches a level");
        Some(hook)
    }

    /// A hook calling `url` with bearer `secret` (from_env; tests). None only if the HTTP client cannot be built.
    pub fn new(url: String, secret: String, timeout: Duration) -> Option<Arc<RiskHook>> {
        let client = reqwest::Client::builder().timeout(timeout).build().ok()?;
        Some(Arc::new(RiskHook {
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
            live: std::sync::OnceLock::new(),
            last_engine_fire: Mutex::new(HashMap::new()),
        }))
    }

    /// Stage 6 risk mode (once; a second call is ignored): touches and crossings of ENGINE-OWNED accounts (per `oracle`)
    /// go to `sender` as LiveFires and no longer to the web; resting orders of those accounts are filled by the web's
    /// routine through `pending_url` (see LiveEngine). Every other account is untouched by this.
    pub fn set_live(&self, oracle: Arc<dyn RiskOwnerOracle>, sender: LiveSender, pending_url: String) {
        let _ = self.live.set(LiveEngine { oracle, sender, pending_url });
    }

    /// Whether the engine owns the account whose broker / mode these are (false without a live engine).
    fn engine_owns(&self, broker_id: &str, mode: &str) -> bool {
        self.live.get().is_some_and(|l| l.oracle.engine_owns(broker_id, mode))
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
                      p."slPrice" AS sl, p."tpPrice" AS tp, a."brokerId" AS a_broker, a."groupId" AS a_group, a."accountMode"::text AS a_mode
               FROM "Position" p JOIN "Symbol" s ON s.id = p."symbolId" JOIN "Account" a ON a.id = p."accountId"
               WHERE p.status = 'OPEN' AND (p."slPrice" IS NOT NULL OR p."tpPrice" IS NOT NULL)"#,
        )
        .fetch_all(&mut *conn)
        .await?;
        // resting LIMIT / STOP orders (the web's own "Order" table: PENDING, not the engine's orders table), with the
        // order's account ask rule for a BUY entry
        let pending_rows = sqlx::query(
            r#"SELECT s.name, s.id AS symbol_id, s.digits, o."accountId" AS account_id, o.side::text AS side, o.type::text AS kind,
                      o."requestedPrice" AS entry, a."brokerId" AS a_broker, a."groupId" AS a_group, a."accountMode"::text AS a_mode
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
                broker_id: r.try_get("a_broker")?,
                mode: r.try_get("a_mode")?,
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
                is_buy: side == "BUY",
                is_limit: kind == "LIMIT",
                entry: r.try_get("entry")?,
                ask_rule,
                account_id: r.try_get("account_id")?,
                broker_id: r.try_get("a_broker")?,
                mode: r.try_get("a_mode")?,
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
                // Stage 6: a level of an ENGINE-OWNED account is not the web's (engine_touches handles it)
                if self.engine_owns(&l.broker_id, &l.mode) {
                    continue;
                }
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
            if pending.get(&t.symbol).map_or(false, |ps| ps.iter().any(|p| !self.engine_owns(&p.broker_id, &p.mode) && p.triggered(t.bid, t.ask))) {
                out.push(t.symbol.clone());
            }
        }
        (out, touches)
    }

    /// Stage 6: the SL / TP touches (first list) and resting-order crossings (second) of ENGINE-OWNED accounts among these
    /// ticks, one LiveFire per account and source, each carrying the tick that crossed. Empty without a live engine.
    /// The web path (touched_with_positions) skips exactly these levels, so a touch has ONE handler.
    fn engine_touches(&self, ticks: &[Tick], now: chrono::DateTime<chrono::Utc>) -> (Vec<LiveFire>, Vec<LiveFire>) {
        let mut sl_tp: Vec<LiveFire> = Vec::new();
        let mut pending: Vec<LiveFire> = Vec::new();
        if self.live.get().is_none() {
            return (sl_tp, pending);
        }
        let tick_at = |t: &Tick| t.tick_ms.and_then(chrono::DateTime::from_timestamp_millis).unwrap_or(now);
        let add = |list: &mut Vec<LiveFire>, account_id: &str, t: &Tick, source: FireSource| {
            let fire = match list.iter_mut().position(|f| f.account_id == account_id) {
                Some(i) => &mut list[i],
                None => {
                    list.push(LiveFire { account_id: account_id.to_string(), ticks: HashMap::new(), source });
                    list.last_mut().unwrap()
                }
            };
            fire.ticks.insert(t.symbol.clone(), (t.bid, t.ask, tick_at(t)));
        };
        {
            let levels = self.levels.lock().unwrap();
            for t in ticks {
                let Some(ls) = levels.get(&t.symbol) else { continue };
                for l in ls {
                    if !self.engine_owns(&l.broker_id, &l.mode) {
                        continue;
                    }
                    let cp = if l.is_buy { t.bid } else { ask_markup::close_price(protocol::OrderSide::Sell, t.bid, t.ask, l.ask_rule.as_ref()) };
                    let sl_hit = l.sl.map_or(false, |sl| if l.is_buy { cp <= sl } else { cp >= sl });
                    let tp_hit = l.tp.map_or(false, |tp| if l.is_buy { cp >= tp } else { cp <= tp });
                    if sl_hit || tp_hit {
                        add(&mut sl_tp, &l.account_id, t, FireSource::SlTp);
                    }
                }
            }
        }
        let resting = self.pending.lock().unwrap();
        for t in ticks {
            let Some(ps) = resting.get(&t.symbol) else { continue };
            for p in ps {
                if self.engine_owns(&p.broker_id, &p.mode) && p.triggered(t.bid, t.ask) {
                    add(&mut pending, &p.account_id, t, FireSource::Pending);
                }
            }
        }
        (sl_tp, pending)
    }

    /// True when a resting order of an engine-owned account is being watched (the backstop's pending sweep).
    fn has_engine_pending(&self) -> bool {
        self.live.get().is_some() && self.pending.lock().unwrap().values().any(|ps| ps.iter().any(|p| self.engine_owns(&p.broker_id, &p.mode)))
    }

    /// One fire per (account, symbol) per second: drops the symbols of a fire that were fired less than a second ago,
    /// returns None when nothing is left.
    fn limit_engine_fire(&self, mut fire: LiveFire) -> Option<LiveFire> {
        let mut last = self.last_engine_fire.lock().unwrap();
        let now = Instant::now();
        let account = fire.account_id.clone();
        fire.ticks.retain(|symbol, _| match last.get(&(account.clone(), symbol.clone())) {
            Some(t) if now.duration_since(*t) < Duration::from_secs(1) => false,
            _ => {
                last.insert((account.clone(), symbol.clone()), now);
                true
            }
        });
        if fire.ticks.is_empty() { None } else { Some(fire) }
    }

    /// Resting orders of engine-owned accounts whose entry a tick crossed: the web's fill routine runs for them
    /// (GET pending_url?symbols=, RUST scope), then each account is evaluated by the engine (the fill may have opened a
    /// position already at a stop-out level). Rate limited per symbol like the web call.
    fn spawn_pending_trigger(self: &Arc<Self>, fires: Vec<LiveFire>) {
        let Some(live) = self.live.get() else { return };
        let mut symbols: Vec<String> = fires.iter().flat_map(|f| f.ticks.keys().cloned()).collect();
        symbols.sort();
        symbols.dedup();
        {
            let mut last = self.last_fired.lock().unwrap();
            let now = Instant::now();
            symbols.retain(|s| {
                let key = format!("pending:{s}");
                match last.get(&key) {
                    Some(t) if now.duration_since(*t) < Duration::from_secs(1) => false,
                    _ => {
                        last.insert(key, now);
                        true
                    }
                }
            });
        }
        if symbols.is_empty() {
            return;
        }
        let fires: Vec<LiveFire> = fires.into_iter().filter(|f| f.ticks.keys().any(|s| symbols.contains(s))).collect();
        let hook = Arc::clone(self);
        let sender = live.sender.clone();
        let url = format!("{}?symbols={}", live.pending_url, symbols.join(","));
        tokio::spawn(async move {
            match hook.client.get(&url).bearer_auth(&hook.secret).send().await {
                Ok(resp) if resp.status().is_success() => tracing::info!(symbols = %symbols.join(","), "risk hook: resting orders of engine-owned accounts handed to the web's fill routine"),
                Ok(resp) => tracing::warn!(status = %resp.status(), "pending trigger rejected"),
                Err(err) => tracing::warn!(error = %err, "pending trigger failed"),
            }
            for fire in fires {
                let _ = sender.send(fire);
            }
        });
    }

    /// The pending-order sweep of engine-owned accounts (no symbols: every resting order of theirs), run by the backstop.
    pub async fn fire_pending_sweep(&self) -> bool {
        let Some(live) = self.live.get() else { return false };
        match self.client.get(&live.pending_url).bearer_auth(&self.secret).send().await {
            Ok(resp) if resp.status().is_success() => true,
            Ok(resp) => {
                tracing::warn!(status = %resp.status(), "pending sweep rejected");
                false
            }
            Err(err) => {
                tracing::warn!(error = %err, "pending sweep failed");
                false
            }
        }
    }

    /// After a LivePrice flush: fire the evaluation for every symbol whose ticks touched an SL / TP, or put
    /// an account holding it at or below stop-out / across margin call (max once a second each).
    pub fn after_flush(self: &Arc<Self>, ticks: &[Tick], cache: &TickCache) {
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
        // Stage 6: engine-owned accounts' touches and crossings go to the engine, never to the web
        if let Some(live) = self.live.get() {
            let (sl_tp, pending) = self.engine_touches(ticks, now);
            for fire in sl_tp {
                if let Some(fire) = self.limit_engine_fire(fire) {
                    let _ = live.sender.send(fire);
                }
            }
            if !pending.is_empty() {
                self.spawn_pending_trigger(pending);
            }
        }
        let (mut symbols, touches) = self.touched_with_positions(ticks, now);
        let margin: Vec<String> = self.margin_watch.get().map(|w| w.symbols_to_evaluate(ticks, cache)).unwrap_or_default();
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
            let now = Instant::now();
            symbols.retain(|s| match last.get(s) {
                Some(t) if now.duration_since(*t) < Duration::from_secs(1) => false,
                _ => {
                    last.insert(s.clone(), now);
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
        let hook = Arc::clone(self);
        tokio::spawn(async move {
            let url = format!("{}?symbols={}", hook.url, symbols.join(","));
            match hook.client.get(&url).bearer_auth(&hook.secret).send().await {
                Ok(resp) if resp.status().is_success() => tracing::info!(symbols = %symbols.join(","), margin = by_margin, "risk hook fired"),
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
                    // Stage 6: the web's own sweeps skip engine-owned accounts' resting orders; this one covers them
                    if hook.has_engine_pending() {
                        hook.fire_pending_sweep().await;
                    }
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
        let buy_limit = super::PendingLevel::bare(true, true, dec!(100), None);
        assert!(buy_limit.triggered(dec!(99.8), dec!(100.0)));
        assert!(!buy_limit.triggered(dec!(99.9), dec!(100.1)));
        let buy_stop = super::PendingLevel::bare(true, false, dec!(100), None);
        assert!(buy_stop.triggered(dec!(99.9), dec!(100.1)));
        assert!(!buy_stop.triggered(dec!(99.7), dec!(99.9)));
        let sell_limit = super::PendingLevel::bare(false, true, dec!(100), None);
        assert!(sell_limit.triggered(dec!(100.0), dec!(100.2)));
        assert!(!sell_limit.triggered(dec!(99.9), dec!(100.1)));
        let sell_stop = super::PendingLevel::bare(false, false, dec!(100), None);
        assert!(sell_stop.triggered(dec!(99.9), dec!(100.1)));
        assert!(!sell_stop.triggered(dec!(100.1), dec!(100.3)));
    }

    #[test]
    fn a_buy_entry_triggers_on_its_account_ask_a_sell_entry_on_the_raw_bid() {
        use crate::ask_markup::AskRule;
        // +1.5 pips on a 2-digit symbol = +0.15
        let rule = Some(AskRule::Markup { markup_pips: dec!(1.5), digits: 2 });
        // BUY STOP at 100.10: raw ask 100.00 has not reached it, the account ask 100.15 has
        let buy_stop = super::PendingLevel::bare(true, false, dec!(100.10), rule);
        assert!(buy_stop.triggered(dec!(99.90), dec!(100.00)));
        // BUY LIMIT at 100.00: raw ask 99.95 would fill it raw; the account ask 100.10 is above the entry
        let buy_limit = super::PendingLevel::bare(true, true, dec!(100.00), rule);
        assert!(!buy_limit.triggered(dec!(99.80), dec!(99.95)));
        // a SELL entry never reads the ask
        let sell_stop = super::PendingLevel::bare(false, false, dec!(99.90), rule);
        assert!(!sell_stop.triggered(dec!(99.95), dec!(100.00)));
    }

    #[test]
    fn a_sell_level_is_touched_at_its_account_ask() {
        use crate::ask_markup::AskRule;
        let h = hook("http://127.0.0.1:1/x".into());
        // SELL SL at 4299.25: raw ask 4299.13 has not reached it, the account ask 4299.28 (+1.5 pips) has
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![Level { position_id: "p1".into(), account_id: "a1".into(), broker_id: String::new(), mode: String::new(), is_buy: false, sl: Some(dec!(4299.25)), tp: None, ask_rule: Some(AskRule::Markup { markup_pips: dec!(1.5), digits: 2 }) }]);
        let t: Tick = serde_json::from_value(serde_json::json!({ "symbol": "XAUUSD", "bid": "4298.96", "ask": "4299.13" })).unwrap();
        assert_eq!(h.touched(std::slice::from_ref(&t)), vec!["XAUUSD".to_string()]);
        // the same level on the raw ask (no rule) is not touched
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![Level { position_id: "p1".into(), account_id: "a1".into(), broker_id: String::new(), mode: String::new(), is_buy: false, sl: Some(dec!(4299.25)), tp: None, ask_rule: None }]);
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
            live: std::sync::OnceLock::new(),
            last_engine_fire: Mutex::new(HashMap::new()),
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
        pend.pending.lock().unwrap().insert("BTCUSD".into(), vec![PendingLevel::bare(true, true, Decimal::ONE, None)]);
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
        pending.pending.lock().unwrap().insert("BTCUSD".into(), vec![PendingLevel::bare(true, true, Decimal::ONE, None)]);
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
        Level { position_id: position.into(), account_id: account.into(), broker_id: String::new(), mode: String::new(), is_buy, sl, tp, ask_rule }
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
        h.pending.lock().unwrap().insert("EURUSD".into(), vec![PendingLevel::bare(false, true, dec!(1.1), None)]);
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
        h.pending.lock().unwrap().insert("XAUUSD".into(), vec![PendingLevel::bare(false, true, dec!(4270), None)]);
        let (tx, mut shadow) = tokio::sync::mpsc::unbounded_channel::<Vec<SlTpTouch>>();
        h.set_shadow_snapshot(tx);
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0)); // bid 4280 >= SELL LIMIT 4270
        tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.expect("web called at once").unwrap();
        assert!(shadow.try_recv().is_err(), "no snapshot for a resting order");
    }

    // ---- Stage 6: the split between the engine and the web, at the hook ----

    /// The engine owns accounts of broker "bR" in mode DEMO and every account of "bA"; nothing else.
    struct StubOracle;
    impl RiskOwnerOracle for StubOracle {
        fn engine_owns(&self, broker_id: &str, account_mode: &str) -> bool {
            (broker_id == "bR" && account_mode == "DEMO") || broker_id == "bA"
        }
    }

    fn lvl_of(position: &str, account: &str, broker: &str, mode: &str, sl: Decimal) -> Level {
        Level { position_id: position.into(), account_id: account.into(), broker_id: broker.into(), mode: mode.into(), is_buy: false, sl: Some(sl), tp: None, ask_rule: None }
    }

    fn pending_of(account: &str, broker: &str, mode: &str) -> PendingLevel {
        PendingLevel { is_buy: false, is_limit: true, entry: dec!(4270), ask_rule: None, account_id: account.into(), broker_id: broker.into(), mode: mode.into() }
    }

    fn live_hook(url: String) -> (Arc<RiskHook>, tokio::sync::mpsc::UnboundedReceiver<LiveFire>) {
        let h = hook(url.clone());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        h.set_live(Arc::new(StubOracle), tx, url.replace("margin-monitor", "pending-trigger"));
        (h, rx)
    }

    /// An SL touch of an ENGINE-owned account goes to the engine (a LiveFire carrying the tick), never to the web, never to the
    /// shadow; a touch of a WEB-owned account on the SAME symbol still goes to the web exactly as before.
    #[tokio::test]
    async fn a_touch_of_an_engine_owned_account_goes_to_the_engine_and_a_web_owned_one_to_the_web() {
        let (url, mut rx) = mock_route(200).await;
        let (h, mut live) = live_hook(url);
        let (snap_tx, mut shadow) = tokio::sync::mpsc::unbounded_channel::<Vec<SlTpTouch>>();
        h.set_shadow_snapshot(snap_tx);
        // SELL SL 4280.2: the tick (ask 4280.3) touches all three
        h.levels.lock().unwrap().insert(
            "XAUUSD".into(),
            vec![lvl_of("p-engine", "a-engine", "bR", "DEMO", dec!(4280.2)), lvl_of("p-web", "a-web", "bR", "LIVE", dec!(4280.2)), lvl_of("p-all", "a-all", "bA", "LIVE", dec!(4280.2))],
        );
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));

        // the engine: one fire per account, carrying the tick that crossed
        let mut fires = vec![live.try_recv().expect("fire 1"), live.try_recv().expect("fire 2")];
        fires.sort_by(|a, b| a.account_id.cmp(&b.account_id));
        assert_eq!(fires.iter().map(|f| f.account_id.as_str()).collect::<Vec<_>>(), vec!["a-all", "a-engine"]);
        for f in &fires {
            assert_eq!(f.source, FireSource::SlTp);
            let (bid, ask, _) = f.ticks["XAUUSD"];
            assert_eq!((bid, ask), (dec!(4280), dec!(4280.3)), "the fire carries the crossing tick");
        }
        assert!(live.try_recv().is_err(), "the web-owned account is not the engine's");
        // the web: called once for the symbol (its own account is touched); the shadow snapshots ONLY the web-owned touch
        let (line, _) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("web called").unwrap();
        assert_eq!(line, "GET /api/internal/margin-monitor?symbols=XAUUSD HTTP/1.1");
        let handed = shadow.try_recv().expect("a snapshot");
        assert_eq!(handed.iter().map(|t| t.account_id.as_str()).collect::<Vec<_>>(), vec!["a-web"], "engine-owned touches are not the shadow's");
    }

    /// When EVERY touched account of the symbol is the engine's, the web is not called at all.
    #[tokio::test]
    async fn the_web_is_not_called_for_a_symbol_whose_touched_accounts_are_all_the_engines() {
        let (url, mut rx) = mock_route(200).await;
        let (h, mut live) = live_hook(url);
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![lvl_of("p-engine", "a-engine", "bA", "LIVE", dec!(4280.2))]);
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));
        assert_eq!(live.try_recv().expect("fire").account_id, "a-engine");
        assert!(tokio::time::timeout(Duration::from_millis(400), rx.recv()).await.is_err(), "no web call");
    }

    /// Without set_live nothing is engine-owned: a touch goes to the web exactly as before Stage 6, whatever the levels' brokers are.
    #[tokio::test]
    async fn without_a_live_engine_every_touch_goes_to_the_web() {
        let (url, mut rx) = mock_route(200).await;
        let h = hook(url);
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![lvl_of("p", "a", "bA", "DEMO", dec!(4280.2))]);
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));
        let (line, _) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("web called").unwrap();
        assert_eq!(line, "GET /api/internal/margin-monitor?symbols=XAUUSD HTTP/1.1");
    }

    /// One engine fire per (account, symbol) per second.
    #[tokio::test]
    async fn an_engine_fire_is_limited_to_one_per_account_and_symbol_per_second() {
        let (url, _rx) = mock_route(200).await;
        let (h, mut live) = live_hook(url);
        h.levels.lock().unwrap().insert("XAUUSD".into(), vec![lvl_of("p", "a", "bA", "LIVE", dec!(4280.2))]);
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));
        assert!(live.try_recv().is_ok());
        assert!(live.try_recv().is_err(), "the second flush inside the second does not fire again");
    }

    /// A resting order of an engine-owned account whose entry a tick crossed: the web's fill routine is called on the RUST-scope
    /// route (never margin-monitor), and only AFTER it the account is handed to the engine for evaluation (the fill may have opened
    /// a position already at a stop-out level). A resting order of a web-owned account on the same symbol still goes to margin-monitor.
    #[tokio::test]
    async fn an_engine_owned_resting_order_is_filled_by_the_rust_scope_route_then_the_account_is_evaluated() {
        let (url, mut rx) = mock_route(200).await;
        let (h, mut live) = live_hook(url);
        h.pending.lock().unwrap().insert("XAUUSD".into(), vec![pending_of("a-engine", "bR", "DEMO")]);
        h.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0)); // bid 4280 >= SELL LIMIT 4270
        let (line, auth) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("route called").unwrap();
        assert_eq!(line, "GET /api/internal/pending-trigger?symbols=XAUUSD HTTP/1.1");
        assert_eq!(auth, "Bearer s3cret");
        let fire = tokio::time::timeout(Duration::from_secs(3), live.recv()).await.expect("evaluated after the fill").unwrap();
        assert_eq!((fire.account_id.as_str(), fire.source), ("a-engine", FireSource::Pending));
        assert!(tokio::time::timeout(Duration::from_millis(300), rx.recv()).await.is_err(), "margin-monitor is not called for it");

        // a web-owned resting order: the web's own call
        let (url2, mut rx2) = mock_route(200).await;
        let (h2, mut live2) = live_hook(url2);
        h2.pending.lock().unwrap().insert("XAUUSD".into(), vec![pending_of("a-web", "bR", "LIVE")]);
        h2.after_flush(&[tick("XAUUSD")], &cache_ticked("XAUUSD", 0));
        let (line2, _) = tokio::time::timeout(Duration::from_secs(3), rx2.recv()).await.expect("web called").unwrap();
        assert_eq!(line2, "GET /api/internal/margin-monitor?symbols=XAUUSD HTTP/1.1");
        assert!(live2.try_recv().is_err());
    }

    /// The backstop also sweeps the engine-owned accounts' resting orders (the web's sweeps skip them) -- and only when there are any.
    #[tokio::test]
    async fn the_backstop_sweeps_engine_owned_resting_orders_only_when_there_are_any() {
        let (url, mut rx) = mock_route(200).await;
        let (h, _live) = live_hook(url);
        h.set_margin_watch(Arc::new(BookWatch(None)));
        h.spawn_backstop_loop(Duration::from_millis(80), cache_ticked("XAUUSD", 0));
        let (line, _) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("full pass").unwrap();
        assert_eq!(line, "GET /api/internal/margin-monitor HTTP/1.1");
        assert!(tokio::time::timeout(Duration::from_millis(400), async { loop { let (l, _) = rx.recv().await.unwrap(); if l.contains("pending-trigger") { return l; } } }).await.is_err(), "no engine-owned resting order: no sweep");
        h.pending.lock().unwrap().insert("XAUUSD".into(), vec![pending_of("a-engine", "bA", "LIVE")]);
        let swept = tokio::time::timeout(Duration::from_secs(3), async { loop { let (l, _) = rx.recv().await.unwrap(); if l.contains("pending-trigger") { return l; } } }).await.expect("swept");
        assert_eq!(swept, "GET /api/internal/pending-trigger HTTP/1.1");
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
}
