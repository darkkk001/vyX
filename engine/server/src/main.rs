//! Trading Core HTTP server — the internal-facing service the TypeScript
//! API Gateway calls (see ../../docs/api.md §2.1, ../../docs/deployment.md
//! §2's "long-running process" row). Not internet-reachable in the target
//! deployment; only the Gateway talks to it (../../docs/security.md §2's
//! second trust boundary).
//!
//! MARKET and LIMIT/STOP order placement, order cancel, and position
//! SL/TP modify are exposed; account/position query routes aren't yet —
//! see ../../docs/trading-engine.md's implementation-status note.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use market_data::cache::TickCache;
use order_management::{
    db, events, CancelOrderOutcome, ModifyPositionOutcome, PlaceMarketOrderOutcome,
    PlaceMarketOrderRequest, PlacePendingOrderOutcome, PlacePendingOrderRequest,
};
use protocol::{OrderSide, OrderType, Tick};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;

struct AppState {
    pool: PgPool,
    nats: async_nats::Client,
    price_feed_secret: String,
    // The "RUST MEMORY... current prices" layer — see
    // market_data::cache::TickCache's own doc comment for why this
    // exists. Populated by ingest_price_feed, read by
    // place_market_order/place_pending_order.
    tick_cache: Arc<TickCache>,
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
    // ../../docs/trading-engine.md's implementation-status note. The
    // current tick is NOT one of these — OMS fetches that itself from
    // Market Data Core (see PlaceMarketOrderRequest's doc comment in
    // order-management/src/lib.rs), so it isn't part of this body.
    equity: Decimal,
    used_margin: Decimal,
    contract_size: Decimal,
    leverage: u32,
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
    };

    let outcome = order_management::place_market_order(&state.pool, &state.nats, &state.tick_cache, req)
        .await
        .map_err(|err| {
            tracing::error!(?err, "place_market_order failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
        })?;

    Ok(Json(outcome.into()))
}

#[derive(Debug, Deserialize)]
struct PlacePendingOrderBody {
    broker_id: String,
    account_id: String,
    symbol: String,
    side: OrderSide,
    order_type: OrderType,
    volume: Decimal,
    requested_price: Decimal,
    sl_price: Option<Decimal>,
    tp_price: Option<Decimal>,
    // No equity/used_margin/contract_size here, unlike
    // PlaceMarketOrderBody — a pending order doesn't reserve margin while
    // it waits, see PlacePendingOrderRequest's doc comment.
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
enum PlacePendingOrderResponse {
    Accepted { order_id: String },
    Rejected { order_id: String, reason: String },
}

impl From<PlacePendingOrderOutcome> for PlacePendingOrderResponse {
    fn from(outcome: PlacePendingOrderOutcome) -> Self {
        match outcome {
            PlacePendingOrderOutcome::Accepted { order_id } => PlacePendingOrderResponse::Accepted { order_id },
            PlacePendingOrderOutcome::Rejected { order_id, reason } => {
                PlacePendingOrderResponse::Rejected { order_id, reason }
            }
        }
    }
}

async fn place_pending_order(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PlacePendingOrderBody>,
) -> Result<Json<PlacePendingOrderResponse>, (StatusCode, String)> {
    let req = PlacePendingOrderRequest {
        broker_id: body.broker_id,
        account_id: body.account_id,
        symbol: body.symbol,
        side: body.side,
        order_type: body.order_type,
        volume: body.volume,
        requested_price: body.requested_price,
        sl_price: body.sl_price,
        tp_price: body.tp_price,
    };

    let outcome = order_management::place_pending_order(&state.pool, &state.nats, &state.tick_cache, req)
        .await
        .map_err(|err| {
            tracing::error!(?err, "place_pending_order failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
        })?;

    Ok(Json(outcome.into()))
}

#[derive(Debug, Deserialize)]
struct CancelOrderBody {
    account_id: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
enum CancelOrderResponse {
    Cancelled { order_id: String },
}

/// Cancels a resting order — see order_management::cancel_order's doc
/// comment for why only a still-pending LIMIT/STOP can ever legally
/// reach here. `NotFound`/`InvalidStatus` map to HTTP status rather than
/// the tagged-enum body the two placement routes use, since those are
/// the two failure shapes every consumer of this route needs to branch
/// on distinctly (404 vs 409), not just display.
async fn cancel_order(
    State(state): State<Arc<AppState>>,
    Path(order_id): Path<String>,
    Json(body): Json<CancelOrderBody>,
) -> Result<Json<CancelOrderResponse>, (StatusCode, String)> {
    let outcome = order_management::cancel_order(&state.pool, &state.nats, &order_id, &body.account_id)
        .await
        .map_err(|err| {
            tracing::error!(?err, "cancel_order failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
        })?;

    match outcome {
        CancelOrderOutcome::Cancelled { order_id } => Ok(Json(CancelOrderResponse::Cancelled { order_id })),
        CancelOrderOutcome::NotFound => Err((StatusCode::NOT_FOUND, "order not found".to_string())),
        CancelOrderOutcome::InvalidStatus { status } => Err((
            StatusCode::CONFLICT,
            format!("cannot cancel an order in status {status:?}"),
        )),
    }
}

#[derive(Debug, Deserialize)]
struct ModifyPositionBody {
    account_id: String,
    current_price: Decimal,
    sl_price: Option<Decimal>,
    tp_price: Option<Decimal>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
enum ModifyPositionResponse {
    Updated {
        sl_price: Option<Decimal>,
        tp_price: Option<Decimal>,
    },
}

/// Edits an open position's SL/TP — see
/// order_management::modify_position_sl_tp's doc comment for why this
/// targets a position, not the order-level `ModifyOrder` in
/// docs/trading-engine.md's original spec (matches what the legacy
/// Next.js path already does).
async fn modify_position(
    State(state): State<Arc<AppState>>,
    Path(position_id): Path<String>,
    Json(body): Json<ModifyPositionBody>,
) -> Result<Json<ModifyPositionResponse>, (StatusCode, String)> {
    let outcome = order_management::modify_position_sl_tp(
        &state.pool,
        &body.account_id,
        &position_id,
        body.current_price,
        body.sl_price,
        body.tp_price,
    )
    .await
    .map_err(|err| {
        tracing::error!(?err, "modify_position_sl_tp failed");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
    })?;

    match outcome {
        ModifyPositionOutcome::Updated { sl_price, tp_price } => {
            Ok(Json(ModifyPositionResponse::Updated { sl_price, tp_price }))
        }
        ModifyPositionOutcome::NotFound => Err((StatusCode::NOT_FOUND, "position not found".to_string())),
        ModifyPositionOutcome::InvalidStatus { status } => Err((
            StatusCode::CONFLICT,
            format!("position is not open (status: {status:?})"),
        )),
        ModifyPositionOutcome::ValidationFailed { reason } => Err((StatusCode::BAD_REQUEST, reason)),
    }
}

// Accepts a single tick or an array — same flexibility as today's
// Next.js handler (lib/price-feed.ts), which the thin forwarder in
// app/api/internal/price-feed/* preserves on its side of the hop.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TicksBody {
    Single(Tick),
    Many(Vec<Tick>),
}

impl TicksBody {
    fn into_vec(self) -> Vec<Tick> {
        match self {
            TicksBody::Single(t) => vec![t],
            TicksBody::Many(ts) => ts,
        }
    }
}

#[derive(Debug, Serialize)]
struct PriceFeedResponse {
    ok: bool,
    count: usize,
}

/// MT5 EA bridge ingest — see ../../docs/market-data.md §2. Reached only
/// via the Next.js thin forwarder (app/api/internal/price-feed/*), not
/// directly by any MT5 terminal; the base64-path workaround that exists
/// on that Next.js route is for a network intermediary between real MT5
/// terminals and Vercel, irrelevant to this internal hop, so a plain
/// header carries the shared secret here.
async fn ingest_price_feed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<TicksBody>,
) -> Result<Json<PriceFeedResponse>, (StatusCode, String)> {
    let provided = headers
        .get("x-price-feed-secret")
        .and_then(|v| v.to_str().ok());
    if provided != Some(state.price_feed_secret.as_str()) {
        return Err((StatusCode::UNAUTHORIZED, "unauthorized".to_string()));
    }

    let ticks: Vec<Tick> = body
        .into_vec()
        .into_iter()
        .filter(|t| !t.symbol.is_empty())
        .collect();
    if ticks.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "no valid ticks in body".to_string()));
    }

    let count = ticks.len();
    market_data::ingest::ingest_ticks(&state.pool, &state.nats, &state.tick_cache, &ticks)
        .await
        .map_err(|err| {
            tracing::error!(?err, "ingest_ticks failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
        })?;

    Ok(Json(PriceFeedResponse { ok: true, count }))
}

/// Subscribes once to the Market Data Core's tick stream
/// (../../docs/market-data.md §2) and fans each tick out to both
/// tick-driven consumers this binary runs, so the payload is only
/// deserialized once per message:
/// - the margin monitor (`order_management::monitor`) — any tick is a
///   valid trigger to re-check every account with an open position (it
///   doesn't narrow by symbol, since floating P&L across *any* symbol an
///   account holds affects its equity). `run_once_guarded` makes a burst
///   of ticks collapse into one pass rather than piling up concurrent
///   scans.
/// - the pending-order trigger (`order_management::pending_orders`) —
///   scoped to this tick's own symbol, since a LIMIT/STOP order can only
///   ever trigger off its own symbol's price.
///
/// Run concurrently via `tokio::join!` per tick (both are independent
/// reads/writes against the same pool, safe to overlap) rather than one
/// waiting on the other.
async fn spawn_tick_driven_triggers(
    pool: PgPool,
    nats: async_nats::Client,
    thresholds: margin::MarginThresholds,
    guard: order_management::monitor::RunGuard,
) -> Result<(), async_nats::SubscribeError> {
    let mut sub = nats.subscribe("price.tick.*").await?;
    tracing::info!("tick-driven triggers: subscribed to price.tick.*");
    tokio::spawn(async move {
        while let Some(msg) = sub.next().await {
            let tick: Tick = match serde_json::from_slice(&msg.payload) {
                Ok(t) => t,
                Err(err) => {
                    tracing::warn!(?err, subject = %msg.subject, "tick-driven triggers: failed to deserialize tick payload");
                    continue;
                }
            };
            tracing::debug!(symbol = %tick.symbol, "tick-driven triggers: tick received");
            tokio::join!(
                order_management::monitor::run_once_guarded(&pool, &nats, thresholds, &guard),
                order_management::pending_orders::check_symbol_for_triggers(&pool, &nats, &tick),
            );
        }
        tracing::warn!("tick-driven triggers: price.tick.* subscription ended");
    });
    Ok(())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let nats_url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".to_string());
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8081);
    let price_feed_secret = std::env::var("PRICE_FEED_SECRET").expect("PRICE_FEED_SECRET must be set");
    // sqlx's own default (10) was silently the concurrency ceiling for
    // order placement -- see db::connect_pool's doc comment.
    let db_pool_max_connections: u32 = std::env::var("DATABASE_POOL_MAX_CONNECTIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);

    let pool = db::connect_pool(&database_url, db_pool_max_connections)
        .await
        .expect("failed to connect to Postgres");
    let nats = events::connect(&nats_url).await.expect("failed to connect to NATS");

    // Margin monitor — see order_management::monitor's module doc. Two
    // trigger sources sharing one guard so they never run concurrently:
    // the polling timer below (a safety net for quiet periods) and the
    // NATS tick subscription (spawn_tick_driven_triggers, the primary
    // path — reacts to real price movement instead of waiting for the
    // next poll). That same subscription also drives the pending-order
    // trigger (order_management::pending_orders).
    let monitor_interval_secs: u64 = std::env::var("MARGIN_MONITOR_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);
    let monitor_guard = order_management::monitor::new_run_guard();
    let monitor_thresholds = margin::MarginThresholds::default();
    order_management::monitor::spawn(
        pool.clone(),
        nats.clone(),
        monitor_thresholds,
        std::time::Duration::from_secs(monitor_interval_secs),
        monitor_guard.clone(),
    );
    spawn_tick_driven_triggers(pool.clone(), nats.clone(), monitor_thresholds, monitor_guard)
        .await
        .expect("failed to subscribe tick-driven triggers to price.tick.*");

    // Daily swap rollover — see order_management::swap's module doc. Not
    // tick-driven like the monitor: it only needs to notice a calendar
    // day has turned over, so a short poll interval (default 5 min) just
    // means rollover starts promptly after midnight rather than needing
    // exact-instant scheduling; the claim's date guard makes polling more
    // often than that harmless.
    let swap_poll_interval_secs: u64 = std::env::var("SWAP_ROLLOVER_POLL_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);
    order_management::swap::spawn(pool.clone(), std::time::Duration::from_secs(swap_poll_interval_secs));

    let tick_cache = Arc::new(TickCache::new());
    let state = Arc::new(AppState { pool, nats, price_feed_secret, tick_cache });

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/orders/market", post(place_market_order))
        .route("/v1/orders/pending", post(place_pending_order))
        .route("/v1/orders/{order_id}/cancel", post(cancel_order))
        .route("/v1/positions/{position_id}/modify", post(modify_position))
        .route("/internal/price-feed", post(ingest_price_feed))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind port");
    tracing::info!("trading-core-server listening on :{port}");
    axum::serve(listener, app).await.expect("server error");
}
