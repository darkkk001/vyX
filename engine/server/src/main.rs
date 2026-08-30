//! Trading Core HTTP server — the internal-facing service the TypeScript
//! API Gateway calls (see ../../docs/api.md §2.1, ../../docs/deployment.md
//! §2's "long-running process" row). Not internet-reachable in the target
//! deployment; only the Gateway talks to it (../../docs/security.md §2's
//! second trust boundary).
//!
//! MARKET and LIMIT/STOP order placement, order cancel, and position
//! SL/TP modify/close are exposed; account/position query routes aren't
//! yet — see ../../docs/trading-engine.md's implementation-status note.

use axum::{
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use chrono::{TimeZone, Utc};
use futures_util::StreamExt;
use market_data::cache::TickCache;
use market_data::gap_fill::GapFillTracker;
use market_data::stats::{FeedStats, FeedStatsSnapshot};
use market_data::symbol_activity::SymbolActivity;
use market_data::{timeframe_from_str, CandleUpdate};
use order_management::{
    db, events, CancelOrderOutcome, ClosePositionOutcome, ModifyPositionOutcome,
    PlaceMarketOrderOutcome, PlaceMarketOrderRequest, PlacePendingOrderOutcome,
    PlacePendingOrderRequest,
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
    // Distinct from price_feed_secret -- gates the 4 order routes instead
    // of the MT5 ingest route, checked by require_internal_secret below.
    // Only services/api-gateway should ever hold this value; per this
    // server's own module doc, it's designed to be reachable only from
    // the Gateway, never directly from a browser.
    internal_service_secret: String,
    // The "RUST MEMORY... current prices" layer — see
    // market_data::cache::TickCache's own doc comment for why this
    // exists. Populated by ingest_price_feed, read by
    // place_market_order/place_pending_order.
    tick_cache: Arc<TickCache>,
    // Phase 4 latency/health counters -- see market_data::stats's module
    // doc. Populated by ingest_price_feed, read by the new
    // /internal/feed-stats route.
    feed_stats: Arc<FeedStats>,
    // Per-symbol rolling tick-rate window, feeding /internal/feed-stats's
    // per_symbol[].ticks_60s -- see market_data::symbol_activity's module
    // doc for why this is separate from both tick_cache (latest tick
    // only) and feed_stats (aggregate, not per-symbol).
    symbol_activity: Arc<SymbolActivity>,
    // fix/realtime-sync §4 -- last-known-bucket tracker shared between the
    // live tick path's own gap-filling (market_data::ingest::flush_candles)
    // and the new /internal/history backfill route below, so a backfilled
    // historical bar also updates what the live path considers "the last
    // real bucket" for that symbol+timeframe -- otherwise a fresh EA
    // backfill landing right before the engine's next live tick could
    // still see a false gap relative to bars the live path never wrote
    // itself.
    gap_fill: Arc<GapFillTracker>,
}

// Applied via .layer() to every order/position route (main() below) --
// centralized in one place rather than a per-handler header check (like
// ingest_price_feed's inline check) specifically so a future new route
// added to that same sub-router can't forget it. Defense-in-depth, not
// the primary authorization layer: services/api-gateway is what actually
// verifies the calling trader's identity and broker ownership before it
// ever reaches this server (src/auth.ts's requireTraderSession).
async fn require_internal_secret(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, (StatusCode, String)> {
    let provided = req
        .headers()
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok());
    if provided != Some(state.internal_service_secret.as_str()) {
        return Err((StatusCode::UNAUTHORIZED, "unauthorized".to_string()));
    }
    Ok(next.run(req).await)
}

// Defense-in-depth for place_market_order/place_pending_order: the
// Gateway already verifies account_id belongs to the calling broker
// before forwarding (services/api-gateway/src/db.ts's getAccount), but
// this server shouldn't blindly trust a broker_id/account_id pair it
// receives -- cancel_order/modify_position_sl_tp already check this
// themselves (order_management::lib.rs, "order.account_id != account_id"
// / "position.account_id != account_id"), this closes the same gap for
// the two routes that don't go through those functions' own ownership
// check.
async fn verify_account_belongs_to_broker(
    pool: &PgPool,
    account_id: &str,
    broker_id: &str,
) -> Result<bool, sqlx::Error> {
    let row: Option<(String,)> =
        sqlx::query_as(r#"SELECT "brokerId" FROM "Account" WHERE id = $1"#)
            .bind(account_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(broker,)| broker == broker_id).unwrap_or(false))
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

// EA clock-sync handshake target (2nd Contabo-audit follow-up on the tick
// pipeline) -- unauthenticated, same as /health, since it exposes nothing
// but the current time and needs to be cheap to call every 60s. The EA
// brackets this call with its own monotonic clock (before/after) to
// derive round-trip time and this engine's UTC offset from its own local
// clock; see mt5-ea/VyXTraderPriceFeed.mq5's SyncClockOffset.
#[derive(Serialize)]
struct ServerTimeResponse {
    server_utc_ms: i64,
}

async fn server_time() -> Json<ServerTimeResponse> {
    Json(ServerTimeResponse { server_utc_ms: Utc::now().timestamp_millis() })
}

async fn place_market_order(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PlaceMarketOrderBody>,
) -> Result<Json<PlaceMarketOrderResponse>, (StatusCode, String)> {
    if !verify_account_belongs_to_broker(&state.pool, &body.account_id, &body.broker_id)
        .await
        .map_err(|err| {
            tracing::error!(?err, "verify_account_belongs_to_broker failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
        })?
    {
        return Err((StatusCode::FORBIDDEN, "account does not belong to broker".to_string()));
    }

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
    if !verify_account_belongs_to_broker(&state.pool, &body.account_id, &body.broker_id)
        .await
        .map_err(|err| {
            tracing::error!(?err, "verify_account_belongs_to_broker failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
        })?
    {
        return Err((StatusCode::FORBIDDEN, "account does not belong to broker".to_string()));
    }

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
        &state.nats,
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

#[derive(Debug, Deserialize)]
struct ClosePositionBody {
    account_id: String,
    bid: Decimal,
    ask: Decimal,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
enum ClosePositionResponse {
    Closed { close_price: Decimal, realized_pnl: Decimal },
}

/// Manually closes an open position — the trader-initiated counterpart to
/// the margin monitor's automatic force-closes, see
/// order_management::close_position's doc comment. `bid`/`ask` are the
/// caller's own current-price read (same convention as `modify_position`'s
/// `current_price`), since this route doesn't have its own Market Data
/// Core dependency.
async fn close_position(
    State(state): State<Arc<AppState>>,
    Path(position_id): Path<String>,
    Json(body): Json<ClosePositionBody>,
) -> Result<Json<ClosePositionResponse>, (StatusCode, String)> {
    let outcome = order_management::close_position(
        &state.pool,
        &state.nats,
        &body.account_id,
        &position_id,
        body.bid,
        body.ask,
    )
    .await
    .map_err(|err| {
        tracing::error!(?err, "close_position failed");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
    })?;

    match outcome {
        ClosePositionOutcome::Closed { close_price, realized_pnl } => {
            Ok(Json(ClosePositionResponse::Closed { close_price, realized_pnl }))
        }
        ClosePositionOutcome::NotFound => Err((StatusCode::NOT_FOUND, "position not found".to_string())),
        ClosePositionOutcome::InvalidStatus { status } => Err((
            StatusCode::CONFLICT,
            format!("position is not open (status: {status:?})"),
        )),
        ClosePositionOutcome::AlreadyClosed => Err((
            StatusCode::CONFLICT,
            "position was already closed".to_string(),
        )),
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

    let all = body.into_vec();
    let total = all.len();
    let ticks: Vec<Tick> = all.into_iter().filter(|t| !t.symbol.is_empty()).collect();
    let dropped = total - ticks.len();
    if dropped > 0 {
        state.feed_stats.record_dropped_invalid(dropped as u64);
    }
    if ticks.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "no valid ticks in body".to_string()));
    }

    let count = ticks.len();
    market_data::ingest::ingest_ticks(
        &state.nats,
        &state.tick_cache,
        &state.feed_stats,
        &state.symbol_activity,
        &ticks,
    )
    .await
    .map_err(|err| {
        tracing::error!(?err, "ingest_ticks failed");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
    })?;

    Ok(Json(PriceFeedResponse { ok: true, count }))
}

#[derive(Debug, Deserialize)]
struct HistoryBar {
    bucket_start_ms: i64,
    open: Decimal,
    high: Decimal,
    low: Decimal,
    close: Decimal,
}

#[derive(Debug, Deserialize)]
struct HistoryBody {
    symbol: String,
    timeframe: String,
    bars: Vec<HistoryBar>,
}

#[derive(Debug, Serialize)]
struct HistoryResponse {
    ok: bool,
    upserted: usize,
    skipped_unrecognized_timeframe: bool,
}

/// fix/realtime-sync §4 -- the EA's periodic CopyRates backfill
/// (mt5-ea/VyXTraderPriceFeed.mq5, on init and every 15 minutes) posts
/// its last ~500 real bars per symbol+timeframe here. Same auth as
/// ingest_price_feed (this is the same MT5-EA-to-engine trust boundary,
/// just a second endpoint on it, not a new one).
///
/// Bars are sorted oldest-first before writing regardless of the order
/// they arrived in -- gap_fill::GapFillTracker's "last known bucket"
/// bookkeeping only makes sense walked forward in time; an EA that
/// happened to send CopyRates' natural newest-first order would
/// otherwise make every real historical bar look like a "gap" relative
/// to the one already recorded ahead of it.
async fn ingest_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<HistoryBody>,
) -> Result<Json<HistoryResponse>, (StatusCode, String)> {
    let provided = headers.get("x-price-feed-secret").and_then(|v| v.to_str().ok());
    if provided != Some(state.price_feed_secret.as_str()) {
        return Err((StatusCode::UNAUTHORIZED, "unauthorized".to_string()));
    }

    let Some(timeframe) = timeframe_from_str(&body.timeframe) else {
        // Not an error -- see timeframe_from_str's own doc comment on
        // "M15" specifically. The EA should stop asking for a timeframe
        // this engine never acknowledges, but one unrecognized value in
        // a broker's symbol list shouldn't fail every other bar in the
        // same request.
        return Ok(Json(HistoryResponse { ok: true, upserted: 0, skipped_unrecognized_timeframe: true }));
    };

    let mut bars = body.bars;
    bars.sort_by_key(|b| b.bucket_start_ms);

    let mut upserted = 0usize;
    let mut tx = state.pool.begin().await.map_err(|err| {
        tracing::error!(?err, "ingest_history: failed to open transaction");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
    })?;

    for bar in &bars {
        let Some(bucket_start) = Utc.timestamp_millis_opt(bar.bucket_start_ms).single() else {
            continue; // malformed timestamp -- skip just this bar
        };
        let update = CandleUpdate {
            symbol: body.symbol.clone(),
            timeframe,
            bucket_start,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
        };
        for fill in state.gap_fill.fill_gaps_and_record(&update) {
            market_data::db::upsert_candle(&mut tx, &fill).await.map_err(|err| {
                tracing::error!(?err, "ingest_history: gap-fill upsert failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            })?;
        }
        market_data::db::upsert_candle_authoritative(&mut tx, &update).await.map_err(|err| {
            tracing::error!(?err, symbol = %body.symbol, "ingest_history: authoritative upsert failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
        })?;
        upserted += 1;
    }

    tx.commit().await.map_err(|err| {
        tracing::error!(?err, "ingest_history: commit failed");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
    })?;

    Ok(Json(HistoryResponse { ok: true, upserted, skipped_unrecognized_timeframe: false }))
}

/// Latency/health snapshot for the tick pipeline — Phase 4 of the audit.
/// Same x-internal-secret guard as the order routes (this server's
/// AppState only has one such guard today; a dedicated read-only stats
/// credential would be a reasonable future split if this ever needs to
/// be exposed more broadly than "whoever can already place orders").
// FeedStatsSnapshot plus queue_len -- there's no literal bounded channel
// in this design (see market_data::ingest's own module doc: the
// TickCache's per-symbol coalescing already gives last-write-wins
// batching without one), so the honest equivalent of "how much work is
// backed up" is how many distinct symbols the cache currently holds --
// exposed here rather than baked into FeedStats itself, since it needs
// the tick_cache handle FeedStats doesn't carry.
#[derive(Serialize)]
struct FeedStatsResponse {
    #[serde(flatten)]
    stats: FeedStatsSnapshot,
    queue_len: usize,
    per_symbol: Vec<PerSymbolStat>,
}

// Second follow-up on the Contabo audit: per-symbol freshness (was
// previously not obtainable from this endpoint at all -- there was no
// way to confirm e.g. BTCUSD/ETHUSD specifically were live). Built from
// tick_cache (latest bid/ask + age) and symbol_activity (60s tick rate)
// together, since neither alone has both pieces.
#[derive(Serialize)]
struct PerSymbolStat {
    symbol: String,
    ticks_60s: u64,
    last_tick_age_ms: i64,
    bid: Decimal,
    ask: Decimal,
}

async fn feed_stats(State(state): State<Arc<AppState>>) -> Json<FeedStatsResponse> {
    let now = Utc::now();
    let now_ms = now.timestamp_millis();
    let per_symbol = state
        .tick_cache
        .snapshot_with_age(now)
        .into_iter()
        .map(|(tick, age_ms)| PerSymbolStat {
            ticks_60s: state.symbol_activity.count_last_60s(&tick.symbol, now_ms),
            symbol: tick.symbol,
            last_tick_age_ms: age_ms,
            bid: tick.bid,
            ask: tick.ask,
        })
        .collect();

    Json(FeedStatsResponse {
        stats: state.feed_stats.snapshot(),
        queue_len: state.tick_cache.snapshot().len(),
        per_symbol,
    })
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
    let internal_service_secret =
        std::env::var("INTERNAL_SERVICE_SECRET").expect("INTERNAL_SERVICE_SECRET must be set");
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
    let feed_stats_registry = Arc::new(FeedStats::new());
    let symbol_activity_registry = Arc::new(SymbolActivity::new());

    // Periodic Postgres flush of the in-memory tick cache -- see
    // market_data::ingest::spawn_periodic_flush's doc comment for why
    // this replaced a per-tick write. Defaults tightened per the Contabo
    // audit (2026-08-29): 250ms for LivePrice, 1s for Candle -- both now
    // millisecond-based env vars (renamed from *_SECS, a breaking rename;
    // Contabo wasn't overriding either, so this is safe to deploy as-is).
    // Each flush now has its own 2s DB timeout regardless of this
    // interval (see ingest.rs's DB_FLUSH_TIMEOUT) -- a slow Postgres can
    // no longer pile up overlapping attempts even at this tighter cadence.
    let live_price_flush_interval_ms: u64 = std::env::var("LIVE_PRICE_FLUSH_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(250);
    let candle_flush_interval_ms: u64 = std::env::var("CANDLE_FLUSH_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1_000);
    let gap_fill_tracker = Arc::new(GapFillTracker::new());
    market_data::ingest::spawn_periodic_flush(
        pool.clone(),
        tick_cache.clone(),
        std::time::Duration::from_millis(live_price_flush_interval_ms),
        std::time::Duration::from_millis(candle_flush_interval_ms),
        feed_stats_registry.clone(),
        gap_fill_tracker.clone(),
    );

    let state = Arc::new(AppState {
        pool,
        nats,
        price_feed_secret,
        internal_service_secret,
        tick_cache,
        feed_stats: feed_stats_registry,
        symbol_activity: symbol_activity_registry,
        gap_fill: gap_fill_tracker,
    });

    // Order/position/stats routes require x-internal-secret
    // (require_internal_secret above) -- only services/api-gateway should
    // ever call these. Kept as its own sub-router + .layer() (applies to
    // every route already added to it) rather than a per-handler check,
    // so a future route added here can't forget the guard.
    let order_routes = Router::new()
        .route("/v1/orders/market", post(place_market_order))
        .route("/v1/orders/pending", post(place_pending_order))
        .route("/v1/orders/{order_id}/cancel", post(cancel_order))
        .route("/v1/positions/{position_id}/modify", post(modify_position))
        .route("/v1/positions/{position_id}/close", post(close_position))
        .route("/internal/feed-stats", get(feed_stats))
        .layer(middleware::from_fn_with_state(state.clone(), require_internal_secret));

    let app = Router::new()
        .route("/health", get(health))
        .route("/internal/time", get(server_time))
        .route("/internal/price-feed", post(ingest_price_feed))
        .route("/internal/history", post(ingest_history))
        .merge(order_routes)
        .with_state(state);

    // Defaults to loopback-only now -- this server was only ever meant to
    // be reached via the Gateway (this file's own module doc) or, on
    // Contabo, a local Caddy reverse proxy; 0.0.0.0 exposed it directly
    // to the internet on whatever host it ran on. Still overridable
    // (BIND_ADDR=0.0.0.0) for a deployment shape that genuinely needs it.
    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1".to_string());
    let listener = tokio::net::TcpListener::bind((bind_addr.as_str(), port))
        .await
        .expect("failed to bind port");
    tracing::info!("trading-core-server listening on {bind_addr}:{port}");
    axum::serve(listener, app).await.expect("server error");
}
