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

use protocol::{Fill, OrderSide, OrderStatus, OrderType, RiskRejection, Tick, TradingEvent};
use rust_decimal::Decimal;
use sqlx::PgPool;

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

/// The MARKET-order path through NEW -> VALIDATING -> ACCEPTED|REJECTED ->
/// ROUTING -> FILLED, all in one Postgres transaction (see
/// ../../docs/trading-engine.md §2, §2.1's atomicity requirement). Does
/// not publish NATS events itself — the caller does that after `commit()`
/// succeeds, since an event about a transaction that might still roll
/// back would be a lie. See ../../docs/api.md §2.1 for who consumes those
/// events downstream.
pub async fn place_market_order(
    pool: &PgPool,
    nats: &async_nats::Client,
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

    db::set_status(&mut tx, &order_id, OrderStatus::Validating).await?;

    // Market Data Core's own current view, not a value the caller handed
    // in — see PlaceMarketOrderRequest's doc comment. Read against `pool`
    // directly (not `tx`): it's a point-in-time read of a table this
    // crate doesn't own (ADR-002), not something that needs snapshot
    // consistency with the order-row insert above.
    let current_tick = match market_data::db::get_live_price(pool, &req.symbol).await? {
        Some((bid, ask)) => Tick { symbol: req.symbol.clone(), bid, ask },
        None => {
            let reason = format!("no live price for {}", req.symbol);
            db::set_rejected(&mut tx, &order_id, &reason).await?;
            tx.commit().await?;
            publish_best_effort(
                nats,
                &TradingEvent::OrderRejected(RiskRejection {
                    order_id: order_id.clone(),
                    reason: reason.clone(),
                }),
            )
            .await;
            return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
        }
    };

    let required = risk::required_margin(req.volume, req.contract_size, current_tick.bid, req.leverage);
    if let Err(reject_reason) = risk::check_free_margin(req.equity, req.used_margin, required) {
        let reason = reject_reason.to_string();
        db::set_rejected(&mut tx, &order_id, &reason).await?;
        tx.commit().await?;
        publish_best_effort(
            nats,
            &TradingEvent::OrderRejected(RiskRejection {
                order_id: order_id.clone(),
                reason: reason.clone(),
            }),
        )
        .await;
        return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
    }

    db::set_status(&mut tx, &order_id, OrderStatus::Accepted).await?;
    db::set_status(&mut tx, &order_id, OrderStatus::Routing).await?;

    // Broker's own markup on top of Market Data Core's raw price — see
    // pricing.rs. Missing/unconfigured BrokerSymbol just means zero
    // markup (get_symbol_pricing's own doc comment), so a `None` here
    // (symbol row itself doesn't exist) is the only case worth a fallback
    // rather than a hard error — the risk check above already proved a
    // live price and a valid order exist, so this is a rare, benign
    // "pricing config missing" case, not treated as fatal.
    let quoted_tick = match db::get_symbol_pricing(pool, &req.broker_id, &req.symbol).await? {
        Some(pricing) => pricing::apply_spread_markup(&current_tick, pricing.spread_markup, pricing.digits),
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
            account_id: req.account_id,
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

    db::set_status(&mut tx, &order_id, OrderStatus::Validating).await?;

    // Same "OMS fetches its own price" rule as place_market_order — used
    // here only to validate the pending price is on the correct side of
    // today's market, not to fill anything yet.
    let current_tick = match market_data::db::get_live_price(pool, &req.symbol).await? {
        Some((bid, ask)) => Tick { symbol: req.symbol.clone(), bid, ask },
        None => {
            let reason = format!("no live price for {}", req.symbol);
            db::set_rejected(&mut tx, &order_id, &reason).await?;
            tx.commit().await?;
            publish_best_effort(
                nats,
                &TradingEvent::OrderRejected(RiskRejection { order_id: order_id.clone(), reason: reason.clone() }),
            )
            .await;
            return Ok(PlacePendingOrderOutcome::Rejected { order_id, reason });
        }
    };

    if let Err(reason) = validate_pending_price_side(req.side, req.order_type, req.requested_price, &current_tick) {
        db::set_rejected(&mut tx, &order_id, &reason).await?;
        tx.commit().await?;
        publish_best_effort(
            nats,
            &TradingEvent::OrderRejected(RiskRejection { order_id: order_id.clone(), reason: reason.clone() }),
        )
        .await;
        return Ok(PlacePendingOrderOutcome::Rejected { order_id, reason });
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
pub(crate) async fn publish_best_effort(nats: &async_nats::Client, event: &TradingEvent) {
    if let Err(err) = events::publish(nats, event).await {
        tracing::warn!(?err, "failed to publish trading event to NATS");
    }
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
            for target in [New, Validating, Accepted, Routing, PartiallyFilled, Filled] {
                assert!(
                    !is_legal_transition(terminal, target),
                    "{terminal:?} should not transition to {target:?}"
                );
            }
        }
    }

    mod pending_price_validation {
        use super::*;
        use rust_decimal_macros::dec;

        fn tick() -> Tick {
            Tick { symbol: "EURUSD".into(), bid: dec!(1.10000), ask: dec!(1.10020) }
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
