//! Postgres persistence for orders/positions — the sole writer per
//! ADR-002 (../../docs/database.md §2-3). Schema:
//! ../../engine/migrations/20260813000000_trading_core_tables.sql.
//!
//! Deliberately uses runtime-checked `sqlx::query`/`query_as` rather than
//! the `sqlx::query!` compile-time macro: the macro needs either a live
//! DB connection or a `cargo sqlx prepare` offline cache at build time,
//! neither of which exists in every environment this crate is built in.
//! Postgres enum columns are bound/read as TEXT with an explicit `::type`
//! cast in SQL, converted to/from the Rust enums by hand below, for the
//! same reason (no compile-time schema check available everywhere).

use chrono::{DateTime, Utc};
use protocol::{OrderSide, OrderStatus, OrderType};
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

pub async fn connect_pool(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPool::connect(database_url).await
}

fn side_to_str(s: OrderSide) -> &'static str {
    match s {
        OrderSide::Buy => "BUY",
        OrderSide::Sell => "SELL",
    }
}

fn side_from_str(s: &str) -> OrderSide {
    match s {
        "BUY" => OrderSide::Buy,
        "SELL" => OrderSide::Sell,
        other => panic!("unknown order_side in database: {other}"),
    }
}

fn type_to_str(t: OrderType) -> &'static str {
    match t {
        OrderType::Market => "MARKET",
        OrderType::Limit => "LIMIT",
        OrderType::Stop => "STOP",
    }
}

fn status_to_str(s: OrderStatus) -> &'static str {
    match s {
        OrderStatus::New => "NEW",
        OrderStatus::Validating => "VALIDATING",
        OrderStatus::Accepted => "ACCEPTED",
        OrderStatus::Rejected => "REJECTED",
        OrderStatus::Routing => "ROUTING",
        OrderStatus::PartiallyFilled => "PARTIALLY_FILLED",
        OrderStatus::Filled => "FILLED",
        OrderStatus::Cancelled => "CANCELLED",
        OrderStatus::Expired => "EXPIRED",
    }
}

fn status_from_str(s: &str) -> OrderStatus {
    match s {
        "NEW" => OrderStatus::New,
        "VALIDATING" => OrderStatus::Validating,
        "ACCEPTED" => OrderStatus::Accepted,
        "REJECTED" => OrderStatus::Rejected,
        "ROUTING" => OrderStatus::Routing,
        "PARTIALLY_FILLED" => OrderStatus::PartiallyFilled,
        "FILLED" => OrderStatus::Filled,
        "CANCELLED" => OrderStatus::Cancelled,
        "EXPIRED" => OrderStatus::Expired,
        other => panic!("unknown order_status in database: {other}"),
    }
}

pub struct NewOrder {
    pub broker_id: String,
    pub account_id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub volume: Decimal,
    pub requested_price: Option<Decimal>,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
}

/// Inserts a new order row with status NEW. Callers move it through
/// `set_status`/`set_rejected`/`set_filled` from there — every write goes
/// through this module so `orders` never gets a row written outside the
/// legality checks in the `order-management` crate root.
pub async fn insert_order(
    tx: &mut sqlx::PgTransaction<'_>,
    order: &NewOrder,
) -> Result<String, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO orders
            (id, broker_id, account_id, symbol, side, type, volume,
             requested_price, sl_price, tp_price, status)
        VALUES ($1, $2, $3, $4, $5::order_side, $6::order_type, $7, $8, $9, $10, 'NEW')
        "#,
    )
    .bind(&id)
    .bind(&order.broker_id)
    .bind(&order.account_id)
    .bind(&order.symbol)
    .bind(side_to_str(order.side))
    .bind(type_to_str(order.order_type))
    .bind(order.volume)
    .bind(order.requested_price)
    .bind(order.sl_price)
    .bind(order.tp_price)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

pub async fn set_status(
    tx: &mut sqlx::PgTransaction<'_>,
    order_id: &str,
    status: OrderStatus,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE orders SET status = $1::order_status, updated_at = now() WHERE id = $2",
    )
    .bind(status_to_str(status))
    .bind(order_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn set_rejected(
    tx: &mut sqlx::PgTransaction<'_>,
    order_id: &str,
    reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE orders SET status = 'REJECTED'::order_status, reject_reason = $1,
           updated_at = now() WHERE id = $2"#,
    )
    .bind(reason)
    .bind(order_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn set_filled(
    tx: &mut sqlx::PgTransaction<'_>,
    order_id: &str,
    filled_price: Decimal,
    filled_volume: Decimal,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE orders SET status = 'FILLED'::order_status, filled_price = $1,
           filled_volume = $2, updated_at = now() WHERE id = $3"#,
    )
    .bind(filled_price)
    .bind(filled_volume)
    .bind(order_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub struct NewPosition {
    pub broker_id: String,
    pub account_id: String,
    pub symbol: String,
    pub origin_order_id: String,
    pub side: OrderSide,
    pub volume: Decimal,
    pub open_price: Decimal,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
}

pub async fn insert_position(
    tx: &mut sqlx::PgTransaction<'_>,
    position: &NewPosition,
) -> Result<String, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO positions
            (id, broker_id, account_id, symbol, origin_order_id, side, volume,
             open_price, sl_price, tp_price, status)
        VALUES ($1, $2, $3, $4, $5, $6::order_side, $7, $8, $9, $10, 'OPEN')
        "#,
    )
    .bind(&id)
    .bind(&position.broker_id)
    .bind(&position.account_id)
    .bind(&position.symbol)
    .bind(&position.origin_order_id)
    .bind(side_to_str(position.side))
    .bind(position.volume)
    .bind(position.open_price)
    .bind(position.sl_price)
    .bind(position.tp_price)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

#[derive(Debug)]
pub struct OrderRow {
    pub id: String,
    pub account_id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub status: OrderStatus,
    pub volume: Decimal,
    pub created_at: DateTime<Utc>,
}

pub async fn get_order(pool: &PgPool, order_id: &str) -> Result<Option<OrderRow>, sqlx::Error> {
    let row = sqlx::query_as::<_, (String, String, String, String, String, Decimal, DateTime<Utc>)>(
        r#"SELECT id, account_id, symbol, side::text, status::text, volume, created_at
           FROM orders WHERE id = $1"#,
    )
    .bind(order_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(id, account_id, symbol, side, status, volume, created_at)| OrderRow {
        id,
        account_id,
        symbol,
        side: side_from_str(&side),
        status: status_from_str(&status),
        volume,
        created_at,
    }))
}

// ─────────────────────────────────────────────────────────────────────
// Margin monitor support — see monitor.rs. Reads Account (Prisma-owned,
// ADR-002) the same way services/api-gateway/src/db.ts does for the
// same reason: the monitor needs balance/credit/leverage to compute
// equity, and only Prisma writes that table, but reading it isn't a
// boundary violation — only writing it would be. This module never
// writes to "Account".
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct AccountFunds {
    pub balance: Decimal,
    pub credit: Decimal,
    pub leverage: i32,
}

pub async fn get_account_funds(pool: &PgPool, account_id: &str) -> Result<Option<AccountFunds>, sqlx::Error> {
    let row = sqlx::query_as::<_, (Decimal, Decimal, i32)>(
        r#"SELECT balance, credit, leverage FROM "Account" WHERE id = $1"#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(balance, credit, leverage)| AccountFunds { balance, credit, leverage }))
}

/// Sum of every ledger entry recorded for this account so far. Account.balance
/// is Prisma-owned and this crate never writes to it (see above) — realized
/// P&L from a force-close still needs to count toward the account's true
/// current balance, so it's tracked here as a delta on top of whatever
/// Account.balance currently holds, rather than requiring a cross-boundary
/// write. Callers (this monitor, and services/api-gateway) both compute
/// "effective balance" as `Account.balance + get_ledger_sum(...)`.
pub async fn get_ledger_sum(pool: &PgPool, account_id: &str) -> Result<Decimal, sqlx::Error> {
    let (sum,): (Decimal,) = sqlx::query_as(
        "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await?;
    Ok(sum)
}

pub async fn get_account_ids_with_open_positions(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT account_id FROM positions WHERE status = 'OPEN'")
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

#[derive(Debug, Clone)]
pub struct OpenPositionWithMarket {
    pub id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub volume: Decimal,
    pub open_price: Decimal,
    pub contract_size: Decimal,
    pub bid: Option<Decimal>,
    pub ask: Option<Decimal>,
}

/// LEFT JOIN on LivePrice, same reasoning as
/// services/api-gateway/src/db.ts's getOpenPositionsSummary: a position
/// whose symbol has no current tick still counts toward margin at its
/// open price (dropping it would understate risk) but can't contribute a
/// floating P&L figure — callers treat `bid`/`ask: None` as "skip this
/// one for P&L, not for margin."
pub async fn get_open_positions_with_market(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<OpenPositionWithMarket>, sqlx::Error> {
    let rows: Vec<(String, String, String, Decimal, Decimal, Decimal, Option<Decimal>, Option<Decimal>)> =
        sqlx::query_as(
            r#"SELECT p.id, p.symbol, p.side::text, p.volume, p.open_price, s."contractSize",
                      lp.bid, lp.ask
               FROM positions p
               JOIN "Symbol" s ON s.name = p.symbol
               LEFT JOIN "LivePrice" lp ON lp.symbol = p.symbol
               WHERE p.account_id = $1 AND p.status = 'OPEN'"#,
        )
        .bind(account_id)
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|(id, symbol, side, volume, open_price, contract_size, bid, ask)| OpenPositionWithMarket {
            id,
            symbol,
            side: side_from_str(&side),
            volume,
            open_price,
            contract_size,
            bid,
            ask,
        })
        .collect())
}

/// Force-closes one position (stop-out) and records the realized P&L as a
/// ledger entry, in one transaction. `close_price` is whatever the caller
/// already resolved (bid for a BUY, ask for a SELL — see monitor.rs).
pub async fn close_position_with_ledger_entry(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    account_id: &str,
    close_price: Decimal,
    realized_pnl: Decimal,
) -> Result<String, sqlx::Error> {
    sqlx::query(
        r#"UPDATE positions SET status = 'CLOSED'::position_status, close_price = $1,
           realized_pnl = $2, closed_at = now() WHERE id = $3"#,
    )
    .bind(close_price)
    .bind(realized_pnl)
    .bind(position_id)
    .execute(&mut **tx)
    .await?;

    let entry_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO ledger_entries (id, account_id, entry_type, amount, related_position_id)
           VALUES ($1, $2, 'REALIZED_PNL'::ledger_entry_type, $3, $4)"#,
    )
    .bind(&entry_id)
    .bind(account_id)
    .bind(realized_pnl)
    .bind(position_id)
    .execute(&mut **tx)
    .await?;

    Ok(entry_id)
}
