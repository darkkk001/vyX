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

    let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4010), dec!(1000), "Stop loss hit (automatic)", book::DealReason::Sl)
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

    assert!(book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4010), dec!(1000), "x", book::DealReason::Sl).await.unwrap().is_some());
    assert!(book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4050), dec!(5000), "x", book::DealReason::Sl).await.unwrap().is_none());
    // a caller that read `other` at 2 lots (it holds 1): refused, not paid for lots it does not have
    assert!(book::close_position_in_tx(&mut tx, &other, dec!(2), dec!(4010), dec!(2000), "x", book::DealReason::Sl).await.unwrap().is_none());

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

    let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(3995), dec!(-500), "Stop-out (automatic): margin level 9.99% below 50%", book::DealReason::StopOut)
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
    let out = book::close_position_in_tx(&mut tx, &covered, dec!(1), dec!(3998.8), dec!(-120), "x", book::DealReason::Sl).await.unwrap().expect("closed");
    assert_eq!((out.final_balance, out.final_credit, out.credit_used, out.write_off), (dec!(0), dec!(30), Some(dec!(20)), None));

    // the remaining 30 of credit is short of the next -50: it is used up and NBP writes off the last 20
    let short = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;
    let out = book::close_position_in_tx(&mut tx, &short, dec!(1), dec!(3999.5), dec!(-50), "x", book::DealReason::Sl).await.unwrap().expect("closed");
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
    let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(3995), dec!(-500), "x", book::DealReason::Sl).await.unwrap().expect("closed");
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
    let fx = fixture(&mut *conn, dec!(100000), true).await;
    let mut positions = Vec::new();
    for _ in 0..10 {
        positions.push(open_position(&mut *conn, &fx, "BUY", dec!(1), dec!(4000)).await);
    }
    let handles: Vec<_> = positions
        .iter()
        .map(|pos| {
            let (pool, pos) = (pool.clone(), pos.clone());
            tokio::spawn(async move {
                let mut tx = pool.begin().await.unwrap();
                let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4010), dec!(1000), "x", book::DealReason::Sl).await.unwrap();
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
    let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(3995), dec!(-500.0000), "x", book::DealReason::Sl).await.unwrap().expect("closed");
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
        "dealId": out.deal_id, "dealTicket": out.deal_ticket.to_string(), "remainingVolume": "0",
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

/// Stage 4.5: an account waits for a pending follow-up that will close its auto-hedged leg -- only while that
/// step is not done, only for FOLLOW_UP_DEFER_SECS, and never for a dealer-booked leg (the web leaves those open).
#[tokio::test]
async fn a_pending_follow_up_defers_the_account_it_will_touch_but_never_for_long() {
    let Some(pool) = pool().await else { return };
    let mut conn = pool.acquire().await.unwrap();
    let fx = fixture(&mut conn, dec!(1000), true).await;
    let leg = open_position(&mut *conn, &fx, "BUY", dec!(1), dec!(4000)).await;
    let source = open_position(&mut *conn, &fx, "BUY", dec!(1), dec!(4000)).await;
    drop(conn);
    sqlx::query(r#"UPDATE "Position" SET "autoHedged" = true WHERE id = $1"#).bind(&leg).execute(&pool).await.unwrap();
    sqlx::query(r#"UPDATE "Position" SET status = 'CLOSED', "coveragePositionId" = $2 WHERE id = $1"#).bind(&source).bind(&leg).execute(&pool).await.unwrap();
    let row = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO "PostCloseEffect" (id, kind, "dedupeKey", "brokerId", "accountId", "positionId", reason, payload)
           VALUES ($1, 'POSITION_CLOSED', $1, $2, $3, $4, 'stop_out', '{}'::jsonb)"#,
    ).bind(&row).bind(&fx.broker).bind(&fx.account).bind(&source).execute(&pool).await.unwrap();

    let owns = || book::pending_follow_up_owns(&pool, &fx.account);
    let fresh = owns().await.unwrap();
    sqlx::query(r#"UPDATE "PostCloseEffect" SET "doneSteps" = ARRAY['coverage'] WHERE id = $1"#).bind(&row).execute(&pool).await.unwrap();
    let coverage_done = owns().await.unwrap();
    sqlx::query(r#"UPDATE "PostCloseEffect" SET "doneSteps" = ARRAY[]::text[], "createdAt" = now() - interval '31 seconds' WHERE id = $1"#).bind(&row).execute(&pool).await.unwrap();
    let too_old = owns().await.unwrap();
    sqlx::query(r#"UPDATE "PostCloseEffect" SET "createdAt" = now() WHERE id = $1"#).bind(&row).execute(&pool).await.unwrap();
    sqlx::query(r#"UPDATE "Position" SET "autoHedged" = false WHERE id = $1"#).bind(&leg).execute(&pool).await.unwrap();
    let dealer_booked = owns().await.unwrap();

    sqlx::query(r#"DELETE FROM "PostCloseEffect" WHERE id = $1"#).bind(&row).execute(&pool).await.unwrap();
    sqlx::query(r#"UPDATE "Position" SET "coveragePositionId" = NULL WHERE "brokerId" = $1"#).bind(&fx.broker).execute(&pool).await.unwrap();
    cleanup(&pool, &fx.broker).await;
    assert!(fresh, "a fresh pending leg close defers the leg's account");
    assert!(!coverage_done, "once the coverage step ran, nothing is owed");
    assert!(!too_old, "past FOLLOW_UP_DEFER_SECS the account is evaluated anyway (a stuck outbox never blocks a stop-out)");
    assert!(!dealer_booked, "a dealer-booked leg is not waited for");
}

async fn cleanup(pool: &PgPool, broker: &str) {
    for sql in [
        r#"DELETE FROM "AuditLog" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Deal" WHERE "brokerId" = $1"#,
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

// ---- close-fields gate (docs/POSITION-DEAL-MODEL.md section 0): the structured fields lib/position-close.ts writes ----

type CloseFields = (Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<String>);

async fn txn_close_fields(db: &mut sqlx::PgConnection, position: &str) -> CloseFields {
    sqlx::query_as(r#"SELECT "closeVolume", "closePrice", "closeSwap", "closeByPositionId" FROM "Transaction" WHERE "referenceId" = $1 AND type = 'TRADE_PNL'"#)
        .bind(position)
        .fetch_one(&mut *db)
        .await
        .unwrap()
}

async fn totals(db: &mut sqlx::PgConnection, position: &str) -> (Option<Decimal>, Option<Decimal>, Option<Decimal>) {
    sqlx::query_as(r#"SELECT "realizedPnl", "closedVolume", "closedSwap" FROM "Position" WHERE id = $1"#).bind(position).fetch_one(&mut *db).await.unwrap()
}

#[tokio::test]
async fn full_close_writes_close_fields_running_totals_and_the_swap_share() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let pos = open_position(&mut *tx, &fx, "BUY", dec!(1.5), dec!(4000)).await;
    sqlx::query(r#"UPDATE "Position" SET swap = 12.3456 WHERE id = $1"#).bind(&pos).execute(&mut *tx).await.unwrap();

    book::close_position_in_tx(&mut tx, &pos, dec!(1.5), dec!(4010), dec!(1500), "Stop loss hit (automatic)", book::DealReason::Sl).await.unwrap().expect("closed");
    // never partial: closeVolume is the whole lot, closeSwap = round2(swap - closedSwap) = 12.35, no close-by partner
    assert_eq!(txn_close_fields(&mut *tx, &pos).await, (Some(dec!(1.5)), Some(dec!(4010)), Some(dec!(12.35)), None));
    assert_eq!(totals(&mut *tx, &pos).await, (Some(dec!(1500)), Some(dec!(1.5)), Some(dec!(12.35))));
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn close_after_a_web_partial_adds_to_the_running_totals_and_takes_the_swap_remainder() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let pos = open_position(&mut *tx, &fx, "SELL", dec!(1), dec!(4000)).await;
    // what lib/position-close.ts leaves after closing 0.5 of 1.5 lots: realizedPnl, closedVolume, closedSwap are running totals
    sqlx::query(r#"UPDATE "Position" SET swap = 12.3456, "realizedPnl" = 80, "closedVolume" = 0.5, "closedSwap" = 4.11 WHERE id = $1"#)
        .bind(&pos).execute(&mut *tx).await.unwrap();

    book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(3995), dec!(500), "Take profit hit (automatic)", book::DealReason::Tp).await.unwrap().expect("closed");
    assert_eq!(txn_close_fields(&mut *tx, &pos).await, (Some(dec!(1)), Some(dec!(3995)), Some(dec!(8.24)), None));
    // 4.11 + round2(12.3456 - 4.11) = 12.35, the shares add up to the swap
    assert_eq!(totals(&mut *tx, &pos).await, (Some(dec!(580)), Some(dec!(1.5)), Some(dec!(12.35))));
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn swap_share_rounds_half_away_from_zero_like_the_web() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let (neg, pos_half) = (open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await, open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await);
    sqlx::query(r#"UPDATE "Position" SET swap = -3.2250 WHERE id = $1"#).bind(&neg).execute(&mut *tx).await.unwrap();
    sqlx::query(r#"UPDATE "Position" SET swap = 0.0050 WHERE id = $1"#).bind(&pos_half).execute(&mut *tx).await.unwrap();

    book::close_position_in_tx(&mut tx, &neg, dec!(1), dec!(4000), dec!(0), "x", book::DealReason::Sl).await.unwrap().expect("closed");
    book::close_position_in_tx(&mut tx, &pos_half, dec!(1), dec!(4000), dec!(0), "x", book::DealReason::Sl).await.unwrap().expect("closed");
    assert_eq!(txn_close_fields(&mut *tx, &neg).await.2, Some(dec!(-3.23)));
    assert_eq!(txn_close_fields(&mut *tx, &pos_half).await.2, Some(dec!(0.01)));
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn close_by_partner_link_is_stored_on_the_ledger_row() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let (a, b) = (open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await, open_position(&mut *tx, &fx, "SELL", dec!(1), dec!(4000)).await);

    // the two legs of a close-by name each other (lib/close-by.ts passes closeByPositionId on both closePositionInTx calls)
    for (me, other, pnl) in [(&a, &b, dec!(-50)), (&b, &a, dec!(50))] {
        let r = book::close_position_full(&mut tx, None, me, dec!(1), dec!(3995), pnl, &format!("Close by {other}"), book::DealReason::CloseBy, Some(other.as_str())).await.unwrap();
        assert!(matches!(r, book::CloseResult::Closed(_)));
    }
    assert_eq!(txn_close_fields(&mut *tx, &a).await, (Some(dec!(1)), Some(dec!(3995)), Some(dec!(0)), Some(b.clone())));
    assert_eq!(txn_close_fields(&mut *tx, &b).await, (Some(dec!(1)), Some(dec!(3995)), Some(dec!(0)), Some(a.clone())));
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn a_lost_close_leaves_the_close_fields_and_totals_untouched() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let pos = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;
    sqlx::query(r#"UPDATE "Position" SET swap = 5 WHERE id = $1"#).bind(&pos).execute(&mut *tx).await.unwrap();

    // the caller read a stale volume: nothing is written, no ledger row, totals still unset
    assert!(book::close_position_in_tx(&mut tx, &pos, dec!(2), dec!(4010), dec!(2000), "x", book::DealReason::Sl).await.unwrap().is_none());
    assert_eq!(totals(&mut *tx, &pos).await, (None, None, None));
    let (n,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Transaction" WHERE "referenceId" = $1"#).bind(&pos).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(n, 0);
    tx.rollback().await.unwrap();
}
// ---- deal model, step 2 (docs/POSITION-DEAL-MODEL.md section 3.3): the engine's close writes its OUT deal ----

type DealRow = (String, String, String, String, Decimal, Decimal, Decimal, Decimal, Option<String>, Option<String>, String, i64);

async fn deals_of(db: &mut sqlx::PgConnection, position: &str) -> Vec<DealRow> {
    sqlx::query_as(
        r#"SELECT entry::text, reason::text, side::text, "symbolId", volume, price, profit, swap, "byPositionId", "transactionId", "accountId", ticket
           FROM "Deal" WHERE "positionId" = $1 ORDER BY ticket"#,
    )
    .bind(position)
    .fetch_all(&mut *db)
    .await
    .unwrap()
}

#[tokio::test]
async fn a_close_writes_one_out_deal_linked_to_its_trade_pnl_row() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let pos = open_position(&mut *tx, &fx, "BUY", dec!(1.5), dec!(4000)).await;
    sqlx::query(r#"UPDATE "Position" SET swap = -3, "closedSwap" = -1, "closedVolume" = 0.5, "realizedPnl" = 20 WHERE id = $1"#).bind(&pos).execute(&mut *tx).await.unwrap();

    let out = book::close_position_in_tx(&mut tx, &pos, dec!(1.5), dec!(3990.5), dec!(-1425), "Stop loss hit (automatic)", book::DealReason::Sl)
        .await.unwrap().expect("closed");
    let deals = deals_of(&mut *tx, &pos).await;
    assert_eq!(deals.len(), 1);
    let (entry, reason, side, symbol, volume, price, profit, swap, by, txn, account, ticket) = deals[0].clone();
    assert_eq!((entry.as_str(), reason.as_str(), side.as_str()), ("OUT", "SL", "SELL"), "closing a BUY is a SELL deal");
    assert_eq!((symbol, volume, price, profit, swap, by), (fx.symbol.clone(), dec!(1.5), dec!(3990.5), dec!(-1425), dec!(-2), None));
    assert_eq!((txn, account, ticket), (Some(out.trade_txn_id.clone()), fx.account.clone(), out.deal_ticket));
    assert!(ticket > 10_000_000, "deal tickets start at 10000001");
    // the deal and its ledger row agree, and the deal's time is the row's
    let (amount, close_volume, close_price, close_swap, same_time): (Decimal, Decimal, Decimal, Decimal, bool) = sqlx::query_as(
        r#"SELECT t.amount, t."closeVolume", t."closePrice", t."closeSwap", t."createdAt" = d."executedAt"
           FROM "Transaction" t JOIN "Deal" d ON d."transactionId" = t.id WHERE t.id = $1"#,
    ).bind(&out.trade_txn_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!((amount, close_volume, close_price, close_swap, same_time), (dec!(-1425), dec!(1.5), dec!(3990.5), dec!(-2), true));
    let (id,): (String,) = sqlx::query_as(r#"SELECT id FROM "Deal" WHERE "transactionId" = $1"#).bind(&out.trade_txn_id).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(id, out.deal_id);
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn sell_side_and_every_risk_reason_map_to_the_schema_enum() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    for (reason, want) in [(book::CloseReason::TakeProfit, "TP"), (book::CloseReason::StopOut { margin_level: dec!(40), stop_out_level: dec!(50) }, "STOP_OUT")] {
        let pos = open_position(&mut *tx, &fx, "SELL", dec!(1), dec!(4000)).await;
        book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(3990), dec!(1000), "x", reason.deal_reason()).await.unwrap().expect("closed");
        let deals = deals_of(&mut *tx, &pos).await;
        assert_eq!((deals[0].0.as_str(), deals[0].1.as_str(), deals[0].2.as_str()), ("OUT", want, "BUY"), "closing a SELL is a BUY deal");
    }
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn a_lost_close_writes_no_deal_and_a_rolled_back_close_leaves_none() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let pos = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;
    // stale volume: benign, nothing written
    assert!(book::close_position_in_tx(&mut tx, &pos, dec!(2), dec!(4010), dec!(2000), "x", book::DealReason::Sl).await.unwrap().is_none());
    assert!(deals_of(&mut *tx, &pos).await.is_empty());
    // a second close of a closed position: one deal, not two
    book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4010), dec!(1000), "x", book::DealReason::Sl).await.unwrap().expect("closed");
    assert!(book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4010), dec!(1000), "x", book::DealReason::Sl).await.unwrap().is_none());
    assert_eq!(deals_of(&mut *tx, &pos).await.len(), 1);
    tx.rollback().await.unwrap();

    // the whole close rolled back: no deal survives it
    let (n,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Deal" WHERE "positionId" = $1"#).bind(&pos).fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn a_close_refused_for_ownership_writes_no_deal() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let pos = open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await;
    // the broker is WEB-owned (the default): the engine acting as RUST is refused and the caller rolls back
    let r = book::close_position_as(&mut tx, Some(order_management::authority::RiskOwner::Rust), &pos, dec!(1), dec!(3990), dec!(-1000), "Stop-out (automatic): x", book::DealReason::StopOut)
        .await.unwrap();
    assert!(matches!(r, book::CloseResult::NotOwner(_)));
    tx.rollback().await.unwrap();
    let (n,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Deal" WHERE "positionId" = $1"#).bind(&pos).fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn a_close_by_writes_two_out_by_deals_naming_each_other() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut *tx, dec!(100000), true).await;
    let (a, b) = (open_position(&mut *tx, &fx, "BUY", dec!(1), dec!(4000)).await, open_position(&mut *tx, &fx, "SELL", dec!(1), dec!(4000)).await);
    for (me, other, pnl) in [(&a, &b, dec!(-50)), (&b, &a, dec!(50))] {
        book::close_position_full(&mut tx, None, me, dec!(1), dec!(3995), pnl, &format!("Close by {other}"), book::DealReason::CloseBy, Some(other.as_str())).await.unwrap();
    }
    let (da, db) = (deals_of(&mut *tx, &a).await, deals_of(&mut *tx, &b).await);
    assert_eq!((da[0].0.as_str(), da[0].1.as_str(), da[0].8.clone()), ("OUT_BY", "CLOSE_BY", Some(b.clone())));
    assert_eq!((db[0].0.as_str(), db[0].1.as_str(), db[0].8.clone()), ("OUT_BY", "CLOSE_BY", Some(a.clone())));
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn concurrent_engine_closes_of_one_position_write_one_deal() {
    let Some(pool) = pool().await else { return };
    let mut conn = pool.acquire().await.unwrap();
    let fx = fixture(&mut *conn, dec!(100000), true).await;
    let pos = open_position(&mut *conn, &fx, "BUY", dec!(1), dec!(4000)).await;
    drop(conn);
    let mut handles = Vec::new();
    for _ in 0..4 {
        let (pool, pos) = (pool.clone(), pos.clone());
        handles.push(tokio::spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            let out = book::close_position_in_tx(&mut tx, &pos, dec!(1), dec!(4010), dec!(1000), "x", book::DealReason::Sl).await.unwrap();
            tx.commit().await.unwrap();
            out.is_some()
        }));
    }
    let mut closed = 0;
    for h in handles {
        if h.await.unwrap() {
            closed += 1;
        }
    }
    let (deals,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Deal" WHERE "positionId" = $1"#).bind(&pos).fetch_one(&pool).await.unwrap();
    let (pnl_rows,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Transaction" WHERE "referenceId" = $1 AND type = 'TRADE_PNL'"#).bind(&pos).fetch_one(&pool).await.unwrap();
    cleanup(&pool, &fx.broker).await;
    assert_eq!((closed, deals, pnl_rows), (1, 1, 1));
}
