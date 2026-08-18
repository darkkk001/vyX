//! Concurrency/latency benchmark for order placement -- the last open
//! row in docs/testing.md §2's cutover gate table. Hits the real
//! engine/server HTTP surface under concurrent load (not a
//! single-threaded in-process criterion micro-benchmark), since that's
//! what the gate's own wording asks for and what actually captures
//! connection-pool/lock contention. Smoke-scale by default, matching
//! docs/testing.md §5's "production-scale load testing is out of
//! scope for Phase 0" -- config via env vars, no CLI-arg crate needed.
//!
//! Re-runnable as a regression check: every row this run writes is
//! tagged with one fresh account_id and cleaned up unconditionally at
//! the end, not left for manual cleanup.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

const TEST_SYMBOL: &str = "MKPTEST";
const TEST_BROKER_ID: &str = "loadtest_broker";

#[derive(Debug, Serialize)]
struct PlaceMarketOrderBody {
    broker_id: String,
    account_id: String,
    symbol: String,
    side: &'static str,
    volume: Decimal,
    sl_price: Option<Decimal>,
    tp_price: Option<Decimal>,
    equity: Decimal,
    used_margin: Decimal,
    contract_size: Decimal,
    leverage: u32,
}

// Only the variant tag is used to classify each outcome -- the payload
// fields document the response shape (matching engine/server's actual
// response type) without this tool needing to read them.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
enum PlaceMarketOrderResponse {
    Filled { order_id: String, position_id: String, fill_price: Decimal },
    Rejected { order_id: String, reason: String },
}

struct Sample {
    latency_ms: f64,
    outcome: &'static str, // "FILLED" | "REJECTED" | "ERROR"
}

#[derive(Serialize)]
struct TickBody {
    symbol: String,
    bid: Decimal,
    ask: Decimal,
}

// Goes through the real /internal/price-feed ingest route -- the same
// path a real MT5 EA tick takes -- rather than writing "LivePrice"
// directly. Matters for this specific benchmark: only the real ingest
// route populates engine/server's in-memory TickCache that
// place_market_order now reads from; a raw SQL upsert would silently
// leave that cache cold and this tool would keep measuring the
// DB-fallback path even after the cache exists.
async fn ingest_live_price(
    client: &reqwest::Client,
    trading_core_url: &str,
    price_feed_secret: &str,
    symbol: &str,
    bid: Decimal,
    ask: Decimal,
) -> Result<(), reqwest::Error> {
    client
        .post(format!("{trading_core_url}/internal/price-feed"))
        .header("x-price-feed-secret", price_feed_secret)
        .json(&TickBody { symbol: symbol.to_string(), bid, ask })
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

fn percentile(sorted_ms: &[f64], p: f64) -> f64 {
    if sorted_ms.is_empty() {
        return 0.0;
    }
    let idx = ((sorted_ms.len() as f64 - 1.0) * p).round() as usize;
    sorted_ms[idx.min(sorted_ms.len() - 1)]
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let trading_core_url =
        std::env::var("TRADING_CORE_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".to_string());
    let price_feed_secret = std::env::var("PRICE_FEED_SECRET").expect("PRICE_FEED_SECRET must be set");
    let concurrency: usize = std::env::var("LOADTEST_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);
    let total_requests: i64 = std::env::var("LOADTEST_REQUESTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);

    let pool = PgPool::connect(&database_url).await?;

    let (_digits, contract_size): (i32, Decimal) =
        sqlx::query_as(r#"SELECT digits, "contractSize" FROM "Symbol" WHERE name = $1"#)
            .bind(TEST_SYMBOL)
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("seed symbol {TEST_SYMBOL} not found -- run the session's usual test fixture seed first: {e}"))?;

    let bid = Decimal::new(2000_00000, 5);
    let ask = Decimal::new(2000_20000, 5);
    let client = reqwest::Client::new();
    ingest_live_price(&client, &trading_core_url, &price_feed_secret, TEST_SYMBOL, bid, ask).await?;

    // Keeps the tick fresh for the whole run -- both the in-memory
    // TickCache's and get_live_price's 15s staleness windows would
    // otherwise leak "rejected: stale price" into the results on a
    // longer run, a confound unrelated to what this benchmark measures.
    let refresh_client = client.clone();
    let refresh_trading_core_url = trading_core_url.clone();
    let refresh_price_feed_secret = price_feed_secret.clone();
    let refresh_handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _ = ingest_live_price(&refresh_client, &refresh_trading_core_url, &refresh_price_feed_secret, TEST_SYMBOL, bid, ask).await;
        }
    });

    let account_id = format!("loadtest_{}", Uuid::new_v4());
    let remaining = std::sync::Arc::new(AtomicI64::new(total_requests));
    let samples = std::sync::Arc::new(Mutex::new(Vec::<Sample>::with_capacity(total_requests as usize)));

    println!("=== Load test: POST /v1/orders/market ===");
    println!("Concurrency: {concurrency}   Total requests: {total_requests}");
    println!("account_id: {account_id}");

    let started = Instant::now();
    let mut workers = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        let client = client.clone();
        let remaining = remaining.clone();
        let samples = samples.clone();
        let account_id = account_id.clone();
        let url = format!("{trading_core_url}/v1/orders/market");

        workers.push(tokio::spawn(async move {
            loop {
                let n = remaining.fetch_sub(1, Ordering::SeqCst);
                if n <= 0 {
                    break;
                }
                let side = if n % 2 == 0 { "BUY" } else { "SELL" };
                let body = PlaceMarketOrderBody {
                    broker_id: TEST_BROKER_ID.to_string(),
                    account_id: account_id.clone(),
                    symbol: TEST_SYMBOL.to_string(),
                    side,
                    volume: Decimal::new(1, 2), // 0.01
                    sl_price: None,
                    tp_price: None,
                    // Deliberately huge -- margin exhaustion mid-run
                    // would be a confound, not something this benchmark
                    // is measuring.
                    equity: Decimal::new(100_000_000_00, 2),
                    used_margin: Decimal::ZERO,
                    contract_size,
                    leverage: 100,
                };

                let request_start = Instant::now();
                let outcome = match client.post(&url).json(&body).send().await {
                    Ok(resp) => match resp.json::<PlaceMarketOrderResponse>().await {
                        Ok(PlaceMarketOrderResponse::Filled { .. }) => "FILLED",
                        Ok(PlaceMarketOrderResponse::Rejected { .. }) => "REJECTED",
                        Err(_) => "ERROR",
                    },
                    Err(_) => "ERROR",
                };
                let latency_ms = request_start.elapsed().as_secs_f64() * 1000.0;

                samples.lock().unwrap().push(Sample { latency_ms, outcome });
            }
        }));
    }

    for w in workers {
        let _ = w.await;
    }
    let elapsed = started.elapsed();
    refresh_handle.abort();

    let samples = samples.lock().unwrap();
    let mut latencies: Vec<f64> = samples.iter().map(|s| s.latency_ms).collect();
    latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let filled = samples.iter().filter(|s| s.outcome == "FILLED").count();
    let rejected = samples.iter().filter(|s| s.outcome == "REJECTED").count();
    let errors = samples.iter().filter(|s| s.outcome == "ERROR").count();
    let mean = if latencies.is_empty() { 0.0 } else { latencies.iter().sum::<f64>() / latencies.len() as f64 };
    let throughput = samples.len() as f64 / elapsed.as_secs_f64();

    println!("Elapsed: {:.2}s   Throughput: {:.1} req/s", elapsed.as_secs_f64(), throughput);
    println!("Outcomes: {filled} FILLED, {rejected} REJECTED, {errors} errors");
    println!(
        "Latency (ms): p50={:.0}  p95={:.0}  p99={:.0}  max={:.0}  mean={:.0}",
        percentile(&latencies, 0.50),
        percentile(&latencies, 0.95),
        percentile(&latencies, 0.99),
        latencies.last().copied().unwrap_or(0.0),
        mean
    );

    let del_ledger = sqlx::query(
        r#"DELETE FROM ledger_entries WHERE related_position_id IN (SELECT id FROM positions WHERE account_id = $1)"#,
    )
    .bind(&account_id)
    .execute(&pool)
    .await?;
    let del_positions = sqlx::query(r#"DELETE FROM positions WHERE account_id = $1"#)
        .bind(&account_id)
        .execute(&pool)
        .await?;
    let del_orders = sqlx::query(r#"DELETE FROM orders WHERE account_id = $1"#)
        .bind(&account_id)
        .execute(&pool)
        .await?;
    println!(
        "Cleaned up: {} ledger_entries, {} positions, {} orders",
        del_ledger.rows_affected(),
        del_positions.rows_affected(),
        del_orders.rows_affected()
    );

    Ok(())
}
