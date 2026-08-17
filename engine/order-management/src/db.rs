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

/// `max_connections` matters under concurrent order placement: a single
/// `place_market_order` call makes several sequential round-trips (a
/// transaction plus a handful of separate pre-transaction reads), each
/// briefly holding a pool connection. The bare `PgPool::connect`
/// default (10) was silently the ceiling here -- a benchmark run at
/// concurrency 20 against this default returned `PoolTimedOut` on 193
/// of 200 requests (see docs/testing.md §2's Concurrency/latency
/// benchmark row). Callers set this explicitly rather than relying on
/// sqlx's own default.
pub async fn connect_pool(database_url: &str, max_connections: u32) -> Result<PgPool, sqlx::Error> {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(max_connections)
        .connect(database_url)
        .await
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

fn type_from_str(s: &str) -> OrderType {
    match s {
        "MARKET" => OrderType::Market,
        "LIMIT" => OrderType::Limit,
        "STOP" => OrderType::Stop,
        other => panic!("unknown order_type in database: {other}"),
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

/// `positions.status` — no equivalent type in `protocol` (only order-side
/// state made it there), and this crate is position's sole writer per
/// ADR-002, so it's defined here rather than adding a dependency on the
/// still-placeholder `position` crate just for one enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionStatus {
    Open,
    Closed,
}

fn position_status_from_str(s: &str) -> PositionStatus {
    match s {
        "OPEN" => PositionStatus::Open,
        "CLOSED" => PositionStatus::Closed,
        other => panic!("unknown position_status in database: {other}"),
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
pub struct PositionRow {
    pub id: String,
    pub account_id: String,
    pub side: OrderSide,
    pub status: PositionStatus,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
}

/// Single-position lookup by id, for the modify-SL/TP path's ownership
/// and status check — narrower than `get_open_positions_with_market`
/// (no market-price join, not account-scoped), which exists for a
/// different caller (the margin monitor) with a different shape need.
pub async fn get_position(pool: &PgPool, position_id: &str) -> Result<Option<PositionRow>, sqlx::Error> {
    let row = sqlx::query_as::<_, (String, String, String, String, Option<Decimal>, Option<Decimal>)>(
        r#"SELECT id, account_id, side::text, status::text, sl_price, tp_price
           FROM positions WHERE id = $1"#,
    )
    .bind(position_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(id, account_id, side, status, sl_price, tp_price)| PositionRow {
        id,
        account_id,
        side: side_from_str(&side),
        status: position_status_from_str(&status),
        sl_price,
        tp_price,
    }))
}

/// Sets a position's SL/TP to the caller-supplied final values (each
/// `None` = no stop on that side). Unlike the legacy Next.js route's
/// `undefined`-vs-`null` PATCH semantics, this always writes both
/// columns — see the module-level design note in the plan for why: this
/// HTTP surface is only ever called by services/api-gateway, which can
/// resolve "unchanged" itself before calling, so there's no need for a
/// three-state "field omitted" concept here.
pub async fn update_position_sl_tp(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    sl_price: Option<Decimal>,
    tp_price: Option<Decimal>,
) -> Result<(), sqlx::Error> {
    sqlx::query(r#"UPDATE positions SET sl_price = $1, tp_price = $2 WHERE id = $3"#)
        .bind(sl_price)
        .bind(tp_price)
        .bind(position_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Charges a position's one-time open commission — a `COMMISSION` ledger
/// entry (negative: a cost, reducing effective balance the same way
/// `get_ledger_sum`'s doc comment describes for stop-out P&L) plus the
/// running total on `positions.commission` for fast display (see
/// `20260817020000_commission_and_swap.sql`'s comment on why that column
/// exists alongside the ledger row instead of only the ledger row).
/// No-op if `commission` is zero — a broker with no commission configured
/// (the default) shouldn't write a $0 ledger entry for every trade.
pub async fn record_commission(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    account_id: &str,
    commission: Decimal,
) -> Result<(), sqlx::Error> {
    if commission.is_zero() {
        return Ok(());
    }

    sqlx::query(r#"UPDATE positions SET commission = commission + $1 WHERE id = $2"#)
        .bind(commission)
        .bind(position_id)
        .execute(&mut **tx)
        .await?;

    sqlx::query(
        r#"INSERT INTO ledger_entries (id, account_id, entry_type, amount, related_position_id)
           VALUES ($1, $2, 'COMMISSION'::ledger_entry_type, $3, $4)"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(account_id)
    .bind(-commission)
    .bind(position_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
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

/// Atomically cancels a resting order — `WHERE status = 'ACCEPTED'` means
/// only a still-waiting LIMIT/STOP can be cancelled this way (mirrors
/// the legacy Next.js path's "only PENDING can be cancelled" rule,
/// app/api/trade/orders/[id]/route.ts). Returns whether a row was
/// actually claimed, same idempotent-claim pattern as
/// `try_claim_order_for_routing`: a caller retrying after a lost
/// response, or a race with the order triggering at the same instant,
/// sees `false` rather than double-cancelling or erroring.
pub async fn cancel_order(tx: &mut sqlx::PgTransaction<'_>, order_id: &str) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        r#"UPDATE orders SET status = 'CANCELLED'::order_status, updated_at = now()
           WHERE id = $1 AND status = 'ACCEPTED'::order_status"#,
    )
    .bind(order_id)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
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
// Broker-specific symbol config — pricing (pricing.rs) + trading rules
// (risk::check_symbol_enabled / risk::check_lot_size).
// ─────────────────────────────────────────────────────────────────────

pub struct BrokerSymbolConfig {
    pub digits: i32,
    pub spread_markup: Decimal,
    pub enabled: bool,
    pub min_lot: Decimal,
    pub max_lot: Decimal,
    pub lot_step: Decimal,
    // Null whether the BrokerSymbol row is missing entirely or present
    // with no limit set — both mean "no limit" to risk::check_symbol_exposure,
    // so no COALESCE needed here unlike the other columns above.
    pub max_exposure: Option<Decimal>,
    // Flat fee per lot, charged once at position open — see swap.rs's
    // module doc and lib.rs's place_market_order for where this actually
    // gets applied.
    pub commission_per_lot: Decimal,
    // Account-currency per lot per day, applied by the daily rollover job
    // (swap.rs) — see BrokerSymbol.swapLong/swapShort's schema comment
    // for the unit convention.
    pub swap_long: Decimal,
    pub swap_short: Decimal,
}

#[allow(clippy::type_complexity)]
type BrokerSymbolConfigRow =
    (i32, Decimal, bool, Decimal, Decimal, Decimal, Option<Decimal>, Decimal, Decimal, Decimal);

/// `Symbol.digits` always resolves if the symbol exists at all; the LEFT
/// JOIN means an unconfigured `BrokerSymbol` row (broker hasn't set up
/// this symbol) defaults via `COALESCE` to zero markup, enabled, and the
/// same min/max/step/commission/swap defaults `BrokerSymbol`'s own schema
/// uses — a missing admin config shouldn't block trading, it just means
/// the broker hasn't customized anything for this symbol yet.
pub async fn get_broker_symbol_config(
    pool: &PgPool,
    broker_id: &str,
    symbol: &str,
) -> Result<Option<BrokerSymbolConfig>, sqlx::Error> {
    let row: Option<BrokerSymbolConfigRow> = sqlx::query_as(
        r#"SELECT s.digits, COALESCE(bs."spreadMarkup", 0), COALESCE(bs.enabled, true),
                  COALESCE(bs."minLot", 0.01), COALESCE(bs."maxLot", 100), COALESCE(bs."lotStep", 0.01),
                  bs."maxExposure", COALESCE(bs."commissionPerLot", 0),
                  COALESCE(bs."swapLong", 0), COALESCE(bs."swapShort", 0)
           FROM "Symbol" s
           LEFT JOIN "BrokerSymbol" bs ON bs."symbolId" = s.id AND bs."brokerId" = $1
           WHERE s.name = $2"#,
    )
    .bind(broker_id)
    .bind(symbol)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(digits, spread_markup, enabled, min_lot, max_lot, lot_step, max_exposure, commission_per_lot, swap_long, swap_short)| {
            BrokerSymbolConfig {
                digits,
                spread_markup,
                enabled,
                min_lot,
                max_lot,
                lot_step,
                max_exposure,
                commission_per_lot,
                swap_long,
                swap_short,
            }
        },
    ))
}

/// §2.1 step 5's account-wide half: `Broker.maxOpenPositionsPerAccount`.
/// A broker row not existing (shouldn't happen for an order already tied
/// to a valid `broker_id`) collapses to the same `None`/no-limit result
/// as a `NULL` column, rather than a separate error case to handle.
pub async fn get_broker_max_open_positions(pool: &PgPool, broker_id: &str) -> Result<Option<i32>, sqlx::Error> {
    let row: Option<(Option<i32>,)> =
        sqlx::query_as(r#"SELECT "maxOpenPositionsPerAccount" FROM "Broker" WHERE id = $1"#)
            .bind(broker_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(v,)| v))
}

pub struct SymbolExposure {
    pub open_volume: Decimal,
    pub open_position_count: i64,
}

/// Narrower than `get_open_positions_with_market`/`load_account_state`
/// (no Symbol/LivePrice join) — §2.1 step 5's checks only need two
/// aggregates over this account's open positions, not per-position P&L
/// inputs. Used by `place_market_order`, which (unlike the pending-order
/// trigger path) doesn't already have an `AccountState` loaded.
pub async fn get_symbol_exposure(
    pool: &PgPool,
    account_id: &str,
    symbol: &str,
) -> Result<SymbolExposure, sqlx::Error> {
    let (open_volume, open_position_count): (Decimal, i64) = sqlx::query_as(
        r#"SELECT COALESCE(SUM(volume) FILTER (WHERE symbol = $2), 0), COUNT(*)
           FROM positions WHERE account_id = $1 AND status = 'OPEN'"#,
    )
    .bind(account_id)
    .bind(symbol)
    .fetch_one(pool)
    .await?;
    Ok(SymbolExposure { open_volume, open_position_count })
}

/// `get_symbol_exposure` + `get_broker_max_open_positions` in one round
/// trip via two independent subqueries -- both are §2.1 step 5 checks
/// read together by `place_market_order`, with no dependency between
/// them, so there's no reason to pay two separate network round trips
/// for them. The two single-purpose functions above stay as they are
/// for any other caller that only needs one value.
pub async fn get_exposure_and_max_positions(
    pool: &PgPool,
    broker_id: &str,
    account_id: &str,
    symbol: &str,
) -> Result<(SymbolExposure, Option<i32>), sqlx::Error> {
    let (open_volume, open_position_count, max_open_positions): (Decimal, i64, Option<i32>) = sqlx::query_as(
        r#"SELECT
             (SELECT COALESCE(SUM(volume) FILTER (WHERE symbol = $3), 0) FROM positions WHERE account_id = $2),
             (SELECT COUNT(*) FROM positions WHERE account_id = $2 AND status = 'OPEN'),
             (SELECT "maxOpenPositionsPerAccount" FROM "Broker" WHERE id = $1)"#,
    )
    .bind(broker_id)
    .bind(account_id)
    .bind(symbol)
    .fetch_one(pool)
    .await?;
    Ok((SymbolExposure { open_volume, open_position_count }, max_open_positions))
}

// ─────────────────────────────────────────────────────────────────────
// Pending-order (LIMIT/STOP) trigger support — see pending_orders.rs.
// ─────────────────────────────────────────────────────────────────────

/// Read-only lookup into Prisma-owned `Symbol` (ADR-002 — reading another
/// module's table isn't a boundary violation, only writing it would be;
/// same reasoning as `get_account_funds` below). Needed at trigger time
/// to compute required margin for the order about to fill.
pub async fn get_symbol_contract_size(pool: &PgPool, symbol: &str) -> Result<Option<Decimal>, sqlx::Error> {
    let row: Option<(Decimal,)> =
        sqlx::query_as(r#"SELECT "contractSize" FROM "Symbol" WHERE name = $1"#)
            .bind(symbol)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(cs,)| cs))
}

#[derive(Debug, Clone)]
pub struct PendingOrder {
    pub id: String,
    pub broker_id: String,
    pub account_id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub volume: Decimal,
    pub requested_price: Decimal,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
}

/// Every ACCEPTED LIMIT/STOP order for one symbol — narrowed by symbol
/// (unlike the margin monitor's account scan, which can't narrow by
/// symbol since floating P&L across *any* symbol affects an account's
/// equity) because a pending order can only ever trigger off its own
/// symbol's price.
pub async fn get_pending_orders_for_symbol(
    pool: &PgPool,
    symbol: &str,
) -> Result<Vec<PendingOrder>, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, String, String, String, String, Decimal, Decimal, Option<Decimal>, Option<Decimal>)> =
        sqlx::query_as(
            r#"SELECT id, broker_id, account_id, symbol, side::text, type::text,
                      volume, requested_price, sl_price, tp_price
               FROM orders
               WHERE symbol = $1 AND status = 'ACCEPTED'::order_status
                 AND type IN ('LIMIT'::order_type, 'STOP'::order_type)"#,
        )
        .bind(symbol)
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(
            |(id, broker_id, account_id, symbol, side, order_type, volume, requested_price, sl_price, tp_price)| {
                PendingOrder {
                    id,
                    broker_id,
                    account_id,
                    symbol,
                    side: side_from_str(&side),
                    order_type: type_from_str(&order_type),
                    volume,
                    requested_price,
                    sl_price,
                    tp_price,
                }
            },
        )
        .collect())
}

/// Atomically claims a pending order for routing — `UPDATE ... WHERE
/// status = 'ACCEPTED'` means only one caller can win this if two ticks
/// (or a tick and the same order re-appearing in a later scan) both try
/// to trigger the same order concurrently; the loser sees
/// `rows_affected() == 0` and treats that as "someone else is already
/// handling this," not an error. Same idempotency pattern as
/// `close_position_with_ledger_entry`.
pub async fn try_claim_order_for_routing(
    tx: &mut sqlx::PgTransaction<'_>,
    order_id: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        r#"UPDATE orders SET status = 'ROUTING'::order_status, updated_at = now()
           WHERE id = $1 AND status = 'ACCEPTED'::order_status"#,
    )
    .bind(order_id)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
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

// ─────────────────────────────────────────────────────────────────────
// Daily swap rollover — see swap.rs.
// ─────────────────────────────────────────────────────────────────────

pub struct PositionForSwap {
    pub id: String,
    pub broker_id: String,
    pub account_id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub volume: Decimal,
}

/// Candidates for today's rollover — every OPEN position not yet charged
/// today. Compares against Postgres's own `CURRENT_DATE` (not a
/// Rust-side date), same reasoning as the staleness checks in
/// `market_data::db::get_live_price`: one clock, no skew between what
/// this query considers "today" and what `claim_position_for_swap`'s
/// `now()` writes.
pub async fn get_positions_due_for_swap(pool: &PgPool) -> Result<Vec<PositionForSwap>, sqlx::Error> {
    let rows: Vec<(String, String, String, String, String, Decimal)> = sqlx::query_as(
        r#"SELECT id, broker_id, account_id, symbol, side::text, volume
           FROM positions
           WHERE status = 'OPEN' AND (last_swap_at IS NULL OR last_swap_at::date < CURRENT_DATE)"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, broker_id, account_id, symbol, side, volume)| PositionForSwap {
            id,
            broker_id,
            account_id,
            symbol,
            side: side_from_str(&side),
            volume,
        })
        .collect())
}

/// Idempotent claim, same `rows_affected() == 1` pattern as
/// `try_claim_order_for_routing`: the `WHERE` repeats the exact
/// "due today" condition from `get_positions_due_for_swap` so a position
/// that raced onto someone else's list (or already got charged between
/// that read and this claim) is a clean no-op here, not a double charge.
pub async fn claim_position_for_swap(tx: &mut sqlx::PgTransaction<'_>, position_id: &str) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        r#"UPDATE positions SET last_swap_at = now()
           WHERE id = $1 AND status = 'OPEN'
             AND (last_swap_at IS NULL OR last_swap_at::date < CURRENT_DATE)"#,
    )
    .bind(position_id)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// ISO weekday (Monday=1..Sunday=7) for `CURRENT_DATE`, from Postgres's
/// own clock — see swap.rs's module doc for why this isn't read from the
/// Rust process's clock instead.
pub async fn get_current_weekday(pool: &PgPool) -> Result<i32, sqlx::Error> {
    let (dow,): (f64,) = sqlx::query_as("SELECT EXTRACT(ISODOW FROM CURRENT_DATE)").fetch_one(pool).await?;
    Ok(dow as i32)
}

/// Records the swap charge/credit itself, once a position has already
/// been claimed via `claim_position_for_swap` — a running total on
/// `positions.swap` (display) plus a `SWAP` ledger entry (the
/// authoritative money movement), same two-writes-in-one-transaction
/// shape as `record_commission`. Unlike commission, the sign comes
/// straight from the broker's configured `swapLong`/`swapShort` rate,
/// not forced negative — a swap can legitimately be a credit.
pub async fn apply_swap(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    account_id: &str,
    swap_amount: Decimal,
) -> Result<(), sqlx::Error> {
    sqlx::query(r#"UPDATE positions SET swap = swap + $1 WHERE id = $2"#)
        .bind(swap_amount)
        .bind(position_id)
        .execute(&mut **tx)
        .await?;

    sqlx::query(
        r#"INSERT INTO ledger_entries (id, account_id, entry_type, amount, related_position_id)
           VALUES ($1, $2, 'SWAP'::ledger_entry_type, $3, $4)"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(account_id)
    .bind(swap_amount)
    .bind(position_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
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
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
}

/// LEFT JOIN on LivePrice, same reasoning as
/// services/api-gateway/src/db.ts's getOpenPositionsSummary: a position
/// whose symbol has no current tick still counts toward margin at its
/// open price (dropping it would understate risk) but can't contribute a
/// floating P&L figure — callers treat `bid`/`ask: None` as "skip this
/// one for P&L, not for margin." `sl_price`/`tp_price` ride along so
/// monitor.rs can check both margin AND per-position SL/TP triggers from
/// this one query, rather than a second round-trip.
///
/// The join condition also requires the tick be fresh (updated in the
/// last 15s, same threshold as `market_data::db::get_live_price` and
/// `WebTrader.tsx`'s chart) — without this, a dead feed leaves `lp.bid`/
/// `lp.ask` frozen at their last real values forever, and every consumer
/// here (SL/TP triggers, stop-out's worst-position pick, floating P&L)
/// would keep evaluating against a wrong, unmoving price with no signal
/// anything was stale. A stale tick now behaves exactly like no tick at
/// all — `bid`/`ask: None` — which every consumer already handles
/// correctly per the paragraph above.
pub async fn get_open_positions_with_market(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<OpenPositionWithMarket>, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        String,
        Decimal,
        Decimal,
        Decimal,
        Option<Decimal>,
        Option<Decimal>,
        Option<Decimal>,
        Option<Decimal>,
    )> = sqlx::query_as(
        r#"SELECT p.id, p.symbol, p.side::text, p.volume, p.open_price, s."contractSize",
                  lp.bid, lp.ask, p.sl_price, p.tp_price
           FROM positions p
           JOIN "Symbol" s ON s.name = p.symbol
           LEFT JOIN "LivePrice" lp ON lp.symbol = p.symbol AND lp."updatedAt" > now() - interval '15 seconds'
           WHERE p.account_id = $1 AND p.status = 'OPEN'"#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(id, symbol, side, volume, open_price, contract_size, bid, ask, sl_price, tp_price)| {
                OpenPositionWithMarket {
                    id,
                    symbol,
                    side: side_from_str(&side),
                    volume,
                    open_price,
                    contract_size,
                    bid,
                    ask,
                    sl_price,
                    tp_price,
                }
            },
        )
        .collect())
}

/// Force-closes one position (stop-out) and records the realized P&L as a
/// ledger entry, in one transaction. `close_price` is whatever the caller
/// already resolved (bid for a BUY, ask for a SELL — see monitor.rs).
///
/// Idempotent via `AND status = 'OPEN'` + `rows_affected()`: now that the
/// monitor can be triggered both by the polling timer and by every
/// incoming tick (see monitor.rs's module doc), two evaluation passes can
/// legitimately race on the same account. Without this guard both could
/// "successfully" close the same position and each insert their own
/// ledger entry — double-counting realized P&L. Returns `None` (no
/// ledger entry written) when the position had already been closed by a
/// concurrent pass by the time this one's UPDATE ran.
pub async fn close_position_with_ledger_entry(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    account_id: &str,
    close_price: Decimal,
    realized_pnl: Decimal,
) -> Result<Option<String>, sqlx::Error> {
    let result = sqlx::query(
        r#"UPDATE positions SET status = 'CLOSED'::position_status, close_price = $1,
           realized_pnl = $2, closed_at = now()
           WHERE id = $3 AND status = 'OPEN'::position_status"#,
    )
    .bind(close_price)
    .bind(realized_pnl)
    .bind(position_id)
    .execute(&mut **tx)
    .await?;

    if result.rows_affected() == 0 {
        return Ok(None);
    }

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

    Ok(Some(entry_id))
}
