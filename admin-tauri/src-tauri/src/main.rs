// Suppresses the console window a Rust binary otherwise gets by default on
// Windows (the "console" subsystem) -- release builds only, so `cargo run`
// during dev still shows println!/log output in a terminal. Same fix as
// manager-tauri's own main.rs -- see its comment for why this was missing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// VyXTrader Admin desktop shell -- see the bundled-UI architecture plan
// (2026-08) for why this no longer loads a remote URL at all: the main
// window now shows `admin-shell/`'s built output (bundled at compile
// time via tauri.conf.json's frontendDist), and every API call that UI
// makes crosses the network through the api_request/api_request_multipart
// commands below -- a persistent, cookie-jar-backed reqwest::Client --
// rather than through the WebView's own fetch(), which cannot carry the
// vyx_admin_session cookie across the local-content/real-host origin
// boundary. Direct port of desktop-tauri's/manager-tauri's own bridge
// (same technique, proven there first). Not broker-scoped -- Super Admin
// lives at a fixed admin.<rootDomain> subdomain, no per-broker config
// needed, so this is even narrower than manager-tauri's own bridge (no
// remember_broker/forget_broker at all, nothing to remember).
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use std::sync::Mutex;

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
        .unwrap_or_else(|| std::path::PathBuf::from("app.config.json"));

    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read app.config.json at {path:?}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("invalid app.config.json: {e}"))
}

// Fixed "admin" subdomain -- middleware.ts's SUPER_ADMIN_SUBDOMAIN, not
// configurable per-install the way a broker's Manager app is, since
// there is exactly one Super Admin surface for the whole platform.
// Local-dev branch mirrors desktop-tauri's/manager-tauri's own
// resolve_api_target -- *.localhost doesn't resolve via DNS on Windows,
// so connect_base substitutes 127.0.0.1 while host_header keeps the
// real value middleware.ts's Host-header check needs.
fn resolve_api_target(config: &AppConfig) -> (String, String) {
    let host = format!("admin.{}", config.root_domain);
    if host.contains("localhost") {
        let port = host.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(3000);
        (format!("http://127.0.0.1:{port}"), host)
    } else {
        (format!("https://{host}"), host)
    }
}

// lib/auth.ts's SESSION_COOKIE_NAME -- shared with Manager (both
// /manage/* and /(super-admin)/* sessions use this same cookie).
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

// Direct port of desktop-tauri's/manager-tauri's own api_request.
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

// Direct port of desktop-tauri's/manager-tauri's own
// api_request_multipart -- unused by Super Admin today, kept for bridge
// shape parity.
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

// Direct port of desktop-tauri's/manager-tauri's own check_for_updates,
// minus the native-notification step (that plugin isn't part of this
// app's deliberately narrower slice yet).
#[cfg_attr(debug_assertions, allow(dead_code))]
async fn check_for_updates(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
    }
    Ok(())
}

// Same shape as desktop-tauri's/manager-tauri's own
// VYX_DESKTOP_INIT_SCRIPT_TEMPLATE, narrower still -- no rememberBroker/
// forgetBroker at all, nothing to remember for a fixed single-tenant app.
const VYX_DESKTOP_INIT_SCRIPT_TEMPLATE: &str = r#"
(function () {
  window.vyxDesktop = {
    isDesktop: true,
    brokerHost: "__BROKER_HOST__",
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
    let config = load_app_config();
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
        .invoke_handler(tauri::generate_handler![api_request, api_request_multipart])
        .setup(move |app| {
            let app_name = config.app_name.clone();
            let nav_app_handle = app.handle().clone();
            let new_window_app_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(&app_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                // Same lockdown as desktop-tauri's/manager-tauri's own:
                // the window only ever shows the bundled local shell now.
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
