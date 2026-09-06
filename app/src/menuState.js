import { state } from "./state.js";
import { getActiveTextArea } from "./syncViews.js";
import { readClipboardText, isTauriAvailable } from "./fileApi.js";
import { hasFloatingWindow } from "./floatingWindow.js";

let clipboardTextAvailable = true;

export async function updateClipboardState() {
  if (!isTauriAvailable()) {
    clipboardTextAvailable = true;
    return;
  }
  try {
    const text = await readClipboardText();
    clipboardTextAvailable = !!text;
  } catch {
    // 클립보드 상태를 확인할 수 없는 환경에서는 메뉴 자체를 막지 않는다.
    clipboardTextAvailable = true;
  }
}

export function updateMenuState(root = document) {
  const active = getActiveTextArea();
  const hasSelection = active && (active.selectionEnd ?? 0) > (active.selectionStart ?? 0);
  const hasFilePath = !!state.currentFilePath;
  const hasCurrentDocument = !!state.currentFilePath || !!state.documentText;
  setDisabled(root, "file:reveal", !hasFilePath);
  setDisabled(root, "file:close", !hasCurrentDocument);
  setDisabled(root, "edit:undo", state.undoStack.length <= 0);
  setDisabled(root, "edit:redo", state.redoStack.length <= 0);
  setDisabled(root, "edit:cut", !hasSelection);
  setDisabled(root, "edit:copy", !hasSelection);
  setDisabled(root, "edit:delete", !hasSelection);
  setDisabled(root, "edit:paste", true);
  setDisabled(root, "edit:pastePlain", !clipboardTextAvailable);
  setDisabled(root, "edit:copyPath", !hasFilePath && !state.currentFileName);
  const floatingOpen = hasFloatingWindow();
  const hasActualTabs = String(state.rawCode || state.documentText || "").includes("\t");
  setDisabled(root, "edit:textCleanup", floatingOpen);
  setDisabled(root, "edit:jsonKeyExtract", floatingOpen);
  setDisabled(root, "edit:implementTabs", floatingOpen || !hasActualTabs);
  setDisabled(root, "edit:restoreTabs", floatingOpen);
  setDisabled(root, "insert:unicodeDialog", floatingOpen);
  setDisabled(root, "find:gotoLine", floatingOpen);
  setDisabled(root, "find:find", floatingOpen);
  setDisabled(root, "find:replace", floatingOpen);
  setDisabled(root, "settings:preferences", floatingOpen);
}

function setDisabled(root, command, disabled) {
  root.querySelectorAll(`[data-command="${command}"]`).forEach(el => {
    el.disabled = !!disabled;
    el.setAttribute("aria-disabled", disabled ? "true" : "false");
  });
}

try { window.addEventListener('ttedit-document-view-synced', () => updateMenuState(document)); } catch (_) {}
