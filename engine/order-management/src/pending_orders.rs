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
use crate::{db, publish_best_effort, reject_order, PlaceOrderError};
use market_data::ask_markup;
use protocol::{Fill, OrderSide, OrderType, Tick, TradingEvent};
use rust_decimal::Decimal;

/// `tick` is THIS ACCOUNT's quote (see the caller), not the raw one: a BUY enters at the account's
/// ask and a SELL at its bid, which is the price it will actually fill at.
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
        // FLIP L2 (2026-11-02): the entry is compared against THIS ACCOUNT's price, not the raw tick.
        // It used to be the raw one while the fill carried a markup, so a BUY LIMIT triggered the
        // moment the RAW ask reached the entry and then filled above it -- the trader got a worse
        // price than the entry they set. The web path and the engine's own risk hook
        // (market-data/src/risk_hook.rs `triggered`) have always compared the account's price; this
        // scan was the odd one out. Resolved from levels the scan already read, so no extra query.
        let rule = order.ask_levels.as_ref().and_then(ask_markup::resolve);
        let quoted = crate::pricing::quoted_tick(tick, rule.as_ref());
        if !is_triggered(&order, &quoted) {
            continue;
        }
        if let Err(err) = trigger_order(pool, nats, &order, &quoted).await {
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
    let book = db::configured();
    let mut tx = pool.begin().await?;

    // Idempotent claim — see db.rs's try_claim_order_for_routing doc. If
    // this returns false, another concurrent scan already has it (two
    // ticks for the same symbol landing close together); nothing to do.
    if !db::try_claim_order_for_routing(&mut tx, &order.id).await? {
        tx.rollback().await?;
        return Ok(());
    }

    let Some(state) = load_account_state(pool, &order.account_id).await? else {
        reject_order(tx, nats, &order.id, &order.account_id,"account not found".to_string()).await?;
        return Ok(());
    };

    let Some(contract_size) = db::get_symbol_contract_size(pool, &order.symbol).await? else {
        reject_order(tx, nats, &order.id, &order.account_id,"unknown symbol".to_string()).await?;
        return Ok(());
    };

    // Same margin check place_market_order does — the one place a
    // pending order's outcome can differ from what the trader saw at
    // placement time (see module doc comment). Lot size and
    // symbol-enabled were already checked at placement (lib.rs's
    // place_pending_order) and don't need rechecking here.
    let required = risk::required_margin(order.volume, contract_size, tick.bid, state.leverage);
    if let Err(reject_reason) = risk::check_free_margin(calc::equity(&state), calc::used_margin(&state), required) {
        reject_order(tx, nats, &order.id, &order.account_id,reject_reason.to_string()).await?;
        return Ok(());
    }

    // §2.1 step 5 — exposure limits, checked here at trigger time like
    // margin above (not at placement — see lib.rs's place_pending_order
    // comment), since only an actual fill changes an account's exposure.
    // `state` (loaded above for the margin check) already has every open
    // position, so this doesn't need its own DB round trip.
    let symbol_config = db::get_broker_symbol_config(pool, &order.broker_id, &order.symbol).await?;
    let open_volume: Decimal = state.positions.iter().filter(|p| p.symbol == order.symbol).map(|p| p.volume).sum();
    let max_exposure = symbol_config.as_ref().and_then(|cfg| cfg.max_exposure);
    if let Err(reject_reason) = risk::check_symbol_exposure(open_volume, order.volume, max_exposure) {
        reject_order(tx, nats, &order.id, &order.account_id,reject_reason.to_string()).await?;
        return Ok(());
    }
    // Where this fill's risk goes -- resolved before the writes, as in place_market_order.
    let book_type = match book {
        db::Book::Prisma => db::BookType::of_category(db::get_routing_category(pool, &order.account_id).await?.as_deref()),
        db::Book::Legacy => db::BookType::BBook,
    };
    let max_open_positions = db::get_broker_max_open_positions(pool, &order.broker_id).await?;
    if let Err(reject_reason) = risk::check_max_open_positions(state.positions.len() as i64, max_open_positions) {
        reject_order(tx, nats, &order.id, &order.account_id,reject_reason.to_string()).await?;
        return Ok(());
    }

    // `tick` is ALREADY this account's quote: check_symbol_for_triggers resolved the rule from the
    // levels the scan read and priced the tick with it, so the entry test and this fill cannot
    // disagree -- and no second read happens per triggered order.
    let quoted_tick = tick.clone();

    let fill = execution::execute_market_order(&order.id, &order.account_id, order.side, order.volume, &quoted_tick, execution::ExecutionStrategy::Internal);

    // Stage 3's double-fill guard applies to a triggered resting order too: two ticks for the same
    // symbol landing together both reach here, and only one may fill it.
    if !db::set_filled(&mut tx, book, &order.id, fill.price, fill.volume, Some(book_type.as_str())).await? {
        tx.rollback().await?;
        return Ok(());
    }

    let (position_id, _opened_at) = db::insert_position(
        &mut tx,
        book,
        &db::NewPosition {
            broker_id: order.broker_id.clone(),
            account_id: order.account_id.clone(),
            symbol: order.symbol.clone(),
            symbol_id: symbol_config.as_ref().map(|c| c.symbol_id.clone()).unwrap_or_default(),
            origin_order_id: order.id.clone(),
            side: order.side,
            volume: fill.volume,
            open_price: fill.price,
            sl_price: order.sl_price,
            tp_price: order.tp_price,
            book_type,
        },
    )
    .await?;

    // Same one-time open commission as place_market_order — see
    // BrokerSymbolConfig's doc comment and db.rs's record_commission.
    let commission_per_lot = symbol_config.as_ref().map_or(Decimal::ZERO, |cfg| cfg.commission_per_lot);
    db::record_commission(&mut tx, book, &order.broker_id, &order.account_id, &position_id, commission_per_lot, fill.volume).await?;

    // The IN deal, after the commission it sums (see db::write_open_deal). CLIENT: a resting order the
    // client placed, filled by its own trigger -- the same reason the web gives a client market fill.
    if book == db::Book::Prisma {
        db::write_open_deal(&mut tx, &position_id, "CLIENT").await?;
    }

    tx.commit().await?;

    publish_best_effort(
        nats,
        &TradingEvent::OrderFilled(Fill {
            order_id: order.id.clone(),
            account_id: order.account_id.clone(),
            price: fill.price,
            volume: fill.volume,
            remaining_volume: fill.remaining_volume,
        }),
    )
    .await;

    Ok(())
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
            // these unit tests hand is_triggered a tick DIRECTLY, so the rule has already been
            // applied by the caller; the levels on the order are only read in that caller
            ask_levels: None,
        }
    }

    fn tick(bid: rust_decimal::Decimal, ask: rust_decimal::Decimal) -> Tick {
        Tick { symbol: "EURUSD".into(), bid, ask, t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None, bars: Vec::new() }
    }

    /// FLIP L2: `check_symbol_for_triggers` prices the tick with the account's rule BEFORE testing the
    /// entry, so a markup moves the trigger exactly as it moves the fill. Previously the entry was
    /// tested on the raw tick while the fill carried the markup, so a BUY LIMIT triggered when the RAW
    /// ask reached the entry and then filled ABOVE it. This asserts the two now agree.
    #[test]
    fn the_entry_is_measured_against_the_account_price_the_fill_will_use() {
        use market_data::ask_markup::AskRule;
        // 1.5 pips on a 5-digit symbol = 0.00015 of spread, half (0.000075) each side, rounded away
        // from the client: ask ceil(1.09000 + 0.000075) = 1.09008, bid floor(1.08980 - 0.000075) = 1.08972
        let rule = AskRule::Markup { markup_pips: dec!(1.5), digits: 5 };
        let raw = tick(dec!(1.08980), dec!(1.09000));
        let quoted = crate::pricing::quoted_tick(&raw, Some(&rule));
        assert_eq!((quoted.bid, quoted.ask), (dec!(1.08972), dec!(1.09008)));

        // a BUY LIMIT at the raw ask: the RAW tick would trigger it, the account's ask has not reached it
        let buy_limit = order(OrderSide::Buy, OrderType::Limit, dec!(1.09000));
        assert!(is_triggered(&buy_limit, &raw), "the raw ask reaches the entry");
        assert!(!is_triggered(&buy_limit, &quoted), "the account's ask does not -- so it must NOT fill");

        // a SELL STOP at the raw bid: symmetrically, the account's marked-down bid HAS fallen through it
        let sell_stop = order(OrderSide::Sell, OrderType::Stop, dec!(1.08975));
        assert!(!is_triggered(&sell_stop, &raw));
        assert!(is_triggered(&sell_stop, &quoted), "the account's bid 1.08972 is below the entry");
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
