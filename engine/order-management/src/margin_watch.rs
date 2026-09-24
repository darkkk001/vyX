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
//! Damping: a stop-out that stays (the web disagrees, e.g. a session it treats as closed) re-fires after
//! 1, 2, 4 ... 30 s, reset once the account is back above; a margin-call edge fires at most every 5 s per
//! account.

use crate::{calc, db, fx};
use market_data::cache::TickCache;
use margin::{MarginThresholds, MonitorAction};
use protocol::Tick;
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// The web's price freshness rule (lib/live-price.ts getFreshPrices, book.rs: tickAt under 15 s).
const FRESH: i64 = 15;
/// A margin-call edge (in or out) fires at most this often per account.
const EDGE_EVERY: Duration = Duration::from_secs(5);
/// Cap of the re-fire backoff for a stop-out that stays.
const MAX_BACKOFF_SECS: u64 = 30;

#[derive(Clone, Debug, PartialEq)]
pub struct WatchedPosition {
    pub symbol: String,
    pub side: protocol::OrderSide,
    pub volume: Decimal,
    pub open_price: Decimal,
    pub contract_size: Decimal,
    pub quote_currency: String,
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
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, Decimal, Decimal, i32, String, Option<Decimal>, Option<Decimal>, String, String, Decimal, Decimal, Decimal, String)> =
        sqlx::query_as(
            r#"SELECT a.id, a.balance, a.credit, a.leverage, a.currency, g."marginCallLevel", g."stopOutLevel",
                      s.name, p.side::text, p.volume, p."openPrice", s."contractSize", s."quoteCurrency"
               FROM "Position" p
               JOIN "Account" a ON a.id = p."accountId"
               JOIN "Symbol" s ON s.id = p."symbolId"
               LEFT JOIN "Group" g ON g.id = a."groupId"
               WHERE p.status = 'OPEN'
               ORDER BY a.id COLLATE "C", p."openedAt", p.id"#,
        )
        .fetch_all(e)
        .await?;
    let d = MarginThresholds::default();
    let mut accounts: Vec<WatchedAccount> = Vec::new();
    for (id, balance, credit, leverage, currency, call, stop_out, symbol, side, volume, open_price, contract_size, quote_currency) in rows {
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
        accounts.last_mut().unwrap().positions.push(WatchedPosition { symbol, side, volume, open_price, contract_size, quote_currency });
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
            }
        })
        .collect();
    let state = calc::AccountState { effective_balance: account.balance, credit: account.credit, leverage: account.leverage, positions };
    (calc::equity(&state), calc::used_margin(&state))
}

#[derive(Default, Debug)]
struct Track {
    in_call: bool,
    stop_out_fires: u32,
    last_stop_out_fire: Option<Instant>,
    last_edge_fire: Option<Instant>,
}

pub struct MarginWatch {
    book: RwLock<Arc<Book>>,
    tracks: Mutex<HashMap<String, Track>>,
    reload_now: Notify,
}

impl MarginWatch {
    pub fn new() -> Arc<Self> {
        Arc::new(MarginWatch { book: RwLock::new(Arc::new(Book::default())), tracks: Mutex::new(HashMap::new()), reload_now: Notify::new() })
    }

    pub fn set_book(&self, book: Book) {
        let ids: HashSet<&str> = book.accounts.iter().map(|a| a.id.as_str()).collect();
        // forget the damping of accounts that no longer hold anything
        self.tracks.lock().unwrap().retain(|id, _| ids.contains(id.as_str()));
        *self.book.write().unwrap() = Arc::new(book);
    }

    pub async fn reload(&self, pool: &PgPool) {
        match load_book(pool).await {
            Ok(book) => self.set_book(book),
            Err(err) => tracing::warn!(error = %err, "margin trigger: could not reload the book (keeping the last one)"),
        }
    }

    /// Refresh the book every `every`, and at once after a triggered evaluation (closes change it).
    pub fn spawn_reload_loop(self: &Arc<Self>, pool: PgPool, every: Duration) {
        let watch = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                watch.reload(&pool).await;
                tokio::select! {
                    _ = tokio::time::sleep(every) => {}
                    _ = watch.reload_now.notified() => {}
                }
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
                        due
                    }
                    MonitorAction::MarginCall | MonitorAction::Ok => {
                        track.stop_out_fires = 0;
                        track.last_stop_out_fire = None;
                        let in_call = action == MonitorAction::MarginCall;
                        let edge = in_call != track.in_call && track.last_edge_fire.is_none_or(|l| now.duration_since(l) >= EDGE_EVERY);
                        track.in_call = in_call;
                        if edge {
                            track.last_edge_fire = Some(now);
                        }
                        edge
                    }
                };
                if fire && !out.contains(&t.symbol) {
                    out.push(t.symbol.clone());
                }
            }
        }
        out
    }
}

impl market_data::risk_hook::MarginWatch for MarginWatch {
    fn symbols_to_evaluate(&self, flushed: &[Tick], cache: &TickCache) -> Vec<String> {
        self.decide(flushed, cache, Instant::now())
    }

    fn evaluated(&self) {
        self.reload_now.notify_one();
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
                    symbol: "XAUUSD".into(),
                    side: protocol::OrderSide::Buy,
                    volume: dec!(0.01),
                    open_price: dec!(4290),
                    contract_size: dec!(100),
                    quote_currency: "USD".into(),
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
            positions: vec![WatchedPosition { symbol: "USDJPY".into(), side: protocol::OrderSide::Sell, volume: dec!(0.1), open_price: dec!(150), contract_size: dec!(100000), quote_currency: "JPY".into() }],
        };
        let cache = cache_with(&[(tick("USDJPY", dec!(151), dec!(151)), 0)]);
        let (equity, used) = measure(&a, &cache);
        // floating = (150 - 151) x 100000 x 0.1 = -10000 JPY / 151 = -66.225... USD; margin = 0.1 x 100000 x 151 / 100 = 15100 JPY = 100 USD
        assert_eq!(used.round_dp(6), dec!(100));
        assert_eq!((equity - dec!(1000)).round_dp(3), dec!(-66.225));
    }

    #[test]
    fn book_new_indexes_each_account_once_per_symbol() {
        let b = Book::new(vec![gold_account("a", dec!(1)), gold_account("b", dec!(1))]);
        assert_eq!(b.by_symbol.get("XAUUSD"), Some(&vec![0, 1]));
    }
}
