fn main() {
    // See desktop-tauri/src-tauri/build.rs's comment for the full story --
    // same fix, same bug: remember_broker/forget_broker had no ACL entry at
    // all, so a remote page calling window.vyxDesktop.rememberBroker(...)
    // would fail with "remember_broker not allowed. Plugin not found."
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["remember_broker", "forget_broker"]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
