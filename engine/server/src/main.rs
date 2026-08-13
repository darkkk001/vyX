//! Trading Core HTTP server — the internal-facing service the TypeScript
//! API Gateway calls (see ../../docs/api.md §2.1, ../../docs/deployment.md
//! §2's "long-running process" row). Not internet-reachable in the target
//! deployment; only the Gateway talks to it (../../docs/security.md §2's
//! second trust boundary).
//!
//! This is the first concrete slice: MARKET order placement only. LIMIT/
//! STOP, cancel/modify, and account/position queries aren't exposed yet —
//! see ../../docs/trading-engine.md's implementation-status note.

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use order_management::{db, events, PlaceMarketOrderOutcome, PlaceMarketOrderRequest};
use protocol::{OrderSide, Tick};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;

struct AppState {
    pool: PgPool,
    nats: async_nats::Client,
}

#[derive(Debug, Deserialize)]
struct PlaceMarketOrderBody {
    broker_id: String,
    account_id: String,
    symbol: String,
    side: OrderSide,
    volume: Decimal,
    sl_price: Option<Decimal>,
    tp_price: Option<Decimal>,
    // Risk-check inputs the Gateway must supply today — OMS doesn't fetch
    // account/symbol data itself (Prisma-owned, ADR-002). See
    // ../../docs/trading-engine.md's implementation-status note.
    equity: Decimal,
    used_margin: Decimal,
    contract_size: Decimal,
    leverage: u32,
    current_tick: Tick,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
enum PlaceMarketOrderResponse {
    Filled {
        order_id: String,
        position_id: String,
        fill_price: Decimal,
    },
    Rejected {
        order_id: String,
        reason: String,
    },
}

impl From<PlaceMarketOrderOutcome> for PlaceMarketOrderResponse {
    fn from(outcome: PlaceMarketOrderOutcome) -> Self {
        match outcome {
            PlaceMarketOrderOutcome::Filled { order_id, position_id, fill_price } => {
                PlaceMarketOrderResponse::Filled { order_id, position_id, fill_price }
            }
            PlaceMarketOrderOutcome::Rejected { order_id, reason } => {
                PlaceMarketOrderResponse::Rejected { order_id, reason }
            }
        }
    }
}

async fn health() -> &'static str {
    "ok"
}

async fn place_market_order(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PlaceMarketOrderBody>,
) -> Result<Json<PlaceMarketOrderResponse>, (StatusCode, String)> {
    let req = PlaceMarketOrderRequest {
        broker_id: body.broker_id,
        account_id: body.account_id,
        symbol: body.symbol,
        side: body.side,
        volume: body.volume,
        sl_price: body.sl_price,
        tp_price: body.tp_price,
        equity: body.equity,
        used_margin: body.used_margin,
        contract_size: body.contract_size,
        leverage: body.leverage,
        current_tick: body.current_tick,
    };

    let outcome = order_management::place_market_order(&state.pool, &state.nats, req)
        .await
        .map_err(|err| {
            tracing::error!(?err, "place_market_order failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
        })?;

    Ok(Json(outcome.into()))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let nats_url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".to_string());
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8081);

    let pool = db::connect_pool(&database_url)
        .await
        .expect("failed to connect to Postgres");
    let nats = events::connect(&nats_url).await.expect("failed to connect to NATS");

    let state = Arc::new(AppState { pool, nats });

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/orders/market", post(place_market_order))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind port");
    tracing::info!("trading-core-server listening on :{port}");
    axum::serve(listener, app).await.expect("server error");
}
