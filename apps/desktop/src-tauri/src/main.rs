// Sparring desktop: a window onto the daemon. The bundled launcher page picks the daemon's address and then
// the window loads the daemon's own pages, so the desktop app is the web app with the same login cookie.
// On the Mac mini itself the launcher reads the token from ~/.sparring/config.json, so there is no login step.
// Elsewhere, build with SPARRING_DAEMON_URL set to the daemon's tailnet address and log in once with the token.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
            "window.__SPARRING_CHROME__={{\"zoom\":{zoom},\"full\":{full},\"hooks\":true,\"lights\":{lights}}};window.dispatchEvent(new Event(\"sparring-chrome\"));"
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
    if std::env::var_os("SPARRING_DEBUG_CHROME").is_some() {
        eprintln!("zoom -> {next} file={:?}", zoom_file(app));
    }
    if let Some(file) = zoom_file(app) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, next.to_string());
    }
    push_chrome(&window);
}

// ───────────────────────────── updates ─────────────────────────────
//
// The daemon serves the newest build of this app next to its pages: `/app/latest.json` names it and
// `/app/Sparring.zip` is it (`pnpm app:release` puts them there). The app asks when a page loads, at most every
// half hour, and from Sparring > Check for Updates. A newer build is downloaded, checked against the hash in
// `latest.json`, and put in this app's place; it runs from the next launch, and the page offers a restart.
// Only the daemon this build was made for, or the one on this machine, is ever asked.

/// When this build was made (`SPARRING_APP_BUILD`, UTC digits). A build without it never updates itself.
const APP_BUILD: Option<&str> = option_env!("SPARRING_APP_BUILD");

#[derive(Default)]
struct Updates {
    busy: AtomicBool,
    last: Mutex<Option<Instant>>,
    /// The build that was installed and waits for a restart.
    ready: Mutex<Option<String>>,
}

fn origin_of(url: &Url) -> Option<String> {
    match url.scheme() {
        "http" | "https" => Some(url.origin().ascii_serialization()),
        _ => None,
    }
}

/// True for the daemon this build was made for and the one on this machine: the only places the app takes
/// orders (`/__app/…`) or updates from.
fn is_daemon(url: &Url) -> bool {
    let Some(origin) = origin_of(url) else { return false };
    let known = [default_daemon().map(str::to_string), local_daemon().map(|d| d.url)];
    known.into_iter().flatten().any(|k| Url::parse(&k).ok().and_then(|u| origin_of(&u)) == Some(origin.clone()))
}

/// Says one line in the page (apps/web/src/desktop.ts shows it for a few seconds).
fn note(app: &tauri::AppHandle, text: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    let text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent(\"sparring-app-note\",{{detail:{text}}}));"
    ));
}

/// Tells the page that a newer build is installed and a restart will run it.
fn push_update(window: &WebviewWindow) {
    let ready = window.state::<Updates>().ready.lock().ok().and_then(|r| r.clone());
    if let Some(build) = ready {
        let build = serde_json::to_string(&build).unwrap_or_else(|_| "\"\"".into());
        let _ = window.eval(format!(
            "window.__SPARRING_APP_UPDATE__={{\"build\":{build}}};window.dispatchEvent(new Event(\"sparring-app-update\"));"
        ));
    }
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// This app's bundle (`…/Sparring.app`), when it is an installed one: not a build folder, and replaceable.
fn bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let app = exe.parent()?.parent()?.parent()?.to_path_buf();
    let ok = app.extension().is_some_and(|e| e == "app") && !app.components().any(|c| c.as_os_str() == "target");
    ok.then_some(app)
}

/// Downloads the build `latest.json` names and puts it in this app's place. Err is why not, in words.
fn install(origin: &str, sha256: &str, app: &Path) -> Result<(), String> {
    let parent = app.parent().ok_or("the app has no folder")?;
    let stage = parent.join(format!(".sparring-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|e| format!("cannot write next to the app · {e}"))?;
    let done = (|| {
        let zip = stage.join("Sparring.zip");
        let zip_s = zip.to_string_lossy().into_owned();
        run("/usr/bin/curl", &["-fsS", "--max-time", "600", "-o", &zip_s, &format!("{origin}/app/Sparring.zip")])
            .ok_or("the download failed")?;
        let sum = run("/usr/bin/shasum", &["-a", "256", &zip_s]).ok_or("could not check the download")?;
        if sum.split_whitespace().next() != Some(sha256) {
            return Err("the download does not match its checksum".to_string());
        }
        run("/usr/bin/ditto", &["-x", "-k", &zip_s, &stage.to_string_lossy()]).ok_or("could not unpack it")?;
        let fresh = stage.join("Sparring.app");
        if !fresh.join("Contents/MacOS").is_dir() {
            return Err("the download is not the app".to_string());
        }
        let old = stage.join("old.app");
        std::fs::rename(app, &old).map_err(|e| format!("cannot replace the app · {e}"))?;
        if let Err(e) = std::fs::rename(&fresh, app) {
            let _ = std::fs::rename(&old, app);
            return Err(format!("cannot replace the app · {e}"));
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&stage);
    done
}

/// Asks the daemon at `origin` for a newer build and installs it. `loud` says what happened either way.
fn check_update(app: tauri::AppHandle, origin: String, loud: bool) {
    let state = app.state::<Updates>();
    if !loud {
        let Ok(mut last) = state.last.lock() else { return };
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(30 * 60)) {
            return;
        }
        *last = Some(Instant::now());
    }
    if state.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let said = (|| -> Result<Option<String>, String> {
            let mine = APP_BUILD.filter(|b| !b.is_empty()).ok_or("this build does not update itself")?;
            let target = bundle().ok_or("this copy runs from a build folder, so it is left alone")?;
            if app.state::<Updates>().ready.lock().is_ok_and(|r| r.is_some()) {
                return Ok(None);
            }
            let text = run("/usr/bin/curl", &["-fsS", "--max-time", "15", &format!("{origin}/app/latest.json")])
                .ok_or("could not ask the daemon for updates")?;
            let latest: serde_json::Value =
                serde_json::from_str(&text).map_err(|_| "the daemon has no app build to offer".to_string())?;
            let build = latest.get("build").and_then(|b| b.as_str()).ok_or("the daemon has no app build to offer")?;
            let sha = latest.get("sha256").and_then(|b| b.as_str()).ok_or("the daemon's app build has no checksum")?;
            if !build.bytes().all(|b| b.is_ascii_digit()) || build <= mine {
                return Ok(Some(format!("the Sparring app is up to date · build {mine}")));
            }
            install(&origin, sha, &target)?;
            if let Ok(mut ready) = app.state::<Updates>().ready.lock() {
                *ready = Some(build.to_string());
            }
            Ok(None)
        })();
        app.state::<Updates>().busy.store(false, Ordering::SeqCst);
        if std::env::var_os("SPARRING_DEBUG_CHROME").is_some() {
            eprintln!("update check at {origin}: {said:?}");
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            match said {
                Ok(None) => {
                    if let Some(w) = handle.get_webview_window("main") {
                        push_update(&w);
                    }
                }
                Ok(Some(line)) if loud => note(&handle, &line),
                Err(why) if loud => note(&handle, &format!("no update · {why}")),
                _ => {}
            }
        });
    });
}

/// What a page asks of the app by going to `/__app/<name>` on the daemon: the visit is refused and the thing is
/// done. A page has no other way in (it gets no IPC beyond moving the window).
fn page_asks(app: &tauri::AppHandle, url: &Url) -> bool {
    let Some(ask) = url.path().strip_prefix("/__app/") else { return false };
    if !is_daemon(url) {
        return false;
    }
    match ask {
        "zoom-reset" => set_zoom(app, 0),
        "zoom-in" => set_zoom(app, 1),
        "zoom-out" => set_zoom(app, -1),
        "restart" => app.restart(),
        _ => {}
    }
    true
}

fn main() {
    tauri::Builder::default()
        // The window has no system title bar (tauri.conf.json): each page's head is the title bar. This mark
        // tells the daemon's pages so, on every page load; an older build of this app does not set it, and
        // there the pages keep their plain head (apps/web/src/desktop.ts).
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("titlebar")
                .js_init_script("window.__SPARRING_TITLEBAR__ = true;".to_string())
                .on_navigation(|webview, url| !page_asks(webview.app_handle(), url))
                .build(),
        )
        .invoke_handler(tauri::generate_handler![local_daemon, default_daemon])
        .on_page_load(|webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let app = webview.app_handle();
            if let Some(window) = app.get_webview_window("main") {
                push_chrome(&window);
                push_update(&window);
            }
            if is_daemon(payload.url()) {
                if let Some(origin) = origin_of(payload.url()) {
                    check_update(app.clone(), origin, false);
                }
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
            app.manage(Updates::default());
            let menu = Menu::default(app.handle())?;
            let change = MenuItem::with_id(app, "change-daemon", "Change Daemon…", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let update = MenuItem::with_id(app, "check-update", "Check for Updates…", true, None::<&str>)?;
            if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
                first.insert(&PredefinedMenuItem::separator(app)?, 1)?;
                first.insert(&change, 2)?;
                first.insert(&reload, 3)?;
                first.insert(&update, 1)?;
            }
            let zoom_in = MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
            let zoom_out = MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
            let zoom_reset = MenuItem::with_id(app, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(sub) = item {
                    if std::env::var_os("SPARRING_DEBUG_CHROME").is_some() {
                        eprintln!("menu {:?}", sub.text());
                    }
                    if sub.text().is_ok_and(|t| t == "View") {
                        sub.append(&PredefinedMenuItem::separator(app)?)?;
                        sub.append(&zoom_reset)?;
                        sub.append(&zoom_in)?;
                        sub.append(&zoom_out)?;
                    }
                }
            }
            app.set_menu(menu)?;
            if std::env::var_os("SPARRING_DEBUG_ZOOM").is_some() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || set_zoom(&h, 1));
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Some(w) = h.get_webview_window("main") {
                            let _ = w.eval("location.href = '/__app/zoom-reset'");
                        }
                    });
                });
            }
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
                "check-update" => match window.url().ok().filter(is_daemon).and_then(|u| origin_of(&u)) {
                    Some(origin) => check_update(app.clone(), origin, true),
                    None => note(app, "no update · connect to the daemon first"),
                },
                "zoom-in" => set_zoom(app, 1),
                "zoom-out" => set_zoom(app, -1),
                "zoom-reset" => set_zoom(app, 0),
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Sparring");
}
