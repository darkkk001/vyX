// Suppresses the console window a Rust binary otherwise gets by default on
// Windows (the "console" subsystem) -- release builds only, so `cargo run`
// during dev still shows println!/log output in a terminal. Direct port of
// desktop-tauri's own main.rs, which already has this; missing here was a
// real bug (a visible cmd window popped up alongside the app on launch).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// VyXTrader Manager desktop shell -- see the bundled-UI architecture plan
// (2026-08) for why this no longer loads a remote URL at all: the main
// window now shows `manager-shell/`'s built output (bundled at compile
// time via tauri.conf.json's frontendDist), and every API call that UI
// makes crosses the network through the api_request/api_request_multipart
// commands below -- a persistent, cookie-jar-backed reqwest::Client --
// rather than through the WebView's own fetch(), which cannot carry the
// broker's httpOnly vyx_admin_session cookie across the local-content /
// real-host origin boundary. Direct port of desktop-tauri/src-tauri/src/
// main.rs's own bridge (same technique, proven there first) -- this app
// still doesn't have desktop-tauri's tray/notifications/window-state/
// frameless-title-bar polish, an already-flagged-deferred decision
// unrelated to this bundling work.
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use std::sync::Mutex;

// fix/realtime-sync -- see desktop-tauri/src-tauri/src/main.rs's
// identical function for the full explanation (WebView2's default
// context menu/accelerator keys/DevTools, reached via Tauri's
// with_webview escape hatch since WebviewWindowBuilder doesn't expose
// wry's own with_default_context_menus/with_browser_accelerator_keys).
#[cfg(target_os = "windows")]
fn lock_down_webview(webview: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let controller = webview.controller();
    let Ok(core_webview) = (unsafe { controller.CoreWebView2() }) else {
        return;
    };
    let Ok(settings) = (unsafe { core_webview.Settings() }) else {
        return;
    };
    unsafe {
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        let _ = settings.SetAreDevToolsEnabled(false);
        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn lock_down_webview(_webview: tauri::webview::PlatformWebview) {}

#[derive(Debug, Deserialize)]
struct BrokerConfig {
    #[serde(rename = "brokerName")]
    broker_name: String,
    // A full host (e.g. "acmefx.vyxtrader.com") -- resolve_api_target()
    // below turns this into the base URL every api_request call is made
    // against. Only meaningful in "broker" mode -- launcher-mode bundling
    // (picking between multiple brokers inside one install) is deferred,
    // same v1 scope decision as desktop-tauri's own.
    subdomain: String,
    #[allow(dead_code)]
    #[serde(rename = "rootDomain")]
    root_domain: String,
    #[allow(dead_code)]
    mode: String,
}

// Direct port of desktop-tauri's own getRememberedBroker()/
// setRememberedBroker()/clearRememberedBroker().
fn remembered_broker_path(app: &tauri::AppHandle) -> tauri::Result<std::path::PathBuf> {
    Ok(app.path().app_data_dir()?.join("remembered-broker.json"))
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

fn load_broker_config() -> BrokerConfig {
    let path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("broker.config.json")))
        .filter(|p| p.exists())
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

// Direct port of desktop-tauri's own resolve_api_target -- see its
// comment for the full local-dev-vs-production reasoning.
fn resolve_api_target(config: &BrokerConfig) -> (String, String) {
    if config.subdomain.contains("localhost") {
        let port = config.subdomain.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(3000);
        (format!("http://127.0.0.1:{port}"), config.subdomain.clone())
    } else {
        (format!("https://{}", config.subdomain), config.subdomain.clone())
    }
}

// lib/auth.ts's SESSION_COOKIE_NAME -- shared by Manager and Super Admin
// (both /manage/* and /(super-admin)/* sessions use this same cookie),
// distinct from the Trader terminal's vyx_trade_session.
const SESSION_COOKIE_NAME: &str = "vyx_admin_session";

struct ApiBridge {
    client: reqwest::Client,
    connect_base: String,
    host_header: String,
    #[allow(dead_code)]
    session_cookie: Mutex<Option<String>>,
}

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

#[derive(Debug, Serialize)]
struct ApiResponsePayload {
    status: u16,
    body: serde_json::Value,
    date: Option<String>,
}

// Direct port of desktop-tauri's own api_request.
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

// Direct port of desktop-tauri's own api_request_multipart -- unused by
// Manager today (no multipart upload in app/api/manage/** yet), kept for
// parity so the bridge's public shape matches exactly, and so any future
// Manager file upload (e.g. a KYC document review attachment) gets this
// for free.
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

// Direct port of desktop-tauri's own check_for_updates, minus the
// native-notification step (that plugin isn't part of this app's
// deliberately narrower slice yet -- see this file's own top comment).
#[cfg_attr(debug_assertions, allow(dead_code))]
async fn check_for_updates(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
    }
    Ok(())
}

// Same shape as desktop-tauri's own VYX_DESKTOP_INIT_SCRIPT_TEMPLATE,
// narrower subset (no window-control methods -- this window is
// OS-decorated, not frameless, so it has no custom title bar needing
// them; see types/vyx-desktop.d.ts's own comment on why every field but
// isDesktop is optional).
const VYX_DESKTOP_INIT_SCRIPT_TEMPLATE: &str = r#"
(function () {
  window.vyxDesktop = {
    isDesktop: true,
    brokerHost: "__BROKER_HOST__",
    rememberBroker: function (hostname) { window.__TAURI__.core.invoke("remember_broker", { hostname: hostname }); },
    forgetBroker: function () { window.__TAURI__.core.invoke("forget_broker"); },
    apiCall: function (path, method, body) {
      return window.__TAURI__.core.invoke("api_request", { path: path, method: method, body: body });
    },
    apiCallMultipart: function (path, fields) {
      return window.__TAURI__.core.invoke("api_request_multipart", { path: path, fields: fields });
    },
  };
})();
"#;

fn main() {
    let config = load_broker_config();
    let (connect_base, host_header) = resolve_api_target(&config);
    let init_script = VYX_DESKTOP_INIT_SCRIPT_TEMPLATE.replace("__BROKER_HOST__", &host_header);

    let http_client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .expect("failed to build reqwest client");

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(ApiBridge { client: http_client, connect_base, host_header, session_cookie: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            remember_broker,
            forget_broker,
            api_request,
            api_request_multipart
        ])
        .setup(move |app| {
            let broker_name = config.broker_name.clone();
            let nav_app_handle = app.handle().clone();
            let new_window_app_handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(&broker_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                // Same lockdown as desktop-tauri's own: the window only
                // ever shows the bundled local shell now, so any
                // navigation away from it opens in the OS browser instead
                // of replacing the app's own UI in-place.
                .on_navigation(move |url| {
                    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
                        return true;
                    }
                    let _ = nav_app_handle.opener().open_url(url.to_string(), None::<&str>);
                    false
                })
                .on_new_window(move |url, _features| {
                    let _ = new_window_app_handle.opener().open_url(url.to_string(), None::<&str>);
                    tauri::webview::NewWindowResponse::Deny
                })
                .initialization_script(&init_script)
                .build()?;
            window.with_webview(lock_down_webview)?;

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
        .expect("error while running vyxtrader-manager-tauri");
}
