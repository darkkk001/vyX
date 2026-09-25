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

use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use protocol::Tick;

use crate::cache::TickCache;

/// The per-tick margin trigger (see the module doc). Pure in-memory on the flush path: no I/O.
pub trait MarginWatch: Send + Sync {
    /// After a LivePrice flush: the flushed symbols whose accounts the web must evaluate now.
    fn symbols_to_evaluate(&self, flushed: &[Tick], cache: &TickCache) -> Vec<String>;
    /// A margin-triggered evaluation came back (closes may have happened): refresh the watched book.
    fn evaluated(&self);
}

#[derive(Clone, Debug)]
struct Level {
    is_buy: bool,
    sl: Option<Decimal>,
    tp: Option<Decimal>,
}

/// A resting LIMIT / STOP order's entry (audit 2026-09-24 Batch 4): pending orders trigger SERVER-side. The tick that
/// crosses the entry fires the same `?symbols=` call; the web (lib/pending-trigger.ts) re-checks the trigger on its
/// own price and fills. A BUY trades at the ask, a SELL at the bid.
#[derive(Clone, Copy, Debug, PartialEq)]
struct PendingLevel {
    is_buy: bool,
    is_limit: bool,
    entry: Decimal,
}

impl PendingLevel {
    fn triggered(&self, bid: Decimal, ask: Decimal) -> bool {
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
}

impl RiskHook {
    /// None when the env is not set (the hook is opt-in per deployment).
    pub fn from_env() -> Option<Arc<RiskHook>> {
        let url = std::env::var("VYX_RISK_HOOK_URL").ok().filter(|s| !s.trim().is_empty())?;
        let secret = std::env::var("VYX_RISK_HOOK_SECRET").ok().filter(|s| !s.trim().is_empty())?;
        let client = reqwest::Client::builder().timeout(Duration::from_secs(12)).build().ok()?;
        tracing::info!(url = %url, "risk hook enabled: SL/TP evaluation fires on the tick that touches a level");
        Some(Arc::new(RiskHook {
            url,
            secret,
            client,
            levels: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            last_fired: Mutex::new(HashMap::new()),
            margin_watch: std::sync::OnceLock::new(),
        }))
    }

    /// Plug in the per-tick margin trigger (once; a second call is ignored).
    pub fn set_margin_watch(&self, watch: Arc<dyn MarginWatch>) {
        let _ = self.margin_watch.set(watch);
    }

    /// Reload the open positions' levels (symbol -> [side, sl, tp]) from the Prisma table.
    pub async fn reload(&self, pool: &PgPool) {
        let rows: Result<Vec<(String, String, Option<Decimal>, Option<Decimal>)>, sqlx::Error> = sqlx::query_as(
            r#"SELECT s.name, p.side::text, p."slPrice", p."tpPrice"
               FROM "Position" p JOIN "Symbol" s ON s.id = p."symbolId"
               WHERE p.status = 'OPEN' AND (p."slPrice" IS NOT NULL OR p."tpPrice" IS NOT NULL)"#,
        )
        .fetch_all(pool)
        .await;
        match rows {
            Ok(rows) => {
                let mut map: HashMap<String, Vec<Level>> = HashMap::new();
                for (symbol, side, sl, tp) in rows {
                    map.entry(symbol).or_default().push(Level { is_buy: side == "BUY", sl, tp });
                }
                *self.levels.lock().unwrap() = map;
            }
            Err(err) => tracing::warn!(error = %err, "risk hook: could not reload SL/TP levels"),
        }
        // resting LIMIT / STOP orders (the web's own "Order" table: PENDING, not the engine's orders table)
        let pending: Result<Vec<(String, String, String, Decimal)>, sqlx::Error> = sqlx::query_as(
            r#"SELECT s.name, o.side::text, o.type::text, o."requestedPrice"
               FROM "Order" o JOIN "Symbol" s ON s.id = o."symbolId"
               WHERE o.status = 'PENDING' AND o.type IN ('LIMIT', 'STOP') AND o."requestedPrice" IS NOT NULL"#,
        )
        .fetch_all(pool)
        .await;
        match pending {
            Ok(rows) => {
                let mut map: HashMap<String, Vec<PendingLevel>> = HashMap::new();
                for (symbol, side, kind, entry) in rows {
                    map.entry(symbol).or_default().push(PendingLevel { is_buy: side == "BUY", is_limit: kind == "LIMIT", entry });
                }
                *self.pending.lock().unwrap() = map;
            }
            Err(err) => tracing::warn!(error = %err, "risk hook: could not reload pending order entries"),
        }
    }

    /// Symbols among the flushed ticks whose bid / ask touches an open level.
    fn touched(&self, ticks: &[Tick]) -> Vec<String> {
        let levels = self.levels.lock().unwrap();
        let mut out = Vec::new();
        for t in ticks {
            let Some(ls) = levels.get(&t.symbol) else { continue };
            let hit = ls.iter().any(|l| {
                // close price: a BUY closes at bid, a SELL at ask (lib/trading.ts closePriceFor)
                let cp = if l.is_buy { t.bid } else { t.ask };
                let sl_hit = l.sl.map_or(false, |sl| if l.is_buy { cp <= sl } else { cp >= sl });
                let tp_hit = l.tp.map_or(false, |tp| if l.is_buy { cp >= tp } else { cp <= tp });
                sl_hit || tp_hit
            });
            if hit && !out.contains(&t.symbol) {
                out.push(t.symbol.clone());
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
        out
    }

    /// After a LivePrice flush: fire the evaluation for every symbol whose ticks touched an SL / TP, or put
    /// an account holding it at or below stop-out / across margin call (max once a second each).
    pub fn after_flush(self: &Arc<Self>, ticks: &[Tick], cache: &TickCache) {
        let mut symbols = self.touched(ticks);
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

    /// The full-book backstop (see the module doc): a full pass every `every`, the first at start.
    /// Passes are awaited one after another, so a slow route delays the next instead of piling up.
    pub fn spawn_backstop_loop(self: &Arc<Self>, every: Duration) {
        let hook = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(every);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                hook.fire_full_pass().await;
            }
        });
    }

    /// Keep the levels current: every `every` (and the caller may reload on NATS position events).
    pub fn spawn_reload_loop(self: &Arc<Self>, pool: PgPool, every: Duration) {
        let hook = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                hook.reload(&pool).await;
                tokio::time::sleep(every).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use rust_decimal_macros::dec;

    #[test]
    fn pending_entries_trigger_on_the_side_they_trade() {
        let buy_limit = super::PendingLevel { is_buy: true, is_limit: true, entry: dec!(100) };
        assert!(buy_limit.triggered(dec!(99.8), dec!(100.0)));
        assert!(!buy_limit.triggered(dec!(99.9), dec!(100.1)));
        let buy_stop = super::PendingLevel { is_buy: true, is_limit: false, entry: dec!(100) };
        assert!(buy_stop.triggered(dec!(99.9), dec!(100.1)));
        assert!(!buy_stop.triggered(dec!(99.7), dec!(99.9)));
        let sell_limit = super::PendingLevel { is_buy: false, is_limit: true, entry: dec!(100) };
        assert!(sell_limit.triggered(dec!(100.0), dec!(100.2)));
        assert!(!sell_limit.triggered(dec!(99.9), dec!(100.1)));
        let sell_stop = super::PendingLevel { is_buy: false, is_limit: false, entry: dec!(100) };
        assert!(sell_stop.triggered(dec!(99.9), dec!(100.1)));
        assert!(!sell_stop.triggered(dec!(100.1), dec!(100.3)));
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
        })
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
        h.after_flush(&[tick("XAUUSD")], &TickCache::new());
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
        h.after_flush(&[tick("XAUUSD")], &TickCache::new());
        assert!(tokio::time::timeout(Duration::from_millis(300), rx.recv()).await.is_err());
    }

    #[tokio::test]
    async fn without_a_margin_watch_or_a_touched_level_nothing_fires() {
        let (url, mut rx) = mock_route(200).await;
        hook(url).after_flush(&[tick("XAUUSD")], &TickCache::new());
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
        hook(url).spawn_backstop_loop(Duration::from_millis(300));
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
        hook(url).spawn_backstop_loop(Duration::from_millis(100));
        for _ in 0..3 {
            tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("loop kept running").unwrap();
        }
    }

    /// Manual e2e: a real margin-monitor route (local `next dev` on a scratch DB) and nothing but the
    /// backstop loop driving it -- no cron, no tick. Run with VYX_RISK_HOOK_URL / VYX_RISK_HOOK_SECRET
    /// set and `-- --ignored`; the caller checks the DB afterwards.
    #[tokio::test]
    #[ignore]
    async fn e2e_backstop_drives_a_real_margin_monitor_route() {
        let hook = RiskHook::from_env().expect("VYX_RISK_HOOK_URL / VYX_RISK_HOOK_SECRET");
        hook.spawn_backstop_loop(Duration::from_secs(5));
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
