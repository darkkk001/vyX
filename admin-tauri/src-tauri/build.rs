fn main() {
    // See desktop-tauri/src-tauri/build.rs's comment for the full story --
    // every custom command needs its own allow-* ACL entry or Tauri's
    // authority resolver refuses it with "<command> not allowed. Plugin
    // not found."
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["api_request", "api_request_multipart"]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
