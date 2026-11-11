// Sparring desktop: a window onto the daemon. The bundled launcher page picks the daemon's address and then
// the window loads the daemon's own pages, so the desktop app is the web app with the same login cookie.
// On the Mac mini itself the launcher reads the token from ~/.sparring/config.json, so there is no login step.
// Elsewhere, build with SPARRING_DAEMON_URL set to the daemon's tailnet address and log in once with the token.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{Manager, Url};

#[derive(Serialize)]
struct LocalDaemon {
    url: String,
    token: String,
}

/// The daemon on this machine, when there is one: its loopback address and login token.
#[tauri::command]
fn local_daemon() -> Option<LocalDaemon> {
    let home = std::env::var_os("SPARRING_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".sparring")))?;
    let text = std::fs::read_to_string(home.join("config.json")).ok()?;
    let config: serde_json::Value = serde_json::from_str(&text).ok()?;
    let token = config.get("token")?.as_str()?.to_string();
    let port = config.get("port").and_then(|p| p.as_u64()).unwrap_or(7421);
    Some(LocalDaemon { url: format!("http://127.0.0.1:{port}"), token })
}

/// The daemon address this build was made for, from `SPARRING_DAEMON_URL` at build time, so a laptop build
/// opens straight onto the Mac mini's tailnet address. A saved address and the local daemon come first.
#[tauri::command]
fn default_daemon() -> Option<&'static str> {
    option_env!("SPARRING_DAEMON_URL").filter(|s| !s.is_empty())
}

/// The bundled launcher page. `change` keeps it from connecting straight away.
fn launcher_url(change: bool) -> Url {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    let query = if change { "?change=1" } else { "" };
    Url::parse(&format!("{base}{query}")).expect("launcher url")
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![local_daemon, default_daemon])
        .setup(|app| {
            let menu = Menu::default(app.handle())?;
            let change = MenuItem::with_id(app, "change-daemon", "Change Daemon…", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
                first.insert(&PredefinedMenuItem::separator(app)?, 1)?;
                first.insert(&change, 2)?;
                first.insert(&reload, 3)?;
            }
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else { return };
            match event.id().as_ref() {
                "change-daemon" => {
                    let _ = window.navigate(launcher_url(true));
                }
                "reload" => {
                    let _ = window.eval("location.reload()");
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Sparring");
}
