//! DB-backed test for the pass resume point and its loop guard (monitor::run_pass / PassCursor, Stage 4 (R)).
//! Same scratch-DB rules as book_db.rs:
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test pass_db
//!
//! Account ids start with "!" so they sort before anything else in the database: the pass meets them first.

use order_management::{book, monitor};
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::sync::atomic::Ordering;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("pass_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

/// A stuck follow-up (the web never finishes it) owes a position to account A. The pass must stop at A once per walk
/// through the list, never block the accounts after A twice in a row, and A itself is evaluated after the window
/// (the safety release). Also: the pass stops at A only for a FRESH row, and resumes AT A.
#[tokio::test]
async fn a_stuck_follow_up_never_blocks_the_rest_of_the_pass_twice_and_falls_back_to_the_safety_release() {
    let Some(pool) = pool().await else { return };
    let tag = &Uuid::new_v4().simple().to_string()[..10];
    let (broker, group, admin, rule) = (format!("pass-{tag}"), format!("pass-g-{tag}"), format!("pass-adm-{tag}"), format!("pass-r-{tag}"));
    let (a, b) = (format!("!pass-{tag}-a"), format!("!pass-{tag}-b"));
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(&pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "updatedAt") VALUES ($1, $2, $1, now())"#).bind(&group).bind(&broker).execute(&pool).await.unwrap();
    for (i, acc) in [&a, &b].into_iter().enumerate() {
        sqlx::query(r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, "updatedAt")
             VALUES ($1, $2, $3, $4, $5, 'x', 'Pass Test', 'LIVE', 1000, now())"#)
            .bind(acc).bind(&broker).bind(&group).bind(format!("4{}{i}", &tag[..6])).bind(format!("{i}-{tag}@test.local"))
            .execute(&pool).await.unwrap();
    }
    let (symbol,): (String,) = sqlx::query_as(r#"SELECT id FROM "Symbol" WHERE name = 'XAUUSD'"#).fetch_one(&pool).await.unwrap();
    let position = |account: &str, key: &str, status: &'static str| {
        let (pool, account, key, symbol, broker) = (pool.clone(), account.to_string(), format!("{key}-{tag}"), symbol.clone(), broker.clone());
        async move {
            sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
                 VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 1, 'FILLED', $1, now())"#)
                .bind(format!("o-{key}")).bind(&broker).bind(&account).bind(&symbol).execute(&pool).await.unwrap();
            let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
            sqlx::query(r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket, status)
                 VALUES ($1, $2, $3, $4, $5, 'BUY', 1, 4000, $6, $7::"PositionStatus")"#)
                .bind(&key).bind(&broker).bind(&account).bind(&symbol).bind(format!("o-{key}")).bind(ticket).bind(status)
                .execute(&pool).await.unwrap();
            key
        }
    };
    let source = position(&b, "src", "CLOSED").await; // a closed source (on B, it does not matter whose)
    let target = position(&a, "tgt", "OPEN").await; // its mirror target, on A
    let _b_open = position(&b, "bopen", "OPEN").await; // B holds an open position, so the pass lists it
    sqlx::query(r#"INSERT INTO "AdminUser" (id, "brokerId", email, "passwordHash", role, "updatedAt") VALUES ($1, $2, $3, 'x', 'BROKER_ADMIN', now())"#)
        .bind(&admin).bind(&broker).bind(format!("{admin}@test.local")).execute(&pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "MirrorRule" (id, "brokerId", "sourceType", "sourceId", "targetAccountId", "createdById", "updatedAt")
         VALUES ($1, $2, 'GROUP', $3, $4, $5, now())"#)
        .bind(&rule).bind(&broker).bind(&group).bind(&a).bind(&admin).execute(&pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "MirrorLink" (id, "ruleId", "sourcePositionId", "targetPositionId", "updatedAt") VALUES ($1, $2, $3, $4, now())"#)
        .bind(format!("ml-{tag}")).bind(&rule).bind(&source).bind(&target).execute(&pool).await.unwrap();
    let row = format!("pce-{tag}");
    sqlx::query(r#"INSERT INTO "PostCloseEffect" (id, kind, "dedupeKey", "brokerId", "accountId", "positionId", reason, payload)
         VALUES ($1, 'POSITION_CLOSED', $1, $2, $3, $4, 'stop_out', '{}'::jsonb)"#)
        .bind(&row).bind(&broker).bind(&b).bind(&source).execute(&pool).await.unwrap();

    let mut cursor = monitor::PassCursor::default();
    // 1: stops AT A (first in the list); B is not reached
    let p1 = monitor::run_pass(&pool, None, &mut cursor).await;
    // 2: resumes at A; the follow-up is still stuck, and the guard does not stop twice at A in one walk: B is evaluated
    let p2 = monitor::run_pass(&pool, None, &mut cursor).await;
    // 3: a new walk from the top: stops at A again (bounded: every other pass reaches B)
    let p3 = monitor::run_pass(&pool, None, &mut cursor).await;
    // 4: the row is now older than the window: A is evaluated anyway, counted as a safety release
    sqlx::query(r#"UPDATE "PostCloseEffect" SET "createdAt" = now() - interval '31 seconds' WHERE id = $1"#).bind(&row).execute(&pool).await.unwrap();
    let releases_before = book::SAFETY_RELEASES.load(Ordering::Relaxed);
    let p4 = monitor::run_pass(&pool, None, &mut cursor).await;
    let released = book::SAFETY_RELEASES.load(Ordering::Relaxed) - releases_before;

    for sql in [
        r#"DELETE FROM "PostCloseEffect" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "MirrorLink" WHERE "ruleId" IN (SELECT id FROM "MirrorRule" WHERE "brokerId" = $1)"#,
        r#"DELETE FROM "MirrorRule" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "AdminUser" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "AuditLog" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Transaction" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Broker" WHERE id = $1"#,
    ] {
        sqlx::query(sql).bind(&broker).execute(&pool).await.unwrap();
    }

    assert_eq!(p1.stopped_at.as_deref(), Some(a.as_str()), "pass 1 stops at A");
    assert!(!p1.evaluated.contains(&b), "pass 1 does not reach B");
    assert_eq!(p2.stopped_at, None, "pass 2 does not stop at A a second time in the same walk");
    assert!(p2.deferred.contains(&a) && p2.evaluated.contains(&b), "pass 2 skips A and evaluates B: {p2:?}");
    assert_eq!(p3.stopped_at.as_deref(), Some(a.as_str()), "a new walk may stop at A again");
    assert!(p4.evaluated.contains(&a) && p4.evaluated.contains(&b), "past the window A is evaluated: {p4:?}");
    assert!(released >= 1, "counted as a safety release");
    let _ = dec!(0); // keep rust_decimal_macros used when assertions change
}
