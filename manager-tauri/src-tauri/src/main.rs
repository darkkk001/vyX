// VyXTrader Manager desktop shell -- core-shell slice only. Wraps a
// broker's own /manage login (app/manage/, Broker Admin + Manager
// roles) in a native window. Deliberately a separate app/project from
// desktop-tauri/ (Client/Trading terminal) and admin-tauri/ (Super
// Admin), per explicit project decision -- not a shared codebase, so
// some scaffolding here intentionally mirrors desktop-tauri/ rather
// than importing it.
//
// Decorated (OS-native title bar), not frameless: app/manage/ has no
// custom title-bar component today (unlike WebTrader's
// DesktopTitleBar.tsx), so going frameless would need new web-app UI
// work first -- explicitly deferred, named in package.json's own
// description. A decorated window still gets real minimize/maximize/
// close for free from the OS, no custom Tauri commands needed for that.
//
// Still deferred (see package.json): system tray, native notifications,
// auto-update, window-state persistence, navigation lockdown,
// splash/offline screens, per-broker rebrand tooling, a custom
// frameless title bar.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Deserialize)]
struct BrokerConfig {
    #[serde(rename = "brokerName")]
    broker_name: String,
    subdomain: String,
}

fn load_broker_config() -> BrokerConfig {
    let path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("broker.config.json")))
        .filter(|p| p.exists())
        // Dev mode: `cargo run`/`tauri dev`'s cwd is src-tauri/, where
        // broker.config.json now lives (moved in from the project root
        // so the bundler's resources path never needs `..` -- Tauri's
        // resource bundler rewrites `..` segments to a literal `_up_`
        // dir rather than escaping the resource root, which silently
        // broke prod path resolution here).
        .unwrap_or_else(|| std::path::PathBuf::from("broker.config.json"));

    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read broker.config.json at {path:?}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("invalid broker.config.json: {e}"))
}

fn main() {
    let config = load_broker_config();
    // Same hardcoded https:// scheme as desktop-tauri/'s own
    // start_url_for -- this app only ever points at a real deployed
    // broker, never a local dev server (except temporarily, by hand,
    // during local verification).
    let manage_url = format!("https://{}/manage/login", config.subdomain);

    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(manage_url.parse().unwrap()))
                .title(&config.broker_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vyxtrader-manager-tauri");
}
