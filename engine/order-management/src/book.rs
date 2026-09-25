//! The risk path's book on the REAL Prisma schema (Rust cutover Stage 1, docs/RUST-CUTOVER-PLAN.md).
//!
//! Until this module the margin monitor read and wrote the engine's own lowercase tables (`positions`,
//! `ledger_entries`), which production never fills: every broker's book lives in Prisma's `"Position"` /
//! `"Account"` / `"Transaction"`. This module reads the book from there and closes a position exactly the
//! way the web's `lib/position-close.ts` `closePositionInTx` does, so the two paths write identical rows:
//!
//! 1. guarded UPDATE of `"Position"` (status = OPEN AND volume = what the caller read: a concurrent close,
//!    or a partial that already reduced it, makes this a benign `None`);
//! 2. `"Account"` row locked (`FOR UPDATE`) before its balance is read, so two closes on one account can
//!    never lose each other's P&L;
//! 3. negative-balance protection per `"Broker"."negativeBalanceProtection"`: the balance floors at 0 and
//!    the excess is an explicit NEGATIVE_BALANCE_PROTECTION write-off + AuditLog row;
//! 4. `"Account".balance` written, and a TRADE_PNL `"Transaction"` whose balanceAfter is the RAW
//!    (uncapped) result, as the web records it.
//!
//! What this module does NOT decide yet (Stage 2): the formulas (credit, live-price margin, tickAt
//! freshness, quote-currency conversion). `realized_pnl` is the caller's, in the account's currency.

use crate::db::OpenPositionWithMarket;
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

/// A decimal as the web prints it with `Prisma.Decimal.toFixed(2)`: rounded half away from zero, 2 places.
/// NOT `format!("{:.2}")`, which TRUNCATES a rust_decimal (90.909 -> "90.90" where the web says "90.91"); found by
/// the Stage 3 gate, 2026-09-24. Every note / notice / audit text the web also writes goes through this.
pub fn fixed2(d: Decimal) -> String {
    format!("{:.2}", d.round_dp_with_strategy(2, rust_decimal::RoundingStrategy::MidpointAwayFromZero))
}

fn side_from_prisma(s: &str) -> protocol::OrderSide {
    match s {
        "SELL" => protocol::OrderSide::Sell,
        _ => protocol::OrderSide::Buy,
    }
}

/// Every account holding at least one OPEN position (same set lib/risk-monitor.ts's callers walk), in accountId byte
/// order (Stage 4: a deterministic pass order; the load harness's web reference walks the same order).
pub async fn account_ids_with_open_positions(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> =
        sqlx::query_as(r#"SELECT "accountId" FROM "Position" WHERE status = 'OPEN' GROUP BY "accountId" ORDER BY "accountId" COLLATE "C""#).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// One account's OPEN positions with their USABLE price (Stage 2 F4, the web's rule in lib/live-price.ts
/// getFreshPrices + lib/risk-monitor.ts's session gate):
/// - the quote's `tickAt` (the real last-tick time, UTC) is under 15 s old. NOT `updatedAt`: the EA's
///   heartbeat re-sends an unchanged price every few seconds, which keeps `updatedAt` fresh on a dead feed;
/// - AND the symbol's trading session is open now for this account's broker (session.rs). As on the web,
///   only a symbol that has a BrokerSymbol row for the broker can be session-closed.
/// A position without a usable price comes back with `bid`/`ask` = None: counted nowhere, closeable by nothing.
// ---- Where the book's prices come from (2026-09-25) ----
// Since the market-data move (S5, 2026-09-15) the feed writes LivePrice to the VPS-local database; Neon's
// "LivePrice" stopped moving (10 days stale on 2026-09-25). This loader joined Neon's LivePrice, so in production the
// shadow -- and Stage 6's real close path -- would have seen every position UNPRICED. The live engine now prices the
// book from its OWN in-memory ticks: the very entry GET /internal/prices serves the web (lib/live-price.ts vps
// path), so the web and the engine read one source, the same Decimal bid / ask (the web gets them via
// decimal_json = normalize().to_string(), exact) under the same freshness rule (tickAt = the tick's origin time,
// else its receive time; fresh = newer than 15 s). Only the SOURCE changes: close, P&L, NBP untouched.

/// The book's price source.
#[derive(Clone, Default)]
pub enum PriceSource {
    /// The "LivePrice" table of the book's own database (tests, parity, the scratch harnesses).
    #[default]
    Db,
    /// The engine's in-memory ticks (the live feed): production.
    Ticks(std::sync::Arc<market_data::cache::TickCache>),
}

tokio::task_local! {
    static PRICE_SOURCE: PriceSource;
}

/// Set by the server (shadow / live order management): a book read with no tick source in scope is then an ERROR,
/// never a silent read of the database's LivePrice (a task spawned outside the scope would otherwise fall back).
static REQUIRE_TICK_SOURCE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn require_tick_source() {
    REQUIRE_TICK_SOURCE.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Runs `f` with `source` as the book's price source (a monitor pass runs as one task: every read inside sees it).
pub async fn with_price_source<F: std::future::Future>(source: PriceSource, f: F) -> F::Output {
    PRICE_SOURCE.scope(source, f).await
}

fn current_price_source() -> Result<PriceSource, sqlx::Error> {
    match PRICE_SOURCE.try_with(|s| s.clone()) {
        Ok(s) => Ok(s),
        Err(_) if REQUIRE_TICK_SOURCE.load(std::sync::atomic::Ordering::SeqCst) => {
            Err(sqlx::Error::Protocol("book read without the engine's tick source in scope (would read the database's stale LivePrice)".into()))
        }
        Err(_) => Ok(PriceSource::Db),
    }
}

/// An FX conversion quote older than this is not used: equal to lib/fx.ts FX_RATE_MAX_AGE_MS (72 h, a weekend fits).
pub fn fx_rate_max_age() -> chrono::Duration {
    chrono::Duration::hours(72)
}

/// A conversion quote from the ticks, or None when there is none or it is older than fx_rate_max_age.
fn fx_quote_from_ticks(cache: &market_data::cache::TickCache, symbol: &str, now: chrono::DateTime<chrono::Utc>) -> Option<(Decimal, Decimal)> {
    cache.latest(symbol).filter(|(t, received)| now - tick_time(t, *received) < fx_rate_max_age()).map(|(t, _)| (t.bid, t.ask))
}

/// The tick time the web uses for freshness (engine price_row: tick_ms, else the receive time).
pub fn tick_time(tick: &protocol::Tick, received_at: chrono::DateTime<chrono::Utc>) -> chrono::DateTime<chrono::Utc> {
    tick.tick_ms.and_then(chrono::DateTime::from_timestamp_millis).unwrap_or(received_at)
}

/// Fresh bid / ask from the ticks, the web's rule: tick time newer than 15 s.
fn fresh_from_ticks(cache: &market_data::cache::TickCache, symbol: &str, now: chrono::DateTime<chrono::Utc>) -> (Option<Decimal>, Option<Decimal>) {
    match cache.latest(symbol) {
        Some((t, received)) if now - tick_time(&t, received) < chrono::Duration::seconds(15) => (Some(t.bid), Some(t.ask)),
        _ => (None, None),
    }
}

pub async fn open_positions_with_market(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<OpenPositionWithMarket>, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, String, Decimal, Decimal, Decimal, Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<Decimal>, String, String, String, String, Decimal)> =
        sqlx::query_as(
            r#"SELECT p.id, s.name, p.side::text, p.volume, p."openPrice", s."contractSize",
                      lp.bid, lp.ask, p."slPrice", p."tpPrice", s.category::text, p."brokerId",
                      s."quoteCurrency", a.currency, COALESCE(bs."hedgedMarginPct", 200)
               FROM "Position" p
               JOIN "Symbol" s ON s.id = p."symbolId"
               JOIN "Account" a ON a.id = p."accountId"
               LEFT JOIN "BrokerSymbol" bs ON bs."brokerId" = p."brokerId" AND bs."symbolId" = p."symbolId"
               LEFT JOIN "LivePrice" lp ON lp.symbol = s.name AND lp."tickAt" > now() - interval '15 seconds'
               WHERE p."accountId" = $1 AND p.status = 'OPEN'
               ORDER BY p."openedAt", p.id"#,
        )
        .bind(account_id)
        .fetch_all(pool)
        .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    // the broker's configured sessions for these symbols (one account = one broker, as the web assumes)
    let broker_id = rows[0].11.clone();
    let names: Vec<String> = rows.iter().map(|r| r.1.clone()).collect();
    let session_rows: Vec<(String, Option<i32>, Option<String>, Option<String>)> = sqlx::query_as(
        r#"SELECT s.name, ts."dayOfWeek", ts."openTime", ts."closeTime"
           FROM "BrokerSymbol" bs
           JOIN "Symbol" s ON s.id = bs."symbolId"
           LEFT JOIN "TradingSession" ts ON ts."brokerSymbolId" = bs.id
           WHERE bs."brokerId" = $1 AND s.name = ANY($2)"#,
    )
    .bind(&broker_id)
    .bind(&names)
    .fetch_all(pool)
    .await?;
    let mut sessions: std::collections::HashMap<String, Vec<crate::session::SessionWindow>> = std::collections::HashMap::new();
    for (name, day, open, close) in session_rows {
        let list = sessions.entry(name).or_default();
        if let (Some(day_of_week), Some(open_time), Some(close_time)) = (day, open, close) {
            list.push(crate::session::SessionWindow { day_of_week, open_time, close_time });
        }
    }
    let now = chrono::Utc::now();

    // quote -> account conversion (Stage 2 F2, fx.rs = lib/fx.ts): every symbol a needed conversion may read,
    // latest quote whatever its age, in one query; nothing is read when every pair is same-currency.
    let mut fx_symbols: Vec<String> = Vec::new();
    for r in &rows {
        for s in crate::fx::conversion_symbols_for(&r.12, &r.13) {
            if !fx_symbols.contains(&s) {
                fx_symbols.push(s);
            }
        }
    }
    let source = current_price_source()?;
    let fx_quotes: std::collections::HashMap<String, crate::fx::Quote> = if fx_symbols.is_empty() {
        std::collections::HashMap::new()
    } else if let PriceSource::Ticks(cache) = &source {
        // same age limit as lib/fx.ts FX_RATE_MAX_AGE_MS: older = no rate = the position is unpriced
        fx_symbols.iter().filter_map(|s| fx_quote_from_ticks(cache, s, now).map(|q| (s.clone(), q))).collect()
    } else {
        let q: Vec<(String, Decimal, Decimal)> = sqlx::query_as(r#"SELECT symbol, bid, ask FROM "LivePrice" WHERE symbol = ANY($1) AND "tickAt" > now() - interval '72 hours'"#)
            .bind(&fx_symbols)
            .fetch_all(pool)
            .await?;
        q.into_iter().map(|(s, b, a)| (s, (b, a))).collect()
    };

    Ok(rows
        .into_iter()
        .map(|(id, symbol, side, volume, open_price, contract_size, bid, ask, sl_price, tp_price, category, _, quote_ccy, account_ccy, hedged_margin_pct)| {
            // the SOURCE of bid / ask: the database's LivePrice (the SQL above) or the engine's ticks
            let (bid, ask) = match &source {
                PriceSource::Db => (bid, ask),
                PriceSource::Ticks(cache) => fresh_from_ticks(cache, &symbol, now),
            };
            let closed = sessions.get(&symbol).is_some_and(|windows| crate::session::is_market_closed(windows, now, &category));
            let rate = crate::fx::conversion_rate(&quote_ccy, &account_ccy, |s| fx_quotes.get(s).copied());
            if rate.is_none() {
                tracing::error!(position_id = %id, %symbol, %quote_ccy, %account_ccy, "no conversion rate: position treated as unpriced");
            }
            let usable = !closed && rate.is_some();
            OpenPositionWithMarket {
                id,
                symbol,
                side: side_from_prisma(&side),
                volume,
                open_price,
                contract_size,
                bid: if usable { bid } else { None },
                ask: if usable { ask } else { None },
                sl_price,
                tp_price,
                fx_rate: rate.unwrap_or(Decimal::ONE),
                hedged_margin_pct,
            }
        })
        .collect())
}

/// The account's stop-out / margin-call thresholds, read from its OWN Group in the same database, every
/// evaluation (Stage 2 F3: one source, no cached map). No group: the global defaults 100 / 50
/// (margin::MarginThresholds::default, = lib/risk-monitor.ts's `?? 100` / `?? 50`). None = no such account.
pub async fn account_thresholds(pool: &PgPool, account_id: &str) -> Result<Option<margin::MarginThresholds>, sqlx::Error> {
    let row: Option<(Option<Decimal>, Option<Decimal>)> = sqlx::query_as(
        r#"SELECT g."marginCallLevel", g."stopOutLevel"
           FROM "Account" a LEFT JOIN "Group" g ON g.id = a."groupId"
           WHERE a.id = $1"#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(call, stop_out)| {
        let d = margin::MarginThresholds::default();
        margin::MarginThresholds { call_level: call.unwrap_or(d.call_level), stop_out_level: stop_out.unwrap_or(d.stop_out_level) }
    }))
}

/// The money side of one close, pure (Stage 5): what `close_position_in_tx` writes and what the shadow's
/// simulated close applies in memory. ONE function, so a would-close in shadow cannot drift from a real close.
/// Stage 2 F1 (credit Model A, = lib/position-close.ts): a loss that takes the BALANCE below zero is paid from
/// CREDIT next, up to the shortfall; only what credit cannot cover reaches negative-balance protection
/// (`protect_nbp` = the broker's negativeBalanceProtection), which floors the balance at 0.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CloseMoney {
    /// balance + realized P&L, before credit and any floor (the TRADE_PNL row's balanceAfter)
    pub raw_balance_after: Decimal,
    /// after credit paid what it could
    pub after_credit: Decimal,
    pub final_balance: Decimal,
    pub final_credit: Decimal,
    pub credit_used: Option<Decimal>,
    pub write_off: Option<Decimal>,
}

pub fn close_money(balance_before: Decimal, credit_before: Decimal, realized_pnl: Decimal, protect_nbp: bool) -> CloseMoney {
    let raw_balance_after = balance_before + realized_pnl;
    let mut after_credit = raw_balance_after;
    let mut final_credit = credit_before;
    let mut credit_used = None;
    if raw_balance_after < Decimal::ZERO && credit_before > Decimal::ZERO {
        let used = credit_before.min(-raw_balance_after);
        after_credit = raw_balance_after + used;
        final_credit = credit_before - used;
        credit_used = Some(used);
    }
    let mut final_balance = after_credit;
    let mut write_off = None;
    if after_credit < Decimal::ZERO && protect_nbp {
        write_off = Some(-after_credit);
        final_balance = Decimal::ZERO;
    }
    CloseMoney { raw_balance_after, after_credit, final_balance, final_credit, credit_used, write_off }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CloseOutcome {
    pub realized_pnl: Decimal,
    /// balance + realized P&L, before any floor (what the TRADE_PNL row records as balanceAfter)
    pub raw_balance_after: Decimal,
    /// what Account.balance now holds
    pub final_balance: Decimal,
    /// Some(amount) when negative-balance protection absorbed the part below zero
    pub write_off: Option<Decimal>,
    /// Some(amount) when credit paid part of a loss beyond the balance (Stage 2 F1)
    pub credit_used: Option<Decimal>,
    /// what Account.credit now holds
    pub final_credit: Decimal,
    pub account_id: String,
    pub broker_id: String,
    /// the TRADE_PNL "Transaction" row this close wrote (one per close: the outbox dedupe key uses it)
    pub trade_txn_id: String,
}

/// Closes one position in full at `close_price`, crediting `realized_pnl` (account currency), inside the
/// caller's transaction. `expected_volume` is the volume the caller read the position with; if the row is
/// no longer OPEN with exactly that volume, nothing is written and `None` comes back (a benign race).
pub async fn close_position_in_tx(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    expected_volume: Decimal,
    close_price: Decimal,
    realized_pnl: Decimal,
    note: &str,
) -> Result<Option<CloseOutcome>, sqlx::Error> {
    let claimed: Option<(String, String)> = sqlx::query_as(
        r#"UPDATE "Position"
           SET status = 'CLOSED', "closePrice" = $1, "realizedPnl" = $2, "closedAt" = now()
           WHERE id = $3 AND status = 'OPEN' AND volume = $4
           RETURNING "accountId", "brokerId""#,
    )
    .bind(close_price)
    .bind(realized_pnl)
    .bind(position_id)
    .bind(expected_volume)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((account_id, broker_id)) = claimed else {
        return Ok(None);
    };

    let (balance_before, credit_before): (Decimal, Decimal) = sqlx::query_as(r#"SELECT balance, credit FROM "Account" WHERE id = $1 FOR UPDATE"#)
        .bind(&account_id)
        .fetch_one(&mut **tx)
        .await?;
    // the money rules live in close_money (shared with the Stage 5 shadow's simulated close); the broker's
    // negative-balance protection flag is read only when the result would go below zero, as before
    let unprotected = close_money(balance_before, credit_before, realized_pnl, false);
    let protect = if unprotected.after_credit < Decimal::ZERO {
        let (protect,): (bool,) = sqlx::query_as(r#"SELECT "negativeBalanceProtection" FROM "Broker" WHERE id = $1"#)
            .bind(&broker_id)
            .fetch_one(&mut **tx)
            .await?;
        protect
    } else {
        false
    };
    let CloseMoney { raw_balance_after, after_credit, final_balance, final_credit, credit_used, write_off } =
        close_money(balance_before, credit_before, realized_pnl, protect);

    sqlx::query(r#"UPDATE "Account" SET balance = $1, credit = $2, "updatedAt" = now() WHERE id = $3"#)
        .bind(final_balance)
        .bind(final_credit)
        .bind(&account_id)
        .execute(&mut **tx)
        .await?;

    let trade_txn_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO "Transaction"
             (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
           VALUES ($1, $2, $3, 'TRADE_PNL', 'COMPLETED', $4, $5, $6, 'Position', $7, $8, now())"#,
    )
    .bind(&trade_txn_id)
    .bind(&broker_id)
    .bind(&account_id)
    .bind(realized_pnl)
    .bind(balance_before)
    .bind(raw_balance_after)
    .bind(position_id)
    .bind(note)
    .execute(&mut **tx)
    .await?;

    if let Some(used) = credit_used {
        sqlx::query(
            r#"INSERT INTO "Transaction"
                 (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
               VALUES ($1, $2, $3, 'CREDIT', 'COMPLETED', $4, $5, $6, 'Position', $7, $8, now())"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&broker_id)
        .bind(&account_id)
        .bind(used)
        .bind(raw_balance_after)
        .bind(after_credit)
        .bind(position_id)
        .bind(format!("Credit applied to a loss: {} (credit {} -> {})", fixed2(used), fixed2(credit_before), fixed2(final_credit)))
        .execute(&mut **tx)
        .await?;
        let detail = serde_json::json!({
            "positionId": position_id,
            "creditUsed": fixed2(used),
            "creditBefore": fixed2(credit_before),
            "creditAfter": fixed2(final_credit),
        });
        sqlx::query(
            r#"INSERT INTO "AuditLog" (id, "brokerId", action, "entityType", "entityId", "newValue")
               VALUES ($1, $2, 'CREDIT_CONSUMED_BY_LOSS', 'Account', $3, $4::jsonb)"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&broker_id)
        .bind(&account_id)
        .bind(detail.to_string())
        .execute(&mut **tx)
        .await?;
    }

    if let Some(amount) = write_off {
        sqlx::query(
            r#"INSERT INTO "Transaction"
                 (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
               VALUES ($1, $2, $3, 'NEGATIVE_BALANCE_PROTECTION', 'COMPLETED', $4, $5, $6, 'Position', $7, $8, now())"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&broker_id)
        .bind(&account_id)
        .bind(amount)
        .bind(after_credit)
        .bind(final_balance)
        .bind(position_id)
        .bind(format!("Negative-balance protection: broker absorbed ${} beyond zero", fixed2(amount)))
        .execute(&mut **tx)
        .await?;
        let detail = serde_json::json!({
            "positionId": position_id,
            "writeOffAmount": fixed2(amount),
            "rawBalanceAfter": fixed2(raw_balance_after),
        });
        sqlx::query(
            r#"INSERT INTO "AuditLog" (id, "brokerId", action, "entityType", "entityId", "newValue")
               VALUES ($1, $2, 'NEGATIVE_BALANCE_PROTECTION_APPLIED', 'Account', $3, $4::jsonb)"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&broker_id)
        .bind(&account_id)
        .bind(detail.to_string())
        .execute(&mut **tx)
        .await?;
    }

    Ok(Some(CloseOutcome {
        realized_pnl,
        raw_balance_after,
        final_balance,
        write_off,
        credit_used,
        final_credit,
        account_id,
        broker_id,
        trade_txn_id,
    }))
}

/// How long a pending follow-up may hold back the evaluation of the account it will touch (see
/// `pending_follow_up_owns`). Past this the account is evaluated anyway: a stuck outbox (dispatcher down, web
/// unreachable) must never keep an account from its own stop-out.
pub const FOLLOW_UP_DEFER_SECS: i32 = 30;

/// Stage 4.5 (ordering = the web's): true when a PENDING post-close follow-up, queued under
/// FOLLOW_UP_DEFER_SECS ago, is still going to touch one of this account's OPEN positions:
/// - close a mirror target (its `mirror` step not yet done);
/// - close an auto-hedged coverage leg (its `coverage` step not yet done; a dealer-booked leg is left open for the
///   desk on the web too, so it is not waited for);
/// - release a client position its coverage leg was hedging, when that LEG was the one closed (its `coverage`
///   step not yet done): the web releases it, and tells the desk, while the client position is still open.
/// The web runs all of these inside its pass, right after the close that triggers them, so by the time it
/// evaluates this account they have happened; the monitor waits for them the same way.
/// Where an account stands against pending follow-ups (see `pending_follow_up_state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowUpOwed {
    /// nothing pending touches it: evaluate
    No,
    /// a follow-up queued under FOLLOW_UP_DEFER_SECS ago still will: wait for it
    Yes,
    /// only follow-ups OLDER than the window still touch it (a stuck outbox): evaluate anyway -- the safety release
    Expired,
}

/// Deferral queries run and safety releases taken since start (Stage 4 cost / starvation metrics; also worth
/// alerting on in production: a safety release means the outbox was stuck for FOLLOW_UP_DEFER_SECS).
pub static DEFER_QUERIES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static SAFETY_RELEASES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// POSITION_CLOSED follow-ups this process queued (enqueue_post_close). A pass that saw none pending at its start
/// only needs the per-account deferral query once this moves (see monitor::run_pass).
pub static FOLLOW_UPS_QUEUED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static DEFER_PRECHECKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Stage 4 §4.8, the per-PASS precheck: is ANY post-close follow-up pending at all? (No window, so a stuck row still
/// routes the accounts it touches through the per-account query and its safety-release accounting.) One index probe
/// on ("status", ...) instead of the 3-way query for every account, in the normal case where nothing is pending.
pub async fn any_pending_follow_up(pool: &PgPool) -> Result<bool, sqlx::Error> {
    DEFER_PRECHECKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (any,): (bool,) = sqlx::query_as(
        r#"SELECT EXISTS (SELECT 1 FROM "PostCloseEffect" WHERE status = 'PENDING' AND kind = 'POSITION_CLOSED')"#,
    )
    .fetch_one(pool)
    .await?;
    Ok(any)
}

pub async fn pending_follow_up_owns(pool: &PgPool, account_id: &str) -> Result<bool, sqlx::Error> {
    Ok(pending_follow_up_state(pool, account_id).await? == FollowUpOwed::Yes)
}

/// The three cases above as one query, without the window, reporting whether any of them is still fresh.
pub async fn pending_follow_up_state(pool: &PgPool, account_id: &str) -> Result<FollowUpOwed, sqlx::Error> {
    DEFER_QUERIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (any, fresh): (bool, bool) = sqlx::query_as(
        r#"WITH owed AS (
             SELECT e."createdAt" FROM "PostCloseEffect" e
             JOIN "MirrorLink" ml ON ml."sourcePositionId" = e."positionId"
             JOIN "Position" t ON t.id = ml."targetPositionId"
             WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('mirror' = ANY(e."doneSteps"))
               AND t."accountId" = $1 AND t.status = 'OPEN'
             UNION ALL
             SELECT e."createdAt" FROM "PostCloseEffect" e
             JOIN "Position" s ON s.id = e."positionId"
             JOIN "Position" leg ON leg.id = s."coveragePositionId"
             WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('coverage' = ANY(e."doneSteps"))
               AND leg."accountId" = $1 AND leg.status = 'OPEN' AND leg."autoHedged"
             UNION ALL
             SELECT e."createdAt" FROM "PostCloseEffect" e
             JOIN "Position" client ON client."coveragePositionId" = e."positionId"
             WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('coverage' = ANY(e."doneSteps"))
               AND client."accountId" = $1 AND client.status = 'OPEN'
           )
           SELECT count(*) > 0, coalesce(bool_or("createdAt" > now() - ($2::int * interval '1 second')), false) FROM owed"#,
    )
    .bind(account_id)
    .bind(FOLLOW_UP_DEFER_SECS)
    .fetch_one(pool)
    .await?;
    Ok(if fresh { FollowUpOwed::Yes } else if any { FollowUpOwed::Expired } else { FollowUpOwed::No })
}

/// Why the monitor closed a position, as the post-close outbox row records it ("reason").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    StopLoss,
    TakeProfit,
    /// the margin level that triggered it and the account's stop-out level (the dealer's notice quotes both)
    StopOut { margin_level: Decimal, stop_out_level: Decimal },
}

impl CloseReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            CloseReason::StopLoss => "stop_loss",
            CloseReason::TakeProfit => "take_profit",
            CloseReason::StopOut { .. } => "stop_out",
        }
    }
}

/// Rust cutover Stage 3: queues what the web must do after this close (queued-close cancel, mirror, stop-out
/// notice, coverage, events: lib/post-close.ts) as a "PostCloseEffect" row, inside the SAME transaction as the
/// close, so a committed close always has its follow-up recorded and a rolled-back one never does. One row per
/// close (dedupe key = the close's TRADE_PNL row). `volume_before` is the position's volume when it was closed:
/// the web can no longer read it from the row once the close has committed.
pub async fn enqueue_post_close(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    outcome: &CloseOutcome,
    reason: CloseReason,
    volume_before: Decimal,
    close_price: Decimal,
) -> Result<(), sqlx::Error> {
    let mut payload = serde_json::json!({
        "closedLots": volume_before.normalize().to_string(),
        "sourceVolumeBeforeClose": volume_before.normalize().to_string(),
        "closePrice": close_price.normalize().to_string(),
        "realizedPnl": outcome.realized_pnl.normalize().to_string(),
    });
    if let CloseReason::StopOut { margin_level, stop_out_level } = reason {
        // the same text lib/risk-monitor.ts passes: level to 2 dp, the threshold as configured
        payload["marginLevel"] = serde_json::Value::String(fixed2(margin_level));
        payload["stopOutLevel"] = serde_json::Value::String(stop_out_level.normalize().to_string());
    }
    sqlx::query(
        r#"INSERT INTO "PostCloseEffect" (id, kind, "dedupeKey", "brokerId", "accountId", "positionId", reason, payload)
           VALUES ($1, 'POSITION_CLOSED', $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT ("dedupeKey") DO NOTHING"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(format!("close:{}:{}", position_id, outcome.trade_txn_id))
    .bind(&outcome.broker_id)
    .bind(&outcome.account_id)
    .bind(position_id)
    .bind(reason.as_str())
    .bind(payload.to_string())
    .execute(&mut **tx)
    .await?;
    // counted once the caller commits or not -- a rolled-back row only makes the next pass check once more
    FOLLOW_UPS_QUEUED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Where an account stands against its margin-call level after a pass (lib/risk-monitor.ts pass 3).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MarginCallEdge {
    /// at or below the margin-call level
    In { margin_level: Decimal, call_level: Decimal },
    /// above it again, or nothing left open
    Out,
}

/// Whether the account's margin-call edge is currently set ("Account"."marginCallNotifiedAt").
pub async fn margin_call_notified(pool: &PgPool, account_id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(bool,)> = sqlx::query_as(r#"SELECT "marginCallNotifiedAt" IS NOT NULL FROM "Account" WHERE id = $1"#)
        .bind(account_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(b,)| b).unwrap_or(false))
}

/// The margin-call notice, edge-triggered on "Account"."marginCallNotifiedAt" exactly as the web does it: entering
/// margin call with the column empty sets it and queues ONE "MARGIN_CALL" outbox row (the web's route writes the
/// trader's and the staff's notification), in one transaction; staying in does nothing; leaving clears the column
/// so the next episode notifies again. Returns true when this call queued a notice.
pub async fn apply_margin_call_edge(pool: &PgPool, account_id: &str, edge: MarginCallEdge) -> Result<bool, sqlx::Error> {
    match edge {
        MarginCallEdge::Out => {
            sqlx::query(r#"UPDATE "Account" SET "marginCallNotifiedAt" = NULL WHERE id = $1 AND "marginCallNotifiedAt" IS NOT NULL"#)
                .bind(account_id)
                .execute(pool)
                .await?;
            Ok(false)
        }
        MarginCallEdge::In { margin_level, call_level } => {
            let mut tx = pool.begin().await?;
            let entered: Option<(String, i64)> = sqlx::query_as(
                r#"UPDATE "Account" SET "marginCallNotifiedAt" = now()
                   WHERE id = $1 AND "marginCallNotifiedAt" IS NULL
                   RETURNING "brokerId", (extract(epoch from "marginCallNotifiedAt") * 1000)::bigint"#,
            )
            .bind(account_id)
            .fetch_optional(&mut *tx)
            .await?;
            let Some((broker_id, edge_ms)) = entered else {
                tx.rollback().await?;
                return Ok(false); // already notified for this episode
            };
            let payload = serde_json::json!({
                "marginLevel": fixed2(margin_level),
                "marginCallLevel": call_level.normalize().to_string(),
            });
            sqlx::query(
                r#"INSERT INTO "PostCloseEffect" (id, kind, "dedupeKey", "brokerId", "accountId", payload)
                   VALUES ($1, 'MARGIN_CALL', $2, $3, $4, $5::jsonb)
                   ON CONFLICT ("dedupeKey") DO NOTHING"#,
            )
            .bind(Uuid::new_v4().to_string())
            .bind(format!("mc:{}:{}", account_id, edge_ms))
            .bind(&broker_id)
            .bind(account_id)
            .bind(payload.to_string())
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixed2;
    use rust_decimal_macros::dec;

    /// = Prisma.Decimal.toFixed(2) (decimal.js ROUND_HALF_UP: half away from zero)
    #[test]
    fn fixed2_rounds_like_the_web() {
        assert_eq!(fixed2(dec!(90.9090909)), "90.91");
        assert_eq!(fixed2(dec!(-900)), "-900.00");
        assert_eq!(fixed2(dec!(0.125)), "0.13");
        assert_eq!(fixed2(dec!(-0.125)), "-0.13");
        assert_eq!(fixed2(dec!(12.344)), "12.34");
        assert_eq!(fixed2(dec!(49.995)), "50.00");
    }
}


#[cfg(test)]
mod price_source_tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn tick(bid: Decimal, ask: Decimal, tick_ms: Option<i64>) -> protocol::Tick {
        let mut j = serde_json::json!({ "symbol": "XAUUSD", "bid": bid, "ask": ask });
        if let Some(ms) = tick_ms {
            j["tick_ms"] = serde_json::json!(ms);
        }
        serde_json::from_value(j).unwrap()
    }

    /// The web receives bid / ask as decimal_json (normalize().to_string()) and parses them back as Decimal: for every
    /// shape of price it gets exactly the Decimal the engine's book uses. No float anywhere, no rounding difference.
    #[test]
    fn the_webs_copy_of_a_tick_is_the_same_decimal() {
        for d in [dec!(4270.50), dec!(4270.5), dec!(1.08345), dec!(0.00001), dec!(150.000), dec!(77061.0), dec!(2000.20)] {
            let over_the_wire = d.normalize().to_string();
            assert_eq!(over_the_wire.parse::<Decimal>().unwrap(), d, "{d} -> {over_the_wire}");
        }
    }

    #[test]
    fn ticks_give_the_exact_bid_ask_under_the_webs_freshness_rule() {
        let cache = market_data::cache::TickCache::new();
        let now = chrono::Utc::now();
        // the tick's own origin time decides (engine price_row tickAt = tick_ms), not when it was received
        cache.set(&tick(dec!(4270.55), dec!(4270.85), Some((now - chrono::Duration::milliseconds(14_999)).timestamp_millis())), now);
        assert_eq!(fresh_from_ticks(&cache, "XAUUSD", now), (Some(dec!(4270.55)), Some(dec!(4270.85))));
        cache.set(&tick(dec!(4270.55), dec!(4270.85), Some((now - chrono::Duration::seconds(15)).timestamp_millis())), now);
        assert_eq!(fresh_from_ticks(&cache, "XAUUSD", now), (None, None), "15 s old = stale (web: tickAt > now - 15 s)");
        // no tick_ms: the receive time, as price_row
        cache.set(&tick(dec!(4271), dec!(4271.3), None), now - chrono::Duration::seconds(3));
        assert_eq!(fresh_from_ticks(&cache, "XAUUSD", now), (Some(dec!(4271)), Some(dec!(4271.3))));
        assert_eq!(fresh_from_ticks(&cache, "EURUSD", now), (None, None), "unknown symbol = unpriced");
    }

    /// FX age limit, the same as lib/fx.ts (fx-age.test.ts): 49 h (a weekend) converts, over 72 h is no rate.
    #[test]
    fn fx_quotes_older_than_72h_are_not_used() {
        let cache = market_data::cache::TickCache::new();
        let now = chrono::Utc::now();
        let set = |hours: i64| {
            let t: protocol::Tick = serde_json::from_value(serde_json::json!({ "symbol": "EURUSD", "bid": dec!(1.08), "ask": dec!(1.0802), "tick_ms": (now - chrono::Duration::hours(hours)).timestamp_millis() })).unwrap();
            cache.set(&t, now);
        };
        set(49);
        assert_eq!(fx_quote_from_ticks(&cache, "EURUSD", now), Some((dec!(1.08), dec!(1.0802))), "a weekend-old rate converts");
        set(73);
        assert_eq!(fx_quote_from_ticks(&cache, "EURUSD", now), None, "older than 72 h: no rate");
        set(24 * 10);
        assert_eq!(fx_quote_from_ticks(&cache, "EURUSD", now), None, "10 days (the stale Neon copy): no rate");
    }
}
