#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, process::Command};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

mod tray_lifecycle;
mod startup_splash;

#[cfg(target_os = "windows")]
mod single_instance {
    use std::{
        ffi::{c_void, OsStr},
        fs,
        os::windows::ffi::OsStrExt,
        path::{Path, PathBuf},
        ptr,
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tauri::{AppHandle, Emitter};

    const ERROR_ALREADY_EXISTS: u32 = 183;
    const EVENT_MODIFY_STATE: u32 = 0x0002;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const WAIT_OBJECT_0: u32 = 0;
    const SW_RESTORE: i32 = 9;
    const SW_SHOW: i32 = 5;

    type Handle = *mut c_void;

    unsafe extern "system" {
        fn CreateMutexW(lp_mutex_attributes: *mut c_void, b_initial_owner: i32, lp_name: *const u16) -> Handle;
        fn CreateEventW(lp_event_attributes: *mut c_void, manual_reset: i32, initial_state: i32, name: *const u16) -> Handle;
        fn OpenEventW(desired_access: u32, inherit_handle: i32, name: *const u16) -> Handle;
        fn SetEvent(event: Handle) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn GetLastError() -> u32;
        fn CloseHandle(h_object: Handle) -> i32;
        fn FindWindowW(lp_class_name: *const u16, lp_window_name: *const u16) -> Handle;
        fn IsIconic(hwnd: Handle) -> i32;
        fn ShowWindow(hwnd: Handle, n_cmd_show: i32) -> i32;
        fn SetForegroundWindow(hwnd: Handle) -> i32;
    }

    fn wide_null(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn event_name() -> Vec<u16> {
        wide_null("Local\\JimSSng_D2R_TooltipEditor_RestoreEvent")
    }

    fn pending_open_dir() -> PathBuf {
        std::env::temp_dir().join("JimSSng_D2R_TooltipEditor_OpenQueue")
    }

    fn is_txt_file(path: &Path) -> bool {
        path.is_file() && path.extension().and_then(|value| value.to_str()).map(|ext| ext.eq_ignore_ascii_case("txt")).unwrap_or(false)
    }

    fn normalized_path_strings(paths: &[PathBuf]) -> Vec<String> {
        let mut out = Vec::new();
        for path in paths {
            if !is_txt_file(path) { continue; }
            let value = path.to_string_lossy().to_string();
            if out.iter().any(|existing: &String| existing.eq_ignore_ascii_case(&value)) { continue; }
            out.push(value);
        }
        out
    }

    fn queue_timestamp_now() -> u128 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos()).unwrap_or(0)
    }

    fn queue_file_timestamp(path: &Path) -> Option<u128> {
        path.file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.split('_').next())
            .and_then(|value| value.parse::<u128>().ok())
    }

    fn prune_pending_open_paths_before(cutoff: u128) {
        let dir = pending_open_dir();
        let Ok(entries) = fs::read_dir(&dir) else { return; };
        for entry in entries.flatten() {
            let path = entry.path();
            if queue_file_timestamp(&path).map(|stamp| stamp < cutoff).unwrap_or(true) {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn queue_pending_open_paths(paths: &[PathBuf]) {
        let values = normalized_path_strings(paths);
        if values.is_empty() { return; }
        let dir = pending_open_dir();
        if fs::create_dir_all(&dir).is_err() { return; }
        let stamp = queue_timestamp_now();
        let base = format!("{:020}_{}", stamp, std::process::id());
        let temp_path = dir.join(format!("{}.tmp", base));
        let final_path = dir.join(format!("{}.json", base));
        if let Ok(bytes) = serde_json::to_vec(&values) {
            if fs::write(&temp_path, bytes).is_ok() {
                let _ = fs::rename(&temp_path, &final_path);
            }
            let _ = fs::remove_file(temp_path);
        }
    }

    pub fn take_pending_open_paths() -> Vec<String> {
        let dir = pending_open_dir();
        let mut files: Vec<PathBuf> = match fs::read_dir(&dir) {
            Ok(entries) => entries
                .filter_map(|entry| entry.ok().map(|item| item.path()))
                .filter(|path| path.extension().and_then(|value| value.to_str()).map(|ext| ext.eq_ignore_ascii_case("json")).unwrap_or(false))
                .collect(),
            Err(_) => return Vec::new(),
        };
        files.sort();
        let mut out: Vec<String> = Vec::new();
        for path in files {
            let Ok(bytes) = fs::read(&path) else { continue; };
            if let Ok(values) = serde_json::from_slice::<Vec<String>>(&bytes) {
                for value in values {
                    let candidate = PathBuf::from(&value);
                    if !is_txt_file(&candidate) { continue; }
                    if out.iter().any(|existing| existing.eq_ignore_ascii_case(&value)) { continue; }
                    out.push(value);
                }
            }
            let _ = fs::remove_file(path);
        }
        let _ = fs::remove_dir(&dir);
        out
    }

    pub struct SingleInstanceGuard {
        mutex_handle: Handle,
        restore_event_handle: Handle,
    }

    impl SingleInstanceGuard {
        pub fn restore_event_handle(&self) -> Option<usize> {
            (!self.restore_event_handle.is_null()).then_some(self.restore_event_handle as usize)
        }
    }

    impl Drop for SingleInstanceGuard {
        fn drop(&mut self) {
            if !self.restore_event_handle.is_null() {
                unsafe { let _ = CloseHandle(self.restore_event_handle); }
            }
            if !self.mutex_handle.is_null() {
                unsafe { let _ = CloseHandle(self.mutex_handle); }
            }
        }
    }

    fn signal_existing_instance() -> bool {
        let name = event_name();
        let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
        if event.is_null() {
            return false;
        }
        let signaled = unsafe { SetEvent(event) } != 0;
        unsafe { let _ = CloseHandle(event); }
        signaled
    }

    fn focus_existing_window_fallback() {
        let titles = [wide_null("D2R 툴팁편집기"), wide_null("D2R Tooltip Editor")];
        for _ in 0..20 {
            for title in &titles {
                let hwnd = unsafe { FindWindowW(ptr::null(), title.as_ptr()) };
                if !hwnd.is_null() {
                    unsafe {
                        if IsIconic(hwnd) != 0 {
                            let _ = ShowWindow(hwnd, SW_RESTORE);
                        } else {
                            let _ = ShowWindow(hwnd, SW_SHOW);
                        }
                        let _ = SetForegroundWindow(hwnd);
                    }
                    return;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn acquire_or_focus_existing(launch_paths: &[PathBuf]) -> Option<SingleInstanceGuard> {
        let launch_queue_epoch = queue_timestamp_now();
        let name = wide_null("Local\\JimSSng_D2R_TooltipEditor_SingleInstance");
        let mutex = unsafe { CreateMutexW(ptr::null_mut(), 1, name.as_ptr()) };
        if mutex.is_null() {
            return Some(SingleInstanceGuard { mutex_handle: mutex, restore_event_handle: ptr::null_mut() });
        }
        let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        if already_exists {
            queue_pending_open_paths(launch_paths);
            if !signal_existing_instance() {
                focus_existing_window_fallback();
            }
            unsafe { let _ = CloseHandle(mutex); }
            return None;
        }

        // Remove only queue files that predate this primary launch.  Secondary
        // processes can already have observed our mutex and queued newer paths;
        // deleting the whole directory here would race with those writes.
        prune_pending_open_paths_before(launch_queue_epoch);
        queue_pending_open_paths(launch_paths);
        let restore_event = unsafe { CreateEventW(ptr::null_mut(), 0, 0, event_name().as_ptr()) };
        Some(SingleInstanceGuard { mutex_handle: mutex, restore_event_handle: restore_event })
    }

    pub fn start_restore_listener(app: AppHandle, event_handle: Option<usize>) {
        let Some(raw_handle) = event_handle else { return; };
        thread::spawn(move || {
            let handle = raw_handle as Handle;
            loop {
                if unsafe { WaitForSingleObject(handle, INFINITE) } != WAIT_OBJECT_0 {
                    break;
                }
                crate::startup_splash::restore_or_defer(&app);
                let _ = app.emit("ttedit-open-file-paths-pending", ());
            }
        });
    }
}

#[cfg(not(target_os = "windows"))]
mod single_instance {
    use std::path::PathBuf;
    use tauri::AppHandle;
    pub struct SingleInstanceGuard;
    impl SingleInstanceGuard { pub fn restore_event_handle(&self) -> Option<usize> { None } }
    pub fn acquire_or_focus_existing(_launch_paths: &[PathBuf]) -> Option<SingleInstanceGuard> { Some(SingleInstanceGuard) }
    pub fn start_restore_listener(_app: AppHandle, _event_handle: Option<usize>) {}
    pub fn take_pending_open_paths() -> Vec<String> { Vec::new() }
}

#[derive(Serialize)]
struct OpenedFile {
    path: String,
    content: String,
}


#[derive(Serialize)]
struct ImportedSettings {
    path: String,
    content: String,
}

#[derive(Serialize)]
struct SystemFontInfo {
    family_name: String,
    file_name: String,
    path: String,
}

#[derive(Serialize)]
struct CachedFontInfo {
    path: String,
    file_name: String,
}

fn native_label(app: &AppHandle, korean: &'static str, english: &'static str) -> &'static str {
    if tray_lifecycle::is_english(app) { english } else { korean }
}

fn valid_dir(path: PathBuf) -> Option<PathBuf> {
    if path.is_dir() { Some(path) } else { None }
}

fn default_documents_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().document_dir().ok().and_then(valid_dir)
}

fn start_dir_from_text(start_dir: Option<String>) -> Option<PathBuf> {
    let raw = start_dir?.trim().to_string();
    if raw.is_empty() { return None; }
    let p = PathBuf::from(raw);
    if p.is_dir() { return Some(p); }
    p.parent().and_then(|parent| valid_dir(parent.to_path_buf()))
}

fn set_dialog_start_dir(mut dialog: rfd::FileDialog, dir: Option<PathBuf>) -> rfd::FileDialog {
    if let Some(d) = dir {
        if d.is_dir() { dialog = dialog.set_directory(d); }
    }
    dialog
}

fn decode_text(bytes: Vec<u8>) -> String {
    let mut text = String::from_utf8_lossy(&bytes).to_string();
    if text.starts_with('\u{feff}') {
        text.remove(0);
    }
    text
}

fn command_line_txt_paths() -> Vec<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|path| path.is_file() && path.extension().and_then(|value| value.to_str()).map(|ext| ext.eq_ignore_ascii_case("txt")).unwrap_or(false))
        .collect()
}

#[tauri::command]
fn take_pending_open_file_paths() -> Vec<String> {
    single_instance::take_pending_open_paths()
}

fn read_file(path: &Path) -> Result<OpenedFile, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(OpenedFile {
        path: path.to_string_lossy().to_string(),
        content: decode_text(bytes),
    })
}

#[tauri::command]
fn open_file_dialog(app: AppHandle, start_dir: Option<String>) -> Result<Option<OpenedFile>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title(native_label(&app, "열기", "Open"))
        .add_filter("Text", &["txt"]);
    dialog = set_dialog_start_dir(dialog, start_dir_from_text(start_dir).or_else(|| default_documents_dir(&app)));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let file = dialog.pick_file();
    match file {
        Some(path) => read_file(&path).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn read_file_at_path(path: String) -> Result<OpenedFile, String> {
    read_file(Path::new(&path))
}

#[tauri::command]
fn save_file_at_path(path: String, content: String) -> Result<String, String> {
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
fn save_file_dialog(app: AppHandle, content: String, current_path: Option<String>, start_dir: Option<String>, suggested_name: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title(native_label(&app, "다른이름으로 저장", "Save As"))
        .add_filter("Text", &["txt"])
        .set_file_name(suggested_name.as_deref().unwrap_or("new_tooltip.txt"));
    dialog = set_dialog_start_dir(dialog, start_dir_from_text(start_dir).or_else(|| default_documents_dir(&app)));

    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }

    if let Some(path) = current_path.as_deref() {
        let p = PathBuf::from(path);
        if let Some(parent) = p.parent() {
            if parent.is_dir() { dialog = dialog.set_directory(parent); }
        }
        if let Some(name) = p.file_name().and_then(|v| v.to_str()) { dialog = dialog.set_file_name(name); }
    }

    match dialog.save_file() {
        Some(path) => {
            fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let p = Path::new(&path);
        if p.is_dir() {
            Command::new("explorer.exe").arg(&path).spawn().map_err(|e| e.to_string())?;
        } else {
            let arg = format!("/select,{}", path);
            Command::new("explorer.exe").arg(arg).spawn().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(path).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let p = Path::new(&path);
        let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
}

#[cfg(target_os = "windows")]
fn open_url_with_default_browser(url: &str) -> Result<(), String> {
    use std::{ffi::{c_void, OsStr}, os::windows::ffi::OsStrExt, ptr};

    const SW_SHOWNORMAL: i32 = 1;

    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> isize;
    }

    fn wide_null(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    let operation = wide_null("open");
    let target = wide_null(url);
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result <= 32 {
        return Err(format!("failed to open external url: {}", result));
    }
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("unsupported external url".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        return open_url_with_default_browser(trimmed);
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(trimmed).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(trimmed).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
}

#[tauri::command]
fn set_ui_language(app: AppHandle, language: String) -> Result<(), String> {
    tray_lifecycle::set_ui_language(&app, &language)?;
    #[cfg(target_os = "windows")]
    {
        const KEY: &str = r"HKCU\Software\Classes\SystemFileAssociations\.txt\shell\D2RTooltipEditor";
        if reg_key_exists(KEY)? {
            set_registry_string_if_needed(
                KEY,
                None,
                native_label(&app, "D2R 툴팁편집기로 열기", "Open with D2R TooltipEditor"),
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
fn set_system_tray_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    tray_lifecycle::set_system_tray_enabled(&app, enabled)
}

#[tauri::command]
fn hide_main_window_to_tray(app: AppHandle) -> Result<(), String> {
    tray_lifecycle::hide_main_window_to_tray(&app)
}

#[tauri::command]
fn restore_main_window(app: AppHandle) -> Result<(), String> {
    tray_lifecycle::restore_main_window(&app, None)
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn read_clipboard_text() -> Result<Option<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    match clipboard.get_text() {
        Ok(text) => Ok(Some(text)),
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_clipboard_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}


fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ttedit_settings.json"))
}

fn pretty_json(app: &AppHandle, content: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(content).map_err(|e| {
        format!("{}: {}", native_label(app, "ttedit_settings.json 형식 오류", "Invalid ttedit_settings.json format"), e)
    })?;
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_settings_json(app: AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok("{}".to_string());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_settings_json(app: AppHandle, content: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    let pretty = pretty_json(&app, &content)?;
    fs::write(path, pretty.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_settings_json_dialog(app: AppHandle, content: String, start_dir: Option<String>) -> Result<Option<String>, String> {
    let pretty = pretty_json(&app, &content)?;
    let mut dialog = rfd::FileDialog::new()
        .set_title(native_label(&app, "설정 내보내기", "Export Settings"))
        .add_filter("JSON", &["json"])
        .set_file_name("ttedit_settings.json");
    dialog = set_dialog_start_dir(dialog, start_dir_from_text(start_dir).or_else(|| default_documents_dir(&app)));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    match dialog.save_file() {
        Some(path) => {
            fs::write(&path, pretty.as_bytes()).map_err(|e| e.to_string())?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn import_settings_json_dialog(app: AppHandle, start_dir: Option<String>) -> Result<Option<ImportedSettings>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title(native_label(&app, "설정 가져오기", "Import Settings"))
        .add_filter("JSON", &["json"]);
    dialog = set_dialog_start_dir(dialog, start_dir_from_text(start_dir).or_else(|| default_documents_dir(&app)));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    match dialog.pick_file() {
        Some(path) => {
            let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let pretty = pretty_json(&app, &content)?;
            Ok(Some(ImportedSettings { path: path.to_string_lossy().to_string(), content: pretty }))
        }
        None => Ok(None),
    }
}


#[tauri::command]
fn get_default_save_directory(app: AppHandle) -> Result<String, String> {
    let dir = default_documents_dir(&app).or_else(|| std::env::current_dir().ok()).ok_or_else(|| "default directory not found".to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn select_default_save_directory_dialog(app: AppHandle, start_dir: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new().set_title(native_label(&app, "기본 저장 경로", "Default Save Folder"));
    dialog = set_dialog_start_dir(dialog, start_dir_from_text(start_dir).or_else(|| default_documents_dir(&app)));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    Ok(dialog.pick_folder().map(|path| path.to_string_lossy().to_string()))
}



fn is_supported_font_ext(ext: &str) -> bool {
    matches!(ext, "ttf" | "otf" | "ttc")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year as i32, m as u32, d as u32)
}

fn timestamp_utc_compact() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;
    format!("{:04}{:02}{:02}_{:02}{:02}{:02}", year, month, day, hour, minute, second)
}

fn sanitize_cached_font_stem(value: &str) -> String {
    let trimmed = value.trim();
    let mut out = String::new();
    for ch in trimmed.chars() {
        if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0') || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let cleaned = out.trim_matches(|ch| ch == ' ' || ch == '.').to_string();
    if cleaned.is_empty() { "custom_font".to_string() } else { cleaned }
}

fn unique_cached_font_target(font_dir: &Path, source: &Path, ext: &str) -> (PathBuf, String) {
    let stamp = timestamp_utc_compact();
    let stem = sanitize_cached_font_stem(source.file_stem().and_then(|v| v.to_str()).unwrap_or("custom_font"));
    for index in 0..1000 {
        let file_name = if index == 0 {
            format!("{}_{}.{}", stem, stamp, ext)
        } else {
            format!("{}_{}_{}.{}", stem, stamp, index, ext)
        };
        let target = font_dir.join(&file_name);
        if !target.exists() {
            return (target, file_name);
        }
    }
    let file_name = format!("{}_{}_fallback.{}", stem, stamp, ext);
    (font_dir.join(&file_name), file_name)
}

fn app_owned_directories(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(path) = app.path().app_config_dir() { dirs.push(path); }
    if let Ok(path) = app.path().app_data_dir() { dirs.push(path); }
    if let Ok(path) = app.path().app_local_data_dir() { dirs.push(path); }
    if let Ok(path) = app.path().app_cache_dir() { dirs.push(path); }
    if let Ok(path) = app.path().app_log_dir() { dirs.push(path); }
    dirs.push(std::env::temp_dir().join("JimSSng_D2R_TooltipEditor_OpenQueue"));
    dirs.sort();
    dirs.dedup();
    dirs
}

fn font_display_name_from_file(path: &Path, english: bool) -> String {
    let file_name = path.file_name().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    match file_name.as_str() {
        "malgun.ttf" | "malgunbd.ttf" => return if english { "Malgun Gothic" } else { "맑은 고딕" }.to_string(),
        "gulim.ttc" => return if english { "Gulim" } else { "굴림" }.to_string(),
        "batang.ttc" => return if english { "Batang" } else { "바탕" }.to_string(),
        "msgothic.ttc" => return "MS Gothic".to_string(),
        _ => {}
    }
    path.file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("Unknown Font")
        .replace('_', " ")
}

#[tauri::command]
fn list_system_fonts(app: AppHandle) -> Result<Vec<SystemFontInfo>, String> {
    let english = tray_lifecycle::is_english(&app);
    let mut out: Vec<SystemFontInfo> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        let mut font_dirs: Vec<PathBuf> = vec![PathBuf::from(r"C:\Windows\Fonts")];
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            font_dirs.push(PathBuf::from(local_app_data).join("Microsoft").join("Windows").join("Fonts"));
        }
        if let Ok(app_data) = std::env::var("APPDATA") {
            font_dirs.push(PathBuf::from(app_data).join("Microsoft").join("Windows").join("Fonts"));
        }
        for font_dir in font_dirs {
            if !font_dir.is_dir() { continue; }
            let entries = match fs::read_dir(&font_dir) { Ok(v) => v, Err(_) => continue };
            for entry in entries {
                let entry = match entry { Ok(v) => v, Err(_) => continue };
                let path = entry.path();
                let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
                if ext != "ttf" && ext != "otf" && ext != "ttc" { continue; }
                let file_name = path.file_name().and_then(|v| v.to_str()).unwrap_or("").to_string();
                if file_name.is_empty() { continue; }
                out.push(SystemFontInfo {
                    family_name: font_display_name_from_file(&path, english),
                    file_name,
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.family_name.to_lowercase().cmp(&b.family_name.to_lowercase()).then(a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase())));
    out.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));
    Ok(out)
}


#[tauri::command]
fn get_user_font_directory() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let path = PathBuf::from(local_app_data).join("Microsoft").join("Windows").join("Fonts");
            if path.is_dir() { return Ok(Some(path.to_string_lossy().to_string())); }
        }
        if let Ok(app_data) = std::env::var("APPDATA") {
            let path = PathBuf::from(app_data).join("Microsoft").join("Windows").join("Fonts");
            if path.is_dir() { return Ok(Some(path.to_string_lossy().to_string())); }
        }
    }
    Ok(None)
}

#[tauri::command]
fn select_font_file_dialog(app: AppHandle, start_dir: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title(native_label(&app, "글꼴 선택", "Select Font"))
        .add_filter("Font", &["ttf", "otf", "ttc"]);
    dialog = set_dialog_start_dir(dialog, start_dir_from_text(start_dir).or_else(|| get_user_font_directory().ok().flatten().map(PathBuf::from)).or_else(|| default_documents_dir(&app)));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    Ok(dialog.pick_file().map(|path| path.to_string_lossy().to_string()))
}


fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] } else { 0 };
        let b2 = if i + 2 < bytes.len() { bytes[i + 2] } else { 0 };
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        if i + 1 < bytes.len() {
            out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < bytes.len() {
            out.push(TABLE[(n & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

fn font_mime_from_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        "ttc" => Some("font/collection"),
        _ => None,
    }
}

#[tauri::command]
fn read_font_file_data_url(path: String) -> Result<String, String> {
    let raw = path.trim();
    if raw.is_empty() { return Err("font path is empty".to_string()); }
    let font_path = PathBuf::from(raw);
    if !font_path.is_file() { return Err("font file not found".to_string()); }
    let ext = font_path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = font_mime_from_ext(&ext).ok_or_else(|| "unsupported font file extension".to_string())?;
    let bytes = fs::read(&font_path).map_err(|e| e.to_string())?;
    if bytes.is_empty() { return Err("font file is empty".to_string()); }
    if bytes.len() > 64 * 1024 * 1024 { return Err("font file is too large".to_string()); }
    Ok(format!("data:{};base64,{}", mime, base64_encode(&bytes)))
}


#[tauri::command]
fn cache_custom_font(app: AppHandle, path: String, role: String) -> Result<CachedFontInfo, String> {
    let raw = path.trim();
    if raw.is_empty() { return Err("font path is empty".to_string()); }
    let source = PathBuf::from(raw);
    if !source.is_file() { return Err("font file not found".to_string()); }
    let ext = source.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    if !is_supported_font_ext(&ext) { return Err("unsupported font file extension".to_string()); }
    let metadata = fs::metadata(&source).map_err(|e| e.to_string())?;
    if metadata.len() == 0 { return Err("font file is empty".to_string()); }
    if metadata.len() > 64 * 1024 * 1024 { return Err("font file is too large".to_string()); }

    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let font_dir = config_dir.join("fonts");
    fs::create_dir_all(&font_dir).map_err(|e| e.to_string())?;
    let _role_key = if role.trim().eq_ignore_ascii_case("fallback") { "fallback" } else { "primary" };
    let (target, file_name) = unique_cached_font_target(&font_dir, &source, &ext);
    fs::copy(&source, &target).map_err(|e| e.to_string())?;
    Ok(CachedFontInfo { path: target.to_string_lossy().to_string(), file_name })
}

#[cfg(target_os = "windows")]
fn run_reg_command(args: &[&str]) -> Result<(), String> {
    let output = Command::new("reg.exe").args(args).output().map_err(|error| error.to_string())?;
    if output.status.success() { return Ok(()); }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { format!("reg.exe failed with status {}", output.status) } else { stderr })
}

#[cfg(target_os = "windows")]
type RegistryKeyHandle = *mut std::ffi::c_void;

#[cfg(target_os = "windows")]
#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegOpenKeyExW(
        h_key: RegistryKeyHandle,
        sub_key: *const u16,
        options: u32,
        desired_access: u32,
        result: *mut RegistryKeyHandle,
    ) -> i32;
    fn RegQueryValueExW(
        h_key: RegistryKeyHandle,
        value_name: *const u16,
        reserved: *mut u32,
        value_type: *mut u32,
        data: *mut u8,
        data_size: *mut u32,
    ) -> i32;
    fn RegCloseKey(h_key: RegistryKeyHandle) -> i32;
}

#[cfg(target_os = "windows")]
fn registry_wide_null(value: &str) -> Vec<u16> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn registry_subkey(key: &str) -> &str {
    key.strip_prefix("HKCU\\").unwrap_or(key)
}

#[cfg(target_os = "windows")]
fn open_registry_key(key: &str) -> Result<Option<RegistryKeyHandle>, String> {
    const HKEY_CURRENT_USER_VALUE: isize = 0x8000_0001u32 as i32 as isize;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PATH_NOT_FOUND: i32 = 3;
    let subkey = registry_wide_null(registry_subkey(key));
    let mut handle: RegistryKeyHandle = std::ptr::null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER_VALUE as RegistryKeyHandle,
            subkey.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut handle,
        )
    };
    if status == ERROR_SUCCESS { return Ok(Some(handle)); }
    if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND { return Ok(None); }
    Err(format!("RegOpenKeyExW failed for {} with status {}", key, status))
}

#[cfg(target_os = "windows")]
fn query_registry_string(key: &str, value_name: Option<&str>) -> Result<Option<String>, String> {
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const REG_SZ: u32 = 1;
    const REG_EXPAND_SZ: u32 = 2;
    let Some(handle) = open_registry_key(key)? else { return Ok(None); };
    let value_name_wide = value_name.map(registry_wide_null);
    let value_name_ptr = value_name_wide.as_ref().map(|value| value.as_ptr()).unwrap_or(std::ptr::null());
    let mut value_type = 0u32;
    let mut byte_len = 0u32;
    let size_status = unsafe {
        RegQueryValueExW(
            handle,
            value_name_ptr,
            std::ptr::null_mut(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut byte_len,
        )
    };
    if size_status == ERROR_FILE_NOT_FOUND {
        unsafe { RegCloseKey(handle); }
        return Ok(None);
    }
    if size_status != ERROR_SUCCESS {
        unsafe { RegCloseKey(handle); }
        return Err(format!("RegQueryValueExW size query failed for {} with status {}", key, size_status));
    }
    if value_type != REG_SZ && value_type != REG_EXPAND_SZ {
        unsafe { RegCloseKey(handle); }
        return Ok(None);
    }
    let mut buffer = vec![0u16; ((byte_len as usize + 1) / 2).max(1)];
    let mut actual_len = byte_len;
    let read_status = unsafe {
        RegQueryValueExW(
            handle,
            value_name_ptr,
            std::ptr::null_mut(),
            &mut value_type,
            buffer.as_mut_ptr() as *mut u8,
            &mut actual_len,
        )
    };
    unsafe { RegCloseKey(handle); }
    if read_status != ERROR_SUCCESS {
        return Err(format!("RegQueryValueExW read failed for {} with status {}", key, read_status));
    }
    let units = (actual_len as usize / 2).min(buffer.len());
    let end = buffer[..units].iter().position(|value| *value == 0).unwrap_or(units);
    String::from_utf16(&buffer[..end]).map(Some).map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn reg_key_exists(key: &str) -> Result<bool, String> {
    let result = open_registry_key(key)?;
    if let Some(handle) = result {
        unsafe { RegCloseKey(handle); }
        return Ok(true);
    }
    Ok(false)
}

#[cfg(target_os = "windows")]
fn delete_reg_key_if_present(key: &str) -> Result<(), String> {
    if !reg_key_exists(key)? { return Ok(()); }
    run_reg_command(&["delete", key, "/f"])
}

#[cfg(target_os = "windows")]
fn set_registry_string_if_needed(key: &str, value_name: Option<&str>, expected: &str) -> Result<(), String> {
    if query_registry_string(key, value_name)?.as_deref() == Some(expected) { return Ok(()); }
    match value_name {
        Some(name) => run_reg_command(&["add", key, "/v", name, "/d", expected, "/f"]),
        None => run_reg_command(&["add", key, "/ve", "/d", expected, "/f"]),
    }?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_windows_shell_txt_context_menu(app: &AppHandle, enabled: bool) -> Result<(), String> {
    const KEY: &str = r"HKCU\Software\Classes\SystemFileAssociations\.txt\shell\D2RTooltipEditor";
    const COMMAND_KEY: &str = r"HKCU\Software\Classes\SystemFileAssociations\.txt\shell\D2RTooltipEditor\command";
    if !enabled {
        return delete_reg_key_if_present(KEY);
    }
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let exe_text = exe.to_string_lossy().to_string();
    let icon_value = format!("\"{}\",0", exe_text);
    let command_value = format!("\"{}\" \"%1\"", exe_text);
    set_registry_string_if_needed(KEY, None, native_label(app, "D2R 툴팁편집기로 열기", "Open with D2R TooltipEditor"))?;
    set_registry_string_if_needed(KEY, Some("Icon"), &icon_value)?;
    set_registry_string_if_needed(KEY, Some("MultiSelectModel"), "Player")?;
    set_registry_string_if_needed(COMMAND_KEY, None, &command_value)?;
    Ok(())
}

#[tauri::command]
fn set_shell_context_menu_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        set_windows_shell_txt_context_menu(&app, enabled)?;
        return Ok(enabled);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, enabled);
        Ok(false)
    }
}

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn cleanup_script_for_paths(paths: Vec<PathBuf>) -> String {
    let mut quoted_paths: Vec<String> = paths
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .filter(|path| !path.trim().is_empty())
        .map(|path| powershell_quote(&path))
        .collect();
    quoted_paths.sort();
    quoted_paths.dedup();
    let paths_literal = if quoted_paths.is_empty() { "@()".to_string() } else { format!("@({})", quoted_paths.join(",")) };
    let registry_literal = "@('HKCU:\\Software\\JimSSng\\D2R TooltipEditor','HKCU:\\Software\\JimSSng\\TooltipEditor','HKCU:\\Software\\com.jimssng.tooltipeditor','HKCU:\\Software\\Classes\\SystemFileAssociations\\.txt\\shell\\D2RTooltipEditor')";
    format!(r#"Start-Sleep -Milliseconds 900;
$paths = {paths};
foreach ($p in $paths) {{
  for ($i = 0; $i -lt 10; $i++) {{
    if (Test-Path -LiteralPath $p) {{ Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300 }}
  }}
}}
$regs = {regs};
foreach ($r in $regs) {{ Remove-Item -LiteralPath $r -Recurse -Force -ErrorAction SilentlyContinue }}
"#, paths = paths_literal, regs = registry_literal)
}

#[tauri::command]
fn cleanup_user_data_and_exit(app: AppHandle) -> Result<(), String> {
    let dirs = app_owned_directories(&app);
    #[cfg(target_os = "windows")]
    {
        let script = cleanup_script_for_paths(dirs);
        Command::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-Command")
            .arg(script)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        for dir in dirs {
            let _ = fs::remove_dir_all(dir);
        }
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn open_main_devtools(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.open_devtools();
    Ok(())
}

fn main() {
    let launch_paths = command_line_txt_paths();
    let single_instance_guard = match single_instance::acquire_or_focus_existing(&launch_paths) {
        Some(guard) => guard,
        None => return,
    };
    let restore_event_handle = single_instance_guard.restore_event_handle();

    tauri::Builder::default()
        .manage(tray_lifecycle::TrayRuntimeState::default())
        .manage(startup_splash::StartupSplashState::default())
        .invoke_handler(tauri::generate_handler![
            open_file_dialog,
            read_file_at_path,
            take_pending_open_file_paths,
            save_file_at_path,
            file_exists,
            save_file_dialog,
            reveal_in_explorer,
            read_clipboard_text,
            write_clipboard_text,
            read_settings_json,
            write_settings_json,
            export_settings_json_dialog,
            import_settings_json_dialog,
            get_default_save_directory,
            select_default_save_directory_dialog,
            list_system_fonts,
            get_user_font_directory,
            select_font_file_dialog,
            read_font_file_data_url,
            cache_custom_font,
            cleanup_user_data_and_exit,
            open_main_devtools,
            open_external_url,
            set_shell_context_menu_enabled,
            set_system_tray_enabled,
            set_ui_language,
            hide_main_window_to_tray,
            restore_main_window,
            exit_app,
            startup_splash::get_startup_splash_progress,
            startup_splash::set_startup_splash_progress,
            startup_splash::resize_startup_splash,
            startup_splash::read_startup_splash_image_data_url,
            startup_splash::finish_startup_splash
        ])
        .setup(move |app| {
            startup_splash::initialize(app.handle())
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            tray_lifecycle::initialize(app.handle())
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            single_instance::start_restore_listener(app.handle().clone(), restore_event_handle);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(native_label(app.handle(), "D2R 툴팁편집기", "D2R Tooltip Editor"));
                let close_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = close_window.emit("ttedit-window-close-requested", ());
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TooltipEditor");

    drop(single_instance_guard);
}
