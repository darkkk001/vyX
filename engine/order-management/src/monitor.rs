//! Margin monitor — see ../../docs/risk-engine.md §2.2. Runs periodically
//! (not literally "on every price tick" yet — there's no running Rust
//! market-data ingest service publishing ticks in this engagement, see
//! ../../docs/market-data.md's implementation status; polling Postgres on
//! an interval is the honest interim substitute, close enough at current
//! scale). One pass: every account with an open position gets its
//! margin level checked; margin calls are published as events,
//! stop-outs force-close positions until the account is back above the
//! stop-out threshold or runs out of positions to close.
//!
//! "Effective balance" = Account.balance (Prisma-owned, never written
//! here) + the sum of this account's ledger_entries (Rust-owned) — see
//! db.rs's `get_ledger_sum` doc comment for why realized P&L from a
//! force-close is tracked as a ledger delta rather than a direct balance
//! write.

use crate::db;
use margin::{evaluate, MarginThresholds, MonitorAction};
use protocol::TradingEvent;
use rust_decimal::Decimal;
use sqlx::PgPool;

fn floating_pnl(side: protocol::OrderSide, open_price: Decimal, close_price: Decimal, contract_size: Decimal, volume: Decimal) -> Decimal {
    let diff = match side {
        protocol::OrderSide::Buy => close_price - open_price,
        protocol::OrderSide::Sell => open_price - close_price,
    };
    diff * contract_size * volume
}

fn close_price_for(side: protocol::OrderSide, bid: Decimal, ask: Decimal) -> Decimal {
    match side {
        protocol::OrderSide::Buy => bid,
        protocol::OrderSide::Sell => ask,
    }
}

struct AccountState {
    effective_balance: Decimal,
    credit: Decimal,
    leverage: u32,
    positions: Vec<db::OpenPositionWithMarket>,
}

fn used_margin(state: &AccountState) -> Decimal {
    state
        .positions
        .iter()
        .map(|p| risk::required_margin(p.volume, p.contract_size, p.open_price, state.leverage))
        .sum()
}

fn equity(state: &AccountState) -> Decimal {
    let floating: Decimal = state
        .positions
        .iter()
        .filter_map(|p| {
            let (bid, ask) = (p.bid?, p.ask?);
            Some(floating_pnl(p.side, p.open_price, close_price_for(p.side, bid, ask), p.contract_size, p.volume))
        })
        .sum();
    state.effective_balance + state.credit + floating
}

async fn load_account_state(pool: &PgPool, account_id: &str) -> Result<Option<AccountState>, sqlx::Error> {
    let Some(funds) = db::get_account_funds(pool, account_id).await? else {
        return Ok(None);
    };
    let ledger_sum = db::get_ledger_sum(pool, account_id).await?;
    let positions = db::get_open_positions_with_market(pool, account_id).await?;
    Ok(Some(AccountState {
        effective_balance: funds.balance + ledger_sum,
        credit: funds.credit,
        leverage: funds.leverage.max(1) as u32,
        positions,
    }))
}

/// Force-closes the account's single worst (most negative floating P&L)
/// closeable position — one with a live bid/ask, since a close price is
/// required. Returns None if no position is currently closeable (all
/// remaining open positions have no live tick — logged by the caller,
/// not silently ignored).
async fn force_close_worst(
    pool: &PgPool,
    account_id: &str,
    state: &mut AccountState,
) -> Result<Option<String>, sqlx::Error> {
    let worst = state
        .positions
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let (bid, ask) = (p.bid?, p.ask?);
            let pnl = floating_pnl(p.side, p.open_price, close_price_for(p.side, bid, ask), p.contract_size, p.volume);
            Some((i, pnl, close_price_for(p.side, bid, ask)))
        })
        .min_by(|a, b| a.1.cmp(&b.1));

    let Some((idx, pnl, close_price)) = worst else {
        return Ok(None);
    };
    let position = state.positions.remove(idx);

    let mut tx = pool.begin().await?;
    db::close_position_with_ledger_entry(&mut tx, &position.id, account_id, close_price, pnl).await?;
    tx.commit().await?;

    state.effective_balance += pnl;
    Ok(Some(position.id))
}

async fn evaluate_account(
    pool: &PgPool,
    nats: &async_nats::Client,
    account_id: &str,
    thresholds: MarginThresholds,
) -> Result<(), sqlx::Error> {
    let Some(mut state) = load_account_state(pool, account_id).await? else {
        return Ok(());
    };
    if state.positions.is_empty() {
        return Ok(());
    }

    let mut closed_ids = Vec::new();
    // Bounded by the account's own position count — each iteration closes
    // exactly one position, so this can't loop longer than that.
    let max_iterations = state.positions.len();
    for _ in 0..max_iterations {
        let action = evaluate(equity(&state), used_margin(&state), thresholds);
        match action {
            MonitorAction::Ok => break,
            MonitorAction::MarginCall => {
                let level = risk::margin_level(equity(&state), used_margin(&state)).unwrap_or(Decimal::ZERO);
                publish_best_effort(
                    nats,
                    &TradingEvent::MarginCall { account_id: account_id.to_string(), margin_level: level },
                )
                .await;
                break;
            }
            MonitorAction::StopOut => match force_close_worst(pool, account_id, &mut state).await? {
                Some(closed_id) => closed_ids.push(closed_id),
                None => {
                    tracing::warn!(account_id, "stop-out triggered but no closeable position has a live price");
                    break;
                }
            },
        }
    }

    if !closed_ids.is_empty() {
        publish_best_effort(
            nats,
            &TradingEvent::StopOut { account_id: account_id.to_string(), closed_position_ids: closed_ids },
        )
        .await;
    }

    Ok(())
}

async fn publish_best_effort(nats: &async_nats::Client, event: &TradingEvent) {
    if let Err(err) = crate::events::publish(nats, event).await {
        tracing::warn!(?err, "failed to publish margin event to NATS");
    }
}

/// One full pass over every account with an open position. Errors for one
/// account are logged and don't stop the rest — a bug in one account's
/// data shouldn't leave every other account unmonitored.
pub async fn run_once(pool: &PgPool, nats: &async_nats::Client, thresholds: MarginThresholds) {
    let account_ids = match db::get_account_ids_with_open_positions(pool).await {
        Ok(ids) => ids,
        Err(err) => {
            tracing::error!(?err, "margin monitor: failed to list accounts with open positions");
            return;
        }
    };

    for account_id in account_ids {
        if let Err(err) = evaluate_account(pool, nats, &account_id, thresholds).await {
            tracing::error!(?err, account_id, "margin monitor: failed to evaluate account");
        }
    }
}

/// Spawns the polling loop as a background task. `interval` should be
/// short enough that a fast-moving price doesn't blow through stop-out
/// unnoticed for long, but this is a placeholder cadence (see the module
/// doc comment) until a real tick-driven trigger exists.
pub fn spawn(pool: PgPool, nats: async_nats::Client, thresholds: MarginThresholds, interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            run_once(&pool, &nats, thresholds).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::OrderSide;
    use rust_decimal_macros::dec;

    #[test]
    fn floating_pnl_matches_lib_trading_ts_formula() {
        // Mirrors lib/trading.ts's computeRealizedPnl exactly — same
        // BUY/SELL diff direction, same contractSize*volume multiplier.
        let buy_profit = floating_pnl(OrderSide::Buy, dec!(1.10000), dec!(1.10050), dec!(100000), dec!(1));
        assert_eq!(buy_profit, dec!(50.00000));

        let sell_profit = floating_pnl(OrderSide::Sell, dec!(1.10000), dec!(1.09950), dec!(100000), dec!(1));
        assert_eq!(sell_profit, dec!(50.00000));

        let buy_loss = floating_pnl(OrderSide::Buy, dec!(1.10000), dec!(1.09950), dec!(100000), dec!(1));
        assert_eq!(buy_loss, dec!(-50.00000));
    }

    #[test]
    fn close_price_is_bid_for_buy_ask_for_sell() {
        assert_eq!(close_price_for(OrderSide::Buy, dec!(1.10000), dec!(1.10020)), dec!(1.10000));
        assert_eq!(close_price_for(OrderSide::Sell, dec!(1.10000), dec!(1.10020)), dec!(1.10020));
    }
}
