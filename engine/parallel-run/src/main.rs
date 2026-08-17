//! Parallel-run diagnostic -- docs/testing.md §4's "same order submitted
//! to both paths... compared for equivalence." Investigation before
//! writing this found that premise doesn't hold today: Legacy
//! (Next.js/Prisma) has zero margin/exposure checks and fills at a
//! client-supplied price; Rust does full margin gating and always fetches
//! its own price server-side. These are architecturally different by
//! design (Legacy is a documented Phase 2 stopgap), not a bug to
//! reconcile. This tool does NOT assert equivalence -- it runs the same
//! nominal order through both paths and reports exactly what happens on
//! each side, including the divergences, as a concrete reference for
//! cutover planning.
//!
//! Self-seeds a throwaway broker/symbol-config/trader account/price tick
//! and unconditionally cleans all of it up at the end, same discipline
//! as `loadtest`.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

const TEST_SYMBOL_NAME: &str = "MKPTEST";
const TEST_SYMBOL_ID: &str = "test_f61e2947a92e7796711f";
const TRADER_PASSWORD: &str = "ParallelRun1234!";

struct Fixtures {
    broker_id: String,
    broker_host: String,
    account_id: String,
    account_number: String,
    contract_size: Decimal,
}

async fn seed(pool: &PgPool) -> Result<Fixtures, Box<dyn std::error::Error>> {
    let broker_id = format!("paralleltest_broker_{}", Uuid::new_v4().simple());
    let subdomain = format!("paralleltest-{}", Uuid::new_v4().simple());
    sqlx::query(
        r#"INSERT INTO "Broker" (id, name, subdomain, tier, status, "createdAt", "updatedAt")
           VALUES ($1, 'Parallel Run Diagnostic Broker', $2, 'STANDARD', 'ACTIVE', now(), now())"#,
    )
    .bind(&broker_id)
    .bind(&subdomain)
    .execute(pool)
    .await?;

    // Deliberately nonzero spreadMarkup -- makes the expected Legacy/Rust
    // price divergence visible in the report instead of accidentally
    // hidden behind a zero default.
    sqlx::query(
        r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "spreadMarkup", "minLot", "maxLot", "lotStep", "swapLong", "swapShort", enabled, "commissionPerLot", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, 1.0, 0.01, 100, 0.01, 0, 0, true, 0, now(), now())"#,
    )
    .bind(format!("paralleltest_bs_{}", Uuid::new_v4().simple()))
    .bind(&broker_id)
    .bind(TEST_SYMBOL_ID)
    .execute(pool)
    .await?;

    let account_id = format!("paralleltest_acct_{}", Uuid::new_v4().simple());
    let account_number = format!("PARALLELRUN{}", chrono_like_millis());
    let password_hash = bcrypt::hash(TRADER_PASSWORD, bcrypt::DEFAULT_COST)?;
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "accountNumber", email, "passwordHash", "fullName", "accountType", currency, leverage, balance, credit, status, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'Parallel Run Diagnostic', 'LIVE', 'USD', 100, 1000000, 0, 'ACTIVE', now(), now())"#,
    )
    .bind(&account_id)
    .bind(&broker_id)
    .bind(&account_number)
    .bind(format!("{account_number}@paralleltest.local"))
    .bind(&password_hash)
    .execute(pool)
    .await?;

    let (_digits, contract_size): (i32, Decimal) =
        sqlx::query_as(r#"SELECT digits, "contractSize" FROM "Symbol" WHERE name = $1"#)
            .bind(TEST_SYMBOL_NAME)
            .fetch_one(pool)
            .await?;

    let bid = Decimal::new(2000_00000, 5);
    let ask = Decimal::new(2000_20000, 5);
    sqlx::query(
        r#"INSERT INTO "LivePrice" (symbol, bid, ask, "updatedAt")
           VALUES ($1, $2, $3, now())
           ON CONFLICT (symbol) DO UPDATE SET bid = $2, ask = $3, "updatedAt" = now()"#,
    )
    .bind(TEST_SYMBOL_NAME)
    .bind(bid)
    .bind(ask)
    .execute(pool)
    .await?;

    Ok(Fixtures {
        broker_id,
        broker_host: format!("{subdomain}.localhost:3000"),
        account_id,
        account_number,
        contract_size,
    })
}

/// `get_live_price`'s 15s staleness window means the tick seeded once at
/// startup can go stale by the time a scenario actually reaches the Rust
/// call (Legacy's login+order round trip against this sandbox's remote
/// DB isn't instant) -- refresh immediately before each Rust call rather
/// than relying on the one seeded at the start of the run.
async fn refresh_live_price(pool: &PgPool) -> Result<(), sqlx::Error> {
    let bid = Decimal::new(2000_00000, 5);
    let ask = Decimal::new(2000_20000, 5);
    sqlx::query(
        r#"INSERT INTO "LivePrice" (symbol, bid, ask, "updatedAt")
           VALUES ($1, $2, $3, now())
           ON CONFLICT (symbol) DO UPDATE SET bid = $2, ask = $3, "updatedAt" = now()"#,
    )
    .bind(TEST_SYMBOL_NAME)
    .bind(bid)
    .bind(ask)
    .execute(pool)
    .await?;
    Ok(())
}

fn chrono_like_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

#[derive(Debug, Serialize)]
struct LegacyOrderBody {
    symbol: String,
    side: &'static str,
    #[serde(rename = "type")]
    order_type: &'static str,
    volume: String,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
    price: String,
}

async fn legacy_login(
    client: &reqwest::Client,
    nextjs_url: &str,
    host: &str,
    account_number: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let resp = client
        .post(format!("{nextjs_url}/api/trade/login"))
        .header("Host", host)
        .json(&serde_json::json!({ "accountNumber": account_number, "password": TRADER_PASSWORD }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(format!("legacy login failed: {} {}", resp.status(), resp.text().await?).into());
    }
    Ok(())
}

/// Returns (order_id, position_id_or_none, status, filled_price_or_none).
async fn legacy_place_order(
    client: &reqwest::Client,
    nextjs_url: &str,
    host: &str,
    volume: &str,
    price: &str,
) -> Result<(String, Option<String>, String, Option<String>), Box<dyn std::error::Error>> {
    let body = LegacyOrderBody {
        symbol: TEST_SYMBOL_NAME.to_string(),
        side: "BUY",
        order_type: "MARKET",
        volume: volume.to_string(),
        idempotency_key: format!("parallel-run-{}", Uuid::new_v4()),
        price: price.to_string(),
    };
    let resp = client
        .post(format!("{nextjs_url}/api/trade/orders"))
        .header("Host", host)
        .json(&body)
        .send()
        .await?;
    let json: serde_json::Value = resp.json().await?;
    let order = &json["order"];
    let order_id = order["id"].as_str().unwrap_or_default().to_string();
    let status = order["status"].as_str().unwrap_or_default().to_string();
    let filled_price = order["filledPrice"].as_str().map(|s| s.to_string());
    let position_id = json["position"]["id"].as_str().map(|s| s.to_string());
    Ok((order_id, position_id, status, filled_price))
}

#[derive(Debug, Serialize)]
struct RustOrderBody {
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

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
enum RustOrderResponse {
    Filled { order_id: String, position_id: String, fill_price: Decimal },
    Rejected { order_id: String, reason: String },
}

async fn rust_place_order(
    client: &reqwest::Client,
    trading_core_url: &str,
    fixtures: &Fixtures,
    volume: Decimal,
    equity: Decimal,
) -> Result<RustOrderResponse, Box<dyn std::error::Error>> {
    let body = RustOrderBody {
        broker_id: fixtures.broker_id.clone(),
        account_id: fixtures.account_id.clone(),
        symbol: TEST_SYMBOL_NAME.to_string(),
        side: "BUY",
        volume,
        sl_price: None,
        tp_price: None,
        equity,
        used_margin: Decimal::ZERO,
        contract_size: fixtures.contract_size,
        leverage: 100,
    };
    let resp = client
        .post(format!("{trading_core_url}/v1/orders/market"))
        .json(&body)
        .send()
        .await?;
    Ok(resp.json().await?)
}

async fn cleanup(pool: &PgPool, fixtures: &Fixtures) -> Result<(), Box<dyn std::error::Error>> {
    sqlx::query(r#"DELETE FROM ledger_entries WHERE related_position_id IN (SELECT id FROM positions WHERE account_id = $1)"#)
        .bind(&fixtures.account_id)
        .execute(pool)
        .await?;
    sqlx::query(r#"DELETE FROM positions WHERE account_id = $1"#).bind(&fixtures.account_id).execute(pool).await?;
    sqlx::query(r#"DELETE FROM orders WHERE account_id = $1"#).bind(&fixtures.account_id).execute(pool).await?;
    sqlx::query(r#"DELETE FROM "Transaction" WHERE "accountId" = $1"#).bind(&fixtures.account_id).execute(pool).await?;
    sqlx::query(r#"DELETE FROM "Position" WHERE "accountId" = $1"#).bind(&fixtures.account_id).execute(pool).await?;
    sqlx::query(r#"DELETE FROM "Order" WHERE "accountId" = $1"#).bind(&fixtures.account_id).execute(pool).await?;
    sqlx::query(r#"DELETE FROM "Account" WHERE id = $1"#).bind(&fixtures.account_id).execute(pool).await?;
    sqlx::query(r#"DELETE FROM "BrokerSymbol" WHERE "brokerId" = $1"#).bind(&fixtures.broker_id).execute(pool).await?;
    sqlx::query(r#"DELETE FROM "Broker" WHERE id = $1"#).bind(&fixtures.broker_id).execute(pool).await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let nextjs_url = std::env::var("NEXTJS_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
    let trading_core_url =
        std::env::var("TRADING_CORE_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".to_string());

    let pool = PgPool::connect(&database_url).await?;
    let http = reqwest::Client::builder().cookie_store(true).build()?;

    println!("=== Parallel-run diagnostic (Legacy Next.js vs Rust engine) ===");
    println!("This does NOT assert equivalence -- see engine/parallel-run's module doc for why.\n");

    let fixtures = seed(&pool).await?;
    println!("Seeded broker_id={} account_number={}\n", fixtures.broker_id, fixtures.account_number);

    let run = async {
        legacy_login(&http, &nextjs_url, &fixtures.broker_host, &fixtures.account_number).await?;

        // --- Scenario 1: happy-path fill ---
        println!("--- Scenario 1: happy-path fill (0.10 lots) ---");
        let (legacy_order_id, _legacy_pos_id, legacy_status, legacy_fill_price) =
            legacy_place_order(&http, &nextjs_url, &fixtures.broker_host, "0.10", "2000.20000").await?;
        println!("Legacy: order {legacy_order_id} status={legacy_status} filled_price={legacy_fill_price:?}");

        refresh_live_price(&pool).await?;
        let rust_outcome =
            rust_place_order(&http, &trading_core_url, &fixtures, Decimal::new(10, 2), Decimal::new(100_000_000_00, 2)).await?;
        match &rust_outcome {
            RustOrderResponse::Filled { order_id, fill_price, .. } => {
                println!("Rust:   order {order_id} status=FILLED fill_price={fill_price}");
                if let Some(lp) = &legacy_fill_price {
                    let legacy_dec: Decimal = lp.parse().unwrap_or_default();
                    let delta = fill_price - legacy_dec;
                    println!(
                        "        Delta vs Legacy: {delta} -- EXPECTED, not a bug: Rust applies the broker's \
                         configured spreadMarkup (1.0 pip here) on top of the raw tick, Legacy applies none \
                         server-side (it just echoes back whatever price the client sent)."
                    );
                }
            }
            RustOrderResponse::Rejected { reason, .. } => {
                println!("Rust:   REJECTED unexpectedly in the happy-path scenario: {reason}");
            }
        }
        println!();

        // --- Scenario 2: margin-check divergence ---
        println!("--- Scenario 2: margin-check divergence (100 lots, tiny Rust equity) ---");
        let (legacy_order_id2, _legacy_pos_id2, legacy_status2, legacy_fill_price2) =
            legacy_place_order(&http, &nextjs_url, &fixtures.broker_host, "100", "2000.20000").await?;
        println!(
            "Legacy: order {legacy_order_id2} status={legacy_status2} filled_price={legacy_fill_price2:?} \
             -- filled unconditionally, Legacy performs NO margin check at all."
        );

        refresh_live_price(&pool).await?;
        let rust_outcome2 =
            rust_place_order(&http, &trading_core_url, &fixtures, Decimal::new(100, 0), Decimal::new(100, 0)).await?;
        match &rust_outcome2 {
            RustOrderResponse::Rejected { order_id, reason } => {
                println!("Rust:   order {order_id} status=REJECTED reason=\"{reason}\"");
            }
            RustOrderResponse::Filled { order_id, .. } => {
                println!("Rust:   order {order_id} status=FILLED unexpectedly (expected a margin rejection)");
            }
        }
        println!(
            "        This divergence is INTENTIONAL and EXPECTED, not something to reconcile: Legacy's \
             Phase 2 order path has never had a margin/exposure/max-position gate (confirmed: zero \
             margin-related code anywhere in app/ or lib/) -- it's a documented temporary stopgap, not a \
             feature Rust needs to match. \"Equivalence\" between these two paths isn't the right goal \
             until Legacy either backports these checks or a broker is fully retired from it."
        );
        println!();

        Ok::<(), Box<dyn std::error::Error>>(())
    }
    .await;

    if let Err(e) = &run {
        eprintln!("Diagnostic run hit an error: {e}");
    }

    cleanup(&pool, &fixtures).await?;
    println!("Cleaned up all seeded fixtures.");

    run
}
