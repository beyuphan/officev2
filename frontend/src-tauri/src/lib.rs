mod clipboard;
mod screen;

use std::collections::HashMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

/// The Python sidecar plus the credentials the UI needs to talk to it.
struct Engine {
    port: u16,
    token: String,
    child: Mutex<Option<Child>>,
}

#[derive(Serialize)]
struct EngineInfo {
    port: u16,
    token: String,
}

#[tauri::command]
fn engine_info(state: State<Engine>) -> EngineInfo {
    EngineInfo { port: state.port, token: state.token.clone() }
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// Dev layout: <repo>/backend. Override with LOCALFLOW_BACKEND_DIR.
/// TODO: production builds must bundle the sidecar executable instead.
fn backend_dir() -> PathBuf {
    std::env::var("LOCALFLOW_BACKEND_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend"))
}

fn spawn_engine(port: u16, token: &str) -> Result<Child, String> {
    let dir = backend_dir();
    let python = std::env::var("LOCALFLOW_PYTHON").map(PathBuf::from).unwrap_or_else(|_| {
        if cfg!(windows) {
            dir.join("venv/Scripts/python.exe")
        } else {
            dir.join("venv/bin/python")
        }
    });

    let mut cmd = Command::new(&python);
    cmd.args(["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .current_dir(&dir)
        .env("LOCALFLOW_TOKEN", token);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    cmd.spawn().map_err(|e| format!("failed to start engine ({}): {e}", python.display()))
}

/* ---------------------------------- clipboard history ---------------------------------- */

type Clips<'a> = State<'a, Arc<clipboard::Store>>;

#[tauri::command]
fn clip_list(store: Clips, query: Option<String>) -> Result<Vec<clipboard::Clip>, String> {
    store.list(query).map_err(|e| e.to_string())
}

#[tauri::command]
fn clip_copy(store: Clips, id: i64) -> Result<(), String> {
    if let Some(text) = store.text_of(id) {
        return set_clipboard(text);
    }
    let png = store.image_png(id).ok_or("that item no longer exists")?;
    clipboard::copy_image(&png)
}

#[tauri::command]
fn clip_pin(store: Clips, id: i64, pinned: bool) -> Result<(), String> {
    store.set_pinned(id, pinned).map_err(|e| e.to_string())
}

#[tauri::command]
fn clip_delete(store: Clips, id: i64) -> Result<(), String> {
    store.delete(id).map_err(|e| e.to_string())
}

#[tauri::command]
fn clip_clear(store: Clips) -> Result<usize, String> {
    store.clear_unpinned().map_err(|e| e.to_string())
}

#[tauri::command]
fn clip_paused(store: Clips) -> bool {
    store.paused()
}

#[tauri::command]
fn clip_set_paused(store: Clips, paused: bool) {
    store.set_paused(paused);
}

#[tauri::command]
fn set_clipboard(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
}

/* ------------------------- screen tools: color, pin, text capture ------------------------- */

/// Data handed to overlay windows (pinned image path, screenshot path), keyed by window label.
#[derive(Default)]
struct Overlays {
    payloads: Mutex<HashMap<String, String>>,
    next_pin: AtomicU32,
}

#[tauri::command]
fn pick_color() -> Result<String, String> {
    screen::pixel_at_cursor()
}

#[tauri::command]
fn overlay_payload(window: tauri::Window, state: State<Overlays>) -> Option<String> {
    state.payloads.lock().unwrap().get(window.label()).cloned()
}

#[tauri::command]
async fn pin_image(app: AppHandle, state: State<'_, Overlays>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let ok_ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif"))
        .unwrap_or(false);
    if !p.is_file() || !ok_ext {
        return Err("choose a PNG, JPG, WebP, BMP or GIF image".into());
    }
    let label = format!("pin-{}", state.next_pin.fetch_add(1, Ordering::Relaxed));
    state.payloads.lock().unwrap().insert(label.clone(), path);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Pinned image")
        .inner_size(420.0, 320.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn start_snip(app: AppHandle, state: State<'_, Overlays>) -> Result<(), String> {
    if app.get_webview_window("snip").is_some() {
        return Ok(());
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide(); // keep officev2 itself out of the screenshot
    }
    std::thread::sleep(Duration::from_millis(350));
    let path = std::env::temp_dir().join(format!("officev2-snip-{}.png", Uuid::new_v4().simple()));
    if let Err(e) = screen::capture_primary(&path) {
        show_main_window(&app);
        return Err(e);
    }
    state.payloads.lock().unwrap().insert("snip".into(), path.to_string_lossy().into_owned());
    let built = WebviewWindowBuilder::new(&app, "snip", WebviewUrl::default())
        .title("Select text")
        .fullscreen(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build();
    if let Err(e) = built {
        let _ = std::fs::remove_file(&path);
        show_main_window(&app);
        return Err(e.to_string());
    }
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

#[tauri::command]
fn finish_snip(app: AppHandle, state: State<Overlays>) {
    if let Some(path) = state.payloads.lock().unwrap().remove("snip") {
        let _ = std::fs::remove_file(path); // the screenshot is never kept
    }
    if let Some(w) = app.get_webview_window("snip") {
        let _ = w.close();
    }
    show_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Overlays::default())
        .setup(|app| {
            let port = free_port()?;
            let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            let child = match spawn_engine(port, &token) {
                Ok(c) => Some(c),
                Err(e) => {
                    eprintln!("{e}");
                    None
                }
            };
            app.manage(Engine { port, token, child: Mutex::new(child) });

            match clipboard::Store::open(clipboard::data_dir().join("clipboard.db")) {
                Ok(store) => {
                    let store = Arc::new(store);
                    clipboard::spawn_watcher(store.clone());
                    app.manage(store);
                }
                Err(e) => eprintln!("clipboard history unavailable: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_info,
            clip_list,
            clip_copy,
            clip_pin,
            clip_delete,
            clip_clear,
            clip_paused,
            clip_set_paused,
            set_clipboard,
            pick_color,
            overlay_payload,
            pin_image,
            start_snip,
            finish_snip,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(engine) = handle.try_state::<Engine>() {
                if let Some(mut child) = engine.child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
