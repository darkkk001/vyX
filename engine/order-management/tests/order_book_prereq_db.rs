//! L2 cutover STAGE 2 — the prerequisites for writing Prisma's book from the engine's order path.
//!
//! Three things, all of them about the database rather than about any decision the engine makes:
//!
//!   1. the order path can resolve a symbol NAME to the `"Symbol"` id Prisma's book requires;
//!   2. `authority::verify_order_path_pool` refuses a role that holds only part of what the path needs,
//!      and refuses a `"Position"` whose BEFORE INSERT triggers are missing;
//!   3. those two triggers really do fill `ticket` and `groupCategoryAtOpen` for an insert shaped the way
//!      Stage 4's will be — and really do STOP filling `groupCategoryAtOpen` if the insert names it.
//!
//! (3) is the one that matters most. A missed `groupCategoryAtOpen` stamp does not raise anything: it
//! leaves an A-book position that QoreBridge never hedges and the hedge account refuses, which is why
//! `book::POSITION_OPEN_TRIGGERS` describes it and why the last test here demonstrates the whole chain
//! rather than asserting the column's value and stopping.
//!
//! Needs a scratch Postgres carrying the Prisma migrations — the TRIGGERS included, so `prisma migrate
//! deploy`, never `prisma db push`, which builds the schema from schema.prisma and so omits them:
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test \
//!   VYX_REQUIRE_DB_TESTS=1 cargo test -p order-management --test order_book_prereq_db
//!
//! The role tests must COMMIT (a role is not visible to another connection before it does), so each
//! collects its findings, drops everything it created, and only then asserts.

use order_management::{authority, book, db};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

fn url() -> Option<String> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("order_book_prereq_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(url)
}

async fn pool() -> Option<PgPool> {
    let url = url()?;
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

fn id() -> String {
    Uuid::new_v4().simple().to_string()
}

/// A tag safe to interpolate into DDL, where an identifier cannot be a bind parameter.
fn tag() -> String {
    let t = format!("l2s2{}", &id()[..10]);
    assert!(t.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()), "{t} is not a safe identifier");
    t
}

struct Fx {
    broker: String,
    account: String,
    symbol_id: String,
    symbol_name: String,
}

/// A broker, a group in the given routing category, one LIVE account, and the broker's own 2-digit
/// symbol. Its own symbol rather than seeded XAUUSD so the symbol-id test can assert on a row it owns.
async fn fixture(db: &mut sqlx::PgConnection, category: &str) -> Fx {
    let (broker, group, account, symbol) = (id(), id(), id(), id());
    let t = &broker[..10];
    let symbol_name = format!("ZS{}", t[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "negativeBalanceProtection", "updatedAt") VALUES ($1, $2, $3, true, now())"#)
        .bind(&broker)
        .bind(format!("L2 Stage 2 {t}"))
        .bind(format!("l2s2-{t}"))
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, category, "updatedAt") VALUES ($1, $2, $3, $4::"RoutingCategory", now())"#)
        .bind(&group)
        .bind(&broker)
        .bind(format!("L2S2-{t}"))
        .bind(category)
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'L2 Stage 2', 'LIVE', 100000, now())"#,
    )
    .bind(&account)
    .bind(&broker)
    .bind(&group)
    .bind(format!("5{}", &t[..7]))
    .bind(format!("l2s2-{t}@test.local"))
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
    Fx { broker, account, symbol_id: symbol, symbol_name }
}

/// An `"Order"` row, whose ticket the position's trigger is supposed to copy. No ticket supplied: the
/// column DEFAULTs to `nextval('order_ticket_seq')`.
async fn order_row(db: &mut sqlx::PgConnection, fx: &Fx) -> (String, i32) {
    let order = id();
    sqlx::query(
        r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
           VALUES ($1, $2, $3, $4, 'BUY'::"OrderSide", 'MARKET', 0.01, 'FILLED', $5, now())"#,
    )
    .bind(&order)
    .bind(&fx.broker)
    .bind(&fx.account)
    .bind(&fx.symbol_id)
    .bind(format!("l2s2:{order}"))
    .execute(&mut *db)
    .await
    .unwrap();
    let (ticket,): (i32,) = sqlx::query_as(r#"SELECT ticket FROM "Order" WHERE id = $1"#).bind(&order).fetch_one(&mut *db).await.unwrap();
    (order, ticket)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. the symbol id
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_order_path_resolves_the_symbol_id_prismas_book_requires() {
    let Some(pool) = pool().await else { return };
    // Committed, because get_broker_symbol_config takes a pool and so uses its own connection.
    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "B_BOOK").await;
    setup.commit().await.unwrap();

    let cfg = db::get_broker_symbol_config(&pool, &fx.broker, &fx.symbol_name)
        .await
        .unwrap()
        .expect("the broker's own symbol resolves");
    assert_eq!(cfg.symbol_id, fx.symbol_id, "the order path must carry the Symbol id, not just its name");
    assert_eq!(cfg.digits, 2, "the same row's digits, so this is one query and not two");

    // The point of carrying it: it satisfies "Position"."symbolId", a NOT NULL FK to "Symbol".
    let mut tx = pool.begin().await.unwrap();
    let (order, _) = order_row(&mut tx, &fx).await;
    let position = id();
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice")
           VALUES ($1, $2, $3, $4, $5, 'BUY'::"OrderSide", 0.01, 4300)"#,
    )
    .bind(&position)
    .bind(&fx.broker)
    .bind(&fx.account)
    .bind(&cfg.symbol_id)
    .bind(&order)
    .execute(&mut *tx)
    .await
    .expect("the resolved id is accepted as Position.symbolId");
    tx.rollback().await.unwrap();

    // A symbol no broker carries is the benign None both fill sites already handle, not an error.
    assert!(db::get_broker_symbol_config(&pool, &fx.broker, "ZZ_NO_SUCH_SYMBOL").await.unwrap().is_none());

    for sql in [
        r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Broker" WHERE id = $1"#,
    ] {
        sqlx::query(sql).bind(&fx.broker).execute(&pool).await.unwrap();
    }
    sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&fx.symbol_id).execute(&pool).await.unwrap();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. the privilege check
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// What `verify_risk_pool` demands, and only that: the set a role running production's risk mode today
/// would hold.
const RISK_GRANTS: &[(&str, &str)] = &[
    ("Position", "UPDATE"),
    ("Account", "UPDATE"),
    ("Transaction", "INSERT"),
    ("AuditLog", "INSERT"),
    ("PostCloseEffect", "INSERT"),
    ("RiskEngineHeartbeat", "INSERT"),
    ("RiskEngineHeartbeat", "UPDATE"),
];

/// Serialises the role tests against each other.
///
/// `CREATE ROLE`, `GRANT`, `DROP OWNED BY` and `DROP ROLE` all touch cluster-wide catalogs, and cargo
/// runs tests -- and whole test binaries -- in parallel, so two of these overlapping fail on catalog
/// contention rather than on anything they are testing. A session-level advisory lock on its own
/// connection makes each one exclusive, and Postgres releases it when that connection closes, so a test
/// that panics cannot wedge the rest.
async fn role_lock() -> PgPool {
    let lock = PgPoolOptions::new().max_connections(1).connect(&url().expect("a URL")).await.expect("a lock connection");
    sqlx::query("SELECT pg_advisory_lock(842100142)").execute(&lock).await.expect("the role lock");
    lock
}

/// SELECT on what the risk path reads before it writes anything. Named rather than granted across the
/// schema: `GRANT ... ON ALL TABLES` rewrites every table's ACL and invalidates every backend's
/// relation cache, which is enough to disturb a timing-sensitive suite running beside this one.
///
/// `"Broker"` carries a second, less obvious requirement: `information_schema.columns` lists a column
/// only when the role holds some privilege on its table, so without SELECT here `verify_risk_pool`
/// cannot see whether the Stage 6 migration is applied at all.
const READS: &[&str] = &["Broker", "Account", "Group", "Symbol", "Position", "RiskEngineHeartbeat"];

/// A login role holding these table privileges on top of [`READS`], and a pool connected as it.
/// What each test varies is the WRITE privileges below.
async fn role_with(pool: &PgPool, grants: &[(&str, &str)], sequences: &[&str]) -> (String, PgPool, String) {
    let role = tag();
    let password = Uuid::new_v4().simple().to_string();
    sqlx::query(&format!(r#"CREATE ROLE "{role}" LOGIN PASSWORD '{password}'"#)).execute(pool).await.unwrap();
    sqlx::query(&format!(r#"GRANT USAGE ON SCHEMA public TO "{role}""#)).execute(pool).await.unwrap();
    for table in READS {
        sqlx::query(&format!(r#"GRANT SELECT ON "{table}" TO "{role}""#)).execute(pool).await.unwrap();
    }
    for (table, privilege) in grants {
        sqlx::query(&format!(r#"GRANT {privilege} ON "{table}" TO "{role}""#)).execute(pool).await.unwrap();
    }
    for sequence in sequences {
        sqlx::query(&format!(r#"GRANT USAGE ON SEQUENCE "{sequence}" TO "{role}""#)).execute(pool).await.unwrap();
    }
    // the same database and host, a different user: postgresql://postgres@host/db -> ...//role:pw@host/db
    let base = url().expect("a URL, since we are connected");
    let (scheme, rest) = base.split_once("://").expect("a URL with a scheme");
    let hostpart = rest.split_once('@').map(|(_, h)| h).unwrap_or(rest);
    let as_role = format!("{scheme}://{role}:{password}@{hostpart}");
    let p = PgPool::connect(&as_role).await.expect("connect as the narrow role");
    (role, p, as_role)
}

async fn drop_role(pool: &PgPool, role: &str, narrow: PgPool) {
    narrow.close().await;
    // DROP OWNED BY revokes the grants above; the role creates nothing, so there is no ownership to
    // reassign first.
    for sql in [format!(r#"DROP OWNED BY "{role}""#), format!(r#"DROP ROLE IF EXISTS "{role}""#)] {
        sqlx::query(&sql).execute(pool).await.unwrap();
    }
}

/// The separation Stage 2 is built around: risk mode's requirements did NOT grow. A role holding exactly
/// what risk needs still starts risk mode — which matters because risk mode is live on production right
/// now, and a role that fails this check leaves a RUST-owned broker with no owner at all — while the
/// order path refuses it, completely and in one message.
#[tokio::test]
async fn a_role_with_only_risks_privileges_still_runs_risk_and_is_refused_the_order_path() {
    let Some(pool) = pool().await else { return };
    let lock = role_lock().await;
    let (role, narrow, _) = role_with(&pool, RISK_GRANTS, &[]).await;

    let risk = authority::verify_risk_pool(&narrow).await;
    let orders = authority::verify_order_path_pool(&narrow).await;

    drop_role(&pool, &role, narrow).await;
    lock.close().await;

    assert!(risk.is_ok(), "risk mode must still accept a role that holds exactly what RISK writes: {risk:?}");
    let why = orders.expect_err("the order path must refuse a role with none of its privileges");
    // all of it, in one message: a partial grant fixed one error at a time is the slow failure this
    // check exists to prevent
    for needed in ["INSERT on \"Order\"", "UPDATE on \"Order\"", "INSERT on \"Position\"", "INSERT on \"Deal\""] {
        assert!(why.contains(needed), "the refusal must name {needed}: {why}");
    }
    for sequence in ["order_ticket_seq", "deal_ticket_seq"] {
        assert!(why.contains(sequence), "the refusal must name USAGE on {sequence}: {why}");
    }
    assert!(why.contains(&role), "the refusal must name the role that cannot write: {why}");
}

/// Half a grant is the dangerous state, because it looks like progress. It must fail exactly as loudly
/// as none of it, and name only what is actually still missing.
#[tokio::test]
async fn a_half_granted_role_is_refused_and_told_precisely_what_is_missing() {
    let Some(pool) = pool().await else { return };
    let mut half: Vec<(&str, &str)> = RISK_GRANTS.to_vec();
    half.extend_from_slice(&[("Order", "INSERT"), ("Position", "INSERT")]);
    let lock = role_lock().await;
    let (role, narrow, _) = role_with(&pool, &half, &["order_ticket_seq"]).await;

    let orders = authority::verify_order_path_pool(&narrow).await;

    drop_role(&pool, &role, narrow).await;
    lock.close().await;

    let why = orders.expect_err("half a grant must still refuse");
    for missing in ["UPDATE on \"Order\"", "INSERT on \"Deal\"", "deal_ticket_seq"] {
        assert!(why.contains(missing), "the refusal must name {missing}: {why}");
    }
    for granted in ["INSERT on \"Order\"", "INSERT on \"Position\"", "USAGE on sequence order_ticket_seq"] {
        assert!(!why.contains(granted), "the refusal must not name {granted}, which was granted: {why}");
    }
}

/// And the grant Stage 7 will make is enough — including that nothing else is quietly required.
#[tokio::test]
async fn the_full_grant_passes_both_checks() {
    let Some(pool) = pool().await else { return };
    let mut full: Vec<(&str, &str)> = RISK_GRANTS.to_vec();
    full.extend(authority::ORDER_PATH_PRIVILEGES.iter().map(|p| (p.table, p.privilege)));
    let sequences: Vec<&str> = authority::ORDER_PATH_SEQUENCES.iter().map(|(n, _)| *n).collect();
    let lock = role_lock().await;
    let (role, narrow, _) = role_with(&pool, &full, &sequences).await;

    let risk = authority::verify_risk_pool(&narrow).await;
    let orders = authority::verify_order_path_pool(&narrow).await;

    drop_role(&pool, &role, narrow).await;
    lock.close().await;

    assert!(risk.is_ok(), "{risk:?}");
    assert!(orders.is_ok(), "the full grant must pass: {orders:?}");
}

/// A `"Position"` built without its triggers — which is exactly what `prisma db push` produces, because
/// schema.prisma does not describe triggers — must be refused even though every privilege is in place.
/// Modelled with a schema ahead of `public` on the role's search_path, so the real table keeps its
/// triggers and the other tests keep running next to this one.
#[tokio::test]
async fn a_position_table_without_its_triggers_is_refused_even_when_every_privilege_is_granted() {
    let Some(pool) = pool().await else { return };
    let lock = role_lock().await;
    let schema = tag();
    sqlx::query(&format!(r#"CREATE SCHEMA "{schema}""#)).execute(&pool).await.unwrap();
    // Only the relations the check asks about, with no triggers on "Position" — the shape, not the data.
    for sql in [
        format!(r#"CREATE TABLE "{schema}"."Order" (id text PRIMARY KEY)"#),
        format!(r#"CREATE TABLE "{schema}"."Position" (id text PRIMARY KEY)"#),
        format!(r#"CREATE TABLE "{schema}"."Deal" (id text PRIMARY KEY)"#),
        format!(r#"CREATE SEQUENCE "{schema}"."order_ticket_seq""#),
        format!(r#"CREATE SEQUENCE "{schema}"."deal_ticket_seq""#),
    ] {
        sqlx::query(&sql).execute(&pool).await.unwrap();
    }
    let mut full: Vec<(&str, &str)> = RISK_GRANTS.to_vec();
    full.extend(authority::ORDER_PATH_PRIVILEGES.iter().map(|p| (p.table, p.privilege)));
    let sequences: Vec<&str> = authority::ORDER_PATH_SEQUENCES.iter().map(|(n, _)| *n).collect();
    let (role, narrow, as_role) = role_with(&pool, &full, &sequences).await;
    for sql in [
        format!(r#"GRANT USAGE ON SCHEMA "{schema}" TO "{role}""#),
        format!(r#"GRANT INSERT, UPDATE, SELECT ON ALL TABLES IN SCHEMA "{schema}" TO "{role}""#),
        format!(r#"GRANT USAGE ON ALL SEQUENCES IN SCHEMA "{schema}" TO "{role}""#),
        format!(r#"ALTER ROLE "{role}" SET search_path = "{schema}", public"#),
    ] {
        sqlx::query(&sql).execute(&pool).await.unwrap();
    }
    // ALTER ROLE ... SET search_path applies at connection time, so this needs a pool opened after it.
    let fresh = PgPool::connect(&as_role).await.expect("reconnect as the narrow role");
    let on_schema: (String,) = sqlx::query_as("SELECT current_schema()::text").fetch_one(&fresh).await.unwrap();
    let orders = authority::verify_order_path_pool(&fresh).await;
    fresh.close().await;

    drop_role(&pool, &role, narrow).await;
    sqlx::query(&format!(r#"DROP SCHEMA "{schema}" CASCADE"#)).execute(&pool).await.unwrap();
    lock.close().await;

    assert_eq!(on_schema.0, schema, "the trigger-less schema must be the one this connection resolves to");
    let why = orders.expect_err("a trigger-less \"Position\" must be refused");
    for trigger in book::POSITION_OPEN_TRIGGERS {
        assert!(why.contains(trigger.trigger), "the refusal must name the missing trigger {}: {why}", trigger.trigger);
    }
    assert!(why.contains("prisma db push"), "the refusal should say how a table ends up without them: {why}");
    assert!(why.contains("UNHEDGED"), "the refusal must say what the missing stamp costs: {why}");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. the triggers
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// Both triggers, on an insert shaped the way Stage 4's will be: it names neither of their columns.
#[tokio::test]
async fn both_position_triggers_fill_their_columns_for_an_insert_that_leaves_them_alone() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "A_BOOK").await;
    let (order, order_ticket) = order_row(&mut tx, &fx).await;
    let position = id();

    // Exactly book.rs's STAGE_4_COLUMNS minus the optionals: no ticket, no groupCategoryAtOpen.
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", "bookType")
           VALUES ($1, $2, $3, $4, $5, 'BUY'::"OrderSide", 0.01, 4300, 'A_BOOK'::"BookType")"#,
    )
    .bind(&position)
    .bind(&fx.broker)
    .bind(&fx.account)
    .bind(&fx.symbol_id)
    .bind(&order)
    .execute(&mut *tx)
    .await
    .expect("an insert that supplies neither trigger column");

    let (ticket, category): (i32, Option<String>) =
        sqlx::query_as(r#"SELECT ticket, "groupCategoryAtOpen"::text FROM "Position" WHERE id = $1"#)
            .bind(&position)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(ticket, order_ticket, "Position_ticket_from_origin_order must copy the opening order's ticket");
    assert_eq!(category.as_deref(), Some("A_BOOK"), "position_stamp_group_category_at_open must stamp the account's group category");

    // The stamp is what lib/hedge.ts keys QoreBridge on, so the position is visible to the A-book
    // exposure query app/api/manage/hedges/route.ts:34 runs.
    let (hedgeable,): (i64,) = sqlx::query_as(
        r#"SELECT count(*) FROM "Position" WHERE "brokerId" = $1 AND status = 'OPEN' AND "groupCategoryAtOpen" = 'A_BOOK'"#,
    )
    .bind(&fx.broker)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(hedgeable, 1, "an A-book position must be visible to the hedge path");
    tx.rollback().await.unwrap();
}

/// The ticket trigger is unconditional, which `book::POSITION_OPEN_TRIGGERS` claims and this proves: a
/// supplied ticket is overwritten rather than honoured. (The existing `book_db.rs` fixtures supply one,
/// and have always been getting the order's.)
#[tokio::test]
async fn a_supplied_ticket_is_overwritten_by_the_opening_orders() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "B_BOOK").await;
    let (order, order_ticket) = order_row(&mut tx, &fx).await;
    let position = id();
    let nonsense: i32 = 1_234_567;
    assert_ne!(nonsense, order_ticket);
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket)
           VALUES ($1, $2, $3, $4, $5, 'BUY'::"OrderSide", 0.01, 4300, $6)"#,
    )
    .bind(&position)
    .bind(&fx.broker)
    .bind(&fx.account)
    .bind(&fx.symbol_id)
    .bind(&order)
    .bind(nonsense)
    .execute(&mut *tx)
    .await
    .unwrap();
    let (ticket,): (i32,) = sqlx::query_as(r#"SELECT ticket FROM "Position" WHERE id = $1"#).bind(&position).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(ticket, order_ticket, "the trigger owns the ticket, so a supplied one is ignored");
    assert!(book::triggers_bypassed_by(&["ticket"]).is_empty(), "and that is not a bypass: no data is wrong");
    tx.rollback().await.unwrap();
}

/// §7's TOP RISK, demonstrated end to end rather than asserted as a column value.
///
/// The stamp trigger fires only `IF NEW."groupCategoryAtOpen" IS NULL`. An insert that names the column
/// — with any value, including the `B_BOOK` default a careless port would reach for — turns it off for
/// that row. Postgres reports nothing. What follows is the damage, in the order the real code sees it.
#[tokio::test]
async fn supplying_group_category_at_open_silently_unhedges_an_a_book_position() {
    let Some(pool) = pool().await else { return };
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, "A_BOOK").await;
    let (order, _) = order_row(&mut tx, &fx).await;
    let position = id();

    // The mistake: the engine fills the column in itself. Nothing here errors.
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", "bookType", "groupCategoryAtOpen")
           VALUES ($1, $2, $3, $4, $5, 'BUY'::"OrderSide", 0.01, 4300, 'A_BOOK'::"BookType", 'B_BOOK'::"RoutingCategory")"#,
    )
    .bind(&position)
    .bind(&fx.broker)
    .bind(&fx.account)
    .bind(&fx.symbol_id)
    .bind(&order)
    .execute(&mut *tx)
    .await
    .expect("supplying the column is accepted: THAT is the problem");

    // 1. the stamp disagrees with the account's own group, and the trigger did not correct it
    let (stamped, group_category): (Option<String>, String) = sqlx::query_as(
        r#"SELECT p."groupCategoryAtOpen"::text, g.category::text FROM "Position" p
             JOIN "Account" a ON a.id = p."accountId" JOIN "Group" g ON g.id = a."groupId" WHERE p.id = $1"#,
    )
    .bind(&position)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(group_category, "A_BOOK", "the account really is in an A-book group");
    assert_eq!(stamped.as_deref(), Some("B_BOOK"), "the supplied value stood: the trigger was bypassed, silently");

    // 2. so the A-book exposure query (app/api/manage/hedges/route.ts:34) cannot see it, and
    //    lib/hedge.ts, which keys an intent on groupCategoryAtOpen = A_BOOK, writes none
    let (hedgeable,): (i64,) = sqlx::query_as(
        r#"SELECT count(*) FROM "Position" WHERE "brokerId" = $1 AND status = 'OPEN' AND "groupCategoryAtOpen" = 'A_BOOK'"#,
    )
    .bind(&fx.broker)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(hedgeable, 0, "the A-book position is invisible to the hedge path: no HedgeIntent will ever be written for it");

    // 3. and the other route refuses it too. lib/hedge-route.ts hedgeRouteOf: not A_BOOK, not COVERAGE,
    //    bookType != B_BOOK -> NONE. Neither QoreBridge nor the hedge account takes it. Unhedged, silent.
    let (book_type,): (String,) = sqlx::query_as(r#"SELECT "bookType"::text FROM "Position" WHERE id = $1"#)
        .bind(&position)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(book_type, "A_BOOK");
    assert_eq!(hedge_route_of(stamped.as_deref(), &book_type), "NONE", "both hedge routes refuse it");

    // 4. and a NULL stamp — the same trigger bypassed by a column list that supplies NULL explicitly —
    //    lands in exactly the same place
    assert_eq!(hedge_route_of(None, "A_BOOK"), "NONE");

    // 5. which is why the guard reports this column list rather than leaving it to review
    let columns = ["id", "brokerId", "accountId", "symbolId", "originOrderId", "side", "volume", "openPrice", "bookType", "groupCategoryAtOpen"];
    let caught = book::triggers_bypassed_by(&columns);
    assert_eq!(caught.len(), 1);
    assert_eq!(caught[0].trigger, "position_stamp_group_category_at_open");

    tx.rollback().await.unwrap();
}

/// lib/hedge-route.ts `hedgeRouteOf`, for a position that is not on the broker's hedge account. Kept
/// here beside the row it judges so the test above shows the consequence rather than asserting a column.
fn hedge_route_of(group_category_at_open: Option<&str>, book_type: &str) -> &'static str {
    match group_category_at_open {
        Some("A_BOOK") => "LIQUIDITY_PROVIDER",
        Some("COVERAGE") => "NONE",
        _ if book_type != "B_BOOK" => "NONE",
        _ => "HEDGE_ACCOUNT",
    }
}

/// The database still has exactly the triggers `book::POSITION_OPEN_TRIGGERS` describes, and both are
/// enabled for ordinary writes. This is the link between that constant and the schema: without it the
/// constant could describe triggers that no longer exist and every test above would still pass.
#[tokio::test]
async fn the_database_has_exactly_the_two_triggers_the_book_module_describes() {
    let Some(pool) = pool().await else { return };
    let rows: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT tgname, tgenabled::text FROM pg_trigger
            WHERE tgrelid = '"Position"'::regclass AND NOT tgisinternal ORDER BY tgname"#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let names: Vec<&str> = rows.iter().map(|(n, _)| n.as_str()).collect();
    let mut expected: Vec<&str> = book::POSITION_OPEN_TRIGGERS.iter().map(|t| t.trigger).collect();
    expected.sort_unstable();
    assert_eq!(names, expected, "\"Position\"'s triggers and POSITION_OPEN_TRIGGERS disagree");
    for (name, enabled) in &rows {
        assert!(matches!(enabled.as_str(), "O" | "A"), "{name} is not enabled for ordinary writes (tgenabled = {enabled})");
    }
    // and the one claimed to be conditional is the one whose body tests for NULL
    let (body,): (String,) = sqlx::query_as(
        r#"SELECT prosrc FROM pg_proc WHERE proname = 'position_stamp_group_category_at_open'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        body.contains("IS NULL"),
        "position_stamp_group_category_at_open is documented as only_when_null; its body no longer tests for NULL"
    );
    let (ticket_body,): (String,) = sqlx::query_as(r#"SELECT prosrc FROM pg_proc WHERE proname = 'position_ticket_from_origin_order'"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        !ticket_body.contains(r#"NEW."ticket" IS NULL THEN
    SELECT"#),
        "position_ticket_from_origin_order is documented as unconditional"
    );
}
