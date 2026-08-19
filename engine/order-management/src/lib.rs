//! Order Management (OMS) — see ../../docs/trading-engine.md.
//!
//! Owns order state exclusively (../../docs/database.md §3: sole writer of
//! the `orders`/`positions` tables). Does not calculate margin, does not
//! decide fill price — it orchestrates calls to Risk and Execution and
//! persists the result in one transaction, per the sequence diagram in
//! ../../docs/trading-engine.md §2.

pub mod calc;
pub mod db;
pub mod events;
pub mod monitor;
pub mod pending_orders;
pub mod pricing;
pub mod swap;

use chrono::Duration as ChronoDuration;
use market_data::cache::TickCache;
use protocol::{Fill, OrderSide, OrderStatus, OrderType, RiskRejection, Tick, TradingEvent};
use rust_decimal::Decimal;
use sqlx::PgPool;

// Same 15s staleness window market_data::db::get_live_price's own SQL
// enforces -- kept as one function so the in-memory cache and the
// Postgres fallback can never silently drift apart.
fn tick_freshness() -> ChronoDuration {
    ChronoDuration::seconds(15)
}

/// Returns whether `to` is a legal next state from `from`, per the
/// diagram in ../../docs/architecture.md §5 / ../../docs/trading-engine.md
/// §2.1. This is the single source of truth for legality — callers should
/// never mutate an order's status without checking this first.
pub fn is_legal_transition(from: OrderStatus, to: OrderStatus) -> bool {
    use OrderStatus::*;
    matches!(
        (from, to),
        (New, Validating)
            | (Validating, Accepted)
            | (Validating, Rejected)
            | (Accepted, Routing)
            | (Accepted, Cancelled)
            | (Accepted, Expired)
            | (Routing, PartiallyFilled)
            | (Routing, Filled)
            | (Routing, Rejected)
            | (PartiallyFilled, Filled)
            | (PartiallyFilled, Cancelled)
    )
}

#[derive(Debug, thiserror::Error)]
pub enum TransitionError {
    #[error("illegal order state transition: {from:?} -> {to:?}")]
    Illegal { from: OrderStatus, to: OrderStatus },
}

/// Validates and (once wired to a Postgres pool) persists a state
/// transition in the same query as any resulting Position/Ledger mutation
/// — see ../../docs/trading-engine.md §2.1 on atomicity. The actual
/// Postgres write isn't implemented yet; this is the Phase 1 scaffold
/// checkpoint, Phase 2 wires it to `sqlx`.
pub fn transition(from: OrderStatus, to: OrderStatus) -> Result<OrderStatus, TransitionError> {
    if is_legal_transition(from, to) {
        Ok(to)
    } else {
        Err(TransitionError::Illegal { from, to })
    }
}

/// Everything OMS needs to place a MARKET order that it doesn't own the
/// storage for itself. `equity`/`used_margin` come from the account's
/// current state, `contract_size`/`leverage` from the symbol spec and
/// account respectively — both Prisma-owned per ADR-002
/// (../../docs/database.md §2), so OMS is handed the numbers rather than
/// reaching into tables it doesn't own. Wiring up who supplies these
/// (the API Gateway, reading Prisma) is Phase 2 integration work still
/// open — see ../../docs/api.md §4.
///
/// Deliberately does NOT include the current tick/price — that used to
/// be caller-supplied (the API Gateway's own Postgres read), which
/// worked but wasn't what ../../docs/execution.md §2.1 specifies
/// ("current best bid/ask from the Market Data Core... never the
/// client-supplied price," where "client" there means whoever calls this
/// function, not just the end user's browser). `place_market_order` now
/// fetches it itself via `market_data::db::get_live_price` — one fewer
/// hop between "the price OMS fills at" and "the price Market Data Core
/// actually has right now."
pub struct PlaceMarketOrderRequest {
    pub broker_id: String,
    pub account_id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub volume: Decimal,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
    pub equity: Decimal,
    pub used_margin: Decimal,
    pub contract_size: Decimal,
    pub leverage: u32,
}

#[derive(Debug)]
pub enum PlaceMarketOrderOutcome {
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

#[derive(Debug, thiserror::Error)]
pub enum PlaceOrderError {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// The MARKET-order path conceptually passes through NEW -> VALIDATING ->
/// ACCEPTED|REJECTED -> ROUTING -> FILLED (see ../../docs/trading-engine.md
/// §2, §2.1's atomicity requirement), all in one Postgres transaction --
/// but only the terminal status (via `db::set_filled`/`db::set_rejected`)
/// is ever actually persisted. The intermediate writes were removed as a
/// round-trip optimization (docs/testing.md's Concurrency/latency
/// benchmark row): Postgres's default READ COMMITTED isolation means
/// nothing outside this transaction can ever observe an uncommitted
/// intermediate value, so writing NEW->VALIDATING->ACCEPTED->ROUTING as
/// separate UPDATEs before the final commit was pure network cost with no
/// observable effect -- the committed row is identical either way. Does
/// not publish NATS events itself — the caller does that after `commit()`
/// succeeds, since an event about a transaction that might still roll
/// back would be a lie. See ../../docs/api.md §2.1 for who consumes those
/// events downstream.
pub async fn place_market_order(
    pool: &PgPool,
    nats: &async_nats::Client,
    cache: &TickCache,
    req: PlaceMarketOrderRequest,
) -> Result<PlaceMarketOrderOutcome, PlaceOrderError> {
    let mut tx = pool.begin().await?;

    let order_id = db::insert_order(
        &mut tx,
        &db::NewOrder {
            broker_id: req.broker_id.clone(),
            account_id: req.account_id.clone(),
            symbol: req.symbol.clone(),
            side: req.side,
            order_type: OrderType::Market,
            volume: req.volume,
            requested_price: None,
            sl_price: req.sl_price,
            tp_price: req.tp_price,
        },
    )
    .await?;

    // Market Data Core's own current view, not a value the caller handed
    // in — see PlaceMarketOrderRequest's doc comment. Read the in-memory
    // TickCache first (no DB round trip on the common, hot path — the
    // spec's "Rust in-memory state... avoid unnecessary DB round trips"
    // rule); Postgres is only a fallback for a symbol that hasn't ticked
    // in-process yet (e.g. right after a server restart). Read against
    // `pool` directly (not `tx`) in the fallback case: it's a
    // point-in-time read of a table this crate doesn't own (ADR-002), not
    // something that needs snapshot consistency with the order-row insert
    // above.
    let current_tick = match cache.get_if_fresh(&req.symbol, tick_freshness()) {
        Some(tick) => Some(tick),
        None => market_data::db::get_live_price(pool, &req.symbol)
            .await?
            .map(|(bid, ask)| Tick { symbol: req.symbol.clone(), bid, ask, t0: None }),
    };
    let current_tick = match current_tick {
        Some(tick) => tick,
        None => {
            let reason = reject_order(tx, nats, &order_id, format!("no live price for {}", req.symbol)).await?;
            return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
        }
    };

    // Fetched once, used for both admission checks below and the markup
    // application further down — one DB round-trip covers both, since
    // both live on the same BrokerSymbol row. A `None` here (the Symbol
    // row itself doesn't exist) is a rare, benign case rather than a hard
    // error — see get_broker_symbol_config's doc comment — so admission
    // checks are skipped, matching the existing markup fallback.
    let symbol_config = db::get_broker_symbol_config(pool, &req.broker_id, &req.symbol).await?;

    if let Some(cfg) = &symbol_config {
        if let Err(reject_reason) = risk::check_symbol_enabled(cfg.enabled) {
            let reason = reject_order(tx, nats, &order_id, reject_reason.to_string()).await?;
            return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
        }
        if let Err(reject_reason) = risk::check_lot_size(req.volume, cfg.min_lot, cfg.max_lot, cfg.lot_step) {
            let reason = reject_order(tx, nats, &order_id, reject_reason.to_string()).await?;
            return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
        }
    }

    let required = risk::required_margin(req.volume, req.contract_size, current_tick.bid, req.leverage);
    if let Err(reject_reason) = risk::check_free_margin(req.equity, req.used_margin, required) {
        let reason = reject_order(tx, nats, &order_id, reject_reason.to_string()).await?;
        return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
    }

    // §2.1 step 5 — per-broker exposure limits. Last of the admission
    // checks, matching risk-engine.md's own ordering: cheaper/simpler
    // checks (enabled, lot size, margin) reject first. Both aggregates
    // fetched in one round trip -- see get_exposure_and_max_positions's
    // doc comment.
    let (exposure, max_open_positions) =
        db::get_exposure_and_max_positions(pool, &req.broker_id, &req.account_id, &req.symbol).await?;
    let max_exposure = symbol_config.as_ref().and_then(|cfg| cfg.max_exposure);
    if let Err(reject_reason) = risk::check_symbol_exposure(exposure.open_volume, req.volume, max_exposure) {
        let reason = reject_order(tx, nats, &order_id, reject_reason.to_string()).await?;
        return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
    }
    if let Err(reject_reason) = risk::check_max_open_positions(exposure.open_position_count, max_open_positions) {
        let reason = reject_order(tx, nats, &order_id, reject_reason.to_string()).await?;
        return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
    }

    // Broker's own markup on top of Market Data Core's raw price — see
    // pricing.rs. Reuses the config fetched above rather than a second
    // round-trip.
    let quoted_tick = match &symbol_config {
        Some(cfg) => pricing::apply_spread_markup(&current_tick, cfg.spread_markup, cfg.digits),
        None => current_tick.clone(),
    };

    let fill = execution::execute_market_order(
        &order_id,
        req.side,
        req.volume,
        &quoted_tick,
        execution::ExecutionStrategy::Internal,
    );

    db::set_filled(&mut tx, &order_id, fill.price, fill.volume).await?;

    let position_id = db::insert_position(
        &mut tx,
        &db::NewPosition {
            broker_id: req.broker_id,
            account_id: req.account_id.clone(),
            symbol: req.symbol,
            origin_order_id: order_id.clone(),
            side: req.side,
            volume: fill.volume,
            open_price: fill.price,
            sl_price: req.sl_price,
            tp_price: req.tp_price,
        },
    )
    .await?;

    // Flat per-lot commission, charged once at open (round-turn, not
    // split between open/close) — see BrokerSymbolConfig's doc comment
    // and db.rs's record_commission.
    let commission = symbol_config.as_ref().map_or(Decimal::ZERO, |cfg| cfg.commission_per_lot * fill.volume);
    db::record_commission(&mut tx, &position_id, &req.account_id, commission).await?;

    tx.commit().await?;

    publish_best_effort(
        nats,
        &TradingEvent::OrderFilled(Fill {
            order_id: order_id.clone(),
            price: fill.price,
            volume: fill.volume,
            remaining_volume: fill.remaining_volume,
        }),
    )
    .await;

    Ok(PlaceMarketOrderOutcome::Filled {
        order_id,
        position_id,
        fill_price: fill.price,
    })
}

/// Everything OMS needs to place a pending LIMIT/STOP order — see
/// ../../docs/execution.md §2.1 step 3. Unlike `PlaceMarketOrderRequest`,
/// there's no `equity`/`used_margin` here: a pending order doesn't
/// reserve margin while it waits (matches how MT5-style platforms
/// behave — margin is checked when the order actually triggers and
/// opens a position, not while it's sitting unfilled). See
/// `pending_orders.rs` for that trigger-time check.
pub struct PlacePendingOrderRequest {
    pub broker_id: String,
    pub account_id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub volume: Decimal,
    pub requested_price: Decimal,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
}

#[derive(Debug)]
pub enum PlacePendingOrderOutcome {
    Accepted { order_id: String },
    Rejected { order_id: String, reason: String },
}

/// A pending order's requested price has to be on the side of the
/// current market that makes it a real pending order, not an order that
/// would just fill immediately if routed as-is:
/// - BUY LIMIT: below the current ask (buy cheaper than now)
/// - BUY STOP: above the current ask (buy a breakout)
/// - SELL LIMIT: above the current bid (sell higher than now)
/// - SELL STOP: below the current bid (sell a breakdown)
///
/// A `MARKET` order_type reaching this function is a caller bug (
/// `engine/server` should only route LIMIT/STOP here) — rejected the
/// same way rather than panicking, since it's still safe to handle as an
/// ordinary rejection.
fn validate_pending_price_side(
    side: OrderSide,
    order_type: OrderType,
    requested_price: Decimal,
    current: &Tick,
) -> Result<(), String> {
    match (side, order_type) {
        (OrderSide::Buy, OrderType::Limit) if requested_price >= current.ask => {
            Err(format!("BUY LIMIT price {requested_price} must be below the current ask {}", current.ask))
        }
        (OrderSide::Buy, OrderType::Stop) if requested_price <= current.ask => {
            Err(format!("BUY STOP price {requested_price} must be above the current ask {}", current.ask))
        }
        (OrderSide::Sell, OrderType::Limit) if requested_price <= current.bid => {
            Err(format!("SELL LIMIT price {requested_price} must be above the current bid {}", current.bid))
        }
        (OrderSide::Sell, OrderType::Stop) if requested_price >= current.bid => {
            Err(format!("SELL STOP price {requested_price} must be below the current bid {}", current.bid))
        }
        (_, OrderType::Market) => Err("pending orders must be LIMIT or STOP, not MARKET".to_string()),
        _ => Ok(()),
    }
}

/// Places a LIMIT/STOP order in ACCEPTED status — no fill, no position,
/// no margin check yet. `pending_orders::check_symbol_for_triggers`
/// (called from `engine/server`'s tick subscription) does the rest once
/// price actually crosses `requested_price`.
pub async fn place_pending_order(
    pool: &PgPool,
    nats: &async_nats::Client,
    cache: &TickCache,
    req: PlacePendingOrderRequest,
) -> Result<PlacePendingOrderOutcome, PlaceOrderError> {
    let mut tx = pool.begin().await?;

    let order_id = db::insert_order(
        &mut tx,
        &db::NewOrder {
            broker_id: req.broker_id.clone(),
            account_id: req.account_id.clone(),
            symbol: req.symbol.clone(),
            side: req.side,
            order_type: req.order_type,
            volume: req.volume,
            requested_price: Some(req.requested_price),
            sl_price: req.sl_price,
            tp_price: req.tp_price,
        },
    )
    .await?;

    // Same cache-first, DB-fallback rule as place_market_order — used
    // here only to validate the pending price is on the correct side of
    // today's market, not to fill anything yet.
    let current_tick = match cache.get_if_fresh(&req.symbol, tick_freshness()) {
        Some(tick) => Some(tick),
        None => market_data::db::get_live_price(pool, &req.symbol)
            .await?
            .map(|(bid, ask)| Tick { symbol: req.symbol.clone(), bid, ask, t0: None }),
    };
    let current_tick = match current_tick {
        Some(tick) => tick,
        None => {
            let reason = reject_order(tx, nats, &order_id, format!("no live price for {}", req.symbol)).await?;
            return Ok(PlacePendingOrderOutcome::Rejected { order_id, reason });
        }
    };

    if let Err(reason) = validate_pending_price_side(req.side, req.order_type, req.requested_price, &current_tick) {
        let reason = reject_order(tx, nats, &order_id, reason).await?;
        return Ok(PlacePendingOrderOutcome::Rejected { order_id, reason });
    }

    // Same admission checks as place_market_order (§2.1) — a disabled
    // symbol or an out-of-bounds lot shouldn't even be accepted as
    // pending, rather than sitting there until trigger time only to
    // reject then. Lot size doesn't need rechecking at trigger time
    // (pending_orders.rs) since volume never changes after placement.
    if let Some(cfg) = db::get_broker_symbol_config(pool, &req.broker_id, &req.symbol).await? {
        if let Err(reject_reason) = risk::check_symbol_enabled(cfg.enabled) {
            let reason = reject_order(tx, nats, &order_id, reject_reason.to_string()).await?;
            return Ok(PlacePendingOrderOutcome::Rejected { order_id, reason });
        }
        if let Err(reject_reason) = risk::check_lot_size(req.volume, cfg.min_lot, cfg.max_lot, cfg.lot_step) {
            let reason = reject_order(tx, nats, &order_id, reject_reason.to_string()).await?;
            return Ok(PlacePendingOrderOutcome::Rejected { order_id, reason });
        }
    }

    db::set_status(&mut tx, &order_id, OrderStatus::Accepted).await?;
    tx.commit().await?;

    publish_best_effort(nats, &TradingEvent::OrderAccepted { order_id: order_id.clone() }).await;

    Ok(PlacePendingOrderOutcome::Accepted { order_id })
}

/// The order is already committed to Postgres by the time this is called
/// — a NATS publish failure means a connected client's UI is stale until
/// its next poll/reconnect, not that trading state is wrong. Logged, not
/// propagated as an error, on that basis (see ../../docs/security.md's
/// framing of Postgres as sole authoritative state).
/// Shared tail of every admission-rejection path: mark the order
/// rejected, commit that (a rejection is itself a terminal state worth
/// persisting even though nothing else in the transaction happened), and
/// publish the event. Takes `tx` by value since a rejection always
/// commits and ends the transaction's life — there's nothing left for
/// the caller to do with it. Returns the reason so each call site can
/// still build its own `Outcome::Rejected` variant.
pub(crate) async fn reject_order(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    nats: &async_nats::Client,
    order_id: &str,
    reason: String,
) -> Result<String, PlaceOrderError> {
    db::set_rejected(&mut tx, order_id, &reason).await?;
    tx.commit().await?;
    publish_best_effort(
        nats,
        &TradingEvent::OrderRejected(RiskRejection { order_id: order_id.to_string(), reason: reason.clone() }),
    )
    .await;
    Ok(reason)
}

pub(crate) async fn publish_best_effort(nats: &async_nats::Client, event: &TradingEvent) {
    if let Err(err) = events::publish(nats, event).await {
        tracing::warn!(?err, "failed to publish trading event to NATS");
    }
}

#[derive(Debug)]
pub enum CancelOrderOutcome {
    Cancelled { order_id: String },
    /// Covers both "no such order" and "exists but belongs to a
    /// different account" — same collapsing the legacy Next.js route
    /// does (app/api/trade/orders/[id]/route.ts's `!order ||
    /// order.accountId !== session.accountId`), so a wrong account_id
    /// never confirms an order's existence.
    NotFound,
    InvalidStatus { status: OrderStatus },
}

#[derive(Debug, thiserror::Error)]
pub enum CancelOrderError {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Cancels a resting LIMIT/STOP order sitting in `ACCEPTED` — the only
/// status this is legal from (`is_legal_transition`'s `(Accepted,
/// Cancelled)`), mirroring the legacy Next.js path's "only PENDING can
/// be cancelled" rule. A MARKET order is filled synchronously within
/// `place_market_order` itself, so by the time a caller could reach this
/// function it's already terminal (FILLED/REJECTED) — cancel is only
/// ever meaningful for a still-waiting pending order.
pub async fn cancel_order(
    pool: &PgPool,
    nats: &async_nats::Client,
    order_id: &str,
    account_id: &str,
) -> Result<CancelOrderOutcome, CancelOrderError> {
    let Some(order) = db::get_order(pool, order_id).await? else {
        return Ok(CancelOrderOutcome::NotFound);
    };
    if order.account_id != account_id {
        return Ok(CancelOrderOutcome::NotFound);
    }
    if order.status != OrderStatus::Accepted {
        return Ok(CancelOrderOutcome::InvalidStatus { status: order.status });
    }

    let mut tx = pool.begin().await?;
    let claimed = db::cancel_order(&mut tx, order_id).await?;
    if !claimed {
        // Lost a race with the order triggering (or another cancel call)
        // between the read above and this claim -- re-report its actual
        // current status rather than falsely confirming cancellation.
        tx.rollback().await?;
        let current = db::get_order(pool, order_id).await?;
        return Ok(match current {
            Some(o) => CancelOrderOutcome::InvalidStatus { status: o.status },
            None => CancelOrderOutcome::NotFound,
        });
    }
    tx.commit().await?;

    publish_best_effort(nats, &TradingEvent::OrderCancelled { order_id: order_id.to_string() }).await;

    Ok(CancelOrderOutcome::Cancelled { order_id: order_id.to_string() })
}

#[derive(Debug)]
pub enum ModifyPositionOutcome {
    Updated {
        sl_price: Option<Decimal>,
        tp_price: Option<Decimal>,
    },
    NotFound,
    InvalidStatus {
        status: db::PositionStatus,
    },
    ValidationFailed {
        reason: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ModifyPositionError {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Edits an open position's SL/TP — same operation as the legacy
/// Next.js path's `PATCH /api/trade/positions/[id]`, not the
/// order-level `ModifyOrder` in docs/trading-engine.md's original
/// target spec (nothing in the live app has ever needed that; this
/// mirrors what traders actually do today). `current_price` is
/// caller-supplied (the Gateway's own Market Data Core read) rather
/// than fetched here, same reasoning as `PlaceMarketOrderRequest` not
/// including a tick -- kept out here deliberately so this function
/// doesn't gain its own Market Data Core dependency for one read the
/// caller already has to make anyway to show the trader a current price.
pub async fn modify_position_sl_tp(
    pool: &PgPool,
    account_id: &str,
    position_id: &str,
    current_price: Decimal,
    sl_price: Option<Decimal>,
    tp_price: Option<Decimal>,
) -> Result<ModifyPositionOutcome, ModifyPositionError> {
    let Some(position) = db::get_position(pool, position_id).await? else {
        return Ok(ModifyPositionOutcome::NotFound);
    };
    if position.account_id != account_id {
        return Ok(ModifyPositionOutcome::NotFound);
    }
    if position.status != db::PositionStatus::Open {
        return Ok(ModifyPositionOutcome::InvalidStatus { status: position.status });
    }

    if let Err(reason) = risk::validate_sl_tp(position.side, current_price, sl_price, tp_price) {
        return Ok(ModifyPositionOutcome::ValidationFailed { reason: reason.to_string() });
    }

    let mut tx = pool.begin().await?;
    db::update_position_sl_tp(&mut tx, position_id, sl_price, tp_price).await?;
    tx.commit().await?;

    Ok(ModifyPositionOutcome::Updated { sl_price, tp_price })
}

#[cfg(test)]
mod tests {
    use super::*;
    use OrderStatus::*;

    #[test]
    fn happy_path_market_order() {
        assert!(is_legal_transition(New, Validating));
        assert!(is_legal_transition(Validating, Accepted));
        assert!(is_legal_transition(Accepted, Routing));
        assert!(is_legal_transition(Routing, Filled));
    }

    #[test]
    fn rejects_skip_ahead() {
        assert!(!is_legal_transition(New, Filled));
        assert!(!is_legal_transition(New, Accepted));
        assert!(!is_legal_transition(Filled, Cancelled));
    }

    #[test]
    fn terminal_states_have_no_outgoing_transitions() {
        for terminal in [Filled, Rejected, Cancelled, Expired] {
            for target in [New, Validating, Accepted, Routing, PartiallyFilled, Filled, Rejected, Expired] {
                assert!(
                    !is_legal_transition(terminal, target),
                    "{terminal:?} should not transition to {target:?}"
                );
            }
        }
    }

    /// docs/testing.md §2's OMS gate: "every legal transition... has a
    /// unit test." is_legal_transition's match arms define exactly 11
    /// legal (from, to) pairs -- asserted here in one place rather than
    /// only implicitly via the happy-path tests above, which exercise a
    /// subset. Includes (Accepted, Cancelled) and (PartiallyFilled,
    /// Cancelled), the two pairs cancel_order depends on.
    #[test]
    fn every_documented_legal_transition_is_legal() {
        let legal_pairs = [
            (New, Validating),
            (Validating, Accepted),
            (Validating, Rejected),
            (Accepted, Routing),
            (Accepted, Cancelled),
            (Accepted, Expired),
            (Routing, PartiallyFilled),
            (Routing, Filled),
            (Routing, Rejected),
            (PartiallyFilled, Filled),
            (PartiallyFilled, Cancelled),
        ];
        for (from, to) in legal_pairs {
            assert!(is_legal_transition(from, to), "{from:?} -> {to:?} should be legal");
        }
    }

    mod pending_price_validation {
        use super::*;
        use rust_decimal_macros::dec;

        fn tick() -> Tick {
            Tick { symbol: "EURUSD".into(), bid: dec!(1.10000), ask: dec!(1.10020), t0: None }
        }

        #[test]
        fn buy_limit_must_be_below_current_ask() {
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Limit, dec!(1.09000), &tick()).is_ok());
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Limit, dec!(1.10020), &tick()).is_err());
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Limit, dec!(1.11000), &tick()).is_err());
        }

        #[test]
        fn buy_stop_must_be_above_current_ask() {
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Stop, dec!(1.11000), &tick()).is_ok());
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Stop, dec!(1.10020), &tick()).is_err());
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Stop, dec!(1.09000), &tick()).is_err());
        }

        #[test]
        fn sell_limit_must_be_above_current_bid() {
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Limit, dec!(1.11000), &tick()).is_ok());
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Limit, dec!(1.10000), &tick()).is_err());
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Limit, dec!(1.09000), &tick()).is_err());
        }

        #[test]
        fn sell_stop_must_be_below_current_bid() {
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Stop, dec!(1.09000), &tick()).is_ok());
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Stop, dec!(1.10000), &tick()).is_err());
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Stop, dec!(1.11000), &tick()).is_err());
        }

        #[test]
        fn market_order_type_always_rejected() {
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Market, dec!(1.00000), &tick()).is_err());
        }
    }
}
