//! A sandbox broker (Broker."isDemoSandbox", the QoreTrader demo, migration 20261013100000) is never part of the engine's book:
//! its accounts are not in the list of accounts holding positions, and its positions are not in the margin watch's book.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/<db with the migration> \
//!   VYX_REQUIRE_DB_TESTS=1 cargo test -p order-management --test demo_sandbox_db
//! Skips without the URL (unless VYX_REQUIRE_DB_TESTS=1). Local databases only. The rows are committed (the list function reads
//! through the pool) and removed again at the end, by id.

use order_management::book;
use order_management::margin_watch::load_book;
use sqlx::PgPool;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("demo_sandbox_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

fn id() -> String {
    Uuid::new_v4().simple().to_string()
}

/// A broker (sandbox or not) with one funded account holding one open XAUUSD position. Returns (broker, account).
async fn tenant(db: &PgPool, sandbox: bool) -> (String, String) {
    let (broker, account, group, order, position) = (id(), id(), id(), id(), id());
    let tag = broker[..10].to_string();
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "isDemoSandbox", "updatedAt") VALUES ($1, $2, $3, $4, now())"#)
        .bind(&broker).bind(format!("Sandbox Test {tag}")).bind(format!("sbx-{tag}")).bind(sandbox).execute(db).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "updatedAt") VALUES ($1, $2, $3, now())"#)
        .bind(&group).bind(&broker).bind(format!("SBX-{tag}")).execute(db).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'Sandbox Test', 'LIVE', 1000, 100, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("5{}", &tag[..7])).bind(format!("sbx-{tag}@test.local")).execute(db).await.unwrap();
    let (symbol,): (String,) = sqlx::query_as(r#"SELECT id FROM "Symbol" WHERE name = 'XAUUSD'"#).fetch_one(db).await.expect("XAUUSD seeded");
    sqlx::query(
        r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
           VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 0.01, 'FILLED', $5, now())"#,
    )
    .bind(&order).bind(&broker).bind(&account).bind(&symbol).bind(format!("sbx:{order}")).execute(db).await.unwrap();
    let ticket: i32 = (u32::from_str_radix(&position[..7], 16).unwrap() % 2_000_000_000) as i32;
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket)
           VALUES ($1, $2, $3, $4, $5, 'BUY', 0.01, 4290, $6)"#,
    )
    .bind(&position).bind(&broker).bind(&account).bind(&symbol).bind(&order).bind(ticket).execute(db).await.unwrap();
    (broker, account)
}

async fn remove(db: &PgPool, broker: &str) {
    for q in [
        r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Broker" WHERE id = $1"#,
    ] {
        sqlx::query(q).bind(broker).execute(db).await.unwrap();
    }
}

#[tokio::test]
async fn a_sandbox_broker_is_not_in_the_book() {
    let Some(db) = pool().await else { return };
    let (normal_broker, normal_account) = tenant(&db, false).await;
    let (sandbox_broker, sandbox_account) = tenant(&db, true).await;

    // the list of accounts the monitor passes walk
    let ids = book::account_ids_with_open_positions(&db).await.unwrap();
    assert!(ids.contains(&normal_account), "an ordinary account holding a position is listed");
    assert!(!ids.contains(&sandbox_account), "a sandbox account never is");

    // the margin watch's book
    let watch = load_book(&db).await.unwrap();
    let in_book = |a: &str| watch.accounts.iter().any(|x| x.id == a);
    assert!(in_book(&normal_account));
    assert!(!in_book(&sandbox_account));

    remove(&db, &normal_broker).await;
    remove(&db, &sandbox_broker).await;
}
