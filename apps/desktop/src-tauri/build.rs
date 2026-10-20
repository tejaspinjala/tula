fn main() {
    // Declaring the command puts it behind the ACL: only a capability that grants
    // `allow-set-server-url` can call it (see capabilities/default.json).
    let manifest = tauri_build::AppManifest::new().commands(&["set_server_url"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
