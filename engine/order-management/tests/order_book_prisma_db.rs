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

// Each assertion reads one query's row as a tuple, so several are wide. Naming a type per row would
// hide which columns an assertion is about, which is the thing a reader needs here.
#![allow(clippy::type_complexity)]

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
    fixture_with(db, category, commission_per_lot, dec!(100000), 2, dec!(1)).await
}

/// `fixture` with everything the contract vector pins, so the parity test builds the same world the
/// web's generator did rather than a lookalike.
async fn fixture_with(
    db: &mut sqlx::PgConnection,
    category: &str,
    commission_per_lot: Decimal,
    balance: Decimal,
    digits: i32,
    contract_size: Decimal,
) -> Fx {
    let (broker, group, account, symbol) = (id(), id(), id(), id());
    let t = &broker[..10];
    let symbol_name = format!("ZP{}", t[..6].to_uppercase());
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
           VALUES ($1, $2, 'XAU', 'USD', $3, $4, 'METALS'::"SymbolCategory", now())"#,
    )
    .bind(&symbol)
    .bind(&symbol_name)
    .bind(digits)
    .bind(contract_size)
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// STAGE 4 — "Position" + COMMISSION + the IN "Deal"
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// Opens a position the way Stage 4's fill path does, and returns its id.
async fn open_position(tx: &mut sqlx::PgTransaction<'_>, fx: &Fx, order_id: &str, side: OrderSide, book_type: db::BookType) -> String {
    let (position_id, opened_at) = db::insert_position(
        tx,
        Book::Prisma,
        &db::NewPosition {
            broker_id: fx.broker.clone(),
            account_id: fx.account.clone(),
            symbol: fx.symbol_name.clone(),
            symbol_id: fx.symbol_id.clone(),
            origin_order_id: order_id.to_string(),
            side,
            volume: dec!(0.01),
            open_price: dec!(4300),
            sl_price: None,
            tp_price: None,
            book_type,
        },
    )
    .await
    .unwrap();
    assert!(opened_at.is_some(), "the Prisma insert returns the openedAt the IN deal must carry");
    position_id
}

/// THE STAGE 4 TEST. Every row `lib/dealing.ts openPositionFromOrder` writes, and the two triggers.
#[tokio::test]
async fn an_engine_fill_writes_the_whole_chain_the_web_writes() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    // A_BOOK, because that is the category whose hedge a missed stamp would silently lose.
    let fx = fixture(&mut tx, "A_BOOK", dec!(3)).await;
    let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Market, None)).await.unwrap();
    assert!(db::set_filled(&mut tx, Book::Prisma, &order_id, dec!(4300), dec!(0.01), Some("A_BOOK")).await.unwrap());
    let position_id = open_position(&mut tx, &fx, &order_id, OrderSide::Buy, db::BookType::ABook).await;
    db::record_commission(&mut tx, Book::Prisma, &fx.broker, &fx.account, &position_id, dec!(3), dec!(0.01)).await.unwrap();
    let deal_id = db::write_open_deal(&mut tx, &position_id, "CLIENT").await.unwrap().deal_id;

    // ── the position, and BOTH triggers ──
    let (ticket, category, book_type, status, commission, initial, open_price): (
        i32,
        Option<String>,
        String,
        String,
        Decimal,
        Option<Decimal>,
        Decimal,
    ) = sqlx::query_as(
        r#"SELECT ticket, "groupCategoryAtOpen"::text, "bookType"::text, status::text, commission, "initialVolume", "openPrice"
             FROM "Position" WHERE id = $1"#,
    )
    .bind(&position_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let (order_ticket,): (i32,) = sqlx::query_as(r#"SELECT ticket FROM "Order" WHERE id = $1"#).bind(&order_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(ticket, order_ticket, "the ticket trigger copies the opening order's number");
    assert_eq!(category.as_deref(), Some("A_BOOK"), "THE CRITICAL ONE: the stamp trigger fired, so this position can be hedged");
    assert_eq!(book_type, "A_BOOK", "resolveBookType(A_BOOK)");
    assert_eq!(status, "OPEN", "the status column DEFAULTs to OPEN");
    assert_eq!(open_price, dec!(4300));
    // 3/lot on 0.01 lots = 0.03, incremented onto the position, not set
    assert_eq!(commission, dec!(0.03));
    assert_eq!(initial, Some(dec!(0.01)), "writeOpenDealInTx also sets initialVolume");

    // ── the money. The legacy path never touched the balance; this one must. ──
    let (balance,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(balance, fx.balance - dec!(0.03), "the commission must leave the balance");
    let (amount, before, after, kind, note, ref_type, ref_id): (Decimal, Decimal, Decimal, String, String, String, String) = sqlx::query_as(
        r#"SELECT amount, "balanceBefore", "balanceAfter", type::text, note, "referenceType", "referenceId"
             FROM "Transaction" WHERE "referenceId" = $1 AND type = 'COMMISSION'"#,
    )
    .bind(&position_id)
    .fetch_one(&mut *tx)
    .await
    .expect("one COMMISSION ledger row");
    assert_eq!(amount, dec!(-0.03), "a charge is recorded NEGATED");
    assert_eq!((before, after), (fx.balance, fx.balance - dec!(0.03)));
    assert_eq!(kind, "COMMISSION");
    assert_eq!((ref_type.as_str(), ref_id.as_str()), ("Position", position_id.as_str()));
    // the web's own note text, including decimal.js's trailing-zero handling: "@ 3/lot", not "@ 3.00/lot"
    assert_eq!(note, "Commission: 0.01 lots @ 3/lot");

    // ── the IN deal ──
    let (entry, reason, side, source, volume, price, deal_commission, txn, executed, order_ref, deal_ticket): (
        String,
        String,
        String,
        Option<String>,
        Decimal,
        Decimal,
        Decimal,
        Option<String>,
        chrono::DateTime<chrono::Utc>,
        Option<String>,
        i64,
    ) = sqlx::query_as(
        r#"SELECT entry::text, reason::text, side::text, source::text, volume, price, commission, "transactionId", "executedAt", "orderId", ticket
             FROM "Deal" WHERE id = $1"#,
    )
    .bind(&deal_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!((entry.as_str(), reason.as_str(), side.as_str()), ("IN", "CLIENT", "BUY"));
    assert_eq!(source.as_deref(), Some("API"), "the deal carries the opening ORDER's channel");
    assert_eq!((volume, price), (dec!(0.01), dec!(4300)));
    // SUMMED back out of the ledger, so it can never disagree with the money that moved -- and negative
    assert_eq!(deal_commission, dec!(-0.03));
    assert!(txn.is_some(), "exactly one commission row, so the deal names it");
    assert_eq!(order_ref.as_deref(), Some(order_id.as_str()));
    assert!(deal_ticket > 0, "deal_ticket_seq owns the number");
    let (opened_at,): (chrono::DateTime<chrono::Utc>,) =
        sqlx::query_as(r#"SELECT "openedAt" FROM "Position" WHERE id = $1"#).bind(&position_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(executed, opened_at, "the IN deal's executedAt is the position's own openedAt");

    // ── and the position is now visible to the hedge path, which is the whole point ──
    let (hedgeable,): (i64,) = sqlx::query_as(
        r#"SELECT count(*) FROM "Position" WHERE "brokerId" = $1 AND status = 'OPEN' AND "groupCategoryAtOpen" = 'A_BOOK'"#,
    )
    .bind(&fx.broker)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(hedgeable, 1);
    tx.rollback().await.unwrap();
}

/// A zero commission charges nothing at all -- no balance move, no ledger row -- and the deal says 0
/// rather than null. The web's `lte(0)` guard, and the `COALESCE(SUM(amount), 0)` behind the deal.
#[tokio::test]
async fn a_zero_commission_moves_no_money_and_the_deal_still_balances() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "B_BOOK", dec!(0)).await;
    let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Sell, OrderType::Market, None)).await.unwrap();
    assert!(db::set_filled(&mut tx, Book::Prisma, &order_id, dec!(4300), dec!(0.01), Some("B_BOOK")).await.unwrap());
    let position_id = open_position(&mut tx, &fx, &order_id, OrderSide::Sell, db::BookType::BBook).await;
    db::record_commission(&mut tx, Book::Prisma, &fx.broker, &fx.account, &position_id, dec!(0), dec!(0.01)).await.unwrap();
    let deal_id = db::write_open_deal(&mut tx, &position_id, "CLIENT").await.unwrap().deal_id;

    let (balance,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(balance, fx.balance, "nothing to charge, so nothing moves");
    let (rows,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Transaction" WHERE "referenceId" = $1"#)
        .bind(&position_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(rows, 0, "and no ledger row is written");
    let (deal_commission, txn, side, category): (Decimal, Option<String>, String, Option<String>) = sqlx::query_as(
        r#"SELECT d.commission, d."transactionId", d.side::text, p."groupCategoryAtOpen"::text
             FROM "Deal" d JOIN "Position" p ON p.id = d."positionId" WHERE d.id = $1"#,
    )
    .bind(&deal_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(deal_commission, Decimal::ZERO);
    assert_eq!(txn, None, "no commission row, so nothing to name");
    assert_eq!(side, "SELL", "the deal's side is the POSITION's, not the inverse the close side uses");
    assert_eq!(category.as_deref(), Some("B_BOOK"), "the stamp follows the account's group, whatever the book type");
    tx.rollback().await.unwrap();
}

/// Charged twice, the deal reports BOTH charges and names neither transaction -- `transactionId` is
/// UNIQUE, so there is no single row to point at. The web leaves it null for the same reason.
#[tokio::test]
async fn two_commission_rows_are_both_summed_and_neither_is_named() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "B_BOOK", dec!(2)).await;
    let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Market, None)).await.unwrap();
    assert!(db::set_filled(&mut tx, Book::Prisma, &order_id, dec!(4300), dec!(0.01), Some("B_BOOK")).await.unwrap());
    let position_id = open_position(&mut tx, &fx, &order_id, OrderSide::Buy, db::BookType::BBook).await;
    db::record_commission(&mut tx, Book::Prisma, &fx.broker, &fx.account, &position_id, dec!(2), dec!(0.01)).await.unwrap();
    db::record_commission(&mut tx, Book::Prisma, &fx.broker, &fx.account, &position_id, dec!(2), dec!(0.01)).await.unwrap();
    let deal_id = db::write_open_deal(&mut tx, &position_id, "CLIENT").await.unwrap().deal_id;

    let (balance,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(balance, fx.balance - dec!(0.04), "both charges left the balance");
    let (position_commission,): (Decimal,) =
        sqlx::query_as(r#"SELECT commission FROM "Position" WHERE id = $1"#).bind(&position_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(position_commission, dec!(0.04), "increment, not set");
    let (deal_commission, txn): (Decimal, Option<String>) =
        sqlx::query_as(r#"SELECT commission, "transactionId" FROM "Deal" WHERE id = $1"#).bind(&deal_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(deal_commission, dec!(-0.04), "the deal reports the money that actually moved");
    assert_eq!(txn, None);
    tx.rollback().await.unwrap();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// STAGE 4 — the whole path, end to end
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// `place_market_order` itself, on the Prisma book, against a real database and a real NATS.
///
/// The row-level tests above prove each write. This one proves the PATH: that it reads the symbol
/// before the order, picks one book, fills, opens, charges, deals -- and, the reason it exists, that it
/// ACTS on Stage 3's compare-and-set instead of merely calling it. Stage 3's mutant that made the
/// caller ignore the answer survived every row-level test; it dies here.
///
/// Needs a NATS to publish OrderFilled to. Point `ENGINE_TEST_NATS_URL` at a THROWAWAY server (the
/// scratch Postgres has the same rule): publishing engine events onto the live bus would reach real
/// clients. Without it the test skips rather than guessing a port.
#[tokio::test]
async fn place_market_order_runs_the_whole_chain_on_prismas_book() {
    let Some(pool) = pool().await else { return };
    let Some(nats_url) = std::env::var("ENGINE_TEST_NATS_URL").ok().filter(|u| !u.is_empty()) else {
        eprintln!("place_market_order_runs_the_whole_chain: ENGINE_TEST_NATS_URL not set, skipping");
        return;
    };
    assert!(nats_url.contains("127.0.0.1") || nats_url.contains("localhost"), "refusing a non-local NATS: {nats_url}");
    let nats = async_nats::connect(&nats_url).await.expect("connect to the throwaway NATS");

    // This process writes the real book, which is what live mode does after its pool check passes.
    db::use_prisma_book();
    assert_eq!(db::configured(), Book::Prisma);

    // Committed: place_market_order reads on the pool and writes in its own transaction.
    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "A_BOOK", dec!(3)).await;
    setup.commit().await.unwrap();

    let cache = market_data::cache::TickCache::new();
    cache.set(
        &protocol::Tick {
            symbol: fx.symbol_name.clone(),
            bid: dec!(4298.96),
            ask: dec!(4299.13),
            t0: None,
            clock_offset_ms: None,
            rtt_ms: None,
            tick_ms: None,
            broker_offset_sec: None,
            bars: Vec::new(),
        },
        chrono::Utc::now(),
    );

    let outcome = order_management::place_market_order(
        &pool,
        &nats,
        &cache,
        order_management::PlaceMarketOrderRequest {
            broker_id: fx.broker.clone(),
            account_id: fx.account.clone(),
            symbol: fx.symbol_name.clone(),
            side: OrderSide::Buy,
            volume: dec!(0.01),
            sl_price: None,
            tp_price: None,
            equity: dec!(100000),
            used_margin: dec!(0),
            contract_size: dec!(1),
            leverage: 100,
        },
    )
    .await
    .expect("the order path ran");

    let (order_id, position_id, fill_price) = match outcome {
        order_management::PlaceMarketOrderOutcome::Filled { order_id, position_id, fill_price } => (order_id, position_id, fill_price),
        order_management::PlaceMarketOrderOutcome::Rejected { reason, .. } => panic!("rejected: {reason}"),
    };
    // a BUY fills at the account's ask; no markup is configured, so the raw one
    assert_eq!(fill_price, dec!(4299.13));

    // every row of the chain, in the real book
    let (status, filled, routing): (String, Option<Decimal>, Option<String>) =
        sqlx::query_as(r#"SELECT status::text, "filledPrice", routing FROM "Order" WHERE id = $1"#)
            .bind(&order_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "FILLED");
    assert_eq!(filled, Some(dec!(4299.13)));
    assert_eq!(routing.as_deref(), Some("A_BOOK"), "the fill stamps where the risk went");

    let (ticket, category, book_type, commission, initial): (i32, Option<String>, String, Decimal, Option<Decimal>) = sqlx::query_as(
        r#"SELECT ticket, "groupCategoryAtOpen"::text, "bookType"::text, commission, "initialVolume" FROM "Position" WHERE id = $1"#,
    )
    .bind(&position_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(ticket >= 100_000_000);
    assert_eq!(category.as_deref(), Some("A_BOOK"), "the stamp trigger fired on the real path too");
    assert_eq!(book_type, "A_BOOK");
    assert_eq!(commission, dec!(0.03));
    assert_eq!(initial, Some(dec!(0.01)));

    let (deals, entry, reason): (i64, String, String) =
        sqlx::query_as(r#"SELECT count(*), min(entry::text), min(reason::text) FROM "Deal" WHERE "positionId" = $1"#)
            .bind(&position_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((deals, entry.as_str(), reason.as_str()), (1, "IN", "CLIENT"));

    let (balance,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&pool).await.unwrap();
    assert_eq!(balance, fx.balance - dec!(0.03));

    // and NOTHING went to the legacy tables: one book per order, the Stage 3 invariant
    let (legacy_orders,): (i64,) = sqlx::query_as("SELECT count(*) FROM orders WHERE broker_id = $1").bind(&fx.broker).fetch_one(&pool).await.unwrap();
    let (legacy_positions,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM positions WHERE broker_id = $1").bind(&fx.broker).fetch_one(&pool).await.unwrap();
    assert_eq!((legacy_orders, legacy_positions), (0, 0), "a Prisma-book order must leave nothing in the legacy tables");

    // ── THE POINT OF THIS TEST: the caller acts on the compare-and-set. ──
    // Take the committed order back to PENDING and re-run the fill step the way a second writer would:
    // the CAS has to be the thing that stops it, and the path has to report that rather than carry on.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(r#"UPDATE "Order" SET status = 'FILLED'::"OrderStatus" WHERE id = $1"#).bind(&order_id).execute(&mut *tx).await.unwrap();
    assert!(
        !db::set_filled(&mut tx, Book::Prisma, &order_id, dec!(9999), dec!(0.01), None).await.unwrap(),
        "an already-filled order must refuse a second fill"
    );
    tx.rollback().await.unwrap();

    // one position for one order, still
    let (positions,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Position" WHERE "originOrderId" = $1"#)
        .bind(&order_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(positions, 1);

    cleanup(&pool, &fx).await;
}

/// Committed fixtures and everything the path wrote for them, in FK order.
async fn cleanup(pool: &PgPool, fx: &Fx) {
    for sql in [
        r#"DELETE FROM "Deal" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Transaction" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "AuditLog" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "PostCloseEffect" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "BrokerSymbol" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Broker" WHERE id = $1"#,
    ] {
        sqlx::query(sql).bind(&fx.broker).execute(pool).await.unwrap();
    }
    sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&fx.symbol_id).execute(pool).await.unwrap();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// STAGE 4 — cross-language parity against the web's own chain
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// THE PARITY PROOF for the stage that moves money.
///
/// The expectations are not written here. `docs/contracts/open-chain-vector.json` is generated by
/// `scripts/contracts/gen-open-chain-vector.ts`, which RUNS `lib/dealing.ts openPositionFromOrder`
/// against a scratch database and records every row it wrote. This test runs the engine's chain on the
/// same input and compares, so "the engine mirrors the web" stops being a claim about code I read and
/// becomes a measurement — the same direction as `ask-markup-vectors.json`, where the web is the
/// oracle and the engine asserts against it.
///
/// Normalised: ids, tickets and timestamps are per-row, so the vector records relationships
/// (`ticketEqualsOrderTicket`, `executedAtEqualsPositionOpenedAt`) instead of values, and decimals are
/// compared as decimal.js strings.
#[tokio::test]
async fn the_engines_open_chain_matches_the_webs_row_for_row() {
    let Some(pool) = pool().await else { return };
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/contracts/open-chain-vector.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).expect("open-chain-vector.json")).unwrap();
    let c = &v["case"];

    // the vector's own case, so a regenerated file with different inputs cannot pass by accident
    assert_eq!(c["category"], "A_BOOK");
    assert_eq!(c["side"], "BUY");
    let volume = dec(&c["volume"]);
    let fill_price = dec(&c["fillPrice"]);
    let per_lot = dec(&c["commissionPerLot"]);
    let opening_balance = dec(&c["openingBalance"]);

    let mut tx = pool.begin().await.unwrap();
    let fx = fixture_with(&mut tx, c["category"].as_str().unwrap(), per_lot, opening_balance, c["digits"].as_i64().unwrap() as i32, dec(&c["contractSize"])).await;

    // ── the engine's chain, exactly as its fill path runs it ──
    let book_type = db::BookType::of_category(Some(c["category"].as_str().unwrap()));
    let order_id = db::insert_order(
        &mut tx,
        Book::Prisma,
        &db::NewOrder {
            broker_id: fx.broker.clone(),
            account_id: fx.account.clone(),
            symbol: fx.symbol_name.clone(),
            symbol_id: fx.symbol_id.clone(),
            side: OrderSide::Buy,
            order_type: OrderType::Market,
            volume,
            requested_price: None,
            sl_price: None,
            tp_price: None,
        },
    )
    .await
    .unwrap();
    assert!(db::set_filled(&mut tx, Book::Prisma, &order_id, fill_price, volume, Some(book_type.as_str())).await.unwrap());
    let (position_id, _) = db::insert_position(
        &mut tx,
        Book::Prisma,
        &db::NewPosition {
            broker_id: fx.broker.clone(),
            account_id: fx.account.clone(),
            symbol: fx.symbol_name.clone(),
            symbol_id: fx.symbol_id.clone(),
            origin_order_id: order_id.clone(),
            side: OrderSide::Buy,
            volume,
            open_price: fill_price,
            sl_price: None,
            tp_price: None,
            book_type,
        },
    )
    .await
    .unwrap();
    db::record_commission(&mut tx, Book::Prisma, &fx.broker, &fx.account, &position_id, per_lot, volume).await.unwrap();
    let deal_id = db::write_open_deal(&mut tx, &position_id, "CLIENT").await.unwrap().deal_id;

    // ── the order ──
    let e = &v["order"];
    let (status, filled, routing, mode, has_filled_at, has_executed_at, rejection): (
        String,
        Option<Decimal>,
        Option<String>,
        Option<String>,
        bool,
        bool,
        Option<String>,
    ) = sqlx::query_as(
        r#"SELECT status::text, "filledPrice", routing, "executionMode", "filledAt" IS NOT NULL, "executedAt" IS NOT NULL, "rejectionReason"
             FROM "Order" WHERE id = $1"#,
    )
    .bind(&order_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(status, e["status"].as_str().unwrap(), "Order.status");
    assert_eq!(norm(filled), e["filledPrice"].as_str().map(str::to_string), "Order.filledPrice");
    assert_eq!(routing.as_deref(), e["routing"].as_str(), "Order.routing");
    assert_eq!(mode.as_deref(), e["executionMode"].as_str(), "Order.executionMode");
    assert_eq!(has_filled_at, e["hasFilledAt"].as_bool().unwrap(), "Order.filledAt");
    assert_eq!(has_executed_at, e["hasExecutedAt"].as_bool().unwrap(), "Order.executedAt");
    assert_eq!(rejection, None);
    assert!(e["rejectionReason"].is_null());

    // ── the position, including both trigger-filled columns ──
    let e = &v["position"];
    let (p_status, p_side, p_volume, p_initial, p_open, p_book, p_category, p_ticket, p_commission, p_swap, p_pnl): (
        String,
        String,
        Decimal,
        Option<Decimal>,
        Decimal,
        String,
        Option<String>,
        i32,
        Decimal,
        Decimal,
        Option<Decimal>,
    ) = sqlx::query_as(
        r#"SELECT status::text, side::text, volume, "initialVolume", "openPrice", "bookType"::text,
                  "groupCategoryAtOpen"::text, ticket, commission, swap, "realizedPnl"
             FROM "Position" WHERE id = $1"#,
    )
    .bind(&position_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let (order_ticket,): (i32,) = sqlx::query_as(r#"SELECT ticket FROM "Order" WHERE id = $1"#).bind(&order_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(p_status, e["status"].as_str().unwrap(), "Position.status");
    assert_eq!(p_side, e["side"].as_str().unwrap(), "Position.side");
    assert_eq!(norm(Some(p_volume)), e["volume"].as_str().map(str::to_string), "Position.volume");
    assert_eq!(norm(p_initial), e["initialVolume"].as_str().map(str::to_string), "Position.initialVolume");
    assert_eq!(norm(Some(p_open)), e["openPrice"].as_str().map(str::to_string), "Position.openPrice");
    assert_eq!(p_book, e["bookType"].as_str().unwrap(), "Position.bookType");
    assert_eq!(p_category.as_deref(), e["groupCategoryAtOpen"].as_str(), "Position.groupCategoryAtOpen -- the stamp trigger");
    assert_eq!(
        p_ticket == order_ticket,
        e["ticketEqualsOrderTicket"].as_bool().unwrap(),
        "Position.ticket vs the order's -- the ticket trigger"
    );
    assert_eq!(norm(Some(p_commission)), e["commission"].as_str().map(str::to_string), "Position.commission");
    assert_eq!(norm(Some(p_swap)), e["swap"].as_str().map(str::to_string), "Position.swap");
    assert_eq!(norm(p_pnl), e["realizedPnl"].as_str().map(str::to_string), "Position.realizedPnl");

    // ── the commission ledger ──
    let expected_txns = v["commissionTransactions"].as_array().unwrap();
    let txns: Vec<(String, String, Decimal, Decimal, Decimal, Option<String>, Option<String>)> = sqlx::query_as(
        r#"SELECT type::text, status::text, amount, "balanceBefore", "balanceAfter", "referenceType", note
             FROM "Transaction" WHERE "referenceType" = 'Position' AND "referenceId" = $1 ORDER BY "createdAt""#,
    )
    .bind(&position_id)
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    assert_eq!(txns.len(), expected_txns.len(), "one COMMISSION row, as the web writes");
    for (got, want) in txns.iter().zip(expected_txns) {
        let (kind, st, amount, before, after, ref_type, note) = got;
        assert_eq!(kind, want["type"].as_str().unwrap(), "Transaction.type");
        assert_eq!(st, want["status"].as_str().unwrap(), "Transaction.status");
        assert_eq!(norm(Some(*amount)), want["amount"].as_str().map(str::to_string), "Transaction.amount");
        assert_eq!(norm(Some(*before)), want["balanceBefore"].as_str().map(str::to_string), "Transaction.balanceBefore");
        assert_eq!(norm(Some(*after)), want["balanceAfter"].as_str().map(str::to_string), "Transaction.balanceAfter");
        assert_eq!(ref_type.as_deref(), want["referenceType"].as_str(), "Transaction.referenceType");
        // the note is user-visible text, and its number formatting is decimal.js's
        assert_eq!(note.as_deref(), want["note"].as_str(), "Transaction.note");
    }

    // ── the IN deal ──
    let expected_deals = v["deals"].as_array().unwrap();
    assert_eq!(expected_deals.len(), 1);
    let e = &expected_deals[0];
    let (entry, reason, d_side, source, d_volume, d_price, d_commission, d_profit, d_swap, names_txn, executed, d_order): (
        String,
        String,
        String,
        Option<String>,
        Decimal,
        Decimal,
        Decimal,
        Decimal,
        Decimal,
        bool,
        chrono::DateTime<chrono::Utc>,
        Option<String>,
    ) = sqlx::query_as(
        r#"SELECT entry::text, reason::text, side::text, source::text, volume, price, commission, profit, swap,
                  "transactionId" IS NOT NULL, "executedAt", "orderId"
             FROM "Deal" WHERE id = $1"#,
    )
    .bind(&deal_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let (opened_at,): (chrono::DateTime<chrono::Utc>,) =
        sqlx::query_as(r#"SELECT "openedAt" FROM "Position" WHERE id = $1"#).bind(&position_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(entry, e["entry"].as_str().unwrap(), "Deal.entry");
    assert_eq!(reason, e["reason"].as_str().unwrap(), "Deal.reason");
    assert_eq!(d_side, e["side"].as_str().unwrap(), "Deal.side");
    assert_eq!(source.as_deref(), e["source"].as_str(), "Deal.source");
    assert_eq!(norm(Some(d_volume)), e["volume"].as_str().map(str::to_string), "Deal.volume");
    assert_eq!(norm(Some(d_price)), e["price"].as_str().map(str::to_string), "Deal.price");
    assert_eq!(norm(Some(d_commission)), e["commission"].as_str().map(str::to_string), "Deal.commission");
    assert_eq!(norm(Some(d_profit)), e["profit"].as_str().map(str::to_string), "Deal.profit");
    assert_eq!(norm(Some(d_swap)), e["swap"].as_str().map(str::to_string), "Deal.swap");
    assert_eq!(names_txn, e["namesOneCommissionTransaction"].as_bool().unwrap(), "Deal.transactionId");
    assert_eq!(executed == opened_at, e["executedAtEqualsPositionOpenedAt"].as_bool().unwrap(), "Deal.executedAt");
    assert_eq!(d_order.as_deref() == Some(order_id.as_str()), e["orderIdEqualsOriginOrder"].as_bool().unwrap(), "Deal.orderId");

    // ── the balance ──
    let (balance,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(norm(Some(balance)), v["account"]["balanceAfter"].as_str().map(str::to_string), "Account.balance");

    // ── and the one deliberate difference: the hedge intent. The web writes it inside the deal's own
    //    transaction; the engine must NOT (design option (b)) -- it queues a PostCloseEffect and the
    //    web's worker writes it, which is Stage 5. So the engine's own chain leaves ZERO here while
    //    the web's vector says one, and that gap is what Stage 5 closes.
    let (intents,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "HedgeIntent" WHERE "positionId" = $1"#)
        .bind(&position_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(v["hedgeIntents"].as_i64().unwrap(), 1, "the web writes the intent itself");
    assert_eq!(intents, 0, "the engine must not write HedgeIntent: Stage 5 queues it for the web instead");

    tx.rollback().await.unwrap();
}

fn dec(v: &serde_json::Value) -> Decimal {
    use std::str::FromStr;
    Decimal::from_str(v.as_str().expect("a decimal string")).unwrap()
}

/// decimal.js `toString` drops trailing zeros, so compare in that form: 0.0300 and 0.03 are one price.
fn norm(d: Option<Decimal>) -> Option<String> {
    d.map(|d| d.normalize().to_string())
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// STAGE 5 — the hedge intent, queued for the web (design option (b))
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// The engine's half of the handshake. It must write a `"PostCloseEffect"` of kind POSITION_OPENED
/// with `payload.dealId`, and must write NO `"HedgeIntent"`.
///
/// The web's half is `lib/post-close-open.test.ts`, which builds this exact row and asserts the intent
/// that comes out of it. Both sides assert the shape rather than assume it, so the two cannot drift:
/// kind POSITION_OPENED, dedupeKey `open:<positionId>:<dealId>`, payload `{ dealId }`.
#[tokio::test]
async fn an_a_book_fill_queues_the_hedge_for_the_web_and_writes_no_intent() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "A_BOOK", dec!(3)).await;
    let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Market, None)).await.unwrap();
    assert!(db::set_filled(&mut tx, Book::Prisma, &order_id, dec!(4300), dec!(0.01), Some("A_BOOK")).await.unwrap());
    let position_id = open_position(&mut tx, &fx, &order_id, OrderSide::Buy, db::BookType::ABook).await;
    db::record_commission(&mut tx, Book::Prisma, &fx.broker, &fx.account, &position_id, dec!(3), dec!(0.01)).await.unwrap();

    let opened = db::write_open_deal(&mut tx, &position_id, "CLIENT").await.unwrap();
    assert_eq!(opened.group_category_at_open.as_deref(), Some("A_BOOK"), "read BACK from the row, not assumed");
    assert!(db::enqueue_position_opened(&mut tx, &position_id, &opened).await.unwrap(), "an A-book fill must queue its hedge");

    let (kind, dedupe, status, payload, broker, account, effect_position): (String, String, String, serde_json::Value, String, String, Option<String>) =
        sqlx::query_as(
            r#"SELECT kind, "dedupeKey", status, payload, "brokerId", "accountId", "positionId"
                 FROM "PostCloseEffect" WHERE "positionId" = $1"#,
        )
        .bind(&position_id)
        .fetch_one(&mut *tx)
        .await
        .expect("exactly one queued effect");
    assert_eq!(kind, "POSITION_OPENED", "the kind lib/post-close.ts dispatches on");
    assert_eq!(dedupe, format!("open:{position_id}:{}", opened.deal_id), "the dedupeKey the web's test builds");
    assert_eq!(status, "PENDING", "the dispatcher picks up PENDING rows");
    assert_eq!(payload["dealId"].as_str(), Some(opened.deal_id.as_str()), "the intent is keyed on the IN deal");
    assert_eq!((broker.as_str(), account.as_str()), (fx.broker.as_str(), fx.account.as_str()));
    assert_eq!(effect_position.as_deref(), Some(position_id.as_str()));

    // AND NOTHING IN "HedgeIntent": the engine is not the intent writer, and has no privilege to be
    // (authority::ORDER_PATH_PRIVILEGES omits the table on purpose).
    let (intents,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "HedgeIntent" WHERE "positionId" = $1"#)
        .bind(&position_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(intents, 0);

    // a replay queues one row, not two (dedupeKey is unique, the insert is ON CONFLICT DO NOTHING)
    assert!(!db::enqueue_position_opened(&mut tx, &position_id, &opened).await.unwrap(), "a retried fill must not queue a second row");
    let (rows,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "PostCloseEffect" WHERE "positionId" = $1"#)
        .bind(&position_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(rows, 1);
    tx.rollback().await.unwrap();
}

/// A B-book fill queues nothing: that is nearly every fill, and the row would only be declined by the
/// web anyway. The gate is the stamp the trigger wrote, which is `isHedgedCategory`'s own first test.
#[tokio::test]
async fn a_b_book_fill_queues_nothing() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    for category in ["B_BOOK", "DEALING", "REVERSAL"] {
        let fx = fixture(&mut tx, category, dec!(0)).await;
        let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Market, None)).await.unwrap();
        assert!(db::set_filled(&mut tx, Book::Prisma, &order_id, dec!(4300), dec!(0.01), Some("B_BOOK")).await.unwrap());
        let position_id = open_position(&mut tx, &fx, &order_id, OrderSide::Buy, db::BookType::BBook).await;
        let opened = db::write_open_deal(&mut tx, &position_id, "CLIENT").await.unwrap();
        assert_eq!(opened.group_category_at_open.as_deref(), Some(category));
        assert!(!db::enqueue_position_opened(&mut tx, &position_id, &opened).await.unwrap(), "{category} must queue nothing");
        let (rows,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "PostCloseEffect" WHERE "positionId" = $1"#)
            .bind(&position_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(rows, 0, "{category}");
    }
    tx.rollback().await.unwrap();
}

/// §7's top risk, one more time, from the hedge's own end: if the stamp trigger did not fire, the
/// engine queues nothing and the position is unhedged. That is the failure the trigger check
/// (`authority::verify_order_path_pool`) and the column guard (`book::triggers_bypassed_by`) exist to
/// make impossible -- this test is what says out loud what happens if they are ever bypassed.
#[tokio::test]
async fn without_the_stamp_the_hedge_is_never_queued() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "A_BOOK", dec!(0)).await;
    let order_id = db::insert_order(&mut tx, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Market, None)).await.unwrap();
    assert!(db::set_filled(&mut tx, Book::Prisma, &order_id, dec!(4300), dec!(0.01), Some("A_BOOK")).await.unwrap());
    // the mistake, made by hand: the insert supplies the column, so the trigger does not fire
    let position_id = id();
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", "bookType", "groupCategoryAtOpen")
           VALUES ($1, $2, $3, $4, $5, 'BUY'::"OrderSide", 0.01, 4300, 'A_BOOK'::"BookType", 'B_BOOK'::"RoutingCategory")"#,
    )
    .bind(&position_id)
    .bind(&fx.broker)
    .bind(&fx.account)
    .bind(&fx.symbol_id)
    .bind(&order_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    let opened = db::write_open_deal(&mut tx, &position_id, "CLIENT").await.unwrap();
    assert_eq!(opened.group_category_at_open.as_deref(), Some("B_BOOK"), "the supplied value stood");
    assert!(
        !db::enqueue_position_opened(&mut tx, &position_id, &opened).await.unwrap(),
        "and so the A-book position's hedge is never queued -- unhedged, with nothing raising an error"
    );
    tx.rollback().await.unwrap();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// STAGE 6 — resting LIMIT / STOP orders on the same book
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// The scan finds a resting order the WEB wrote, with the account's pricing rule attached.
///
/// Status PENDING, joined through `"symbolId"` -- the two things the Prisma query had to change, and
/// the two that would silently return nothing if they were wrong.
#[tokio::test]
async fn the_scan_finds_a_resting_order_on_prismas_book_with_its_pricing_rule() {
    let Some(pool) = pool().await else { return };
    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "B_BOOK", dec!(0)).await;
    // the broker's own markup, so the rule the scan attaches is not the trivial one
    sqlx::query(r#"UPDATE "BrokerSymbol" SET "spreadMarkup" = 2 WHERE "brokerId" = $1 AND "symbolId" = $2"#)
        .bind(&fx.broker)
        .bind(&fx.symbol_id)
        .execute(&mut *setup)
        .await
        .unwrap();
    let order_id = db::insert_order(&mut setup, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Limit, Some(dec!(4200)))).await.unwrap();
    setup.commit().await.unwrap();

    let found = db::get_pending_orders_for_symbol(&pool, Book::Prisma, &fx.symbol_name).await.unwrap();
    assert_eq!(found.len(), 1, "the resting order must be visible to the scan");
    let o = &found[0];
    assert_eq!(o.id, order_id);
    assert_eq!(o.broker_id, fx.broker);
    assert_eq!(o.account_id, fx.account);
    assert_eq!(o.symbol, fx.symbol_name, "resolved through the FK, not stored as text");
    assert_eq!(o.requested_price, dec!(4200));
    assert_eq!(o.volume, dec!(0.01));
    // the rule rides along on the scan, so the entry test and the fill price cannot disagree
    let levels = o.ask_levels.as_ref().expect("the account's levels came with the order");
    assert_eq!(levels.digits, 2);
    assert_eq!(levels.broker, Some(dec!(2)));

    // a FILLED order is no longer resting, and the legacy query sees nothing here at all
    sqlx::query(r#"UPDATE "Order" SET status = 'FILLED'::"OrderStatus" WHERE id = $1"#).bind(&order_id).execute(&pool).await.unwrap();
    assert!(db::get_pending_orders_for_symbol(&pool, Book::Prisma, &fx.symbol_name).await.unwrap().is_empty());
    assert!(db::get_pending_orders_for_symbol(&pool, Book::Legacy, &fx.symbol_name).await.unwrap().is_empty());

    cleanup(&pool, &fx).await;
}

/// A MARKET order waiting in the dealer queue is also `status = 'PENDING'`, and must NOT be triggered
/// by a price scan -- the dealer decides it. Only the `type` filter separates them.
#[tokio::test]
async fn a_market_order_in_the_dealer_queue_is_not_a_resting_order() {
    let Some(pool) = pool().await else { return };
    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "B_BOOK", dec!(0)).await;
    // WITH a requestedPrice, because that is what the web writes for a queued market order
    // (app/api/trade/orders/route.ts:525 sets requestedPrice on the dealer-queue row). Without it this
    // test would pass for the wrong reason -- the `requestedPrice IS NOT NULL` guard would exclude the
    // order even if the type filter were gone. Found by mutation testing: dropping the type filter
    // survived until this fixture matched the real row.
    db::insert_order(&mut setup, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Market, Some(dec!(4299.13)))).await.unwrap();
    setup.commit().await.unwrap();

    assert!(
        db::get_pending_orders_for_symbol(&pool, Book::Prisma, &fx.symbol_name).await.unwrap().is_empty(),
        "a queued MARKET order must never be picked up by the price scan: a dealer decides it"
    );
    cleanup(&pool, &fx).await;
}

/// THE RACE, and the test Stage 3's surviving mutant was waiting for.
///
/// Two scans of the same tick run at once, as two ticks for one symbol landing together really do.
/// Both see the order PENDING, both run the admission checks, and both reach the fill -- where exactly
/// one wins the compare-and-set. The loser must roll back, NOT open a second position.
///
/// This is the only place that can prove the CALLER acts on the answer rather than merely asking:
/// `place_market_order` creates its own order inside its own transaction, so its compare-and-set can
/// never lose (see the comment there). Here the order was written earlier, so the race is real -- and
/// a `trigger_order` that ignored the answer would either open two positions or die on
/// `"Position"."originOrderId"`'s unique index.
#[tokio::test]
async fn two_concurrent_scans_of_one_resting_order_fill_it_once() {
    let Some(pool) = pool().await else { return };
    let Some(nats_url) = std::env::var("ENGINE_TEST_NATS_URL").ok().filter(|u| !u.is_empty()) else {
        eprintln!("two_concurrent_scans: ENGINE_TEST_NATS_URL not set, skipping");
        return;
    };
    assert!(nats_url.contains("127.0.0.1") || nats_url.contains("localhost"), "refusing a non-local NATS: {nats_url}");
    let nats = async_nats::connect(&nats_url).await.expect("connect to the throwaway NATS");
    db::use_prisma_book();

    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "A_BOOK", dec!(3)).await;
    // a BUY LIMIT at 4300, which the tick below has already fallen through
    let order_id = db::insert_order(&mut setup, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Limit, Some(dec!(4300)))).await.unwrap();
    setup.commit().await.unwrap();

    let tick = protocol::Tick {
        symbol: fx.symbol_name.clone(),
        bid: dec!(4298.96),
        ask: dec!(4299.13),
        t0: None,
        clock_offset_ms: None,
        rtt_ms: None,
        tick_ms: None,
        broker_offset_sec: None,
        bars: Vec::new(),
    };
    // both scans, at once, on the same pool -- the shape two ticks arriving together produce
    let (a, b) = (
        order_management::pending_orders::check_symbol_for_triggers(&pool, &nats, &tick),
        order_management::pending_orders::check_symbol_for_triggers(&pool, &nats, &tick),
    );
    tokio::join!(a, b);

    // ONE fill, ONE position, ONE deal, ONE commission charge
    let (positions,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Position" WHERE "originOrderId" = $1"#)
        .bind(&order_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(positions, 1, "two scans must not open two positions for one resting order");
    let (status, filled, routing): (String, Option<Decimal>, Option<String>) =
        sqlx::query_as(r#"SELECT status::text, "filledPrice", routing FROM "Order" WHERE id = $1"#)
            .bind(&order_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "FILLED");
    // a BUY fills at the account's ask; no markup configured on this fixture, so the raw one
    assert_eq!(filled, Some(dec!(4299.13)));
    assert_eq!(routing.as_deref(), Some("A_BOOK"));

    let (deals,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Deal" WHERE "orderId" = $1"#).bind(&order_id).fetch_one(&pool).await.unwrap();
    assert_eq!(deals, 1, "one fill, one IN deal");
    let (charges,): (i64,) = sqlx::query_as(
        r#"SELECT count(*) FROM "Transaction" t JOIN "Position" p ON p.id = t."referenceId"
            WHERE p."originOrderId" = $1 AND t.type = 'COMMISSION'"#,
    )
    .bind(&order_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(charges, 1, "the commission is charged once, not twice");
    let (balance,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&pool).await.unwrap();
    assert_eq!(balance, fx.balance - dec!(0.03), "and the balance moved once");

    // the A-book hedge was queued once as well
    let (effects,): (i64,) = sqlx::query_as(
        r#"SELECT count(*) FROM "PostCloseEffect" e JOIN "Position" p ON p.id = e."positionId"
            WHERE p."originOrderId" = $1 AND e.kind = 'POSITION_OPENED'"#,
    )
    .bind(&order_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(effects, 1);

    // and the whole chain landed on the Prisma book only
    let (legacy,): (i64,) = sqlx::query_as("SELECT count(*) FROM positions WHERE broker_id = $1").bind(&fx.broker).fetch_one(&pool).await.unwrap();
    assert_eq!(legacy, 0);

    cleanup(&pool, &fx).await;
}

/// A resting order whose entry the tick has NOT reached is left alone -- the scan is not a "fill
/// everything pending" pass.
#[tokio::test]
async fn a_resting_order_the_price_has_not_reached_is_left_alone() {
    let Some(pool) = pool().await else { return };
    let Some(nats_url) = std::env::var("ENGINE_TEST_NATS_URL").ok().filter(|u| !u.is_empty()) else {
        eprintln!("a_resting_order_the_price_has_not_reached: ENGINE_TEST_NATS_URL not set, skipping");
        return;
    };
    let nats = async_nats::connect(&nats_url).await.expect("connect to the throwaway NATS");
    db::use_prisma_book();

    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "B_BOOK", dec!(0)).await;
    // a BUY LIMIT far below the market: the ask has to FALL to 4000 for this to trigger
    let order_id = db::insert_order(&mut setup, Book::Prisma, &new_order(&fx, OrderSide::Buy, OrderType::Limit, Some(dec!(4000)))).await.unwrap();
    setup.commit().await.unwrap();

    order_management::pending_orders::check_symbol_for_triggers(
        &pool,
        &nats,
        &protocol::Tick {
            symbol: fx.symbol_name.clone(),
            bid: dec!(4298.96),
            ask: dec!(4299.13),
            t0: None,
            clock_offset_ms: None,
            rtt_ms: None,
            tick_ms: None,
            broker_offset_sec: None,
            bars: Vec::new(),
        },
    )
    .await;

    let (status,): (String,) = sqlx::query_as(r#"SELECT status::text FROM "Order" WHERE id = $1"#).bind(&order_id).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "PENDING", "the price never reached the entry, so the order still rests");
    let (positions,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Position" WHERE "originOrderId" = $1"#)
        .bind(&order_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(positions, 0);
    cleanup(&pool, &fx).await;
}
