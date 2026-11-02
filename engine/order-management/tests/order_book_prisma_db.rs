//! L2 cutover STAGES 3-6 — the order path on Prisma's book.
//!
//! One suite per stage-ordered section, all against the real Prisma schema with its triggers:
//!
//!   Stage 3  `"Order"`: the row the whole chain hangs off, and the compare-and-set that stops a
//!            second writer filling the same order.
//!   Stage 4  `"Position"` + COMMISSION + the IN `"Deal"`: the writes that make an engine fill
//!            visible to margin, P&L, the UI and hedging.
//!   Stage 5  the hedge intent, queued as a `"PostCloseEffect"` for the web to act on.
//!   Stage 6  a resting LIMIT/STOP triggering onto the same book.
//!
//! WHAT THESE ASSERT AGAINST. Not a hand-written expectation of what the rows should look like — the
//! WEB's own open path, `lib/dealing.ts openPositionFromOrder`, which is four steps:
//!   1. `"Order"` -> FILLED with filledPrice / filledAt / executedAt / routing / executionMode
//!   2. `"Position"` created, naming NEITHER `ticket` NOR `groupCategoryAtOpen` (both triggers fire)
//!   3. `chargeCommission` (lib/group-pricing.ts): the balance is DEBITED, a COMMISSION
//!      `"Transaction"` records before/after, and `"Position".commission` is incremented
//!   4. `writeOpenDealInTx` (lib/deals.ts): the IN `"Deal"` whose commission is SUMMED from those
//!      Transaction rows, `"Position".initialVolume`, then the hedge
//!
//! Needs a scratch Postgres carrying the Prisma migrations (triggers included, so `migrate deploy`):
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test \
//!   VYX_REQUIRE_DB_TESTS=1 cargo test -p order-management --test order_book_prisma_db

use order_management::db::{self, Book};
use protocol::{OrderSide, OrderStatus, OrderType};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("order_book_prisma_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

fn id() -> String {
    Uuid::new_v4().simple().to_string()
}

struct Fx {
    broker: String,
    account: String,
    symbol_id: String,
    symbol_name: String,
    balance: Decimal,
}

/// A broker, a group of the given routing category, one LIVE account with a known balance, and the
/// broker's own 2-digit symbol carrying a per-lot commission.
async fn fixture(db: &mut sqlx::PgConnection, category: &str, commission_per_lot: Decimal) -> Fx {
    let (broker, group, account, symbol) = (id(), id(), id(), id());
    let t = &broker[..10];
    let symbol_name = format!("ZP{}", t[..6].to_uppercase());
    let balance = dec!(100000);
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "negativeBalanceProtection", "updatedAt") VALUES ($1, $2, $3, true, now())"#)
        .bind(&broker)
        .bind(format!("L2 S3 {t}"))
        .bind(format!("l2s3-{t}"))
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, category, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $3, $4::"RoutingCategory", 100, 50, now())"#)
        .bind(&group)
        .bind(&broker)
        .bind(format!("L2S3-{t}"))
        .bind(category)
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, credit, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'L2 S3', 'LIVE', $6, 0, 100, now())"#,
    )
    .bind(&account)
    .bind(&broker)
    .bind(&group)
    .bind(format!("5{}", &t[..7]))
    .bind(format!("l2s3-{t}@test.local"))
    .bind(balance)
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt")
           VALUES ($1, $2, 'XAU', 'USD', 2, 1, 'METALS'::"SymbolCategory", now())"#,
    )
    .bind(&symbol)
    .bind(&symbol_name)
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "commissionPerLot", "updatedAt") VALUES ($1, $2, $3, $4, now())"#)
        .bind(id())
        .bind(&broker)
        .bind(&symbol)
        .bind(commission_per_lot)
        .execute(&mut *db)
        .await
        .unwrap();
    Fx { broker, account, symbol_id: symbol, symbol_name, balance }
}

fn new_order(fx: &Fx, side: OrderSide, order_type: OrderType, requested: Option<Decimal>) -> db::NewOrder {
    db::NewOrder {
        broker_id: fx.broker.clone(),
        account_id: fx.account.clone(),
        symbol: fx.symbol_name.clone(),
        symbol_id: fx.symbol_id.clone(),
        side,
        order_type,
        volume: dec!(0.01),
        requested_price: requested,
        sl_price: None,
        tp_price: None,
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// STAGE 3 — "Order"
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// The row as the web would have written it, and as `"Position"."originOrderId"` needs it.
#[tokio::test]
async fn an_engine_order_lands_in_prismas_order_table_with_a_ticket_from_the_sequence() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "B_BOOK", dec!(0)).await;

    let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Market, None)).await.unwrap();

    let (ticket, status, side, otype, volume, key, source, symbol_id): (i32, String, String, String, Decimal, String, String, String) = sqlx::query_as(
        r#"SELECT ticket, status::text, side::text, type::text, volume, "idempotencyKey", source::text, "symbolId" FROM "Order" WHERE id = $1"#,
    )
    .bind(&order_id)
    .fetch_one(&mut *tx)
    .await
    .expect("the order row exists");

    // the ticket is the sequence's, not the engine's: it is what a trader quotes to support
    assert!(ticket >= 100_000_000, "the ticket must come from order_ticket_seq, got {ticket}");
    // PENDING, which is what the web writes and what BOTH pending scans look for
    assert_eq!(status, "PENDING");
    assert_eq!((side.as_str(), otype.as_str()), ("BUY", "MARKET"));
    assert_eq!(volume, dec!(0.01));
    assert_eq!(symbol_id, fx.symbol_id, "the Stage 2 symbol id is what makes this row possible");
    assert_eq!(key, format!("engine:{order_id}"), "an engine order carries its own id as the idempotency key");
    assert_eq!(source, "API", "engine orders arrive through its HTTP routes");

    // updatedAt is NOT NULL with no database default (Prisma fills it client-side), so the insert
    // must set it -- the kind of thing that only shows up against the real schema.
    let (updated,): (Option<chrono::DateTime<chrono::Utc>>,) =
        sqlx::query_as(r#"SELECT "updatedAt" FROM "Order" WHERE id = $1"#).bind(&order_id).fetch_one(&mut *tx).await.unwrap();
    assert!(updated.is_some());

    // An order is not a fill: Stage 3 writes no money. The balance moves in Stage 4's commission.
    let (balance,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(balance, fx.balance, "placing an order must not touch the balance");
    let (ledger,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Transaction" WHERE "accountId" = $1"#).bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(ledger, 0, "and must write no ledger row");
    tx.rollback().await.unwrap();
}

/// THE DOUBLE-FILL GUARD. Two writers, one order: exactly one wins, and the loser is told so rather
/// than going on to open a second position.
#[tokio::test]
async fn only_one_writer_can_fill_an_order_and_the_loser_is_told() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "B_BOOK", dec!(0)).await;
    let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Market, None)).await.unwrap();

    assert!(db::set_filled(&mut tx, Book::Prisma, &order_id, dec!(4300), dec!(0.01), Some("B_BOOK")).await.unwrap(), "the first fill wins");
    assert!(
        !db::set_filled(&mut tx, Book::Prisma, &order_id, dec!(4999), dec!(0.01), Some("B_BOOK")).await.unwrap(),
        "the second fill must lose: one order, one position"
    );

    // and the losing attempt changed nothing -- not even the price
    let (status, price, routing, mode): (String, Decimal, Option<String>, Option<String>) =
        sqlx::query_as(r#"SELECT status::text, "filledPrice", routing, "executionMode" FROM "Order" WHERE id = $1"#)
            .bind(&order_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(status, "FILLED");
    assert_eq!(price, dec!(4300), "the second writer must not overwrite the first fill's price");
    assert_eq!(routing.as_deref(), Some("B_BOOK"));
    assert_eq!(mode.as_deref(), Some("AUTO"));

    // a reject cannot land on top of a fill either
    assert!(
        !db::set_rejected(&mut tx, Book::Prisma, &order_id, "too late").await.unwrap(),
        "a filled order must not be rejectable: the trader has the position"
    );
    let (status, reason): (String, Option<String>) =
        sqlx::query_as(r#"SELECT status::text, "rejectionReason" FROM "Order" WHERE id = $1"#).bind(&order_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(status, "FILLED");
    assert_eq!(reason, None);
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn a_rejected_order_records_its_reason_once() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "B_BOOK", dec!(0)).await;
    let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Market, None)).await.unwrap();

    assert!(db::set_rejected(&mut tx, Book::Prisma, &order_id, "insufficient free margin").await.unwrap());
    assert!(!db::set_rejected(&mut tx, Book::Prisma, &order_id, "something else").await.unwrap(), "a second reject must not overwrite the first");
    let (status, reason, executed): (String, Option<String>, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(r#"SELECT status::text, "rejectionReason", "executedAt" FROM "Order" WHERE id = $1"#)
            .bind(&order_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(status, "REJECTED");
    assert_eq!(reason.as_deref(), Some("insufficient free margin"));
    assert!(executed.is_some(), "a rejected order has been answered, so it has an executedAt");
    // and a fill cannot sneak in after a reject
    assert!(!db::set_filled(&mut tx, Book::Prisma, &order_id, dec!(4300), dec!(0.01), None).await.unwrap());
    tx.rollback().await.unwrap();
}

/// A resting LIMIT/STOP must be left at PENDING, because that is the only status both pending scans
/// look for (`market-data/src/risk_hook.rs`'s load, and `get_pending_orders_for_symbol`). Moving it to
/// the engine's own ACCEPTED would hide the order and it would rest for ever.
#[tokio::test]
async fn a_resting_order_stays_pending_so_the_scans_can_see_it() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "B_BOOK", dec!(0)).await;
    let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Limit, Some(dec!(4200)))).await.unwrap();

    db::set_status(&mut tx, Book::Prisma, &order_id, OrderStatus::Accepted).await.unwrap();

    let (status, entry): (String, Option<Decimal>) =
        sqlx::query_as(r#"SELECT status::text, "requestedPrice" FROM "Order" WHERE id = $1"#).bind(&order_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(status, "PENDING", "a resting order must stay PENDING on the Prisma book");
    assert_eq!(entry, Some(dec!(4200)));

    // the shape risk_hook.rs's own scan matches, asserted as that scan writes it
    let (visible,): (i64,) = sqlx::query_as(
        r#"SELECT count(*) FROM "Order" WHERE id = $1 AND status = 'PENDING' AND type IN ('LIMIT', 'STOP') AND "requestedPrice" IS NOT NULL"#,
    )
    .bind(&order_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(visible, 1, "the resting order must be visible to the pending scans");
    tx.rollback().await.unwrap();
}

/// DEFENCE IN DEPTH behind the compare-and-set: even if a caller ignored it, the database would not
/// let one order open two positions. `"Position"."originOrderId"` is UNIQUE (schema.prisma:2019), so
/// the second attempt is a constraint violation rather than a second client position.
///
/// That is what makes the CAS an improvement rather than the only guard: the CAS turns this into a
/// clean "someone else has this order" instead of a unique-violation thrown in the middle of a money
/// transaction. Both matter, so both are asserted.
#[tokio::test]
async fn the_database_itself_refuses_a_second_position_for_one_order() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "B_BOOK", dec!(0)).await;
    let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Market, None)).await.unwrap();

    for first in [true, false] {
        let sql = r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice")
                     VALUES ($1, $2, $3, $4, $5, 'BUY'::"OrderSide", 0.01, 4300)"#;
        let result = sqlx::query(sql)
            .bind(id())
            .bind(&fx.broker)
            .bind(&fx.account)
            .bind(&fx.symbol_id)
            .bind(&order_id)
            .execute(&mut *tx)
            .await;
        if first {
            result.expect("the first position opens");
        } else {
            let err = result.expect_err("a second position for one order must be refused");
            let text = err.to_string();
            assert!(
                text.contains("originOrderId") || text.contains("Position_originOrderId_key"),
                "expected the unique index on originOrderId to be what refused it, got: {text}"
            );
            break;
        }
    }
    // the transaction is poisoned by the violation, so roll back rather than assert further on it
    tx.rollback().await.unwrap();
}

/// The legacy book is untouched by all of this: the mode that writes it is still back-compatible, and
/// nothing about its rows changed.
#[tokio::test]
async fn the_legacy_book_still_writes_its_own_tables_exactly_as_before() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "B_BOOK", dec!(0)).await;

    let order_id = db::insert_order(&mut tx, Book::Legacy, &new_order(&fx, OrderSide::Sell, OrderType::Market, None)).await.unwrap();
    let (status, symbol): (String, String) =
        sqlx::query_as("SELECT status::text, symbol FROM orders WHERE id = $1").bind(&order_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(status, "NEW", "the legacy book still opens an order at NEW");
    assert_eq!(symbol, fx.symbol_name, "and still keys it by symbol NAME");
    // nothing landed in Prisma's table
    let (in_prisma,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Order" WHERE id = $1"#).bind(&order_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(in_prisma, 0, "a legacy order must never appear in Prisma's book");

    // and its fill still reports success with a volume, which Prisma's table cannot even hold
    assert!(db::set_filled(&mut tx, Book::Legacy, &order_id, dec!(4300), dec!(0.01), None).await.unwrap());
    let (filled_volume,): (Option<Decimal>,) =
        sqlx::query_as("SELECT filled_volume FROM orders WHERE id = $1").bind(&order_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(filled_volume, Some(dec!(0.01)));
    tx.rollback().await.unwrap();
}
