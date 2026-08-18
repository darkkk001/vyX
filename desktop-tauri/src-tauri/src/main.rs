// VyXTrader Tauri desktop shell -- see docs/decisions.md ADR-001 for the
// full feature-by-feature history. Same "no local server or database
// here, it only points at the already-deployed site" principle as
// desktop/README.md's Electron app -- this app has no local frontend of
// its own beyond the splash/offline screens, the main window is built
// programmatically pointing at the broker's real deployed WebTrader.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Deserialize)]
struct BrokerConfig {
    #[serde(rename = "brokerName")]
    broker_name: String,
    subdomain: String,
    // Only meaningful in "launcher" mode (root-domain broker picker) --
    // see start_url_for() below. Unused in "broker" mode, the only mode
    // any committed broker.config.json actually ships with today.
    #[serde(rename = "rootDomain")]
    root_domain: String,
    mode: String,
}

// Direct port of desktop/main.js's getRememberedBroker()/
// setRememberedBroker()/clearRememberedBroker(), using Tauri's
// app_data_dir() in place of Electron's app.getPath("userData"). Only
// meaningful in launcher mode -- a single-broker build always has
// exactly one broker anyway, so nothing to remember.
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
    // Non-fatal on failure -- worst case the picker shows again next
    // launch, same reasoning as desktop/main.js's own try/catch here.
    let _ = std::fs::write(&path, serde_json::json!({ "hostname": hostname }).to_string());
}

fn clear_remembered_broker(app: &tauri::AppHandle) {
    if let Ok(path) = remembered_broker_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

// Direct port of desktop/main.js's startUrlFor(): broker mode always
// goes straight to that one broker's /trade (today's only real-world
// mode); launcher mode goes to the remembered broker's /trade if one
// exists, else the root domain's /launch picker page (app/launch/page.tsx).
// Direct port of desktop/main.js's `allowedHost`: in launcher mode
// navigation must be allowed to roam across broker subdomains (that's
// the whole point of the picker); in broker mode it stays locked to
// that one broker's own subdomain.
fn allowed_host_for(config: &BrokerConfig) -> &str {
    if config.mode == "launcher" {
        &config.root_domain
    } else {
        &config.subdomain
    }
}

fn start_url_for(config: &BrokerConfig, app: &tauri::AppHandle) -> String {
    if config.mode != "launcher" {
        return format!("https://{}/trade", config.subdomain);
    }
    match read_remembered_broker(app) {
        Some(hostname) => format!("https://{hostname}/trade"),
        None => format!("https://{}/launch", config.root_domain),
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
        // dir rather than escaping the resource root, which meant this
        // config was never actually reachable in any real installed
        // build, including the already-shipped release).
        .unwrap_or_else(|| std::path::PathBuf::from("broker.config.json"));

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

// Direct equivalent of desktop/main.js's auth:remember-broker/
// auth:forget-broker IPC handlers -- called from the init script's
// window.vyxDesktop bridge, which the web app already calls
// unconditionally on login/logout regardless of desktop shell.
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

// Managed app state holding the real broker/launcher URL start_url_for()
// computed at startup -- retry_connection (below) needs it and has no
// other way to reach it, since it's otherwise local to main()'s setup
// closure.
struct StartUrl(String);

// Tauri's PageLoadEvent only has Started/Finished -- no failure/error
// variant exists (confirmed against the installed tauri crate source),
// so unlike Electron's did-fail-load this can't react to a failed
// navigation after the fact. Instead it checks proactively: a short HEAD
// request decides whether to navigate to the real app or the local
// offline page, both at startup and on every Retry click. The real app
// path (/trade) 307-redirects rather than 200s directly (confirmed via
// this session's own earlier dev-server testing), so redirects count as
// reachable too, not just a bare 200.
async fn is_reachable(url: &str) -> bool {
    reqwest::Client::new()
        .head(url)
        // 15s, not a tight few seconds -- a real deployment is normally
        // fast, but this also has to tolerate a genuinely slow first
        // response without false-negativing into the offline page (hit
        // this exact failure mode while verifying: a local dev server's
        // cold first-compile took ~12s for a single route, which a
        // tighter timeout misread as "unreachable").
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map(|res| res.status().is_success() || res.status().is_redirection())
        .unwrap_or(false)
}

// Invoked by offline.html's Retry button. Re-runs the same reachability
// check and only navigates away from the offline page if it now
// succeeds -- if still unreachable, the offline page just stays put
// (its own button re-enables itself once the invoke's promise settles).
#[tauri::command]
async fn retry_connection(app: tauri::AppHandle) {
    let start_url = app.state::<StartUrl>().0.clone();
    if is_reachable(&start_url).await {
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(url) = start_url.parse() {
                let _ = window.navigate(url);
            }
        }
    }
}

// Direct port of desktop/main.js's entire auto-update surface: check,
// silently download+install if found, notify once on success. No
// "Check for Updates" UI, no forced relaunch -- the update applies on
// the app's next natural restart, matching electron-updater's own
// checkForUpdatesAndNotify() behavior exactly rather than inventing new
// UX Electron doesn't have. Any failure (no update feed reachable, no
// update available, download/signature-verification failure) is
// swallowed by the caller -- same as Electron's own
// `.catch(() => { /* not fatal, app already runs */ })`.
// Only called from the #[cfg(not(debug_assertions))] block in .setup()
// below -- unused (by design) in debug builds, same reasoning as the
// #[allow(dead_code)] on BrokerConfig's root_domain/mode fields above.
#[cfg_attr(debug_assertions, allow(dead_code))]
async fn check_for_updates(
    app: tauri::AppHandle,
    broker_name: String,
) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
        let _ = app
            .notification()
            .builder()
            .title(&broker_name)
            .body("A new version has been downloaded. Restart to apply it.")
            .show();
    }
    Ok(())
}

// Injected before every page load (including the remote broker page --
// this app bundles no local frontend JS of its own) so window.vyxDesktop
// exists with EXACTLY the shape WebTrader.tsx/DesktopTitleBar.tsx already
// expect -- see their `declare global { interface Window { vyxDesktop?
// {...} } }`. Matching that shape exactly means zero changes to the web
// app; it doesn't know or care which desktop shell it's running in, only
// whether window.vyxDesktop exists. rememberBroker/forgetBroker invoke
// the remember_broker/forget_broker commands above -- real no-ops in
// broker mode in practice (nothing reads the file start_url_for()
// doesn't already ignore), real persistence in launcher mode.
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
    rememberBroker: function (hostname) { window.__TAURI__.core.invoke("remember_broker", { hostname: hostname }); },
    forgetBroker: function () { window.__TAURI__.core.invoke("forget_broker"); },
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        // Direct equivalent of desktop/main.js's electron-window-state
        // usage -- restores x/y/width/height/maximized on the next
        // launch, auto-saves on move/resize/close. Needs no other
        // wiring: it hooks on_window_ready for every window, including
        // ours built programmatically below, not just ones declared in
        // tauri.conf.json.
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            win_minimize,
            win_toggle_maximize,
            win_close,
            remember_broker,
            forget_broker,
            retry_connection
        ])
        .setup(move |app| {
            // Same hardcoded https:// scheme as desktop/main.js's own
            // brokerUrl/launchUrl construction -- this app only ever
            // points at a real deployed broker, never a local dev server.
            let start_url = start_url_for(&config, app.handle());
            app.manage(StartUrl(start_url.clone()));
            // Direct port of desktop/main.js's allowedHost.split(":")[0]
            // comparison -- config values in this codebase sometimes
            // carry an explicit port (local dev testing), so the host
            // check ignores it exactly like the Electron reference does.
            let allowed_host = allowed_host_for(&config).split(':').next().unwrap_or("").to_string();
            let nav_app_handle = app.handle().clone();
            let new_window_app_handle = app.handle().clone();
            // Splash first (instant, local) -- swapped to the real
            // remote URL (or offline.html) below once a reachability
            // check settles, exactly mirroring desktop/main.js's own
            // win.loadFile(loadingPath) + delayed win.loadURL(...).
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("splash.html".into()))
                .title(&config.broker_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                // Frameless -- matches desktop/main.js's `frame: false`.
                // WebTrader renders its own title bar (DesktopTitleBar.tsx)
                // once it detects window.vyxDesktop.isDesktop.
                .decorations(false)
                // Direct port of desktop/main.js's will-navigate handler:
                // in-place navigation outside the broker's own domain (or,
                // in launcher mode, the root domain) opens in the OS
                // browser instead of following it inside the app. Local
                // asset pages (splash/offline) are always allowed --
                // Tauri's local content is served either from a `tauri://`
                // scheme or, on Windows/Android, `http://tauri.localhost`
                // (a fixed hostname, not configurable per-app), mirroring
                // Electron's own `if (url.startsWith("file://")) return`.
                .on_navigation(move |url| {
                    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
                        return true;
                    }
                    if url.scheme() != "http" && url.scheme() != "https" {
                        return true;
                    }
                    let host = url.host_str().unwrap_or("");
                    if host == allowed_host || host.ends_with(&format!(".{allowed_host}")) {
                        true
                    } else {
                        let _ = nav_app_handle.opener().open_url(url.to_string(), None::<&str>);
                        false
                    }
                })
                // Direct port of desktop/main.js's setWindowOpenHandler:
                // any window.open()/target="_blank" opens in the OS
                // browser instead of inside the app.
                .on_new_window(move |url, _features| {
                    let _ = new_window_app_handle.opener().open_url(url.to_string(), None::<&str>);
                    tauri::webview::NewWindowResponse::Deny
                })
                .initialization_script(VYX_DESKTOP_INIT_SCRIPT)
                .build()?;

            // Reachability check decides whether to swap the splash
            // screen to the real broker URL or to offline.html -- see
            // is_reachable()'s own comment for why this is proactive
            // instead of reactive like Electron's did-fail-load.
            // offline.html's URL uses Tauri's local-content origin
            // directly (confirmed empirically while verifying this --
            // on_navigation's own log showed the splash page's real,
            // actual URL as `http://tauri.localhost/splash.html` -- NOT
            // derived from window.url() right after .build(), which was
            // separately observed to report a stale "about:blank" for a
            // window's first several seconds regardless of scheme,
            // local/external/data:, so it can't be used as a live
            // signal here). This project only ships a Windows build
            // (`bundle.targets`/`win`-only, matching the Electron
            // reference's own `electron-builder --win`), so this fixed
            // hostname doesn't need to handle other platforms' `tauri://`
            // convention.
            {
                let check_window = window.clone();
                let target_url = start_url.clone();
                let offline_url: tauri::Url = "http://tauri.localhost/offline.html".parse()?;
                tauri::async_runtime::spawn(async move {
                    let url_to_load = if is_reachable(&target_url).await {
                        target_url.parse().ok()
                    } else {
                        Some(offline_url)
                    };
                    if let Some(url) = url_to_load {
                        let _ = check_window.navigate(url);
                    }
                });
            }

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

            // Same gate as Electron's `if (app.isPackaged)` -- only check
            // for updates in a real release build, never in `tauri dev`/
            // debug builds pointed at a local broker.
            #[cfg(not(debug_assertions))]
            {
                let update_handle = app.handle().clone();
                let update_broker_name = broker_name.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = check_for_updates(update_handle, update_broker_name).await;
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vyxtrader-desktop-tauri");
}
