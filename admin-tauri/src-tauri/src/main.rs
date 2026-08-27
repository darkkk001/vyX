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
// window-state persistence, navigation lockdown, splash/offline
// screens, a custom frameless title bar. Auto-update is no longer on
// this list -- wired below, direct port of desktop-tauri's
// check_for_updates minus the native-notification step (that plugin
// isn't part of this app's deliberately narrower slice yet; the update
// still silently downloads and installs on next restart).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

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
        // Dev mode: `cargo run`/`tauri dev`'s cwd is src-tauri/, where
        // app.config.json now lives (moved in from the project root so
        // the bundler's resources path never needs `..` -- Tauri's
        // resource bundler rewrites `..` segments to a literal `_up_`
        // dir rather than escaping the resource root, which silently
        // broke prod path resolution here).
        .unwrap_or_else(|| std::path::PathBuf::from("app.config.json"));

    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read app.config.json at {path:?}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("invalid app.config.json: {e}"))
}

// Direct port of desktop-tauri's check_for_updates, minus the native-
// notification call (see this file's top comment). Any failure (no feed
// reachable, no update available, download/signature-verification
// failure) is swallowed by the caller -- not fatal, the app already runs.
#[cfg_attr(debug_assertions, allow(dead_code))]
async fn check_for_updates(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
    }
    Ok(())
}

fn main() {
    let config = load_app_config();
    // Fixed "admin" subdomain -- middleware.ts's SUPER_ADMIN_SUBDOMAIN,
    // not configurable per-install the way a broker's Manager app is,
    // since there is exactly one Super Admin surface for the whole
    // platform.
    let admin_url = format!("https://admin.{}/login", config.root_domain);

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(admin_url.parse().unwrap()))
                .title(&config.app_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                .build()?;

            // Same gate as desktop-tauri: only check for updates in a real
            // release build, never in `tauri dev`/debug builds.
            #[cfg(not(debug_assertions))]
            {
                let update_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = check_for_updates(update_handle).await;
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vyxtrader-admin-tauri");
}
