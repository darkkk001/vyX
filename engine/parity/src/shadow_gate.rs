//! Stage 5 scratch gate (docs/RUST-CUTOVER-PLAN.md §5.5): the engine in `Mode::Shadow` on the SAME database the
//! web is acting on (`vyx_load_web`, seeded by scripts/load/seed.ts), concurrently, then the reconciler.
//!
//!   cargo run -p parity -- --shadow-run <stop-file> <report.json>
//!
//! Shadows the book every 200 ms until <stop-file> exists (the driver creates it once run-web.ts is done), keeps
//! going 3 s more (the web's last follow-ups land), lets the reconcile window pass, then reconciles once. The gate:
//! zero VALUE / ENGINE_ONLY / WEB_ONLY. Exit code 1 otherwise, with every unexplained pair in the report.
//! The shadow store is the same scratch database (tables shadow_*), emptied at the start.

use order_management::monitor::{self, Mode, PassCursor};
use order_management::reconcile::Reconciler;
use order_management::shadow::Recorder;
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const WEB_URL: &str = "postgresql://postgres@127.0.0.1:5499/vyx_load_web";
const WINDOW_SECS: i64 = 15;
const SETTLE_SECS: i64 = 1;

pub fn main(args: &[String]) {
    let stop_file = args.first().cloned().unwrap_or_else(|| "shadow-stop".into());
    let out = args.get(1).cloned().unwrap_or_else(|| "shadow-gate-report.json".into());
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let code = rt.block_on(async move {
        match run(&stop_file, &out).await {
            Ok(unexplained) => {
                if unexplained == 0 { 0 } else { 1 }
            }
            Err(err) => {
                eprintln!("[shadow-gate] {err}");
                2
            }
        }
    });
    std::process::exit(code);
}

async fn run(stop_file: &str, out: &str) -> Result<usize, String> {
    let recorder = Arc::new(Recorder::connect(WEB_URL).await?);
    let pool = recorder.store().unwrap().clone();
    let (db, port): (String, i32) = sqlx::query_as("SELECT current_database()::text, inet_server_port()").fetch_one(&pool).await.map_err(|e| e.to_string())?;
    if db != "vyx_load_web" || port != 5499 {
        return Err(format!("connected to {db}:{port}, expected vyx_load_web:5499 -- refusing"));
    }
    // Stage 5 guard 1, exercised for real: the shadow reads the book through a READ-ONLY role (the same check the
    // server makes at startup), so a write -- or a row lock -- anywhere on the shadow path fails this gate.
    let ro_url = std::env::var("VYX_SHADOW_DATABASE_URL").unwrap_or_else(|_| "postgresql://vyx_shadow_ro@127.0.0.1:5499/vyx_load_web".into());
    let book = order_management::shadow::connect_read_only_book(Some(&ro_url), WEB_URL).await?;
    let reconciler = Reconciler::new(book.clone(), recorder.clone()).await?.with_timing(WINDOW_SECS, SETTLE_SECS);
    for t in ["shadow_pair", "shadow_decision", "shadow_state", "shadow_daily"] {
        sqlx::query(&format!("DELETE FROM {t}")).execute(&pool).await.map_err(|e| e.to_string())?;
    }
    // the web cursor starts before anything this run books
    reconciler.run_once().await.map_err(|e| e.to_string())?;
    println!("[shadow-gate] shadow ready");

    let mode = Mode::Shadow(recorder.clone());
    let mut cursor = PassCursor::default();
    let started = Instant::now();
    let mut passes = 0usize;
    let mut stop_seen: Option<Instant> = None;
    loop {
        monitor::run_pass_mode(&book, None, &mut cursor, &mode).await;
        passes += 1;
        if stop_seen.is_none() && std::path::Path::new(stop_file).exists() {
            stop_seen = Some(Instant::now());
        }
        if stop_seen.is_some_and(|t| t.elapsed() > Duration::from_secs(3)) || started.elapsed() > Duration::from_secs(600) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // every shadow decision older than the window can now be judged one-sided or not
    tokio::time::sleep(Duration::from_secs((WINDOW_SECS + SETTLE_SECS + 6) as u64)).await;
    reconciler.run_once().await.map_err(|e| e.to_string())?;
    reconciler.run_once().await.map_err(|e| e.to_string())?;

    let counts: Vec<(String, i64)> = sqlx::query_as("SELECT class, count(*) FROM shadow_pair GROUP BY class ORDER BY class").fetch_all(&pool).await.map_err(|e| e.to_string())?;
    #[allow(clippy::type_complexity)]
    let bad: Vec<(String, String, String, Option<String>, Option<i64>, serde_json::Value)> = sqlx::query_as(
        "SELECT class, kind, account_id, position_id, skew_ms, detail FROM shadow_pair WHERE class IN ('VALUE','ENGINE_ONLY','WEB_ONLY') ORDER BY account_id",
    )
    .fetch_all(&pool).await.map_err(|e| e.to_string())?;
    let (decisions,): (i64,) = sqlx::query_as("SELECT count(*) FROM shadow_decision").fetch_one(&pool).await.map_err(|e| e.to_string())?;
    let (web_risk_closes,): (i64,) = sqlx::query_as(
        r#"SELECT count(*) FROM "Transaction" WHERE type = 'TRADE_PNL' AND (note LIKE 'Stop loss hit (automatic)%' OR note LIKE 'Take profit hit (automatic)%' OR note LIKE 'Stop-out (automatic)%')"#,
    )
    .fetch_one(&pool).await.map_err(|e| e.to_string())?;
    let report = json!({
        "passes": passes,
        "shadowDecisions": decisions,
        "webRiskCloses": web_risk_closes,
        "counts": counts.iter().map(|(c, n)| (c.clone(), json!(n))).collect::<serde_json::Map<_, _>>(),
        "unexplained": bad.iter().map(|(c, k, a, p, s, d)| json!({ "class": c, "kind": k, "account": a, "position": p, "skewMs": s, "detail": d })).collect::<Vec<_>>(),
    });
    std::fs::write(out, serde_json::to_string_pretty(&report).unwrap() + "\n").map_err(|e| e.to_string())?;
    println!("[shadow-gate] passes={passes} decisions={decisions} webRiskCloses={web_risk_closes} counts={} unexplained={}", report["counts"], bad.len());
    for (c, k, a, p, s, d) in &bad {
        println!("[shadow-gate] UNEXPLAINED {c} {k} account={a} position={p:?} skew={s:?} {d}");
    }
    Ok(bad.len())
}
