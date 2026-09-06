import * as editMenu from './editMenu.js';
import { getCodeTextArea, getEditorTextArea } from './syncViews.js';
import { beginUserAction } from './statusBar.js';
import { readClipboardText, writeClipboardText, isTauriAvailable } from './fileApi.js';
import { gotoLineDialog } from './findMenu.js';
import { openUnicodeDialog } from './unicodeDialog.js';
import { hasFloatingWindow } from './floatingWindow.js';
import { hasActiveBlockingModal, focusTopBlockingModal } from './blockingModalManager.js';
import { getGlyphSettings, codeToChar } from './unicodeStore.js';
import { getPreferences, setNewInputDefaultColorPreference } from './preferences.js';
import { copySelectedFontColor, pasteCopiedFontColor, hasCopiedFontColor } from './colorCodes.js';

let menu = null;
let target = null;

function isEditorTarget(el) { return el === getCodeTextArea() || el === getEditorTextArea(); }
function isTabRestoreCustomTarget(el) { return el?.classList?.contains('tab-restore-custom-input'); }
function hasSelection(el) { return (el.selectionEnd ?? 0) > (el.selectionStart ?? 0); }

async function hasClipboardText() {
  if (!isTauriAvailable()) return true;
  try {
    const text = await readClipboardText();
    return !!text;
  } catch { return true; }
}

function close() { if (menu) menu.hidden = true; target = null; }
function createMenu() { menu = document.createElement('div'); menu.id = 'contextMenu'; menu.className = 'context-menu'; menu.hidden = true; document.body.appendChild(menu); }
function addSeparator() { const sep = document.createElement('div'); sep.className = 'context-separator'; menu.appendChild(sep); }


function addCheckButton(label, checked, command, disabled = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'context-check-button';
  btn.disabled = disabled;
  const text = document.createElement('span');
  text.className = 'context-check-label';
  text.textContent = label;
  const check = document.createElement('span');
  check.className = 'context-check-mark';
  check.textContent = checked ? '✓' : '';
  btn.append(text, check);
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    beginUserAction();
    const el = target;
    close();
    if (hasActiveBlockingModal()) focusTopBlockingModal();
    else el?.focus({ preventScroll: true });
    await command();
  });
  menu.appendChild(btn);
}

function addButton(label, command, disabled = false, title = '', shortcut = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  if (shortcut) {
    const text = document.createElement('span');
    text.className = 'context-command-label';
    text.textContent = label;
    const key = document.createElement('kbd');
    key.className = 'context-command-shortcut';
    key.textContent = shortcut;
    btn.append(text, key);
  } else {
    btn.textContent = label;
  }
  if (title) btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    beginUserAction();
    const el = target;
    close();
    if (hasActiveBlockingModal()) focusTopBlockingModal();
    else el?.focus({ preventScroll: true });
    await command();
  });
  menu.appendChild(btn);
}


async function writeClipboardTextSafe(text) {
  if (isTauriAvailable()) return await writeClipboardText(text);
  return await navigator.clipboard.writeText(text);
}

function insertIntoTextInput(el, text) {
  if (!el || typeof el.setRangeText !== 'function') return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.setRangeText(String(text ?? ''), start, end, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function copyFromTextInput(el) {
  const start = el?.selectionStart ?? 0;
  const end = el?.selectionEnd ?? start;
  if (end <= start) return;
  await writeClipboardTextSafe(String(el.value || '').slice(start, end));
}

async function cutFromTextInput(el) {
  const start = el?.selectionStart ?? 0;
  const end = el?.selectionEnd ?? start;
  if (end <= start) return;
  await writeClipboardTextSafe(String(el.value || '').slice(start, end));
  insertIntoTextInput(el, '');
}

async function pasteIntoTextInput(el) {
  const text = await (isTauriAvailable() ? readClipboardText() : navigator.clipboard.readText());
  if (text) insertIntoTextInput(el, text);
}

function showTabRestoreInputContextMenu(event, el) {
  event.preventDefault();
  target = el;
  target.focus({ preventScroll: true });
  const canSelect = hasSelection(el);
  menu.innerHTML = '';
  addButton('색상기호(ÿ) 입력', () => insertIntoTextInput(el, 'ÿ'), false);
  addSeparator();
  addButton('잘라내기', () => cutFromTextInput(el), !canSelect);
  addButton('복사', () => copyFromTextInput(el), !canSelect);
  addButton('붙여넣기', () => pasteIntoTextInput(el), false, '문자열 입력칸에 클립보드 텍스트를 붙여넣습니다.', 'Ctrl+V');
  addButton('텍스트로 붙여넣기', () => pasteIntoTextInput(el), false, '문자열 입력칸에 클립보드 텍스트를 붙여넣습니다.');
  addButton('모두 선택', () => { el.select(); }, !String(el.value || '').length);
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.hidden = false;
}

function defaultGlyphCode() { return getGlyphSettings().defaultCode || '2060'; }

function defaultGlyphLabel(code) {
  if (code === '2060') return '"0 너비 문자" 입력 (기본값)';
  const glyph = codeToChar(code);
  return `"${glyph}" 입력 (기본값)`;
}

function addDefaultGlyphButton(disabled = false) {
  const code = defaultGlyphCode();
  addButton(defaultGlyphLabel(code), () => editMenu.insertUnicodeGlyph(code), disabled);
}

export function initContextMenu() {
  createMenu();
  document.addEventListener('contextmenu', async (event) => {
    const el = event.target;
    if (isTabRestoreCustomTarget(el)) {
      if (!menu) createMenu();
      showTabRestoreInputContextMenu(event, el);
      return;
    }
    if (hasActiveBlockingModal()) return;
    if (!isEditorTarget(el)) { event.preventDefault(); close(); return; }
    event.preventDefault();
    target = el;
    target.focus({ preventScroll: true });
    const canSelect = hasSelection(el);
    const canPaste = await hasClipboardText();
    menu.innerHTML = '';
    const floatingOpen = hasFloatingWindow();
    const blockedByFloatingWindow = (action) => floatingOpen && !['insertDefaultGlyph', 'cut', 'copy', 'paste', 'pastePlain', 'selectAll'].includes(action);
    const codeTarget = el === getCodeTextArea();
    const blockedInCodeWindow = (action) => codeTarget && !['removeZeroWidth', 'cut', 'copy', 'paste', 'pastePlain', 'selectAll'].includes(action);
    const isBlocked = (action, base = false) => !!base || blockedByFloatingWindow(action) || blockedInCodeWindow(action);

    const defaultCode = defaultGlyphCode();
    addDefaultGlyphButton(isBlocked('insertDefaultGlyph'));
    if (defaultCode !== '2060') addButton('0 너비 문자(U+2060) 입력', editMenu.insertZeroWidthWithNotice, isBlocked('insertDefaultGlyph'));
    addButton('모든 0 너비 문자(U+2060) 삭제', editMenu.removeAllZeroWidthCharacters, isBlocked('removeZeroWidth'));
    addSeparator();
    addButton('유니코드 입력기..', openUnicodeDialog, isBlocked('unicodeDialog'), '유니코드 입력기 창을 엽니다. 단축키: Ctrl+G', 'Ctrl+G');
    addButton('텍스트 정리..', editMenu.textCleanupDialog, isBlocked('textCleanup'), '텍스트 정리 창을 엽니다. 단축키: Ctrl+L', 'Ctrl+L');
    addSeparator();
    const prefs = getPreferences();
    addCheckButton('새 입력 시 기본 색상', prefs.newInputDefaultColor === true, () => setNewInputDefaultColorPreference(getPreferences().newInputDefaultColor !== true), isBlocked('newInputDefaultColor'));
    addSeparator();
    addButton('잘라내기', editMenu.cut, isBlocked('cut', !canSelect));
    addButton('복사', editMenu.copy, isBlocked('copy', !canSelect));
    addButton('글꼴 색상 복사', copySelectedFontColor, isBlocked('copyFontColor', codeTarget || !canSelect), '편집창 선택 영역 첫 글자의 글꼴 색상을 복사합니다.', 'Ctrl+Shift+C');
    addButton('복사한 색상 붙여넣기', pasteCopiedFontColor, isBlocked('pasteFontColor', codeTarget || !canSelect || !hasCopiedFontColor()), '복사한 글꼴 색상을 편집창 선택 영역에 적용합니다.', 'Ctrl+Shift+V');
    addButton('일반 붙여넣기는 단축키(Ctrl+V)로만 이용', editMenu.paste, true, '일반/HTML 색상 근사 붙여넣기는 Ctrl+V native paste로만 사용합니다.');
    addButton('텍스트로 붙여넣기', editMenu.pastePlainText, isBlocked('pastePlain', !canPaste), '색상 매핑 없이 텍스트로 붙여넣습니다.');
    addButton('모두 선택', editMenu.selectAll, isBlocked('selectAll'));
    addSeparator();
    addButton('행 번호 찾아가기..', gotoLineDialog, isBlocked('gotoLine'));

    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.hidden = false;
  });
  document.addEventListener('mousedown', (event) => { if (hasActiveBlockingModal()) return; if (!menu?.contains(event.target)) close(); }, true);
  document.addEventListener('keydown', (event) => { if (hasActiveBlockingModal()) return; if (event.key === 'Escape') close(); }, true);
}
