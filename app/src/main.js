import { initStatusBar, setStatusMessage } from "./statusBar.js";
import { initLayout } from "./layout.js";
import { initViews, setDocumentContent } from "./syncViews.js";
import { activateDocumentTab, closeDocumentTab, duplicateDocumentTab, ensureActiveUntitledDocumentName, initExitGuard, initExternalFileOpenRequests, initFileMenu, newFile, renderRecentDocuments, renameDocumentTab, restoreOpenDocumentSession, reorderDocumentTabs } from "./fileMenu.js";
import { initMenuBar, handleGlobalShortcuts } from "./menuBar.js";
import { initWrapToggles, initToolOptions } from "./viewMenu.js";
import { initLineNumbers } from "./lineNumbers.js";
import { initScrollSync, handleViewActivity } from "./scrollSync.js";
import { initCodeLineHighlight } from "./codeLineHighlight.js";
import { initContextMenu } from "./contextMenu.js";
import { getPreferences, initSettingsStore } from "./preferences.js";
import { finishStartupSplash, isTauriAvailable, openMainDevtools, setShellContextMenuEnabled, setStartupSplashProgress, setSystemTrayEnabled } from "./fileApi.js";
import { initDocumentTabs } from "./documentTabs.js";
import { initRenderingToolbar } from "./rendering.js";
import { initColorToolbar } from "./colorCodes.js";
import { initDeveloperMode, isDeveloperModeEnabled } from "./developerMode.js";
import { initLargeEditorViewport } from "./largeEditorViewport.js";
import { initLanguage } from "./language.js";

const splitLayout = document.getElementById("splitLayout");
const splitter = document.getElementById("splitter");
const codeText = document.getElementById("codeText");
const editorText = document.getElementById("editorText");
const statusBar = document.getElementById("statusBar");
const statusMessage = document.getElementById("statusMessage");
const statusSlots = document.getElementById("statusSlots");
const codeStatusSlots = document.getElementById("codeStatusSlots");

let startupSplashFinished = false;
async function reportStartupProgress(progress) {
  if (!isTauriAvailable() || startupSplashFinished) return;
  try {
    await setStartupSplashProgress(progress);
  } catch (error) {
    console.warn('startup splash progress failed', progress, error);
  }
}
async function finishStartupSplashSafely() {
  if (!isTauriAvailable() || startupSplashFinished) return;
  startupSplashFinished = true;
  try {
    await finishStartupSplash(getPreferences().startMaximized !== false);
  } catch (error) {
    console.warn('startup splash completion failed', error);
  }
}
window.addEventListener('error', () => { void finishStartupSplashSafely(); }, { once: true });
window.addEventListener('unhandledrejection', () => { void finishStartupSplashSafely(); }, { once: true });

await reportStartupProgress(15);

function updateRangeProgress(input) {
  if (!input || input.type !== 'range') return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value || 0);
  const span = max - min;
  const ratio = Number.isFinite(span) && span > 0 ? (value - min) / span : 0;
  const percent = Math.max(0, Math.min(100, ratio * 100));
  input.style.setProperty('--range-progress', `${percent}%`);
}

function updateAllRangeProgress(root = document) {
  root.querySelectorAll?.('input[type="range"]').forEach(updateRangeProgress);
}

function initRangeProgressStyling() {
  updateAllRangeProgress();
  document.addEventListener('input', event => updateRangeProgress(event.target), true);
  document.addEventListener('change', event => updateRangeProgress(event.target), true);
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes || [])) {
        if (node?.nodeType !== 1) continue;
        if (node.matches?.('input[type="range"]')) updateRangeProgress(node);
        updateAllRangeProgress(node);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function suppressNativeTextBoxTitles(root = document) {
  root.querySelectorAll?.('input[type="text"], input[type="number"], textarea').forEach(el => {
    el.removeAttribute('title');
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.closest('label')?.removeAttribute('title');
    el.closest('.form-row')?.removeAttribute('title');
  });
}
document.addEventListener('mouseover', event => {
  const el = event.target?.closest?.('input[type="text"], input[type="number"], textarea');
  if (el) suppressNativeTextBoxTitles(el.parentElement || document);
}, true);
document.addEventListener('focusin', event => {
  const el = event.target?.closest?.('input[type="text"], input[type="number"], textarea');
  if (el) suppressNativeTextBoxTitles(el.parentElement || document);
}, true);

await reportStartupProgress(25);
await reportStartupProgress(70);

try {
  await initSettingsStore();
} catch (err) {
  console.error('settings initialization failed; continuing with defaults', err);
}
try {
  await initLanguage();
} catch (err) {
  console.error('language initialization failed; continuing with Korean UI', err);
}
await reportStartupProgress(86);

async function syncSystemTrayPreference(preferences = getPreferences()) {
  if (!isTauriAvailable()) return;
  try {
    await setSystemTrayEnabled(preferences?.systemTrayEnabled !== false);
  } catch (err) {
    console.warn('system tray preference sync failed', err);
  }
}

let lastAppliedShellContextMenuPreference = null;
let shellContextMenuSyncQueue = Promise.resolve();

function syncShellContextMenuPreference(preferences = getPreferences()) {
  if (!isTauriAvailable()) return Promise.resolve();
  const desired = preferences?.windowsShellTxtContextMenu !== false;
  const task = shellContextMenuSyncQueue.then(async () => {
    if (lastAppliedShellContextMenuPreference === desired) return;
    await setShellContextMenuEnabled(desired);
    lastAppliedShellContextMenuPreference = desired;
  });
  shellContextMenuSyncQueue = task.catch(() => {});
  return task.catch((err) => {
    console.warn('Windows shell context menu preference sync failed', err);
    setStatusMessage('Windows 쉘 메뉴 설정을 적용하지 못했습니다.', { type: 'warning', timeout: 3500 });
  });
}

document.addEventListener('tooltipeditor:preferences-changed', event => {
  const preferences = event.detail || getPreferences();
  void syncSystemTrayPreference(preferences);
  void syncShellContextMenuPreference(preferences);
});
void syncSystemTrayPreference();
void syncShellContextMenuPreference();

function initDevtoolsShortcut() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'F12' && event.code !== 'F12') return;
    event.preventDefault();
    if (!isDeveloperModeEnabled()) return;
    if (!isTauriAvailable()) return;
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    openMainDevtools()
      .then(() => setStatusMessage('개발자도구 열기'))
      .catch((err) => {
        console.warn('open devtools failed', err);
        setStatusMessage('개발자도구 열기 실패');
      });
  }, true);
}


initDeveloperMode({ versionBadge: document.getElementById("versionBadge") });
initDevtoolsShortcut();
initRangeProgressStyling();
initStatusBar({ root: statusBar, message: statusMessage, slots: statusSlots, codeSlots: codeStatusSlots, editorInfo: document.getElementById("editorFileStatus") });
initLayout({ layoutElement: splitLayout, splitterElement: splitter, modeSelect: document.getElementById("layoutModeSelect") });
initLineNumbers({
  editorElement: editorText,
  gutterElement: document.getElementById("editorLineGutter"),
  innerElement: document.getElementById("editorLineGutterInner"),
});
initRenderingToolbar({ editorElement: editorText });
initColorToolbar({ editorElement: editorText, codeElement: codeText });
initLargeEditorViewport({ editorElement: editorText });
initScrollSync();
initCodeLineHighlight({ codeElement: codeText });
initViews({ codeElement: codeText, editorElement: editorText, onChange: handleViewActivity });
initDocumentTabs({ rootElement: document.getElementById("documentTabs"), activateDocument: activateDocumentTab, closeDocument: closeDocumentTab, newDocument: newFile, reorderDocument: reorderDocumentTabs, renameDocument: renameDocumentTab, duplicateDocument: duplicateDocumentTab });
initFileMenu({
  fallbackFileInput: document.getElementById("fallbackOpenFile"),
  recentDocumentsMenu: document.getElementById("recentDocumentsMenu"),
  renderRecent: renderRecentDocuments,
});
initExitGuard();
initWrapToggles({
  editorToggle: document.getElementById("editorWrapToggle"),
  codeToggle: document.getElementById("codeWrapToggle"),
  editorText,
  codeText,
});
initToolOptions({ scrollSyncToggle: document.getElementById("scrollSyncToggle") });
initMenuBar();
handleGlobalShortcuts();
initContextMenu();
setDocumentContent("", { path: null, dirty: false, source: "init" });
ensureActiveUntitledDocumentName();
await restoreOpenDocumentSession();
await initExternalFileOpenRequests();
await reportStartupProgress(96);
await finishStartupSplashSafely();

window.addEventListener("DOMContentLoaded", () => {
  editorText.focus();
  setStatusMessage("준비됨", { timeout: 0 });
});
