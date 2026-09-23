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

fn side_from_prisma(s: &str) -> protocol::OrderSide {
    match s {
        "SELL" => protocol::OrderSide::Sell,
        _ => protocol::OrderSide::Buy,
    }
}

/// Every account holding at least one OPEN position (same set lib/risk-monitor.ts's callers walk).
pub async fn account_ids_with_open_positions(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> =
        sqlx::query_as(r#"SELECT DISTINCT "accountId" FROM "Position" WHERE status = 'OPEN'"#).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// One account's OPEN positions with their USABLE price (Stage 2 F4, the web's rule in lib/live-price.ts
/// getFreshPrices + lib/risk-monitor.ts's session gate):
/// - the quote's `tickAt` (the real last-tick time, UTC) is under 15 s old. NOT `updatedAt`: the EA's
///   heartbeat re-sends an unchanged price every few seconds, which keeps `updatedAt` fresh on a dead feed;
/// - AND the symbol's trading session is open now for this account's broker (session.rs). As on the web,
///   only a symbol that has a BrokerSymbol row for the broker can be session-closed.
/// A position without a usable price comes back with `bid`/`ask` = None: counted nowhere, closeable by nothing.
pub async fn open_positions_with_market(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<OpenPositionWithMarket>, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, String, Decimal, Decimal, Decimal, Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<Decimal>, String, String, String, String)> =
        sqlx::query_as(
            r#"SELECT p.id, s.name, p.side::text, p.volume, p."openPrice", s."contractSize",
                      lp.bid, lp.ask, p."slPrice", p."tpPrice", s.category::text, p."brokerId",
                      s."quoteCurrency", a.currency
               FROM "Position" p
               JOIN "Symbol" s ON s.id = p."symbolId"
               JOIN "Account" a ON a.id = p."accountId"
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
    let fx_quotes: std::collections::HashMap<String, crate::fx::Quote> = if fx_symbols.is_empty() {
        std::collections::HashMap::new()
    } else {
        let q: Vec<(String, Decimal, Decimal)> = sqlx::query_as(r#"SELECT symbol, bid, ask FROM "LivePrice" WHERE symbol = ANY($1)"#)
            .bind(&fx_symbols)
            .fetch_all(pool)
            .await?;
        q.into_iter().map(|(s, b, a)| (s, (b, a))).collect()
    };

    Ok(rows
        .into_iter()
        .map(|(id, symbol, side, volume, open_price, contract_size, bid, ask, sl_price, tp_price, category, _, quote_ccy, account_ccy)| {
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
    let raw_balance_after = balance_before + realized_pnl;

    // Stage 2 F1 (credit Model A, = lib/position-close.ts): a loss that takes the BALANCE below zero is paid
    // from CREDIT next, up to the shortfall; only what credit cannot cover reaches negative-balance protection.
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
    if after_credit < Decimal::ZERO {
        let (protect,): (bool,) = sqlx::query_as(r#"SELECT "negativeBalanceProtection" FROM "Broker" WHERE id = $1"#)
            .bind(&broker_id)
            .fetch_one(&mut **tx)
            .await?;
        if protect {
            write_off = Some(-after_credit);
            final_balance = Decimal::ZERO;
        }
    }

    sqlx::query(r#"UPDATE "Account" SET balance = $1, credit = $2, "updatedAt" = now() WHERE id = $3"#)
        .bind(final_balance)
        .bind(final_credit)
        .bind(&account_id)
        .execute(&mut **tx)
        .await?;

    sqlx::query(
        r#"INSERT INTO "Transaction"
             (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
           VALUES ($1, $2, $3, 'TRADE_PNL', 'COMPLETED', $4, $5, $6, 'Position', $7, $8, now())"#,
    )
    .bind(Uuid::new_v4().to_string())
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
        .bind(format!("Credit applied to a loss: {:.2} (credit {:.2} -> {:.2})", used, credit_before, final_credit))
        .execute(&mut **tx)
        .await?;
        let detail = serde_json::json!({
            "positionId": position_id,
            "creditUsed": format!("{:.2}", used),
            "creditBefore": format!("{:.2}", credit_before),
            "creditAfter": format!("{:.2}", final_credit),
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
        .bind(format!("Negative-balance protection: broker absorbed ${:.2} beyond zero", amount))
        .execute(&mut **tx)
        .await?;
        let detail = serde_json::json!({
            "positionId": position_id,
            "writeOffAmount": format!("{:.2}", amount),
            "rawBalanceAfter": format!("{:.2}", raw_balance_after),
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

    Ok(Some(CloseOutcome { realized_pnl, raw_balance_after, final_balance, write_off, credit_used, final_credit }))
}
