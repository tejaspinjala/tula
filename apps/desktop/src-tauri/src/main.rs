//! Guildhall desktop: a native window that opens the configured Guildhall server. The window loads
//! the remote https origin directly, so WebAuthn's RP ID stays the server's host (see
//! docs/spikes/tauri-passkeys.md). The remote page gets no native commands; only the local
//! first-run page can set the address. Passkeys hang in the webview, so sign-in goes through the
//! system browser and comes back by the `guildhall://` deep link (see `handoff.rs`).

mod handoff;
mod settings;

use std::path::PathBuf;
use std::time::Instant;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

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
    let mut builder = WebviewWindowBuilder::new(app, "main", target.clone())
        .title("Guildhall")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .user_agent(&handoff::desktop_user_agent());
    if let WebviewUrl::External(server) = target {
        // The remote page has no native bridge. Passkeys do not work in this webview, so the page
        // asks for its sign-in page as a new window; only that one goes to the system browser, and
        // every other new window is refused.
        let handle = app.clone();
        builder = builder.on_new_window(move |url, _features| {
            if handoff::is_browser_sign_in(&server, &url) {
                let state = handle.state::<handoff::PendingSignIn>().begin(Instant::now());
                let target = handoff::browser_url(&url, &state);
                let _ = handle.opener().open_url(target.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        });
    }
    builder.build()?;
    Ok(())
}

/// Finishes a browser sign-in: a `guildhall://signed-in#code=...` link sends the main window to
/// the server with the code in the fragment, where the page exchanges it for a session. Links
/// that are not a well-formed sign-in are ignored.
fn finish_sign_in<R: Runtime>(app: &AppHandle<R>, links: &[Url]) {
    let stored = settings_path(app).ok().and_then(|p| settings::load(&p));
    let (Some(server), Some(window)) = (stored, main_window(app)) else {
        return;
    };
    let pending = app.state::<handoff::PendingSignIn>();
    let arrival = links.iter().find_map(|l| handoff::code_from_deep_link(l.as_str()));
    if let Some((code, state)) = arrival.filter(|(_, s)| pending.take(s, Instant::now())) {
        let _ = window.navigate(handoff::return_url(&server, &code, &state));
        let _ = window.set_focus();
    }
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
        .manage(handoff::PendingSignIn::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
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
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| finish_sign_in(&handle, &event.urls()));
            // The app may have been launched by the link itself.
            if let Ok(Some(links)) = app.deep_link().get_current() {
                finish_sign_in(app.handle(), &links);
            }
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
    fn no_capability_exposes_the_opener_or_deep_link_plugins_to_any_page() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        for entry in std::fs::read_dir(dir).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            let capability: serde_json::Value = serde_json::from_str(&text).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                let name = permission.as_str().unwrap_or_default();
                assert!(
                    !name.starts_with("opener:") && !name.starts_with("deep-link:"),
                    "{name} would hand a page a native plugin"
                );
            }
            assert!(capability.get("remote").is_none(), "no capability may name remote urls");
        }
    }

    #[test]
    fn the_guildhall_scheme_is_registered_for_deep_links() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let schemes = conf["plugins"]["deep-link"]["desktop"]["schemes"].as_array().unwrap();
        assert!(schemes.iter().any(|s| s == handoff::SCHEME), "{schemes:?}");
    }

    #[test]
    fn the_local_page_may_call_set_server_url() {
        // Reaches the command (which rejects the empty address) instead of the ACL.
        let err = call("tauri://localhost/index.html").unwrap_err();
        assert!(!err.to_string().contains("not allowed"), "{err}");
    }
}
