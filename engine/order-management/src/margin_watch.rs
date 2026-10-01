//! Per-tick margin trigger (2026-09-24): stop-out on the tick, not up to a minute later.
//!
//! The engine risk hook (market_data::risk_hook) fired the web's margin-monitor on a tick only when that tick
//! touched an open SL / TP level; it computed no margin. An account without levels going under its stop-out
//! was caught only by the full-book backstop (every VYX_RISK_HOOK_BACKSTOP_SECS, 60 s) or the Vercel cron
//! (every 5 min). Production, 2026-09-24: account 50005708 sat at 80-89 % against a 99 % stop-out for up to
//! ~60 s between closes (27 of 43 stop-outs landed on the backstop's :33 second).
//!
//! This watch is a TRIGGER only. It keeps an in-memory copy of the book (every account holding an open
//! position: balance, credit, leverage, currency, its group's thresholds, its positions), refreshed every
//! few seconds and right after a triggered evaluation. After every LivePrice flush it recomputes the level
//! of each account holding a flushed symbol, with the canonical Stage 2 math (calc::equity / used_margin,
//! margin::evaluate: live close-side price x fx, 15 s freshness, at-or-below), against the engine's own
//! tick cache. When an account is at or below its stop-out, or crosses its margin-call level, it returns
//! that symbol, and the hook calls the web's `?symbols=X` evaluation at once. The web decides and closes
//! with its own fresh numbers (unchanged, canonical); a false trigger costs one call, and the backstop
//! stays underneath for anything this misses (a position opened since the last refresh, a session the
//! engine cannot see).
//!
//! Idle gate (2026-09-26, market_data::activity): the reload stops querying once nothing has ticked for a minute (a
//! position cannot open without a fresh price), except the first load and a reload asked for after a triggered
//! evaluation; and book_symbols() tells the hook's backstop and the shadow pass what the book holds.
//!
//! Damping: a stop-out that stays (the web disagrees, e.g. a session it treats as closed) re-fires after
//! 1, 2, 4 ... 30 s, reset once the account is back above; a margin-call edge fires at most every 5 s per
//! account. A margin-call change inside those 5 s is DEFERRED, not lost (2026-10-01, the 11-flap episode of 50005708):
//! the watch remembers the last state it FIRED, and once the 5 s are over, the first evaluation that finds the account
//! in a different state fires it. So a flap that ends inside the 5 s (in -> out -> in) is coalesced into the state the
//! account is in when the window ends, and a change that stays is always announced, at most 5 s late.
//! Margin-call notices (owner 2026-10-01): no real warning is lost;
//! the account's final state is announced within 5 s; sub-5 s flickers are not repeated
//! (for the 11-flap replay: 8 in/out pairs vs the web's 11, all 11 web notices explained, 0 WEB_ONLY).

use crate::{calc, db, fx};
use market_data::cache::TickCache;
use margin::{MarginThresholds, MonitorAction};
use protocol::Tick;
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// The web's price freshness rule (lib/live-price.ts getFreshPrices, book.rs: tickAt under 15 s).
const FRESH: i64 = 15;
/// A margin-call edge (in or out) fires at most this often per account; a change inside it is deferred, not dropped
/// (Track::fired_in_call). Damping option A, kept at 5 s. The rule:
/// "Margin-call notices (owner 2026-10-01): no real warning is lost; the account's final state is announced within 5 s; sub-5 s flickers are not repeated (for the 11-flap replay: 8 in/out pairs vs the web's 11, all 11 web notices explained, 0 WEB_ONLY)."
const EDGE_EVERY: Duration = Duration::from_secs(5);
/// Cap of the re-fire backoff for a stop-out that stays.
const MAX_BACKOFF_SECS: u64 = 30;

#[derive(Clone, Debug, PartialEq)]
pub struct WatchedPosition {
    /// the position's id: named in the fire's pin (book::Pin::measured)
    pub id: String,
    pub symbol: String,
    pub side: protocol::OrderSide,
    pub volume: Decimal,
    pub open_price: Decimal,
    pub contract_size: Decimal,
    pub quote_currency: String,
    /// BrokerSymbol.hedgedMarginPct (calc::used_margin); 200 = no reduction
    pub hedged_margin_pct: Decimal,
    /// The account's ask rule (market_data::ask_markup): a SELL is valued at the account's ask. None = raw.
    pub ask_rule: Option<market_data::ask_markup::AskRule>,
}

/// What the per-tick margin trigger hands the shadow when it fires (Stage 5 fan-in race, 2026-09-29): the account AND
/// the moment it was measured at, with the tick-cache prices of every symbol it holds (book::Pin). The shadow evaluates
/// the account AS IT STOOD THEN, the same pinned evaluation the SL / TP snapshot uses (monitor::evaluate_snapshot),
/// so a web close that lands before the shadow's database read no longer hides the position. (Before, only the id was
/// sent and the shadow re-read the live book: in the 2026-09-28 S2 fan-in the web closed 49990002 first, the shadow
/// read it second, found nothing open and recorded nothing -> WEB_ONLY.)
#[derive(Clone, Debug)]
pub struct MarginFire {
    pub account_id: String,
    pub pin: crate::book::Pin,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WatchedAccount {
    pub id: String,
    pub balance: Decimal,
    pub credit: Decimal,
    pub leverage: u32,
    pub currency: String,
    pub thresholds: MarginThresholds,
    pub positions: Vec<WatchedPosition>,
}

#[derive(Default, Debug)]
pub struct Book {
    pub accounts: Vec<WatchedAccount>,
    by_symbol: HashMap<String, Vec<usize>>,
}

impl Book {
    pub fn new(accounts: Vec<WatchedAccount>) -> Self {
        let mut by_symbol: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, a) in accounts.iter().enumerate() {
            for p in &a.positions {
                let list = by_symbol.entry(p.symbol.clone()).or_default();
                if list.last() != Some(&i) {
                    list.push(i);
                }
            }
        }
        Book { accounts, by_symbol }
    }
}

/// Every account holding an OPEN position, with its positions and its group's thresholds. One query. (Every
/// account has a group and both levels are NOT NULL today; the LEFT JOIN + 100 / 50 fallback mirror
/// book::account_thresholds, so a row can never be dropped for a missing group.)
pub async fn load_book<'e, E: sqlx::PgExecutor<'e>>(e: E) -> Result<Book, sqlx::Error> {
    use sqlx::Row;
    // + the levels of each position's account ask rule (market_data::ask_markup), joined: still one query
    let sql = format!(
        r#"SELECT a.id, a.balance, a.credit, a.leverage, a.currency, g."marginCallLevel" AS call, g."stopOutLevel" AS stop_out,
                  p.id AS position_id, s.name, p.side::text AS side, p.volume, p."openPrice" AS open_price, s."contractSize" AS contract_size,
                  s."quoteCurrency" AS quote_ccy, COALESCE(bs."hedgedMarginPct", 200) AS hedged_margin_pct,
                  {levels}
           FROM "Position" p
           JOIN "Account" a ON a.id = p."accountId"
           JOIN "Symbol" s ON s.id = p."symbolId"
           LEFT JOIN "BrokerSymbol" bs ON bs."brokerId" = p."brokerId" AND bs."symbolId" = p."symbolId"
           LEFT JOIN "Group" g ON g.id = a."groupId"
           {joins}
           WHERE p.status = 'OPEN'
           ORDER BY a.id COLLATE "C", p."openedAt", p.id"#,
        levels = market_data::ask_markup::LEVELS_COLUMNS,
        joins = market_data::ask_markup::LEVELS_JOINS,
    );
    let raw = sqlx::query(&sql).fetch_all(e).await?;
    #[allow(clippy::type_complexity)]
    let mut rows: Vec<(String, Decimal, Decimal, i32, String, Option<Decimal>, Option<Decimal>, String, String, String, Decimal, Decimal, Decimal, String, Decimal, Option<market_data::ask_markup::AskRule>)> = Vec::with_capacity(raw.len());
    for r in &raw {
        rows.push((
            r.try_get("id")?, r.try_get("balance")?, r.try_get("credit")?, r.try_get("leverage")?, r.try_get("currency")?, r.try_get("call")?, r.try_get("stop_out")?,
            r.try_get("position_id")?, r.try_get("name")?, r.try_get("side")?, r.try_get("volume")?, r.try_get("open_price")?, r.try_get("contract_size")?, r.try_get("quote_ccy")?,
            r.try_get("hedged_margin_pct")?, market_data::ask_markup::resolve(&market_data::ask_markup::levels_from_row(r)?),
        ));
    }
    let d = MarginThresholds::default();
    let mut accounts: Vec<WatchedAccount> = Vec::new();
    for (id, balance, credit, leverage, currency, call, stop_out, position_id, symbol, side, volume, open_price, contract_size, quote_currency, hedged_margin_pct, ask_rule) in rows {
        if accounts.last().map(|a| a.id != id).unwrap_or(true) {
            accounts.push(WatchedAccount {
                id,
                balance,
                credit,
                leverage: leverage.max(1) as u32,
                currency,
                thresholds: MarginThresholds { call_level: call.unwrap_or(d.call_level), stop_out_level: stop_out.unwrap_or(d.stop_out_level) },
                positions: Vec::new(),
            });
        }
        let side = if side == "SELL" { protocol::OrderSide::Sell } else { protocol::OrderSide::Buy };
        accounts.last_mut().unwrap().positions.push(WatchedPosition { id: position_id, symbol, side, volume, open_price, contract_size, quote_currency, hedged_margin_pct, ask_rule });
    }
    Ok(Book::new(accounts))
}

/// Equity and used margin of one watched account at the tick cache's prices, with the canonical math: a
/// position without a fresh (15 s) price, or without a conversion rate, counts in neither (as on the web).
pub fn measure(account: &WatchedAccount, cache: &TickCache) -> (Decimal, Decimal) {
    let fresh = chrono::Duration::seconds(FRESH);
    // fx.rs: the conversion pair's latest quote, whatever its age
    let any_age = chrono::Duration::days(3650);
    let positions = account
        .positions
        .iter()
        .map(|p| {
            let tick = cache.get_if_fresh(&p.symbol, fresh);
            let rate = fx::conversion_rate(&p.quote_currency, &account.currency, |s| cache.get_if_fresh(s, any_age).map(|t| (t.bid, t.ask)));
            let usable = tick.is_some() && rate.is_some();
            db::OpenPositionWithMarket {
                id: String::new(),
                symbol: p.symbol.clone(),
                side: p.side,
                volume: p.volume,
                open_price: p.open_price,
                contract_size: p.contract_size,
                bid: if usable { tick.as_ref().map(|t| t.bid) } else { None },
                ask: if usable { tick.as_ref().map(|t| t.ask) } else { None },
                sl_price: None,
                tp_price: None,
                fx_rate: rate.unwrap_or(Decimal::ONE),
                hedged_margin_pct: p.hedged_margin_pct,
                ask_rule: p.ask_rule,
            }
        })
        .collect();
    let state = calc::AccountState { effective_balance: account.balance, credit: account.credit, leverage: account.leverage, positions };
    (calc::equity(&state), calc::used_margin(&state))
}

#[derive(Default, Debug)]
struct Track {
    in_call: bool,
    /// The margin-call state the last FIRED edge announced (false = out; an account starts out of a call). Compared,
    /// not `in_call`, once the damping is over: a change seen inside the 5 s is fired then, not dropped.
    fired_in_call: bool,
    stop_out_fires: u32,
    last_stop_out_fire: Option<Instant>,
    last_edge_fire: Option<Instant>,
}

pub struct MarginWatch {
    book: RwLock<Arc<Book>>,
    tracks: Mutex<HashMap<String, Track>>,
    reload_now: Notify,
    /// Stage 5 (2026-09-25): every account this trigger fires for is handed to the shadow FIRST, before the hook
    /// calls the web, so the shadow samples the breached state instead of racing the web's close. Unset (live, no
    /// shadow) = nothing changes. A send never blocks and never delays the web call.
    on_fire: Mutex<Option<tokio::sync::mpsc::UnboundedSender<MarginFire>>>,
    /// The book has been set at least once: until then book_symbols() is None (unknown), never "flat".
    loaded: AtomicBool,
}

impl MarginWatch {
    pub fn new() -> Arc<Self> {
        Arc::new(MarginWatch {
            book: RwLock::new(Arc::new(Book::default())),
            tracks: Mutex::new(HashMap::new()),
            reload_now: Notify::new(),
            on_fire: Mutex::new(None),
            loaded: AtomicBool::new(false),
        })
    }

    /// The symbols of every open position in the book; None until the book has loaded once.
    pub fn book_symbols(&self) -> Option<HashSet<String>> {
        if !self.loaded.load(Ordering::Acquire) {
            return None;
        }
        Some(self.book.read().unwrap().by_symbol.keys().cloned().collect())
    }

    /// Stage 5: hand every fired account to the shadow (monitor::spawn_shadow_trigger) before the web is called.
    pub fn set_on_fire(&self, tx: tokio::sync::mpsc::UnboundedSender<MarginFire>) {
        *self.on_fire.lock().unwrap() = Some(tx);
    }

    pub fn set_book(&self, book: Book) {
        let ids: HashSet<&str> = book.accounts.iter().map(|a| a.id.as_str()).collect();
        // forget the damping of accounts that no longer hold anything
        self.tracks.lock().unwrap().retain(|id, _| ids.contains(id.as_str()));
        *self.book.write().unwrap() = Arc::new(book);
        self.loaded.store(true, Ordering::Release);
    }

    pub async fn reload(&self, pool: &PgPool) {
        match load_book(pool).await {
            Ok(book) => self.set_book(book),
            Err(err) => tracing::warn!(error = %err, "margin trigger: could not reload the book (keeping the last one)"),
        }
    }

    /// A book change was announced (market_data::book_events): reload the book now, not at the next poll.
    pub fn request_reload(&self) {
        self.reload_now.notify_one();
    }

    /// Refresh the book every `every` while anything ticks (market_data::activity::reload_due; always the first time),
    /// and at once after a triggered evaluation (closes change it).
    pub fn spawn_reload_loop(self: &Arc<Self>, pool: PgPool, every: Duration, cache: Arc<TickCache>) {
        self.spawn_reload_loop_with(pool, cache, Arc::new(move || every));
    }

    /// As spawn_reload_loop, with the safety interval read from `interval` every second (market_data::book_events::
    /// safety_interval: 5 s while the book can move or the event feed is unproven, 10 min otherwise).
    pub fn spawn_reload_loop_with(self: &Arc<Self>, pool: PgPool, cache: Arc<TickCache>, interval: Arc<dyn Fn() -> Duration + Send + Sync>) {
        let watch = Arc::clone(self);
        tokio::spawn(async move {
            let mut asked = true; // the first load
            let mut last: Option<tokio::time::Instant> = None;
            loop {
                let due = last.is_none_or(|l| l.elapsed() >= interval());
                if asked || !watch.loaded.load(Ordering::Acquire) || (due && market_data::activity::reload_due(&cache, chrono::Utc::now())) {
                    watch.reload(&pool).await;
                    last = Some(tokio::time::Instant::now());
                }
                let nap = interval().min(Duration::from_secs(1));
                asked = tokio::select! {
                    _ = tokio::time::sleep(nap) => false,
                    _ = watch.reload_now.notified() => true,
                };
            }
        });
    }

    /// The decision, testable with an explicit `now`. Returns the flushed symbols to evaluate.
    pub fn decide(&self, flushed: &[Tick], cache: &TickCache, now: Instant) -> Vec<String> {
        let book = Arc::clone(&self.book.read().unwrap());
        let mut tracks = self.tracks.lock().unwrap();
        let mut seen: HashSet<usize> = HashSet::new();
        let mut out: Vec<String> = Vec::new();
        for t in flushed {
            let Some(idxs) = book.by_symbol.get(&t.symbol) else { continue };
            for &i in idxs {
                if !seen.insert(i) {
                    continue;
                }
                let account = &book.accounts[i];
                let (equity, used) = measure(account, cache);
                let action = margin::evaluate(equity, used, account.thresholds);
                let track = tracks.entry(account.id.clone()).or_default();
                let fire = match action {
                    MonitorAction::StopOut => {
                        let wait = if track.stop_out_fires == 0 { 0 } else { (1u64 << (track.stop_out_fires - 1).min(5)).min(MAX_BACKOFF_SECS) };
                        let due = track.last_stop_out_fire.is_none_or(|l| now.duration_since(l) >= Duration::from_secs(wait));
                        if due {
                            track.stop_out_fires += 1;
                            track.last_stop_out_fire = Some(now);
                            tracing::info!(account_id = %account.id, %equity, used_margin = %used, stop_out = %account.thresholds.stop_out_level, "margin trigger: at or below stop-out, evaluating now");
                        }
                        track.in_call = true;
                        // a stop-out fire is a full evaluation of an account below its call level: it stands for "in"
                        track.fired_in_call = true;
                        due
                    }
                    MonitorAction::MarginCall | MonitorAction::Ok => {
                        track.stop_out_fires = 0;
                        track.last_stop_out_fire = None;
                        let in_call = action == MonitorAction::MarginCall;
                        track.in_call = in_call;
                        // against the last FIRED state: a change inside the damping window waits for the window to end
                        // (deferred), it is not overwritten and lost
                        let edge = in_call != track.fired_in_call && track.last_edge_fire.is_none_or(|l| now.duration_since(l) >= EDGE_EVERY);
                        if edge {
                            track.last_edge_fire = Some(now);
                            track.fired_in_call = in_call;
                        }
                        edge
                    }
                };
                if fire {
                    // to the shadow first (a non-blocking send), then the symbol goes back to the hook for the web call.
                    // The pin: this moment and the prices this decision was measured at (every symbol of the account).
                    if let Some(tx) = self.on_fire.lock().unwrap().as_ref() {
                        let _ = tx.send(MarginFire { account_id: account.id.clone(), pin: pin_for(account, cache) });
                    }
                }
                if fire && !out.contains(&t.symbol) {
                    out.push(t.symbol.clone());
                }
            }
        }
        out
    }
}

/// The account's moment: now, and the tick-cache quote (bid, ask, tick time) of every symbol it holds: what measure()
/// just used. A symbol with no quote is left out (the pinned book then treats it as unpriced, like measure()).
fn pin_for(account: &WatchedAccount, cache: &TickCache) -> crate::book::Pin {
    let mut ticks = HashMap::new();
    for p in &account.positions {
        if ticks.contains_key(&p.symbol) {
            continue;
        }
        if let Some((t, received)) = cache.latest(&p.symbol) {
            ticks.insert(p.symbol.clone(), (t.bid, t.ask, crate::book::tick_time(&t, received)));
        }
    }
    // the positions this measurement counted: open at the fire by construction (book::Pin::measured)
    let measured = account.positions.iter().map(|p| p.id.clone()).collect();
    crate::book::Pin { at: chrono::Utc::now(), ticks, measured }
}

impl market_data::risk_hook::MarginWatch for MarginWatch {
    fn symbols_to_evaluate(&self, flushed: &[Tick], cache: &TickCache) -> Vec<String> {
        self.decide(flushed, cache, Instant::now())
    }

    fn evaluated(&self) {
        self.reload_now.notify_one();
    }

    fn book_symbols(&self) -> Option<HashSet<String>> {
        MarginWatch::book_symbols(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn tick(symbol: &str, bid: Decimal, ask: Decimal) -> Tick {
        serde_json::from_value(serde_json::json!({ "symbol": symbol, "bid": bid, "ask": ask })).unwrap()
    }

    fn cache_with(ticks: &[(Tick, i64)]) -> TickCache {
        let c = TickCache::new();
        for (t, age_secs) in ticks {
            c.set(t, chrono::Utc::now() - chrono::Duration::seconds(*age_secs));
        }
        c
    }

    /// 10 x 0.01 XAUUSD BUY at 4290, leverage 1000, stop-out 99 / call 100 (account 50005708's shape).
    fn gold_account(id: &str, balance: Decimal) -> WatchedAccount {
        WatchedAccount {
            id: id.into(),
            balance,
            credit: dec!(0),
            leverage: 1000,
            currency: "USD".into(),
            thresholds: MarginThresholds { call_level: dec!(100), stop_out_level: dec!(99) },
            positions: (0..10)
                .map(|_| WatchedPosition {
                    id: "p".into(),
                    symbol: "XAUUSD".into(),
                    side: protocol::OrderSide::Buy,
                    volume: dec!(0.01),
                    open_price: dec!(4290),
                    contract_size: dec!(100),
                    quote_currency: "USD".into(),
                    hedged_margin_pct: dec!(200),
                    ask_rule: None,
                })
                .collect(),
        }
    }

    // used margin at bid 4280 = 10 x 0.01 x 100 x 4280 / 1000 = 42.80; floating = 10 x (4280-4290) = -100.
    // balance 142 -> equity 42.00 -> 98.13 % (<= 99, stop-out); balance 150 -> 50.00 -> 116.8 % (ok).

    #[test]
    fn measure_is_the_canonical_live_close_side_formula() {
        let cache = cache_with(&[(tick("XAUUSD", dec!(4280), dec!(4280.30)), 0)]);
        let (equity, used) = measure(&gold_account("a", dec!(142)), &cache);
        assert_eq!((equity, used), (dec!(42.00), dec!(42.800)));
    }

    #[test]
    fn a_tick_that_puts_an_account_at_or_below_stop_out_fires_its_symbol() {
        let w = MarginWatch::new();
        w.set_book(Book::new(vec![gold_account("a", dec!(142))]));
        let t = tick("XAUUSD", dec!(4280), dec!(4280.30));
        let cache = cache_with(&[(t.clone(), 0)]);
        assert_eq!(w.decide(&[t], &cache, Instant::now()), vec!["XAUUSD".to_string()]);
    }

    #[test]
    fn an_account_above_both_levels_fires_nothing() {
        let w = MarginWatch::new();
        w.set_book(Book::new(vec![gold_account("a", dec!(150))]));
        let t = tick("XAUUSD", dec!(4280), dec!(4280.30));
        let cache = cache_with(&[(t.clone(), 0)]);
        assert!(w.decide(&[t], &cache, Instant::now()).is_empty());
    }

    #[test]
    fn a_tick_of_a_symbol_nobody_holds_fires_nothing() {
        let w = MarginWatch::new();
        w.set_book(Book::new(vec![gold_account("a", dec!(142))]));
        let t = tick("EURUSD", dec!(1.1), dec!(1.1001));
        let cache = cache_with(&[(t.clone(), 0), (tick("XAUUSD", dec!(4280), dec!(4280.30)), 0)]);
        assert!(w.decide(&[t], &cache, Instant::now()).is_empty());
    }

    #[test]
    fn a_stale_price_is_unpriced_like_on_the_web_so_nothing_fires() {
        let w = MarginWatch::new();
        w.set_book(Book::new(vec![gold_account("a", dec!(142))]));
        let t = tick("XAUUSD", dec!(4280), dec!(4280.30));
        let cache = cache_with(&[(t.clone(), 20)]);
        assert!(w.decide(&[t], &cache, Instant::now()).is_empty());
    }

    #[test]
    fn a_stop_out_that_stays_re_fires_with_backoff_and_resets_once_back_above() {
        let w = MarginWatch::new();
        w.set_book(Book::new(vec![gold_account("a", dec!(142))]));
        let t = tick("XAUUSD", dec!(4280), dec!(4280.30));
        let cache = cache_with(&[(t.clone(), 0)]);
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let fired = |now| !w.decide(std::slice::from_ref(&t), &cache, now).is_empty();
        assert!(fired(at(0)), "first: at once");
        assert!(!fired(at(500)), "second: not before 1 s");
        assert!(fired(at(1000)));
        assert!(!fired(at(2500)), "third: not before 2 s after the second");
        assert!(fired(at(3000)));
        // back above both levels: that is also the margin-call edge out, one evaluation, then quiet
        w.set_book(Book::new(vec![gold_account("a", dec!(150))]));
        assert!(fired(at(3100)), "edge out of margin call");
        assert!(!fired(at(9000)), "staying above: nothing");
        // the backoff was reset: the next stop-out fires at once again
        let at = |ms: u64| t0 + Duration::from_millis(ms + 6000);
        w.set_book(Book::new(vec![gold_account("a", dec!(142))]));
        assert!(fired(at(3200)));
    }

    #[test]
    fn the_backoff_is_capped_at_30_s() {
        let w = MarginWatch::new();
        w.set_book(Book::new(vec![gold_account("a", dec!(142))]));
        let t = tick("XAUUSD", dec!(4280), dec!(4280.30));
        let cache = cache_with(&[(t.clone(), 0)]);
        let t0 = Instant::now();
        let mut now = t0;
        for _ in 0..12 {
            assert!(!w.decide(std::slice::from_ref(&t), &cache, now).is_empty());
            now += Duration::from_secs(30);
        }
    }

    #[test]
    fn a_margin_call_edge_fires_once_in_and_once_out() {
        let w = MarginWatch::new();
        // balance 144 -> equity 44.00 / 42.80 = 102.8 %: ok at call 100? no -> set call 110 so it is a call, not a stop-out
        let mut a = gold_account("a", dec!(144));
        a.thresholds = MarginThresholds { call_level: dec!(110), stop_out_level: dec!(99) };
        w.set_book(Book::new(vec![a.clone()]));
        let t = tick("XAUUSD", dec!(4280), dec!(4280.30));
        let cache = cache_with(&[(t.clone(), 0)]);
        let t0 = Instant::now();
        assert!(!w.decide(std::slice::from_ref(&t), &cache, t0).is_empty(), "edge in");
        assert!(w.decide(std::slice::from_ref(&t), &cache, t0 + Duration::from_secs(6)).is_empty(), "still in: no repeat");
        a.balance = dec!(160);
        w.set_book(Book::new(vec![a]));
        assert!(!w.decide(std::slice::from_ref(&t), &cache, t0 + Duration::from_secs(12)).is_empty(), "edge out");
    }

    /// Account 50005708, 2026-10-01 04:19:08-04:21:40 UTC: the web's 11 margin-call episodes (MARGIN_CALL /
    /// MARGIN_CALL_CLEARED notices, seconds after 04:19:00), including the 0.58 s episode 5 at 04:20:04.94.
    pub(crate) const FLAP_50005708: [(f64, f64); 11] = [
        (8.943, 14.889), (43.717, 49.877), (51.806, 54.866), (57.888, 59.869), (64.940, 65.520),
        (75.133, 82.492), (84.937, 88.130), (95.701, 100.236), (102.287, 108.631), (127.105, 153.198), (155.018, 160.068),
    ];

    /// Replays the 11 flaps through decide() on a tick every 100 ms: which margin-call edges fire, and when.
    fn replay_flaps() -> Vec<(f64, bool)> {
        let w = MarginWatch::new();
        let acc = |balance| {
            let mut a = gold_account("a", balance);
            a.thresholds = MarginThresholds { call_level: dec!(110), stop_out_level: dec!(99) };
            a
        };
        let t = tick("XAUUSD", dec!(4280), dec!(4280.30));
        let cache = cache_with(&[(t.clone(), 0)]);
        let t0 = Instant::now();
        let mut fired = Vec::new();
        let mut was_in: Option<bool> = None;
        for step in 0..=1800u64 {
            let secs = step as f64 / 10.0;
            let is_in = FLAP_50005708.iter().any(|(i, o)| secs >= *i && secs < *o);
            if was_in != Some(is_in) {
                // 144 -> 102.8 % (in a call at 110, above the 99 stop-out); 160 -> out
                w.set_book(Book::new(vec![acc(if is_in { dec!(144) } else { dec!(160) })]));
                was_in = Some(is_in);
            }
            if !w.decide(std::slice::from_ref(&t), &cache, t0 + Duration::from_millis(step * 100)).is_empty() {
                fired.push((secs, is_in));
            }
        }
        fired
    }

    #[test]
    fn the_11_flap_sequence_fires_deferred_edges_never_loses_the_final_state() {
        let fired = replay_flaps();
        eprintln!("trigger fires for the 11 web episodes (s after 04:19:00, in?): {fired:?}");
        // alternating in / out, starting in, ending out (the account left its margin call at 04:21:40)
        for (k, (_, is_in)) in fired.iter().enumerate() {
            assert_eq!(*is_in, k % 2 == 0, "edges alternate: {fired:?}");
        }
        assert!(!fired.last().unwrap().1, "the final OUT is announced, not lost: {fired:?}");
        // never two edges within 5 s
        for w in fired.windows(2) {
            assert!(w[1].0 - w[0].0 >= 5.0 - 1e-9, "damped to one edge per 5 s: {fired:?}");
        }
        // The exact sequence (deterministic): 8 IN + 8 OUT for the web's 11 + 11. Episodes 3 (3.1 s) and 5 (0.58 s,
        // 04:20:04.94) began and ended inside the 5 s after an OUT fire, and episode 9 began inside the 5 s after episode
        // 8's IN fire while 8's OUT was still deferred: they are coalesced, never left stale -- every state the account
        // is in when a damping window ends is announced (at most 5 s late) and the last one (OUT) always is.
        let expected = [
            (9.0, true), (14.9, false), (43.8, true), (49.9, false), (57.9, true), (62.9, false), (75.2, true), (82.5, false),
            (87.5, true), (92.5, false), (97.5, true), (108.7, false), (127.2, true), (153.2, false), (158.2, true), (163.2, false),
        ];
        assert_eq!(fired, expected, "{fired:?}");
    }

    #[test]
    fn a_jpy_quoted_position_is_converted_into_the_account_currency() {
        // 1 lot USDJPY SELL at 150, ask 151 -> -1000 x 100000 / ... in JPY; converted at mid(USDJPY) = 1/151.0 approx
        let a = WatchedAccount {
            id: "j".into(),
            balance: dec!(1000),
            credit: dec!(0),
            leverage: 100,
            currency: "USD".into(),
            thresholds: MarginThresholds { call_level: dec!(100), stop_out_level: dec!(50) },
            positions: vec![WatchedPosition { id: "p".into(), symbol: "USDJPY".into(), side: protocol::OrderSide::Sell, volume: dec!(0.1), open_price: dec!(150), contract_size: dec!(100000), quote_currency: "JPY".into(), hedged_margin_pct: dec!(200), ask_rule: None }],
        };
        let cache = cache_with(&[(tick("USDJPY", dec!(151), dec!(151)), 0)]);
        let (equity, used) = measure(&a, &cache);
        // floating = (150 - 151) x 100000 x 0.1 = -10000 JPY / 151 = -66.225... USD; margin = 0.1 x 100000 x 151 / 100 = 15100 JPY = 100 USD
        assert_eq!(used.round_dp(6), dec!(100));
        assert_eq!((equity - dec!(1000)).round_dp(3), dec!(-66.225));
    }

    #[test]
    fn book_symbols_is_unknown_until_the_first_load_then_what_the_book_holds() {
        let w = MarginWatch::new();
        assert_eq!(w.book_symbols(), None, "not loaded: unknown, never 'flat'");
        w.set_book(Book::new(Vec::new()));
        assert_eq!(w.book_symbols(), Some(HashSet::new()));
        w.set_book(Book::new(vec![gold_account("a", dec!(1))]));
        assert_eq!(w.book_symbols(), Some(["XAUUSD".to_string()].into()));
    }

    #[test]
    fn book_new_indexes_each_account_once_per_symbol() {
        let b = Book::new(vec![gold_account("a", dec!(1)), gold_account("b", dec!(1))]);
        assert_eq!(b.by_symbol.get("XAUUSD"), Some(&vec![0, 1]));
    }
}
