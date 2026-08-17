// VyXTrader Tauri desktop shell -- core-shell slice only, see
// docs/decisions.md ADR-001 and this repo's CLAUDE.md for exactly what's
// deferred (tray, notifications, auto-update, per-broker rebrand CLI,
// remembered-broker persistence, navigation lockdown, splash/offline
// screens, window-state persistence). Same "no local server or database
// here, it only points at the already-deployed site" principle as
// desktop/README.md's Electron app -- this app has no local frontend of
// its own, the window is built programmatically pointing at the broker's
// real deployed WebTrader.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::sync::Mutex;
use tauri::{Emitter, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[derive(Debug, Deserialize)]
struct BrokerConfig {
    #[serde(rename = "brokerName")]
    broker_name: String,
    subdomain: String,
    // rootDomain/mode are read but unused in this slice -- launcher mode
    // (root-domain server picker) is explicitly deferred, single-broker
    // mode only for now. Kept in the struct so the config file's full
    // shape stays stable for when launcher mode is picked up.
    #[allow(dead_code)]
    #[serde(rename = "rootDomain")]
    root_domain: String,
    #[allow(dead_code)]
    mode: String,
}

fn load_broker_config() -> BrokerConfig {
    let path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("broker.config.json")))
        .filter(|p| p.exists())
        // Dev mode: the exe lives under target/debug, config lives at the
        // project root next to package.json -- same relative-path
        // resolution problem Electron's `path.join(__dirname, ...)`
        // doesn't have to solve since it isn't a compiled binary.
        .unwrap_or_else(|| std::path::PathBuf::from("../broker.config.json"));

    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read broker.config.json at {path:?}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("invalid broker.config.json: {e}"))
}

// The direct equivalent of desktop/main.js's three `ipcMain.on("win:...")`
// handlers -- called from the js_init_script's window.vyxDesktop bridge
// below via `window.__TAURI__.core.invoke(...)`.
#[tauri::command]
fn win_minimize(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_toggle_maximize(window: tauri::Window) {
    match window.is_maximized() {
        Ok(true) => {
            let _ = window.unmaximize();
        }
        _ => {
            let _ = window.maximize();
        }
    }
}

#[tauri::command]
fn win_close(window: tauri::Window) {
    let _ = window.close();
}

// Injected before every page load (including the remote broker page --
// this app bundles no local frontend JS of its own) so window.vyxDesktop
// exists with EXACTLY the shape WebTrader.tsx/DesktopTitleBar.tsx already
// expect -- see their `declare global { interface Window { vyxDesktop?
// {...} } }`. Matching that shape exactly means zero changes to the web
// app; it doesn't know or care which desktop shell it's running in, only
// whether window.vyxDesktop exists. rememberBroker/forgetBroker are
// no-op stubs here -- launcher mode (the only mode that actually needs
// them) is deferred, but the web app calls them unconditionally in
// desktop mode, so they must exist rather than being undefined.
const VYX_DESKTOP_INIT_SCRIPT: &str = r#"
(function () {
  window.vyxDesktop = {
    isDesktop: true,
    minimize: function () { window.__TAURI__.core.invoke("win_minimize"); },
    toggleMaximize: function () { window.__TAURI__.core.invoke("win_toggle_maximize"); },
    close: function () { window.__TAURI__.core.invoke("win_close"); },
    onMaximizedChange: function (callback) {
      var unlistenPromise = window.__TAURI__.event.listen("maximized-changed", function (event) {
        callback(event.payload);
      });
      return function () {
        unlistenPromise.then(function (unlisten) { unlisten(); });
      };
    },
    rememberBroker: function () {},
    forgetBroker: function () {},
  };
})();
"#;

fn main() {
    let config = load_broker_config();
    // Same hardcoded https:// scheme as desktop/main.js's own
    // brokerUrl/launchUrl construction -- this app only ever points at a
    // real deployed broker, never a local dev server.
    let broker_url = format!("https://{}/trade", config.subdomain);

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![win_minimize, win_toggle_maximize, win_close])
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(broker_url.parse().unwrap()))
                .title(&config.broker_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                // Frameless -- matches desktop/main.js's `frame: false`.
                // WebTrader renders its own title bar (DesktopTitleBar.tsx)
                // once it detects window.vyxDesktop.isDesktop.
                .decorations(false)
                .initialization_script(VYX_DESKTOP_INIT_SCRIPT)
                .build()?;

            // Mirrors desktop/main.js's win.on("maximize"/"unmaximize", ...)
            // -> win:maximized-changed push. Tauri 2 has no single portable
            // "maximized changed" event, so this diffs is_maximized() across
            // Resized events and only emits when it actually flips.
            let last_maximized = Mutex::new(window.is_maximized().unwrap_or(false));
            let emit_window = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Resized(_) = event {
                    if let Ok(is_max) = emit_window.is_maximized() {
                        let mut last = last_maximized.lock().unwrap();
                        if *last != is_max {
                            *last = is_max;
                            let _ = emit_window.emit("maximized-changed", is_max);
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vyxtrader-desktop-tauri");
}
