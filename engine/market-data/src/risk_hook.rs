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

use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use protocol::Tick;

#[derive(Clone, Debug)]
struct Level {
    is_buy: bool,
    sl: Option<Decimal>,
    tp: Option<Decimal>,
}

pub struct RiskHook {
    url: String,
    secret: String,
    client: reqwest::Client,
    levels: Mutex<HashMap<String, Vec<Level>>>,
    last_fired: Mutex<HashMap<String, Instant>>,
}

impl RiskHook {
    /// None when the env is not set (the hook is opt-in per deployment).
    pub fn from_env() -> Option<Arc<RiskHook>> {
        let url = std::env::var("VYX_RISK_HOOK_URL").ok().filter(|s| !s.trim().is_empty())?;
        let secret = std::env::var("VYX_RISK_HOOK_SECRET").ok().filter(|s| !s.trim().is_empty())?;
        let client = reqwest::Client::builder().timeout(Duration::from_secs(12)).build().ok()?;
        tracing::info!(url = %url, "risk hook enabled: SL/TP evaluation fires on the tick that touches a level");
        Some(Arc::new(RiskHook { url, secret, client, levels: Mutex::new(HashMap::new()), last_fired: Mutex::new(HashMap::new()) }))
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
        out
    }

    /// After a LivePrice flush: fire the evaluation for every touched symbol (max once a second each).
    pub fn after_flush(self: &Arc<Self>, ticks: &[Tick]) {
        let mut symbols = self.touched(ticks);
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
                Ok(resp) if resp.status().is_success() => tracing::info!(symbols = %symbols.join(","), "risk hook fired"),
                Ok(resp) => tracing::warn!(status = %resp.status(), "risk hook rejected"),
                Err(err) => tracing::warn!(error = %err, "risk hook failed"),
            }
        });
    }

    /// `VYX_RISK_HOOK_BACKSTOP_SECS` (default 60); None when set to 0 (backstop off).
    pub fn backstop_interval_from_env() -> Option<Duration> {
        let secs = std::env::var("VYX_RISK_HOOK_BACKSTOP_SECS").ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(60);
        (secs > 0).then(|| Duration::from_secs(secs))
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
            last_fired: Mutex::new(HashMap::new()),
        })
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
