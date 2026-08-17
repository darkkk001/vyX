//! Pending-order (LIMIT/STOP) trigger scanning — see
//! ../../docs/execution.md §2.1 step 3: "LIMIT/STOP orders sit in
//! ACCEPTED until the Market Data Core's tick stream crosses the trigger
//! price, at which point Execution treats it exactly like a newly-routed
//! MARKET order at that moment's price." Called from `engine/server`'s
//! tick subscription once per tick, scoped to that tick's own symbol — a
//! pending order can only ever trigger off its own symbol's price,
//! unlike the margin monitor (monitor.rs) which has to consider every
//! symbol an account holds and so can't narrow by symbol at all.
//!
//! Placement (`place_pending_order` in lib.rs) never checks margin — this
//! module does, at trigger time, exactly the same check
//! `place_market_order` does for an immediate MARKET order. That's the
//! one place a pending order's fate can differ from what the trader saw
//! when they placed it: if their free margin no longer covers it by the
//! time it triggers, it's rejected here instead of opening a position.

use crate::calc::{self, load_account_state};
use crate::{db, publish_best_effort, PlaceOrderError};
use protocol::{Fill, OrderSide, OrderType, RiskRejection, Tick, TradingEvent};

fn is_triggered(order: &db::PendingOrder, tick: &Tick) -> bool {
    match (order.side, order.order_type) {
        (OrderSide::Buy, OrderType::Limit) => tick.ask <= order.requested_price,
        (OrderSide::Buy, OrderType::Stop) => tick.ask >= order.requested_price,
        (OrderSide::Sell, OrderType::Limit) => tick.bid >= order.requested_price,
        (OrderSide::Sell, OrderType::Stop) => tick.bid <= order.requested_price,
        // get_pending_orders_for_symbol only ever returns LIMIT/STOP rows
        // — a MARKET row reaching here would be a schema-level surprise,
        // not something to trigger on.
        (_, OrderType::Market) => false,
    }
}

/// One pass over every ACCEPTED LIMIT/STOP order for `tick.symbol`,
/// firing any whose trigger price has been crossed. Errors for one order
/// are logged and don't stop the rest — same "one bad row doesn't take
/// down the whole scan" rule as `monitor::run_once`.
pub async fn check_symbol_for_triggers(pool: &sqlx::PgPool, nats: &async_nats::Client, tick: &Tick) {
    let pending = match db::get_pending_orders_for_symbol(pool, &tick.symbol).await {
        Ok(orders) => orders,
        Err(err) => {
            tracing::error!(?err, symbol = %tick.symbol, "pending-order trigger: failed to list pending orders");
            return;
        }
    };

    for order in pending {
        if !is_triggered(&order, tick) {
            continue;
        }
        if let Err(err) = trigger_order(pool, nats, &order, tick).await {
            tracing::error!(?err, order_id = %order.id, "pending-order trigger: failed to process triggered order");
        }
    }
}

async fn trigger_order(
    pool: &sqlx::PgPool,
    nats: &async_nats::Client,
    order: &db::PendingOrder,
    tick: &Tick,
) -> Result<(), PlaceOrderError> {
    let mut tx = pool.begin().await?;

    // Idempotent claim — see db.rs's try_claim_order_for_routing doc. If
    // this returns false, another concurrent scan already has it (two
    // ticks for the same symbol landing close together); nothing to do.
    if !db::try_claim_order_for_routing(&mut tx, &order.id).await? {
        tx.rollback().await?;
        return Ok(());
    }

    let Some(state) = load_account_state(pool, &order.account_id).await? else {
        let reason = "account not found".to_string();
        db::set_rejected(&mut tx, &order.id, &reason).await?;
        tx.commit().await?;
        publish_reject(nats, &order.id, reason).await;
        return Ok(());
    };

    let Some(contract_size) = db::get_symbol_contract_size(pool, &order.symbol).await? else {
        let reason = "unknown symbol".to_string();
        db::set_rejected(&mut tx, &order.id, &reason).await?;
        tx.commit().await?;
        publish_reject(nats, &order.id, reason).await;
        return Ok(());
    };

    // Same margin check place_market_order does — the one place a
    // pending order's outcome can differ from what the trader saw at
    // placement time (see module doc comment).
    let required = risk::required_margin(order.volume, contract_size, tick.bid, state.leverage);
    if let Err(reject_reason) = risk::check_free_margin(calc::equity(&state), calc::used_margin(&state), required) {
        let reason = reject_reason.to_string();
        db::set_rejected(&mut tx, &order.id, &reason).await?;
        tx.commit().await?;
        publish_reject(nats, &order.id, reason).await;
        return Ok(());
    }

    // Broker's own markup on top of the raw tick — see pricing.rs and
    // lib.rs's place_market_order (same logic, same fallback-to-raw for
    // a missing Symbol row).
    let quoted_tick = match db::get_symbol_pricing(pool, &order.broker_id, &order.symbol).await? {
        Some(pricing) => crate::pricing::apply_spread_markup(tick, pricing.spread_markup, pricing.digits),
        None => tick.clone(),
    };

    let fill = execution::execute_market_order(&order.id, order.side, order.volume, &quoted_tick, execution::ExecutionStrategy::Internal);

    db::set_filled(&mut tx, &order.id, fill.price, fill.volume).await?;

    db::insert_position(
        &mut tx,
        &db::NewPosition {
            broker_id: order.broker_id.clone(),
            account_id: order.account_id.clone(),
            symbol: order.symbol.clone(),
            origin_order_id: order.id.clone(),
            side: order.side,
            volume: fill.volume,
            open_price: fill.price,
            sl_price: order.sl_price,
            tp_price: order.tp_price,
        },
    )
    .await?;

    tx.commit().await?;

    publish_best_effort(
        nats,
        &TradingEvent::OrderFilled(Fill {
            order_id: order.id.clone(),
            price: fill.price,
            volume: fill.volume,
            remaining_volume: fill.remaining_volume,
        }),
    )
    .await;

    Ok(())
}

async fn publish_reject(nats: &async_nats::Client, order_id: &str, reason: String) {
    publish_best_effort(
        nats,
        &TradingEvent::OrderRejected(RiskRejection { order_id: order_id.to_string(), reason }),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn order(side: OrderSide, order_type: OrderType, requested_price: rust_decimal::Decimal) -> db::PendingOrder {
        db::PendingOrder {
            id: "o1".into(),
            broker_id: "b1".into(),
            account_id: "a1".into(),
            symbol: "EURUSD".into(),
            side,
            order_type,
            volume: dec!(1),
            requested_price,
            sl_price: None,
            tp_price: None,
        }
    }

    fn tick(bid: rust_decimal::Decimal, ask: rust_decimal::Decimal) -> Tick {
        Tick { symbol: "EURUSD".into(), bid, ask }
    }

    #[test]
    fn buy_limit_triggers_when_ask_falls_to_or_below() {
        let o = order(OrderSide::Buy, OrderType::Limit, dec!(1.09000));
        assert!(is_triggered(&o, &tick(dec!(1.08980), dec!(1.09000))));
        assert!(!is_triggered(&o, &tick(dec!(1.09500), dec!(1.09520))));
    }

    #[test]
    fn buy_stop_triggers_when_ask_rises_to_or_above() {
        let o = order(OrderSide::Buy, OrderType::Stop, dec!(1.11000));
        assert!(is_triggered(&o, &tick(dec!(1.10980), dec!(1.11000))));
        assert!(!is_triggered(&o, &tick(dec!(1.10000), dec!(1.10020))));
    }

    #[test]
    fn sell_limit_triggers_when_bid_rises_to_or_above() {
        let o = order(OrderSide::Sell, OrderType::Limit, dec!(1.11000));
        assert!(is_triggered(&o, &tick(dec!(1.11000), dec!(1.11020))));
        assert!(!is_triggered(&o, &tick(dec!(1.10000), dec!(1.10020))));
    }

    #[test]
    fn sell_stop_triggers_when_bid_falls_to_or_below() {
        let o = order(OrderSide::Sell, OrderType::Stop, dec!(1.09000));
        assert!(is_triggered(&o, &tick(dec!(1.09000), dec!(1.09020))));
        assert!(!is_triggered(&o, &tick(dec!(1.10000), dec!(1.10020))));
    }
}
