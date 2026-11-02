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
use market_data::ask_markup::{AskLevels, Level};
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

// ---- which book the order path writes (L2 Stage 3) ---------------------------------------------------
//
// The engine has always written its OWN lowercase `orders` / `positions` / `ledger_entries`, which
// production never fills: every broker's book lives in Prisma's `"Order"` / `"Position"` / `"Deal"` /
// `"Transaction"`, which is what margin, P&L, the UI and hedging all read (book.rs's module doc).
// The L2 cutover moves the order path onto that book.
//
// The choice is an explicit parameter rather than a flag read inside each function, so that:
//   - the legacy mode (`ENGINE_ORDER_MANAGEMENT=1|on|true|yes`) keeps writing the legacy tables and
//     its behaviour does not change at all until Stage 8 removes it, and
//   - a test can exercise either book without touching process-wide state.
// `live` mode selects Prisma; everything else selects Legacy. See `configured()`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Book {
    /// The engine's own lowercase tables. Nothing in production reads them.
    #[default]
    Legacy,
    /// Prisma's `"Order"` / `"Position"` / `"Deal"` / `"Transaction"` -- the real book.
    Prisma,
}

/// Set once at start-up by `live` mode (engine/server/src/main.rs), before the HTTP listener binds.
static PRISMA_BOOK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `live` mode announces that the order path writes the real book. Idempotent; never unset.
pub fn use_prisma_book() {
    PRISMA_BOOK.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// The book this process's order path writes. Read ONCE per order by the paths in lib.rs /
/// pending_orders.rs and then passed down, so one order can never write half of each.
pub fn configured() -> Book {
    if PRISMA_BOOK.load(std::sync::atomic::Ordering::Relaxed) {
        Book::Prisma
    } else {
        Book::Legacy
    }
}

// ---- L2 Stage 3: which book, and the fail-safe default ----------------------------------------------

#[cfg(test)]
mod book_tests {
    use super::Book;

    /// The default has to be the LEGACY book, and the flag has to be one-way. Every process that is
    /// not `live` mode -- the legacy order-only mode, shadow, a test binary, a tool -- must write the
    /// engine's own tables, because those are the ones nothing reads. Defaulting the other way would
    /// mean any process that forgot to opt out wrote real client positions.
    #[test]
    fn a_process_that_says_nothing_writes_the_legacy_book() {
        assert_eq!(Book::default(), Book::Legacy);
        // configured() reads a process-wide flag, so this asserts the UNSET reading. The flag is only
        // ever set by live mode in engine/server/src/main.rs, after verify_order_path_pool passed.
        assert_eq!(super::configured(), Book::Legacy, "no process writes the real book until live mode says so");
    }
}

pub struct NewOrder {
    pub broker_id: String,
    pub account_id: String,
    pub symbol: String,
    /// `Symbol.id` -- required by Prisma's `"Order"."symbolId"` (a NOT NULL FK). Resolved by
    /// `get_broker_symbol_config` (L2 Stage 2). Ignored by the legacy book, which keys by name.
    pub symbol_id: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub volume: Decimal,
    pub requested_price: Option<Decimal>,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
}

/// Inserts a new order row. Callers move it through
/// `set_status`/`set_rejected`/`set_filled` from there — every write goes
/// through this module so the order table never gets a row written outside the
/// legality checks in the `order-management` crate root.
///
/// LEGACY: status NEW in the engine's own `orders`.
///
/// PRISMA: status PENDING in `"Order"`, which is what the web writes for both a market order waiting
/// on a decision and a resting LIMIT/STOP (`risk_hook.rs`'s pending scan reads exactly
/// `status = 'PENDING' AND type IN ('LIMIT','STOP')`). Three columns are deliberately NOT supplied:
///   - `ticket`, so the sequence DEFAULT assigns the number a trader quotes to support;
///   - `createdAt` / `requestedAt`, which default to now().
///
/// `updatedAt` IS supplied: Prisma declares it `@updatedAt`, which Prisma Client fills in — the column
/// is NOT NULL with no database default, so a plain SQL insert must set it or fail.
pub async fn insert_order(
    tx: &mut sqlx::PgTransaction<'_>,
    book: Book,
    order: &NewOrder,
) -> Result<String, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    match book {
        Book::Legacy => {
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
        }
        Book::Prisma => {
            // idempotencyKey is UNIQUE per (accountId, key) and exists so a CLIENT retrying after a
            // timeout gets its original answer instead of a second order. An engine-originated order
            // has no client key to carry, so the row's own id -- already a v4 uuid -- is the honest
            // value: unique, and never colliding with a client's. (In the cutover's own design the
            // WEB creates the Order row and the engine only fills it; this path exists for the
            // engine's own /v1/orders routes, which nothing calls today.)
            //
            // source API: these orders arrive through the engine's HTTP routes, which is what that
            // enum value means. Not WEB (its default), which would misattribute them in reports.
            sqlx::query(
                r#"INSERT INTO "Order"
                     (id, "brokerId", "accountId", "symbolId", side, type, volume,
                      "requestedPrice", "slPrice", "tpPrice", status, "idempotencyKey", source, "updatedAt")
                   VALUES ($1, $2, $3, $4, $5::"OrderSide", $6::"OrderType", $7, $8, $9, $10,
                           'PENDING'::"OrderStatus", $11, 'API'::"OrderSource", now())"#,
            )
            .bind(&id)
            .bind(&order.broker_id)
            .bind(&order.account_id)
            .bind(&order.symbol_id)
            .bind(side_to_str(order.side))
            .bind(type_to_str(order.order_type))
            .bind(order.volume)
            .bind(order.requested_price)
            .bind(order.sl_price)
            .bind(order.tp_price)
            .bind(format!("engine:{id}"))
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(id)
}

/// LEGACY only. The engine's `order_status` enum has NEW / VALIDATING / ACCEPTED / ROUTING states
/// that Prisma's `OrderStatus` simply does not have, and the one that matters -- a resting LIMIT/STOP
/// waiting for its price -- is `PENDING` on the Prisma book, which `insert_order` already wrote. So on
/// Prisma a placed pending order needs no status move at all, and making one would be actively wrong:
/// `ACCEPTED` there is invisible to the pending scans (`risk_hook.rs` and
/// `get_pending_orders_for_symbol` both match `PENDING`), so the order would rest forever.
pub async fn set_status(
    tx: &mut sqlx::PgTransaction<'_>,
    book: Book,
    order_id: &str,
    status: OrderStatus,
) -> Result<(), sqlx::Error> {
    if book == Book::Prisma {
        debug_assert_eq!(status, OrderStatus::Accepted, "the Prisma book has no intermediate order states");
        return Ok(());
    }
    sqlx::query(
        "UPDATE orders SET status = $1::order_status, updated_at = now() WHERE id = $2",
    )
    .bind(status_to_str(status))
    .bind(order_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Rejects the order. On the Prisma book this is a compare-and-set for the same reason `set_filled`
/// is: an order that has already been answered must not be answered again, and a reject landing on top
/// of a fill would tell the trader their open position was refused.
pub async fn set_rejected(
    tx: &mut sqlx::PgTransaction<'_>,
    book: Book,
    order_id: &str,
    reason: &str,
) -> Result<bool, sqlx::Error> {
    let result = match book {
        Book::Legacy => {
            sqlx::query(
                r#"UPDATE orders SET status = 'REJECTED'::order_status, reject_reason = $1,
           updated_at = now() WHERE id = $2"#,
            )
            .bind(reason)
            .bind(order_id)
            .execute(&mut **tx)
            .await?
        }
        Book::Prisma => {
            sqlx::query(
                r#"UPDATE "Order" SET status = 'REJECTED'::"OrderStatus", "rejectionReason" = $1,
                     "executedAt" = now(), "executionMode" = COALESCE("executionMode", 'AUTO'), "updatedAt" = now()
                   WHERE id = $2 AND status = 'PENDING'::"OrderStatus""#,
            )
            .bind(reason)
            .bind(order_id)
            .execute(&mut **tx)
            .await?
        }
    };
    Ok(result.rows_affected() == 1)
}

/// Marks the order filled. **Returns false when it was not this caller's to fill.**
///
/// THE DOUBLE-FILL GUARD (design §5b.3). On the Prisma book this is a compare-and-set on the status:
/// `WHERE id = $1 AND status = 'PENDING'`. Only one writer can move a PENDING order to FILLED, so a
/// second filler -- another engine pass, the web's own fill path during a failover, a retried request
/// -- matches zero rows and must abort its transaction rather than open a second position for one
/// order. That is the same discipline `lib/order-expiry.ts` already uses on the web side, and the
/// reason it has to exist here is that `"Position"."originOrderId"` is UNIQUE: a second position for
/// the same order would fail anyway, but as a constraint violation in the middle of a money
/// transaction instead of a clean "someone else has this".
///
/// `routing` is the position's book type (A_BOOK / B_BOOK), which `lib/dealing.ts` writes in this same
/// UPDATE; None leaves it alone (Stage 3 has not resolved it yet, Stage 4 passes it).
///
/// Prisma's `"Order"` has no filled-volume column -- a fill is whole there -- so `filled_volume` is
/// legacy-only. `execution::execute_market_order` fills the whole requested volume on the Internal
/// strategy, so nothing is lost; a partial-fill strategy would need a column first.
pub async fn set_filled(
    tx: &mut sqlx::PgTransaction<'_>,
    book: Book,
    order_id: &str,
    filled_price: Decimal,
    filled_volume: Decimal,
    routing: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let result = match book {
        Book::Legacy => {
            sqlx::query(
                r#"UPDATE orders SET status = 'FILLED'::order_status, filled_price = $1,
           filled_volume = $2, updated_at = now() WHERE id = $3"#,
            )
            .bind(filled_price)
            .bind(filled_volume)
            .bind(order_id)
            .execute(&mut **tx)
            .await?
        }
        Book::Prisma => {
            sqlx::query(
                r#"UPDATE "Order" SET status = 'FILLED'::"OrderStatus", "filledPrice" = $1,
                     "filledAt" = now(), "executedAt" = now(),
                     "executionMode" = COALESCE("executionMode", 'AUTO'),
                     routing = COALESCE($2, routing), "updatedAt" = now()
                   WHERE id = $3 AND status = 'PENDING'::"OrderStatus""#,
            )
            .bind(filled_price)
            .bind(routing)
            .bind(order_id)
            .execute(&mut **tx)
            .await?
        }
    };
    Ok(result.rows_affected() == 1)
}

// ---- L2 Stage 4: the position insert against the triggers that complete it --------------------------

#[cfg(test)]
mod position_insert_tests {
    use super::{prisma_position_insert_columns, BookType, PRISMA_POSITION_INSERT};

    /// §7's top risk, caught at compile-and-test time rather than in production.
    ///
    /// The column list is PARSED OUT OF THE SQL that actually runs, so this is not a check against a
    /// copy that could drift: adding `groupCategoryAtOpen` to the insert -- which would silently stop
    /// the stamp trigger and open A-book positions unhedged -- fails here.
    #[test]
    fn the_position_insert_names_no_trigger_owned_column() {
        let columns = prisma_position_insert_columns();
        let bypassed = crate::book::triggers_bypassed_by(&columns);
        assert!(
            bypassed.is_empty(),
            "the position insert names a column a BEFORE INSERT trigger fills: {:?}",
            bypassed.iter().map(|t| (t.trigger, t.column, t.bypass_consequence)).collect::<Vec<_>>()
        );
        // not vacuous: the parse really did find the real column list
        assert_eq!(columns.len(), 11, "parsed {columns:?}");
        for required in ["id", "brokerId", "accountId", "symbolId", "originOrderId", "side", "volume", "openPrice", "bookType"] {
            assert!(columns.contains(&required), "the insert must name {required}: {columns:?}");
        }
        // and the two the database owns are absent
        for owned in ["ticket", "groupCategoryAtOpen"] {
            assert!(!columns.contains(&owned), "{owned} belongs to a trigger, not to this insert");
        }
        // status is not named either: the column DEFAULTs to OPEN
        assert!(!columns.contains(&"status"));
        // the trigger columns are not smuggled in through the VALUES list or the RETURNING clause
        assert!(!PRISMA_POSITION_INSERT.contains("groupCategoryAtOpen"), "the statement must not mention the stamp column at all");
    }

    /// `lib/group-pricing.ts resolveBookType`, every category it can be given. A_BOOK and COVERAGE are
    /// market-facing; the rest stay in the broker's own book. Getting this wrong misroutes a hedge.
    #[test]
    fn the_book_type_matches_the_webs_rule_for_every_category() {
        for category in ["A_BOOK", "COVERAGE"] {
            assert_eq!(BookType::of_category(Some(category)), BookType::ABook, "{category}");
        }
        for category in ["B_BOOK", "DEALING", "REVERSAL"] {
            assert_eq!(BookType::of_category(Some(category)), BookType::BBook, "{category}");
        }
        // an account with no group, and anything unrecognised, book B -- the safe side
        assert_eq!(BookType::of_category(None), BookType::BBook);
        assert_eq!(BookType::of_category(Some("SOMETHING_NEW")), BookType::BBook);
        assert_eq!((BookType::ABook.as_str(), BookType::BBook.as_str()), ("A_BOOK", "B_BOOK"));
    }
}

// ---- where a position's risk goes (L2 Stage 4) ------------------------------------------------------

/// Prisma's `BookType`. Mirrors `lib/group-pricing.ts resolveBookType`, which is the ONLY thing that
/// decides this on the web, so the engine must not invent its own rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BookType {
    /// Market-facing exposure: bridged to a liquidity provider, or the broker's own hedge account.
    ABook,
    /// The broker's own book.
    BBook,
}

impl BookType {
    /// `resolveBookType(category)`: A_BOOK bridges to a real LP and COVERAGE is the offsetting leg of
    /// a booked client position -- both are real market-facing exposure. B_BOOK / DEALING / REVERSAL
    /// all stay in the broker's own book. An unknown or missing category books B, the safe side.
    pub fn of_category(category: Option<&str>) -> Self {
        match category {
            Some("A_BOOK") | Some("COVERAGE") => Self::ABook,
            _ => Self::BBook,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ABook => "A_BOOK",
            Self::BBook => "B_BOOK",
        }
    }
}

/// The account's group's routing category, for `BookType::of_category`.
///
/// NOTE this is its own round-trip, once per order. It could ride along on `get_ask_levels` (which
/// already LEFT JOINs the same `"Group"` row) at no extra cost, and should if the 200 ms fill budget
/// ever needs it -- but that function's job is the pricing rule, and folding routing into it would
/// make a pricing change able to break routing. Correctness first; the fold is a measured optimisation.
///
/// `None` = the account has no group (`Account.groupId` is nullable), which `of_category` books B.
pub async fn get_routing_category(pool: &PgPool, account_id: &str) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        r#"SELECT g.category::text FROM "Account" a LEFT JOIN "Group" g ON g.id = a."groupId" WHERE a.id = $1"#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(c,)| c))
}

pub struct NewPosition {
    pub broker_id: String,
    pub account_id: String,
    pub symbol: String,
    /// `Symbol.id` -- Prisma's `"Position"."symbolId"` is a NOT NULL FK (L2 Stage 2).
    pub symbol_id: String,
    pub origin_order_id: String,
    pub side: OrderSide,
    pub volume: Decimal,
    pub open_price: Decimal,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
    /// Where this position's risk goes. Legacy-book inserts ignore it.
    pub book_type: BookType,
}

/// The `"Position"` insert, as ONE string, so the column list below can be checked against the SQL
/// that actually runs instead of against a copy of it.
///
/// WHAT IS NOT IN IT, and must never be: `ticket` and `groupCategoryAtOpen`. Both are filled by BEFORE
/// INSERT triggers (`crate::book::POSITION_OPEN_TRIGGERS`), and the second one fires only when the
/// insert left it NULL -- so naming it would silently open A-book positions unhedged. The unit test
/// `the_position_insert_names_no_trigger_owned_column` parses this very string and refuses that.
const PRISMA_POSITION_INSERT: &str = r#"INSERT INTO "Position"
    (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", "slPrice", "tpPrice", "bookType")
  VALUES ($1, $2, $3, $4, $5, $6::"OrderSide", $7, $8, $9, $10, $11::"BookType")
  RETURNING "openedAt""#;

/// The columns `PRISMA_POSITION_INSERT` names, in order. Derived from the SQL rather than maintained
/// beside it: the text between its first pair of brackets, split on commas, unquoted.
pub fn prisma_position_insert_columns() -> Vec<&'static str> {
    let open = PRISMA_POSITION_INSERT.find('(').expect("the insert names its columns");
    let close = PRISMA_POSITION_INSERT[open..].find(')').expect("the column list closes") + open;
    PRISMA_POSITION_INSERT[open + 1..close]
        .split(',')
        .map(|c| c.trim().trim_matches('"'))
        .collect()
}

/// Opens the position. Returns its id and, on the Prisma book, the `openedAt` the row ended up with
/// (the column DEFAULTs to now(), and the IN deal's `executedAt` must be that exact value -- see
/// `write_open_deal` and lib/deals.ts, which reads it off the position for the same reason).
///
/// `status` is not named on the Prisma book either: `"Position".status` DEFAULTs to OPEN.
pub async fn insert_position(
    tx: &mut sqlx::PgTransaction<'_>,
    book: Book,
    position: &NewPosition,
) -> Result<(String, Option<chrono::DateTime<Utc>>), sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    match book {
        Book::Legacy => {
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
            Ok((id, None))
        }
        Book::Prisma => {
            let (opened_at,): (chrono::DateTime<Utc>,) = sqlx::query_as(PRISMA_POSITION_INSERT)
                .bind(&id)
                .bind(&position.broker_id)
                .bind(&position.account_id)
                .bind(&position.symbol_id)
                .bind(&position.origin_order_id)
                .bind(side_to_str(position.side))
                .bind(position.volume)
                .bind(position.open_price)
                .bind(position.sl_price)
                .bind(position.tp_price)
                .bind(position.book_type.as_str())
                .fetch_one(&mut **tx)
                .await?;
            Ok((id, Some(opened_at)))
        }
    }
}

#[derive(Debug)]
pub struct PositionRow {
    pub id: String,
    pub account_id: String,
    pub side: OrderSide,
    pub status: PositionStatus,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
    pub volume: Decimal,
    pub open_price: Decimal,
    pub contract_size: Decimal,
}

/// Single-position lookup by id, for the modify-SL/TP and manual-close
/// paths' ownership/status checks — narrower than
/// `get_open_positions_with_market` (account-scoped, no live-price join),
/// which exists for a different caller (the margin monitor) with a
/// different shape need. The `Symbol` join (same as
/// `get_open_positions_with_market`'s) exists only so `close_position`
/// has `contract_size` for its own P&L calc — `modify_position_sl_tp`
/// simply ignores the extra fields.
pub async fn get_position(pool: &PgPool, position_id: &str) -> Result<Option<PositionRow>, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let row = sqlx::query_as::<_, (String, String, String, String, Option<Decimal>, Option<Decimal>, Decimal, Decimal, Decimal)>(
        r#"SELECT p.id, p.account_id, p.side::text, p.status::text, p.sl_price, p.tp_price,
                  p.volume, p.open_price, s."contractSize"
           FROM positions p
           JOIN "Symbol" s ON s.name = p.symbol
           WHERE p.id = $1"#,
    )
    .bind(position_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(id, account_id, side, status, sl_price, tp_price, volume, open_price, contract_size)| PositionRow {
        id,
        account_id,
        side: side_from_str(&side),
        status: position_status_from_str(&status),
        sl_price,
        tp_price,
        volume,
        open_price,
        contract_size,
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
/// Charges the open commission.
///
/// LEGACY: the position's column plus a `ledger_entries` row. Note what it does NOT do -- **it never
/// touched the balance**. On the engine's own tables that was invisible, because nothing reads them.
///
/// PRISMA: `lib/group-pricing.ts chargeCommission`, step for step, because this one moves real money:
///   1. the `"Account"` row is locked FOR UPDATE and its balance read -- so two fills on one account
///      cannot lose each other's charge (the same lock `lib/account-lock.ts` takes);
///   2. the balance is written;
///   3. a COMMISSION `"Transaction"` records the amount NEGATED with balanceBefore / balanceAfter, and
///      `referenceType = 'Position'` / `referenceId` -- which is how `write_open_deal` finds it again,
///      and how every commission report adds it up;
///   4. `"Position".commission` is INCREMENTED, not set: the column is cumulative, and increment is
///      also what makes a retry safe.
///
/// The note is the web's own text verbatim. `normalize()` matches decimal.js's `toString`, which drops
/// trailing zeros, so a 3.00/lot charge reads "@ 3/lot" on both paths rather than "@ 3.00/lot" on one.
pub async fn record_commission(
    tx: &mut sqlx::PgTransaction<'_>,
    book: Book,
    broker_id: &str,
    account_id: &str,
    position_id: &str,
    commission_per_lot: Decimal,
    volume: Decimal,
) -> Result<(), sqlx::Error> {
    let commission = commission_per_lot * volume;
    // `lte(0)` on the web: a zero or negative per-lot rate charges nothing at all.
    if commission <= Decimal::ZERO {
        return Ok(());
    }

    match book {
        Book::Legacy => {
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
        }
        Book::Prisma => {
            // FOR NO KEY UPDATE, not FOR UPDATE: the same lock lib/account-lock.ts takes, and the same
            // one authority::lock_owner_in_tx takes for the same reason -- it serialises writers to
            // the row without blocking the FK references other inserts in this transaction need.
            // Found by comparing the two paths' statement logs during the L2 latency measurement.
            let (balance_before,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1 FOR NO KEY UPDATE"#)
                .bind(account_id)
                .fetch_one(&mut **tx)
                .await?;
            let balance_after = balance_before - commission;

            sqlx::query(r#"UPDATE "Account" SET balance = $1, "updatedAt" = now() WHERE id = $2"#)
                .bind(balance_after)
                .bind(account_id)
                .execute(&mut **tx)
                .await?;

            sqlx::query(
                r#"INSERT INTO "Transaction"
                     (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter",
                      "referenceType", "referenceId", note, "updatedAt")
                   VALUES ($1, $2, $3, 'COMMISSION'::"TransactionType", 'COMPLETED'::"TransactionStatus",
                           $4, $5, $6, 'Position', $7, $8, now())"#,
            )
            .bind(Uuid::new_v4().to_string())
            .bind(broker_id)
            .bind(account_id)
            .bind(-commission)
            .bind(balance_before)
            .bind(balance_after)
            .bind(position_id)
            .bind(format!("Commission: {} lots @ {}/lot", volume.normalize(), commission_per_lot.normalize()))
            .execute(&mut **tx)
            .await?;

            sqlx::query(r#"UPDATE "Position" SET commission = commission + $1 WHERE id = $2"#)
                .bind(commission)
                .bind(position_id)
                .execute(&mut **tx)
                .await?;
        }
    }

    Ok(())
}

/// The IN `"Deal"` for a position just opened in this transaction, plus `"Position".initialVolume`.
/// Prisma-book only: the legacy tables have no deal model at all.
///
/// `lib/deals.ts writeOpenDealInTx`, with two details that matter and are easy to get wrong:
///
/// - **the commission is SUMMED back out of the ledger**, not passed in. The Transaction rows are the
///   record; summing them means the deal can never disagree with the money that actually moved, and a
///   position charged twice reports both. The sum is NEGATIVE, because `record_commission` writes the
///   amount negated -- do not flip it, every reader expects a charge.
/// - **`transactionId` is set only when there is exactly ONE commission row.** The column is UNIQUE,
///   so pointing two deals at one transaction is impossible; with several rows there is no single one
///   to name, and the web leaves it null for the same reason.
///
/// `executedAt` is the position's own `openedAt`, `source` the opening order's, and `reason` the
/// caller's (CLIENT for a client fill -- app/api/trade/orders/route.ts:794). `ticket` is not supplied:
/// `deal_ticket_seq` owns it.
pub async fn write_open_deal(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    reason: &str,
) -> Result<OpenDeal, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let (broker_id, account_id, symbol_id, side, volume, open_price, opened_at, origin_order_id, source, category): (
        String,
        String,
        String,
        String,
        Decimal,
        Decimal,
        chrono::DateTime<Utc>,
        String,
        String,
        Option<String>,
    ) = sqlx::query_as(
        r#"SELECT p."brokerId", p."accountId", p."symbolId", p.side::text, p.volume, p."openPrice",
                  p."openedAt", p."originOrderId", o.source::text, p."groupCategoryAtOpen"::text
             FROM "Position" p JOIN "Order" o ON o.id = p."originOrderId"
            WHERE p.id = $1"#,
    )
    .bind(position_id)
    .fetch_one(&mut **tx)
    .await?;

    let (commission, rows, only_id): (Decimal, i64, Option<String>) = sqlx::query_as(
        r#"SELECT COALESCE(SUM(amount), 0), count(*), CASE WHEN count(*) = 1 THEN min(id) END
             FROM "Transaction"
            WHERE "referenceType" = 'Position' AND "referenceId" = $1 AND type = 'COMMISSION'::"TransactionType""#,
    )
    .bind(position_id)
    .fetch_one(&mut **tx)
    .await?;
    debug_assert!(rows >= 0);

    let deal_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO "Deal"
             (id, "brokerId", "accountId", "positionId", "orderId", "symbolId", side, entry, reason, source,
              volume, price, commission, "transactionId", "executedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7::"OrderSide", 'IN'::"DealEntry", $8::"DealReason", $9::"OrderSource",
                   $10, $11, $12, $13, $14)"#,
    )
    .bind(&deal_id)
    .bind(&broker_id)
    .bind(&account_id)
    .bind(position_id)
    .bind(&origin_order_id)
    .bind(&symbol_id)
    .bind(&side)
    .bind(reason)
    .bind(&source)
    .bind(volume)
    .bind(open_price)
    .bind(commission)
    .bind(&only_id)
    .bind(opened_at)
    .execute(&mut **tx)
    .await?;

    sqlx::query(r#"UPDATE "Position" SET "initialVolume" = volume WHERE id = $1"#)
        .bind(position_id)
        .execute(&mut **tx)
        .await?;

    Ok(OpenDeal { deal_id, broker_id, account_id, group_category_at_open: category })
}

/// What the IN deal leaves behind for the hedge gate: the deal to key an intent on, and the category
/// the stamp trigger actually wrote (read back, never assumed -- a missed stamp must not be hedged on
/// the engine's guess).
#[derive(Debug, Clone)]
pub struct OpenDeal {
    pub deal_id: String,
    pub broker_id: String,
    pub account_id: String,
    pub group_category_at_open: Option<String>,
}

/// L2 Stage 5 -- the hedge intent, by design OPTION (b).
///
/// The engine does NOT write `"HedgeIntent"`. It queues a `"PostCloseEffect"` of kind
/// `POSITION_OPENED` in the SAME transaction as the fill, and the web's worker
/// (`lib/post-close.ts positionOpenedSteps`) writes the intent. Three reasons that is the right side
/// of the line:
///
/// - the invariant "an intent exists if and only if its deal committed" stays in ONE place. The effect
///   row commits with the deal, so a rolled-back fill queues nothing and a committed one always has
///   its follow-up.
/// - `lib/hedge.ts hedgeDealInTx` keeps being the only intent writer, so the full routing rule
///   (`hedgeRouteOf`: the coverage-account check, the bookType/category disagreement case) is applied
///   by the code that owns it rather than reimplemented here.
/// - the engine needs no INSERT privilege on `"HedgeIntent"` at all -- see
///   `authority::ORDER_PATH_PRIVILEGES`, which deliberately omits it.
///
/// THE GATE. Queued only when the stamp says `A_BOOK`, which is exactly `hedgeDealInTx`'s own first
/// test (`isHedgedCategory`). That is the NECESSARY condition; the web still applies the sufficient
/// one, so being wrong here can only ever queue a row the web then declines -- never skip a hedge the
/// web would have written. A B-book fill, which is nearly all of them, costs nothing.
///
/// `kind` is plain text on `"PostCloseEffect"`, so this needs no migration. `dedupeKey` is unique and
/// the insert is ON CONFLICT DO NOTHING, so a retried fill queues one row, as the close side does.
///
/// DEPLOY ORDER MATTERS: `lib/post-close.ts` THROWS on a kind it does not know, so the web must ship
/// its branch BEFORE the engine ever writes this kind, or the worker error-loops on the row. (Rolling
/// back is the reverse: engine first.)
pub async fn enqueue_position_opened(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    opened: &OpenDeal,
) -> Result<bool, sqlx::Error> {
    if opened.group_category_at_open.as_deref() != Some("A_BOOK") {
        return Ok(false);
    }
    let payload = serde_json::json!({ "dealId": opened.deal_id });
    let result = sqlx::query(
        r#"INSERT INTO "PostCloseEffect" (id, kind, "dedupeKey", "brokerId", "accountId", "positionId", payload)
           VALUES ($1, 'POSITION_OPENED', $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT ("dedupeKey") DO NOTHING"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(format!("open:{}:{}", position_id, opened.deal_id))
    .bind(&opened.broker_id)
    .bind(&opened.account_id)
    .bind(position_id)
    .bind(payload.to_string())
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
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
    /// `Symbol.id`. The engine's own lowercase tables key a position by symbol NAME (`positions.symbol`),
    /// but Prisma's book keys it by id (`"Position"."symbolId"`, a required FK), so the L2 cutover needs the
    /// id on every path that opens a position. Resolved here rather than in a second query because this
    /// function already joins `"Symbol"` by name for the digits.
    ///
    /// `Symbol.name` is globally UNIQUE (schema.prisma:1731), so the name -> id lookup is unambiguous and
    /// needs no broker scoping -- a broker's own view of a symbol is the `"BrokerSymbol"` row LEFT JOINed
    /// below, which may be absent without changing which `Symbol` this is.
    pub symbol_id: String,
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
    (String, i32, Decimal, bool, Decimal, Decimal, Decimal, Option<Decimal>, Decimal, Decimal, Decimal);

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
        r#"SELECT s.id, s.digits, COALESCE(bs."spreadMarkup", 0), COALESCE(bs.enabled, true),
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
        |(symbol_id, digits, spread_markup, enabled, min_lot, max_lot, lot_step, max_exposure, commission_per_lot, swap_long, swap_short)| {
            BrokerSymbolConfig {
                symbol_id,
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

/// The account's resolved pricing rule for this symbol, read in one round-trip.
///
/// FLIP L2 (2026-11-02): the fill path used to take `BrokerSymbol.spreadMarkup` straight off
/// `get_broker_symbol_config` above, which is only the BOTTOM of the hierarchy. The rule a trader is
/// quoted at resolves account → group → broker and can be a target-spread rule rather than a markup
/// (`market_data::ask_markup::resolve`, mirroring lib/ask-markup.ts), so the fill has to resolve the
/// same way or it charges a different price from the one on screen.
///
/// Reads the levels fresh rather than from `PricingSnapshot`'s cache on purpose: this runs once per
/// order, not once per tick, so a round-trip is cheap here and a stale markup on a FILL is not an
/// acceptable trade for it. The column set and the COVERAGE test mirror `PricingSnapshot::levels`
/// exactly — a COVERAGE group, or being the broker's own coverage account, prices raw.
///
/// `None` = no such `Symbol` row, the same benign case `get_broker_symbol_config` returns `None` for.
pub async fn get_ask_levels(
    pool: &PgPool,
    broker_id: &str,
    account_id: &str,
    symbol: &str,
) -> Result<Option<AskLevels>, sqlx::Error> {
    type Row = (i32, bool, bool, Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<Decimal>);
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT s.digits,
                  COALESCE(b."pricingEngineEnabled", false),
                  COALESCE(g.category::text = 'COVERAGE', false) OR COALESCE(b."coverageAccountId" = a.id, false),
                  bs."spreadMarkup",
                  gsc."spreadMarkup", gsc."targetTotalSpreadPips",
                  acs."spreadMarkup", acs."targetTotalSpreadPips"
             FROM "Symbol" s
             LEFT JOIN "Broker" b ON b.id = $1
             LEFT JOIN "Account" a ON a.id = $2
             LEFT JOIN "Group" g ON g.id = a."groupId"
             LEFT JOIN "BrokerSymbol" bs ON bs."symbolId" = s.id AND bs."brokerId" = $1
             LEFT JOIN "GroupSymbolConfig" gsc ON gsc."symbolId" = s.id AND gsc."groupId" = a."groupId"
             LEFT JOIN "AccountSymbolConfig" acs ON acs."symbolId" = s.id AND acs."accountId" = $2
             WHERE s.name = $3"#,
    )
    .bind(broker_id)
    .bind(account_id)
    .bind(symbol)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(digits, pricing_engine, coverage, broker, g_markup, g_target, a_markup, a_target)| AskLevels {
        pricing_engine,
        coverage,
        digits,
        broker,
        group: Level { markup: g_markup, target: g_target },
        account_symbol: Level { markup: a_markup, target: a_target },
    }))
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
    /// This order's account's pricing levels, read in the same query as the order (see
    /// `get_pending_orders_for_symbol`). `None` = no `Symbol` row, the benign fallback-to-raw case.
    /// Carried on the order so the per-tick scan still costs ONE query: the entry test and the fill
    /// then price off the same resolved rule, which is the whole point -- see pending_orders.rs.
    pub ask_levels: Option<AskLevels>,
}

/// Every ACCEPTED LIMIT/STOP order for one symbol — narrowed by symbol
/// (unlike the margin monitor's account scan, which can't narrow by
/// symbol since floating P&L across *any* symbol affects an account's
/// equity) because a pending order can only ever trigger off its own
/// symbol's price.
pub async fn get_pending_orders_for_symbol(
    pool: &PgPool,
    book: Book,
    symbol: &str,
) -> Result<Vec<PendingOrder>, sqlx::Error> {
    if book == Book::Prisma {
        return get_prisma_pending_orders_for_symbol(pool, symbol).await;
    }
    // The five config LEFT JOINs mirror `get_ask_levels` / `PricingSnapshot::levels` column for
    // column, and ride along on the scan that was already happening once per tick: a resting order's
    // entry has to be compared against THIS ACCOUNT's price, so the rule belongs here rather than in
    // one extra read per order. Read by name (`sqlx::Row`, as book.rs does) because the row is wider
    // than the 16 columns sqlx's tuple `FromRow` goes up to.
    let rows = sqlx::query(
        r#"SELECT o.id, o.broker_id, o.account_id, o.symbol, o.side::text AS side, o.type::text AS otype,
                  o.volume, o.requested_price, o.sl_price, o.tp_price,
                  s.digits AS digits,
                  COALESCE(b."pricingEngineEnabled", false) AS pricing_engine,
                  (COALESCE(g.category::text = 'COVERAGE', false) OR COALESCE(b."coverageAccountId" = a.id, false)) AS coverage,
                  bs."spreadMarkup" AS broker_markup,
                  gsc."spreadMarkup" AS group_markup, gsc."targetTotalSpreadPips" AS group_target,
                  acs."spreadMarkup" AS account_markup, acs."targetTotalSpreadPips" AS account_target
             FROM orders o
             LEFT JOIN "Symbol" s ON s.name = o.symbol
             LEFT JOIN "Broker" b ON b.id = o.broker_id
             LEFT JOIN "Account" a ON a.id = o.account_id
             LEFT JOIN "Group" g ON g.id = a."groupId"
             LEFT JOIN "BrokerSymbol" bs ON bs."symbolId" = s.id AND bs."brokerId" = o.broker_id
             LEFT JOIN "GroupSymbolConfig" gsc ON gsc."symbolId" = s.id AND gsc."groupId" = a."groupId"
             LEFT JOIN "AccountSymbolConfig" acs ON acs."symbolId" = s.id AND acs."accountId" = o.account_id
            WHERE o.symbol = $1 AND o.status = 'ACCEPTED'::order_status
              AND o.type IN ('LIMIT'::order_type, 'STOP'::order_type)"#,
    )
    .bind(symbol)
    .fetch_all(pool)
    .await?;

    rows.iter().map(pending_order_from_row).collect()
}

/// One scanned row -> a `PendingOrder`. Shared by both books' queries, which alias their columns to
/// the same names on purpose: the two statements differ in WHERE and in how they reach `"Symbol"`,
/// never in what a row means.
fn pending_order_from_row(r: &sqlx::postgres::PgRow) -> Result<PendingOrder, sqlx::Error> {
    use sqlx::Row;
    let side: String = r.try_get("side")?;
    let order_type: String = r.try_get("otype")?;
    // digits is NULL only when no "Symbol" row joined, which is exactly the no-rule
    // (fall back to the raw tick) case both fill sites have always allowed for.
    let digits: Option<i32> = r.try_get("digits")?;
    let ask_levels = match digits {
        Some(digits) => Some(AskLevels {
            pricing_engine: r.try_get("pricing_engine")?,
            coverage: r.try_get("coverage")?,
            digits,
            broker: r.try_get("broker_markup")?,
            group: Level { markup: r.try_get("group_markup")?, target: r.try_get("group_target")? },
            account_symbol: Level { markup: r.try_get("account_markup")?, target: r.try_get("account_target")? },
        }),
        None => None,
    };
    Ok(PendingOrder {
        id: r.try_get("id")?,
        broker_id: r.try_get("broker_id")?,
        account_id: r.try_get("account_id")?,
        symbol: r.try_get("symbol")?,
        side: side_from_str(&side),
        order_type: type_from_str(&order_type),
        volume: r.try_get("volume")?,
        requested_price: r.try_get("requested_price")?,
        sl_price: r.try_get("sl_price")?,
        tp_price: r.try_get("tp_price")?,
        ask_levels,
    })
}

/// Atomically claims a pending order for routing — `UPDATE ... WHERE
/// status = 'ACCEPTED'` means only one caller can win this if two ticks
/// (or a tick and the same order re-appearing in a later scan) both try
/// to trigger the same order concurrently; the loser sees
/// `rows_affected() == 0` and treats that as "someone else is already
/// handling this," not an error. Same idempotency pattern as
/// `close_position_with_ledger_entry`.
/// The Prisma book's resting LIMIT/STOP orders for one symbol, with the same five pricing LEFT JOINs.
///
/// Two differences from the legacy query, both forced by the schema rather than chosen:
///
/// - **`status = 'PENDING'`, not ACCEPTED.** That is what the web writes for a resting order
///   (app/api/trade/orders/route.ts:855) and what the other pending scan already matches
///   (`market-data/src/risk_hook.rs`). Prisma's `OrderStatus` has no ACCEPTED-then-ROUTING pair.
/// - **joined on `"symbolId"`, not on the name.** The legacy table stores the symbol as text and the
///   join was `s.name = o.symbol`; here the FK is the join, which also means a renamed symbol cannot
///   orphan a resting order.
///
/// `requestedPrice IS NOT NULL` guards the same thing `risk_hook.rs` guards: a LIMIT/STOP with no
/// entry cannot be triggered, and `PendingOrder.requested_price` is not nullable.
async fn get_prisma_pending_orders_for_symbol(pool: &PgPool, symbol: &str) -> Result<Vec<PendingOrder>, sqlx::Error> {
    let rows = sqlx::query(
        r#"SELECT o.id, o."brokerId" AS broker_id, o."accountId" AS account_id, s.name AS symbol,
                  o.side::text AS side, o.type::text AS otype,
                  o.volume, o."requestedPrice" AS requested_price, o."slPrice" AS sl_price, o."tpPrice" AS tp_price,
                  s.digits AS digits,
                  COALESCE(b."pricingEngineEnabled", false) AS pricing_engine,
                  (COALESCE(g.category::text = 'COVERAGE', false) OR COALESCE(b."coverageAccountId" = a.id, false)) AS coverage,
                  bs."spreadMarkup" AS broker_markup,
                  gsc."spreadMarkup" AS group_markup, gsc."targetTotalSpreadPips" AS group_target,
                  acs."spreadMarkup" AS account_markup, acs."targetTotalSpreadPips" AS account_target
             FROM "Order" o
             JOIN "Symbol" s ON s.id = o."symbolId"
             LEFT JOIN "Broker" b ON b.id = o."brokerId"
             LEFT JOIN "Account" a ON a.id = o."accountId"
             LEFT JOIN "Group" g ON g.id = a."groupId"
             LEFT JOIN "BrokerSymbol" bs ON bs."symbolId" = s.id AND bs."brokerId" = o."brokerId"
             LEFT JOIN "GroupSymbolConfig" gsc ON gsc."symbolId" = s.id AND gsc."groupId" = a."groupId"
             LEFT JOIN "AccountSymbolConfig" acs ON acs."symbolId" = s.id AND acs."accountId" = o."accountId"
            WHERE s.name = $1 AND o.status = 'PENDING'::"OrderStatus"
              AND o.type IN ('LIMIT'::"OrderType", 'STOP'::"OrderType")
              AND o."requestedPrice" IS NOT NULL"#,
    )
    .bind(symbol)
    .fetch_all(pool)
    .await?;
    rows.iter().map(pending_order_from_row).collect()
}

/// Claims the order for this pass.
///
/// LEGACY: ACCEPTED -> ROUTING, so a second scan skips it early.
///
/// PRISMA: **nothing to do, and that is deliberate.** Prisma's `OrderStatus` has no intermediate
/// state to park the order in, and it does not need one: `lib/pending-trigger.ts` -- the WEB's own
/// trigger for exactly these orders -- claims by going straight PENDING -> FILLED in ONE
/// status-guarded update (`updateMany({ where: { id, status: "PENDING" } ... })`), which is the same
/// compare-and-set `set_filled` does here. So the fill IS the claim.
///
/// What that costs: two passes for one tick both run the admission checks before one of them loses.
/// What it buys: one atomic decision per order instead of two, no state a crash between them could
/// leave the order stuck in, and the same discipline on both sides of the cutover. A reject is equally
/// safe -- `set_rejected` is guarded on PENDING too, so only one answer lands.
pub async fn try_claim_order_for_routing(
    tx: &mut sqlx::PgTransaction<'_>,
    book: Book,
    order_id: &str,
) -> Result<bool, sqlx::Error> {
    if book == Book::Prisma {
        return Ok(true);
    }
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

/// This account's group, if any -- `NULL` is a real, valid state (see
/// Prisma schema's own comment on `Account.groupId`: any account created
/// before Group existed, or never assigned one), not an error. Used by
/// the monitor to look up which entry of a loaded `ThresholdsByGroup`
/// (see margin::resolve_thresholds) this specific account should
/// evaluate against.
pub async fn get_account_group_id(pool: &PgPool, account_id: &str) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query_as::<_, (Option<String>,)>(r#"SELECT "groupId" FROM "Account" WHERE id = $1"#)
        .bind(account_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|(group_id,)| group_id))
}

/// Every group's own real, broker-configured `marginCallLevel`/
/// `stopOutLevel` (risk item 2 -- previously nothing ever read these two
/// columns from anywhere in this crate; every account evaluated against
/// margin::MarginThresholds::default() instead, regardless of what a
/// broker admin actually set per group). Cheap enough (one row per
/// group, brokers have few) to re-run on every monitor pass rather than
/// needing a separate "group changed" event for hot-reload -- a group
/// edit takes effect within one poll cycle / one price tick, whichever
/// comes first.
pub async fn load_group_thresholds(pool: &PgPool) -> Result<margin::ThresholdsByGroup, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, Decimal, Decimal)>(
        r#"SELECT id, "marginCallLevel", "stopOutLevel" FROM "Group""#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, call_level, stop_out_level)| (id, margin::MarginThresholds { call_level, stop_out_level }))
        .collect())
}

/// Every DISTINCT group id currently referenced by at least one account
/// -- the "known_group_ids" the startup/live-order guard
/// (margin::missing_group_thresholds) checks a freshly loaded
/// ThresholdsByGroup against. Deliberately NOT "every group that
/// exists" -- an unused group with no accounts in it can't cause a real
/// account to evaluate with the wrong thresholds, so it shouldn't be
/// able to block order acceptance either.
pub async fn get_distinct_account_group_ids(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String,)>(r#"SELECT DISTINCT "groupId" FROM "Account" WHERE "groupId" IS NOT NULL"#)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
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
///
/// `EXTRACT(...)` returns Postgres `NUMERIC`, not `double precision` --
/// sqlx's `f64` decode only accepts a real `FLOAT8` column and throws a
/// `ColumnDecode` "mismatched types" error against a bare `NUMERIC` result
/// (hit live during the daily swap rollover job). The explicit `::float8`
/// cast makes the wire type match what's being decoded into.
pub async fn get_current_weekday(pool: &PgPool) -> Result<i32, sqlx::Error> {
    let (dow,): (f64,) = sqlx::query_as("SELECT EXTRACT(ISODOW FROM CURRENT_DATE)::float8").fetch_one(pool).await?;
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
    /// quote currency -> account currency (fx.rs, Stage 2 F2). 1 for the same currency. A position whose
    /// rate cannot be resolved is given bid/ask None instead (unpriced), never a guessed rate.
    pub fx_rate: Decimal,
    /// BrokerSymbol.hedgedMarginPct of this position's symbol (calc::used_margin); 200 = no reduction.
    pub hedged_margin_pct: Decimal,
    /// The account's ask rule for this symbol (market_data::ask_markup, 2026-09-26): a SELL closes, triggers and is
    /// valued at the account's marked-up ask. None = the raw ask.
    pub ask_rule: Option<market_data::ask_markup::AskRule>,
    /// Where `bid` / `ask` came from and the tick's time (book.rs price_rows). None = unpriced, or a caller that does
    /// not track it (the legacy order-path table, the margin trigger's measure, the parity scenarios). An engine close
    /// records it in its POSITION_CLOSED payload as the trigger tick (book::enqueue_post_close).
    pub quote: Option<QuoteStamp>,
}

/// Which price priced a position (OpenPositionWithMarket::quote).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteSource {
    /// the tick a Stage 6 live fire carried (book::TickHint): the one that crossed the SL / TP or the stop-out
    FireTick,
    /// the engine's latest tick for the symbol (a pass, the backstop, or a symbol the fire did not carry)
    EngineTick,
    /// the database's LivePrice (no tick source in scope: tests and tools)
    LivePrice,
    /// a shadow pin's tick (never closes for real)
    Pin,
}

impl QuoteSource {
    pub fn as_str(self) -> &'static str {
        match self {
            QuoteSource::FireTick => "fire_tick",
            QuoteSource::EngineTick => "engine_tick",
            QuoteSource::LivePrice => "live_price",
            QuoteSource::Pin => "pin",
        }
    }
}

/// The source and time of a position's bid / ask (raw, before any ask markup).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuoteStamp {
    pub source: QuoteSource,
    /// the tick's own time: the feed's clock (tick_ms), else the engine's receive time
    pub tick_at: chrono::DateTime<chrono::Utc>,
    /// when the ENGINE received that tick, by its own clock; None for a LivePrice or pinned price
    pub engine_at: Option<chrono::DateTime<chrono::Utc>>,
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
                    fx_rate: Decimal::ONE, // legacy order-path table: no conversion
                    hedged_margin_pct: Decimal::from(200), // legacy order-path table: no hedged margin
                    ask_rule: None, // legacy order-path table (ENGINE_ORDER_MANAGEMENT off in production): raw ask
                    quote: None,
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
