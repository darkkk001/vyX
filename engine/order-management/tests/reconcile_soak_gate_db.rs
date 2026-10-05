//! The soak gate as the owner defined it (2026-09-29): the exit's risk actions are counted SINCE THE CLOCK STARTED and
//! only on REAL brokers (a "zz" test tenant such as the shadow bot's zzshadowbot is reported apart); the clock is
//! derived (the soak start, or the newest unexplained pair not excused); an excuse is the owner's act alone (a row in
//! shadow_excuse with a reason and a name), logged once, and removing it restores the reset.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test reconcile_soak_gate_db

use chrono::{DateTime, Utc};
use order_management::reconcile::{is_test_broker, Reconciler};
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
            eprintln!("reconcile_soak_gate_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

struct Fx {
    pool: PgPool,
    tag: String,
    brokers: Vec<String>,
}

impl Fx {
    async fn broker(&mut self, subdomain: &str) -> String {
        let id = format!("sg-b-{subdomain}");
        sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $2, $2, now())"#).bind(&id).bind(subdomain).execute(&self.pool).await.unwrap();
        self.brokers.push(id.clone());
        id
    }
    async fn account(&self, broker: &str, name: &str) -> String {
        let (account, group) = (format!("sg-a-{}-{name}", self.tag), format!("sg-g-{}-{name}", self.tag));
        sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 50, now())"#)
            .bind(&group).bind(broker).execute(&self.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, "updatedAt")
             VALUES ($1, $2, $3, $4, $5, 'x', 'Soak Gate', 'LIVE', 1000, now())"#)
            .bind(&account).bind(broker).bind(&group).bind(format!("5{}{}", &self.tag[..5], &name[..2])).bind(format!("{account}@test.local"))
            .execute(&self.pool).await.unwrap();
        account
    }
    /// The web's margin-call notice `ago` seconds ago.
    async fn notice(&self, broker: &str, account: &str, ago: i64, n: &str) {
        sqlx::query(r#"INSERT INTO "Notification" (id, "brokerId", type, title, body, "entityType", "entityId", "accountId", "createdAt")
             VALUES ($1, $2, 'MARGIN_CALL', 'Margin call', 'margin level 82.47%, at or below the 100% margin-call level', 'Account', $3, $3, now() - make_interval(secs => $4))"#)
            .bind(format!("sg-n-{}-{n}", self.tag)).bind(broker).bind(account).bind(ago as f64).execute(&self.pool).await.unwrap();
    }
    /// The shadow's margin_call_in edge `ago` seconds ago.
    async fn edge(&self, account: &str, ago: i64) {
        sqlx::query(r#"INSERT INTO shadow_decision (dedupe_key, kind, account_id, level, first_seen, last_seen)
             VALUES ($1, 'margin_call_in', $2, 82.4, now() - make_interval(secs => $3), now())"#)
            .bind(format!("margin_call_in:{account}:sg")).bind(account).bind(ago as f64).execute(&self.pool).await.unwrap();
    }
    async fn cleanup(&self) {
        let like = format!("sg-a-{}-%", self.tag);
        let _ = sqlx::query("DELETE FROM shadow_excuse WHERE pair_id IN (SELECT id FROM shadow_pair WHERE account_id LIKE $1)").bind(&like).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_state WHERE key LIKE 'excuse_logged:%' AND substr(key, 15)::bigint NOT IN (SELECT pair_id FROM shadow_excuse)").execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_pair WHERE account_id LIKE $1").bind(&like).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_decision WHERE account_id LIKE $1").bind(&like).execute(&self.pool).await;
        for b in &self.brokers {
            for sql in [r#"DELETE FROM "Notification" WHERE "brokerId" = $1"#, r#"DELETE FROM "Account" WHERE "brokerId" = $1"#, r#"DELETE FROM "Group" WHERE "brokerId" = $1"#, r#"DELETE FROM "Broker" WHERE id = $1"#] {
                let _ = sqlx::query(sql).bind(b).execute(&self.pool).await;
            }
        }
    }
}

#[test]
fn test_tenants_are_the_zz_ones() {
    assert!(is_test_broker("zzshadowbot"));
    assert!(is_test_broker("zzsynthtest"));
    assert!(!is_test_broker("futurixglobal"));
    assert!(!is_test_broker("azzure"));
}

#[tokio::test]
async fn the_gate_counts_real_brokers_since_the_clock_and_only_the_owner_can_excuse_a_reset() {
    let Some(url) = url() else { return };
    let recorder = Arc::new(Recorder::connect(&url).await.expect("local store"));
    let pool = recorder.store().unwrap().clone();
    let reconciler = Reconciler::new(pool.clone(), recorder.clone()).await.expect("reconciler").with_timing(60, 0);
    sqlx::query("DELETE FROM shadow_state WHERE key LIKE 'web_mc_cursor%' OR key LIKE 'web_close_cursor%'").execute(&pool).await.unwrap();

    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let mut fx = Fx { pool: pool.clone(), tag: tag.clone(), brokers: vec![] };
    let body = async {
        // (a) a CLEAN CLOCK: the owner deletes the soak start; the next read sets it to now
        sqlx::query("DELETE FROM shadow_state WHERE key = 'clock_started_at'").execute(&pool).await.unwrap();
        let soak_start = reconciler.clock_started_at().await;
        assert!((Utc::now() - soak_start).num_seconds().abs() < 5, "a clean clock starts now");
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        let real = fx.broker(&format!("sgreal{}", &tag[..6])).await;
        let bot = fx.broker(&format!("zzsg{}", &tag[..6])).await;
        // a MATCH on a real broker, a MATCH on the bot's test tenant, and a WEB_ONLY on the real broker
        let ra = fx.account(&real, "ra").await;
        let ba = fx.account(&bot, "ba").await;
        let rw = fx.account(&real, "rw").await;
        fx.notice(&real, &ra, 10, "ra").await;
        fx.edge(&ra, 11).await;
        fx.notice(&bot, &ba, 10, "ba").await;
        fx.edge(&ba, 11).await;
        fx.notice(&real, &rw, 10, "rw").await;
        reconciler.run_once().await.unwrap();

        let pairs: Vec<(i64, String, String, Option<String>, DateTime<Utc>)> =
            sqlx::query_as("SELECT id, account_id, class, broker, created_at FROM shadow_pair WHERE account_id LIKE $1 ORDER BY account_id")
                .bind(format!("sg-a-{tag}-%")).fetch_all(&pool).await.unwrap();
        let of = |acc: &str| pairs.iter().find(|p| p.1 == acc).cloned().unwrap_or_else(|| panic!("no pair for {acc}: {pairs:?}"));
        let (_, _, c_ra, b_ra, _) = of(&ra);
        let (_, _, c_ba, b_ba, _) = of(&ba);
        let (web_only_id, _, c_rw, _, web_only_at) = of(&rw);
        assert_eq!((c_ra.as_str(), c_ba.as_str(), c_rw.as_str()), ("MATCH", "MATCH", "WEB_ONLY"), "{pairs:?}");
        assert_eq!(b_ra.as_deref(), Some(format!("sgreal{}", &tag[..6]).as_str()), "each pair carries its broker");
        assert_eq!(b_ba.as_deref(), Some(format!("zzsg{}", &tag[..6]).as_str()));

        // the WEB_ONLY resets the clock (derived from the pair)
        assert_eq!(reconciler.clock_started_at().await, web_only_at, "an unexplained pair resets the clock");

        // (b) the OWNER excuses it: a reason and a name are required
        let short = sqlx::query("INSERT INTO shadow_excuse (pair_id, reason, excused_by) VALUES ($1, 'test', 'owner')").bind(web_only_id).execute(&pool).await;
        assert!(short.is_err(), "an excuse needs a real reason (at least 10 characters)");
        sqlx::query("INSERT INTO shadow_excuse (pair_id, reason, excused_by) VALUES ($1, 'failed S4 run: position opened already beyond stop-out (harness artifact)', 'owner')")
            .bind(web_only_id).execute(&pool).await.unwrap();
        assert_eq!(reconciler.clock_started_at().await, soak_start, "an excused pair no longer resets the clock");
        // every excuse is announced once by the reconciler
        reconciler.run_once().await.unwrap();
        let logged: Option<(String,)> = sqlx::query_as("SELECT value FROM shadow_state WHERE key = $1").bind(format!("excuse_logged:{web_only_id}")).fetch_optional(&pool).await.unwrap();
        assert!(logged.is_some(), "the reconciler announced the excuse");

        // the exit counts SINCE the clock, per origin: the real MATCH counts, the bot's is reported apart
        let summary = reconciler.summarize(Utc::now().date_naive()).await.unwrap();
        assert_eq!(summary["pairedReal"], serde_json::json!(1), "{summary}");
        assert_eq!(summary["pairedBot"], serde_json::json!(1), "{summary}");
        assert_eq!(summary["clockStartedAt"], serde_json::json!(soak_start.to_rfc3339()), "{summary}");
        assert!(summary["excused"].as_i64().unwrap() >= 1, "{summary}");
        assert_eq!(summary["exitMet"], serde_json::json!(false));

        // removing the excuse restores the reset
        sqlx::query("DELETE FROM shadow_excuse WHERE pair_id = $1").bind(web_only_id).execute(&pool).await.unwrap();
        assert_eq!(reconciler.clock_started_at().await, web_only_at, "without its excuse the pair resets the clock again");
        // and a clock reset since the MATCHes: nothing paired counts in the new clean run
        let after = reconciler.summarize(Utc::now().date_naive()).await.unwrap();
        assert!(after["pairedReal"].as_i64().unwrap() <= 1, "{after}");
    };
    body.await;
    fx.cleanup().await;
}

/// The broker counter (2026-10-05): every pair since the soak start was stored with broker NULL (the read-only role
/// could not read Broker.subdomain), so "30 real paired" counted nothing. Once the column is readable the reconciler
/// fills the broker in itself: pairs since the soak start get their account's broker, an older pair is left alone,
/// nothing is re-classified, and the backfill does not run again within BACKFILL_EVERY.
#[tokio::test]
async fn pairs_stored_without_a_broker_since_the_soak_start_get_it_filled_in() {
    let Some(url) = url() else { return };
    let pool = PgPool::connect(&url).await.unwrap();
    let recorder = Arc::new(Recorder::connect(&url).await.expect("local store"));
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let mut fx = Fx { pool: pool.clone(), tag: tag.clone(), brokers: Vec::new() };
    let sub = format!("realbf{}", &tag[..6]);
    let broker = fx.broker(&sub).await;
    let account = fx.account(&broker, "bf").await;
    let reconciler = Reconciler::new(pool.clone(), recorder.clone()).await.expect("reconciler");
    let since = reconciler.soak_started_at().await;
    let pair = |created: DateTime<Utc>, n: &str| {
        let (pool, account, tag) = (pool.clone(), account.clone(), tag.clone());
        let n = n.to_string();
        async move {
            let (id,): (i64,) = sqlx::query_as("INSERT INTO shadow_pair (class, kind, account_id, web_ref, created_at) VALUES ('MATCH', 'stop_out', $1, $2, $3) RETURNING id")
                .bind(&account).bind(format!("bf-{tag}-{n}")).bind(created).fetch_one(&pool).await.unwrap();
            id
        }
    };
    let new_pair = pair(Utc::now().max(since), "new").await;
    let old_pair = pair(since - chrono::Duration::days(1), "old").await;
    let result = async {
        let first = reconciler.backfill_brokers().await;
        let again = reconciler.backfill_brokers().await;
        let get = |id: i64| {
            let pool = pool.clone();
            async move { sqlx::query_as::<_, (Option<String>, String)>("SELECT broker, class FROM shadow_pair WHERE id = $1").bind(id).fetch_one(&pool).await.unwrap() }
        };
        (first, again, get(new_pair).await, get(old_pair).await)
    }
    .await;
    fx.cleanup().await;
    let (first, again, (new_broker, new_class), (old_broker, _)) = result;
    assert!(first >= 1, "the pair since the soak start was filled in: {first}");
    assert_eq!(new_broker.as_deref(), Some(sub.as_str()));
    assert_eq!(new_class, "MATCH", "nothing re-classified");
    assert_eq!(old_broker, None, "a pair from before the soak start is left alone");
    assert_eq!(again, 0, "not again within BACKFILL_EVERY");
    assert!(!is_test_broker(&sub), "a real broker: it counts toward the 30 real paired");
}
