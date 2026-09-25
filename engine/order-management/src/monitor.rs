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
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use sqlx::PgPool;

/// Rust cutover Stage 5: how a pass acts on its decisions. `Live` closes, queues follow-ups, writes the margin-call
/// edge and publishes (cutover behaviour, unchanged). `Shadow` takes the SAME decisions but acts on nothing: a
/// close is applied in memory with book::close_money (the real close's own money rules), the rest of the
/// evaluation sees that simulated account, and the decision is recorded (shadow.rs). No book write, no
/// PostCloseEffect, no margin-call edge write, no NATS event.
#[derive(Clone, Default)]
pub enum Mode {
    #[default]
    Live,
    Shadow(Arc<crate::shadow::Recorder>),
}

impl Mode {
    fn is_shadow(&self) -> bool {
        matches!(self, Mode::Shadow(_))
    }
}

/// Shadow only: what this evaluation has closed in simulation, and the simulated funds. Applied to every re-read
/// of the account, which the database (untouched in shadow) would otherwise still show as before the close.
#[derive(Default)]
struct Overlay {
    closed: HashSet<String>,
    funds: Option<(Decimal, Decimal)>,
}

/// load_book_state, plus the shadow overlay (Live: the database as it is).
async fn load(pool: &PgPool, account_id: &str, mode: &Mode, ov: &Overlay) -> Result<Option<AccountState>, sqlx::Error> {
    let state = load_book_state(pool, account_id).await?;
    if !mode.is_shadow() {
        return Ok(state);
    }
    Ok(state.map(|mut st| {
        st.positions.retain(|p| !ov.closed.contains(&p.id));
        if let Some((balance, credit)) = ov.funds {
            st.effective_balance = balance;
            st.credit = credit;
        }
        st
    }))
}

/// symbol -> [bid, ask] of the positions' usable prices (the shadow record's snapshot)
fn price_snapshot(state: &AccountState) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    for p in &state.positions {
        if let (Some(b), Some(a)) = (p.bid, p.ask) {
            m.insert(p.symbol.clone(), serde_json::json!([b.to_string(), a.to_string()]));
        }
    }
    serde_json::Value::Object(m)
}

/// The funds after closing `position` at `close_price` with `pnl`: Live writes the close (and queues its follow-up)
/// in one transaction; Shadow simulates it and records the decision. None = the position was already closed by a
/// concurrent pass (Live only). Returns (final balance, final credit).
#[allow(clippy::too_many_arguments)]
async fn apply_close(
    pool: &PgPool,
    mode: &Mode,
    ov: &mut Overlay,
    state: &AccountState,
    account_id: &str,
    position: &db::OpenPositionWithMarket,
    close_price: Decimal,
    pnl: Decimal,
    note: &str,
    reason: book::CloseReason,
    level_before: Option<Decimal>,
) -> Result<Option<(Decimal, Decimal)>, sqlx::Error> {
    match mode {
        Mode::Live => {
            let mut tx = pool.begin().await?;
            let closed = book::close_position_in_tx(&mut tx, &position.id, position.volume, close_price, pnl, note).await?;
            if let Some(outcome) = &closed {
                // Stage 3: the web's post-close follow-up, queued in the close's own transaction
                book::enqueue_post_close(&mut tx, &position.id, outcome, reason, position.volume, close_price).await?;
            }
            tx.commit().await?;
            let Some(outcome) = closed else { return Ok(None) };
            crate::outbox::wake();
            Ok(Some((outcome.final_balance, outcome.final_credit))) // after any credit use and negative-balance floor
        }
        Mode::Shadow(recorder) => {
            // the broker's negative-balance protection is read only when it can matter, as in the real close
            let unprotected = book::close_money(state.effective_balance, state.credit, pnl, false);
            let protect = if unprotected.after_credit < Decimal::ZERO {
                let (p,): (bool,) = sqlx::query_as(
                    r#"SELECT b."negativeBalanceProtection" FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" WHERE a.id = $1"#,
                )
                .bind(account_id)
                .fetch_one(pool)
                .await?;
                p
            } else {
                false
            };
            let money = book::close_money(state.effective_balance, state.credit, pnl, protect);
            ov.closed.insert(position.id.clone());
            ov.funds = Some((money.final_balance, money.final_credit));
            let (kind, level) = match reason {
                book::CloseReason::StopLoss => (crate::shadow::Kind::StopLoss, None),
                book::CloseReason::TakeProfit => (crate::shadow::Kind::TakeProfit, None),
                book::CloseReason::StopOut { margin_level, .. } => (crate::shadow::Kind::StopOut, Some(margin_level)),
            };
            recorder
                .record(crate::shadow::Decision {
                    kind,
                    account_id: account_id.to_string(),
                    position_id: Some(position.id.clone()),
                    level_before,
                    level,
                    close_price: Some(close_price),
                    pnl: Some(pnl),
                    balance_after: Some(money.final_balance),
                    credit_after: Some(money.final_credit),
                    write_off: money.write_off,
                    prices: price_snapshot(state),
                })
                .await;
            Ok(Some((money.final_balance, money.final_credit)))
        }
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
    nats: Option<&async_nats::Client>,
    account_id: &str,
    state: &mut AccountState,
    mode: &Mode,
    ov: &mut Overlay,
    level_before: Option<Decimal>,
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
        let why = match reason {
            SlTpReason::StopLoss => book::CloseReason::StopLoss,
            SlTpReason::TakeProfit => book::CloseReason::TakeProfit,
        };
        let Some((balance, credit)) = apply_close(pool, mode, ov, state, account_id, &position, close_price, pnl, note, why, level_before).await? else {
            continue; // already closed by a concurrent pass — nothing to credit or publish
        };
        state.effective_balance = balance; // after any credit use and negative-balance floor
        state.credit = credit;
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
        if !mode.is_shadow() {
            publish_best_effort(nats, &event).await;
        }
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
#[allow(clippy::too_many_arguments)]
async fn force_close_worst(
    pool: &PgPool,
    state: &mut AccountState,
    note: &str,
    reason: book::CloseReason,
    mode: &Mode,
    ov: &mut Overlay,
    account_id: &str,
    level_before: Option<Decimal>,
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
    let pnl = crate::fx::convert_pnl(
        floating_pnl(state.positions[idx].side, state.positions[idx].open_price, close_price, state.positions[idx].contract_size, state.positions[idx].volume),
        state.positions[idx].fx_rate,
    );
    // the snapshot / funds are taken with the position still in the book (shadow records what it was decided on)
    let applied = apply_close(pool, mode, ov, state, account_id, &state.positions[idx].clone(), close_price, pnl, note, reason, level_before).await?;
    let position = state.positions.remove(idx);

    let Some((balance, credit)) = applied else {
        return Ok(CloseAttempt::AlreadyClosedConcurrently);
    };
    state.effective_balance = balance; // after any credit use and negative-balance floor
    state.credit = credit;
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
    evaluate_account_checked(pool, nats, account_id, true, &Mode::Live).await
}

/// One account in a given mode (Stage 5: the shadow harness gate evaluates single accounts in `Mode::Shadow`).
pub async fn evaluate_account_mode(
    pool: &PgPool,
    nats: Option<&async_nats::Client>,
    account_id: &str,
    mode: &Mode,
) -> Result<Option<EvalReport>, sqlx::Error> {
    evaluate_account_checked(pool, nats, account_id, !mode.is_shadow(), mode).await
}

/// `check_deferral` false = the caller knows no follow-up can be pending (run_pass's precheck): skip the query.
async fn evaluate_account_checked(
    pool: &PgPool,
    nats: Option<&async_nats::Client>,
    account_id: &str,
    check_deferral: bool,
    mode: &Mode,
) -> Result<Option<EvalReport>, sqlx::Error> {
    // shadow queues nothing, so nothing is ever pending for it: the web runs mirror / coverage inline and the
    // shadow sees their results on its next read
    let check_deferral = check_deferral && !mode.is_shadow();
    let mut ov = Overlay::default();
    // Stage 4.5 BEHAVIOR CHANGE (engine): the web runs mirror / coverage follow-ups inside its pass, right after the
    // close that triggers them, so an account holding a mirror target or an auto-hedged leg is evaluated only AFTER
    // that position was closed for it. The engine queues those follow-ups (outbox); until one has run, the account
    // it touches waits for the next pass instead of stopping out a position the follow-up is about to close.
    let owed = if check_deferral { book::pending_follow_up_state(pool, account_id).await? } else { book::FollowUpOwed::No };
    match owed {
        book::FollowUpOwed::Yes => return Ok(Some(EvalReport { deferred: true, ..EvalReport::default() })),
        book::FollowUpOwed::Expired => {
            book::SAFETY_RELEASES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            tracing::warn!(account_id, "post-close follow-up older than the deferral window still pending: evaluating anyway (outbox stuck?)");
        }
        book::FollowUpOwed::No => {}
    }
    let Some(mut state) = load(pool, account_id, mode, &ov).await? else {
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
    if let Mode::Shadow(recorder) = mode {
        // the reconciler's SNAPSHOT evidence: where this account stood on every shadow pass
        recorder.sample(account_id, report.margin_level_before, thresholds.stop_out_level, thresholds.call_level);
    }

    // SL/TP resolves first: it's the trader's own chosen exit, independent
    // of margin level, and closing these here means the margin/stop-out
    // loop below only ever considers positions that are still actually
    // open.
    let before_sl_tp = state.positions.len();
    let level_before = report.margin_level_before;
    report.closed = close_sl_tp_triggered(pool, nats, account_id, &mut state, mode, &mut ov, level_before).await?;

    // Stage 4 BEHAVIOR CHANGE (engine): after ANY close attempt (ours, or one a concurrent pass got to first) the
    // account and its positions are read again from the database before the next decision, exactly as
    // lib/risk-monitor.ts re-reads them on every stop-out iteration. The in-memory state used to be patched instead,
    // which goes wrong when another pass closed a position of this account meanwhile: its realized P&L (and any
    // credit use or negative-balance write-off) is in the balance, not in our copy -- the load harness caught a
    // profitable position being stopped out on that stale, too-low equity.
    let mut dirty = state.positions.len() != before_sl_tp;
    let mut closed_ids = Vec::new();
    // Bounded by the account's own position count — each iteration closes
    // exactly one position, so this can't loop longer than that (0 when SL/TP closed everything).
    let max_iterations = state.positions.len();
    for _ in 0..max_iterations {
        if dirty {
            match load(pool, account_id, mode, &ov).await? {
                Some(fresh) => state = fresh,
                None => break,
            }
            dirty = false;
            if state.positions.is_empty() {
                break;
            }
        }
        let action = evaluate(equity(&state), used_margin(&state), thresholds);
        match action {
            MonitorAction::Ok => break,
            MonitorAction::MarginCall => {
                report.margin_call = true;
                // evaluate() only returns MarginCall for a real level; a null level is never an action
                let Some(level) = risk::margin_level(equity(&state), used_margin(&state)) else { break };
                if !mode.is_shadow() {
                    publish_best_effort(
                        nats,
                        &TradingEvent::MarginCall { account_id: account_id.to_string(), margin_level: level },
                    )
                    .await;
                }
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
                match force_close_worst(pool, &mut state, &note, reason, mode, &mut ov, account_id, level_before).await? {
                    CloseAttempt::Closed(closed_id) => {
                        report.closed.push((closed_id.clone(), "stop_out"));
                        closed_ids.push(closed_id);
                        dirty = true;
                    }
                    CloseAttempt::AlreadyClosedConcurrently => {
                        dirty = true;
                        continue;
                    }
                    CloseAttempt::NoCloseablePosition => {
                        tracing::warn!(account_id, "stop-out triggered but no closeable position has a live price");
                        break;
                    }
                }
            }
        }
    }

    if !closed_ids.is_empty() && !mode.is_shadow() {
        publish_best_effort(
            nats,
            &TradingEvent::StopOut { account_id: account_id.to_string(), closed_position_ids: closed_ids },
        )
        .await;
    }

    // Stage 3: the standing margin-call notice, lib/risk-monitor.ts pass 3 -- measured on what is still open after
    // this pass, edge-triggered on "Account"."marginCallNotifiedAt" (one notice per episode). An account left with
    // open positions but no usable price has no level: nothing changes, as on the web. Re-read after any close, as
    // the web's pass 3 does.
    if dirty {
        if let Some(fresh) = load(pool, account_id, mode, &ov).await? {
            state = fresh;
        }
    }
    // Only a TRANSITION of the edge writes anything, and a transition is decided on a fresh read: a concurrent pass
    // may have changed this account since our copy was taken, and clearing the edge on stale numbers would make the
    // next pass notify the same episode twice (caught by the load harness with 2 walkers). Steady state costs one
    // cheap read of the column instead of an UPDATE per account per pass.
    let notified = book::margin_call_notified(pool, account_id).await?;
    let mut edge = margin_call_edge(&state, thresholds);
    let transition = |e: Option<book::MarginCallEdge>| match e {
        Some(book::MarginCallEdge::In { .. }) => !notified,
        Some(book::MarginCallEdge::Out) => notified,
        None => false,
    };
    if let Mode::Shadow(recorder) = mode {
        // shadow: its OWN edge per account (the web's flag moves with the web's decisions, not ours); recorded on
        // change only, nothing written to the book
        if let Some(e) = edge {
            let (kind, level) = match e {
                book::MarginCallEdge::In { margin_level, .. } => (crate::shadow::Kind::MarginCallIn, Some(margin_level)),
                book::MarginCallEdge::Out => (crate::shadow::Kind::MarginCallOut, risk::margin_level(equity(&state), used_margin(&state))),
            };
            recorder
                .record_edge(crate::shadow::Decision {
                    kind,
                    account_id: account_id.to_string(),
                    position_id: None,
                    level_before,
                    level,
                    close_price: None,
                    pnl: None,
                    balance_after: Some(state.effective_balance),
                    credit_after: Some(state.credit),
                    write_off: None,
                    prices: price_snapshot(&state),
                })
                .await;
        }
        return Ok(Some(report));
    }
    if transition(edge) {
        if let Some(fresh) = load_book_state(pool, account_id).await? {
            state = fresh;
            edge = margin_call_edge(&state, thresholds);
        }
    }
    if let Some(e) = edge.filter(|e| transition(Some(*e))) {
        if book::apply_margin_call_edge(pool, account_id, e).await? {
            crate::outbox::wake();
        }
    }

    Ok(Some(report))
}

/// Where the account stands against its margin-call level (None: open positions but no level, nothing changes).
fn margin_call_edge(state: &AccountState, thresholds: margin::MarginThresholds) -> Option<book::MarginCallEdge> {
    if state.positions.is_empty() {
        return Some(book::MarginCallEdge::Out);
    }
    risk::margin_level(equity(state), used_margin(state)).map(|level| {
        if level <= thresholds.call_level {
            book::MarginCallEdge::In { margin_level: level, call_level: thresholds.call_level }
        } else {
            book::MarginCallEdge::Out
        }
    })
}

async fn publish_best_effort(nats: Option<&async_nats::Client>, event: &TradingEvent) {
    let Some(nats) = nats else { return };
    if let Err(err) = crate::events::publish(nats, event).await {
        tracing::warn!(?err, "failed to publish margin event to NATS");
    }
}

/// One full pass over every account with an open position (a fresh cursor: no resume point). Errors for one
/// account are logged and don't stop the rest — a bug in one account's data shouldn't leave every other account
/// unmonitored. Production goes through `run_once_guarded`, whose guard keeps the cursor between passes.
pub async fn run_once(pool: &PgPool, nats: &async_nats::Client) {
    run_pass(pool, Some(nats), &mut PassCursor::default()).await;
}

/// What one pass did (Stage 4: the load harness drives passes through this, the production entry point).
#[derive(Debug, Clone, Default)]
pub struct PassReport {
    /// accounts evaluated (not deferred), in pass order
    pub evaluated: Vec<String>,
    /// accounts deferred to a later pass (a pending follow-up touches them)
    pub deferred: Vec<String>,
    /// Stage 4 (R): the pass stopped at this account, to resume there once its follow-ups ran
    pub stopped_at: Option<String>,
    /// positions closed by this pass
    pub closed: usize,
    pub errors: usize,
}

/// At most this many resume points in one walk through the account list (the loop guard, with `stopped_at`).
pub const MAX_CASCADE_STOPS: usize = 32;

/// Stage 4 (R), the resume point: where the next pass continues, kept between passes by the run guard.
///
/// The web evaluates accounts one after the other and runs each close's follow-ups (mirror, coverage) before it
/// moves on, so an account later in its pass always sees what an earlier account's closes did to it -- through any
/// number of hops (a client's stop-out closes a master's mirror target, the master's own stop-out then closes
/// another master's target...). The engine queues those follow-ups, so a pass that reaches an account a pending
/// follow-up will still touch (EvalReport.deferred) STOPS there; the next pass resumes AT that account, after the
/// dispatcher ran the follow-up, and carries on through the rest of the list. That is the web's order, hop by hop;
/// deferring only that account and carrying on (Stage 4.5) let a later account act before an earlier account's
/// cascade reached it.
///
/// Loop guard: a pass never stops twice at the same account within one walk through the list (`stopped_at`), nor
/// more than MAX_CASCADE_STOPS times. A follow-up that cannot finish (the web down, a circular mirror left by bad
/// data) therefore holds back at most one pass of the accounts after it; the account itself is only evaluated once
/// nothing fresh is pending for it, or after FOLLOW_UP_DEFER_SECS (the safety release).
#[derive(Debug, Clone, Default)]
pub struct PassCursor {
    resume_at: Option<String>,
    stopped_at: std::collections::HashSet<String>,
    stops: usize,
}

impl PassCursor {
    /// where the next pass will start (None = from the top)
    pub fn resume_at(&self) -> Option<&str> {
        self.resume_at.as_deref()
    }
}

/// One pass over every account with an open position, in accountId order, from the cursor's resume point. `nats` is
/// optional so the harness can run it without a broker.
pub async fn run_pass(pool: &PgPool, nats: Option<&async_nats::Client>, cursor: &mut PassCursor) -> PassReport {
    run_pass_mode(pool, nats, cursor, &Mode::Live).await
}

/// One pass in a given mode. Shadow: no deferral (it queues nothing), so no precheck and no resume point.
pub async fn run_pass_mode(pool: &PgPool, nats: Option<&async_nats::Client>, cursor: &mut PassCursor, mode: &Mode) -> PassReport {
    let mut report = PassReport::default();
    let account_ids = match book::account_ids_with_open_positions(pool).await {
        Ok(ids) => ids,
        Err(err) => {
            tracing::error!(?err, "margin monitor: failed to list accounts with open positions");
            report.errors += 1;
            return report;
        }
    };
    // ids come in byte order (COLLATE "C"), the order of Rust's String comparison
    let start = cursor.resume_at.take().map(|r| account_ids.partition_point(|id| id.as_str() < r.as_str())).unwrap_or(0);

    // Stage 4 §4.8: the per-account deferral query only runs once a follow-up can be pending -- one was at the start
    // of the pass, or this process queued one since (its own closes, or a concurrent pass's). Only this process ever
    // queues POSITION_CLOSED follow-ups (the web and the dispatcher never do), so nothing else can make one appear.
    // VYX_DEFER_PRECHECK=0 turns this off (every account queries, as before) for A/B verification.
    let queued_at_start = book::FOLLOW_UPS_QUEUED.load(std::sync::atomic::Ordering::Relaxed);
    let mut maybe_pending = !mode.is_shadow() && (!defer_precheck_enabled() || match book::any_pending_follow_up(pool).await {
        Ok(any) => any,
        Err(err) => {
            tracing::error!(?err, "margin monitor: follow-up precheck failed; checking every account");
            true
        }
    });

    // thresholds are read per account inside evaluate_account (Stage 2 F3), not cached per pass
    for account_id in &account_ids[start..] {
        maybe_pending = !mode.is_shadow() && (maybe_pending || book::FOLLOW_UPS_QUEUED.load(std::sync::atomic::Ordering::Relaxed) != queued_at_start);
        match evaluate_account_checked(pool, nats, account_id, maybe_pending, mode).await {
            Ok(Some(r)) if r.deferred => {
                report.deferred.push(account_id.clone());
                if cursor.stops < MAX_CASCADE_STOPS && cursor.stopped_at.insert(account_id.clone()) {
                    cursor.stops += 1;
                    cursor.resume_at = Some(account_id.clone());
                    report.stopped_at = Some(account_id.clone());
                    return report;
                }
                // loop guard: already stopped here in this walk -- carry on without it (Stage 4.5 behaviour)
            }
            Ok(r) => {
                report.closed += r.map(|r| r.closed.len()).unwrap_or(0);
                report.evaluated.push(account_id.clone());
            }
            Err(err) => {
                report.errors += 1;
                tracing::error!(?err, account_id, "margin monitor: failed to evaluate account");
            }
        }
    }
    // the walk reached the end of the list: the next pass starts a new one from the top
    cursor.stopped_at.clear();
    cursor.stops = 0;
    report
}

fn defer_precheck_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("VYX_DEFER_PRECHECK").map(|v| v.trim() != "0").unwrap_or(true))
}

/// Shared across every trigger source (the polling timer and, in
/// `engine/server`, the NATS tick subscription) so at most one
/// evaluation pass runs at a time — see the module doc comment. Used only
/// via `try_lock`: this is a coalescing/skip guard, not a queue, so a burst
/// of ticks while a pass is already running just gets dropped rather than
/// piling up (the in-flight pass, or the next trigger after it finishes,
/// covers the account either way). It also holds the pass cursor (Stage 4
/// resume point) from one pass to the next.
pub type RunGuard = Arc<Mutex<PassCursor>>;

pub fn new_run_guard() -> RunGuard {
    Arc::new(Mutex::new(PassCursor::default()))
}

/// Runs one evaluation pass if no other pass is currently running via
/// this guard; otherwise a no-op. Correctness doesn't depend on this
/// guard (closes are guarded, see book.rs), it's purely to avoid wasted
/// overlapping full-account-table scans when ticks arrive faster than a
/// pass completes -- and it carries the resume point.
pub async fn run_once_guarded(pool: &PgPool, nats: &async_nats::Client, guard: &RunGuard) {
    let Ok(mut cursor) = guard.try_lock() else {
        return;
    };
    run_pass(pool, Some(nats), &mut cursor).await;
}

/// Spawns the polling-timer trigger as a background task — the safety
/// net described in the module doc comment, not the primary trigger path
/// once a tick-driven subscription is also running alongside it.
pub fn spawn(pool: PgPool, nats: async_nats::Client, interval: std::time::Duration, guard: RunGuard, prices: book::PriceSource) {
    tokio::spawn(book::with_price_source(prices, async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            run_once_guarded(&pool, &nats, &guard).await;
        }
    }));
}

/// Stage 5: the shadow monitor. A pass every `interval` in `Mode::Shadow`, one at a time (a slow pass delays the
/// next, never overlaps it). No NATS, no dispatcher, no writes to the book.
pub fn spawn_shadow(pool: PgPool, recorder: Arc<crate::shadow::Recorder>, interval: std::time::Duration, prices: book::PriceSource) {
    tokio::spawn(book::with_price_source(prices, async move {
        let mode = Mode::Shadow(recorder);
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut cursor = PassCursor::default();
        loop {
            ticker.tick().await;
            let report = run_pass_mode(&pool, None, &mut cursor, &mode).await;
            if report.errors > 0 {
                tracing::warn!(errors = report.errors, "shadow pass: some accounts failed to evaluate");
            }
        }
    }));
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
            hedged_margin_pct: dec!(200),
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
