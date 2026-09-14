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
//! level cannot flood Vercel; the minute cron stays as the backstop.
//!
//! Configured by `VYX_RISK_HOOK_URL` (e.g. https://vyxtrader.com/api/internal/margin-monitor)
//! and `VYX_RISK_HOOK_SECRET` (= the web app's CRON_SECRET); unset = off.

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
