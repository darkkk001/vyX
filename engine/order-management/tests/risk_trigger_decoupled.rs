//! S3 2026-09-28 22:26:00 UTC (49990004, vEUR, hedge-break then a 0.2 %/s ramp): the margin level crossed stop-out on
//! ONE tick (54.24 % -> 44.40 % at bid 1.06532) and the per-tick margin trigger never ran on it. The trigger was
//! chained behind the LivePrice database write (ingest::spawn_periodic_flush called the hook only after a SUCCESSFUL
//! flush, in the same sequential loop); that write logged "live-price flush timed out (timeout_ms=2000)", so the
//! crossing tick was skipped while the web, reading the engine's tick cache, stopped the account out on its 5 s poll:
//! WEB_ONLY in shadow, a late stop-out in RUST mode.
//!
//! The fix: the trigger runs in its own loop from the tick cache (ingest::spawn_risk_trigger), never behind a write.
//! These tests run the REAL flush + trigger loops, the real MarginWatch on S3's exact account and the real RiskHook
//! against a stub web route, with the LivePrice write target either STALLED (accepts the connection and never answers,
//! so every write hits the 2 s timeout) or REFUSED (every write fails at once), and assert the trigger fires ON the
//! crossing tick, within one trigger interval, while every write failed. No database is needed.
//!
//!   cargo test -p order-management --test risk_trigger_decoupled

use market_data::broker_offset::BrokerOffsetTracker;
use market_data::cache::TickCache;
use market_data::gap_fill::GapFillTracker;
use market_data::risk_hook::RiskHook;
use market_data::sink::{MarketDataPools, WriteMode};
use market_data::stats::FeedStats;
use margin::MarginThresholds;
use order_management::margin_watch::{measure, Book, MarginFire, MarginWatch, WatchedAccount, WatchedPosition};
use protocol::Tick;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

const TRIGGER_EVERY: Duration = Duration::from_millis(250); // the VPS LIVE_PRICE_FLUSH_INTERVAL_MS
/// fired ON the crossing tick: within one trigger interval plus scheduling slack, far below the 2 s write timeout
const MAX_LATENCY: Duration = Duration::from_millis(700);

/// 49990004 after the SELL leg closed (live rows): balance 354.635, leverage 50, SO 50 / MC 100, one BUY 0.08 vEUR
/// at 1.1002, contract 100000, hedged margin 50 %.
fn s3_account() -> WatchedAccount {
    WatchedAccount {
        id: "cmuhzbyhu002evczw9by38okm".into(),
        balance: dec!(354.635),
        credit: dec!(0),
        leverage: 50,
        currency: "USD".into(),
        thresholds: MarginThresholds { call_level: dec!(100), stop_out_level: dec!(50) },
        positions: vec![WatchedPosition {
            id: "cmultfygx000tia04zt47yq4g".into(),
            symbol: "vEUR".into(),
            side: protocol::OrderSide::Buy,
            volume: dec!(0.08),
            open_price: dec!(1.1002),
            contract_size: dec!(100000),
            quote_currency: "USD".into(),
            hedged_margin_pct: dec!(50),
            ask_rule: None,
        }],
    }
}

fn veur(bid: Decimal) -> Tick {
    serde_json::from_value(serde_json::json!({ "symbol": "vEUR", "bid": bid, "ask": bid + dec!(0.0002) })).unwrap()
}

fn level(account: &WatchedAccount, cache: &TickCache) -> Decimal {
    let (equity, used) = measure(account, cache);
    (equity / used * dec!(100)).round_dp(2)
}

#[derive(Clone, Copy, Debug)]
enum Write {
    /// the database accepts the connection and never answers: every write runs into the 2 s timeout
    Stalled,
    /// nothing listens: every write fails at once
    Refused,
}

/// A LivePrice write target that never succeeds, the way `write` says.
async fn failing_db(write: Write) -> PgPool {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    match write {
        Write::Stalled => {
            tokio::spawn(async move {
                let mut held = Vec::new();
                while let Ok((sock, _)) = listener.accept().await {
                    held.push(sock); // accepted, never answered
                }
            });
        }
        Write::Refused => drop(listener),
    }
    sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_secs(30))
        .connect_lazy(&format!("postgresql://nobody@127.0.0.1:{port}/none"))
        .unwrap()
}

/// The web's margin-monitor route, stubbed: every request line, with when it arrived.
async fn stub_web() -> (String, UnboundedReceiver<(Instant, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api/internal/margin-monitor", listener.local_addr().unwrap());
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
                let _ = tx.send((Instant::now(), line));
                let _ = sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}").await;
            });
        }
    });
    (url, rx)
}

struct Rig {
    cache: Arc<TickCache>,
    stats: Arc<FeedStats>,
    fires: UnboundedReceiver<MarginFire>,
    web: UnboundedReceiver<(Instant, String)>,
    account: WatchedAccount,
    _keep: UnboundedSender<()>,
}

/// The production wiring (server main.rs): the flush loops + the trigger, the hook with the margin watch plugged in.
async fn rig(write: Write) -> Rig {
    let (url, web) = stub_web().await;
    let hook = RiskHook::new(url, "s3cret".into(), Duration::from_secs(5)).unwrap();
    let account = s3_account();
    let watch = MarginWatch::new();
    watch.set_book(Book::new(vec![account.clone()]));
    let (tx, fires) = tokio::sync::mpsc::unbounded_channel::<MarginFire>();
    watch.set_on_fire(tx);
    hook.set_margin_watch(watch);
    let cache = Arc::new(TickCache::new());
    let stats = Arc::new(FeedStats::new());
    let pools = Arc::new(MarketDataPools::new(failing_db(write).await, None, WriteMode::Neon));
    market_data::ingest::spawn_periodic_flush(
        pools,
        cache.clone(),
        TRIGGER_EVERY,
        Duration::from_millis(1000),
        stats.clone(),
        Arc::new(GapFillTracker::new()),
        Arc::new(BrokerOffsetTracker::new()),
        Some(hook),
    );
    let (keep, _) = tokio::sync::mpsc::unbounded_channel();
    Rig { cache, stats, fires, web, account, _keep: keep }
}

impl Rig {
    /// A tick arriving (what ingest_ticks does to the cache), with when.
    fn tick(&self, bid: Decimal) -> Instant {
        self.cache.set(&veur(bid), chrono::Utc::now());
        Instant::now()
    }

    /// The next fire whose pinned vEUR bid is `bid`, with when it arrived (other fires are skipped).
    async fn fire_at(&mut self, bid: Decimal, within: Duration) -> Option<Instant> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            match tokio::time::timeout_at(deadline, self.fires.recv()).await {
                Ok(Some(f)) if f.pin.ticks.get("vEUR").map(|t| t.0) == Some(bid) => return Some(Instant::now()),
                Ok(Some(_)) => continue,
                _ => return None,
            }
        }
    }

    /// The first web call for vEUR at or after `from`.
    async fn web_call_after(&mut self, from: Instant, within: Duration) -> Option<Instant> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            match tokio::time::timeout_at(deadline, self.web.recv()).await {
                Ok(Some((at, line))) if at >= from && line.contains("symbols=vEUR") => return Some(at),
                Ok(Some(_)) => continue,
                _ => return None,
            }
        }
    }

    /// Every LivePrice / candle write so far failed, none succeeded (waits for the stalled ones to time out).
    async fn assert_every_write_failed(&self) {
        for _ in 0..60 {
            if self.stats.snapshot().db_fail > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let s = self.stats.snapshot();
        assert_eq!(s.db_ok, 0, "no write may have succeeded");
        assert!(s.db_fail > 0, "the writes must have failed (db_fail = {})", s.db_fail);
    }
}

async fn crossing_tick_with(write: Write) {
    let mut r = rig(write).await;
    // one tick above stop-out (54.24 %, in margin call): its write goes out and fails / stalls
    r.tick(dec!(1.06745));
    assert_eq!(level(&r.account, &r.cache), dec!(54.24));
    tokio::time::sleep(Duration::from_millis(1200)).await; // past the hook's 1 s per-symbol web-call limit
    while r.fires.try_recv().is_ok() {} // the margin-call edge
    // the crossing tick: S3's exact price, 44.40 % (the web: 44.35 %)
    let crossing = dec!(1.06532);
    let at = r.tick(crossing);
    assert!(level(&r.account, &r.cache) <= dec!(50));
    let fired = r.fire_at(crossing, Duration::from_secs(3)).await.unwrap_or_else(|| panic!("{write:?}: the trigger never fired on the crossing tick"));
    let latency = fired - at;
    eprintln!("{write:?}: crossing tick {crossing} -> trigger fired after {} ms", latency.as_millis());
    assert!(latency <= MAX_LATENCY, "{write:?}: stop-out delayed {} ms (the write, not the trigger, set the pace)", latency.as_millis());
    let called = r.web_call_after(at, Duration::from_secs(2)).await.unwrap_or_else(|| panic!("{write:?}: the web was never called"));
    assert!(called - at <= MAX_LATENCY + Duration::from_millis(300), "{write:?}: web called {} ms after the crossing tick", (called - at).as_millis());
    r.assert_every_write_failed().await;
}

#[tokio::test]
async fn the_stop_out_crossing_tick_fires_the_trigger_even_when_its_live_price_write_stalls() {
    crossing_tick_with(Write::Stalled).await;
}

#[tokio::test]
async fn the_stop_out_crossing_tick_fires_the_trigger_even_when_its_live_price_write_fails() {
    crossing_tick_with(Write::Refused).await;
}

/// S3's shape at 4x speed: a steady ramp down (0.2 % a tick, one tick every 250 ms) from 111 % through margin call
/// and stop-out, every write failing. The trigger must fire ON the first tick at or below stop-out.
async fn slow_ramp_with(write: Write) {
    let mut r = rig(write).await;
    let mut bid = dec!(1.0800);
    let mut crossing: Option<(Decimal, Instant)> = None;
    for _ in 0..80 {
        let at = r.tick(bid);
        if level(&r.account, &r.cache) <= dec!(50) {
            crossing = Some((bid, at));
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        bid = (bid * dec!(0.998)).round_dp(5);
    }
    let (bid, at) = crossing.expect("the ramp crosses stop-out");
    let fired = r.fire_at(bid, Duration::from_secs(3)).await.unwrap_or_else(|| panic!("{write:?}: no fire on the crossing tick {bid}"));
    let latency = fired - at;
    eprintln!("{write:?}: ramp crossed stop-out at {bid} -> trigger fired after {} ms", latency.as_millis());
    assert!(latency <= MAX_LATENCY, "{write:?}: stop-out delayed {} ms", latency.as_millis());
    r.web_call_after(at, Duration::from_secs(2)).await.unwrap_or_else(|| panic!("{write:?}: the web was never called for the crossing"));
    r.assert_every_write_failed().await;
}

#[tokio::test]
async fn a_slow_ramp_across_stop_out_fires_on_the_crossing_tick_while_every_live_price_write_stalls() {
    slow_ramp_with(Write::Stalled).await;
}

#[tokio::test]
async fn a_slow_ramp_across_stop_out_fires_on_the_crossing_tick_while_every_live_price_write_fails() {
    slow_ramp_with(Write::Refused).await;
}
