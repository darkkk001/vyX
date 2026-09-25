//! DB-backed tests for the post-close outbox dispatcher (outbox.rs, Rust cutover Stage 3), against a local mock of
//! the web's /api/internal/post-close. Same scratch-DB rules as book_db.rs:
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test \
//!   VYX_REQUIRE_DB_TESTS=1 cargo test -p order-management --test outbox_db
//! One test function on purpose: drain_once takes every due row in the database, so the scenarios run in order
//! instead of racing each other's rows.

use order_management::outbox::{self, Delivery, DispatcherConfig, FailureOutcome};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("outbox_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

/// How the mock answers one request: (HTTP status, body), or None to drop the connection without an answer.
type Responder = Arc<dyn Fn(&serde_json::Value) -> Option<(u16, String)> + Send + Sync>;

/// A one-status HTTP server; every request it receives (head + body) is kept. A 200 answers the batch form
/// (`{ids}`) with every row `done`, the single form with `{"status":"done"}`.
async fn mock(status: u16) -> (String, Arc<Mutex<Vec<String>>>) {
    mock_with(Arc::new(move |body: &serde_json::Value| {
        if status != 200 {
            return Some((status, r#"{"status":"error"}"#.to_string()));
        }
        Some((200, match body.get("ids").and_then(|v| v.as_array()) {
            Some(ids) => serde_json::json!({ "results": ids.iter().map(|id| serde_json::json!({ "id": id, "status": "done" })).collect::<Vec<_>>() }).to_string(),
            None => r#"{"status":"done"}"#.to_string(),
        }))
    }))
    .await
}

async fn mock_with(respond: Responder) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_by_server = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let seen = seen_by_server.clone();
            let respond = respond.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                let mut total = 0;
                loop {
                    let n = socket.read(&mut buf[total..]).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    total += n;
                    let text = String::from_utf8_lossy(&buf[..total]).to_string();
                    if let Some(h) = text.find("\r\n\r\n") {
                        let length = text[..h]
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if total >= h + 4 + length {
                            seen.lock().unwrap().push(text);
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&buf[..total]).to_string();
                let json: serde_json::Value = text.find("\r\n\r\n").and_then(|h| serde_json::from_str(&text[h + 4..]).ok()).unwrap_or(serde_json::Value::Null);
                if let Some((status, body)) = respond(&json) {
                    let response = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                    let _ = socket.write_all(response.as_bytes()).await;
                }
                let _ = socket.shutdown().await;
            });
        }
    });
    (format!("http://{addr}/api/internal/post-close"), seen)
}

fn cfg(url: &str) -> DispatcherConfig {
    DispatcherConfig { url: url.to_string(), secret: "s3cret".into(), sweep_interval: Duration::from_secs(3600), parallel: 8, batch: 50 }
}

async fn broker(pool: &PgPool) -> String {
    let id = Uuid::new_v4().simple().to_string();
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $2, $3, now())"#)
        .bind(&id)
        .bind(format!("Outbox Test {}", &id[..10]))
        .bind(format!("outbox-{}", &id[..10]))
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn row(pool: &PgPool, broker: &str) -> String {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO "PostCloseEffect" (id, kind, "dedupeKey", "brokerId", "accountId", "positionId", reason, payload)
           VALUES ($1, 'POSITION_CLOSED', $2, $3, 'acct-x', $4, 'stop_out', '{}'::jsonb)"#,
    )
    .bind(&id)
    .bind(format!("test:{id}"))
    .bind(broker)
    .bind(format!("pos-{}", &id[..8]))
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn state(pool: &PgPool, id: &str) -> (String, i32, f64, Option<String>) {
    sqlx::query_as(r#"SELECT status, attempts, extract(epoch from ("nextAttemptAt" - now()))::float8, "lastError" FROM "PostCloseEffect" WHERE id = $1"#)
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn dead_notices(pool: &PgPool, broker: &str) -> i64 {
    let (n,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Notification" WHERE "brokerId" = $1 AND type = 'OUTBOX_DEAD'"#)
        .bind(broker)
        .fetch_one(pool)
        .await
        .unwrap();
    n
}

#[tokio::test]
async fn dispatcher_delivers_backs_off_gives_up_once_and_wakes_fast() {
    let Some(pool) = pool().await else { return };
    // rows other runs left behind would be delivered to these mocks: retire them first (scratch DB only)
    sqlx::query(r#"UPDATE "PostCloseEffect" SET status = 'DONE' WHERE status = 'PENDING'"#).execute(&pool).await.unwrap();
    let b = broker(&pool).await;
    let client = reqwest::Client::new();

    // 200: settled, with the bearer secret and the id
    let (ok_url, ok_seen) = mock(200).await;
    let id = row(&pool, &b).await;
    assert_eq!(outbox::deliver(&client, &cfg(&ok_url), &id).await, Delivery::Settled);
    let request = ok_seen.lock().unwrap()[0].to_ascii_lowercase();
    assert!(request.contains("authorization: bearer s3cret"), "{request}");
    assert!(request.contains(&format!(r#"{{"id":"{id}"}}"#)), "{request}");

    // drain with a 200: delivered, nothing recorded as failed
    let stats = outbox::drain_once(&pool, &client, &cfg(&ok_url)).await.unwrap();
    assert_eq!((stats.delivered, stats.failed), (1, 0));
    assert_eq!(state(&pool, &id).await.1, 0);
    sqlx::query(r#"UPDATE "PostCloseEffect" SET status = 'DONE' WHERE id = $1"#).bind(&id).execute(&pool).await.unwrap(); // what the route does

    // Stage 4.6: one conflict group (three rows sharing an account) answered done / error / not_attempted: the first
    // settles, only the SECOND gets an attempt, the third is untouched. Then the group waits while its head backs off,
    // and a batch with no answer at all puts the attempt on the first row still PENDING only.
    {
        let shared = format!("acct-shared-{}", &b[..8]);
        let mut group = Vec::new();
        for _ in 0..3 {
            let rid = row(&pool, &b).await;
            sqlx::query(r#"UPDATE "PostCloseEffect" SET "accountId" = $2 WHERE id = $1"#).bind(&rid).bind(&shared).execute(&pool).await.unwrap();
            group.push(rid);
        }
        let (script_url, script_seen) = mock_with(Arc::new(|body: &serde_json::Value| {
            let ids = body.get("ids")?.as_array()?.clone();
            let statuses = ["done", "error", "not_attempted"];
            let results: Vec<serde_json::Value> = ids
                .iter()
                .enumerate()
                .map(|(i, id)| serde_json::json!({ "id": id, "status": statuses.get(i).copied().unwrap_or("not_attempted"), "error": "boom" }))
                .collect();
            Some((200, serde_json::json!({ "results": results }).to_string()))
        }))
        .await;
        let stats = outbox::drain_once(&pool, &client, &cfg(&script_url)).await.unwrap();
        assert_eq!((stats.delivered, stats.failed), (1, 1), "{stats:?}");
        let requests = script_seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1, "one conflict group = one batch request");
        assert!(requests[0].contains(&format!(r#""ids":["{}","{}","{}"]"#, group[0], group[1], group[2])), "in order: {}", requests[0]);
        assert_eq!(state(&pool, &group[1]).await.1, 1, "the failed row carries the attempt");
        assert_eq!(state(&pool, &group[2]).await.1, 0, "the row after it is untouched");
        sqlx::query(r#"UPDATE "PostCloseEffect" SET status = 'DONE' WHERE id = $1"#).bind(&group[0]).execute(&pool).await.unwrap(); // what the route did
        let before = script_seen.lock().unwrap().len();
        outbox::drain_once(&pool, &client, &cfg(&script_url)).await.unwrap();
        assert_eq!(script_seen.lock().unwrap().len(), before, "a group whose head is backing off waits as a whole");
        // due 1 s AGO, not now(): "nextAttemptAt" is timestamptz(3) and Postgres ROUNDS now() to the millisecond, so a
        // row set to now() can sit up to 0.5 ms in the future; a drain inside that window skipped it (the (1, 0) flake of
        // 2026-09-25, proven: 938 of 2000 immediate checks saw such a row as not yet due). Harmless in production (a
        // row is picked up 0.5 ms later), fatal to an assert made in the same instant.
        sqlx::query(r#"UPDATE "PostCloseEffect" SET "nextAttemptAt" = now() - interval '1 second' WHERE id = ANY($1)"#).bind(&group).execute(&pool).await.unwrap();
        let (drop_url, _) = mock_with(Arc::new(|_: &serde_json::Value| None)).await;
        outbox::drain_once(&pool, &client, &cfg(&drop_url)).await.unwrap();
        assert_eq!(
            (state(&pool, &group[1]).await.1, state(&pool, &group[2]).await.1),
            (2, 0),
            "only the first PENDING row of an unanswered batch counts an attempt"
        );
        sqlx::query(r#"UPDATE "PostCloseEffect" SET status = 'DONE' WHERE id = ANY($1)"#).bind(&group).execute(&pool).await.unwrap();
    }

    // a 500: one attempt, next try in 2 s, the error kept; not due again straight away
    let (err_url, err_seen) = mock(500).await;
    let id = row(&pool, &b).await;
    let stats = outbox::drain_once(&pool, &client, &cfg(&err_url)).await.unwrap();
    assert_eq!((stats.delivered, stats.failed, stats.dead), (0, 1, 0));
    let (status, attempts, wait, error) = state(&pool, &id).await;
    assert_eq!((status.as_str(), attempts), ("PENDING", 1));
    assert!((1.0..=3.0).contains(&wait), "next try in {wait} s");
    assert!(error.unwrap().starts_with("HTTP 500"));
    let before = err_seen.lock().unwrap().len();
    outbox::drain_once(&pool, &client, &cfg(&err_url)).await.unwrap();
    assert_eq!(err_seen.lock().unwrap().len(), before, "a backed-off row must not be re-sent early");

    // nobody listening: a failure too
    let dead_port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    match outbox::deliver(&client, &cfg(&format!("http://127.0.0.1:{dead_port}/x")), &id).await {
        Delivery::Failed(e) => assert!(e.starts_with("no answer"), "{e}"),
        other => panic!("expected a failure, got {other:?}"),
    }

    // the backoff table, then DEAD at attempt 50 with exactly one OUTBOX_DEAD
    let mut waits = Vec::new();
    for _ in 0..6 {
        outbox::record_failure(&pool, &id, "x").await.unwrap();
        waits.push(state(&pool, &id).await.2.round() as i64);
    }
    // attempts 2..7 (the drain above was attempt 1): 10 s, 30 s, 2 min, 10 min, then 30 min
    let expected = [10, 30, 120, 600, 1800, 1800];
    assert!(waits.iter().zip(expected).all(|(w, e)| (w - e).abs() <= 2), "{waits:?}");
    sqlx::query(r#"UPDATE "PostCloseEffect" SET attempts = 49 WHERE id = $1"#).bind(&id).execute(&pool).await.unwrap();
    assert_eq!(outbox::record_failure(&pool, &id, "HTTP 500: boom").await.unwrap(), FailureOutcome::Dead);
    assert_eq!(outbox::record_failure(&pool, &id, "HTTP 500: boom").await.unwrap(), FailureOutcome::Gone);
    assert_eq!(state(&pool, &id).await.0, "DEAD");
    assert_eq!(dead_notices(&pool, &b).await, 1);
    let (body,): (String,) = sqlx::query_as(r#"SELECT body FROM "Notification" WHERE "brokerId" = $1 AND type = 'OUTBOX_DEAD'"#)
        .bind(&b)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(body.contains("after 50 attempts") && body.contains("HTTP 500: boom") && body.contains(&id), "{body}");

    // older than 24 h: DEAD on the next failure
    let old = row(&pool, &b).await;
    sqlx::query(r#"UPDATE "PostCloseEffect" SET "createdAt" = now() - interval '25 hours' WHERE id = $1"#).bind(&old).execute(&pool).await.unwrap();
    assert_eq!(outbox::record_failure(&pool, &old, "no answer").await.unwrap(), FailureOutcome::Dead);
    assert_eq!(dead_notices(&pool, &b).await, 2);

    // the fast path: a spawned dispatcher whose sweep is an hour away still delivers within a moment of wake()
    let (fast_url, fast_seen) = mock(200).await;
    outbox::spawn(pool.clone(), cfg(&fast_url));
    tokio::time::sleep(Duration::from_millis(200)).await; // let it reach its select!
    let fast = row(&pool, &b).await;
    outbox::wake();
    let mut delivered = false;
    for _ in 0..30 {
        if fast_seen.lock().unwrap().iter().any(|r| r.contains(&fast)) {
            delivered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(delivered, "wake() did not deliver within 3 s");

    for sql in [
        r#"DELETE FROM "Notification" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "PostCloseEffect" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Broker" WHERE id = $1"#,
    ] {
        sqlx::query(sql).bind(&b).execute(&pool).await.unwrap();
    }
}
