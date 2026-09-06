import * as fileMenu from "./fileMenu.js";
import * as editMenu from "./editMenu.js";
import * as insertMenu from "./insertMenu.js";
import * as findMenu from "./findMenu.js";
import * as layoutManager from "./layout.js";
import { showHelpDialog, showVersionDialog } from "./infoDialog.js";
import { setStatusMessage, beginUserAction, setCursorLocation } from "./statusBar.js";
import { updateClipboardState, updateMenuState } from "./menuState.js";
import { hasBlockingModal, pokeTopModal } from "./modal.js";
import { hasFloatingWindow, pokeActiveFloatingWindow } from "./floatingWindow.js";
import { getActiveTextArea } from "./syncViews.js";
import { shouldYieldGlobalShortcutToFocusLayer } from "./focusHierarchy.js";
import { setUiLanguage } from "./language.js";
import { copySelectedFontColor, pasteCopiedFontColor } from "./colorCodes.js";

const commandMap = {
  "file:new": fileMenu.newFile,
  "file:open": fileMenu.openFile,
  "file:reveal": fileMenu.revealCurrentFile,
  "file:save": fileMenu.saveFile,
  "file:saveAs": fileMenu.saveFileAs,
  "file:close": fileMenu.closeCurrentFile,
  "app:exit": fileMenu.exitApplication,
  "edit:undo": editMenu.undo,
  "edit:redo": editMenu.redo,
  "edit:cut": editMenu.cut,
  "edit:copy": editMenu.copy,
  "edit:paste": editMenu.paste,
  "edit:pastePlain": editMenu.pastePlainText,
  "edit:delete": editMenu.deleteSelection,
  "edit:selectAll": editMenu.selectAll,
  "edit:copyPath": editMenu.copyCurrentPath,
  "edit:textCleanup": editMenu.textCleanupDialog,
  "edit:jsonKeyExtract": editMenu.jsonKeyExtractDialog,
  "edit:implementTabs": editMenu.implementTabs,
  "edit:restoreTabs": editMenu.restoreTabs,
  "edit:trimBoth": editMenu.trimBoth,
  "edit:trimLineStart": editMenu.trimLineStart,
  "edit:trimLineEnd": editMenu.trimLineEnd,
  "edit:removeEol": editMenu.removeEol,
  "edit:removeDuplicateEol": editMenu.removeDuplicateEol,
  "edit:removeEolAndSpaces": editMenu.removeEolAndSpaces,
  "edit:removeTabs": editMenu.removeTabs,
  "insert:zeroWidth": insertMenu.insertZeroWidth,
  "insert:removeZeroWidth": insertMenu.removeZeroWidth,
  "insert:unicodeDialog": insertMenu.unicodeDialog,
  "find:find": findMenu.findDialog,
  "find:replace": findMenu.replaceDialog,
  "find:colorConvert": findMenu.colorConvertDialog,
  "find:nextTab": () => fileMenu.activateAdjacentDocumentTab(1),
  "find:prevTab": () => fileMenu.activateAdjacentDocumentTab(-1),
  "find:gotoLine": findMenu.gotoLineDialog,
  "settings:preferences": fileMenu.showPreferences,
  "layout:right-editor": () => layoutManager.applyLayoutMode("right-editor", { persist: false, announce: true }),
  "layout:split": () => layoutManager.applyLayoutMode("split", { persist: false, announce: true }),
  "layout:bottom-code": () => layoutManager.applyLayoutMode("bottom-code", { persist: false, announce: true }),
  "layout:vertical": () => layoutManager.applyLayoutMode("vertical", { persist: false, announce: true }),
  "layout:editor-only": () => layoutManager.applyLayoutMode("editor-only", { persist: false, announce: true }),
  "layout:code-only": () => layoutManager.applyLayoutMode("code-only", { persist: false, announce: true }),
  "info:help": showHelpDialog,
  "info:about": showVersionDialog,
  "language:en": () => setUiLanguage("en"),
  "language:ko": () => setUiLanguage("ko"),
};

let menuBar = null;
let groups = [];
let activeGroupIndex = -1;
let activePopup = null;
let activeItemIndex = -1;
let keyboardMode = false;
let pendingAltToggle = false;
let restoreFocusEl = null;

function consumeBrowserShortcut(event, message = '브라우저 기본 단축키 차단') {
  event.preventDefault();
  event.stopPropagation();
  if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  setStatusMessage(message);
}

function isRefreshShortcut(event) {
  const key = String(event.key || '').toLowerCase();
  const code = String(event.code || '');
  const ctrl = event.ctrlKey || event.metaKey;
  return code === 'F5' || key === 'f5' || (ctrl && key === 'r');
}

function isFindAgainShortcut(event) {
  const key = String(event.key || '').toLowerCase();
  const ctrl = event.ctrlKey || event.metaKey;
  return ctrl && key === 'g';
}

function isBlockedBrowserShortcut(event) {
  const key = String(event.key || '').toLowerCase();
  const code = String(event.code || '');
  const ctrl = event.ctrlKey || event.metaKey;
  if (code === 'F7' || key === 'f7') return 'F7 커서 브라우징 단축키 차단';
  if (ctrl && !event.altKey && key === 'p') return 'Ctrl+P 인쇄 단축키 차단';
  if (ctrl && !event.altKey && key === 'j') return 'Ctrl+J 다운로드 단축키 차단';
  return '';
}

function closeAll() {
  groups.forEach(g => g.classList.remove("open", "menu-keyboard-focus"));
  document.querySelectorAll('.menu-submenu.open').forEach(el => el.classList.remove('open'));
  clearActiveItem();
  activeGroupIndex = -1;
  activePopup = null;
  keyboardMode = false;
}

function rememberFocusBeforeMenu() {
  const active = document.activeElement;
  if (active?.matches?.('textarea.editor-box')) restoreFocusEl = active;
  else if (!restoreFocusEl || !document.contains(restoreFocusEl)) restoreFocusEl = getActiveTextArea();
}

function focusMenuGroup(index = activeGroupIndex) {
  const group = groups[index];
  const button = group?.querySelector('.menu-button');
  button?.focus?.({ preventScroll: true });
}

function updateCursorStatusFromElement(el) {
  if (el?.id === 'codeText') setCursorLocation('코드창');
  else if (el?.id === 'editorText') setCursorLocation('편집창');
}

function closeAllAndRestoreFocus() {
  closeAll();
  const target = restoreFocusEl && document.contains(restoreFocusEl) ? restoreFocusEl : getActiveTextArea();
  target?.focus?.({ preventScroll: true });
  updateCursorStatusFromElement(target);
}

async function refreshStates() {
  await updateClipboardState();
  updateMenuState(document);
}

function refreshStatesAfterClipboardWrite() {
  setTimeout(() => { void refreshStates(); }, 0);
}

function setActiveGroup(index, open = false) {
  groups.forEach(g => g.classList.remove('menu-keyboard-focus'));
  activeGroupIndex = (index + groups.length) % groups.length;
  const group = groups[activeGroupIndex];
  group.classList.add('menu-keyboard-focus');
  setCursorLocation('메뉴바');
  if (keyboardMode) focusMenuGroup(activeGroupIndex);
  if (open) openGroup(group);
}

function openGroup(group) {
  groups.forEach(g => { if (g !== group) g.classList.remove('open'); });
  document.querySelectorAll('.menu-submenu.open').forEach(el => el.classList.remove('open'));
  group.classList.add('open');
  activePopup = group.querySelector(':scope > .menu-popup');
  clearActiveItem();
}

function getItems(popup = activePopup) {
  if (!popup) return [];
  return [...popup.querySelectorAll(':scope > .menu-command, :scope > .menu-check, :scope > .menu-submenu > .submenu-trigger')]
    .filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.classList.contains('menu-heading'));
}

function clearActiveItem() {
  document.querySelectorAll('.menu-command.keyboard-active, .menu-check.keyboard-active').forEach(el => el.classList.remove('keyboard-active'));
  activeItemIndex = -1;
}

function setActiveItem(index) {
  clearActiveItem();
  const items = getItems();
  if (!items.length) return;
  activeItemIndex = (index + items.length) % items.length;
  const item = items[activeItemIndex];
  item.classList.add('keyboard-active');
  item.scrollIntoView({ block: 'nearest' });
}

function activeItem() {
  const items = getItems();
  return items[activeItemIndex] || null;
}

async function runCommandButton(commandButton) {
  const command = commandButton?.dataset?.command;
  const handler = commandMap[command];
  if (!handler) return;
  if (commandButton.disabled || commandButton.getAttribute("aria-disabled") === "true") return;
  beginUserAction();
  closeAll();
  await handler();
  await refreshStates();
}

function activateMenuItem(item) {
  if (!item) return;
  const submenu = item.closest('.menu-submenu');
  if (item.classList.contains('submenu-trigger') && submenu) {
    submenu.classList.add('open');
    activePopup = submenu.querySelector('.submenu-popup');
    setActiveItem(0);
    return;
  }
  if (item.classList.contains('menu-check')) {
    const input = item.querySelector('input');
    if (input) {
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeAll();
    return;
  }
  runCommandButton(item);
}

function menuHasOpenGroup() { return groups.some(g => g.classList.contains('open')); }

function menuMnemonicIndex(letter) {
  if (!letter) return -1;
  return groups.findIndex(g => g.querySelector('.menu-button')?.dataset.mnemonic === letter);
}

async function handleMenuKeyboardLetter(event, letter) {
  const idx = menuMnemonicIndex(letter);
  if (idx >= 0) {
    event.preventDefault();
    event.stopPropagation();
    rememberFocusBeforeMenu();
    keyboardMode = true;
    await refreshStates();
    setActiveGroup(idx, true);
    return true;
  }
  if (keyboardMode) {
    event.preventDefault();
    event.stopPropagation();
    closeAllAndRestoreFocus();
    return true;
  }
  return false;
}

export function isMenuKeyboardRoutingActive() {
  return keyboardMode || menuHasOpenGroup();
}

export function initMenuBar() {
  menuBar = document.getElementById("menuBar");
  groups = [...menuBar.querySelectorAll(".menu-group")];

  document.addEventListener("mousedown", (event) => {
    const commandButton = event.target.closest("[data-command]");
    const menuButton = event.target.closest(".menu-button");
    if (commandButton || menuButton) event.preventDefault();
  }, true);

  for (const [idx, group] of groups.entries()) {
    const button = group.querySelector(".menu-button");
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      beginUserAction();
      rememberFocusBeforeMenu();
      const wasOpen = group.classList.contains("open");
      closeAll();
      if (!wasOpen) {
        await refreshStates();
        keyboardMode = false;
        setActiveGroup(idx, true);
      }
    });
    group.addEventListener("mouseenter", async () => {
      if (menuHasOpenGroup()) {
        await refreshStates();
        setActiveGroup(idx, true);
      }
    });
  }

  menuBar.addEventListener("mouseover", (event) => {
    const item = event.target.closest('.menu-command, .menu-check');
    if (!item || !menuBar.contains(item)) return;
    const popup = item.closest('.menu-popup, .submenu-popup');
    if (!popup || !menuHasOpenGroup()) return;
    activePopup = popup;
    const items = getItems(popup);
    const index = items.indexOf(item.classList.contains('submenu-trigger') ? item : item);
    if (index >= 0) setActiveItem(index);
  });

  document.addEventListener("mousedown", (event) => {
    if (!menuBar.contains(event.target)) {
      closeAll();
      updateCursorStatusFromElement(document.activeElement);
    }
  });

  document.addEventListener("selectionchange", () => updateMenuState(document));

  document.addEventListener("click", async (event) => {
    const check = event.target.closest(".menu-check");
    if (check && menuBar.contains(check)) closeAll();
  }, true);

  document.addEventListener("click", async (event) => {
    const commandButton = event.target.closest("[data-command]");
    if (!commandButton) return;
    await runCommandButton(commandButton);
  });

  document.addEventListener('keydown', async (event) => {
    if (hasBlockingModal()) {
      if (event.key === 'Alt' || event.key === 'F10' || event.altKey) {
        if (event.altKey && event.key === 'Tab') return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'F10') pokeTopModal(true);
      }
      return;
    }
    if (hasFloatingWindow()) {
      if (event.altKey && event.key === 'Tab') { pendingAltToggle = false; return; }
      if (event.key === 'Alt' && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        pendingAltToggle = false;
        return;
      }
      if (event.key === 'F10' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        pokeActiveFloatingWindow();
        return;
      }
    }
    if (event.altKey && event.key === 'Tab') { pendingAltToggle = false; return; }
    if (event.key === 'Alt' && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      pendingAltToggle = true;
      return;
    }
    if (event.altKey && event.key !== 'Alt') pendingAltToggle = false;

    const letter = event.key.length === 1 ? event.key.toLowerCase() : '';
    const bareAltMnemonic = event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey;
    if (letter && (keyboardMode || bareAltMnemonic)) {
      if (await handleMenuKeyboardLetter(event, letter)) return;
    }

    if (!keyboardMode && !menuHasOpenGroup()) return;

    if (event.key === 'Escape') { event.preventDefault(); closeAllAndRestoreFocus(); return; }
    if (event.key === 'Tab') { event.preventDefault(); setStatusMessage('Tab 이동은 비활성화됨'); return; }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      const item = activeItem();
      if (item?.classList.contains('submenu-trigger')) { activateMenuItem(item); return; }
      await refreshStates();
      setActiveGroup(activeGroupIndex + 1, menuHasOpenGroup());
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const parentSub = activePopup?.closest('.menu-submenu');
      if (parentSub) {
        parentSub.classList.remove('open');
        activePopup = parentSub.closest('.menu-popup');
        const items = getItems();
        activeItemIndex = Math.max(0, items.indexOf(parentSub.querySelector('.submenu-trigger')));
        setActiveItem(activeItemIndex);
        return;
      }
      await refreshStates();
      setActiveGroup(activeGroupIndex - 1, menuHasOpenGroup());
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!menuHasOpenGroup()) { openGroup(groups[activeGroupIndex < 0 ? 0 : activeGroupIndex]); setActiveItem(0); }
      else setActiveItem(activeItemIndex < 0 ? 0 : activeItemIndex + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!menuHasOpenGroup()) { openGroup(groups[activeGroupIndex < 0 ? 0 : activeGroupIndex]); setActiveItem(getItems().length - 1); }
      else setActiveItem(activeItemIndex < 0 ? getItems().length - 1 : activeItemIndex - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!menuHasOpenGroup()) openGroup(groups[activeGroupIndex < 0 ? 0 : activeGroupIndex]);
      else activateMenuItem(activeItem());
    }
  }, true);

  document.addEventListener('keyup', async (event) => {
    if (event.key !== 'Alt' || event.ctrlKey || event.shiftKey || event.metaKey) return;
    if (!pendingAltToggle) return;
    event.preventDefault();
    event.stopPropagation();
    pendingAltToggle = false;
    if (keyboardMode || menuHasOpenGroup()) {
      closeAllAndRestoreFocus();
      return;
    }
    rememberFocusBeforeMenu();
    keyboardMode = true;
    await refreshStates();
    setActiveGroup(0, false);
  }, true);

  window.addEventListener('blur', () => { pendingAltToggle = false; });
  window.addEventListener('focus', () => { void refreshStates(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshStates();
  });
  document.addEventListener('copy', refreshStatesAfterClipboardWrite, true);
  document.addEventListener('cut', refreshStatesAfterClipboardWrite, true);

  fileMenu.renderRecentDocuments();
  refreshStates();
}

let globalShortcutsRegistered = false;

export function handleGlobalShortcuts() {
  if (globalShortcutsRegistered) return;
  globalShortcutsRegistered = true;
  window.addEventListener('ttedit-document-history-request', (event) => {
    const command = event?.detail?.command === 'redo' ? 'redo' : 'undo';
    beginUserAction();
    if (command === 'redo') editMenu.redo();
    else editMenu.undo();
  });
  document.addEventListener("keydown", async (event) => {
    if (event.key === 'F3' || event.code === 'F3') {
      consumeBrowserShortcut(event, 'F3 브라우저 찾기 동작 차단');
      return;
    }
    if (isRefreshShortcut(event)) {
      consumeBrowserShortcut(event, '새로고침 단축키 차단');
      return;
    }
    const blockedBrowserShortcutMessage = isBlockedBrowserShortcut(event);
    if (blockedBrowserShortcutMessage) {
      consumeBrowserShortcut(event, blockedBrowserShortcutMessage);
      return;
    }
    if (isFindAgainShortcut(event)) {
      if (event.shiftKey) {
        consumeBrowserShortcut(event, 'Ctrl+Shift+G 브라우저 찾기 동작 차단');
        return;
      }
      if (event.altKey) return;
      consumeBrowserShortcut(event, '유니코드 입력기 열기');
      if (!hasBlockingModal()) {
        beginUserAction();
        insertMenu.unicodeDialog();
      }
      return;
    }
    if (hasBlockingModal()) return;
    if (isMenuKeyboardRoutingActive()) return;
    if (shouldYieldGlobalShortcutToFocusLayer(event)) return;
    const key = event.key.toLowerCase();
    const ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl) return;
    if (event.altKey) return;

    if (key === 'tab') {
      event.preventDefault();
      event.stopPropagation();
      beginUserAction();
      await fileMenu.activateAdjacentDocumentTab(event.shiftKey ? -1 : 1);
      return;
    }

    if (key === 'pagedown' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      beginUserAction();
      await fileMenu.activateAdjacentDocumentTab(1);
      return;
    }
    if (key === 'pageup' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      beginUserAction();
      await fileMenu.activateAdjacentDocumentTab(-1);
      return;
    }

    if (key === "f") {
      event.preventDefault();
      event.stopPropagation();
      beginUserAction();
      findMenu.findDialog();
      return;
    }
    if (key === "h") {
      event.preventDefault();
      event.stopPropagation();
      beginUserAction();
      findMenu.replaceDialog();
      return;
    }
    if (key === "k") {
      event.preventDefault();
      event.stopPropagation();
      beginUserAction();
      findMenu.colorConvertDialog();
      return;
    }
    if (key === "l" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      beginUserAction();
      editMenu.textCleanupDialog();
      return;
    }
    if (key === "t" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      beginUserAction();
      findMenu.gotoLineDialog();
      return;
    }

    const isDocumentTextArea = event.target?.matches?.('textarea.editor-box');
    if ((key === 'z' || key === 'y') && isDocumentTextArea && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      beginUserAction();
      if (key === 'y' || (key === 'z' && event.shiftKey)) editMenu.redo();
      else editMenu.undo();
      return;
    }
    if (isDocumentTextArea && event.shiftKey && (key === 'c' || key === 'v')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      beginUserAction();
      if (key === 'c') copySelectedFontColor();
      else pasteCopiedFontColor();
      return;
    }
    if (key === 'v' && isDocumentTextArea) {
      // Ctrl+V는 native paste event의 clipboardData를 사용해 일반/HTML 색상 근사 붙여넣기를 적용한다.
      // 텍스트로 붙여넣기는 메뉴/도구모음/우클릭에서 제공하고 Ctrl+Shift+V는 복사한 글꼴 색상 붙여넣기에 사용한다.
      return;
    }
    const isAnyTextInput = event.target?.tagName === "TEXTAREA" || event.target?.tagName === "INPUT";
    if (key === 'a' && !isDocumentTextArea && !isAnyTextInput && !event.target?.closest?.('.floating-window, .modal-window, .menu-bar')) {
      event.preventDefault();
      event.stopPropagation();
      beginUserAction();
      editMenu.selectAll();
      return;
    }

    const isTextEditShortcut = ["z", "y", "x", "c", "v", "a"].includes(key);
    if (event.target?.closest?.('.find-replace-floating-window')) return;
    if (isTextEditShortcut && (event.target?.tagName === "TEXTAREA" || event.target?.tagName === "INPUT")) return;
    beginUserAction();
    if (key === "n") { event.preventDefault(); await fileMenu.newFile(); }
    else if (key === "o" && event.shiftKey) { event.preventDefault(); await fileMenu.revealCurrentFile(); }
    else if (key === "o") { event.preventDefault(); await fileMenu.openFile(); }
    else if (key === "s" && event.shiftKey) { event.preventDefault(); await fileMenu.saveFileAs(); }
    else if (key === "s") { event.preventDefault(); await fileMenu.saveFile(); }
    else if (key === "w") { event.preventDefault(); await fileMenu.closeCurrentFile(); }
  }, true);
}
