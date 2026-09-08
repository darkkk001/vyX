// Suppresses the console window a Rust binary otherwise gets by default on
// Windows (the "console" subsystem) -- release builds only, so `cargo run`
// during dev still shows println!/log output in a terminal. Same fix as
// manager-tauri's own main.rs -- see its comment for why this was missing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// VyXTrader Admin desktop shell -- 2026-09-08 rewrite, direct port of
// manager-tauri's own (see its main.rs top comment for the full
// rationale): loads the real, live Super Admin pages directly
// (WebviewUrl::External) instead of admin-shell/'s own bundled copy, so
// every page/feature/fix there shows up here automatically with zero
// separate work. Getting in requires SUPER_ADMIN_DESKTOP_GATE_SECRET
// (baked into this build by set-gate-secret.js) that middleware.ts
// otherwise 404s unconditionally for everyone else -- see this window's
// launch URL below and middleware.ts's/lib/desktop-gate.ts's comments.
// The old ApiBridge/window.vyxDesktop reqwest bridge is gone for the same
// reason as manager-tauri's -- it only ever existed to get admin-shell's
// bundled local content past a cross-origin/cookie problem that doesn't
// apply once the window shows the real page directly.
use serde::Deserialize;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use std::sync::{Arc, Mutex};

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
struct AppConfig {
    #[serde(rename = "appName")]
    app_name: String,
    #[serde(rename = "rootDomain")]
    root_domain: String,
    // SUPER_ADMIN_DESKTOP_GATE_SECRET's plaintext value -- see this
    // file's own top comment and set-gate-secret.js. Baked in at build
    // time, reverted (never committed) right after.
    #[serde(rename = "desktopGateSecret", default)]
    desktop_gate_secret: String,
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
// Local-dev branch mirrors manager-tauri's/desktop-tauri's own resolve
// helpers -- *.localhost doesn't resolve via DNS on Windows.
fn resolve_connect_base(config: &AppConfig) -> String {
    let host = format!("admin.{}", config.root_domain);
    if host.contains("localhost") {
        let port = host.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(3000);
        format!("http://127.0.0.1:{port}")
    } else {
        format!("https://{host}")
    }
}

// Direct port of manager-tauri's/desktop-tauri's own check_for_updates.
#[cfg_attr(debug_assertions, allow(dead_code))]
async fn check_for_updates(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
    }
    Ok(())
}

fn main() {
    let config = load_app_config();
    let connect_base = resolve_connect_base(&config);

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let app_name = config.app_name.clone();

            // The one entry point this window actually navigates to first
            // -- trades desktop_gate_secret for a signed cookie and
            // redirects into the real /login -- see app/api/admin/
            // desktop-gate/route.ts.
            let gate_url: tauri::Url = format!(
                "{connect_base}/api/admin/desktop-gate?secret={}",
                config.desktop_gate_secret
            )
            .parse()
            .expect("connect_base + /api/admin/desktop-gate must be a valid URL");

            // Same dynamic host-lock as manager-tauri's/desktop-tauri's
            // own -- see either's comment for the full rationale.
            let locked_host: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let nav_locked_host = locked_host.clone();
            let load_locked_host = locked_host.clone();

            let nav_app_handle = app.handle().clone();
            let new_window_app_handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(gate_url))
                .title(&app_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                // Same dark-titlebar fix as manager-tauri's own -- see its
                // main.rs comment.
                .theme(Some(tauri::Theme::Dark))
                .on_navigation(move |url| {
                    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
                        return true;
                    }
                    let locked = nav_locked_host.lock().unwrap().clone();
                    match locked {
                        None => true,
                        Some(host) => {
                            if url.host_str() == Some(host.as_str()) {
                                true
                            } else {
                                let _ = nav_app_handle.opener().open_url(url.to_string(), None::<&str>);
                                false
                            }
                        }
                    }
                })
                .on_new_window(move |url, _features| {
                    let _ = new_window_app_handle.opener().open_url(url.to_string(), None::<&str>);
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_page_load(move |_webview, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                        let mut locked = load_locked_host.lock().unwrap();
                        if locked.is_none() {
                            *locked = payload.url().host_str().map(str::to_string);
                        }
                    }
                })
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
        .expect("error while running vyxtrader-admin-tauri");
}
