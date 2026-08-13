//! Order Management (OMS) — see ../../docs/trading-engine.md.
//!
//! Owns order state exclusively (../../docs/database.md §3: sole writer of
//! the `orders`/`positions` tables). Does not calculate margin, does not
//! decide fill price — it orchestrates calls to Risk and Execution and
//! persists the result in one transaction, per the sequence diagram in
//! ../../docs/trading-engine.md §2.

pub mod db;
pub mod events;

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
    pub current_tick: Tick,
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

    let required = risk::required_margin(req.volume, req.contract_size, req.current_tick.bid, req.leverage);
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

    let fill = execution::execute_market_order(
        &order_id,
        req.side,
        req.volume,
        &req.current_tick,
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

/// The order is already committed to Postgres by the time this is called
/// — a NATS publish failure means a connected client's UI is stale until
/// its next poll/reconnect, not that trading state is wrong. Logged, not
/// propagated as an error, on that basis (see ../../docs/security.md's
/// framing of Postgres as sole authoritative state).
async fn publish_best_effort(nats: &async_nats::Client, event: &TradingEvent) {
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
}
