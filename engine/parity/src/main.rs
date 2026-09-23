//! `cargo run -p parity [-- <scenario-name-filter>]` -- evaluates every
//! engine/parity/scenarios/*.json with the engine's own code (no DB) and writes
//! engine/parity/out/rust/<scenario>.json. See ../README.md.

use parity::{evaluate, Scenario};
use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let scenario_dir = root.join("scenarios");
    // `-- --db <scenario>`: Stage 1 DB mode (see db_mode.rs); otherwise the pure-calc Stage 0 run
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `-- --evaluate-accounts <id,id,...>`: Stage 3 gate (lib/post-close.test.ts) -- one real monitor pass per
    // account on whatever the caller seeded into the harness DB; the closes and their outbox rows stay behind.
    if args.first().map(String::as_str) == Some("--evaluate-accounts") {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let pool = rt.block_on(parity::db_mode::connect()).unwrap_or_else(|e| {
            eprintln!("[parity:evaluate] {e}");
            std::process::exit(2)
        });
        for id in args.get(1).map(String::as_str).unwrap_or("").split(',').filter(|s| !s.is_empty()) {
            match rt.block_on(order_management::monitor::evaluate_account(&pool, None, id)) {
                Ok(report) => println!("[parity:evaluate] {id}: {report:?}"),
                Err(e) => {
                    eprintln!("[parity:evaluate] {id}: {e}");
                    std::process::exit(1)
                }
            }
        }
        return;
    }
    let db_mode = args.first().map(String::as_str) == Some("--db");
    let filter = if db_mode { args.get(1).cloned() } else { args.first().cloned() };
    let out_dir = root.join("out").join(if db_mode { "rust-db" } else { "rust" });
    std::fs::create_dir_all(&out_dir).expect("create out dir");
    let runtime = db_mode.then(|| tokio::runtime::Runtime::new().expect("tokio runtime"));
    let pool = runtime.as_ref().map(|rt| rt.block_on(parity::db_mode::connect()).unwrap_or_else(|e| {
        eprintln!("[parity:rust-db] {e}");
        std::process::exit(2)
    }));

    let mut paths: Vec<PathBuf> = std::fs::read_dir(&scenario_dir)
        .expect("read scenarios dir")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter(|p| filter.as_deref().is_none_or(|f| p.file_name().unwrap().to_string_lossy().contains(f)))
        .collect();
    paths.sort();

    let mut failed = false;
    for path in &paths {
        let text = std::fs::read_to_string(path).expect("read scenario");
        let sc = match Scenario::from_json(&text) {
            Ok(sc) => sc,
            Err(e) => {
                eprintln!("[parity:rust] {}: {e}", path.display());
                failed = true;
                continue;
            }
        };
        let out = match (&runtime, &pool) {
            (Some(rt), Some(pool)) => match rt.block_on(parity::db_mode::evaluate(pool, &sc)) {
                Ok(accounts) => parity::ScenarioOutcome { scenario: sc.name.clone(), engine: "rust-db", accounts },
                Err(e) => {
                    eprintln!("[parity:rust-db] {e}");
                    failed = true;
                    continue;
                }
            },
            _ => evaluate(&sc),
        };
        let summary: Vec<String> = out
            .accounts
            .iter()
            .map(|(k, v)| format!("{k} closed=[{}] balance={} mc={}", v.closed_position_ids.join(","), v.final_balance, v.margin_call_notified))
            .collect();
        println!("[parity:rust] {}: {}", sc.name, summary.join("; "));
        let json = serde_json::to_string_pretty(&out).expect("serialize") + "\n";
        std::fs::write(out_dir.join(format!("{}.json", sc.name)), json).expect("write output");
    }
    println!("[parity:rust] {} scenario(s) written to {}", paths.len(), out_dir.display());
    if failed {
        std::process::exit(1);
    }
}
