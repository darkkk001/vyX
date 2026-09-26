//! Reconciler margin-call pairing (2026-09-26), reproducing the 12 ENGINE_ONLY margin_call_in rows of 2026-09-25
//! (account 50005708 sitting at its 100 % call level, web notices 03:40 .. 06:12 UTC):
//! - fix 1: two web notices within one minute used to pair with the SAME (earliest) shadow edge -- the second insert was
//!   silently dropped and the other shadow edges were left alone -> ENGINE_ONLY; each notice now takes the nearest
//!   edge no other notice has taken;
//! - fix 2: a lone shadow edge with a web notice for the account within the window is SNAPSHOT;
//! - item 3: a lone shadow edge while the web's own episode was still open (its last MARGIN_CALL newer than its last
//!   MARGIN_CALL_CLEARED; the 04:49 case) is SNAPSHOT;
//! and genuine cases stay ENGINE_ONLY (a closed web episode; no web record at all; an episode older than the web's
//! clear tracking).
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test reconcile_margin_call_db

use order_management::reconcile::Reconciler;
use order_management::shadow::Recorder;
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
            eprintln!("reconcile_margin_call_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

struct Fx {
    pool: PgPool,
    broker: String,
    tag: String,
}

impl Fx {
    async fn account(&self, name: &str) -> String {
        let (account, group) = (format!("mc-a-{}-{name}", self.tag), format!("mc-g-{}-{name}", self.tag));
        sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 20, now())"#)
            .bind(&group).bind(&self.broker).execute(&self.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, "updatedAt")
             VALUES ($1, $2, $3, $4, $5, 'x', 'MC Test', 'LIVE', 1000, now())"#)
            .bind(&account).bind(&self.broker).bind(&group).bind(format!("7{}{}", &self.tag[..5], &name[..2])).bind(format!("{account}@test.local"))
            .execute(&self.pool).await.unwrap();
        account
    }
    /// A web notice (trader copy): MARGIN_CALL or MARGIN_CALL_CLEARED, `ago` seconds ago.
    async fn notice(&self, account: &str, kind: &str, ago: i64, n: &str) {
        sqlx::query(r#"INSERT INTO "Notification" (id, "brokerId", type, title, body, "entityType", "entityId", "accountId", "createdAt")
             VALUES ($1, $2, $3, 'Margin call', 'test', 'Account', $4, $4, now() - make_interval(secs => $5))"#)
            .bind(format!("mc-n-{}-{n}", self.tag)).bind(&self.broker).bind(kind).bind(account).bind(ago as f64)
            .execute(&self.pool).await.unwrap();
    }
    /// A shadow margin_call_in edge (its own episode number) `ago` seconds ago.
    async fn edge(&self, account: &str, episode: u32, ago: i64, level: &str) -> String {
        let key = format!("margin_call_in:{account}:{episode}");
        sqlx::query(r#"INSERT INTO shadow_decision (dedupe_key, kind, account_id, level, first_seen, last_seen)
             VALUES ($1, 'margin_call_in', $2, $3::numeric, now() - make_interval(secs => $4), now())"#)
            .bind(&key).bind(account).bind(level).bind(ago as f64).execute(&self.pool).await.unwrap();
        key
    }
    async fn cleanup(&self) {
        let _ = sqlx::query(r#"DELETE FROM "Notification" WHERE "brokerId" = $1"#).bind(&self.broker).execute(&self.pool).await;
        let _ = sqlx::query(r#"DELETE FROM "Account" WHERE "brokerId" = $1"#).bind(&self.broker).execute(&self.pool).await;
        let _ = sqlx::query(r#"DELETE FROM "Group" WHERE "brokerId" = $1"#).bind(&self.broker).execute(&self.pool).await;
        let _ = sqlx::query(r#"DELETE FROM "Broker" WHERE id = $1"#).bind(&self.broker).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_decision WHERE account_id LIKE $1").bind(format!("mc-a-{}-%", self.tag)).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_pair WHERE account_id LIKE $1").bind(format!("mc-a-{}-%", self.tag)).execute(&self.pool).await;
    }
}

#[tokio::test]
async fn margin_call_edges_pair_nearest_unused_and_explain_what_the_web_recorded() {
    let Some(url) = url() else { return };
    let recorder = Arc::new(Recorder::connect(&url).await.expect("local store"));
    let pool = recorder.store().unwrap().clone();
    // short timing: pairing window 20 s, lone edges classified once older than 25 s
    let reconciler = Reconciler::new(pool.clone(), recorder.clone()).await.expect("reconciler").with_timing(20, 0);
    sqlx::query("DELETE FROM shadow_state").execute(&pool).await.unwrap(); // fresh cursors: this test owns them
    // item 3 needs no MARGIN_CALL_CLEARED rows left over from elsewhere in the scratch DB
    sqlx::query(r#"DELETE FROM "Notification" WHERE type = 'MARGIN_CALL_CLEARED'"#).execute(&pool).await.unwrap();

    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let broker = format!("mc-{tag}");
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(&pool).await.unwrap();
    let fx = Fx { pool: pool.clone(), broker, tag };

    let body = async {
        // (A) the 09-25 03:40-03:41 shape: flapping at 100 %, two web notices 5 s apart, three shadow edges
        let a = fx.account("flap").await;
        fx.notice(&a, "MARGIN_CALL", 60, "a1").await;
        fx.notice(&a, "MARGIN_CALL", 55, "a2").await;
        let a1 = fx.edge(&a, 1, 61, "97.27").await; // pairs with the notice at -60 (1 s)
        let a2 = fx.edge(&a, 2, 54, "97.97").await; // pairs with the notice at -55 (fix 1: the -61 edge is taken)
        let a3 = fx.edge(&a, 3, 50, "95.26").await; // left alone, a web notice 5 s away (fix 2) -> SNAPSHOT

        // (B) the 04:49 case: the web's episode opened at -600 s and was never cleared; the shadow saw a brief
        // recovery and re-entered at -300 s -> the web deliberately stayed silent (item 3) -> SNAPSHOT
        let b = fx.account("episode").await;
        fx.notice(&b, "MARGIN_CALL_CLEARED", 900, "b0").await; // an earlier episode, closed (clear tracking is live)
        fx.notice(&b, "MARGIN_CALL", 600, "b1").await;
        let b1 = fx.edge(&b, 1, 300, "95.73").await;

        // (C) genuine: the web closed its episode (clear at -500 s after the call at -600 s); the shadow's edge at
        // -300 s is one the web never saw -> ENGINE_ONLY
        let c = fx.account("closedep").await;
        fx.notice(&c, "MARGIN_CALL", 600, "c1").await;
        fx.notice(&c, "MARGIN_CALL_CLEARED", 500, "c2").await;
        let c1 = fx.edge(&c, 1, 300, "91.28").await;

        // (D) genuine: no web record for the account at all -> ENGINE_ONLY
        let d = fx.account("nothing").await;
        let d1 = fx.edge(&d, 1, 300, "79.80").await;

        // (E) the web's episode began BEFORE the web recorded any clear (tracking starts with the first
        // MARGIN_CALL_CLEARED anywhere, here at -900 s): unknown, not assumed open -> ENGINE_ONLY
        let e = fx.account("pretrack").await;
        fx.notice(&e, "MARGIN_CALL", 1000, "e1").await;
        let e1 = fx.edge(&e, 1, 300, "88.15").await;

        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let clock_before = reconciler.clock_started_at().await;
        reconciler.run_once().await.unwrap();
        let clock_after = reconciler.clock_started_at().await;
        let rows: Vec<(Option<String>, Option<String>, String, serde_json::Value)> =
            sqlx::query_as("SELECT decision_key, web_ref, class, detail FROM shadow_pair WHERE account_id LIKE $1 ORDER BY id")
                .bind(format!("mc-a-{}-%", fx.tag)).fetch_all(&pool).await.unwrap();
        let class_of = |key: &str| rows.iter().find(|r| r.0.as_deref() == Some(key)).map(|r| r.2.clone()).unwrap_or_else(|| "NONE".into());
        let detail_of = |key: &str| rows.iter().find(|r| r.0.as_deref() == Some(key)).map(|r| r.3.clone()).unwrap_or_default();
        let notices_paired = rows.iter().filter(|r| r.1.is_some()).count();
        (
            [class_of(&a1), class_of(&a2), class_of(&a3), class_of(&b1), class_of(&c1), class_of(&d1), class_of(&e1)],
            notices_paired,
            detail_of(&a3),
            detail_of(&b1),
            clock_after > clock_before,
        )
    };
    let (classes, notices_paired, a3_detail, b1_detail, clock_reset) = body.await;
    fx.cleanup().await;
    eprintln!("classes (a1 a2 a3 b1 c1 d1 e1): {classes:?}");
    assert_eq!(classes, ["MATCH", "MATCH", "SNAPSHOT", "SNAPSHOT", "ENGINE_ONLY", "ENGINE_ONLY", "ENGINE_ONLY"].map(String::from), "{classes:?}");
    assert_eq!(notices_paired, 2, "both web notices paired (none silently dropped)");
    assert_eq!(a3_detail["web"]["reason"], "web margin-call notice within the window", "{a3_detail}");
    assert_eq!(b1_detail["web"]["reason"], "inside an open web margin-call episode", "{b1_detail}");
    assert!(clock_reset, "the genuine ENGINE_ONLY rows still reset the soak clock");
}
