// Suppresses the console window a Rust binary otherwise gets by default on
// Windows (the "console" subsystem) -- release builds only, so `cargo run`
// during dev still shows println!/log output in a terminal. Direct port of
// desktop-tauri's own main.rs, which already has this; missing here was a
// real bug (a visible cmd window popped up alongside the app on launch).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// VyXTrader Manager desktop shell -- 2026-09-08 rewrite. Loads this
// broker's own real, live /manage backoffice directly (WebviewUrl::
// External), the same fix already proven on desktop-tauri/the trader
// terminal, instead of manager-shell/'s own bundled copy -- that copy had
// its own hand-maintained nav array and router, separate from the real
// Next.js app, which is exactly what let it drift out of sync (confirmed
// live: missing features, a forced theme, a missing dealer toggle). This
// means every page, every feature, every future fix in app/manage/** shows
// up here automatically, with zero separate work -- there is no second UI
// left to maintain.
//
// Getting in requires a secret (desktopGateSecret, baked into this build
// by rebrand.js) that middleware.ts's own /manage/* block otherwise 404s
// unconditionally for everyone else -- see this window's own launch URL
// below and middleware.ts's/lib/desktop-gate.ts's comments for the full
// mechanism. Once past that gate, this window is functionally a normal
// browser tab on the broker's own domain: real fetch() calls, real
// cookies, no cross-origin boundary to work around -- which is also why
// the old ApiBridge/window.vyxDesktop reqwest bridge this file used to
// carry is gone. That bridge only ever existed to get manager-shell's
// bundled local content past a cross-origin/cookie problem that no longer
// applies once the window shows the real page directly (same reasoning as
// desktop-tauri's own header comment on this).
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
struct BrokerConfig {
    #[serde(rename = "brokerName")]
    broker_name: String,
    // A full host (e.g. "acmefx.vyxtrader.com") -- resolve_api_target()
    // below turns this into the base URL this window is pointed at.
    subdomain: String,
    #[allow(dead_code)]
    #[serde(rename = "rootDomain")]
    root_domain: String,
    #[allow(dead_code)]
    mode: String,
    // Broker.desktopGateSecret's plaintext value -- see this file's own
    // top comment and rebrand.js's --desktop-gate-secret flag. Baked in
    // at rebrand/build time, reverted (never committed) right after.
    #[serde(rename = "desktopGateSecret", default)]
    desktop_gate_secret: String,
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

// Direct port of desktop-tauri's own resolve_api_target -- see its
// comment for the full local-dev-vs-production reasoning.
fn resolve_connect_base(config: &BrokerConfig) -> String {
    if config.subdomain.contains("localhost") {
        let port = config.subdomain.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(3000);
        format!("http://127.0.0.1:{port}")
    } else {
        format!("https://{}", config.subdomain)
    }
}

// Direct port of desktop-tauri's own check_for_updates, minus the
// native-notification step (that plugin isn't part of this app's
// deliberately narrower slice yet -- see docs/decisions.md's core-shell
// slice decision).
#[cfg_attr(debug_assertions, allow(dead_code))]
async fn check_for_updates(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
    }
    Ok(())
}

fn main() {
    let config = load_broker_config();
    let connect_base = resolve_connect_base(&config);

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let broker_name = config.broker_name.clone();

            // The one entry point this window actually navigates to first
            // -- trades desktop_gate_secret for a signed cookie and
            // redirects into the real /manage/login (which itself
            // redirects on to /manage/dashboard if a session already
            // exists) -- see app/api/manage/desktop-gate/route.ts.
            let gate_url: tauri::Url = format!(
                "{connect_base}/api/manage/desktop-gate?secret={}",
                config.desktop_gate_secret
            )
            .parse()
            .expect("connect_base + /api/manage/desktop-gate must be a valid URL");

            // 2026-09-08 fix -- see desktop-tauri/src-tauri/src/main.rs's
            // identical mechanism and its own comment for the full
            // rationale (a static precomputed host broke the moment a
            // broker's own server-side redirect chain crossed onto a
            // different host, e.g. a customDomain 308). None = nothing
            // has actually finished loading yet, so every navigation so
            // far -- the gate's own redirect included -- is still part of
            // OUR OWN server's chain from the initial launch URL, not
            // something the user clicked, and is trusted unconditionally;
            // on_page_load locks this to wherever that chain lands the
            // moment it does.
            let locked_host: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let nav_locked_host = locked_host.clone();
            let load_locked_host = locked_host.clone();

            let nav_app_handle = app.handle().clone();
            let new_window_app_handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(gate_url))
                .title(&broker_name)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                // The app's own UI is dark by default (admin-theme.css's
                // base [data-surface] rule) -- without this, Windows draws
                // its own native title bar in the OS's light-mode colors
                // regardless, a jarring white bar above a dark app.
                // decorations stay on (a real native title bar, not a
                // custom-drawn one -- that's desktop-tauri's own frameless/
                // DesktopTitleBar.tsx treatment, an already-flagged-deferred
                // decision for this app, not done here yet).
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
                // See desktop-tauri/src-tauri/src/main.rs's identical
                // hook for why Started (not Finished) is the right event:
                // WebView2 only fires it once redirects are already
                // resolved, for the chain's real final document.
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
        .expect("error while running vyxtrader-manager-tauri");
}
