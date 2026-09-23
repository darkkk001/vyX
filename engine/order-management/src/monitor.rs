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
//! Book (Rust cutover Stage 1, 2026-09-23): the monitor reads and closes on
//! the REAL Prisma book through book.rs (`"Position"` / `"Account"` /
//! `"Transaction"`), writing a close exactly like the web's
//! closePositionInTx (guard, row lock, negative-balance protection,
//! Account.balance + TRADE_PNL). It used to read the engine's own empty
//! `positions` table and book realized P&L as a `ledger_entries` delta on
//! top of an Account.balance it never wrote.

use crate::book;
use crate::calc::{close_price_for, equity, floating_pnl, load_book_state, used_margin, AccountState};
use crate::db;
use margin::{evaluate, MonitorAction};
use protocol::TradingEvent;
use rust_decimal::Decimal;
use std::sync::Arc;
use tokio::sync::Mutex;
use sqlx::PgPool;

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
    nats: Option<&async_nats::Client>,
    account_id: &str,
    state: &mut AccountState,
) -> Result<Vec<(String, &'static str)>, sqlx::Error> {
    let mut closed = Vec::new();
    let triggered: Vec<(String, SlTpReason, Decimal, Decimal)> = state
        .positions
        .iter()
        .filter_map(|p| {
            let reason = sl_tp_trigger(p)?;
            let (bid, ask) = (p.bid?, p.ask?);
            let close_price = close_price_for(p.side, bid, ask);
            // booked exactly as the web books it: quote P&L x rate, 4 dp when converted (fx.rs convert_pnl)
            let pnl = crate::fx::convert_pnl(floating_pnl(p.side, p.open_price, close_price, p.contract_size, p.volume), p.fx_rate);
            Some((p.id.clone(), reason, close_price, pnl))
        })
        .collect();

    // Stage 2 F5: closed in the book's own order (oldest first, book.rs ORDER BY "openedAt", id), the same
    // order lib/risk-monitor.ts uses. Several SL/TP closes in one pass interact through negative-balance
    // protection and credit, so the order can change the final balance; this used to walk the list backwards.
    // Positions are taken out by id, so an earlier removal cannot shift a later one.
    for (id, reason, close_price, pnl) in triggered {
        let Some(pos_idx) = state.positions.iter().position(|p| p.id == id) else { continue };
        let position = state.positions.remove(pos_idx);

        let note = match reason {
            SlTpReason::StopLoss => "Stop loss hit (automatic)",
            SlTpReason::TakeProfit => "Take profit hit (automatic)",
        };
        let mut tx = pool.begin().await?;
        let closed_now = book::close_position_in_tx(&mut tx, &position.id, position.volume, close_price, pnl, note).await?;
        if let Some(outcome) = &closed_now {
            // Stage 3: the web's post-close follow-up, queued in the close's own transaction
            let why = match reason {
                SlTpReason::StopLoss => book::CloseReason::StopLoss,
                SlTpReason::TakeProfit => book::CloseReason::TakeProfit,
            };
            book::enqueue_post_close(&mut tx, &position.id, outcome, why, position.volume, close_price).await?;
        }
        tx.commit().await?;

        let Some(outcome) = closed_now else {
            continue; // already closed by a concurrent pass — nothing to credit or publish
        };
        crate::outbox::wake();
        state.effective_balance = outcome.final_balance; // after any credit use and negative-balance floor
        state.credit = outcome.final_credit;
        closed.push((position.id.clone(), match reason {
            SlTpReason::StopLoss => "stop_loss",
            SlTpReason::TakeProfit => "take_profit",
        }));

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

    Ok(closed)
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
    state: &mut AccountState,
    note: &str,
    reason: book::CloseReason,
) -> Result<CloseAttempt, sqlx::Error> {
    let worst = state
        .positions
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let (bid, ask) = (p.bid?, p.ask?);
            // the worst is chosen in the ACCOUNT currency (a JPY loss and a USD loss compare as money)
            Some((i, crate::calc::floating_pnl_account(p)?, close_price_for(p.side, bid, ask)))
        })
        .min_by(|a, b| a.1.cmp(&b.1));

    let Some((idx, _, close_price)) = worst else {
        return Ok(CloseAttempt::NoCloseablePosition);
    };
    let position = state.positions.remove(idx);
    let pnl = crate::fx::convert_pnl(
        floating_pnl(position.side, position.open_price, close_price, position.contract_size, position.volume),
        position.fx_rate,
    );

    let mut tx = pool.begin().await?;
    let closed = book::close_position_in_tx(&mut tx, &position.id, position.volume, close_price, pnl, note).await?;
    if let Some(outcome) = &closed {
        // Stage 3: the web's post-close follow-up (incl. the stop-out notice), queued in the close's own transaction
        book::enqueue_post_close(&mut tx, &position.id, outcome, reason, position.volume, close_price).await?;
    }
    tx.commit().await?;

    let Some(outcome) = closed else {
        return Ok(CloseAttempt::AlreadyClosedConcurrently);
    };
    crate::outbox::wake();

    state.effective_balance = outcome.final_balance; // after any credit use and negative-balance floor
    state.credit = outcome.final_credit;
    Ok(CloseAttempt::Closed(position.id))
}

/// What one evaluation decided and did -- returned so a caller that is not NATS (the parity harness,
/// Stage 5's shadow comparison) can see the decision, not just the rows it left behind.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EvalReport {
    /// equity / used margin x 100 when the pass started, before any close (None = no used margin)
    pub margin_level_before: Option<Decimal>,
    /// every position this pass closed, in order, with "stop_loss" / "take_profit" / "stop_out"
    pub closed: Vec<(String, &'static str)>,
    /// the pass ended in margin call (not stop-out)
    pub margin_call: bool,
    /// Stage 4.5: not evaluated in this pass -- a pending post-close follow-up (a mirror close, a coverage leg
    /// close) will close one of its positions first; the next pass evaluates it, as the web does after it
    pub deferred: bool,
}

/// One account, one pass. `None` = not evaluated (no account / no open position / its group's thresholds
/// not loaded). `nats` is optional so the same code runs without a broker for the harness and shadow mode.
pub async fn evaluate_account(
    pool: &PgPool,
    nats: Option<&async_nats::Client>,
    account_id: &str,
) -> Result<Option<EvalReport>, sqlx::Error> {
    // Stage 4.5 BEHAVIOR CHANGE (engine): the web runs mirror / coverage follow-ups inside its pass, right after the
    // close that triggers them, so an account holding a mirror target or an auto-hedged leg is evaluated only AFTER
    // that position was closed for it. The engine queues those follow-ups (outbox); until one has run, the account
    // it touches waits for the next pass instead of stopping out a position the follow-up is about to close.
    if book::pending_follow_up_owns(pool, account_id).await? {
        return Ok(Some(EvalReport { deferred: true, ..EvalReport::default() }));
    }
    let Some(mut state) = load_book_state(pool, account_id).await? else {
        return Ok(None);
    };
    if state.positions.is_empty() {
        return Ok(None);
    }
    let mut report = EvalReport {
        margin_level_before: risk::margin_level(equity(&state), used_margin(&state)),
        ..EvalReport::default()
    };

    // Risk item 2: resolve THIS account's own real thresholds -- its
    // group's broker-configured marginCallLevel/stopOutLevel, or the
    // documented ungrouped-account default. A group referenced by this
    // account but missing from `by_group` (a stale/partial load) skips
    // evaluation entirely rather than falling back to a guess -- the
    // account is picked up again on the next pass once the load
    // succeeds, rather than evaluated once against the wrong number.
    // Stage 2 F3: the account's own Group, read now from the same database (defaults 100 / 50 without one).
    // Replaces the per-pass cached map, which skipped an account whose group was "not loaded yet".
    let Some(thresholds) = book::account_thresholds(pool, account_id).await? else {
        return Ok(None);
    };

    // SL/TP resolves first: it's the trader's own chosen exit, independent
    // of margin level, and closing these here means the margin/stop-out
    // loop below only ever considers positions that are still actually
    // open.
    report.closed = close_sl_tp_triggered(pool, nats, account_id, &mut state).await?;

    let mut closed_ids = Vec::new();
    // Bounded by the account's own position count — each iteration closes
    // exactly one position, so this can't loop longer than that (0 when SL/TP closed everything).
    let max_iterations = state.positions.len();
    for _ in 0..max_iterations {
        let action = evaluate(equity(&state), used_margin(&state), thresholds);
        match action {
            MonitorAction::Ok => break,
            MonitorAction::MarginCall => {
                report.margin_call = true;
                // evaluate() only returns MarginCall for a real level; a null level is never an action
                let Some(level) = risk::margin_level(equity(&state), used_margin(&state)) else { break };
                publish_best_effort(
                    nats,
                    &TradingEvent::MarginCall { account_id: account_id.to_string(), margin_level: level },
                )
                .await;
                break;
            }
            MonitorAction::StopOut => {
                // the web's note text exactly (lib/risk-monitor.ts), so both paths leave identical Transaction rows
                let Some(level) = risk::margin_level(equity(&state), used_margin(&state)) else { break };
                let note = format!(
                    "Stop-out (automatic): margin level {}% at or below {}%",
                    book::fixed2(level),
                    thresholds.stop_out_level.normalize()
                );
                let reason = book::CloseReason::StopOut { margin_level: level, stop_out_level: thresholds.stop_out_level };
                match force_close_worst(pool, &mut state, &note, reason).await? {
                    CloseAttempt::Closed(closed_id) => {
                        report.closed.push((closed_id.clone(), "stop_out"));
                        closed_ids.push(closed_id);
                    }
                    CloseAttempt::AlreadyClosedConcurrently => continue,
                    CloseAttempt::NoCloseablePosition => {
                        tracing::warn!(account_id, "stop-out triggered but no closeable position has a live price");
                        break;
                    }
                }
            }
        }
    }

    if !closed_ids.is_empty() {
        publish_best_effort(
            nats,
            &TradingEvent::StopOut { account_id: account_id.to_string(), closed_position_ids: closed_ids },
        )
        .await;
    }

    // Stage 3: the standing margin-call notice, lib/risk-monitor.ts pass 3 -- measured on what is still open after
    // this pass, edge-triggered on "Account"."marginCallNotifiedAt" (one notice per episode). An account left with
    // open positions but no usable price has no level: nothing changes, as on the web.
    let edge = if state.positions.is_empty() {
        Some(book::MarginCallEdge::Out)
    } else {
        risk::margin_level(equity(&state), used_margin(&state)).map(|level| {
            if level <= thresholds.call_level {
                book::MarginCallEdge::In { margin_level: level, call_level: thresholds.call_level }
            } else {
                book::MarginCallEdge::Out
            }
        })
    };
    if let Some(edge) = edge {
        if book::apply_margin_call_edge(pool, account_id, edge).await? {
            crate::outbox::wake();
        }
    }

    Ok(Some(report))
}

async fn publish_best_effort(nats: Option<&async_nats::Client>, event: &TradingEvent) {
    let Some(nats) = nats else { return };
    if let Err(err) = crate::events::publish(nats, event).await {
        tracing::warn!(?err, "failed to publish margin event to NATS");
    }
}

/// One full pass over every account with an open position. Errors for one
/// account are logged and don't stop the rest — a bug in one account's
/// data shouldn't leave every other account unmonitored.
pub async fn run_once(pool: &PgPool, nats: &async_nats::Client) {
    let account_ids = match book::account_ids_with_open_positions(pool).await {
        Ok(ids) => ids,
        Err(err) => {
            tracing::error!(?err, "margin monitor: failed to list accounts with open positions");
            return;
        }
    };

    // thresholds are read per account inside evaluate_account (Stage 2 F3), not cached per pass
    for account_id in account_ids {
        if let Err(err) = evaluate_account(pool, Some(nats), &account_id).await {
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
pub async fn run_once_guarded(pool: &PgPool, nats: &async_nats::Client, guard: &RunGuard) {
    let Ok(_permit) = guard.try_lock() else {
        return;
    };
    run_once(pool, nats).await;
}

/// Spawns the polling-timer trigger as a background task — the safety
/// net described in the module doc comment, not the primary trigger path
/// once a tick-driven subscription is also running alongside it.
pub fn spawn(pool: PgPool, nats: async_nats::Client, interval: std::time::Duration, guard: RunGuard) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            run_once_guarded(&pool, &nats, &guard).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::OrderSide;
    use rust_decimal_macros::dec;

    // floating_pnl/close_price_for's own tests now live in calc.rs, where
    // those functions moved to.

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
            fx_rate: Decimal::ONE,
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
