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
    // Phase 1 trust pack §3 -- see market_data::alerts's own module doc.
    // Populated at boot (load_active_price_alerts) and kept current by a
    // NATS subscription to cfg.alerts.* (spawned in main(), not read from
    // this struct -- it only needs the cache handle, not the rest of
    // AppState). Checked in-memory on every tick by ingest_price_feed.
    alert_cache: Arc<market_data::alerts::AlertCache>,
    // Cumulative alert-pipeline counters -- see AlertMetrics's own doc
    // comment. Separate from alert_cache since it's pure bookkeeping, not
    // part of the actual in-memory alert book.
    alert_metrics: Arc<market_data::alerts::AlertMetrics>,
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
    let triggered = market_data::ingest::ingest_ticks(
        &state.nats,
        &state.tick_cache,
        &state.feed_stats,
        &state.symbol_activity,
        &state.alert_cache,
        &ticks,
    )
    .await
    .map_err(|err| {
        tracing::error!(?err, "ingest_ticks failed");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
    })?;

    // Phase 1 trust pack §3 -- rare by nature (only fires when a tick
    // actually crosses someone's threshold), so a synchronous DB write +
    // NATS publish per trigger here doesn't reintroduce the per-tick
    // Postgres cost the Contabo audit removed from this same handler's
    // hot path (see ingest_ticks's own doc comment) -- this only runs at
    // all for the exceptional tick, never the common one.
    for fired in triggered {
        let result: Result<(), sqlx::Error> = async {
            let mut tx = state.pool.begin().await?;
            market_data::db::mark_price_alert_triggered(&mut tx, &fired.alert, fired.triggered_price).await?;
            tx.commit().await
        }
        .await;

        if let Err(err) = result {
            tracing::warn!(?err, alert_id = %fired.alert.id, "failed to persist triggered price alert");
            state.alert_metrics.record_persist_failure();
            continue; // don't publish a trigger that failed to persist
        }
        state.alert_metrics.record_triggered();

        let payload = serde_json::json!({
            "type": "AlertTriggered",
            "alert_id": fired.alert.id,
            "account_id": fired.alert.account_id,
            "broker_id": fired.alert.broker_id,
            "symbol": fired.alert.symbol,
            "condition": market_data::alerts::condition_to_str(fired.alert.condition),
            "price": fired.alert.price.to_string(),
            "triggered_price": fired.triggered_price.to_string(),
        });
        if let Ok(bytes) = serde_json::to_vec(&payload) {
            if let Err(err) = state.nats.publish("alert.triggered", bytes.into()).await {
                tracing::warn!(?err, alert_id = %fired.alert.id, "failed to publish alert.triggered");
            }
        }
    }

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
    // The broker-server-to-UTC offset the EA used when converting
    // MqlRates.time (hotfix/history-broker-time). Optional so an older EA
    // build still parses instead of 400-ing -- but its absence is itself
    // the signal that the sender predates the conversion, which
    // assert_bars_look_like_utc reports.
    #[serde(default)]
    server_offset_sec: Option<i64>,
    bars: Vec<HistoryBar>,
}

/// Bars are supposed to arrive as UTC epoch ms. An EA that hasn't been
/// updated sends the trade server's local time instead, which on
/// Pepperstone (UTC+3) put 3,915 rows into the future on Contabo and
/// froze the chart's last candle -- the live tick path buckets in real
/// UTC, so klinecharts' updateData saw a timestamp hours behind the last
/// history bar and discarded it.
///
/// Checked here rather than trusted because the EA is deployed by hand on
/// a terminal nobody watches: the failure is silent, self-consistent, and
/// only visible three hours later on a chart. A bar meaningfully in the
/// future is the one unambiguous tell.
fn assert_bars_look_like_utc(symbol: &str, timeframe: &str, offset_sec: Option<i64>, bars: &[HistoryBar]) {
    const FUTURE_TOLERANCE_MS: i64 = 60 * 60 * 1000;

    let Some(newest) = bars.iter().map(|b| b.bucket_start_ms).max() else {
        return;
    };
    let ahead_ms = newest - Utc::now().timestamp_millis();
    if ahead_ms > FUTURE_TOLERANCE_MS {
        tracing::warn!(
            symbol,
            timeframe,
            hours_ahead = ahead_ms as f64 / 3_600_000.0,
            server_offset_sec = offset_sec.unwrap_or(0),
            sender_sent_offset = offset_sec.is_some(),
            "history bars are in the future -- the sender is almost certainly still writing broker-server time, not UTC. Stored as-is; fix the EA (>= v1.36) and re-run scripts/fix-broker-time-candles.ts"
        );
    }
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
    assert_bars_look_like_utc(&body.symbol, &body.timeframe, body.server_offset_sec, &bars);

    // One DB transaction for the whole batch (opened once here, committed
    // once below), AND (as of this fix) two round trips inside it -- one
    // batched multi-row upsert for every gap-fill this request produces,
    // one for every real bar -- not one round trip per bar. The 500-bar
    // (later 200, see mt5-ea/VyXTraderPriceFeed.mq5's
    // HISTORY_BACKFILL_BAR_COUNT history) request that used to take 3-6s
    // was this exact per-row round-trip cost; Contabo re-measured it at
    // 17-25s for 1500 sequential rows under real market-open load once the
    // EA's deep-pass counts went up (v1.34), which is what actually
    // motivated doing this instead of just tuning bar counts/timeouts
    // again. Every failure path below is still `?`-propagated, so at most
    // one warn! fires per request (the handler returns on the first
    // failure) -- unchanged from before this fix.
    //
    // No de-duplication of (symbol, timeframe, bucketStart) keys before
    // the batched upserts below, unlike a generic bulk-upsert helper might
    // need: Postgres errors if one INSERT ... ON CONFLICT statement would
    // affect the same conflict target twice, but that can't happen here.
    // `bars` is sorted oldest-first and CopyRates (the EA's own source)
    // never returns two bars for the same bucket, so every authoritative
    // bar's key is already unique; gap_fill::GapFillTracker only ever
    // fills buckets strictly between the previous real bar and the
    // current one, so no fill can collide with another fill or a real bar
    // either.
    let mut gap_fills: Vec<CandleUpdate> = Vec::new();
    let mut authoritative: Vec<CandleUpdate> = Vec::with_capacity(bars.len());

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
        gap_fills.extend(state.gap_fill.fill_gaps_and_record(&update));
        authoritative.push(update);
    }
    let upserted = authoritative.len();

    let mut tx = state.pool.begin().await.map_err(|err| {
        tracing::warn!(?err, "ingest_history: failed to open transaction");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
    })?;
    market_data::db::upsert_candles_batch(&mut tx, &gap_fills).await.map_err(|err| {
        tracing::warn!(?err, symbol = %body.symbol, "ingest_history: gap-fill batch upsert failed");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
    })?;
    market_data::db::upsert_candles_authoritative_batch(&mut tx, &authoritative).await.map_err(|err| {
        tracing::warn!(?err, symbol = %body.symbol, "ingest_history: authoritative batch upsert failed");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
    })?;

    tx.commit().await.map_err(|err| {
        tracing::warn!(?err, "ingest_history: commit failed");
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

/// Alert-pipeline health snapshot -- same shared-secret guard and
/// "in-memory atomics, no Prometheus" convention as feed_stats above. See
/// market_data::alerts::AlertMetrics's own doc comment for what each
/// field means and why active_alerts_total comes from AlertCache
/// directly rather than a counter of its own.
async fn alert_stats(State(state): State<Arc<AppState>>) -> Json<market_data::alerts::AlertMetricsSnapshot> {
    Json(state.alert_metrics.snapshot(state.alert_cache.count_total()))
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
///
/// hotfix/terminal-live-bugs round 3 -- both consumers used to be
/// `.await`ed inline (via `tokio::join!`) before this loop pulled the next
/// message off `sub`, which meant the NATS subscription's own receive
/// buffer only drained as fast as a full margin-monitor pass + pending-
/// order DB round trip could complete. Production logged 213,482 "slow
/// consumers for subscription 1" events on the previous build (a burst of
/// ticks at 50/s outrunning that combined processing time) -- and per
/// async-nats' own delivery loop, a slow consumer doesn't queue past its
/// buffer, it silently *drops* the tick (see `record_nats_slow_consumer`'s
/// doc comment). `tokio::spawn`ing each consumer per tick instead lets
/// this loop keep calling `sub.next()` at the rate ticks actually arrive,
/// decoupled from how long either consumer takes -- both are already
/// documented as safe under overlapping/concurrent execution
/// (`run_once_guarded`'s try_lock coalescing, `check_symbol_for_triggers`'s
/// atomic per-order claim), so spawning them is not a new correctness
/// risk, only a throughput one this already tolerated by design.
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

            let (pool1, nats1, guard1) = (pool.clone(), nats.clone(), guard.clone());
            tokio::spawn(async move {
                order_management::monitor::run_once_guarded(&pool1, &nats1, thresholds, &guard1).await;
            });
            let (pool2, nats2) = (pool.clone(), nats.clone());
            tokio::spawn(async move {
                order_management::pending_orders::check_symbol_for_triggers(&pool2, &nats2, &tick).await;
            });
        }
        tracing::warn!("tick-driven triggers: price.tick.* subscription ended");
    });
    Ok(())
}

/// Phase 1 trust pack §3 -- keeps AlertCache current between boot-time
/// loads: app/api/trade/alerts publishes here on every create/cancel so a
/// new alert is checked against the very next tick, not just after a
/// restart. Wildcard subject (every broker) -- the cache itself isn't
/// partitioned by broker (see AppState's own comment), so there's nothing
/// to gain from one subscription per broker. Malformed/unrecognized
/// fields are logged and skipped, never fatal to the subscription itself
/// -- one bad message must not silently stop every future alert from
/// hot-reloading.
async fn spawn_alert_hot_reload(
    alert_cache: Arc<market_data::alerts::AlertCache>,
    alert_metrics: Arc<market_data::alerts::AlertMetrics>,
    nats: async_nats::Client,
) -> Result<(), async_nats::SubscribeError> {
    let mut sub = nats.subscribe("cfg.alerts.*").await?;
    tracing::info!("alert hot-reload: subscribed to cfg.alerts.*");
    tokio::spawn(async move {
        while let Some(msg) = sub.next().await {
            let payload: serde_json::Value = match serde_json::from_slice(&msg.payload) {
                Ok(v) => v,
                Err(err) => {
                    tracing::warn!(?err, subject = %msg.subject, "alert hot-reload: malformed payload");
                    alert_metrics.record_hot_reload_malformed();
                    continue;
                }
            };
            match payload.get("action").and_then(|v| v.as_str()) {
                Some("create") => {
                    let id = payload.get("id").and_then(|v| v.as_str());
                    let account_id = payload.get("account_id").and_then(|v| v.as_str());
                    let broker_id = payload.get("broker_id").and_then(|v| v.as_str());
                    let symbol = payload.get("symbol").and_then(|v| v.as_str());
                    let condition_str = payload.get("condition").and_then(|v| v.as_str());
                    let price_str = payload.get("price").and_then(|v| v.as_str());
                    let (Some(id), Some(account_id), Some(broker_id), Some(symbol), Some(condition_str), Some(price_str)) =
                        (id, account_id, broker_id, symbol, condition_str, price_str)
                    else {
                        tracing::warn!("alert hot-reload: create payload missing a required field");
                        alert_metrics.record_hot_reload_malformed();
                        continue;
                    };
                    let Some(condition) = market_data::alerts::condition_from_str(condition_str) else {
                        tracing::warn!(condition_str, "alert hot-reload: unrecognized condition");
                        alert_metrics.record_hot_reload_malformed();
                        continue;
                    };
                    let Ok(price) = price_str.parse::<rust_decimal::Decimal>() else {
                        tracing::warn!(price_str, "alert hot-reload: unparseable price");
                        alert_metrics.record_hot_reload_malformed();
                        continue;
                    };
                    alert_cache.add(market_data::alerts::PriceAlert {
                        id: id.to_string(),
                        account_id: account_id.to_string(),
                        broker_id: broker_id.to_string(),
                        symbol: symbol.to_string(),
                        condition,
                        price,
                    });
                    alert_metrics.record_hot_reload_add();
                }
                Some("cancel") => {
                    if let Some(id) = payload.get("id").and_then(|v| v.as_str()) {
                        alert_cache.remove(id);
                        alert_metrics.record_hot_reload_cancel();
                    } else {
                        tracing::warn!("alert hot-reload: cancel payload missing id");
                        alert_metrics.record_hot_reload_malformed();
                    }
                }
                other => {
                    tracing::warn!(?other, "alert hot-reload: unrecognized action");
                    alert_metrics.record_hot_reload_malformed();
                }
            }
        }
        tracing::warn!("alert hot-reload: cfg.alerts.* subscription ended");
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
    // Created here (moved ahead of the other feed_stats_registry uses
    // below) so events::connect can wire its slow-consumer event_callback
    // into the same counters /internal/feed-stats already reads.
    let feed_stats_registry = Arc::new(FeedStats::new());
    let nats = events::connect(&nats_url, feed_stats_registry.clone())
        .await
        .expect("failed to connect to NATS");

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

    // Nightly Candle retention -- Contabo DB hygiene audit (M1 was 68% of
    // all Candle rows). See market_data::retention's own module doc for
    // why this runs in bounded batches rather than one DELETE, and for
    // the CANDLE_M1_RETENTION_DAYS/CANDLE_M5_RETENTION_DAYS env vars this
    // reads (defaults 30/180).
    market_data::retention::spawn_candle_retention(pool.clone());

    // Phase 1 trust pack §3 -- see market_data::alerts's own module doc.
    // Loaded once here (every currently ACTIVE alert), then kept current
    // by spawn_alert_hot_reload's own NATS subscription.
    let alert_cache = Arc::new(market_data::alerts::AlertCache::new());
    let alert_metrics = Arc::new(market_data::alerts::AlertMetrics::new());
    match market_data::db::load_active_price_alerts(&pool).await {
        Ok(alerts) => {
            tracing::info!(count = alerts.len(), "loaded active price alerts");
            alert_cache.load(alerts);
        }
        Err(err) => {
            tracing::error!(?err, "failed to load active price alerts at boot -- starting with an empty alert book");
        }
    }
    spawn_alert_hot_reload(alert_cache.clone(), alert_metrics.clone(), nats.clone())
        .await
        .expect("failed to subscribe alert hot-reload to cfg.alerts.*");

    let state = Arc::new(AppState {
        pool,
        nats,
        price_feed_secret,
        internal_service_secret,
        tick_cache,
        feed_stats: feed_stats_registry,
        symbol_activity: symbol_activity_registry,
        gap_fill: gap_fill_tracker,
        alert_cache,
        alert_metrics,
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
        .route("/internal/alert-stats", get(alert_stats))
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
