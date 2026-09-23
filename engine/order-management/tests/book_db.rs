//! DB-backed tests for book.rs (Rust cutover Stage 1) on the REAL Prisma schema.
//!
//! Needs a scratch Postgres carrying the Prisma migrations (see engine/parity/README.md):
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test \
//!   VYX_REQUIRE_DB_TESTS=1 cargo test -p order-management --test book_db
//! Without the URL the tests skip, unless VYX_REQUIRE_DB_TESTS=1, which makes a missing DB a failure (the
//! parity harness sets it, so a gate can never pass by silently skipping). The URL must be 127.0.0.1: these
//! tests write rows, and refuse anything that looks like a real database.
//!
//! Every test runs inside one transaction that is rolled back, except the concurrency test, which needs
//! committed rows and deletes them afterwards.

use order_management::book;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::str::FromStr;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("book_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

struct Fx {
    broker: String,
    account: String,
    symbol: String,
}

fn id() -> String {
    Uuid::new_v4().simple().to_string()
}

async fn fixture(db: &mut sqlx::PgConnection, balance: Decimal, nbp: bool) -> Fx {
    let (broker, group, account) = (id(), id(), id());
    let tag = &broker[..10];
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "negativeBalanceProtection", "updatedAt") VALUES ($1, $2, $3, $4, now())"#)
        .bind(&broker).bind(format!("Book DB Test {tag}")).bind(format!("bookdb-{tag}")).bind(nbp)
        .execute(&mut *db).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "updatedAt") VALUES ($1, $2, $3, now())"#)
        .bind(&group).bind(&broker).bind(format!("BOOKDB-{tag}"))
        .execute(&mut *db).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'Book DB Test', 'LIVE', $6, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("5{}", &tag[..7])).bind(format!("bookdb-{tag}@test.local")).bind(balance)
    .execute(&mut *db).await.unwrap();
    let (symbol,): (String,) = sqlx::query_as(r#"SELECT id FROM "Symbol" WHERE name = 'XAUUSD'"#).fetch_one(&mut *db).await.expect("XAUUSD seeded");
    Fx { broker, account, symbol }
}

async fn open_position(db: &mut sqlx::PgConnection, fx: &Fx, side: &str, volume: Decimal, open_price: Decimal) -> String {
    let (order, position) = (id(), id());
    sqlx::query(
        r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
           VALUES ($1, $2, $3, $4, $5::"OrderSide", 'MARKET', $6, 'FILLED', $7, now())"#,
    )
    .bind(&order).bind(&fx.broker).bind(&fx.account).bind(&fx.symbol).bind(side).bind(volume).bind(format!("bookdb:{order}"))
    .execute(&mut *db).await.unwrap();
    let ticket: i32 = (u32::from_str_radix(&position[..7], 16).unwrap() % 2_000_000_000) as i32;
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket)
           VALUES ($1, $2, $3, $4, $5, $6::"OrderSide", $7, $8, $9)"#,
    )
    .bind(&position).bind(&fx.broker).bind(&fx.account).bind(&fx.symbol).bind(&order).bind(side).bind(volume).bind(open_price).bind(ticket)
    .execute(&mut *db).await.unwrap();
    position
}

async fn balance(db: &mut sqlx::PgConnection, account: &str) -> Decimal {
    let (b,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(account).fetch_one(&mut *db).await.unwrap();
    b
}

#[tokio::test]
async fn close_writes_balance_trade_pnl_and_closes_the_position() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let pos = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;

    let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4010), dec!(1000), "Stop loss hit (automatic)")
        .await.unwrap().expect("closed");
    assert_eq!(out.final_balance, dec!(101000));
    assert_eq!(out.write_off, None);
    assert_eq!(balance(&mut *tx, &fx.account).await, dec!(101000));
    let (status, close_price, pnl): (String, Decimal, Decimal) =
        sqlx::query_as(r#"SELECT status::text, "closePrice", "realizedPnl" FROM "Position" WHERE id = $1"#).bind(&pos).fetch_one(&mut *tx).await.unwrap();
    assert_eq!((status.as_str(), close_price, pnl), ("CLOSED", dec!(4010), dec!(1000)));
    let rows: Vec<(String, Decimal, Decimal, Decimal, Option<String>)> = sqlx::query_as(
        r#"SELECT type::text, amount, "balanceBefore", "balanceAfter", note FROM "Transaction" WHERE "accountId" = $1"#,
    ).bind(&fx.account).fetch_all(&mut *tx).await.unwrap();
    assert_eq!(rows, vec![("TRADE_PNL".into(), dec!(1000), dec!(100000), dec!(101000), Some("Stop loss hit (automatic)".into()))]);
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn a_second_close_or_a_stale_volume_writes_nothing() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let pos = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;
    let other = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;

    assert!(book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4010), dec!(1000), "x").await.unwrap().is_some());
    assert!(book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4050), dec!(5000), "x").await.unwrap().is_none());
    // a caller that read `other` at 2 lots (it holds 1): refused, not paid for lots it does not have
    assert!(book::close_position_in_tx(&mut tx, &other, dec!(2), dec!(4010), dec!(2000), "x").await.unwrap().is_none());

    assert_eq!(balance(&mut *tx, &fx.account).await, dec!(101000));
    let (n,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Transaction" WHERE "accountId" = $1"#).bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(n, 1);
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn negative_balance_protection_floors_at_zero_and_books_the_write_off() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(50), true).await;
    let pos = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;

    let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(3995), dec!(-500), "Stop-out (automatic): margin level 9.99% below 50%")
        .await.unwrap().expect("closed");
    assert_eq!((out.raw_balance_after, out.final_balance, out.write_off, out.credit_used), (dec!(-450), dec!(0), Some(dec!(450)), None));
    assert_eq!(balance(&mut *tx, &fx.account).await, dec!(0));
    let rows: Vec<(String, Decimal, Decimal, Decimal)> = sqlx::query_as(
        r#"SELECT type::text, amount, "balanceBefore", "balanceAfter" FROM "Transaction" WHERE "accountId" = $1 ORDER BY type::text DESC"#,
    ).bind(&fx.account).fetch_all(&mut *tx).await.unwrap();
    assert_eq!(rows, vec![
        ("TRADE_PNL".into(), dec!(-500), dec!(50), dec!(-450)),
        ("NEGATIVE_BALANCE_PROTECTION".into(), dec!(450), dec!(-450), dec!(0)),
    ]);
    let (audits,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "AuditLog" WHERE "entityId" = $1 AND action = 'NEGATIVE_BALANCE_PROTECTION_APPLIED'"#)
        .bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(audits, 1);
    tx.rollback().await.unwrap();
}

/// Stage 2 F1 (credit Model A, = lib/position-close.ts): balance first, then credit, then NBP.
#[tokio::test]
async fn a_loss_beyond_the_balance_is_paid_from_credit_then_written_off() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100), true).await;
    sqlx::query(r#"UPDATE "Account" SET credit = 50 WHERE id = $1"#).bind(&fx.account).execute(&mut *tx).await.unwrap();
    let covered = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;
    let out = book::close_position_in_tx(&mut tx, &covered, dec!(1), dec!(3998.8), dec!(-120), "x").await.unwrap().expect("closed");
    assert_eq!((out.final_balance, out.final_credit, out.credit_used, out.write_off), (dec!(0), dec!(30), Some(dec!(20)), None));

    // the remaining 30 of credit is short of the next -50: it is used up and NBP writes off the last 20
    let short = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;
    let out = book::close_position_in_tx(&mut tx, &short, dec!(1), dec!(3999.5), dec!(-50), "x").await.unwrap().expect("closed");
    assert_eq!((out.final_balance, out.final_credit, out.credit_used, out.write_off), (dec!(0), dec!(0), Some(dec!(30)), Some(dec!(20))));

    let rows: Vec<(String, Decimal, Decimal, Decimal)> = sqlx::query_as(
        r#"SELECT type::text, amount, "balanceBefore", "balanceAfter" FROM "Transaction" WHERE "accountId" = $1 AND type = 'CREDIT' ORDER BY amount"#,
    ).bind(&fx.account).fetch_all(&mut *tx).await.unwrap();
    assert_eq!(rows, vec![("CREDIT".into(), dec!(20), dec!(-20), dec!(0)), ("CREDIT".into(), dec!(30), dec!(-50), dec!(-20))]);
    let (audits,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "AuditLog" WHERE "entityId" = $1 AND action = 'CREDIT_CONSUMED_BY_LOSS'"#)
        .bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(audits, 2);
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn without_protection_the_balance_goes_negative_and_nothing_is_written_off() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(50), false).await;
    let pos = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;
    let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(3995), dec!(-500), "x").await.unwrap().expect("closed");
    assert_eq!((out.final_balance, out.write_off), (dec!(-450), None));
    assert_eq!(balance(&mut *tx, &fx.account).await, dec!(-450));
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn open_positions_come_from_the_prisma_book() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(1000), true).await;
    let a = open_position(&mut *tx, &fx, "BUY", dec!(0.5), dec!(4000)).await;
    let b = open_position(&mut *tx, &fx, "SELL", dec!(0.25), dec!(4100)).await;
    tx.commit().await.unwrap(); // the reader takes the pool, so these two rows are committed and removed below

    let got = book::open_positions_with_market(&pool, &fx.account).await.unwrap();
    let ids: std::collections::HashSet<_> = got.iter().map(|p| p.id.clone()).collect();
    let listed = book::account_ids_with_open_positions(&pool).await.unwrap();
    cleanup(&pool, &fx.broker).await;

    assert_eq!(ids, [a, b].into_iter().collect());
    assert!(got.iter().all(|p| p.symbol == "XAUUSD" && p.contract_size == Decimal::from_str("100").unwrap()));
    assert!(listed.contains(&fx.account));
}

#[tokio::test]
async fn concurrent_closes_on_one_account_never_lose_a_pnl() {
    let Some(pool) = pool().await else { return };
    let mut conn = pool.acquire().await.unwrap();
    let fx = fixture(&mut conn, dec!(100000), true).await;
    let mut positions = Vec::new();
    for _ in 0..10 {
        positions.push(open_position(&mut conn, &fx, "BUY", dec!(1), dec!(4000)).await);
    }
    let handles: Vec<_> = positions
        .iter()
        .map(|pos| {
            let (pool, pos) = (pool.clone(), pos.clone());
            tokio::spawn(async move {
                let mut tx = pool.begin().await.unwrap();
                let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4010), dec!(1000), "x").await.unwrap();
                tx.commit().await.unwrap();
                out.is_some()
            })
        })
        .collect();
    let mut closed = 0;
    for h in handles {
        if h.await.unwrap() {
            closed += 1;
        }
    }
    let final_balance = balance(&mut conn, &fx.account).await;
    cleanup(&pool, &fx.broker).await;
    assert_eq!(closed, 10);
    assert_eq!(final_balance, dec!(110000));
}

/// Stage 3: the close and its post-close outbox row are one transaction -- both or neither -- and one close can
/// only ever queue one row.
#[tokio::test]
async fn a_close_and_its_outbox_row_commit_or_roll_back_together() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(50), true).await;
    let pos = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;
    let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(3995), dec!(-500.0000), "x").await.unwrap().expect("closed");
    assert_eq!((out.account_id.as_str(), out.broker_id.as_str()), (fx.account.as_str(), fx.broker.as_str()));
    let reason = book::CloseReason::StopOut { margin_level: dec!(9.9909), stop_out_level: dec!(50.00) };
    book::enqueue_post_close(&mut tx, &pos, &out, reason, dec!(1.00), dec!(3995.00)).await.unwrap();
    book::enqueue_post_close(&mut tx, &pos, &out, reason, dec!(1.00), dec!(3995.00)).await.unwrap(); // a replay: no second row

    let (txn,): (String,) = sqlx::query_as(r#"SELECT id FROM "Transaction" WHERE "referenceId" = $1 AND type = 'TRADE_PNL'"#)
        .bind(&pos).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(txn, out.trade_txn_id);
    let rows: Vec<(String, String, String, String, serde_json::Value)> = sqlx::query_as(
        r#"SELECT kind, "dedupeKey", reason, status, payload FROM "PostCloseEffect" WHERE "positionId" = $1"#,
    ).bind(&pos).fetch_all(&mut *tx).await.unwrap();
    assert_eq!(rows.len(), 1);
    let (kind, key, why, status, payload) = rows[0].clone();
    assert_eq!((kind.as_str(), why.as_str(), status.as_str()), ("POSITION_CLOSED", "stop_out", "PENDING"));
    assert_eq!(key, format!("close:{pos}:{txn}"));
    assert_eq!(payload, serde_json::json!({
        "closedLots": "1", "sourceVolumeBeforeClose": "1", "closePrice": "3995", "realizedPnl": "-500",
        "marginLevel": "9.99", "stopOutLevel": "50",
    }));
    tx.rollback().await.unwrap();

    let (n,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "PostCloseEffect" WHERE "positionId" = $1"#).bind(&pos).fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0, "a rolled-back close leaves no follow-up behind");
}

/// Stage 3: the margin-call edge on "Account"."marginCallNotifiedAt" -- one notice per episode.
#[tokio::test]
async fn margin_call_edge_notifies_once_per_episode() {
    let Some(pool) = pool().await else { return };
    let mut conn = pool.acquire().await.unwrap();
    let fx = fixture(&mut conn, dec!(1000), true).await;
    drop(conn);
    let into = book::MarginCallEdge::In { margin_level: dec!(90.9090), call_level: dec!(100.00) };
    let rows = |pool: PgPool, account: String| async move {
        let r: Vec<(String, serde_json::Value)> = sqlx::query_as(r#"SELECT kind, payload FROM "PostCloseEffect" WHERE "accountId" = $1 ORDER BY "createdAt""#)
            .bind(&account).fetch_all(&pool).await.unwrap();
        r
    };
    assert!(book::apply_margin_call_edge(&pool, &fx.account, into).await.unwrap());
    assert!(!book::apply_margin_call_edge(&pool, &fx.account, into).await.unwrap(), "still in: no second notice");
    assert_eq!(rows(pool.clone(), fx.account.clone()).await.len(), 1);
    assert!(!book::apply_margin_call_edge(&pool, &fx.account, book::MarginCallEdge::Out).await.unwrap());
    let (set,): (bool,) = sqlx::query_as(r#"SELECT "marginCallNotifiedAt" IS NOT NULL FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&pool).await.unwrap();
    assert!(!set, "recovery clears the edge");
    tokio::time::sleep(std::time::Duration::from_millis(5)).await; // a new episode, a new millisecond
    assert!(book::apply_margin_call_edge(&pool, &fx.account, into).await.unwrap(), "a new episode notifies again");
    let all = rows(pool.clone(), fx.account.clone()).await;
    sqlx::query(r#"DELETE FROM "PostCloseEffect" WHERE "accountId" = $1"#).bind(&fx.account).execute(&pool).await.unwrap();
    cleanup(&pool, &fx.broker).await;
    assert_eq!(all.len(), 2);
    assert!(all.iter().all(|(k, p)| k == "MARGIN_CALL" && *p == serde_json::json!({ "marginLevel": "90.91", "marginCallLevel": "100" })));
}

async fn cleanup(pool: &PgPool, broker: &str) {
    for sql in [
        r#"DELETE FROM "AuditLog" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Transaction" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Broker" WHERE id = $1"#,
    ] {
        sqlx::query(sql).bind(broker).execute(pool).await.unwrap();
    }
}
