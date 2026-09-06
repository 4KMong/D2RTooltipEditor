use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition,
};

const TRAY_ID: &str = "tooltipeditor-main-tray";
const TRAY_PREFERENCES_ID: &str = "tray-preferences";
const TRAY_EXIT_ID: &str = "tray-exit";
const ANIMATION_MS: u64 = 300;
const ANIMATION_STEPS: u32 = 18;

#[derive(Clone, Copy)]
struct WindowRestoreSnapshot {
    position: PhysicalPosition<i32>,
    animation_position: PhysicalPosition<i32>,
    was_maximized: bool,
}

struct TrayRuntimeInner {
    preference_enabled: AtomicBool,
    hidden_to_tray: AtomicBool,
    animating: AtomicBool,
    english_ui: AtomicBool,
    restore_snapshot: Mutex<Option<WindowRestoreSnapshot>>,
}

#[derive(Clone)]
pub struct TrayRuntimeState {
    inner: Arc<TrayRuntimeInner>,
}

impl Default for TrayRuntimeState {
    fn default() -> Self {
        Self {
            inner: Arc::new(TrayRuntimeInner {
                preference_enabled: AtomicBool::new(true),
                hidden_to_tray: AtomicBool::new(false),
                animating: AtomicBool::new(false),
                english_ui: AtomicBool::new(false),
                restore_snapshot: Mutex::new(None),
            }),
        }
    }
}

fn settings_tray_enabled(app: &AppHandle) -> bool {
    let Ok(dir) = app.path().app_config_dir() else { return true; };
    let path = dir.join("ttedit_settings.json");
    let Ok(text) = fs::read_to_string(path) else { return true; };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return true; };
    value
        .get("preferences")
        .and_then(|prefs| prefs.get("systemTrayEnabled"))
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

fn settings_english_ui(app: &AppHandle) -> bool {
    let Ok(dir) = app.path().app_config_dir() else { return false; };
    let path = dir.join("ttedit_settings.json");
    let Ok(text) = fs::read_to_string(path) else { return false; };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return false; };
    value
        .get("preferences")
        .and_then(|prefs| prefs.get("uiLanguage"))
        .and_then(|value| value.as_str())
        .map(|value| value.eq_ignore_ascii_case("en"))
        .unwrap_or(false)
}

pub fn is_english(app: &AppHandle) -> bool {
    app.state::<TrayRuntimeState>().inner.english_ui.load(Ordering::SeqCst)
}

fn emit_after_restore(app: &AppHandle, event_name: Option<String>) {
    if let Some(name) = event_name {
        let _ = app.emit(&name, ());
    }
}

fn finish_restore(app: &AppHandle, inner: &TrayRuntimeInner, event_name: Option<String>) {
    inner.hidden_to_tray.store(false, Ordering::SeqCst);
    inner.animating.store(false, Ordering::SeqCst);
    if !inner.preference_enabled.load(Ordering::SeqCst) {
        let _ = app.remove_tray_by_id(TRAY_ID);
    }
    emit_after_restore(app, event_name);
}


fn request_tray_exit(app: &AppHandle) {
    let state = app.state::<TrayRuntimeState>();
    let hidden = state.inner.hidden_to_tray.load(Ordering::SeqCst);
    let animating = state.inner.animating.load(Ordering::SeqCst);
    let window = app.get_webview_window("main");
    let minimized = window
        .as_ref()
        .and_then(|window| window.is_minimized().ok())
        .unwrap_or(false);
    let visible = window
        .as_ref()
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);

    if hidden || animating || minimized || !visible {
        app.exit(0);
        return;
    }

    let _ = app.emit("ttedit-tray-exit-requested", ());
}

fn create_tray_icon(app: &AppHandle) -> Result<(), String> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let english = is_english(app);
    let preferences_label = if english { "Preferences" } else { "환경설정" };
    let exit_label = if english { "Exit" } else { "종료" };
    let tooltip = if english { "D2R Tooltip Editor" } else { "D2R 툴팁편집기" };
    let preferences = MenuItem::with_id(app, TRAY_PREFERENCES_ID, preferences_label, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let exit = MenuItem::with_id(app, TRAY_EXIT_ID, exit_label, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&preferences, &exit]).map_err(|error| error.to_string())?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(tooltip)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_PREFERENCES_ID => {
                let _ = restore_main_window(app, Some("ttedit-tray-open-preferences".to_string()));
            }
            TRAY_EXIT_ID => {
                request_tray_exit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                let _ = restore_main_window(tray.app_handle(), None);
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let enabled = settings_tray_enabled(app);
    let english = settings_english_ui(app);
    let state = app.state::<TrayRuntimeState>();
    state.inner.preference_enabled.store(enabled, Ordering::SeqCst);
    state.inner.english_ui.store(english, Ordering::SeqCst);
    state.inner.hidden_to_tray.store(false, Ordering::SeqCst);
    if enabled {
        create_tray_icon(app)?;
    } else {
        let _ = app.remove_tray_by_id(TRAY_ID);
    }
    Ok(())
}

pub fn set_ui_language(app: &AppHandle, language: &str) -> Result<(), String> {
    let state = app.state::<TrayRuntimeState>();
    let english = language.eq_ignore_ascii_case("en");
    state.inner.english_ui.store(english, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(if english { "D2R Tooltip Editor" } else { "D2R 툴팁편집기" });
    }
    let had_tray = app.tray_by_id(TRAY_ID).is_some();
    if had_tray {
        let _ = app.remove_tray_by_id(TRAY_ID);
        create_tray_icon(app)?;
    } else if state.inner.preference_enabled.load(Ordering::SeqCst)
        || state.inner.hidden_to_tray.load(Ordering::SeqCst)
    {
        create_tray_icon(app)?;
    }
    Ok(())
}

pub fn set_system_tray_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<TrayRuntimeState>();
    state.inner.preference_enabled.store(enabled, Ordering::SeqCst);
    if enabled {
        create_tray_icon(app)?;
    } else if !state.inner.hidden_to_tray.load(Ordering::SeqCst) {
        let _ = app.remove_tray_by_id(TRAY_ID);
    }
    Ok(())
}

pub fn hide_main_window_to_tray(app: &AppHandle) -> Result<(), String> {
    create_tray_icon(app)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let state = app.state::<TrayRuntimeState>().inner.clone();

    if state.hidden_to_tray.load(Ordering::SeqCst) {
        return Ok(());
    }
    if state.animating.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let app_handle = app.clone();
    thread::spawn(move || {
        let was_maximized = window.is_maximized().unwrap_or(false);
        let _ = window.unminimize();

        let start = window
            .outer_position()
            .unwrap_or_else(|_| PhysicalPosition::new(0, 0));
        let size = window.outer_size().ok();
        let work_area = native_window_work_area(&window).or_else(|| {
            let monitor = window.current_monitor().ok().flatten()?;
            let position = monitor.position();
            let size = monitor.size();
            Some((position.x, position.y, size.width as i32, size.height as i32))
        });

        let (target_x, target_y) = if let Some((work_x, work_y, work_width, work_height)) = work_area {
            let width = size.map(|value| value.width as i32).unwrap_or(800);
            let height = size.map(|value| value.height as i32).unwrap_or(600);
            let base_x = work_x + ((work_width as f64) * 0.60).round() as i32;
            let base_y = work_y + ((work_height as f64) * 0.78).round() as i32;
            let desired_x = base_x.max(start.x + (width / 4).max(120));
            let desired_y = base_y.max(start.y + (height / 5).max(90));
            (
                desired_x.min(work_x + work_width - (width / 5).max(80)),
                desired_y.min(work_y + work_height - (height / 6).max(60)),
            )
        } else {
            (start.x + 260, start.y + 180)
        };

        if let Ok(mut snapshot) = state.restore_snapshot.lock() {
            *snapshot = Some(WindowRestoreSnapshot {
                position: start,
                animation_position: PhysicalPosition::new(target_x, target_y),
                was_maximized,
            });
        }

        for step in 0..=ANIMATION_STEPS {
            let t = step as f64 / ANIMATION_STEPS as f64;
            let eased = t * t * (3.0 - 2.0 * t);
            let alpha = (255.0 * (1.0 - eased)).round().clamp(0.0, 255.0) as u8;
            let x = start.x as f64 + (target_x - start.x) as f64 * eased;
            let y = start.y as f64 + (target_y - start.y) as f64 * eased;
            move_window_for_animation(
                &window,
                PhysicalPosition::new(x.round() as i32, y.round() as i32),
                was_maximized,
            );
            set_native_window_alpha(&window, alpha);
            thread::sleep(Duration::from_millis(ANIMATION_MS / ANIMATION_STEPS as u64));
        }

        let _ = window.hide();
        set_native_window_alpha(&window, 255);
        state.hidden_to_tray.store(true, Ordering::SeqCst);
        state.animating.store(false, Ordering::SeqCst);
        let _ = app_handle.emit("ttedit-window-hidden-to-tray", ());
    });

    Ok(())
}

pub fn restore_main_window(app: &AppHandle, event_name: Option<String>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let state = app.state::<TrayRuntimeState>().inner.clone();

    if state.animating.swap(true, Ordering::SeqCst) {
        let app_handle = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(ANIMATION_MS + 80));
            let _ = restore_main_window(&app_handle, event_name);
        });
        return Ok(());
    }

    if !state.hidden_to_tray.load(Ordering::SeqCst) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        finish_restore(app, &state, event_name);
        return Ok(());
    }

    let app_handle = app.clone();
    thread::spawn(move || {
        let snapshot = state.restore_snapshot.lock().ok().and_then(|guard| *guard);
        let fallback = window
            .outer_position()
            .unwrap_or_else(|_| PhysicalPosition::new(0, 0));
        let current = snapshot
            .map(|value| value.animation_position)
            .unwrap_or(fallback);
        let target = snapshot.map(|value| value.position).unwrap_or(fallback);

        let was_maximized = snapshot.map(|value| value.was_maximized).unwrap_or(false);
        set_native_window_alpha(&window, 0);
        let _ = window.show();
        let _ = window.unminimize();
        if was_maximized && !window.is_maximized().unwrap_or(false) {
            let _ = window.maximize();
        }
        move_window_for_animation(&window, current, was_maximized);

        for step in 0..=ANIMATION_STEPS {
            let t = step as f64 / ANIMATION_STEPS as f64;
            let eased = t * t * (3.0 - 2.0 * t);
            let alpha = (255.0 * eased).round().clamp(0.0, 255.0) as u8;
            let x = current.x as f64 + (target.x - current.x) as f64 * eased;
            let y = current.y as f64 + (target.y - current.y) as f64 * eased;
            move_window_for_animation(
                &window,
                PhysicalPosition::new(x.round() as i32, y.round() as i32),
                was_maximized,
            );
            set_native_window_alpha(&window, alpha);
            thread::sleep(Duration::from_millis(ANIMATION_MS / ANIMATION_STEPS as u64));
        }

        set_native_window_alpha(&window, 255);
        move_window_for_animation(&window, target, was_maximized);
        let _ = window.set_focus();
        finish_restore(&app_handle, &state, event_name);
    });

    Ok(())
}

fn move_window_for_animation(
    window: &tauri::WebviewWindow,
    position: PhysicalPosition<i32>,
    was_maximized: bool,
) {
    if was_maximized {
        set_native_window_position(window, position);
    } else {
        let _ = window.set_position(position);
    }
}

#[cfg(target_os = "windows")]
fn native_window_handle(window: &tauri::WebviewWindow) -> Option<*mut std::ffi::c_void> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let handle = window.window_handle().ok()?.as_raw();
    match handle {
        RawWindowHandle::Win32(handle) => Some(handle.hwnd.get() as *mut std::ffi::c_void),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn native_window_work_area(window: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    use std::ffi::c_void;

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MonitorInfo {
        cb_size: u32,
        monitor: Rect,
        work: Rect,
        flags: u32,
    }

    unsafe extern "system" {
        fn MonitorFromWindow(hwnd: *mut c_void, flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(monitor: *mut c_void, info: *mut MonitorInfo) -> i32;
    }

    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    let hwnd = native_window_handle(window)?;
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return None;
    }
    let mut info = MonitorInfo {
        cb_size: std::mem::size_of::<MonitorInfo>() as u32,
        monitor: Rect { left: 0, top: 0, right: 0, bottom: 0 },
        work: Rect { left: 0, top: 0, right: 0, bottom: 0 },
        flags: 0,
    };
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return None;
    }
    Some((
        info.work.left,
        info.work.top,
        info.work.right - info.work.left,
        info.work.bottom - info.work.top,
    ))
}

#[cfg(not(target_os = "windows"))]
fn native_window_work_area(_window: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    None
}

#[cfg(target_os = "windows")]
fn set_native_window_position(window: &tauri::WebviewWindow, position: PhysicalPosition<i32>) {
    use std::{ffi::c_void, ptr};

    unsafe extern "system" {
        fn SetWindowPos(
            hwnd: *mut c_void,
            insert_after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;

    let Some(hwnd) = native_window_handle(window) else { return; };
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            ptr::null_mut(),
            position.x,
            position.y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn set_native_window_position(window: &tauri::WebviewWindow, position: PhysicalPosition<i32>) {
    let _ = window.set_position(position);
}

#[cfg(target_os = "windows")]
fn set_native_window_alpha(window: &tauri::WebviewWindow, alpha: u8) {
    use std::ffi::c_void;

    unsafe extern "system" {
        fn GetWindowLongPtrW(hwnd: *mut c_void, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: *mut c_void, index: i32, value: isize) -> isize;
        fn SetLayeredWindowAttributes(hwnd: *mut c_void, color_key: u32, alpha: u8, flags: u32) -> i32;
    }

    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_LAYERED: isize = 0x0008_0000;
    const LWA_ALPHA: u32 = 0x0000_0002;

    let Some(hwnd) = native_window_handle(window) else { return; };
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if style & WS_EX_LAYERED == 0 {
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED);
        }
        let _ = SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);
    }
}

#[cfg(not(target_os = "windows"))]
fn set_native_window_alpha(_window: &tauri::WebviewWindow, _alpha: u8) {}
