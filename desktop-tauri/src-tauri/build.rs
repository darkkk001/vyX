fn main() {
    // Without this, none of main.rs's #[tauri::command] fns have any ACL
    // entry at all -- not even a wrongly-scoped one. Tauri's authority
    // resolver looks them up under the app's own pseudo-plugin key
    // (`__app-acl__`, used when a command has no plugin) and, finding
    // nothing, refuses every call with "<command> not allowed. Plugin not
    // found" -- confirmed against tauri-2.11.5's own
    // src/ipc/authority.rs. This was silently broken for every command
    // here (title-bar minimize/maximize/close, remember/forget-broker,
    // retry-connection) since this app has always loaded a *remote* URL,
    // and Tauri only enforces the ACL that strictly for remote content.
    //
    // AppManifest::commands(...) autogenerates one `allow-<command>` /
    // `deny-<command>` permission pair per command (underscores become
    // dashes) under src-tauri/gen/schemas/ -- capabilities/default.json
    // must list the `allow-*` ones it wants to grant.
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "win_minimize",
            "win_toggle_maximize",
            "win_close",
            "remember_broker",
            "forget_broker",
            "api_request",
            "api_request_multipart",
            "start_live_streams",
            "stop_live_streams",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
