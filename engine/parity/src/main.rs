//! `cargo run -p parity [-- <scenario-name-filter>]` -- evaluates every
//! engine/parity/scenarios/*.json with the engine's own code (no DB) and writes
//! engine/parity/out/rust/<scenario>.json. See ../README.md.

use parity::{evaluate, Scenario};
use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let scenario_dir = root.join("scenarios");
    let out_dir = root.join("out").join("rust");
    std::fs::create_dir_all(&out_dir).expect("create out/rust");
    let filter = std::env::args().nth(1);

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
        let out = evaluate(&sc);
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
