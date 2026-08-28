// VyXTrader Tauri desktop shell -- see docs/decisions.md ADR-001 for the
// full feature-by-feature history, and the bundled-UI architecture plan
// (2026-08) for why this file no longer loads a remote URL at all: the
// main window now shows `webtrader-shell/`'s built output (bundled at
// compile time via tauri.conf.json's frontendDist), and every API call
// that UI makes crosses the network through the api_request/
// api_request_multipart commands below -- a persistent, cookie-jar-
// backed reqwest::Client -- rather than through the WebView's own
// fetch()/WebSocket, which cannot carry the broker's httpOnly session
// cookie across the local-content / real-host origin boundary. See
// lib/trade-api.ts's isDesktop branch on the web-app side.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde::{Deserialize, Serialize};
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
    // A full host (e.g. "acmefx.vyxtrader.com" in a real rebranded
    // build -- see rebrand.js) that resolve_api_target() below turns
    // into the base URL every api_request call is made against.
    subdomain: String,
    // Only meaningful in "launcher" mode -- unused in "broker" mode, the
    // only mode any committed broker.config.json ships with today (v1 of
    // the bundled-UI architecture is broker-mode only; launcher-mode
    // bundling -- picking between multiple brokers inside one install --
    // is deferred).
    #[allow(dead_code)]
    #[serde(rename = "rootDomain")]
    root_domain: String,
    #[allow(dead_code)]
    mode: String,
    // The API Gateway's WebSocket base (e.g. "wss://feed.acmefx.vyxtrader.com")
    // -- there is no established production convention for this yet (the
    // website itself reads it from NEXT_PUBLIC_GATEWAY_WS_URL, a Next.js
    // build-time env var that isn't confirmed set anywhere), so this is a
    // new, optional broker.config.json field rather than a derived value.
    // Unset (the committed dev default) falls back to the same
    // "ws://127.0.0.1:8080" WebTrader.tsx itself falls back to -- a real
    // broker's Gateway not being configured here degrades to the 2s HTTP
    // poll exactly like it does on the website today, not a regression.
    #[serde(rename = "gatewayWsUrl", default)]
    gateway_ws_url: Option<String>,
}

// Direct port of desktop/main.js's getRememberedBroker()/
// setRememberedBroker()/clearRememberedBroker(), using Tauri's
// app_data_dir() in place of Electron's app.getPath("userData"). Only
// meaningful in launcher mode -- a single-broker build always has
// exactly one broker anyway, so nothing to remember. Kept even though
// v1 only ships broker-mode builds, so the window.vyxDesktop bridge
// shape stays identical for a future launcher-mode bundled build.
fn remembered_broker_path(app: &tauri::AppHandle) -> tauri::Result<std::path::PathBuf> {
    Ok(app.path().app_data_dir()?.join("remembered-broker.json"))
}

#[allow(dead_code)]
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

// "Remember me" -- persists the trader's session cookie (not their
// password) to disk so relaunching the app skips the login screen as
// long as the server-side session is still valid, matching the MT4/5
// convention of not re-prompting for credentials on every launch. Same
// plaintext-JSON-file pattern as remembered-broker.json above (not an OS
// keychain -- a real security tradeoff worth knowing, consistent with
// this codebase's existing risk posture for that file). Only ever
// written when the trader explicitly checks "Remember me"; a plain
// logout or an unchecked "Remember me" on a fresh login clears it.
fn session_file_path(app: &tauri::AppHandle) -> tauri::Result<std::path::PathBuf> {
    Ok(app.path().app_data_dir()?.join("session.json"))
}

fn read_saved_session(app: &tauri::AppHandle) -> Option<String> {
    let path = session_file_path(app).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get("cookie")?.as_str().map(|s| s.to_string())
}

fn write_saved_session(app: &tauri::AppHandle, cookie: &str) {
    let Ok(path) = session_file_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, serde_json::json!({ "cookie": cookie }).to_string());
}

fn clear_saved_session(app: &tauri::AppHandle) {
    if let Ok(path) = session_file_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

// Called from the login form's "Remember me" checkbox handler right
// after a successful login -- reads whatever session cookie
// capture_session_cookie already captured from that login response and
// writes it to disk.
#[tauri::command]
fn remember_session(app: tauri::AppHandle, bridge: tauri::State<'_, ApiBridge>) {
    if let Some(cookie) = bridge.session_cookie.lock().unwrap().clone() {
        write_saved_session(&app, &cookie);
    }
}

#[tauri::command]
fn forget_session(app: tauri::AppHandle) {
    clear_saved_session(&app);
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

// Resolves BrokerConfig.subdomain to (connect_base, host_header):
//   - real production build: subdomain is a real, TLS-terminated,
//     DNS-resolvable host ("acmefx.vyxtrader.com") -- both values are
//     identical, the Host header is a harmless no-op alongside TLS SNI.
//   - local dev build: subdomain carries a `.localhost` host (this
//     codebase's existing dev-testing convention, previously used by
//     is_reachable's own now-removed reachability check) -- `*.localhost`
//     doesn't actually resolve via DNS on Windows, so connect_base
//     substitutes 127.0.0.1 for the real TCP connection while
//     host_header keeps the original value so middleware.ts's Host-
//     header-based broker resolution still works.
fn resolve_api_target(config: &BrokerConfig) -> (String, String) {
    if config.subdomain.contains("localhost") {
        let port = config.subdomain.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(3000);
        (format!("http://127.0.0.1:{port}"), config.subdomain.clone())
    } else {
        (format!("https://{}", config.subdomain), config.subdomain.clone())
    }
}

// The trader session cookie's name (lib/account-auth.ts's
// ACCOUNT_SESSION_COOKIE_NAME) -- captured out of every api_request/
// api_request_multipart response's Set-Cookie headers below (not just
// login's) into ApiBridge.session_cookie, since it's the one thing a
// raw Rust WebSocket handshake needs that reqwest's own cookie jar can't
// hand over: a WS handshake needs an explicit `Cookie` header value, not
// an opaque jar a browser would apply automatically.
const SESSION_COOKIE_NAME: &str = "vyx_trade_session";

fn capture_session_cookie(res: &reqwest::Response, bridge: &ApiBridge) {
    let prefix = format!("{SESSION_COOKIE_NAME}=");
    for value in res.headers().get_all(reqwest::header::SET_COOKIE) {
        let Ok(s) = value.to_str() else { continue };
        if let Some(rest) = s.strip_prefix(&prefix) {
            let value_only = rest.split(';').next().unwrap_or("");
            *bridge.session_cookie.lock().unwrap() = Some(format!("{prefix}{value_only}"));
        }
    }
}

// Managed app state: the one persistent, cookie-jar-backed HTTP client
// every api_request/api_request_multipart call reuses -- a fresh
// reqwest::Client per call would mean a fresh (empty) cookie jar per
// call, losing the session the moment login's Set-Cookie response ended.
struct ApiBridge {
    client: reqwest::Client,
    connect_base: String,
    host_header: String,
    session_cookie: Mutex<Option<String>>,
    gateway_ws_base: String,
}

// Tracks the two live-stream tasks start_live_streams spawns, so a
// second login (account switch) or a logout can cancel the previous
// pair instead of leaking an ever-growing set of connections.
struct WsHandles {
    prices: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    trading: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Debug, Serialize)]
struct ApiResponsePayload {
    status: u16,
    body: serde_json::Value,
    // The HTTP Date response header, forwarded so lib/trade-api.ts's
    // recalibrateFromResponse (clock-skew correction for candle
    // bucketing) keeps working unchanged under the desktop transport --
    // see its own module comment for why this matters.
    date: Option<String>,
}

// The desktop-transport twin of lib/trade-api.ts's call(): same
// method/path/JSON-body/response shape, just over reqwest instead of
// fetch(). No backend route needs to know or care which one called it.
#[tauri::command]
async fn api_request(
    bridge: tauri::State<'_, ApiBridge>,
    path: String,
    method: String,
    body: Option<serde_json::Value>,
) -> Result<ApiResponsePayload, String> {
    let method = match method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PATCH" => reqwest::Method::PATCH,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        other => return Err(format!("unsupported method: {other}")),
    };
    let url = format!("{}{}", bridge.connect_base, path);
    let mut req = bridge.client.request(method, &url).header("Host", &bridge.host_header);
    if let Some(b) = &body {
        req = req.json(b);
    }
    let res = req.send().await.map_err(|e| format!("request to {path} failed: {e}"))?;
    capture_session_cookie(&res, &bridge);
    let status = res.status().as_u16();
    let date = res.headers().get(reqwest::header::DATE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let body = res.json().await.unwrap_or(serde_json::Value::Null);
    Ok(ApiResponsePayload { status, body, date })
}

#[derive(Debug, Deserialize)]
struct MultipartField {
    name: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    file: Option<MultipartFile>,
}

#[derive(Debug, Deserialize)]
struct MultipartFile {
    filename: String,
    mime: String,
    #[serde(rename = "dataBase64")]
    data_base64: String,
}

// The desktop-transport twin of lib/trade-api.ts's callForm() (used only
// by KYC document submission today) -- browsers build a multipart body
// from real File objects directly; the WebView here has no File-object
// bridge to Rust, so the JS side base64-encodes each file's bytes into a
// plain JSON array of fields instead, and this reconstructs the same
// multipart/form-data body reqwest sends, against the same unmodified
// /api/trade/kyc route.
#[tauri::command]
async fn api_request_multipart(
    bridge: tauri::State<'_, ApiBridge>,
    path: String,
    fields: Vec<MultipartField>,
) -> Result<ApiResponsePayload, String> {
    let mut form = reqwest::multipart::Form::new();
    for field in fields {
        if let Some(file) = field.file {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&file.data_base64)
                .map_err(|e| format!("invalid base64 for field {}: {e}", field.name))?;
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(file.filename)
                .mime_str(&file.mime)
                .map_err(|e| e.to_string())?;
            form = form.part(field.name, part);
        } else if let Some(value) = field.value {
            form = form.text(field.name, value);
        }
    }
    let url = format!("{}{}", bridge.connect_base, path);
    let res = bridge
        .client
        .post(&url)
        .header("Host", &bridge.host_header)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("request to {path} failed: {e}"))?;
    capture_session_cookie(&res, &bridge);
    let status = res.status().as_u16();
    let body = res.json().await.unwrap_or(serde_json::Value::Null);
    Ok(ApiResponsePayload { status, body, date: None })
}

// Reconnect-with-backoff mirror of WebTrader.tsx's own two browser-
// WebSocket effects (price ticks / trading events), just over a native
// tokio-tungstenite client instead -- see its own call site
// (start_live_streams) for why a raw WS handshake, not the WebView's own
// WebSocket, is what can actually carry the session cookie here.
async fn run_gateway_stream(
    app: tauri::AppHandle,
    gateway_base: String,
    path: &'static str,
    cookie: String,
    event_name: &'static str,
) {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    loop {
        let url = format!("{gateway_base}{path}");
        let request = url
            .as_str()
            .into_client_request()
            .ok()
            .and_then(|mut req| {
                reqwest::header::HeaderValue::from_str(&cookie).ok().map(|v| {
                    req.headers_mut().insert("Cookie", v);
                    req
                })
            });
        if let Some(request) = request {
            if let Ok((ws_stream, _)) = tokio_tungstenite::connect_async(request).await {
                use futures_util::StreamExt;
                let (_, mut read) = ws_stream.split();
                while let Some(msg) = read.next().await {
                    match msg {
                        Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                            let _ = app.emit(event_name, text.to_string());
                        }
                        Ok(tokio_tungstenite::tungstenite::Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
            }
        }
        // Same 3s reconnect delay as WebTrader.tsx's own browser-WebSocket
        // fallback -- this task only ever exits via JoinHandle::abort()
        // (stop_live_streams / a fresh start_live_streams superseding it),
        // never on its own, so a dropped connection always retries.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

// Called once the bundled shell knows it's logged in (right after a
// successful login, or on mount if a session already exists) -- reads
// the session cookie api_request/api_request_multipart already captured
// from a real response, then spawns the two live-stream tasks. Safe to
// call again later (e.g. switching accounts): cancels the previous pair
// first rather than leaking connections.
#[tauri::command]
fn start_live_streams(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, ApiBridge>,
    handles: tauri::State<'_, WsHandles>,
) -> Result<(), String> {
    let cookie = bridge
        .session_cookie
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "not logged in yet -- no session cookie captured".to_string())?;

    if let Some(h) = handles.prices.lock().unwrap().take() {
        h.abort();
    }
    if let Some(h) = handles.trading.lock().unwrap().take() {
        h.abort();
    }

    let prices_handle = tauri::async_runtime::spawn(run_gateway_stream(
        app.clone(),
        bridge.gateway_ws_base.clone(),
        "/v1/prices/stream",
        cookie.clone(),
        "gateway-price-tick",
    ));
    *handles.prices.lock().unwrap() = Some(prices_handle);

    let trading_handle = tauri::async_runtime::spawn(run_gateway_stream(
        app,
        bridge.gateway_ws_base.clone(),
        "/v1/trading/stream",
        cookie,
        "gateway-trading-event",
    ));
    *handles.trading.lock().unwrap() = Some(trading_handle);

    Ok(())
}

// Called on logout (WebTrader.tsx's handleLogout) so a stale session's
// live streams don't keep running -- a fresh start_live_streams call
// after the next login would also cancel these, but logout shouldn't
// leave live connections open in the meantime even briefly.
#[tauri::command]
fn stop_live_streams(handles: tauri::State<'_, WsHandles>) {
    if let Some(h) = handles.prices.lock().unwrap().take() {
        h.abort();
    }
    if let Some(h) = handles.trading.lock().unwrap().take() {
        h.abort();
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
// below -- unused (by design) in debug builds.
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

// Injected before the bundled shell's index.html loads, so
// window.vyxDesktop exists with EXACTLY the shape WebTrader.tsx/
// DesktopTitleBar.tsx already expect -- see their `declare global {
// interface Window { vyxDesktop?  {...} } }`. apiCall/apiCallMultipart
// are what lib/trade-api.ts's isDesktop branch invokes instead of
// fetch() -- see api_request/api_request_multipart above for why the
// WebView's own network stack can't be used instead (can't carry the
// broker's httpOnly session cookie across the local-content/real-host
// origin boundary). brokerHost is the one piece of static config the
// bundled UI needs that used to come from window.location.hostname
// (meaningless now that the document's own origin is local content) --
// see WebTrader.tsx's two call sites.
//
// Also requests OS notification permission up front -- see this
// script's own previous version for the full isPermissionGranted/
// requestPermission reasoning (unchanged).
const VYX_DESKTOP_INIT_SCRIPT_TEMPLATE: &str = r#"
(function () {
  window.vyxDesktop = {
    isDesktop: true,
    brokerHost: "__BROKER_HOST__",
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
    rememberSession: function () { window.__TAURI__.core.invoke("remember_session"); },
    forgetSession: function () { window.__TAURI__.core.invoke("forget_session"); },
    apiCall: function (path, method, body) {
      return window.__TAURI__.core.invoke("api_request", { path: path, method: method, body: body });
    },
    apiCallMultipart: function (path, fields) {
      return window.__TAURI__.core.invoke("api_request_multipart", { path: path, fields: fields });
    },
    startLiveStreams: function () { return window.__TAURI__.core.invoke("start_live_streams"); },
    stopLiveStreams: function () { window.__TAURI__.core.invoke("stop_live_streams"); },
    onPriceTick: function (callback) {
      var unlistenPromise = window.__TAURI__.event.listen("gateway-price-tick", function (event) {
        callback(event.payload);
      });
      return function () {
        unlistenPromise.then(function (unlisten) { unlisten(); });
      };
    },
    onTradingEvent: function (callback) {
      var unlistenPromise = window.__TAURI__.event.listen("gateway-trading-event", function (event) {
        callback(event.payload);
      });
      return function () {
        unlistenPromise.then(function (unlisten) { unlisten(); });
      };
    },
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
    let (connect_base, host_header) = resolve_api_target(&config);
    let gateway_ws_base = config.gateway_ws_url.clone().unwrap_or_else(|| "ws://127.0.0.1:8080".to_string());

    let init_script = VYX_DESKTOP_INIT_SCRIPT_TEMPLATE.replace("__BROKER_HOST__", &host_header);

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
        .manage(WsHandles { prices: Mutex::new(None), trading: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            win_minimize,
            win_toggle_maximize,
            win_close,
            remember_broker,
            forget_broker,
            remember_session,
            forget_session,
            api_request,
            api_request_multipart,
            start_live_streams,
            stop_live_streams
        ])
        .setup(move |app| {
            // Cookie jar built here (not in main(), before the app handle
            // exists) specifically so a "Remember me" session saved on a
            // previous launch (see remember_session/session_file_path) can
            // be pre-seeded into it -- app_data_dir() needs a real
            // AppHandle, only available once .setup() runs. Falls back to
            // an empty jar exactly like .cookie_store(true) always did when
            // no saved session exists (the overwhelmingly common case: a
            // fresh launch, or "Remember me" never checked).
            let app_handle = app.handle().clone();
            let saved_session = read_saved_session(&app_handle);
            let jar = reqwest::cookie::Jar::default();
            if let Some(cookie) = &saved_session {
                if let Ok(url) = connect_base.parse::<reqwest::Url>() {
                    jar.add_cookie_str(cookie, &url);
                }
            }
            let http_client = reqwest::Client::builder()
                .cookie_provider(Arc::new(jar))
                .build()
                .expect("failed to build reqwest client");
            app.manage(ApiBridge {
                client: http_client,
                connect_base: connect_base.clone(),
                host_header: host_header.clone(),
                session_cookie: Mutex::new(saved_session),
                gateway_ws_base: gateway_ws_base.clone(),
            });

            let nav_app_handle = app.handle().clone();
            let new_window_app_handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(&config.broker_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                // Frameless -- matches desktop/main.js's `frame: false`.
                // WebTrader renders its own title bar (DesktopTitleBar.tsx)
                // once it detects window.vyxDesktop.isDesktop.
                .decorations(false)
                // The window now only ever shows the bundled local shell --
                // any navigation away from it (a support-email mailto:, a
                // stray external link) should open in the OS browser
                // instead, never replace the app's own UI in-place. Unlike
                // the old remote-wrapper version of this file, no host is
                // "allowed" in-window anymore; only local content is.
                .on_navigation(move |url| {
                    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
                        return true;
                    }
                    let _ = nav_app_handle.opener().open_url(url.to_string(), None::<&str>);
                    false
                })
                // Direct port of desktop/main.js's setWindowOpenHandler:
                // any window.open()/target="_blank" opens in the OS
                // browser instead of inside the app.
                .on_new_window(move |url, _features| {
                    let _ = new_window_app_handle.opener().open_url(url.to_string(), None::<&str>);
                    tauri::webview::NewWindowResponse::Deny
                })
                .initialization_script(&init_script)
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
