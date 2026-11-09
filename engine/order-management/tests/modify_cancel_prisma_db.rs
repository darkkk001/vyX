//! MODIFY + CANCEL ON THE REAL BOOK — the deploy-free half of the proof.
//!
//! Both handlers used to read the engine's own lowercase `positions` / `orders`, which hold 0 rows in
//! production against 6,609 `"Position"` and 6,787 `"Order"`, so every real request answered 404 (checked
//! live: a real OPEN demo position returned `{"error":"position not found"}` / HTTP 404, and a real
//! PENDING order returned `{"error":"order not found"}` / HTTP 404, neither writing anything).
//!
//! This exercises the REAL `modify_position_sl_tp` and `cancel_order` against a real Postgres, so what is
//! asserted is the shipped code path, not a reimplementation. It cannot assert that the risk monitor
//! FIRES on the new SL — that needs the monitor inside a running engine, so it belongs to the post-deploy
//! demo test.
//!
//! What it pins, each of which is a way the fix could be silently wrong:
//!   1. the write lands on Prisma's `"Position"` / `"Order"` at all (the defect)
//!   2. THREE-STATE legs: a TP-only modify must not wipe an existing SL
//!   3. an explicit Clear nulls the leg
//!   4. legWrite: writing a price leg clears its amount sibling, so the live amount monitor cannot end
//!      up with two triggers armed on one position
//!   5. cancel sets CANCELLED and releases a queued close's lock (`closePendingOrderId`)
//!   6. cancel of a non-PENDING order is refused, and says which status it is actually in
//!
//!   ENGINE_TEST_DATABASE_URL=... cargo test --test modify_cancel_prisma_db -- --nocapture

use order_management::db;
use rust_decimal_macros::dec;
use sqlx::PgPool;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) => u,
        Err(_) => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("modify_cancel_prisma_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    Some(PgPool::connect(&url).await.expect("connect"))
}

/// One self-contained fixture: a broker, an account, a symbol, an OPEN position carrying BOTH an slPrice
/// and an slAmount (so legWrite has something to clear), and a PENDING order that is a queued close of
/// that position (so the lock release has something to release).
struct Fx {
    account: String,
    position: String,
    order: String,
}

async fn fixture(pool: &PgPool, tag: &str) -> Fx {
    // Reuse an EXISTING broker and symbol rather than inserting them: "Symbol" has NOT NULL columns
    // (baseCurrency, quoteCurrency, ...) that a hand-written fixture has no business guessing at, and the
    // point of this test is the modify/cancel write path, not schema archaeology.
    let (broker,): (String,) = sqlx::query_as(r#"SELECT id FROM "Broker" ORDER BY id LIMIT 1"#)
        .fetch_one(pool).await.expect("a broker must exist in the test database");
    let (symbol,): (String,) = sqlx::query_as(r#"SELECT id FROM "Symbol" ORDER BY id LIMIT 1"#)
        .fetch_one(pool).await.expect("a symbol must exist in the test database");

    // the same reasoning applies to "Account" (email and others are NOT NULL): reuse one that belongs to
    // the broker we picked, so the foreign keys line up without inventing column values.
    let (account,): (String,) = sqlx::query_as(
        r#"SELECT id FROM "Account" WHERE "brokerId" = $1 ORDER BY id LIMIT 1"#,
    )
    .bind(&broker)
    .fetch_one(pool)
    .await
    .expect("an account must exist for that broker in the test database");

    let position = format!("po_{tag}");
    let order = format!("or_{tag}");
    // Column lists taken from the database, not guessed: these are exactly the NOT NULL columns with no
    // default. "Position" also needs an originOrderId, so the resting order is inserted FIRST and the
    // position points at it; then the order is re-pointed as that position's queued close.
    sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, status, volume, "requestedPrice", "idempotencyKey", "updatedAt")
                   VALUES ($1,$2,$3,$4,'BUY','LIMIT','PENDING',0.01,1.28000,$1,now())"#)
        .bind(&order).bind(&broker).bind(&account).bind(&symbol).execute(pool).await.expect("order");
    sqlx::query(r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket, status, "slPrice", "slAmount")
                   VALUES ($1,$2,$3,$4,$5,'BUY',0.01,1.30000,$6,'OPEN',1.29000,25.0)"#)
        .bind(&position).bind(&broker).bind(&account).bind(&symbol).bind(&order)
        .bind(i64::from(std::process::id() % 1_000_000) + 900_000_000)
        .execute(pool).await.expect("position");
    // the order becomes that position's queued close, and takes the lock
    sqlx::query(r#"UPDATE "Order" SET "closesPositionId" = $2 WHERE id = $1"#)
        .bind(&order).bind(&position).execute(pool).await.expect("closes");
    sqlx::query(r#"UPDATE "Position" SET "closePendingOrderId" = $2 WHERE id = $1"#)
        .bind(&position).bind(&order).execute(pool).await.expect("lock");

    Fx { account, position, order }
}

async fn legs(pool: &PgPool, id: &str) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    sqlx::query_as(
        r#"SELECT "slPrice"::text, "tpPrice"::text, "slAmount"::text, "tpAmount"::text FROM "Position" WHERE id = $1"#,
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .expect("legs")
}

async fn order_state(pool: &PgPool, order: &str, position: &str) -> (String, Option<String>) {
    let status: (String,) = sqlx::query_as(r#"SELECT status::text FROM "Order" WHERE id = $1"#)
        .bind(order).fetch_one(pool).await.expect("order status");
    let lock: (Option<String>,) = sqlx::query_as(r#"SELECT "closePendingOrderId" FROM "Position" WHERE id = $1"#)
        .bind(position).fetch_one(pool).await.expect("lock");
    (status.0, lock.0)
}

#[tokio::test]
async fn modify_and_cancel_hit_the_prisma_book() {
    let Some(pool) = pool().await else { return };
    db::use_prisma_book();
    assert!(matches!(db::configured(), db::Book::Prisma), "the Prisma book must be selected");

    let nats = async_nats::connect(std::env::var("NATS_URL").unwrap_or_else(|_| "127.0.0.1:4222".into()))
        .await
        .expect("nats (the handlers publish best-effort, but still need a client)");

    let tag = format!("mc{}", std::process::id());
    let fx = fixture(&pool, &tag).await;

    let before = legs(&pool, &fx.position).await;
    println!("BEFORE position legs  slPrice={:?} tpPrice={:?} slAmount={:?} tpAmount={:?}", before.0, before.1, before.2, before.3);
    assert_eq!(before.0.as_deref(), Some("1.29000"), "fixture: slPrice set");
    assert_eq!(before.2.as_deref(), Some("25.0000"), "fixture: slAmount set too");

    // ---- (2) THREE STATE: a TP-only modify must leave the SL alone -------------------------------
    let out = order_management::modify_position_sl_tp(
        &pool, &nats, &fx.account, &fx.position, dec!(1.30000),
        db::Leg::Untouched,          // SL not mentioned
        db::Leg::Set(dec!(1.31000)), // TP set
    )
    .await
    .expect("modify tp only");
    println!("TP-ONLY modify -> {out:?}");
    let a = legs(&pool, &fx.position).await;
    println!("AFTER  tp-only        slPrice={:?} tpPrice={:?} slAmount={:?} tpAmount={:?}", a.0, a.1, a.2, a.3);
    assert_eq!(a.0.as_deref(), Some("1.29000"), "an untouched SL leg must survive a TP-only modify");
    assert_eq!(a.1.as_deref(), Some("1.31000"), "the TP must be set");
    assert_eq!(a.2.as_deref(), Some("25.0000"), "an untouched SL amount must survive too");
    assert_eq!(a.3, None, "legWrite: setting tpPrice clears tpAmount");

    // ---- (4) legWrite: setting slPrice clears slAmount --------------------------------------------
    order_management::modify_position_sl_tp(
        &pool, &nats, &fx.account, &fx.position, dec!(1.30000),
        db::Leg::Set(dec!(1.28500)),
        db::Leg::Untouched,
    )
    .await
    .expect("modify sl");
    let b = legs(&pool, &fx.position).await;
    println!("AFTER  sl set         slPrice={:?} tpPrice={:?} slAmount={:?} tpAmount={:?}", b.0, b.1, b.2, b.3);
    assert_eq!(b.0.as_deref(), Some("1.28500"));
    assert_eq!(b.2, None, "legWrite: setting slPrice MUST clear slAmount or two triggers stay armed");
    assert_eq!(b.1.as_deref(), Some("1.31000"), "the TP leg was untouched by an SL-only modify");

    // ---- (3) explicit Clear nulls the leg ---------------------------------------------------------
    order_management::modify_position_sl_tp(
        &pool, &nats, &fx.account, &fx.position, dec!(1.30000),
        db::Leg::Clear,
        db::Leg::Untouched,
    )
    .await
    .expect("modify clear sl");
    let c = legs(&pool, &fx.position).await;
    println!("AFTER  sl cleared     slPrice={:?} tpPrice={:?} slAmount={:?} tpAmount={:?}", c.0, c.1, c.2, c.3);
    assert_eq!(c.0, None, "an explicit Clear must null the leg");
    assert_eq!(c.1.as_deref(), Some("1.31000"), "and still leave the other leg alone");

    // wrong account must not find it, and must not say why
    let other = order_management::modify_position_sl_tp(
        &pool, &nats, "someone-else", &fx.position, dec!(1.30000), db::Leg::Set(dec!(1.2)), db::Leg::Untouched,
    ).await.expect("modify foreign");
    println!("FOREIGN account modify -> {other:?}");
    assert!(matches!(other, order_management::ModifyPositionOutcome::NotFound), "a foreign account gets NotFound");

    // ---- (5) cancel: CANCELLED + the queued close's lock released ---------------------------------
    let (s0, l0) = order_state(&pool, &fx.order, &fx.position).await;
    println!("BEFORE cancel         order={s0} closePendingOrderId={l0:?}");
    assert_eq!(s0, "PENDING");
    assert_eq!(l0.as_deref(), Some(fx.order.as_str()), "fixture: the position is locked by this order");

    let out = order_management::cancel_order(&pool, &nats, &fx.order, &fx.account).await.expect("cancel");
    println!("CANCEL -> {out:?}");
    assert!(matches!(out, order_management::CancelOrderOutcome::Cancelled { .. }));
    let (s1, l1) = order_state(&pool, &fx.order, &fx.position).await;
    println!("AFTER  cancel         order={s1} closePendingOrderId={l1:?}");
    assert_eq!(s1, "CANCELLED");
    assert_eq!(l1, None, "cancelling a queued close MUST release the position's lock");

    // ---- (6) a second cancel is refused, naming the real status -----------------------------------
    let again = order_management::cancel_order(&pool, &nats, &fx.order, &fx.account).await.expect("cancel twice");
    println!("CANCEL AGAIN -> {again:?}");
    match again {
        order_management::CancelOrderOutcome::InvalidStatus { status } => assert_eq!(status, "CANCELLED"),
        other => panic!("a second cancel must be refused with the real status, got {other:?}"),
    }

    println!("ALL MODIFY/CANCEL PRISMA-BOOK ASSERTIONS PASSED");
}
