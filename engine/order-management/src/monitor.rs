//! Margin monitor — see ../../docs/risk-engine.md §2.2. One pass: every
//! account with an open position gets its margin level checked; margin
//! calls are published as events, stop-outs force-close positions until
//! the account is back above the stop-out threshold or runs out of
//! positions to close.
//!
//! Triggered two ways, both funneled through `run_once_guarded` so they
//! never run concurrently (see that function's doc, and db.rs's
//! `close_position_with_ledger_entry` idempotency note for why an
//! overlapping pass is safe even if the guard is ever bypassed):
//! - `spawn`'s polling timer — a safety net for quiet periods (no ticks
//!   arriving, e.g. the feed/EA is down), same role the client-side poll
//!   plays alongside WebTrader.tsx's price WebSocket.
//! - `engine/server`'s NATS subscription to `price.tick.*` (the Market
//!   Data Core stream, see ../../docs/market-data.md §2) — the primary
//!   path now that a live tick stream exists; a real price move triggers
//!   an evaluation immediately instead of waiting for the next poll.
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
use std::sync::Arc;
use tokio::sync::Mutex;
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

enum CloseAttempt {
    Closed(String),
    /// No remaining open position has a live bid/ask, so none is
    /// closeable — genuinely stuck, the caller should stop and warn.
    NoCloseablePosition,
    /// The worst position was already closed by a concurrent evaluation
    /// pass (see db.rs's idempotency note) between this pass loading
    /// account state and reaching this UPDATE — a benign race, not a
    /// stuck state. `state.positions` already had it removed, so the
    /// caller should just retry with the next-worst position.
    AlreadyClosedConcurrently,
}

/// Force-closes the account's single worst (most negative floating P&L)
/// closeable position — one with a live bid/ask, since a close price is
/// required.
async fn force_close_worst(
    pool: &PgPool,
    account_id: &str,
    state: &mut AccountState,
) -> Result<CloseAttempt, sqlx::Error> {
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
        return Ok(CloseAttempt::NoCloseablePosition);
    };
    let position = state.positions.remove(idx);

    let mut tx = pool.begin().await?;
    let closed =
        db::close_position_with_ledger_entry(&mut tx, &position.id, account_id, close_price, pnl).await?;
    tx.commit().await?;

    let Some(_entry_id) = closed else {
        return Ok(CloseAttempt::AlreadyClosedConcurrently);
    };

    state.effective_balance += pnl;
    Ok(CloseAttempt::Closed(position.id))
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
                CloseAttempt::Closed(closed_id) => closed_ids.push(closed_id),
                CloseAttempt::AlreadyClosedConcurrently => continue,
                CloseAttempt::NoCloseablePosition => {
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

/// Shared across every trigger source (the polling timer and, in
/// `engine/server`, the NATS tick subscription) so at most one
/// evaluation pass runs at a time — see the module doc comment. A plain
/// `Mutex<()>` used only via `try_lock`: this is a coalescing/skip guard,
/// not a queue, so a burst of ticks while a pass is already running just
/// gets dropped rather than piling up (the in-flight pass, or the next
/// trigger after it finishes, covers the account either way).
pub type RunGuard = Arc<Mutex<()>>;

pub fn new_run_guard() -> RunGuard {
    Arc::new(Mutex::new(()))
}

/// Runs one evaluation pass if no other pass is currently running via
/// this guard; otherwise a no-op. Correctness doesn't depend on this
/// guard (`close_position_with_ledger_entry` is idempotent under real
/// concurrency — see db.rs), it's purely to avoid wasted overlapping
/// full-account-table scans when ticks arrive faster than a pass
/// completes.
pub async fn run_once_guarded(pool: &PgPool, nats: &async_nats::Client, thresholds: MarginThresholds, guard: &RunGuard) {
    let Ok(_permit) = guard.try_lock() else {
        return;
    };
    run_once(pool, nats, thresholds).await;
}

/// Spawns the polling-timer trigger as a background task — the safety
/// net described in the module doc comment, not the primary trigger path
/// once a tick-driven subscription is also running alongside it.
pub fn spawn(pool: PgPool, nats: async_nats::Client, thresholds: MarginThresholds, interval: std::time::Duration, guard: RunGuard) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            run_once_guarded(&pool, &nats, thresholds, &guard).await;
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
