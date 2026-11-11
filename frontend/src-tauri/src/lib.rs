mod clipboard;
mod screen;

/// The engine starts helper processes of its own (a pool of workers for long jobs). Killing only the engine would leave
/// them running, holding files open, so they all live in one Windows "job" that ends together.
#[cfg(windows)]
mod procjob {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);
    // SAFETY: a job handle is only used through the Win32 calls below, which are thread-safe
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// A job that also ends everything in it when the app itself goes away, however it ends.
        pub fn new() -> Option<Job> {
            // SAFETY: plain Win32 calls; the limit structure is zero-filled and only the one flag is set
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
                if ok == 0 {
                    CloseHandle(h);
                    return None;
                }
                Some(Job(h))
            }
        }
        pub fn add(&self, child: &std::process::Child) {
            // SAFETY: both handles are valid for the duration of the call
            unsafe {
                AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE);
            }
        }
        pub fn end_all(&self) {
            // SAFETY: the handle is valid until the Job is dropped
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closing our own handle; with the kill-on-close flag this also ends whatever is still inside
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod procjob {
    pub struct Job;
    impl Job {
        pub fn new() -> Option<Job> {
            Some(Job)
        }
        pub fn add(&self, _child: &std::process::Child) {}
        pub fn end_all(&self) {}
    }
}

use std::collections::HashMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use uuid::Uuid;

/// The Python sidecar plus the credentials the UI needs to talk to it.
struct Engine {
    port: u16,
    token: String,
    child: Mutex<Option<Child>>,
    /// the engine and everything it starts
    job: Mutex<procjob::Job>,
    /// the engine folder inside the installed app (python + code); None when running from the source tree
    packaged: Option<PathBuf>,
}

/// Files the app was asked to open (double click, right click, command line) that the window has not taken yet.
struct OpenQueue(Mutex<Vec<String>>);

#[derive(Serialize)]
struct EngineInfo {
    port: u16,
    token: String,
}

/// The files the app was started with (or asked to open since); the window calls this when it is ready.
#[tauri::command]
fn take_open_args(queue: State<OpenQueue>) -> Vec<String> {
    std::mem::take(&mut *queue.0.lock().unwrap())
}

#[tauri::command]
fn engine_info(state: State<Engine>) -> EngineInfo {
    EngineInfo { port: state.port, token: state.token.clone() }
}

/// Start the engine again on the same port and token (it stopped while the app was open).
#[tauri::command]
fn restart_engine(state: State<Engine>) -> Result<(), String> {
    let mut child = state.child.lock().unwrap();
    let mut job = state.job.lock().unwrap();
    job.end_all();
    if let Some(mut old) = child.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    *job = procjob::Job::new().ok_or("could not prepare the engine")?;
    let fresh = spawn_engine(state.port, &state.token, state.packaged.as_deref())?;
    job.add(&fresh);
    *child = Some(fresh);
    Ok(())
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

/// The engine folder the installer puts next to the app, when it is there.
fn packaged_engine(app: &tauri::App) -> Option<PathBuf> {
    let dist = app.path().resource_dir().ok()?.join("engine-dist");
    dist.join("python").join("python.exe").is_file().then_some(dist)
}

fn spawn_engine(port: u16, token: &str, packaged: Option<&std::path::Path>) -> Result<Child, String> {
    let dir = packaged.map(|d| d.join("app")).unwrap_or_else(backend_dir);
    let python = std::env::var("LOCALFLOW_PYTHON").map(PathBuf::from).unwrap_or_else(|_| {
        if let Some(dist) = packaged {
            dist.join("python").join("python.exe")
        } else if cfg!(windows) {
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

    // what the engine prints goes to a log file, so a crash can be looked at afterwards
    let log_dir = clipboard::data_dir().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    if let Ok(log) = std::fs::OpenOptions::new().create(true).append(true).open(log_dir.join("engine.log")) {
        if let Ok(err) = log.try_clone() {
            cmd.stderr(err);
        }
        cmd.stdout(log);
    }

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

/* ---------------------- clipboard pop-up: one shortcut, anywhere in Windows ---------------------- */

const POPUP: &str = "clip-popup";
const POPUP_SIZE: (f64, f64) = (380.0, 500.0);

/// Open the clipboard list next to the mouse pointer, or close it when it is already open.
fn toggle_clip_popup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(POPUP) {
        let _ = w.close();
        return;
    }
    let mut builder = WebviewWindowBuilder::new(app, POPUP, WebviewUrl::default())
        .title("Clipboard")
        .inner_size(POPUP_SIZE.0, POPUP_SIZE.1)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(true);
    if let Some((x, y)) = popup_position() {
        builder = builder.position(x, y);
    } else {
        builder = builder.center();
    }
    if let Err(e) = builder.build() {
        eprintln!("clipboard pop-up failed: {e}");
    }
}

/// Where the pop-up goes: at the pointer, moved back inside the screen when it would hang off an edge.
#[cfg(windows)]
fn popup_position() -> Option<(f64, f64)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    let mut p = POINT { x: 0, y: 0 };
    // SAFETY: plain Win32 calls with a valid out pointer
    let (ok, sw, sh) = unsafe { (GetCursorPos(&mut p), GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    if ok == 0 || sw <= 0 || sh <= 0 {
        return None;
    }
    Some(clamp_to_screen(p.x as f64, p.y as f64, sw as f64, sh as f64))
}

#[cfg(not(windows))]
fn popup_position() -> Option<(f64, f64)> {
    None
}

fn clamp_to_screen(x: f64, y: f64, sw: f64, sh: f64) -> (f64, f64) {
    // the window size is in logical pixels; on a scaled screen it can be a bit larger, so leave some room
    let (w, h) = (POPUP_SIZE.0 * 1.25, POPUP_SIZE.1 * 1.25);
    ((x - 12.0).clamp(0.0, (sw - w).max(0.0)), (y - 12.0).clamp(0.0, (sh - h).max(0.0)))
}

/// Press Ctrl+V in whatever window has the focus.
#[cfg(windows)]
fn send_paste() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VK_CONTROL};
    fn key(vk: u16, up: bool) -> INPUT {
        INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { 0 }, time: 0, dwExtraInfo: 0 } } }
    }
    let inputs = [key(VK_CONTROL, false), key(0x56, false), key(0x56, true), key(VK_CONTROL, true)];
    // SAFETY: the array lives for the call and the size matches INPUT
    unsafe {
        SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(not(windows))]
fn send_paste() {}

/// Put the chosen item on the clipboard, close the pop-up and paste it into the window that was in front before.
#[tauri::command]
fn clip_paste(app: AppHandle, store: Clips, id: i64) -> Result<(), String> {
    clip_copy(store, id)?;
    if let Some(w) = app.get_webview_window(POPUP) {
        let _ = w.close();
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(160)); // the focus has to go back to the other program first
        send_paste();
    });
    Ok(())
}

/// With the tray icon in place, closing the window only hides it so the clipboard keeps being recorded.
struct KeepRunning(AtomicBool);

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open officev2", true, None::<&str>)?;
    let clip = MenuItem::with_id(app, "clip", "Clipboard (Ctrl+Shift+V)", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &clip, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("officev2")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "clip" => toggle_clip_popup(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
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
        // a second start (a double click on another file) hands its files to the running app instead of opening a second one
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let files: Vec<String> = args.into_iter().skip(1).collect();
            if let Some(q) = app.try_state::<OpenQueue>() {
                q.0.lock().unwrap().extend(files.iter().cloned());
            }
            show_main_window(app);
            let _ = app.emit("open-files", files);
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_clip_popup(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let keep = window.app_handle().try_state::<KeepRunning>().map(|k| k.0.load(Ordering::Relaxed)).unwrap_or(false);
                if window.label() == "main" && keep {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .manage(Overlays::default())
        .setup(|app| {
            let port = free_port()?;
            let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            let packaged = packaged_engine(app);
            let job = procjob::Job::new().ok_or("could not prepare the engine")?;
            let child = match spawn_engine(port, &token, packaged.as_deref()) {
                Ok(c) => {
                    job.add(&c);
                    Some(c)
                }
                Err(e) => {
                    eprintln!("{e}");
                    None
                }
            };
            app.manage(Engine { port, token, child: Mutex::new(child), job: Mutex::new(job), packaged });

            // what the app was started with: files to open, and --hidden when Windows starts it at log-in
            let args: Vec<String> = std::env::args().skip(1).collect();
            let hidden = args.iter().any(|a| a == "--hidden");
            app.manage(OpenQueue(Mutex::new(args.into_iter().filter(|a| a != "--hidden").collect())));
            if hidden {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            match clipboard::Store::open(clipboard::data_dir().join("clipboard.db")) {
                Ok(store) => {
                    let store = Arc::new(store);
                    clipboard::spawn_watcher(store.clone());
                    app.manage(store);
                }
                Err(e) => eprintln!("clipboard history unavailable: {e}"),
            }
            let tray_ok = setup_tray(app).map_err(|e| eprintln!("tray icon unavailable: {e}")).is_ok();
            app.manage(KeepRunning(AtomicBool::new(tray_ok)));
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyV);
            if let Err(e) = app.global_shortcut().register(shortcut) {
                eprintln!("Ctrl+Shift+V is taken by another program: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_info,
            take_open_args,
            restart_engine,
            clip_list,
            clip_copy,
            clip_paste,
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
                engine.job.lock().unwrap().end_all(); // the engine and its helper processes
                if let Some(mut child) = engine.child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::clamp_to_screen;

    #[test]
    fn popup_stays_on_screen() {
        assert_eq!(clamp_to_screen(100.0, 100.0, 1920.0, 1080.0), (88.0, 88.0));
        let (x, y) = clamp_to_screen(1915.0, 1075.0, 1920.0, 1080.0);
        assert!(x + 380.0 <= 1920.0 && y + 500.0 <= 1080.0);
        assert_eq!(clamp_to_screen(0.0, 0.0, 1920.0, 1080.0), (0.0, 0.0));
    }
}
