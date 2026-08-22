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
// close for free from the OS, no custom Tauri commands needed for that
// -- window.vyxDesktop below exposes only isDesktop/rememberBroker/
// forgetBroker, not the window-control methods desktop-tauri's own
// bridge has (see types/vyx-desktop.d.ts: every field but isDesktop is
// optional specifically so this narrower bridge still type-checks).
//
// Still deferred (see package.json): system tray, native notifications,
// auto-update, window-state persistence, navigation lockdown,
// splash/offline screens, per-broker rebrand tooling, a custom
// frameless title bar.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Deserialize)]
struct BrokerConfig {
    #[serde(rename = "brokerName")]
    broker_name: String,
    // Only meaningful in "broker" mode -- ignored in "launcher" mode
    // (today's committed config), same split as desktop-tauri's own
    // BrokerConfig/start_url_for.
    subdomain: String,
    // Only meaningful in "launcher" mode -- see start_url_for() below.
    #[serde(rename = "rootDomain")]
    root_domain: String,
    mode: String,
}

// Direct port of desktop-tauri/src-tauri/src/main.rs's own
// remembered_broker_path/read_remembered_broker/write_remembered_broker
// -- kept in its own app_data_dir() rather than shared with that app
// (separate project, separate install, per this file's own top comment).
fn remembered_broker_path(app: &tauri::AppHandle) -> tauri::Result<std::path::PathBuf> {
    Ok(app.path().app_data_dir()?.join("remembered-broker.json"))
}

fn read_remembered_broker(app: &tauri::AppHandle) -> Option<String> {
    let path = remembered_broker_path(app).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get("hostname")?.as_str().map(|s| s.to_string())
}

fn write_remembered_broker(app: &tauri::AppHandle, hostname: &str) {
    let Ok(path) = remembered_broker_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, serde_json::json!({ "hostname": hostname }).to_string());
}

fn clear_remembered_broker(app: &tauri::AppHandle) {
    if let Ok(path) = remembered_broker_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

// Direct port of desktop-tauri's start_url_for(), pointed at /manage/login
// instead of /trade: broker mode always goes straight to that one
// broker's own backoffice login (unchanged behavior for a future
// per-broker build); launcher mode -- today's actual committed config --
// goes to the remembered broker's /manage/login if one exists, else the
// root domain's /manage-launch picker page (app/manage-launch/page.tsx).
fn start_url_for(config: &BrokerConfig, app: &tauri::AppHandle) -> String {
    if config.mode != "launcher" {
        return format!("https://{}/manage/login", config.subdomain);
    }
    match read_remembered_broker(app) {
        Some(hostname) => format!("https://{hostname}/manage/login"),
        None => format!("https://{}/manage-launch", config.root_domain),
    }
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

#[tauri::command]
fn remember_broker(app: tauri::AppHandle, hostname: String) {
    if !hostname.is_empty() {
        write_remembered_broker(&app, &hostname);
    }
}

#[tauri::command]
fn forget_broker(app: tauri::AppHandle) {
    clear_remembered_broker(&app);
}

// Injected before every page load, same principle as desktop-tauri's own
// VYX_DESKTOP_INIT_SCRIPT -- narrower shape (no minimize/toggleMaximize/
// close/onMaximizedChange) since this window is OS-decorated, not
// frameless, so the app/manage-launch picker page has something to check
// (window.vyxDesktop?.isDesktop) and call (rememberBroker/forgetBroker)
// without needing to know which shell it's running in.
const VYX_DESKTOP_INIT_SCRIPT: &str = r#"
(function () {
  window.vyxDesktop = {
    isDesktop: true,
    rememberBroker: function (hostname) { window.__TAURI__.core.invoke("remember_broker", { hostname: hostname }); },
    forgetBroker: function () { window.__TAURI__.core.invoke("forget_broker"); },
  };
})();
"#;

fn main() {
    let config = load_broker_config();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![remember_broker, forget_broker])
        .setup(move |app| {
            let manage_url = start_url_for(&config, app.handle());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(manage_url.parse().unwrap()))
                .title(&config.broker_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                .initialization_script(VYX_DESKTOP_INIT_SCRIPT)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vyxtrader-manager-tauri");
}
