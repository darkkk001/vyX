//! Stage 5 reconciler on the REAL schema (scratch DB as both the book and the local store): every class the soak
//! gate counts, from rows shaped exactly like the web's (TRADE_PNL notes, MARGIN_CALL notices) and the shadow's
//! (shadow_decision), plus the soak clock reset on an unexplained one.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test reconcile_db

use chrono::{Duration, Utc};
use order_management::reconcile::Reconciler;
use order_management::shadow::Recorder;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

fn url() -> Option<String> {
    match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => {
            assert!(u.contains("@127.0.0.1:") || u.contains("@localhost:"), "refusing a non-local test database: {u}");
            Some(u)
        }
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("reconcile_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

struct Fx {
    pool: PgPool,
    broker: String,
    symbol: String,
    symbol_name: String,
    tag: String,
}

impl Fx {
    async fn account(&self, name: &str) -> String {
        let (account, group) = (format!("rc-a-{}-{name}", self.tag), format!("rc-g-{}-{name}", self.tag));
        sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 99, now())"#)
            .bind(&group).bind(&self.broker).execute(&self.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, "updatedAt")
             VALUES ($1, $2, $3, $4, $5, 'x', 'Reconcile Test', 'LIVE', 1000, now())"#)
            .bind(&account).bind(&self.broker).bind(&group).bind(format!("8{}{}", &self.tag[..5], &name[..2])).bind(format!("{account}@test.local"))
            .execute(&self.pool).await.unwrap();
        account
    }
    /// A position; `closed` = Some((note, secs ago, close price, pnl)) books it the way the web does.
    async fn position(&self, account: &str, name: &str, closed: Option<(&str, i64, Decimal, Decimal)>) -> String {
        let (order, pos) = (format!("rc-o-{}-{name}", self.tag), format!("rc-p-{}-{name}", self.tag));
        sqlx::query(r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
             VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 1, 'FILLED', $1, now())"#)
            .bind(&order).bind(&self.broker).bind(account).bind(&self.symbol).execute(&self.pool).await.unwrap();
        let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
        sqlx::query(r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", ticket) VALUES ($1, $2, $3, $4, $5, 'BUY', 1, 100, $6)"#)
            .bind(&pos).bind(&self.broker).bind(account).bind(&self.symbol).bind(&order).bind(ticket).execute(&self.pool).await.unwrap();
        if let Some((note, ago, price, pnl)) = closed {
            sqlx::query(r#"UPDATE "Position" SET status = 'CLOSED', "closePrice" = $2, "realizedPnl" = $3, "closedAt" = now() - make_interval(secs => $4) WHERE id = $1"#)
                .bind(&pos).bind(price).bind(pnl).bind(ago as f64).execute(&self.pool).await.unwrap();
            sqlx::query(r#"INSERT INTO "Transaction" (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, 'TRADE_PNL', 'COMPLETED', $4, 1000, 1000 + $4, 'Position', $5, $6, now() - make_interval(secs => $7), now())"#)
                .bind(format!("rc-t-{}-{name}", self.tag)).bind(&self.broker).bind(account).bind(pnl).bind(&pos).bind(note).bind(ago as f64)
                .execute(&self.pool).await.unwrap();
        }
        pos
    }
    /// A shadow decision seen `ago` seconds ago.
    async fn decision(&self, kind: &str, account: &str, position: Option<&str>, ago: i64, price: Option<Decimal>, pnl: Option<Decimal>, level: Option<Decimal>) {
        let key = match position { Some(p) => format!("{kind}:{p}"), None => format!("{kind}:{account}:1") };
        sqlx::query(r#"INSERT INTO shadow_decision (dedupe_key, kind, account_id, position_id, level, close_price, pnl, first_seen, last_seen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(secs => $8), now())"#)
            .bind(key).bind(kind).bind(account).bind(position).bind(level).bind(price).bind(pnl).bind(ago as f64)
            .execute(&self.pool).await.unwrap();
    }
    async fn cleanup(&self) {
        for sql in [
            r#"DELETE FROM "Notification" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Transaction" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Broker" WHERE id = $1"#,
        ] {
            let _ = sqlx::query(sql).bind(&self.broker).execute(&self.pool).await;
        }
        let _ = sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&self.symbol).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_decision WHERE account_id LIKE $1").bind(format!("rc-a-{}-%", self.tag)).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_pair WHERE account_id LIKE $1").bind(format!("rc-a-{}-%", self.tag)).execute(&self.pool).await;
        let _ = self.symbol_name.len();
    }
}

#[tokio::test]
async fn every_class_the_soak_gate_counts_and_the_clock_reset() {
    let Some(url) = url() else { return };
    let recorder = Arc::new(Recorder::connect(&url).await.expect("local store"));
    let pool = recorder.store().unwrap().clone();
    let reconciler = Reconciler::new(pool.clone(), recorder.clone()).await.expect("reconciler");
    // a fresh cursor / clock: this test owns the scratch shadow tables
    sqlx::query("DELETE FROM shadow_state").execute(&pool).await.unwrap();

    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, symbol, symbol_name) = (format!("rc-{tag}"), format!("rc-s-{tag}"), format!("ZR{}", tag[..6].to_uppercase()));
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(&pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, 'ZR', 'USD', 2, 1, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(&pool).await.unwrap();
    let fx = Fx { pool: pool.clone(), broker, symbol, symbol_name, tag };

    let body = async {
        let so = "Stop-out (automatic): margin level 95.52% at or below 99%";
        // web closed, shadow decided the same 2 s earlier, same price and P&L -> MATCH
        let a = fx.account("match").await;
        let pa = fx.position(&a, "match", Some((so, 20, dec!(90), dec!(-10)))).await;
        fx.decision("stop_out", &a, Some(&pa), 22, Some(dec!(90)), Some(dec!(-10)), Some(dec!(95))).await;
        // same decision 30 s apart -> TIMING
        let b = fx.account("timing").await;
        let pb = fx.position(&b, "timing", Some((so, 20, dec!(90), dec!(-10)))).await;
        fx.decision("stop_out", &b, Some(&pb), 50, Some(dec!(91)), Some(dec!(-9)), Some(dec!(96))).await;
        // web: stop loss; shadow: stop-out on the same position -> VALUE (unexplained)
        let c = fx.account("value").await;
        let pc = fx.position(&c, "value", Some(("Stop loss hit (automatic)", 20, dec!(90), dec!(-10)))).await;
        fx.decision("stop_out", &c, Some(&pc), 21, Some(dec!(90)), Some(dec!(-10)), Some(dec!(95))).await;
        // web stop-out, no shadow decision, but the shadow saw the account at 99.5 % (the edge) -> SNAPSHOT
        let d = fx.account("snapshot").await;
        let _pd = fx.position(&d, "snapshot", Some((so, 20, dec!(90), dec!(-10)))).await;
        recorder.sample_at(&d, Utc::now() - Duration::seconds(21), Some(dec!(99.5)), dec!(99), dec!(100));
        // web stop-out, no shadow decision, shadow saw 150 % -> WEB_ONLY (unexplained)
        let e = fx.account("webonly").await;
        let _pe = fx.position(&e, "webonly", Some((so, 20, dec!(90), dec!(-10)))).await;
        recorder.sample_at(&e, Utc::now() - Duration::seconds(21), Some(dec!(150)), dec!(99), dec!(100));
        // shadow would have stopped out 2 min ago, the position is still open, level 80 -> ENGINE_ONLY (unexplained)
        let f = fx.account("engineonly").await;
        let pf = fx.position(&f, "engineonly", None).await;
        fx.decision("stop_out", &f, Some(&pf), 120, Some(dec!(90)), Some(dec!(-10)), Some(dec!(80))).await;
        // shadow would have stopped out, the web's dealer closed it by hand first -> PREEMPTED
        let g = fx.account("preempted").await;
        let pg = fx.position(&g, "preempted", Some(("Manual close by admin @ 90.00", 115, dec!(90), dec!(-10)))).await;
        fx.decision("stop_out", &g, Some(&pg), 120, Some(dec!(90)), Some(dec!(-10)), Some(dec!(90))).await;
        // margin call: web notice and shadow edge 1 s apart -> MATCH
        let h = fx.account("mc").await;
        sqlx::query(r#"INSERT INTO "Notification" (id, "brokerId", type, title, body, "entityType", "entityId", "accountId", "createdAt")
             VALUES ($1, $2, 'MARGIN_CALL', 'Margin call', 'Account 8x''s margin level is 82.47%, at or below the 100% margin-call level.', 'Account', $3, $3, now() - interval '20 seconds')"#)
            .bind(format!("rc-n-{}", fx.tag)).bind(&fx.broker).bind(&h).execute(&pool).await.unwrap();
        fx.decision("margin_call_in", &h, None, 21, None, None, Some(dec!(82.4))).await;

        let clock_before = reconciler.clock_started_at().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        reconciler.run_once().await.unwrap();
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT account_id, class FROM shadow_pair WHERE account_id LIKE $1 ORDER BY account_id")
            .bind(format!("rc-a-{}-%", fx.tag)).fetch_all(&pool).await.unwrap();
        let class_of = |acc: &str| rows.iter().find(|(a, _)| a == acc).map(|r| r.1.clone()).unwrap_or_else(|| "NONE".into());
        let clock_after = reconciler.clock_started_at().await;
        // a second run classifies nothing twice
        reconciler.run_once().await.unwrap();
        let (n2,): (i64,) = sqlx::query_as("SELECT count(*) FROM shadow_pair WHERE account_id LIKE $1").bind(format!("rc-a-{}-%", fx.tag)).fetch_one(&pool).await.unwrap();
        let summary = reconciler.summarize(Utc::now().date_naive()).await.unwrap();
        (
            [class_of(&a), class_of(&b), class_of(&c), class_of(&d), class_of(&e), class_of(&f), class_of(&g), class_of(&h)],
            rows.len() as i64, n2, clock_after > clock_before, summary,
        )
    };
    let (classes, n1, n2, clock_reset, summary) = body.await;
    fx.cleanup().await;
    assert_eq!(classes, ["MATCH", "TIMING", "VALUE", "SNAPSHOT", "WEB_ONLY", "ENGINE_ONLY", "PREEMPTED", "MATCH"].map(String::from), "{classes:?}");
    assert_eq!(n1, 8);
    assert_eq!(n2, 8, "a second run adds nothing");
    assert!(clock_reset, "an unexplained class resets the soak clock");
    assert!(summary["counts"]["MATCH"].as_i64().unwrap_or(0) >= 2, "{summary}");
    assert_eq!(summary["exitMet"], serde_json::json!(false));
}

/// The VPS shape: the engine role has USAGE on the schema only (deploy/market_data.sql), so it cannot create the
/// shadow tables; deploy/shadow-store.sql made them as postgres. Recorder + Reconciler must start and write.
/// Runs only with SHADOW_STORE_PROBE_URL (a scratch database prepared that way, connected as the restricted role).
#[tokio::test]
async fn a_role_without_create_rights_uses_the_tables_made_by_shadow_store_sql() {
    let Ok(url) = std::env::var("SHADOW_STORE_PROBE_URL") else { return };
    assert!(url.contains("@127.0.0.1:"), "scratch only");
    let pool = PgPool::connect(&url).await.unwrap();
    let create = sqlx::query("CREATE TABLE probe_should_fail (x int)").execute(&pool).await;
    assert!(create.is_err(), "the probe role must NOT be able to create tables, or this test proves nothing");
    let recorder = Arc::new(Recorder::connect(&url).await.expect("recorder starts on existing tables"));
    let reconciler = Reconciler::new(pool.clone(), recorder.clone()).await.expect("reconciler starts on existing tables");
    recorder.record(order_management::shadow::Decision {
        kind: order_management::shadow::Kind::StopOut, account_id: "probe".into(), position_id: Some("probe-p".into()),
        level_before: None, level: Some(dec!(90)), close_price: Some(dec!(1)), pnl: Some(dec!(-1)), balance_after: None, credit_after: None, write_off: None,
        prices: serde_json::json!({}),
    }).await;
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM shadow_decision WHERE account_id = 'probe'").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 1, "the restricted role wrote a decision");
    let _ = reconciler.clock_started_at().await;
    sqlx::query("DELETE FROM shadow_decision WHERE account_id = 'probe'").execute(&pool).await.unwrap();
}
