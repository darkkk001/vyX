// VyXTrader Admin desktop shell -- core-shell slice only. Wraps Super
// Admin's login (app/(super-admin)/, fixed admin.<rootDomain>
// subdomain -- middleware.ts's SUPER_ADMIN_SUBDOMAIN, not broker-scoped
// at all) in a native window. Deliberately a separate app/project from
// desktop-tauri/ (Client/Trading terminal) and manager-tauri/ (Broker
// Admin + Manager), per explicit project decision -- not a shared
// codebase, so some scaffolding here intentionally mirrors those rather
// than importing them.
//
// Decorated (OS-native title bar), not frameless: app/(super-admin)/
// has no custom title-bar component today, so going frameless would
// need new web-app UI work first -- explicitly deferred, named in
// package.json's own description. A decorated window still gets real
// minimize/maximize/close for free from the OS, no custom Tauri
// commands needed for that.
//
// Still deferred (see package.json): system tray, native notifications,
// auto-update, window-state persistence, navigation lockdown,
// splash/offline screens, a custom frameless title bar.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Deserialize)]
struct AppConfig {
    #[serde(rename = "appName")]
    app_name: String,
    #[serde(rename = "rootDomain")]
    root_domain: String,
}

fn load_app_config() -> AppConfig {
    let path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("app.config.json")))
        .filter(|p| p.exists())
        // Dev mode: the exe lives under target/debug, config lives at
        // the project root next to package.json -- same relative-path
        // fallback desktop-tauri/'s own loader uses.
        .unwrap_or_else(|| std::path::PathBuf::from("../app.config.json"));

    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read app.config.json at {path:?}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("invalid app.config.json: {e}"))
}

fn main() {
    let config = load_app_config();
    // Fixed "admin" subdomain -- middleware.ts's SUPER_ADMIN_SUBDOMAIN,
    // not configurable per-install the way a broker's Manager app is,
    // since there is exactly one Super Admin surface for the whole
    // platform.
    let admin_url = format!("https://admin.{}/login", config.root_domain);

    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(admin_url.parse().unwrap()))
                .title(&config.app_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vyxtrader-admin-tauri");
}
