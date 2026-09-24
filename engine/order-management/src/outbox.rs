//! Post-close outbox dispatcher (Rust cutover Stage 3, docs/RUST-CUTOVER-PLAN.md).
//!
//! The monitor's closes (and margin-call edges) queue a `"PostCloseEffect"` row in their own transaction
//! (book.rs `enqueue_post_close` / `apply_margin_call_edge`). This task hands each row to the web, which owns
//! those effects (mirror, coverage, notifications, the dealing queue): `POST {url} {"id": ...}` with
//! `Authorization: Bearer {secret}` to /api/internal/post-close, which runs lib/post-close.ts. That route is
//! retry-safe step by step, so delivering the same row twice is harmless; this side only decides WHEN to try.
//!
//! - Fast path: `wake()` right after a close commits, so a normal close reaches the web within ~100 ms.
//! - Sweep: every `sweep_interval` (15 s) for rows that are due and not leased by a running route call.
//! - A non-200 answer or no answer is one failed attempt: `record_failure` schedules the next try on the backoff
//!   table below, and after MAX_ATTEMPTS or MAX_AGE_HOURS gives the row up as DEAD with exactly one OUTBOX_DEAD
//!   notification to the broker's staff. The same rule as lib/post-close.ts recordPostCloseFailure (the web's
//!   cron backstop, which runs rows this dispatcher has not finished within 2 minutes).
//!
//! One dispatcher per engine process. It holds no lock across the HTTP call: the route takes a 60 s lease on the
//! row itself, and a second caller for a leased row just gets "busy".

use sqlx::PgPool;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Notify;
use uuid::Uuid;

pub const MAX_ATTEMPTS: i32 = 50;
pub const MAX_AGE_HOURS: i32 = 24;
/// rows considered per drain (all PENDING ones, due or not: a group whose head is not due waits as a whole)
const WINDOW: i64 = 500;
/// the web route's own cap on `{ids}`
const MAX_BATCH: usize = 50;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

static WAKE: OnceLock<Notify> = OnceLock::new();

fn wake_handle() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

/// Called after a transaction that queued a row has committed: the dispatcher runs now instead of at its next sweep.
pub fn wake() {
    wake_handle().notify_one();
}

/// Seconds until the next try after the Nth failed attempt (= lib/post-close.ts backoffSeconds).
pub fn backoff_seconds(attempts: i32) -> i32 {
    match attempts {
        1 => 2,
        2 => 10,
        3 => 30,
        4 => 120,
        5 => 600,
        _ => 1800,
    }
}

#[derive(Debug, Clone)]
pub struct DispatcherConfig {
    /// the web's https://.../api/internal/post-close
    pub url: String,
    pub secret: String,
    pub sweep_interval: Duration,
    /// Stage 4.6: conflict groups delivered at the same time (1 = one after another)
    pub parallel: usize,
    /// Stage 4.6: rows per request (`{ids: [...]}`); 0 = the single `{id}` form, one request per row (for a web that
    /// does not have the batch form yet)
    pub batch: usize,
}

impl DispatcherConfig {
    /// VYX_POST_CLOSE_URL + VYX_POST_CLOSE_SECRET (both required), VYX_POST_CLOSE_SWEEP_SECS (default 15).
    pub fn from_env() -> Option<Self> {
        let url = std::env::var("VYX_POST_CLOSE_URL").ok().filter(|v| !v.trim().is_empty())?;
        let secret = std::env::var("VYX_POST_CLOSE_SECRET").ok().filter(|v| !v.trim().is_empty())?;
        let sweep_secs: u64 = std::env::var("VYX_POST_CLOSE_SWEEP_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(15);
        let parallel: usize = std::env::var("VYX_POST_CLOSE_PARALLEL").ok().and_then(|v| v.parse().ok()).unwrap_or(8);
        let batch: usize = std::env::var("VYX_POST_CLOSE_BATCH").ok().and_then(|v| v.parse().ok()).unwrap_or(50);
        Some(Self {
            url: url.trim().to_string(),
            secret: secret.trim().to_string(),
            sweep_interval: Duration::from_secs(sweep_secs.max(1)),
            parallel: parallel.max(1),
            batch: batch.min(MAX_BATCH),
        })
    }
}

/// Rows due now: pending, their backoff elapsed, and no route call holding them.
pub async fn due_ids(pool: &PgPool, limit: i64) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> = sqlx::query_as(
        r#"SELECT id FROM "PostCloseEffect"
           WHERE status = 'PENDING' AND "nextAttemptAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
           ORDER BY seq LIMIT $1"#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    /// 200: the route did what it could (done, already done, or another run holds it)
    Settled,
    /// anything else, or no answer
    Failed(String),
}

/// Deliveries made and their total round-trip time (Stage 4.6 measurement; the load report reads them).
pub static DELIVERIES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static DELIVERY_MICROS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub async fn deliver(client: &reqwest::Client, cfg: &DispatcherConfig, id: &str) -> Delivery {
    let started = std::time::Instant::now();
    let delivery = deliver_inner(client, cfg, id).await;
    DELIVERIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    DELIVERY_MICROS.fetch_add(started.elapsed().as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
    delivery
}

async fn deliver_inner(client: &reqwest::Client, cfg: &DispatcherConfig, id: &str) -> Delivery {
    let response = client
        .post(&cfg.url)
        .bearer_auth(&cfg.secret)
        .json(&serde_json::json!({ "id": id }))
        .timeout(HTTP_TIMEOUT)
        .send()
        .await;
    match response {
        Ok(r) if r.status() == reqwest::StatusCode::OK => Delivery::Settled,
        Ok(r) => {
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            Delivery::Failed(format!("HTTP {}: {}", status.as_u16(), body.chars().take(500).collect::<String>()))
        }
        Err(err) => Delivery::Failed(format!("no answer: {err}")),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureOutcome {
    Retry,
    Dead,
    /// the row was no longer pending (finished meanwhile): nothing recorded
    Gone,
}

/// One failed attempt: count it and schedule the next try, or give the row up as DEAD with one OUTBOX_DEAD
/// notification (the PENDING -> DEAD update is guarded, so a second caller can never notify twice).
pub async fn record_failure(pool: &PgPool, id: &str, error: &str) -> Result<FailureOutcome, sqlx::Error> {
    let error: String = error.chars().take(2000).collect();
    let mut tx = pool.begin().await?;
    #[allow(clippy::type_complexity)]
    let row: Option<(i32, bool, String, String, Option<String>, String, Vec<String>)> = sqlx::query_as(
        r#"UPDATE "PostCloseEffect" SET attempts = attempts + 1, "lastError" = $2
           WHERE id = $1 AND status = 'PENDING'
           RETURNING attempts, "createdAt" < now() - ($3::int * interval '1 hour'), "brokerId", "accountId", "positionId", kind, "doneSteps""#,
    )
    .bind(id)
    .bind(&error)
    .bind(MAX_AGE_HOURS)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((attempts, old, broker_id, account_id, position_id, kind, done_steps)) = row else {
        tx.rollback().await?;
        return Ok(FailureOutcome::Gone);
    };
    if attempts < MAX_ATTEMPTS && !old {
        sqlx::query(r#"UPDATE "PostCloseEffect" SET "nextAttemptAt" = now() + ($2::int * interval '1 second') WHERE id = $1"#)
            .bind(id)
            .bind(backoff_seconds(attempts))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(FailureOutcome::Retry);
    }

    sqlx::query(r#"UPDATE "PostCloseEffect" SET status = 'DEAD', "leaseUntil" = NULL WHERE id = $1"#)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // the same text as lib/post-close.ts outboxDeadNotification
    let what = if kind == "MARGIN_CALL" {
        format!("the margin-call notice for account {account_id}")
    } else {
        format!("the follow-up of automatic close {}", position_id.as_deref().unwrap_or(""))
    };
    let done = if done_steps.is_empty() { "nothing".to_string() } else { done_steps.join(", ") };
    let body = format!(
        "The platform stopped retrying {what} after {attempts} attempts. Done: {done}. Last error: {}. Check mirror, coverage and the dealing queue for this position by hand (PostCloseEffect {id}).",
        error.chars().take(300).collect::<String>()
    );
    let (entity_type, entity_id) = match &position_id {
        Some(p) => ("Position", p.clone()),
        None => ("Account", account_id.clone()),
    };
    sqlx::query(
        r#"INSERT INTO "Notification" (id, "brokerId", type, title, body, "entityType", "entityId")
           VALUES ($1, $2, 'OUTBOX_DEAD', 'Post-close follow-up gave up', $3, $4, $5)"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&broker_id)
    .bind(&body)
    .bind(entity_type)
    .bind(&entity_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::error!(id, attempts, %error, "post-close outbox row DEAD: staff notified (OUTBOX_DEAD)");
    Ok(FailureOutcome::Dead)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DrainStats {
    pub delivered: usize,
    pub failed: usize,
    pub dead: usize,
}

/// One PENDING row as the dispatcher schedules it.
#[derive(Debug, Clone)]
pub struct QueuedRow {
    pub id: String,
    /// due now: backoff elapsed and no route call holding it
    pub due: bool,
    /// every account its follow-up touches: its own, mirror targets', the auto-hedged leg's, released clients'
    pub accounts: Vec<String>,
}

/// Stage 4.6: rows that share ANY account form one conflict group (transitively), kept in the order given (source-
/// close order). A group runs strictly in order -- the web closes a master's mirror targets / a coverage account's
/// legs in exactly that order, and the order decides e.g. which close a negative-balance write-off lands on -- while
/// different groups touch different accounts and can run at the same time without changing any result.
pub fn conflict_groups(rows: &[QueuedRow]) -> Vec<Vec<usize>> {
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let mut parent: Vec<usize> = (0..rows.len()).collect();
    let mut owner: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        for account in &row.accounts {
            match owner.get(account.as_str()) {
                Some(&j) => {
                    let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                    if a != b {
                        parent[a.max(b)] = a.min(b);
                    }
                }
                None => {
                    owner.insert(account.as_str(), i);
                }
            }
        }
    }
    let mut groups: std::collections::BTreeMap<usize, Vec<usize>> = std::collections::BTreeMap::new();
    for i in 0..rows.len() {
        let root = find(&mut parent, i);
        groups.entry(root).or_default().push(i); // i ascending: each group keeps the given order
    }
    groups.into_values().collect()
}

/// Every PENDING row (in insertion order, "seq"; bounded) with whether it is due and the accounts it touches.
pub async fn queued_rows(pool: &PgPool, limit: i64) -> Result<Vec<QueuedRow>, sqlx::Error> {
    let rows: Vec<(String, bool, Vec<String>)> = sqlx::query_as(
        r#"SELECT e.id,
                  e."nextAttemptAt" <= now() AND (e."leaseUntil" IS NULL OR e."leaseUntil" < now()),
                  ARRAY(
                    SELECT e."accountId"
                    UNION SELECT t."accountId" FROM "MirrorLink" ml JOIN "Position" t ON t.id = ml."targetPositionId"
                          WHERE ml."sourcePositionId" = e."positionId"
                    UNION SELECT leg."accountId" FROM "Position" s JOIN "Position" leg ON leg.id = s."coveragePositionId"
                          WHERE s.id = e."positionId"
                    UNION SELECT c."accountId" FROM "Position" c WHERE c."coveragePositionId" = e."positionId"
                  )
           FROM "PostCloseEffect" e
           WHERE e.status = 'PENDING'
           ORDER BY e.seq
           LIMIT $1"#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id, due, accounts)| QueuedRow { id, due, accounts }).collect())
}

/// What the web answered for one row of a batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowOutcome {
    /// done / gone: finished
    Settled,
    /// another run holds it: leave it, the group waits
    Busy,
    /// retry / error: this row's attempt failed
    Failed(String),
    /// the web stopped before it (an earlier row of the group did not finish)
    NotAttempted,
}

#[derive(serde::Deserialize)]
struct BatchAnswer {
    results: Vec<BatchRow>,
}
#[derive(serde::Deserialize)]
struct BatchRow {
    id: String,
    status: String,
    #[serde(default)]
    error: Option<String>,
}

/// One `{ids}` request. Err = no usable answer (transport, non-200, unparseable): the caller cannot know which rows ran.
pub async fn deliver_batch(client: &reqwest::Client, cfg: &DispatcherConfig, ids: &[String]) -> Result<Vec<(String, RowOutcome)>, String> {
    let started = std::time::Instant::now();
    let response = client
        .post(&cfg.url)
        .bearer_auth(&cfg.secret)
        .json(&serde_json::json!({ "ids": ids }))
        .timeout(HTTP_TIMEOUT)
        .send()
        .await;
    DELIVERIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let result = match response {
        Ok(r) if r.status() == reqwest::StatusCode::OK => match r.json::<BatchAnswer>().await {
            Ok(a) => Ok(a
                .results
                .into_iter()
                .map(|row| {
                    let outcome = match row.status.as_str() {
                        "done" | "gone" => RowOutcome::Settled,
                        "busy" => RowOutcome::Busy,
                        "not_attempted" => RowOutcome::NotAttempted,
                        other => RowOutcome::Failed(format!("{other}: {}", row.error.unwrap_or_default())),
                    };
                    (row.id, outcome)
                })
                .collect()),
            Err(err) => Err(format!("unreadable batch answer: {err}")),
        },
        Ok(r) => {
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            Err(format!("HTTP {}: {}", status.as_u16(), body.chars().take(500).collect::<String>()))
        }
        Err(err) => Err(format!("no answer: {err}")),
    };
    DELIVERY_MICROS.fetch_add(started.elapsed().as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
    result
}

/// Delivers one conflict group in order, batch by batch, and stops at the first row that did not finish. Only that
/// row's attempt is counted (record_failure); rows after it are not touched and go out again on a later drain.
async fn deliver_group(pool: &PgPool, client: &reqwest::Client, cfg: &DispatcherConfig, ids: Vec<String>) -> Result<DrainStats, sqlx::Error> {
    let mut stats = DrainStats::default();
    let fail = |stats: &mut DrainStats, outcome: FailureOutcome| {
        stats.failed += 1;
        if outcome == FailureOutcome::Dead {
            stats.dead += 1;
        }
    };
    if cfg.batch == 0 {
        // the single `{id}` form, one row at a time, still stopping at the first failure
        for id in ids {
            match deliver(client, cfg, &id).await {
                Delivery::Settled => stats.delivered += 1,
                Delivery::Failed(error) => {
                    tracing::warn!(id, %error, "post-close outbox delivery failed");
                    let outcome = record_failure(pool, &id, &error).await?;
                    fail(&mut stats, outcome);
                    break;
                }
            }
        }
        return Ok(stats);
    }
    for chunk in ids.chunks(cfg.batch.max(1)) {
        match deliver_batch(client, cfg, chunk).await {
            Ok(answers) => {
                let mut stop = false;
                for (id, outcome) in answers {
                    match outcome {
                        RowOutcome::Settled => stats.delivered += 1,
                        RowOutcome::Busy | RowOutcome::NotAttempted => stop = true,
                        RowOutcome::Failed(error) => {
                            tracing::warn!(id, %error, "post-close outbox row failed");
                            let outcome = record_failure(pool, &id, &error).await?;
                            fail(&mut stats, outcome);
                            stop = true;
                        }
                    }
                }
                if stop {
                    break;
                }
            }
            Err(error) => {
                // no usable answer: some rows may have run. The first one still PENDING carries the attempt; rows
                // already DONE are finished, the rest simply go out again (their step markers make that harmless).
                tracing::warn!(%error, rows = chunk.len(), "post-close outbox batch failed");
                let pending: Vec<(String,)> = sqlx::query_as(r#"SELECT id FROM "PostCloseEffect" WHERE id = ANY($1) AND status = 'PENDING'"#)
                    .bind(chunk)
                    .fetch_all(pool)
                    .await?;
                if let Some(first) = chunk.iter().find(|id| pending.iter().any(|(p,)| p == *id)) {
                    let outcome = record_failure(pool, first, &error).await?;
                    fail(&mut stats, outcome);
                }
                stats.delivered += chunk.len() - pending.len();
                break;
            }
        }
    }
    Ok(stats)
}

/// Stage 4.6: delivers what is due, as conflict groups -- in parallel across groups (cfg.parallel), strictly in order
/// within one. A group whose first row is not due (backing off, or held by another run) waits as a whole, so no row
/// ever overtakes an earlier one touching the same account (a single failed row used to let later rows through).
pub async fn drain_once(pool: &PgPool, client: &reqwest::Client, cfg: &DispatcherConfig) -> Result<DrainStats, sqlx::Error> {
    let rows = queued_rows(pool, WINDOW).await?;
    let mut work: Vec<Vec<String>> = Vec::new();
    for group in conflict_groups(&rows) {
        // the group from its head up to the first row that is not due
        let ready: Vec<String> = group.iter().map_while(|&i| rows[i].due.then(|| rows[i].id.clone())).collect();
        if !ready.is_empty() {
            work.push(ready);
        }
    }
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.parallel.max(1)));
    let mut tasks = tokio::task::JoinSet::new();
    for ids in work {
        let (pool, client, cfg, permit) = (pool.clone(), client.clone(), cfg.clone(), semaphore.clone());
        tasks.spawn(async move {
            let _permit = permit.acquire_owned().await;
            deliver_group(&pool, &client, &cfg, ids).await
        });
    }
    let mut stats = DrainStats::default();
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Ok(s)) => {
                stats.delivered += s.delivered;
                stats.failed += s.failed;
                stats.dead += s.dead;
            }
            Ok(Err(err)) => return Err(err),
            Err(err) => tracing::error!(?err, "post-close outbox: a group task panicked"),
        }
    }
    Ok(stats)
}

/// Spawns the dispatcher: a drain on every wake() and every sweep interval.
pub fn spawn(pool: PgPool, cfg: DispatcherConfig) {
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        loop {
            tokio::select! {
                _ = wake_handle().notified() => {}
                _ = tokio::time::sleep(cfg.sweep_interval) => {}
            }
            if let Err(err) = drain_once(&pool, &client, &cfg).await {
                tracing::error!(?err, "post-close outbox: drain failed");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{conflict_groups, QueuedRow};

    fn row(id: &str, accounts: &[&str]) -> QueuedRow {
        QueuedRow { id: id.into(), due: true, accounts: accounts.iter().map(|a| a.to_string()).collect() }
    }

    /// shared accounts chain rows into one group (transitively), in the given order; disjoint rows stay apart
    #[test]
    fn conflict_groups_join_shared_accounts_transitively_and_keep_order() {
        let rows = vec![
            row("r0", &["c1", "M"]),
            row("r1", &["c2"]),
            row("r2", &["c3", "CV"]),
            row("r3", &["c4", "M", "CV"]), // joins r0's and r2's groups
            row("r4", &["c5"]),
            row("r5", &["c2", "X"]),
        ];
        let groups: Vec<Vec<&str>> = conflict_groups(&rows).into_iter().map(|g| g.into_iter().map(|i| rows[i].id.as_str()).collect()).collect();
        assert_eq!(groups, vec![vec!["r0", "r2", "r3"], vec!["r1", "r5"], vec!["r4"]]);
    }
}
