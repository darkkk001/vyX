//! Margin monitor — see ../../docs/risk-engine.md §2.2. One pass, per
//! account with an open position: first, every position whose own SL/TP
//! has been crossed closes (independent of margin — a trader's stop loss
//! protects them even nowhere near a margin call); then the account's
//! margin level is checked on whatever positions remain — margin calls
//! are published as events, stop-outs force-close positions until the
//! account is back above the stop-out threshold or runs out of positions
//! to close.
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

enum SlTpReason {
    StopLoss,
    TakeProfit,
}

/// Whether a position's own SL/TP has been crossed by the current
/// market, independent of the account's margin level — a trader's stop
/// loss protects them even while their account is nowhere near a margin
/// call. Uses the same close-price convention as everything else here
/// (bid for a BUY, ask for a SELL — the price closing it *now* would
/// actually fill at). SL is checked before TP so a position that somehow
/// gapped through both in one tick reports the more conservative reason;
/// in practice only one can be true for a given side's price levels
/// (SL below/at TP for a BUY, above/at TP for a SELL — enforced at order
/// time by lib/trading.ts's `validateSlTp`, mirrored server-side there,
/// not re-validated here).
fn sl_tp_trigger(p: &db::OpenPositionWithMarket) -> Option<SlTpReason> {
    let (bid, ask) = (p.bid?, p.ask?);
    let close_price = close_price_for(p.side, bid, ask);
    let crossed = |level: Decimal, is_below_trigger: bool| {
        if is_below_trigger { close_price <= level } else { close_price >= level }
    };
    match p.side {
        protocol::OrderSide::Buy => {
            if p.sl_price.is_some_and(|sl| crossed(sl, true)) {
                return Some(SlTpReason::StopLoss);
            }
            if p.tp_price.is_some_and(|tp| crossed(tp, false)) {
                return Some(SlTpReason::TakeProfit);
            }
        }
        protocol::OrderSide::Sell => {
            if p.sl_price.is_some_and(|sl| crossed(sl, false)) {
                return Some(SlTpReason::StopLoss);
            }
            if p.tp_price.is_some_and(|tp| crossed(tp, true)) {
                return Some(SlTpReason::TakeProfit);
            }
        }
    }
    None
}

/// Closes every position in `state` whose SL/TP has been crossed —
/// unlike `force_close_worst` (stop-out), this isn't "pick the single
/// worst one," every triggered position closes in this pass, since each
/// is an independent trader-chosen exit level, not a margin-driven
/// rescue. Uses the same idempotent `close_position_with_ledger_entry`
/// as stop-out, so a race against another concurrent pass (or a manual
/// close arriving at the same moment) is a silent no-op, not a double
/// close — see db.rs's idempotency note.
async fn close_sl_tp_triggered(
    pool: &PgPool,
    nats: &async_nats::Client,
    account_id: &str,
    state: &mut AccountState,
) -> Result<(), sqlx::Error> {
    let triggered: Vec<(usize, SlTpReason, Decimal, Decimal)> = state
        .positions
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let reason = sl_tp_trigger(p)?;
            let (bid, ask) = (p.bid?, p.ask?);
            let close_price = close_price_for(p.side, bid, ask);
            let pnl = floating_pnl(p.side, p.open_price, close_price, p.contract_size, p.volume);
            Some((i, reason, close_price, pnl))
        })
        .collect();

    // Remove highest-index-first so earlier indices in `triggered` stay
    // valid as we go.
    for (idx, reason, close_price, pnl) in triggered.into_iter().rev() {
        let position = state.positions.remove(idx);

        let mut tx = pool.begin().await?;
        let closed =
            db::close_position_with_ledger_entry(&mut tx, &position.id, account_id, close_price, pnl).await?;
        tx.commit().await?;

        let Some(_entry_id) = closed else {
            continue; // already closed by a concurrent pass — nothing to credit or publish
        };
        state.effective_balance += pnl;

        let event = match reason {
            SlTpReason::StopLoss => {
                TradingEvent::StopLossHit { account_id: account_id.to_string(), position_id: position.id }
            }
            SlTpReason::TakeProfit => {
                TradingEvent::TakeProfitHit { account_id: account_id.to_string(), position_id: position.id }
            }
        };
        publish_best_effort(nats, &event).await;
    }

    Ok(())
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

    // SL/TP resolves first: it's the trader's own chosen exit, independent
    // of margin level, and closing these here means the margin/stop-out
    // loop below only ever considers positions that are still actually
    // open.
    close_sl_tp_triggered(pool, nats, account_id, &mut state).await?;
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

    fn position(
        side: OrderSide,
        bid: Decimal,
        ask: Decimal,
        sl_price: Option<Decimal>,
        tp_price: Option<Decimal>,
    ) -> db::OpenPositionWithMarket {
        db::OpenPositionWithMarket {
            id: "pos1".into(),
            symbol: "EURUSD".into(),
            side,
            volume: dec!(1),
            open_price: dec!(1.10000),
            contract_size: dec!(100000),
            bid: Some(bid),
            ask: Some(ask),
            sl_price,
            tp_price,
        }
    }

    #[test]
    fn buy_sl_triggers_when_bid_drops_to_or_below_it() {
        let p = position(OrderSide::Buy, dec!(1.09000), dec!(1.09020), Some(dec!(1.09000)), Some(dec!(1.12000)));
        assert!(matches!(sl_tp_trigger(&p), Some(SlTpReason::StopLoss)));

        let above_sl = position(OrderSide::Buy, dec!(1.09500), dec!(1.09520), Some(dec!(1.09000)), Some(dec!(1.12000)));
        assert!(sl_tp_trigger(&above_sl).is_none());
    }

    #[test]
    fn buy_tp_triggers_when_bid_rises_to_or_above_it() {
        let p = position(OrderSide::Buy, dec!(1.12000), dec!(1.12020), Some(dec!(1.09000)), Some(dec!(1.12000)));
        assert!(matches!(sl_tp_trigger(&p), Some(SlTpReason::TakeProfit)));
    }

    #[test]
    fn sell_sl_triggers_when_ask_rises_to_or_above_it() {
        let p = position(OrderSide::Sell, dec!(1.10980), dec!(1.11000), Some(dec!(1.11000)), Some(dec!(1.08000)));
        assert!(matches!(sl_tp_trigger(&p), Some(SlTpReason::StopLoss)));
    }

    #[test]
    fn sell_tp_triggers_when_ask_drops_to_or_below_it() {
        let p = position(OrderSide::Sell, dec!(1.07980), dec!(1.08000), Some(dec!(1.11000)), Some(dec!(1.08000)));
        assert!(matches!(sl_tp_trigger(&p), Some(SlTpReason::TakeProfit)));
    }

    #[test]
    fn no_sl_or_tp_set_never_triggers() {
        let p = position(OrderSide::Buy, dec!(0.50000), dec!(0.50020), None, None);
        assert!(sl_tp_trigger(&p).is_none());
    }

    #[test]
    fn no_live_price_never_triggers() {
        let mut p = position(OrderSide::Buy, dec!(1.09000), dec!(1.09020), Some(dec!(1.09000)), None);
        p.bid = None;
        p.ask = None;
        assert!(sl_tp_trigger(&p).is_none());
    }
}
