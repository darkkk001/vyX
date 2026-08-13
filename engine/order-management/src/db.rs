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
