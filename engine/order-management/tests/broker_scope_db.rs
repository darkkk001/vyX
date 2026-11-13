//! BYTE-SAME PROOF, parts 2 AND 3: the broker assignment changes nothing on the current full broker
//! set, and it is not doing nothing.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres:PW@127.0.0.1:5432/vyx_closeproof VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test broker_scope_db
//!
//! Part 1 (the statements are byte-identical with no assignment) is asserted without a database, in
//! `authority::broker_scope_proof` and by the source-level comparison against d960cdee.
//!
//! WHAT THIS ADDS. A statement can be byte-identical and still be read differently, so each scoped
//! reader is run three ways against real rows:
//!
//!   1. NO ASSIGNMENT          -- the baseline, which is what production runs today;
//!   2. ASSIGNED TO EVERY BROKER PRESENT -- must equal the baseline exactly. This is the proof the
//!      owner asked for: on the current full broker set the output is identical;
//!   3. ASSIGNED TO ONE BROKER -- must EXCLUDE the other broker's rows.
//!
//! (3) IS NOT DECORATION. Without it (2) proves nothing: a filter that silently matched everything, or
//! that was never applied at all, would pass (2) and fail (3). (3) is what shows the scope is real, and
//! together they show it is both real and inert at full scope.
//!
//! The fixtures are this test's own two brokers, deleted afterwards; scratch database only.

use order_management::{authority, book, db, outbox};
use protocol::broker_scope;
use sqlx::PgPool;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("broker_scope_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

struct Fixture {
    broker_a: String,
    broker_b: String,
    group_a: String,
    group_b: String,
    account_a: String,
    account_b: String,
    symbol: String,
}

/// Two RUST-owned brokers, each with a group, an account and one OPEN position, plus a fresh risk
/// heartbeat (the risk-pass statement requires one, or it would return nothing and prove nothing).
async fn setup(pool: &PgPool) -> Fixture {
    let tag = Uuid::new_v4().to_string();
    let f = Fixture {
        broker_a: format!("bsA-{tag}"),
        broker_b: format!("bsB-{tag}"),
        group_a: format!("bsGA-{tag}"),
        group_b: format!("bsGB-{tag}"),
        account_a: format!("bsAA-{tag}"),
        account_b: format!("bsAB-{tag}"),
        symbol: format!("bsS-{tag}"),
    };
    for (b, g, a) in [(&f.broker_a, &f.group_a, &f.account_a), (&f.broker_b, &f.group_b, &f.account_b)] {
        sqlx::query(
            r#"INSERT INTO "Broker" (id, name, subdomain, tier, status, "riskAuthority", "riskAuthorityDemoOnly", "isDemoSandbox", "createdAt", "updatedAt")
               VALUES ($1, $1, $1, 'STANDARD', 'ACTIVE', 'RUST', false, false, now(), now())"#,
        )
        .bind(b)
        .execute(pool)
        .await
        .expect("insert broker");
        sqlx::query(
            r#"INSERT INTO "Group" (id, "brokerId", name, "groupType", "marginCallLevel", "stopOutLevel", "createdAt", "updatedAt")
               VALUES ($1, $2, $1, 'DEMO', 100, 50, now(), now())"#,
        )
        .bind(g)
        .bind(b)
        .execute(pool)
        .await
        .expect("insert group");
        sqlx::query(
            r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", "accountMode", status, balance, credit, leverage, currency,
                                      email, "passwordHash", "fullName", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $1, 'DEMO', 'ACTIVE', 10000, 0, 100, 'USD', $1 || '@scratch.invalid', 'x', 'broker scope proof', now(), now())"#,
        )
        .bind(a)
        .bind(b)
        .bind(g)
        .execute(pool)
        .await
        .expect("insert account");
    }
    sqlx::query(
        r#"INSERT INTO "Symbol" (id, name, category, digits, "contractSize", "quoteCurrency", "baseCurrency", "createdAt", "updatedAt")
           VALUES ($1, $1, 'FOREX', 5, 100000, 'USD', 'EUR', now(), now())"#,
    )
    .bind(&f.symbol)
    .execute(pool)
    .await
    .expect("insert symbol");
    // An origin order first: Position.originOrderId is a real FK, and the ticket comes from the
    // `Position_ticket_from_origin_order` trigger, so ticket is deliberately NOT supplied.
    for (b, a) in [(&f.broker_a, &f.account_a), (&f.broker_b, &f.account_b)] {
        sqlx::query(
            r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 0.10, 'FILLED', $1, now(), now())"#,
        )
        .bind(format!("ord-{a}"))
        .bind(b)
        .bind(a)
        .bind(&f.symbol)
        .execute(pool)
        .await
        .expect("insert origin order");
        sqlx::query(
            r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", status, "openedAt")
               VALUES ($1, $2, $3, $4, $5, 'BUY', 0.10, 1.10000, 'OPEN', now())"#,
        )
        .bind(format!("pos-{a}"))
        .bind(b)
        .bind(a)
        .bind(&f.symbol)
        .bind(format!("ord-{a}"))
        .execute(pool)
        .await
        .expect("insert position");
    }
    // the risk pass requires a fresh heartbeat or it returns nothing
    sqlx::query(
        r#"INSERT INTO "RiskEngineHeartbeat" (name, "beatAt", "staleAfterSecs") VALUES ('risk', clock_timestamp(), 60)
           ON CONFLICT (name) DO UPDATE SET "beatAt" = clock_timestamp(), "staleAfterSecs" = 60"#,
    )
    .execute(pool)
    .await
    .expect("heartbeat");
    f
}

async fn teardown(pool: &PgPool, f: &Fixture) {
    for a in [&f.account_a, &f.account_b] {
        let _ = sqlx::query(r#"DELETE FROM "Position" WHERE "accountId" = $1"#).bind(a).execute(pool).await;
        let _ = sqlx::query(r#"DELETE FROM "Order" WHERE "accountId" = $1"#).bind(a).execute(pool).await;
    }
    for a in [&f.account_a, &f.account_b] {
        let _ = sqlx::query(r#"DELETE FROM "Account" WHERE id = $1"#).bind(a).execute(pool).await;
    }
    for g in [&f.group_a, &f.group_b] {
        let _ = sqlx::query(r#"DELETE FROM "Group" WHERE id = $1"#).bind(g).execute(pool).await;
    }
    let _ = sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&f.symbol).execute(pool).await;
    for b in [&f.broker_a, &f.broker_b] {
        let _ = sqlx::query(r#"DELETE FROM "Broker" WHERE id = $1"#).bind(b).execute(pool).await;
    }
}

/// Everything the engine reads through a scoped statement, in one snapshot, so the three runs can be
/// compared as whole values rather than field by field.
#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    risk_pass_accounts: Vec<String>,
    authority_brokers: Vec<String>,
    book_accounts: Vec<String>,
    group_threshold_ids: Vec<String>,
    account_group_ids: Vec<String>,
    outbox_due: Vec<String>,
}

async fn read_all(pool: &PgPool) -> Snapshot {
    let cache = authority::AuthorityCache::new();
    cache.reload(pool).await.expect("authority reload");
    let mut authority_brokers = cache.broker_ids();
    authority_brokers.sort();
    let mut group_threshold_ids: Vec<String> = db::load_group_thresholds(pool).await.expect("thresholds").into_keys().collect();
    group_threshold_ids.sort();
    let mut account_group_ids = db::get_distinct_account_group_ids(pool).await.expect("group ids");
    account_group_ids.sort();
    Snapshot {
        risk_pass_accounts: authority::rust_owned_account_ids_with_open_positions(pool).await.expect("risk pass"),
        authority_brokers,
        book_accounts: book::account_ids_with_open_positions(pool).await.expect("book accounts"),
        group_threshold_ids,
        account_group_ids,
        outbox_due: outbox::due_ids(pool, 50).await.expect("outbox"),
    }
}

/// ONE test function on purpose: the assignment is process-global, so two of these running in parallel
/// would read each other's scope. Everything is asserted in sequence here instead.
#[tokio::test]
async fn the_assignment_is_inert_at_full_scope_and_real_at_narrow_scope() {
    let Some(pool) = pool().await else { return };
    let f = setup(&pool).await;
    broker_scope::clear();

    // ---- 1. the baseline: no assignment, which is what production runs today
    let baseline = read_all(&pool).await;
    assert!(
        baseline.risk_pass_accounts.contains(&f.account_a) && baseline.risk_pass_accounts.contains(&f.account_b),
        "the fixtures must be visible to the unscoped risk pass or the comparison below is vacuous"
    );

    // ---- 2. assigned to EVERY broker present: must be identical
    let all: Vec<String> = sqlx::query_scalar(r#"SELECT id FROM "Broker" ORDER BY id"#).fetch_all(&pool).await.expect("brokers");
    assert!(all.len() >= 2, "need at least two brokers for this proof, found {}", all.len());
    broker_scope::assign_to(all.clone());
    let full = read_all(&pool).await;
    assert_eq!(baseline, full, "assigning every broker must read exactly what no assignment reads");

    // ---- 3. assigned to ONE broker: must exclude the other's rows
    broker_scope::assign_to(vec![f.broker_a.clone()]);
    let narrow = read_all(&pool).await;
    assert!(narrow.risk_pass_accounts.contains(&f.account_a), "broker A's account must still be in the risk pass");
    assert!(!narrow.risk_pass_accounts.contains(&f.account_b), "broker B's account must be gone -- otherwise the filter is not applied");
    assert!(narrow.book_accounts.contains(&f.account_a) && !narrow.book_accounts.contains(&f.account_b));
    assert!(narrow.authority_brokers.contains(&f.broker_a) && !narrow.authority_brokers.contains(&f.broker_b));
    assert!(narrow.group_threshold_ids.contains(&f.group_a) && !narrow.group_threshold_ids.contains(&f.group_b));
    assert!(narrow.account_group_ids.contains(&f.group_a) && !narrow.account_group_ids.contains(&f.group_b));
    assert_ne!(baseline, narrow, "a narrow scope must read less than no scope at all");

    // ---- 4. assigned to a broker that does not exist: nothing of ours comes back
    broker_scope::assign_to(vec![format!("no-such-broker-{}", Uuid::new_v4())]);
    let empty = read_all(&pool).await;
    assert!(empty.risk_pass_accounts.is_empty(), "an unknown broker must match nothing, got {:?}", empty.risk_pass_accounts);
    assert!(empty.authority_brokers.is_empty());
    assert!(empty.book_accounts.is_empty());

    broker_scope::clear();
    teardown(&pool, &f).await;
}
