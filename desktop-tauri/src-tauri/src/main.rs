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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

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
//
// Also requests OS notification permission up front -- WebTrader.tsx's
// pushToast (see `if (important && ... && "Notification" in window) {
// new Notification("VyXTrader", { body: message }) }`) is written
// against the standard browser Notification API. WebView2 (Chromium)
// already implements that API natively, so **no polyfill of
// window.Notification is needed at all** -- WebTrader's call site works
// completely unchanged. Confirmed by reading tauri-plugin-notification
// 2.3.3's actual shipped JS shim (api-iife.js, the exact bundle
// `withGlobalTauri` injects as window.__TAURI__.notification): its
// isPermissionGranted/requestPermission/sendNotification all read/call
// the browser's own `window.Notification` object directly -- the plugin
// is a thin permission-plumbing layer on top of it, not a replacement.
// (An earlier version of this script *did* try to replace
// window.Notification with a wrapper that called into this same plugin
// API -- since the plugin calls back into window.Notification itself,
// that was direct infinite recursion, caught by reading the plugin's
// source before shipping it, not by a runtime crash.) The only real gap
// versus a normal browser is that a frameless kiosk-style window has no
// address-bar UI for a permission prompt, so permission is requested
// proactively here at startup instead of lazily on first toast.
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

  var notif = window.__TAURI__.notification;
  notif.isPermissionGranted().then(function (granted) {
    if (!granted) {
      notif.requestPermission();
    }
  });
})();
"#;

fn main() {
    let config = load_broker_config();
    // Same hardcoded https:// scheme as desktop/main.js's own
    // brokerUrl/launchUrl construction -- this app only ever points at a
    // real deployed broker, never a local dev server.
    let broker_url = format!("https://{}/trade", config.subdomain);
    let broker_name = config.broker_name.clone();

    // Shared between the tray menu's "Quit" handler and the window's
    // close-request handler below -- mirrors desktop/main.js's module-
    // level `isQuitting` flag exactly: closing the window normally hides
    // it instead (so background price alerts / SL-TP notifications keep
    // working), only the tray's own Quit item actually exits.
    let is_quitting = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
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

            // --- System tray -- direct port of desktop/main.js's
            // createTray()/refreshTrayMenu(), same item order: Show, sep,
            // Launch at startup (checkbox), sep, Quit.
            let autostart = app.autolaunch();
            let autostart_enabled = autostart.is_enabled().unwrap_or(false);

            let show_item = MenuItemBuilder::with_id("show", format!("Show {broker_name}")).build(app)?;
            let autostart_item =
                CheckMenuItemBuilder::with_id("autostart", "Launch at startup").checked(autostart_enabled).build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&autostart_item)
                .separator()
                .item(&quit_item)
                .build()?;

            let tray_window = window.clone();
            let tray_is_quitting = is_quitting.clone();
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("bundle.icon must be set in tauri.conf.json"))
                .tooltip(&broker_name)
                .menu(&tray_menu)
                .on_menu_event(move |app_handle, event| match event.id().as_ref() {
                    "show" => {
                        let _ = tray_window.show();
                        let _ = tray_window.set_focus();
                    }
                    "autostart" => {
                        let autostart = app_handle.autolaunch();
                        let enabled = autostart.is_enabled().unwrap_or(false);
                        let _ = if enabled { autostart.disable() } else { autostart.enable() };
                    }
                    "quit" => {
                        tray_is_quitting.store(true, Ordering::SeqCst);
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click shows the window -- matches Electron's
                    // tray.on("click", () => mainWindow?.show()).
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Single combined event handler -- Tauri's on_window_event only
            // keeps the most recently registered closure per window, so
            // both behaviors below (maximize tracking + close-to-tray) have
            // to live in one registration, not two separate calls.
            //
            // 1) Mirrors desktop/main.js's win.on("maximize"/"unmaximize",
            //    ...) -> win:maximized-changed push. Tauri 2 has no single
            //    portable "maximized changed" event, so this diffs
            //    is_maximized() across Resized events and only emits when
            //    it actually flips.
            // 2) Closing the window minimizes to tray instead of quitting --
            //    matches win.on("close", ...) exactly (see its own comment:
            //    "so background price alerts / SL-TP notifications keep
            //    working"). Only the tray's Quit item (or OS shutdown)
            //    actually exits.
            let last_maximized = Mutex::new(window.is_maximized().unwrap_or(false));
            let event_window = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Resized(_) => {
                    if let Ok(is_max) = event_window.is_maximized() {
                        let mut last = last_maximized.lock().unwrap();
                        if *last != is_max {
                            *last = is_max;
                            let _ = event_window.emit("maximized-changed", is_max);
                        }
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    if !is_quitting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = event_window.hide();
                    }
                }
                _ => {}
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vyxtrader-desktop-tauri");
}
