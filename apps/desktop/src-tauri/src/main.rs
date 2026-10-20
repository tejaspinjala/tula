//! Guildhall desktop: a native window that opens the configured Guildhall server. The window loads
//! the remote https origin directly, so WebAuthn's RP ID stays the server's host (see
//! docs/spikes/tauri-passkeys.md). The remote page gets no native commands; only the local
//! first-run page can set the address.

mod settings;

use std::path::PathBuf;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const CHANGE_ADDRESS: &str = "change-server-address";
const TOGGLE_FULLSCREEN: &str = "toggle-fullscreen";

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("settings.json"))
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window("main")
}

fn open_window<R: Runtime>(app: &AppHandle<R>, target: WebviewUrl) -> tauri::Result<()> {
    if let Some(window) = main_window(app) {
        let _ = window.close();
    }
    WebviewWindowBuilder::new(app, "main", target)
        .title("Guildhall")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .build()?;
    Ok(())
}

/// Opens the stored server, or the first-run page when none is stored.
fn open_server_or_prompt(app: &AppHandle) -> tauri::Result<()> {
    let stored = settings_path(app).ok().and_then(|p| settings::load(&p));
    match stored {
        Some(url) => open_window(app, WebviewUrl::External(url)),
        None => open_window(app, WebviewUrl::App("index.html".into())),
    }
}

/// Called by the local first-run page: validates, stores and opens the address.
#[tauri::command]
fn set_server_url<R: Runtime>(app: AppHandle<R>, address: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    let url = settings::save(&path, &address)?;
    // Defer: the calling window is the one being replaced.
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = open_window(&handle, WebviewUrl::External(url));
    });
    Ok(())
}

/// The one embedded app context (the macro may expand only once per crate).
fn context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_server_url])
        .setup(|app| {
            let change = MenuItemBuilder::with_id(CHANGE_ADDRESS, "Change Server Address…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;
            let fullscreen = MenuItemBuilder::with_id(TOGGLE_FULLSCREEN, "Toggle Full Screen")
                .accelerator("CmdOrCtrl+Ctrl+F")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Guildhall")
                .item(&change)
                .separator()
                .quit()
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view = SubmenuBuilder::new(app, "View").item(&fullscreen).build()?;
            app.set_menu(MenuBuilder::new(app).items(&[&app_menu, &edit, &view]).build()?)?;
            open_server_or_prompt(app.handle())?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            CHANGE_ADDRESS => {
                let _ = open_window(app, WebviewUrl::App("index.html".into()));
            }
            TOGGLE_FULLSCREEN => {
                if let Some(window) = main_window(app) {
                    let on = window.is_fullscreen().unwrap_or(false);
                    let _ = window.set_fullscreen(!on);
                }
            }
            _ => {}
        })
        .run(context())
        .expect("error while running Guildhall desktop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    fn call(origin: &str) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![set_server_url])
            .build(context())
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            WebviewUrl::External(origin.parse().unwrap()),
        )
        .build()
        .unwrap();
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "set_server_url".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: origin.parse().unwrap(),
                body: InvokeBody::Json(serde_json::json!({ "address": "" })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    #[test]
    fn a_remote_origin_may_not_call_set_server_url() {
        let err = call("https://evil.example.com/").unwrap_err();
        assert!(err.to_string().contains("not allowed"), "{err}");
    }

    #[test]
    fn set_server_url_is_granted_only_to_a_local_capability() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut granted = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            let capability: serde_json::Value = serde_json::from_str(&text).unwrap();
            let grants = capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p == "allow-set-server-url");
            if grants {
                granted += 1;
                assert_eq!(capability["local"], true, "must be a local capability");
                assert!(capability.get("remote").is_none(), "must have no remote urls");
            }
        }
        assert_eq!(granted, 1, "exactly one capability grants set_server_url");
    }

    #[test]
    fn pages_get_no_global_tauri_object_and_a_strict_csp() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_ne!(conf["app"]["withGlobalTauri"], true);
        assert_eq!(conf["app"]["security"]["csp"]["default-src"], "'self'");
    }

    #[test]
    fn the_local_page_may_call_set_server_url() {
        // Reaches the command (which rejects the empty address) instead of the ACL.
        let err = call("tauri://localhost/index.html").unwrap_err();
        assert!(!err.to_string().contains("not allowed"), "{err}");
    }
}
