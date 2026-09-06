use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Size, State,
};

const SPLASH_LABEL: &str = "startup-splash";
const MAIN_LABEL: &str = "main";
const MIN_SPLASH_MS: u64 = 3_000;
const KEEP_ON_TOP_INTERVAL_MS: u64 = 50;

struct StartupSplashInner {
    started_at: Mutex<Instant>,
    progress: AtomicU8,
    finishing: AtomicBool,
    completed: AtomicBool,
}

#[derive(Clone)]
pub struct StartupSplashState {
    inner: Arc<StartupSplashInner>,
}

impl Default for StartupSplashState {
    fn default() -> Self {
        Self {
            inner: Arc::new(StartupSplashInner {
                started_at: Mutex::new(Instant::now()),
                progress: AtomicU8::new(0),
                finishing: AtomicBool::new(false),
                completed: AtomicBool::new(false),
            }),
        }
    }
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<StartupSplashState>();
    if let Ok(mut started_at) = state.inner.started_at.lock() {
        *started_at = Instant::now();
    }
    state.inner.progress.store(0, Ordering::SeqCst);
    state.inner.finishing.store(false, Ordering::SeqCst);
    state.inner.completed.store(false, Ordering::SeqCst);

    if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
        let _ = splash.set_focusable(false);
        let _ = splash.set_always_on_top(true);
        apply_splash_no_activate(&splash);
    }

    update_progress(app, &state.inner, 10);
    Ok(())
}

fn update_progress(app: &AppHandle, inner: &StartupSplashInner, progress: u8) {
    let clamped = progress.min(100);
    inner.progress.store(clamped, Ordering::SeqCst);
    if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
        let _ = splash.emit("ttedit-splash-progress", clamped);
    }
}

#[tauri::command]
pub fn get_startup_splash_progress(state: State<'_, StartupSplashState>) -> u8 {
    state.inner.progress.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn set_startup_splash_progress(
    app: AppHandle,
    state: State<'_, StartupSplashState>,
    progress: u8,
) -> Result<(), String> {
    update_progress(&app, &state.inner, progress);
    keep_splash_on_top(&app);
    Ok(())
}

#[tauri::command]
pub fn resize_startup_splash(
    app: AppHandle,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let width = width.clamp(64, 4_096);
    let height = height.clamp(64, 4_096);
    let splash = app
        .get_webview_window(SPLASH_LABEL)
        .ok_or_else(|| "startup splash window not found".to_string())?;
    splash
        .set_size(Size::Logical(LogicalSize::new(width as f64, height as f64)))
        .map_err(|error| error.to_string())?;
    let _ = splash.center();
    apply_splash_no_activate(&splash);
    Ok(())
}

#[tauri::command]
pub fn read_startup_splash_image_data_url(app: AppHandle) -> Result<Option<String>, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("assets").join("loading.png"));
        candidates.push(resource_dir.join("app").join("assets").join("loading.png"));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("loading.png"));
        }
    }

    candidates.sort();
    candidates.dedup();

    for path in candidates {
        if !path.is_file() {
            continue;
        }
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        if bytes.is_empty() {
            continue;
        }
        return Ok(Some(format!(
            "data:image/png;base64,{}",
            base64_encode(&bytes)
        )));
    }

    Ok(None)
}

#[tauri::command]
pub fn finish_startup_splash(
    app: AppHandle,
    state: State<'_, StartupSplashState>,
    start_maximized: bool,
) -> Result<(), String> {
    update_progress(&app, &state.inner, 100);
    if state.inner.finishing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let app_handle = app.clone();
    let inner = state.inner.clone();
    thread::spawn(move || {
        loop {
            let elapsed = inner
                .started_at
                .lock()
                .map(|started_at| started_at.elapsed())
                .unwrap_or_else(|_| Duration::from_millis(MIN_SPLASH_MS));
            if elapsed >= Duration::from_millis(MIN_SPLASH_MS) {
                break;
            }
            keep_splash_on_top(&app_handle);
            let remaining = Duration::from_millis(MIN_SPLASH_MS).saturating_sub(elapsed);
            thread::sleep(remaining.min(Duration::from_millis(KEEP_ON_TOP_INTERVAL_MS)));
        }

        keep_splash_on_top(&app_handle);
        if let Some(splash) = app_handle.get_webview_window(SPLASH_LABEL) {
            let _ = splash.close();
        }
        if let Some(main) = app_handle.get_webview_window(MAIN_LABEL) {
            if start_maximized {
                let _ = main.maximize();
            }
            let _ = main.show();
            let _ = main.set_focus();
        }
        inner.completed.store(true, Ordering::SeqCst);
    });

    Ok(())
}


pub fn restore_or_defer(app: &AppHandle) {
    let state = app.state::<StartupSplashState>();
    if state.inner.completed.load(Ordering::SeqCst) {
        let _ = crate::tray_lifecycle::restore_main_window(app, None);
    }
}

fn keep_splash_on_top(app: &AppHandle) {
    if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
        apply_splash_no_activate(&splash);
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    let mut index = 0;
    while index < bytes.len() {
        let b0 = bytes[index];
        let b1 = if index + 1 < bytes.len() { bytes[index + 1] } else { 0 };
        let b2 = if index + 2 < bytes.len() { bytes[index + 2] } else { 0 };
        let packed = ((b0 as u32) << 16) | ((b1 as u32) << 8) | b2 as u32;
        out.push(TABLE[((packed >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((packed >> 12) & 0x3f) as usize] as char);
        if index + 1 < bytes.len() {
            out.push(TABLE[((packed >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if index + 2 < bytes.len() {
            out.push(TABLE[(packed & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        index += 3;
    }
    out
}

#[cfg(target_os = "windows")]
mod windows_no_activate {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::ffi::c_void;

    type Hwnd = *mut c_void;
    type SubclassProc = unsafe extern "system" fn(Hwnd, u32, usize, isize, usize, usize) -> isize;

    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_NOACTIVATE: isize = 0x0800_0000;
    const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    const WM_MOUSEACTIVATE: u32 = 0x0021;
    const WM_NCDESTROY: u32 = 0x0082;
    const MA_NOACTIVATE: isize = 3;
    const SUBCLASS_ID: usize = 0x5454_4553;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize;
        fn SetWindowPos(
            hwnd: Hwnd,
            insert_after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
    }

    #[link(name = "comctl32")]
    unsafe extern "system" {
        fn SetWindowSubclass(
            hwnd: Hwnd,
            proc: Option<SubclassProc>,
            id: usize,
            data: usize,
        ) -> i32;
        fn DefSubclassProc(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
        fn RemoveWindowSubclass(hwnd: Hwnd, proc: Option<SubclassProc>, id: usize) -> i32;
    }

    pub fn apply(window: &tauri::WebviewWindow) {
        let Ok(handle) = window.window_handle() else {
            return;
        };
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return;
        };
        let hwnd = handle.hwnd.get() as Hwnd;
        let hwnd_topmost = (-1isize) as Hwnd;

        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);
            let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
            let _ = SetWindowPos(
                hwnd,
                hwnd_topmost,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: Hwnd,
        message: u32,
        wparam: usize,
        lparam: isize,
        subclass_id: usize,
        _reference_data: usize,
    ) -> isize {
        if message == WM_MOUSEACTIVATE {
            return MA_NOACTIVATE;
        }
        if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), subclass_id);
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}

#[cfg(target_os = "windows")]
fn apply_splash_no_activate(window: &tauri::WebviewWindow) {
    windows_no_activate::apply(window);
}

#[cfg(not(target_os = "windows"))]
fn apply_splash_no_activate(window: &tauri::WebviewWindow) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_focusable(false);
}
