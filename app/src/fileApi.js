function getInvoke() {
  return window.__TAURI__?.core?.invoke || null;
}

let sessionDialogDirectory = '';

function getParentDirectory(path) {
  const text = String(path || '');
  const idx = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  return idx > 0 ? text.slice(0, idx) : '';
}

function rememberDialogPath(path) {
  const text = String(path || '');
  if (!text) return;
  sessionDialogDirectory = getParentDirectory(text) || text;
}

function dialogStartDirectory(defaultDirectory = '') {
  return sessionDialogDirectory || String(defaultDirectory || '').trim() || null;
}

export function isTauriAvailable() {
  return !!getInvoke();
}

async function invoke(command, args = {}) {
  const fn = getInvoke();
  if (!fn) throw new Error("Tauri API를 찾을 수 없습니다.");
  return await fn(command, args);
}

export async function openFileDialog(defaultDirectory = '') {
  const result = await invoke("open_file_dialog", { startDir: dialogStartDirectory(defaultDirectory) });
  if (result?.path) rememberDialogPath(result.path);
  return result;
}
export async function readFileAtPath(path) { return await invoke("read_file_at_path", { path }); }
export async function takePendingOpenFilePaths() { return await invoke("take_pending_open_file_paths"); }
export async function saveFileAtPath(path, content) { return await invoke("save_file_at_path", { path, content }); }
export async function fileExists(path) { return await invoke("file_exists", { path }); }
export async function saveFileDialog(content, currentPath = null, defaultDirectory = '', suggestedName = null) {
  const result = await invoke("save_file_dialog", { content, currentPath, startDir: dialogStartDirectory(defaultDirectory), suggestedName });
  if (result) rememberDialogPath(result);
  return result;
}
export async function revealInExplorer(path) { return await invoke("reveal_in_explorer", { path }); }
export async function exitApp() { return await invoke("exit_app"); }
export async function openMainDevtools() { return await invoke("open_main_devtools"); }
export async function openExternalUrl(url) { return await invoke("open_external_url", { url }); }
export async function setSystemTrayEnabled(enabled) { return await invoke("set_system_tray_enabled", { enabled: enabled !== false }); }
export async function setShellContextMenuEnabled(enabled) { return await invoke("set_shell_context_menu_enabled", { enabled: enabled !== false }); }
export async function setNativeUiLanguage(language) { return await invoke("set_ui_language", { language: String(language || "ko") }); }
export async function hideMainWindowToTray() { return await invoke("hide_main_window_to_tray"); }
export async function restoreMainWindow() { return await invoke("restore_main_window"); }
export async function setStartupSplashProgress(progress) { return await invoke("set_startup_splash_progress", { progress }); }
export async function finishStartupSplash(startMaximized = true) { return await invoke("finish_startup_splash", { startMaximized: startMaximized !== false }); }

export async function readClipboardText() { return await invoke("read_clipboard_text"); }
export async function writeClipboardText(text) { return await invoke("write_clipboard_text", { text }); }

export async function readSettingsJson() { return await invoke("read_settings_json"); }
export async function writeSettingsJson(content) { return await invoke("write_settings_json", { content }); }
export async function exportSettingsJsonDialog(content, defaultDirectory = '') {
  const result = await invoke("export_settings_json_dialog", { content, startDir: dialogStartDirectory(defaultDirectory) });
  if (result) rememberDialogPath(result);
  return result;
}
export async function importSettingsJsonDialog(defaultDirectory = '') {
  const result = await invoke("import_settings_json_dialog", { startDir: dialogStartDirectory(defaultDirectory) });
  if (result?.path) rememberDialogPath(result.path);
  return result?.content ?? null;
}

export async function getDefaultSaveDirectory() { return await invoke("get_default_save_directory"); }
export async function selectDefaultSaveDirectoryDialog(defaultDirectory = '') {
  const result = await invoke("select_default_save_directory_dialog", { startDir: dialogStartDirectory(defaultDirectory) });
  if (result) rememberDialogPath(result);
  return result;
}

export async function listSystemFonts() { return await invoke("list_system_fonts"); }
export async function getUserFontDirectory() { return await invoke("get_user_font_directory"); }
export async function selectFontFileDialog(defaultDirectory = '') {
  const result = await invoke("select_font_file_dialog", { startDir: String(defaultDirectory || '').trim() || null });
  if (result) rememberDialogPath(result);
  return result;
}
export async function readFontFileDataUrl(path) { return await invoke("read_font_file_data_url", { path }); }
export async function cacheCustomFont(path, role) { return await invoke("cache_custom_font", { path, role }); }
export async function cleanupUserDataAndExit() { return await invoke("cleanup_user_data_and_exit"); }
