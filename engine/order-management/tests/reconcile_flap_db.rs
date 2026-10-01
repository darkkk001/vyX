//! Margin-call flapping (2026-10-01): account 50005708 crossed its 100 % call level 11 times between 04:19:08 and
//! 04:21:40 UTC. The web sent 11 MARGIN_CALL + 11 MARGIN_CALL_CLEARED notices; the shadow, damped to one margin-call
//! edge per 5 s (margin_watch EDGE_EVERY, now deferring instead of dropping), records 8 "in" edges for the same
//! moments. One web notice (04:20:04.94, the 0.58 s episode) used to come out WEB_ONLY and reset the soak clock.
//! Replayed here with the exact times, shifted to "now": every web notice is MATCH / TIMING or explained (SNAPSHOT),
//! 0 WEB_ONLY, no clock reset -- with the shadow's samples, and with its edges alone. Plus the reverse case: the
//! shadow sees an episode the web merged (the web left a margin call within the window) -> SNAPSHOT.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test reconcile_flap_db -- --nocapture

use chrono::{DateTime, Duration, Utc};
use order_management::reconcile::Reconciler;
use order_management::shadow::Recorder;
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
            eprintln!("reconcile_flap_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

/// The web's 11 episodes: (in, out, level in the MARGIN_CALL notice), seconds after 04:19:00 UTC.
const WEB: [(f64, f64, &str); 11] = [
    (8.943, 14.889, "98.56"), (43.717, 49.877, "99.41"), (51.806, 54.866, "99.89"), (57.888, 59.869, "98.93"),
    (64.940, 65.520, "97.73"), (75.133, 82.492, "99.65"), (84.937, 88.130, "97.25"), (95.701, 100.236, "98.93"),
    (102.287, 108.631, "97.25"), (127.105, 153.198, "89.81"), (155.018, 160.068, "99.65"),
];
/// The shadow's "in" edges for the same moments: the trigger's fires after this fix (margin_watch
/// the_11_flap_sequence_fires_deferred_edges_never_loses_the_final_state), seconds after 04:19:00.
const SHADOW_IN: [f64; 8] = [9.0, 43.8, 57.9, 75.2, 87.5, 97.5, 127.2, 158.2];

struct Fx {
    pool: PgPool,
    broker: String,
    tag: String,
    base: DateTime<Utc>,
}

impl Fx {
    fn t(&self, secs: f64) -> DateTime<Utc> {
        self.base + Duration::milliseconds((secs * 1000.0).round() as i64)
    }
    async fn account(&self, name: &str) -> String {
        let (account, group) = (format!("fl-a-{}-{name}", self.tag), format!("fl-g-{}-{name}", self.tag));
        sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 20, now())"#)
            .bind(&group).bind(&self.broker).execute(&self.pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, "updatedAt")
             VALUES ($1, $2, $3, $4, $5, 'x', 'Flap Test', 'LIVE', 4156.19, now())"#)
            .bind(&account).bind(&self.broker).bind(&group).bind(format!("6{}{}", &self.tag[..5], &name[..2])).bind(format!("{account}@test.local"))
            .execute(&self.pool).await.unwrap();
        account
    }
    async fn notice(&self, account: &str, kind: &str, at: DateTime<Utc>, body: &str, n: &str) {
        sqlx::query(r#"INSERT INTO "Notification" (id, "brokerId", type, title, body, "entityType", "entityId", "accountId", "createdAt")
             VALUES ($1, $2, $3, 'Margin call', $4, 'Account', $5, $5, $6)"#)
            .bind(format!("fl-n-{}-{n}", self.tag)).bind(&self.broker).bind(kind).bind(body).bind(account).bind(at)
            .execute(&self.pool).await.unwrap();
    }
    async fn edge(&self, account: &str, at: DateTime<Utc>, level: &str) -> String {
        let key = format!("margin_call_in:{account}:{}", at.timestamp_millis());
        sqlx::query(r#"INSERT INTO shadow_decision (dedupe_key, kind, account_id, level, first_seen, last_seen) VALUES ($1, 'margin_call_in', $2, $3::numeric, $4, $4)"#)
            .bind(&key).bind(account).bind(level).bind(at).execute(&self.pool).await.unwrap();
        key
    }
    async fn web_flaps(&self, account: &str, prefix: &str) {
        for (i, (tin, tout, level)) in WEB.iter().enumerate() {
            let body = format!("Account 50005708's margin level is {level}%, at or below the 100% margin-call level.");
            self.notice(account, "MARGIN_CALL", self.t(*tin), &body, &format!("{prefix}in{i}")).await;
            self.notice(account, "MARGIN_CALL_CLEARED", self.t(*tout), "back above", &format!("{prefix}out{i}")).await;
        }
    }
    async fn cleanup(&self) {
        let _ = sqlx::query(r#"DELETE FROM "Notification" WHERE "brokerId" = $1"#).bind(&self.broker).execute(&self.pool).await;
        let _ = sqlx::query(r#"DELETE FROM "Account" WHERE "brokerId" = $1"#).bind(&self.broker).execute(&self.pool).await;
        let _ = sqlx::query(r#"DELETE FROM "Group" WHERE "brokerId" = $1"#).bind(&self.broker).execute(&self.pool).await;
        let _ = sqlx::query(r#"DELETE FROM "Broker" WHERE id = $1"#).bind(&self.broker).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_decision WHERE account_id LIKE $1").bind(format!("fl-a-{}-%", self.tag)).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_pair WHERE account_id LIKE $1").bind(format!("fl-a-{}-%", self.tag)).execute(&self.pool).await;
    }
}

#[tokio::test]
async fn the_11_flap_episode_of_50005708_pairs_or_is_explained_and_never_resets_the_soak_clock() {
    let Some(url) = url() else { return };
    let recorder = Arc::new(Recorder::connect(&url).await.expect("local store"));
    let pool = recorder.store().unwrap().clone();
    // production timing: pairing window 60 s, settle 0 (the rows are already old)
    let reconciler = Reconciler::new(pool.clone(), recorder.clone()).await.expect("reconciler").with_timing(60, 0);
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let broker = format!("fl-{tag}");
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(&pool).await.unwrap();
    // the whole 2.5 min sequence ends 80 s ago: every lone shadow edge is past the window + settle
    let base = DateTime::<Utc>::from_timestamp_millis((Utc::now() - Duration::seconds(240)).timestamp_millis()).unwrap(); // whole ms: the DB keeps µs
    let fx = Fx { pool: pool.clone(), broker, tag, base };
    // the web notices are read from a cursor: start it just before the sequence (this test owns the cursors)
    sqlx::query("DELETE FROM shadow_state WHERE key LIKE 'web_mc_cursor%' OR key LIKE 'web_close_cursor%'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO shadow_state (key, value) VALUES ('web_mc_cursor_at', $1), ('web_mc_cursor_id', '')")
        .bind(fx.t(-1.0).to_rfc3339()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO shadow_state (key, value) VALUES ('web_close_cursor_at', $1), ('web_close_cursor_id', '')")
        .bind(Utc::now().to_rfc3339()).execute(&pool).await.unwrap();

    let body = async {
        // (A) the shadow's edges AND its level samples (one per second: 97.7 % while in a call, 104 % while out)
        let a = fx.account("samples").await;
        fx.web_flaps(&a, "a").await;
        for s in SHADOW_IN {
            fx.edge(&a, fx.t(s), "97.70").await;
        }
        for sec in 0..=170 {
            let in_call = WEB.iter().any(|(i, o, _)| (sec as f64) >= *i && (sec as f64) < *o);
            recorder.sample_at(&a, fx.t(sec as f64), Some(if in_call { dec!(97.7) } else { dec!(104) }), dec!(20), dec!(100));
        }
        // (B) the same, the shadow's edges ONLY (no samples: e.g. after an engine restart wiped the in-memory ones)
        let b = fx.account("edgesonly").await;
        fx.web_flaps(&b, "b").await;
        for s in SHADOW_IN {
            fx.edge(&b, fx.t(s), "97.70").await;
        }
        // (C) reverse: the web was in a margin call 04:19:10 .. 04:20:15 (one notice, one clear); the shadow paired the
        // call, then saw a short re-entry at 04:20:20 that the web merged into its clear (5 s earlier) -> the lone shadow
        // edge is explained by the web's clear within the window (the web's notice is 70 s away, outside it)
        let c = fx.account("reverse").await;
        fx.notice(&c, "MARGIN_CALL", fx.t(10.0), "Account x's margin level is 99.65%, at or below the 100% margin-call level.", "cin").await;
        fx.notice(&c, "MARGIN_CALL_CLEARED", fx.t(75.0), "back above", "cout").await;
        let c_pair = fx.edge(&c, fx.t(10.1), "99.60").await;
        let c_extra = fx.edge(&c, fx.t(80.0), "93.10").await; // 7 % below the level: only the web's clear explains it

        let clock_before = reconciler.clock_started_at().await;
        reconciler.run_once().await.unwrap();
        let clock_after = reconciler.clock_started_at().await;
        let rows: Vec<(String, Option<String>, Option<String>, String, Option<DateTime<Utc>>, Option<i64>, serde_json::Value)> = sqlx::query_as(
            "SELECT account_id, web_ref, decision_key, class, web_at, skew_ms, detail FROM shadow_pair WHERE account_id LIKE $1 ORDER BY account_id, web_at NULLS LAST, id",
        )
        .bind(format!("fl-a-{}-%", fx.tag)).fetch_all(&pool).await.unwrap();
        (a, b, c, c_pair, c_extra, rows, clock_before, clock_after)
    };
    let (a, b, c, c_pair, c_extra, rows, clock_before, clock_after) = body.await;
    fx.cleanup().await;

    for acc in [&a, &b] {
        eprintln!("account {}:", if acc == &a { "A (edges + samples)" } else { "B (edges only)" });
        for r in rows.iter().filter(|r| &r.0 == acc && r.1.is_some()) {
            let at = r.4.map(|t| (t - base).num_milliseconds() as f64 / 1000.0).unwrap_or(f64::NAN);
            eprintln!("  web in at +{at:7.3}s -> {:8} skew {:>6} ms {}", r.3, r.5.map(|v| v.to_string()).unwrap_or("-".into()),
                r.6.get("shadow").and_then(|s| s.get("reason")).and_then(|s| s.as_str()).unwrap_or(""));
        }
        let web_rows: Vec<_> = rows.iter().filter(|r| &r.0 == acc && r.1.is_some()).collect();
        assert_eq!(web_rows.len(), 11, "all 11 web notices classified");
        let classes: Vec<&str> = web_rows.iter().map(|r| r.3.as_str()).collect();
        assert!(classes.iter().all(|c| ["MATCH", "TIMING", "SNAPSHOT"].contains(c)), "no WEB_ONLY: {classes:?}");
        // each of the 8 shadow edges pairs the web notice it belongs to (within 5 s: MATCH, no cascade), the 3 notices of
        // the episodes the trigger coalesced (3, 5, 9) are explained by the overlapping shadow episode
        assert_eq!(classes, ["MATCH", "MATCH", "SNAPSHOT", "MATCH", "SNAPSHOT", "MATCH", "MATCH", "MATCH", "SNAPSHOT", "MATCH", "MATCH"], "{classes:?}");
        // the 0.58 s episode (04:20:04.94) is one of the explained ones
        let ep5 = web_rows.iter().find(|r| r.4.is_some_and(|t| ((t - base).num_milliseconds() - 64_940).abs() <= 1)).unwrap();
        assert!(["MATCH", "TIMING", "SNAPSHOT"].contains(&ep5.3.as_str()), "{ep5:?}");
        // no shadow edge left unexplained
        assert!(rows.iter().filter(|r| &r.0 == acc).all(|r| r.3 != "ENGINE_ONLY" && r.3 != "WEB_ONLY"), "{rows:?}");
    }
    let class_of = |key: &str| rows.iter().find(|r| r.2.as_deref() == Some(key)).map(|r| (r.3.clone(), r.6.clone()));
    assert_eq!(class_of(&c_pair).map(|r| r.0).as_deref(), Some("MATCH"));
    let (cx, cd) = class_of(&c_extra).expect("the reverse edge was classified");
    eprintln!("account C (reverse): extra shadow edge -> {cx} {}", cd["web"]["reason"]);
    assert_eq!(cx, "SNAPSHOT", "{cd}");
    assert_eq!(cd["web"]["reason"], "web left a margin call within the window", "{cd}");
    assert!(rows.iter().filter(|r| r.0 == c).count() == 2, "{rows:?}");
    assert_eq!(clock_after, clock_before, "nothing unexplained: the soak clock is not reset");
}
