//! Negative-balance protection on the last close only (owner 2026-10-23, docs/NBP-LAST-CLOSE-DESIGN.md), on the REAL
//! close path (book::close_position_in_tx) and the real Prisma schema: the 50005696 sequence of 2026-10-22 from the
//! shared fixture tests/fixtures/nbp-50005696-2026-10-22.json (lib/nbp-replay.test.ts replays the same file).
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test \
//!   VYX_REQUIRE_DB_TESTS=1 cargo test -p order-management --test nbp_replay_db
//! Without the URL the test skips (unless VYX_REQUIRE_DB_TESTS=1). Everything runs in one rolled-back transaction.

use order_management::book;
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::HashMap;
use std::str::FromStr;
use uuid::Uuid;

const FIXTURE: &str = include_str!("../../../tests/fixtures/nbp-50005696-2026-10-22.json");

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("nbp_replay_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

fn id() -> String {
    Uuid::new_v4().simple().to_string()
}

fn d(v: &serde_json::Value) -> Decimal {
    Decimal::from_str(v.as_str().expect("decimal string")).unwrap()
}

struct Fx {
    broker: String,
    account: String,
    symbol: String,
}

async fn fixture(db: &mut sqlx::PgConnection, balance: Decimal, nbp: bool) -> Fx {
    let (broker, group, account) = (id(), id(), id());
    let tag = &broker[..10];
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "negativeBalanceProtection", "updatedAt") VALUES ($1, $2, $3, $4, now())"#)
        .bind(&broker).bind(format!("NBP Replay {tag}")).bind(format!("nbpreplay-{tag}")).bind(nbp)
        .execute(&mut *db).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "updatedAt") VALUES ($1, $2, $3, now())"#)
        .bind(&group).bind(&broker).bind(format!("NBPREPLAY-{tag}"))
        .execute(&mut *db).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'NBP Replay', 'LIVE', $6, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("4{}", &tag[..7])).bind(format!("nbpreplay-{tag}@test.local")).bind(balance)
    .execute(&mut *db).await.unwrap();
    // the money rule does not depend on the symbol: every position is booked on XAUUSD
    let (symbol,): (String,) = sqlx::query_as(r#"SELECT id FROM "Symbol" WHERE name = 'XAUUSD'"#).fetch_one(&mut *db).await.expect("XAUUSD seeded");
    Fx { broker, account, symbol }
}

async fn open_position(db: &mut sqlx::PgConnection, fx: &Fx, side: &str, volume: Decimal) -> String {
    let (order, position) = (id(), id());
    sqlx::query(
        r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
           VALUES ($1, $2, $3, $4, $5::"OrderSide", 'MARKET', $6, 'FILLED', $7, now())"#,
    )
    .bind(&order).bind(&fx.broker).bind(&fx.account).bind(&fx.symbol).bind(side).bind(volume).bind(format!("nbpreplay:{order}"))
    .execute(&mut *db).await.unwrap();
    let ticket: i32 = (u32::from_str_radix(&position[..7], 16).unwrap() % 2_000_000_000) as i32;
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket)
           VALUES ($1, $2, $3, $4, $5, $6::"OrderSide", $7, 4000, $8)"#,
    )
    .bind(&position).bind(&fx.broker).bind(&fx.account).bind(&fx.symbol).bind(&order).bind(side).bind(volume).bind(ticket)
    .execute(&mut *db).await.unwrap();
    position
}

/// The open's COMMISSION ledger row, as the open path writes it (balance moves, no floor).
async fn charge_commission(db: &mut sqlx::PgConnection, fx: &Fx, position: &str, amount: Decimal) {
    let (before,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&mut *db).await.unwrap();
    sqlx::query(r#"UPDATE "Account" SET balance = balance + $1 WHERE id = $2"#).bind(amount).bind(&fx.account).execute(&mut *db).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Transaction" (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", "updatedAt")
           VALUES ($1, $2, $3, 'COMMISSION', 'COMPLETED', $4, $5, $6, 'Position', $7, now())"#,
    )
    .bind(id()).bind(&fx.broker).bind(&fx.account).bind(amount).bind(before).bind(before + amount).bind(position)
    .execute(&mut *db).await.unwrap();
}

fn reason(s: &str) -> book::DealReason {
    match s {
        "STOP_OUT" => book::DealReason::StopOut,
        "BULK" => book::DealReason::Bulk,
        other => panic!("unexpected reason {other}"),
    }
}

async fn nbp_rows(db: &mut sqlx::PgConnection, account: &str) -> Vec<(Decimal, String)> {
    sqlx::query_as(r#"SELECT amount, "referenceId" FROM "Transaction" WHERE "accountId" = $1 AND type = 'NEGATIVE_BALANCE_PROTECTION' ORDER BY "createdAt", id"#)
        .bind(account).fetch_all(&mut *db).await.unwrap()
}

#[tokio::test]
async fn the_50005696_sequence_writes_off_once_at_the_last_close() {
    let Some(pool) = pool().await else { return };
    let fx_json: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
    let e = &fx_json["expect"];
    let mut tx = pool.begin().await.unwrap();
    let fx = fixture(&mut tx, d(&fx_json["account"]["balance"]), fx_json["account"]["negativeBalanceProtection"].as_bool().unwrap()).await;

    let mut by_ticket: HashMap<u64, (String, Decimal)> = HashMap::new();
    for p in fx_json["openAtStart"].as_array().unwrap() {
        let pos = open_position(&mut tx, &fx, p["side"].as_str().unwrap(), d(&p["volume"])).await;
        by_ticket.insert(p["ticket"].as_u64().unwrap(), (pos, d(&p["volume"])));
    }

    let mut min_balance = Decimal::MAX;
    for s in fx_json["steps"].as_array().unwrap() {
        let ticket = s["ticket"].as_u64().unwrap();
        match s["kind"].as_str().unwrap() {
            "open" => {
                let pos = open_position(&mut tx, &fx, s["side"].as_str().unwrap(), d(&s["volume"])).await;
                charge_commission(&mut tx, &fx, &pos, d(&s["commission"])).await;
                by_ticket.insert(ticket, (pos, d(&s["volume"])));
            }
            "close" => {
                let (pos, vol) = by_ticket[&ticket].clone();
                let out = book::close_position_in_tx(&mut tx, &pos, vol, Decimal::from(4000), d(&s["pnl"]), "replay", reason(s["reason"].as_str().unwrap()))
                    .await.unwrap().expect("closed");
                assert_eq!(out.write_off, None, "ticket {ticket}: no write-off while other positions are open");
                min_balance = min_balance.min(out.final_balance);
            }
            k => panic!("unknown step {k}"),
        }
    }
    assert_eq!(nbp_rows(&mut tx, &fx.account).await.len() as u64, e["afterRealStepsNbpRows"].as_u64().unwrap());
    let (bal,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(bal, d(&e["afterRealStepsBalance"]));
    assert!(min_balance < Decimal::ZERO);

    let last = &fx_json["syntheticFinalCloses"];
    for t in last["tickets"].as_array().unwrap() {
        let (pos, vol) = by_ticket[&t.as_u64().unwrap()].clone();
        book::close_position_in_tx(&mut tx, &pos, vol, Decimal::from(4000), d(&last["pnl"]), "replay", reason(last["reason"].as_str().unwrap()))
            .await.unwrap().expect("closed");
    }
    let rows = nbp_rows(&mut tx, &fx.account).await;
    let final_ticket = e["finalWriteOffTicket"].as_u64().unwrap();
    assert_eq!(rows.len() as u64, e["finalNbpRows"].as_u64().unwrap(), "exactly one NBP row");
    assert_eq!(rows[0], (d(&e["finalWriteOff"]), by_ticket[&final_ticket].0.clone()));
    let (bal,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(bal, d(&e["finalBalance"]));
    let (audits,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "AuditLog" WHERE "entityId" = $1 AND action = 'NEGATIVE_BALANCE_PROTECTION_APPLIED'"#)
        .bind(&fx.account).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(audits, 1);
    tx.rollback().await.unwrap();
}
