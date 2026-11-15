// Sparring desktop: a window onto the daemon. The bundled launcher page picks the daemon's address and then
// the window loads the daemon's own pages, so the desktop app is the web app with the same login cookie.
// On the Mac mini itself the launcher reads the token from ~/.sparring/config.json, so there is no login step.
// Elsewhere, build with SPARRING_DAEMON_URL set to the daemon's tailnet address and log in once with the token.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{Manager, Url, WebviewWindow, WindowEvent};

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

/// The page zoom, kept between launches in the app's config folder. View > Zoom In, Zoom Out and Actual Size
/// change it (Cmd+=, Cmd+-, Cmd+0).
struct Zoom(Mutex<f64>);

const ZOOM_STEPS: [f64; 12] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5];

fn zoom_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("zoom"))
}

fn saved_zoom(app: &tauri::AppHandle) -> f64 {
    zoom_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| t.trim().parse::<f64>().ok())
        .filter(|z| (0.5..=2.5).contains(z))
        .unwrap_or(1.0)
}

/// One step up (`dir` 1), one step down (-1), or back to 1 (0).
fn step_zoom(now: f64, dir: i8) -> f64 {
    let at = ZOOM_STEPS
        .iter()
        .enumerate()
        .min_by(|a, b| (a.1 - now).abs().total_cmp(&(b.1 - now).abs()))
        .map_or(5, |(i, _)| i);
    match dir {
        0 => 1.0,
        d if d > 0 => ZOOM_STEPS[(at + 1).min(ZOOM_STEPS.len() - 1)],
        _ => ZOOM_STEPS[at.saturating_sub(1)],
    }
}

/// Where the three window buttons are: the middle of them from the top of the window, and their right edge,
/// in points. The pages size their head from this, so the head's buttons sit on the same line.
#[cfg(target_os = "macos")]
fn window_buttons(window: &WebviewWindow) -> Option<(f64, f64)> {
    use objc2::encode::{Encode, Encoding};
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }
    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct(
            "CGRect",
            &[
                Encoding::Struct("CGPoint", &[Encoding::Double, Encoding::Double]),
                Encoding::Struct("CGSize", &[Encoding::Double, Encoding::Double]),
            ],
        );
    }

    let ns = window.ns_window().ok()? as *mut AnyObject;
    if ns.is_null() {
        return None;
    }
    unsafe {
        let frame: Rect = msg_send![ns, frame];
        let in_window = |which: usize| -> Option<Rect> {
            let button: *mut AnyObject = msg_send![ns, standardWindowButton: which];
            if button.is_null() {
                return None;
            }
            let bounds: Rect = msg_send![button, bounds];
            let nil: *const AnyObject = std::ptr::null();
            Some(msg_send![button, convertRect: bounds, toView: nil])
        };
        let close = in_window(0)?;
        let zoom = in_window(2)?;
        Some((frame.h - (close.y + close.h / 2.0), zoom.x + zoom.w))
    }
}

#[cfg(not(target_os = "macos"))]
fn window_buttons(_window: &WebviewWindow) -> Option<(f64, f64)> {
    None
}

/// Tells the page in the window what surrounds it: the zoom, and where the window buttons are (none in full
/// screen). `apps/web/src/desktop.ts` reads it.
fn push_chrome(window: &WebviewWindow) {
    let zoom = window.state::<Zoom>().0.lock().map(|z| *z).unwrap_or(1.0);
    let _ = window.set_zoom(zoom);
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        let full = w.is_fullscreen().unwrap_or(false);
        let buttons = if full { None } else { window_buttons(&w) };
        let lights = match buttons {
            Some((y, x)) => format!("{{\"y\":{y},\"x\":{x}}}"),
            None => "null".to_string(),
        };
        if std::env::var_os("SPARRING_DEBUG_CHROME").is_some() {
            eprintln!("chrome zoom={zoom} full={full} lights={lights}");
        }
        let _ = w.eval(format!(
            "window.__SPARRING_CHROME__={{\"zoom\":{zoom},\"full\":{full},\"lights\":{lights}}};window.dispatchEvent(new Event(\"sparring-chrome\"));"
        ));
    });
}

fn set_zoom(app: &tauri::AppHandle, dir: i8) {
    let Some(window) = app.get_webview_window("main") else { return };
    let next = {
        let state = app.state::<Zoom>();
        let Ok(mut z) = state.0.lock() else { return };
        *z = step_zoom(*z, dir);
        *z
    };
    if let Some(file) = zoom_file(app) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, next.to_string());
    }
    push_chrome(&window);
}

fn main() {
    tauri::Builder::default()
        // The window has no system title bar (tauri.conf.json): each page's head is the title bar. This mark
        // tells the daemon's pages so, on every page load; an older build of this app does not set it, and
        // there the pages keep their plain head (apps/web/src/desktop.ts).
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("titlebar")
                .js_init_script("window.__SPARRING_TITLEBAR__ = true;".to_string())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![local_daemon, default_daemon])
        .on_page_load(|webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            if let Some(window) = webview.app_handle().get_webview_window("main") {
                push_chrome(&window);
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Resized(_) = event {
                if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                    push_chrome(&w);
                }
            }
        })
        .setup(|app| {
            let zoom = saved_zoom(app.handle());
            app.manage(Zoom(Mutex::new(zoom)));
            let menu = Menu::default(app.handle())?;
            let change = MenuItem::with_id(app, "change-daemon", "Change Daemon…", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
                first.insert(&PredefinedMenuItem::separator(app)?, 1)?;
                first.insert(&change, 2)?;
                first.insert(&reload, 3)?;
            }
            let zoom_in = MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
            let zoom_out = MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
            let zoom_reset = MenuItem::with_id(app, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(sub) = item {
                    if sub.text().is_ok_and(|t| t == "View") {
                        sub.append(&PredefinedMenuItem::separator(app)?)?;
                        sub.append(&zoom_reset)?;
                        sub.append(&zoom_in)?;
                        sub.append(&zoom_out)?;
                    }
                }
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
                "zoom-in" => set_zoom(app, 1),
                "zoom-out" => set_zoom(app, -1),
                "zoom-reset" => set_zoom(app, 0),
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Sparring");
}
