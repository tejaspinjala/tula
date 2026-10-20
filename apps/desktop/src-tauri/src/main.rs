//! Guildhall desktop: a native window that opens the configured Guildhall server. The window loads
//! the remote https origin directly, so WebAuthn's RP ID stays the server's host (see
//! docs/spikes/tauri-passkeys.md). The remote page gets no native commands; only the local
//! first-run page can set the address.

mod settings;

use std::path::PathBuf;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const CHANGE_ADDRESS: &str = "change-server-address";
const TOGGLE_FULLSCREEN: &str = "toggle-fullscreen";

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("settings.json"))
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn open_window(app: &AppHandle, target: WebviewUrl) -> tauri::Result<()> {
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
fn set_server_url(app: AppHandle, address: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    let url = settings::save(&path, &address)?;
    // Defer: the calling window is the one being replaced.
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = open_window(&handle, WebviewUrl::External(url));
    });
    Ok(())
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
        .run(tauri::generate_context!())
        .expect("error while running Guildhall desktop");
}
