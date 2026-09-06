import { state, restoreUndo, restoreRedo } from "./state.js";
import { getActiveTextArea, getCodeTextArea, getEditorTextArea, syncTextAreasFromState, refreshStatus, insertAtActiveView, captureDocumentSnapshot, applyDocumentTextAction, flushDocumentInputUndoState } from "./syncViews.js";
import { setStatusMessage, setErrorMessage } from "./statusBar.js";
import { showAlertModal, showConfirmModal, showModal } from "./modal.js";
import { formatCopyLineBreaks, normalizeNewlines } from "./textCodec.js";
import { readClipboardText, writeClipboardText, isTauriAvailable } from "./fileApi.js";
import { handleFindReplaceEditCommand } from "./findMenu.js";
import { openTextCleanupDialog } from './textCleanupDialog.js';
import { buildTextCleanupResult } from './textCleanupCore.js';
import { openJsonKeyExtractDialog } from './jsonKeyExtractDialog.js';
import { getPreferences } from './preferences.js';
import { shouldEncodeUnicodeCodePoint, normalizeGlyphCode, codePointToUnicodeEscapes } from './unicodeStore.js';
import { makeRawCodePatch, normalizeClipboardToRawFragment, rawCodeToVisibleText, rawFragmentFromVisibleRange } from './rawCodeModel.js';
import { DEFAULT_COLOR_CODE } from './colorPalette.js';
import { convertTabsToFillersAsync, restoreTabFillers } from './tabConvert.js';
import { showProgressOverlay } from './progressOverlay.js';
import { getColorInputPolicy } from './colorInputPolicy.js';
import { flushEditorColorOverlayNow } from './colorCodes.js';

function active() { return getActiveTextArea(); }
function activeSource(el = active()) { return el.id === "codeText" ? "code" : "editor"; }
function normalizeCodePaneRawInput(value) { return normalizeNewlines(value).replace(/\n/g, '\\n'); }

function focusActive() {
  const el = active();
  el.focus({ preventScroll: true });
  return el;
}

async function getClipboardText() {
  if (isTauriAvailable()) return await readClipboardText();
  return await navigator.clipboard.readText();
}

async function setClipboardText(text) {
  if (isTauriAvailable()) return await writeClipboardText(text);
  return await navigator.clipboard.writeText(text);
}

function selectedRange(el) {
  const start = el?.selectionStart ?? 0;
  const end = el?.selectionEnd ?? start;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function restoreSelectionAfterRawAction(source, pos) {
  const target = source === 'code' ? getCodeTextArea() : getEditorTextArea();
  target?.focus?.({ preventScroll: true });
  const max = target?.value?.length ?? 0;
  const safe = Math.max(0, Math.min(Number(pos) || 0, max));
  try { target.setSelectionRange(safe, safe); } catch (_) {}
}

function rawFragmentForEditorPaste(text) {
  const activeColor = getColorInputPolicy().newInputDefaultColor === true ? DEFAULT_COLOR_CODE : '';
  return normalizeClipboardToRawFragment(text, { activeColor, preserveColorCodes: true });
}

function replaceSelectionWithRawFragment(el, rawFragment, label, { actionType = 'paste-raw-fragment' } = {}) {
  el.focus({ preventScroll: true });
  const source = activeSource(el);
  const { start, end } = selectedRange(el);
  const fragment = String(rawFragment ?? '');
  let nextRawCode = '';
  let caret = start;

  if (source === 'code') {
    const rawInsert = normalizeCodePaneRawInput(fragment);
    nextRawCode = normalizeCodePaneRawInput(el.value.slice(0, start)) + rawInsert + normalizeCodePaneRawInput(el.value.slice(end));
    caret = start + rawInsert.length;
  } else {
    const visibleInsertLength = rawCodeToVisibleText(fragment).length;
    const pasteStart = start;
    const pasteEnd = end;
    nextRawCode = makeRawCodePatch(state.rawCode, pasteStart, pasteEnd, fragment).rawCode;
    caret = pasteStart + visibleInsertLength;
  }

  const snapshot = captureDocumentSnapshot(source);
  if (!applyDocumentTextAction(nextRawCode, { source, label, snapshot, actionType: source === 'editor' ? actionType : 'replace-selection', selectionRestoreMode: 'collapse-end' })) {
    // Standard paste semantics: replacing selected text with the same text is a
    // no-op that collapses at the replacement end, not a duplicate insertion.
    restoreSelectionAfterRawAction(source, caret);
    return;
  }
  restoreSelectionAfterRawAction(source, caret);
  setStatusMessage(label);
}

function replaceSelection(el, text, label) {
  const rawFragment = rawFragmentForEditorPaste(String(text ?? ''));
  replaceSelectionWithRawFragment(el, rawFragment, label, { actionType: 'paste-plain-text' });
}


function selectedEditorDocumentFragment(start, end) {
  return rawFragmentFromVisibleRange(state.rawCode, start, end);
}


function unicodeEscapeForCopy(text) {
  let out = '';
  for (const ch of normalizeNewlines(text)) {
    const cp = ch.codePointAt(0);
    if (shouldEncodeUnicodeCodePoint(cp)) out += '\\u' + cp.toString(16).toUpperCase().padStart(4, '0');
    else out += ch;
  }
  return out;
}

function omitUnicodeSymbolsForCopy(text) {
  let out = '';
  for (const ch of normalizeNewlines(text)) {
    const cp = ch.codePointAt(0);
    if (!shouldEncodeUnicodeCodePoint(cp)) out += ch;
  }
  return out;
}

function applyEditorCopyOptions(text, prefs = getPreferences()) {
  let out = normalizeNewlines(text);
  const mode = ['escape', 'glyph', 'omit'].includes(prefs.editorCopyUnicodeMode) ? prefs.editorCopyUnicodeMode : 'escape';
  if (mode === 'escape') out = unicodeEscapeForCopy(out);
  else if (mode === 'omit') out = omitUnicodeSymbolsForCopy(out);
  out = formatCopyLineBreaks(out, prefs.editorCopyUseLineBreakLiterals !== false);
  return out;
}

function selectedCopyText(el, start, end) {
  const source = activeSource(el);
  if (source !== 'editor') return el.value.slice(start, end);
  const prefs = getPreferences();
  const selected = prefs.editorCopyIncludeColorCodes !== false
    ? selectedEditorDocumentFragment(start, end)
    : el.value.slice(start, end);
  return applyEditorCopyOptions(selected, prefs);
}

function documentTextAreaIsFocused() {
  const activeEl = document.activeElement;
  return activeEl === getCodeTextArea() || activeEl === getEditorTextArea();
}

function editableFloatingInputIsFocused() {
  const activeEl = document.activeElement;
  if (!activeEl?.closest?.('.floating-window')) return false;
  if (activeEl.matches?.('textarea')) return true;
  if (!activeEl.matches?.('input')) return false;
  const type = String(activeEl.type || 'text').toLowerCase();
  return ['text', 'search', 'number', 'url', 'email', 'tel', 'password'].includes(type);
}

function floatingWindowIsFocused() {
  return !!document.activeElement?.closest?.('.floating-window');
}

function rejectNonDocumentUndo(command) {
  if (editableFloatingInputIsFocused()) {
    setStatusMessage(command === 'redo' ? '현재 입력칸 다시 실행만 허용됩니다.' : '현재 입력칸 실행취소만 허용됩니다.');
  } else if (floatingWindowIsFocused()) {
    setStatusMessage('입력 가능한 텍스트 박스에 커서가 없으면 실행취소/다시실행하지 않습니다.');
  } else {
    setStatusMessage('코드창/편집창에 커서가 있을 때만 문서 실행취소/다시실행을 적용합니다.');
  }
}

export function undo() {
  if (handleFindReplaceEditCommand('undo')) return;
  if (!documentTextAreaIsFocused()) { rejectNonDocumentUndo('undo'); return; }
  flushDocumentInputUndoState();
  if (!restoreUndo()) { setStatusMessage("실행취소할 내용 없음"); return; }
  syncTextAreasFromState("실행취소", { forceOverlay: true });
  flushEditorColorOverlayNow('history-undo-immediate');
  requestAnimationFrame(() => flushEditorColorOverlayNow('history-undo-post-layout'));
}
export function redo() {
  if (handleFindReplaceEditCommand('redo')) return;
  if (!documentTextAreaIsFocused()) { rejectNonDocumentUndo('redo'); return; }
  flushDocumentInputUndoState();
  if (!restoreRedo()) { setStatusMessage("다시 실행할 내용 없음"); return; }
  syncTextAreasFromState("다시 실행", { forceOverlay: true });
  flushEditorColorOverlayNow('history-redo-immediate');
  requestAnimationFrame(() => flushEditorColorOverlayNow('history-redo-post-layout'));
}

export async function cut() {
  const el = focusActive();
  const source = activeSource(el);
  const { start, end } = selectedRange(el);
  if (end <= start) { setStatusMessage("잘라낼 선택 영역 없음"); return; }
  const selected = selectedCopyText(el, start, end);
  try { await setClipboardText(selected); }
  catch (err) { setErrorMessage("클립보드 쓰기 실패: " + String(err)); return; }
  const nextRawCode = source === 'code'
    ? normalizeCodePaneRawInput(el.value.slice(0, start) + el.value.slice(end))
    : makeRawCodePatch(state.rawCode, start, end, '').rawCode;
  const snapshot = captureDocumentSnapshot(source);
  if (!applyDocumentTextAction(nextRawCode, { source, label: '잘라내기', snapshot, actionType: 'cut', selectionRestoreMode: 'collapse-start' })) return;
  restoreSelectionAfterRawAction(source, start);
  refreshStatus("잘라내기");
}


function handleNativeCopyEvent(event) {
  const editor = getEditorTextArea();
  if (!editor) return;
  const target = event?.target;
  if (target !== editor && document.activeElement !== editor) return;
  const start = editor.selectionStart ?? 0;
  const end = editor.selectionEnd ?? start;
  if (end <= start) return;
  const text = selectedCopyText(editor, start, end);
  if (event?.clipboardData) {
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    event.stopPropagation();
    setStatusMessage('편집창 복사');
    return;
  }
  event?.preventDefault?.();
  void setClipboardText(text)
    .then(() => setStatusMessage('편집창 복사'))
    .catch(err => setErrorMessage('클립보드 쓰기 실패: ' + String(err)));
}

function handleNativeCutEvent(event) {
  const editor = getEditorTextArea();
  if (!editor) return;
  const target = event?.target;
  if (target !== editor && document.activeElement !== editor) return;
  const start = editor.selectionStart ?? 0;
  const end = editor.selectionEnd ?? start;
  if (end <= start) return;
  const text = selectedCopyText(editor, start, end);
  const deleteSelection = () => {
    const snapshot = captureDocumentSnapshot('editor');
    const nextRawCode = makeRawCodePatch(state.rawCode, start, end, '').rawCode;
    if (!applyDocumentTextAction(nextRawCode, { source: 'editor', label: '잘라내기', snapshot, actionType: 'cut', selectionRestoreMode: 'collapse-start' })) return;
    restoreSelectionAfterRawAction('editor', start);
    refreshStatus('잘라내기');
  };
  if (event?.clipboardData) {
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    event.stopPropagation();
    deleteSelection();
    return;
  }
  event?.preventDefault?.();
  void setClipboardText(text)
    .then(() => deleteSelection())
    .catch(err => setErrorMessage('클립보드 쓰기 실패: ' + String(err)));
}

if (typeof document !== 'undefined') {
  document.addEventListener('copy', handleNativeCopyEvent, true);
  document.addEventListener('cut', handleNativeCutEvent, true);
}

export async function copy() {
  const el = focusActive();
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  if (end <= start) { setStatusMessage("복사할 선택 영역 없음"); return; }
  try {
    await setClipboardText(selectedCopyText(el, start, end));
    setStatusMessage(activeSource(el) === 'editor' ? "편집창 복사" : "복사");
  } catch (err) {
    setErrorMessage("클립보드 쓰기 실패: " + String(err));
  }
}

async function pastePlainWithLabel(label = '텍스트로 붙여넣기') {
  const el = focusActive();
  try {
    const text = await getClipboardText();
    if (!text) { setStatusMessage('붙여넣을 텍스트 없음'); return; }
    replaceSelection(el, text, label);
  } catch (err) {
    setErrorMessage('클립보드 읽기 실패: ' + String(err));
  }
}

export async function paste() {
  setStatusMessage('일반 붙여넣기는 단축키(Ctrl+V)로만 이용');
}

export async function pastePlainText() {
  await pastePlainWithLabel('텍스트로 붙여넣기');
}


let tabRestoreCustomScopeValue = 'per-tab';

function showTabRestoreDialog() {
  const wrap = document.createElement('div');
  wrap.className = 'tab-restore-dialog';
  wrap.innerHTML = `
    <div class="tab-restore-title">탭 구현 흔적을 무엇으로 바꿀까요?</div>
    <label class="tab-restore-option"><input type="radio" name="tabRestoreMode" value="tab" checked> <span class="tab-restore-label">탭 문자로 복원</span></label>
    <div class="tab-restore-note tab-restore-note-standalone">정확한 복구가 어려울 수도 있습니다</div>
    <div class="tab-restore-section-divider" aria-hidden="true"></div>
    <label class="tab-restore-option tab-restore-custom-row"><input type="radio" name="tabRestoreMode" value="custom"> <span>직접 입력한 문자열로 바꾸기</span><select id="tabRestoreCustomScope" class="tab-restore-scope-select"><option value="per-tab">탭 당 1개</option><option value="all-consecutive">모든 탭을 치환</option></select><input id="tabRestoreCustomInput" class="tab-restore-custom-input" type="text" autocomplete="off" spellcheck="false" placeholder="색상코드 포함 가능: 예) ÿc1---ÿc0"></label>
  `;
  const customInput = wrap.querySelector('#tabRestoreCustomInput');
  const customScope = wrap.querySelector('#tabRestoreCustomScope');
  const radios = Array.from(wrap.querySelectorAll('input[name="tabRestoreMode"]'));
  if (customScope) customScope.value = tabRestoreCustomScopeValue;
  const syncCustom = () => {
    const isCustom = wrap.querySelector('input[value="custom"]')?.checked;
    customInput.disabled = !isCustom;
    customScope.disabled = !isCustom;
    if (isCustom) customInput.focus({ preventScroll: true });
  };
  radios.forEach(radio => radio.addEventListener('change', syncCustom));
  customScope?.addEventListener('change', () => { tabRestoreCustomScopeValue = customScope.value === 'all-consecutive' ? 'all-consecutive' : 'per-tab'; });
  customInput.addEventListener('focus', () => { const custom = wrap.querySelector('input[value="custom"]'); if (custom) custom.checked = true; syncCustom(); });
  customInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      customInput.closest('.modal-layer')?.querySelector('.modal-footer button[data-modal-value="ok"]')?.click();
    }
  });
  syncCustom();
  return showModal({
    title: '탭 복원',
    body: wrap,
    buttons: [{ text: '확인', value: 'ok', default: true, shortcutKey: 'y' }, { text: '취소', value: 'cancel', shortcutKey: 'n' }],
  }).then(value => {
    if (value !== 'ok') return null;
    const mode = wrap.querySelector('input[name="tabRestoreMode"]:checked')?.value || 'tab';
    const customScopeValue = customScope?.value === 'all-consecutive' ? 'all-consecutive' : 'per-tab';
    tabRestoreCustomScopeValue = customScopeValue;
    return { mode, customText: customInput.value || '', customScope: customScopeValue };
  });
}

export async function implementTabs() {
  const tabCount = (String(state.rawCode || '').match(/	/g) || []).length;
  if (tabCount <= 0) { setStatusMessage('탭 구현: 변환할 탭 없음'); return false; }
  const ok = await showConfirmModal(`탭을 현재 글꼴/탭 너비 기준 검은 점·공백 조합으로 구현하시겠습니까?

대상 탭: ${tabCount}개`, { title: '탭 구현 확인' });
  if (!ok) { setStatusMessage('탭 구현 취소'); return false; }
  flushDocumentInputUndoState();
  const source = activeSource(active());
  const snapshot = captureDocumentSnapshot(source);
  const progress = showProgressOverlay({ title: '탭 구현 중', message: '현재 글꼴/탭 너비 기준으로 탭을 변환하는 중입니다.' });
  let result;
  try {
    result = await convertTabsToFillersAsync(state.rawCode, {
      rendering: state.rendering,
      editorElement: getEditorTextArea(),
      onProgress: ({ done, total }) => progress.setProgress({
        done,
        total,
        message: '현재 글꼴/탭 너비 기준으로 탭을 변환하는 중입니다.',
        detail: `${done} / ${total}개 탭 처리`,
      }),
    });
  } finally {
    progress.close();
  }
  if (!result.changed || result.converted <= 0) { setStatusMessage('탭 구현: 변환할 탭 없음'); return false; }
  return applyDocumentTextAction(result.rawCode, { source, label: `탭 구현: ${result.converted}개`, snapshot, actionType: 'implement-tabs', selectionRestoreMode: 'preserve' });
}

export async function restoreTabs() {
  const choice = await showTabRestoreDialog();
  if (!choice) { setStatusMessage('탭 복원 취소'); return false; }
  flushDocumentInputUndoState();
  const source = activeSource(active());
  const snapshot = captureDocumentSnapshot(source);
  const result = restoreTabFillers(state.rawCode, choice);
  if (!result.changed || result.restored <= 0) { setStatusMessage('탭 복원: 복원할 흔적 없음'); return false; }
  return applyDocumentTextAction(result.rawCode, { source, label: `탭 복원: ${result.restored}개`, snapshot, actionType: 'restore-tabs', selectionRestoreMode: 'preserve' });
}

export const textCleanupDialog = openTextCleanupDialog;
export const jsonKeyExtractDialog = openJsonKeyExtractDialog;

export function deleteSelection() {
  const el = focusActive();
  const source = activeSource(el);
  const { start, end } = selectedRange(el);
  if (end <= start) return;
  const nextRawCode = source === 'code'
    ? normalizeCodePaneRawInput(el.value.slice(0, start) + el.value.slice(end))
    : makeRawCodePatch(state.rawCode, start, end, '').rawCode;
  const snapshot = captureDocumentSnapshot(source);
  if (!applyDocumentTextAction(nextRawCode, { source, label: '삭제 완료', snapshot, actionType: 'delete-selection', selectionRestoreMode: 'collapse-start' })) return;
  restoreSelectionAfterRawAction(source, start);
  setStatusMessage("삭제 완료");
}


export function selectAll() {
  const el = focusActive();
  el.select();
  refreshStatus("모두 선택");
}

export async function copyCurrentPath() {
  const text = state.currentFilePath || state.currentFileName || "";
  if (!text) { setErrorMessage("복사할 현재 경로/파일명 없음"); return; }
  try {
    await setClipboardText(text);
    setStatusMessage("현재 경로/파일명 복사 완료");
  } catch (err) {
    setErrorMessage("클립보드 쓰기 실패: " + String(err));
  }
}

export { buildTextCleanupResult, textCleanupSummary, cleanupUnsafeInvisibleText, removeDuplicateEolFromText } from './textCleanupCore.js';

export function applyTextCleanupOptions(options = {}, { label = '텍스트 정리' } = {}) {
  const source = activeSource(active());
  const beforeDoc = state.documentText;
  const result = buildTextCleanupResult(state.rawCode, options);
  if (!result.changed || result.text === beforeDoc) {
    setStatusMessage(`${label}: 변경 없음`);
    return { ...result, changed: false };
  }
  applyDocumentTextAction(result.text, { source, label, snapshot: captureDocumentSnapshot(source), actionType: 'text-cleanup' });
  return result;
}


function applyCleanupCommand(options, label) {
  const result = applyTextCleanupOptions(options, { label });
  if (result.changed) setStatusMessage(label);
  return result.changed;
}

export function trimBoth() { return applyCleanupCommand({ trimDocumentEdges: true }, '양쪽 끝 공백 제거'); }
export function trimLineStart() { return applyCleanupCommand({ trimLineStart: true, includeTabsInLineTrim: true }, '행 시작 공백 제거'); }
export function trimLineEnd() { return applyCleanupCommand({ trimLineEnd: true, includeTabsInLineTrim: true }, '행 꼬리 공백 제거'); }
export function removeEol() { return applyCleanupCommand({ removeEol: true }, '줄바꿈 제거'); }
export function removeDuplicateEol() { return applyCleanupCommand({ removeDuplicateEol: true }, '중복 줄바꿈 제거'); }
export function removeEolAndSpaces() { return applyCleanupCommand({ removeEol: true, removeSpaces: true, removeTabs: true }, '줄바꿈 및 공백 제거'); }
export function removeTabs() { return applyCleanupCommand({ removeTabs: true }, '탭 문자 제거'); }


export function insertUnicodeGlyph(code) {
  const clean = normalizeGlyphCode(code);
  const codeLiteral = codePointToUnicodeEscapes(clean);
  if (!clean || !codeLiteral) { setErrorMessage("유효한 유니코드 주소가 아닙니다."); return; }
  insertAtActiveView({ codeLiteral, editorText: String.fromCodePoint(parseInt(clean, 16)), label: `U+${clean} 입력` });
}

export async function insertZeroWidthWithNotice() {
  await showAlertModal('커서 위치에 0 너비 문자(U+2060)를 삽입합니다. 이 문자가 들어있는 툴팁은 폰트가 시스템 기본폰트로 되돌아가므로, 일부 폰트 조건에서는 가독성이 살아날 수 있습니다.', { title: '0 너비 문자 입력' });
  insertUnicodeGlyph('2060');
}

function removeZeroWidthFromRawCode(rawCode) {
  const source = String(rawCode ?? '');
  let removed = 0;
  const text = source
    .replace(/\\u2060/gi, () => { removed += 1; return ''; })
    .replace(/⁠/g, () => { removed += 1; return ''; });
  return { text, removed, changed: text !== source };
}

export async function removeAllZeroWidthCharacters() {
  const ok = await showConfirmModal('글에 삽입된 모든 U+2060을 지웁니다. 해당 툴팁의 폰트가 인게임 구현 폰트로 정상 출력됩니다', { title: '0 너비 문자 삭제' });
  if (!ok) { setStatusMessage('0 너비 문자 삭제 취소'); return; }
  const source = activeSource(active());
  const result = removeZeroWidthFromRawCode(state.rawCode);
  if (!result.changed) { setStatusMessage('모든 U+2060 삭제: 변경 없음'); return; }
  if (!applyDocumentTextAction(result.text, { source, label: '모든 U+2060 삭제', snapshot: captureDocumentSnapshot(source), actionType: 'remove-zero-width' })) return;
  setStatusMessage(`모든 U+2060 삭제: ${result.removed}개`);
}
