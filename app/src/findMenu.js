import { state } from './state.js';
import { getEditorTextArea, getCodeTextArea, captureDocumentSnapshot, applyDocumentTextAction, activateDocumentInViews } from './syncViews.js';
import { setStatusMessage } from './statusBar.js';
import { showAlertModal, showConfirmModal } from './modal.js';
import { normalizeNewlines, lineStartOffset, lineEndOffset, countEditorLines, codeOffsetToEditorLine } from './textCodec.js';
import { scrollEditorToLine } from './lineNumbers.js';
import { createFloatingWindow, focusFloatingWindow, closeFloatingWindow, hasFloatingWindow, pokeActiveFloatingWindow, attachFloatingOpacityControl } from './floatingWindow.js';
import { attachDigitInput, sanitizeDigits } from './inputFilter.js';
import { addSearchHistory, getSearchHistory, getPreferences, addLineHistory, getLineHistory } from './preferences.js';
import { getActiveColorPalette, getColorByCode } from './colorPalette.js';
import { makeRawCodePatch, normalizeClipboardToRawFragment, rawCodeToVisibleText } from './rawCodeModel.js';
import { getRuntimeUiLanguage } from './uiLanguageRuntime.js';
import { localizeSystemGeneratedNewDocumentName } from './documentName.js';

let lastLineInput = '';
let gotoWindow = null;
let findWindow = null;
let activeFindTab = 'find';
let lastFindValue = '';
let lastReplaceValue = '';
let searchCursor = { editor: 0, code: 0 };
let activeMatch = null;
let replaceSignature = '';
let tooltipEl = null;
let mirrorOverlay = null;
let findMarker = null;
let markerMirror = null;
let initialFindTargetOverride = null;
let overlayInvalidationListenersAttached = false;
const DEFAULT_COLOR_CONVERT_FROM = 'ÿc0';
const DEFAULT_COLOR_CONVERT_TO = 'ÿcE';
const FIND_REPLACE_PRESET_FIND = 'ÿc';
const FIND_REPLACE_PRESET_REPLACE = '@Myc';
let lastColorConvertFrom = DEFAULT_COLOR_CONVERT_FROM;
let lastColorConvertTo = DEFAULT_COLOR_CONVERT_TO;
const inputHistories = new WeakMap();

function resetCursorForTarget(target) {
  const area = targetArea(target);
  searchCursor[target] = area?.selectionEnd ?? 0;
  resetReplaceState();
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function removeMarkerDom() {
  if (mirrorOverlay) { mirrorOverlay.remove(); mirrorOverlay = null; }
  if (markerMirror) { markerMirror.remove(); markerMirror = null; }
}

function clearMirrorOverlay() {
  findMarker = null;
  removeMarkerDom();
}

function invalidateFindOverlay() {
  clearMirrorOverlay();
  resetReplaceState();
}

function clearMarkerOnUserDocumentFocus(event) {
  const target = event?.target;
  if (target === getCodeTextArea() || target === getEditorTextArea()) clearMirrorOverlay();
}

function attachOverlayInvalidationListeners() {
  if (overlayInvalidationListenersAttached) return;
  const code = getCodeTextArea();
  const editor = getEditorTextArea();
  for (const area of [code, editor]) {
    area.addEventListener('input', invalidateFindOverlay);
    area.addEventListener('mousedown', clearMarkerOnUserDocumentFocus, true);
    area.addEventListener('focus', clearMarkerOnUserDocumentFocus, true);
    area.addEventListener('scroll', () => { if (findMarker) drawFindMarker(); }, { passive: true });
  }
  window.addEventListener('resize', () => { if (findMarker) drawFindMarker(); });
  window.addEventListener('ttedit-document-view-synced', clearMirrorOverlay);
  overlayInvalidationListenersAttached = true;
}

// hotfix12j: green find/replace marker is visual-only. It is not native selection and is never stored in undo/redo.

function initInputHistory(input) {
  if (!input || inputHistories.has(input)) return;
  inputHistories.set(input, { undo: [input.value || ''], redo: [], last: input.value || '', applying: false });
  input.addEventListener('input', () => {
    const h = inputHistories.get(input);
    if (!h || h.applying) return;
    const value = input.value || '';
    if (value === h.last) return;
    h.undo.push(value);
    if (h.undo.length > 20) h.undo.shift();
    h.redo = [];
    h.last = value;
  });
}

function applyInputHistory(input, direction) {
  const h = inputHistories.get(input);
  if (!h) return false;
  if (direction === 'undo') {
    if (h.undo.length <= 1) { setStatusMessage('입력칸 실행취소할 내용 없음'); return true; }
    const current = h.undo.pop();
    h.redo.push(current);
    const next = h.undo[h.undo.length - 1] ?? '';
    h.applying = true;
    input.value = next;
    h.last = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    h.applying = false;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    return true;
  }
  if (!h.redo.length) { setStatusMessage('입력칸 다시 실행할 내용 없음'); return true; }
  const next = h.redo.pop();
  h.undo.push(next);
  if (h.undo.length > 20) h.undo.shift();
  h.applying = true;
  input.value = next;
  h.last = next;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  h.applying = false;
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

export function handleFindReplaceEditCommand(command) {
  const active = document.activeElement;
  if (!active?.closest?.('.find-replace-floating-window')) return false;
  if (active.matches?.('#frFindText, #frReplaceText, #lineNumberInput')) {
    return applyInputHistory(active, command === 'redo' ? 'redo' : 'undo');
  }
  setStatusMessage('찾기/바꾸기 입력칸에 커서가 있을 때만 입력칸 실행취소가 적용됩니다.');
  return true;
}

function decodeEditorInput(value) {
  const source = normalizeNewlines(value);
  let out = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\' && source[i + 1] === 'n') { out += '\n'; i++; continue; }
    if (source[i] === '\\' && source[i + 1] === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
      out += String.fromCodePoint(parseInt(source.slice(i + 2, i + 6), 16));
      i += 5;
      continue;
    }
    out += source[i];
  }
  return out;
}

function normalizeInputForTarget(value, target) {
  if (target === 'editor') return decodeEditorInput(value);
  return normalizeNewlines(value).replace(/\n/g, '\\n');
}

function escapeRegExp(text) { return String(text).replace(/[.*+^${}()|[\]\\]/g, '\\$&'); }

function patternToRegex(pattern, { wildcard, caseSensitive }) {
  const source = [...String(pattern)].map(ch => ch === '?' ? '([\\s\\S])' : escapeRegExp(ch)).join('');
  return new RegExp(source, caseSensitive ? 'g' : 'gi');
}

function findLiteralMatches(text, pattern, { caseSensitive }) {
  const matches = [];
  if (!pattern) return matches;
  const haystack = caseSensitive ? text : text.toLocaleLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase();
  let pos = 0;
  while (pos <= haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) break;
    matches.push({ start: idx, end: idx + pattern.length, text: text.slice(idx, idx + pattern.length), captures: [] });
    pos = idx + Math.max(1, pattern.length);
  }
  return matches;
}

function findWildcardMatches(text, pattern, options) {
  const matches = [];
  if (!pattern) return matches;
  const re = patternToRegex(pattern, options);
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], captures: m.slice(1) });
    if (m[0].length === 0) re.lastIndex++;
  }
  return matches;
}

function getMatches(text, pattern, options) {
  if (!pattern) return [];
  return options.wildcard ? findWildcardMatches(text, pattern, options) : findLiteralMatches(text, pattern, options);
}

function optionsSignature(options) {
  return [
    options?.target || '',
    options?.pattern || '',
    options?.replacement || '',
    options?.wildcard ? 'w' : 'l',
    options?.caseSensitive ? 'c' : 'i',
    options?.backwards ? 'b' : 'f',
    options?.allTabs ? 'a' : 's'
  ].join('\u001f');
}

function resetReplaceState() {
  replaceSignature = '';
  activeMatch = null;
}

function matchEquals(a, b) {
  return !!a && !!b && a.start === b.start && a.end === b.end;
}

function setPreviewedReplaceHit(target, hit, backwards, documentId = state.activeDocumentId) {
  activeMatch = { target, documentId, start: hit.start, end: hit.end };
  searchCursor[target] = backwards ? hit.end : hit.start;
}

function replacementLengthDelta(hit, replacement) {
  return String(replacement ?? '').length - Math.max(0, hit.end - hit.start);
}

function adjustForwardActiveMatchAfterReplace(hit, nextHit, replacement) {
  if (!nextHit) return null;
  if (nextHit.start < hit.end) return null;
  const delta = replacementLengthDelta(hit, replacement);
  return { ...nextHit, start: nextHit.start + delta, end: nextHit.end + delta };
}

function replacementFromMatch(replacementPattern, match, options) {
  if (!options.wildcard) return replacementPattern;
  let index = 0;
  return String(replacementPattern).replace(/\?/g, () => match.captures[index++] ?? '');
}

function lineColFromOffset(text, offset) {
  const end = Math.max(0, Math.min(Number(offset) || 0, text.length));
  let line = 1;
  let colStart = 0;
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') { line++; colStart = i + 1; }
  }
  return { line, col: end - colStart + 1 };
}

function rawCodeLineStartOffset(codeText, lineNumber) {
  const text = String(codeText ?? '');
  const target = Math.max(1, Number.parseInt(lineNumber, 10) || 1);
  if (target <= 1) return 0;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === 'n') {
      line += 1;
      i += 1;
      if (line === target) return i + 1;
    }
  }
  return text.length;
}

function codeLineColFromOffset(codeText, offset) {
  const line = codeOffsetToEditorLine(codeText, offset);
  const lineCodeStart = rawCodeLineStartOffset(codeText, line);
  return { line, col: Math.max(1, offset - lineCodeStart + 1) };
}

function snippetAround(text, start, end, max = 80) {
  const left = Math.max(0, start - Math.floor(max / 2));
  const right = Math.min(text.length, end + Math.floor(max / 2));
  const prefix = left > 0 ? '…' : '';
  const suffix = right < text.length ? '…' : '';
  return prefix + text.slice(left, right).replace(/\n/g, '\\n') + suffix;
}

function getFindControls() {
  if (!findWindow) return null;
  const root = findWindow.querySelector('.find-replace-window');
  if (!root) return null;
  return {
    root,
    findText: root.querySelector('#frFindText'),
    replaceText: root.querySelector('#frReplaceText'),
    target: root.querySelector('input[name="frTarget"]:checked')?.value || 'editor',
    allTabs: !!root.querySelector('#frAllTabs')?.checked,
    backwards: !!root.querySelector('#frBackwards')?.checked,
    wrap: !!root.querySelector('#frWrap')?.checked,
    wildcard: !!root.querySelector('#frWildcard')?.checked,
    caseSensitive: !!root.querySelector('#frCase')?.checked,
    results: root.querySelector('#frResults'),
    count: root.querySelector('#frCount'),
    findNextButton: root.querySelector('#frFindNext'),
    clearInputsButton: root.querySelector('#frClearInputs'),
    presetSwapButton: root.querySelector('#frPresetSwap'),
    colorFrom: root.querySelector('#frColorFrom'),
    colorTo: root.querySelector('#frColorTo'),
    colorSwap: root.querySelector('#frColorSwap'),
    colorWarning: root.querySelector('#frColorWarning'),
    colorFromSwatch: root.querySelector('#frColorFromSwatch'),
    colorToSwatch: root.querySelector('#frColorToSwatch'),
    colorSwapSelections: root.querySelector('#frColorSwapSelections'),
  };
}

function getTargetText(target) {
  return target === 'code' ? getCodeTextArea().value : rawCodeToVisibleText(state.rawCode);
}

function normalizeCodePaneRawInput(value) {
  return normalizeNewlines(value).replace(/\n/g, '\\n');
}

function setTargetText(target, text, label) {
  const documentText = target === 'code' ? normalizeCodePaneRawInput(text) : normalizeNewlines(text);
  if (documentText === state.rawCode) {
    setStatusMessage(`${label}: 변경 없음`);
    return false;
  }
  return applyDocumentTextAction(documentText, { source: target, label, snapshot: captureDocumentSnapshot(target), actionType: label.includes('모두') ? 'replace-all' : 'replace-one' });
}

function editorReplacementFragment(replacement) {
  return normalizeClipboardToRawFragment(String(replacement ?? ''), { preserveColorCodes: true });
}

function editorReplacementVisibleText(replacement) {
  return rawCodeToVisibleText(editorReplacementFragment(replacement));
}

function replacementVisibleForTarget(target, replacement) {
  return target === 'editor' ? editorReplacementVisibleText(replacement) : String(replacement ?? '');
}

function applyEditorReplaceRange(hit, replacement, label, actionType = 'replace-one') {
  const rawFragment = editorReplacementFragment(replacement);
  const nextRawCode = makeRawCodePatch(state.rawCode, hit.start, hit.end, rawFragment).rawCode;
  if (nextRawCode === state.rawCode) {
    setStatusMessage(`${label}: 변경 없음`);
    return false;
  }
  return applyDocumentTextAction(nextRawCode, { source: 'editor', label, snapshot: captureDocumentSnapshot('editor'), actionType });
}

function applyEditorReplaceAll(matches, opt, label) {
  let nextRawCode = state.rawCode;
  for (let i = matches.length - 1; i >= 0; i--) {
    const hit = matches[i];
    const replacement = replacementFromMatch(opt.replacement, hit, opt);
    nextRawCode = makeRawCodePatch(nextRawCode, hit.start, hit.end, editorReplacementFragment(replacement)).rawCode;
  }
  if (nextRawCode === state.rawCode) {
    setStatusMessage(`${label}: 변경 없음`);
    return false;
  }
  return applyDocumentTextAction(nextRawCode, { source: 'editor', label, snapshot: captureDocumentSnapshot('editor'), actionType: 'replace-all-editor-raw' });
}

function targetArea(target) { return target === 'code' ? getCodeTextArea() : getEditorTextArea(); }

function nonEmptySelection(area) {
  if (!area) return '';
  const start = area.selectionStart ?? 0;
  const end = area.selectionEnd ?? start;
  if (end <= start) return '';
  return area.value.slice(start, end);
}

function getFindPrefillFromDocumentSelection() {
  const editor = getEditorTextArea();
  const code = getCodeTextArea();
  const active = document.activeElement;
  if (active === editor) {
    const text = nonEmptySelection(editor);
    return text ? { text, target: 'editor' } : null;
  }
  if (active === code) {
    const text = nonEmptySelection(code);
    return text ? { text: rawCodeToVisibleText(text), target: 'editor' } : null;
  }
  const preferred = state.activeView === 'code' ? code : editor;
  const fallback = preferred === code ? editor : code;
  let text = nonEmptySelection(preferred);
  if (text) return preferred === code ? { text: rawCodeToVisibleText(text), target: 'editor' } : { text, target: 'editor' };
  text = nonEmptySelection(fallback);
  if (text) return fallback === code ? { text: rawCodeToVisibleText(text), target: 'editor' } : { text, target: 'editor' };
  return null;
}

function applyFindPrefill(prefill) {
  if (!prefill?.text) return false;
  lastFindValue = prefill.text;
  initialFindTargetOverride = prefill.target || 'editor';
  const c = getFindControls();
  if (c?.findText) {
    c.findText.value = prefill.text;
    c.findText.dispatchEvent(new Event('input', { bubbles: true }));
    const radio = c.root.querySelector(`input[name="frTarget"][value="${initialFindTargetOverride}"]`);
    if (radio) radio.checked = true;
    resetCursorForTarget(initialFindTargetOverride);
  }
  return true;
}


function copyMarkerTextAreaStyle(source, dest) {
  const cs = getComputedStyle(source);
  const props = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth',
    'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'whiteSpace',
    'overflowWrap', 'wordBreak', 'tabSize'
  ];
  for (const prop of props) dest.style[prop] = cs[prop];
}

function textForMarker(target) {
  return target === 'code' ? targetArea('code').value : targetArea('editor').value;
}

function markerStillValid() {
  if (!findMarker) return false;
  if (findMarker.documentId !== state.activeDocumentId) return false;
  const text = textForMarker(findMarker.target);
  if (findMarker.start < 0 || findMarker.end <= findMarker.start || findMarker.end > text.length) return false;
  return text.slice(findMarker.start, findMarker.end) === findMarker.text;
}

function ensureMarkerOverlay(area) {
  if (!mirrorOverlay) {
    mirrorOverlay = document.createElement('div');
    mirrorOverlay.className = 'find-marker-overlay';
    mirrorOverlay.setAttribute('aria-hidden', 'true');
    document.body.appendChild(mirrorOverlay);
  }
  if (!markerMirror) {
    markerMirror = document.createElement('div');
    markerMirror.className = 'find-marker-mirror';
    markerMirror.setAttribute('aria-hidden', 'true');
    document.body.appendChild(markerMirror);
  }
  const rect = area.getBoundingClientRect();
  mirrorOverlay.style.left = `${rect.left}px`;
  mirrorOverlay.style.top = `${rect.top}px`;
  mirrorOverlay.style.width = `${rect.width}px`;
  mirrorOverlay.style.height = `${rect.height}px`;
  markerMirror.style.left = `${rect.left - area.scrollLeft}px`;
  markerMirror.style.top = `${rect.top - area.scrollTop}px`;
  markerMirror.style.width = `${area.clientWidth}px`;
  copyMarkerTextAreaStyle(area, markerMirror);
  return rect;
}

function appendMarkerText(parent, text) {
  parent.appendChild(document.createTextNode(text.length ? text : '​'));
}

function drawFindMarker() {
  if (!markerStillValid()) { clearMirrorOverlay(); return; }
  const area = targetArea(findMarker.target);
  const rect = ensureMarkerOverlay(area);
  const text = area.value || '';
  const before = text.slice(0, findMarker.start);
  const hit = text.slice(findMarker.start, findMarker.end);
  const after = text.slice(findMarker.end);
  markerMirror.textContent = '';
  appendMarkerText(markerMirror, before);
  const span = document.createElement('span');
  span.className = `find-marker-span ${findMarker.kind === 'replace-next' ? 'replace-next' : 'find-current'}`;
  appendMarkerText(span, hit);
  markerMirror.appendChild(span);
  appendMarkerText(markerMirror, after || '​');
  mirrorOverlay.innerHTML = '';
  const markerRects = Array.from(span.getClientRects());
  for (const r of markerRects) {
    const left = Math.max(r.left, rect.left);
    const top = Math.max(r.top, rect.top);
    const right = Math.min(r.right, rect.right);
    const bottom = Math.min(r.bottom, rect.bottom);
    if (right <= left || bottom <= top) continue;
    const box = document.createElement('div');
    box.className = `find-marker-rect ${findMarker.kind === 'replace-next' ? 'replace-next' : 'find-current'}`;
    box.style.left = `${left - rect.left}px`;
    box.style.top = `${top - rect.top}px`;
    box.style.width = `${right - left}px`;
    box.style.height = `${bottom - top}px`;
    mirrorOverlay.appendChild(box);
  }
}

function setFindMarker(target, start, end, kind = 'find-current') {
  const text = textForMarker(target);
  const safeStart = Math.max(0, Math.min(Number(start) || 0, text.length));
  const safeEnd = Math.max(safeStart, Math.min(Number(end) || safeStart, text.length));
  if (safeEnd <= safeStart) { clearMirrorOverlay(); return; }
  findMarker = {
    documentId: state.activeDocumentId,
    target,
    start: safeStart,
    end: safeEnd,
    kind,
    color: 'green',
    text: text.slice(safeStart, safeEnd),
  };
  drawFindMarker();
}

function focusReplaceInput() {
  const c = getFindControls();
  const el = c?.replaceText;
  if (!el || !document.contains(el)) return;
  el.focus({ preventScroll: true });
  try {
    const pos = el.selectionStart ?? el.value.length;
    el.setSelectionRange(pos, pos);
  } catch (_) {}
}

function scrollTextAreaOffsetToCenter(area, offset) {
  const text = area.value || '';
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const line = before.split('\n').length - 1;
  const cs = getComputedStyle(area);
  const lineHeight = Number.parseFloat(cs.lineHeight) || (Number.parseFloat(cs.fontSize) || 15) * 1.45;
  area.scrollTop = Math.max(0, line * lineHeight - Math.max(0, (area.clientHeight - lineHeight) * 0.5));
}

function showRange(target, start, end, message = null, kind = 'find-current') {
  const active = document.activeElement;
  const area = targetArea(target);
  scrollTextAreaOffsetToCenter(area, start);
  if (target === 'editor') {
    const lc = lineColFromOffset(area.value, start);
    scrollEditorToLine(lc.line, 0.45);
  } else {
    const lc = codeLineColFromOffset(area.value, start);
    scrollEditorToLine(lc.line, 0.45);
  }
  setFindMarker(target, start, end, kind);
  if (active && document.contains(active) && active !== area) {
    try { active.focus({ preventScroll: true }); } catch (_) {}
    if (active.tagName === 'INPUT' && typeof active.setSelectionRange === 'function') {
      const pos = active.selectionStart ?? active.value.length;
      try { active.setSelectionRange(pos, pos); } catch (_) {}
    }
  }
  if (message) setStatusMessage(message);
}

function currentOptions() {
  const c = getFindControls();
  if (!c) return null;
  const pattern = normalizeInputForTarget(c.findText.value, c.target);
  const replacement = normalizeInputForTarget(c.replaceText?.value || '', c.target);
  return { ...c, pattern, replacement, wildcard: c.wildcard, caseSensitive: c.caseSensitive };
}

function setCountIdle() {
  const c = getFindControls();
  const row = c?.root?.querySelector('.fr-count-row');
  if (row) row.hidden = true;
  if (c?.count) c.count.textContent = '';
}

function rememberSearch(value) {
  const v = String(value || '').trim();
  if (v) addSearchHistory(v);
}

function rememberReplace(value) {
  const v = String(value || '').trim();
  if (v) addSearchHistory(v);
}

function pickNextMatch(matches, options) {
  if (!matches.length) return null;
  const backwards = !!options.backwards;
  const from = searchCursor[options.target] ?? 0;
  if (backwards) {
    let hit = [...matches].reverse().find(m => m.end <= from);
    if (!hit && options.wrap) hit = matches[matches.length - 1];
    return hit || null;
  }
  let hit = matches.find(m => m.start >= from);
  if (!hit && options.wrap) hit = matches[0];
  return hit || null;
}

function advanceCursor(target, hit, backwards, documentId = state.activeDocumentId) {
  searchCursor[target] = backwards ? hit.start : hit.end;
  activeMatch = { target, documentId, start: hit.start, end: hit.end };
}



function documentTargetText(doc, target) {
  const raw = String(doc?.documentText ?? '');
  return target === 'code' ? raw : rawCodeToVisibleText(raw);
}

function documentTabLabel(doc, index = 0) {
  const raw = String(doc?.currentFileName || '').trim();
  if (raw) return doc?.systemGeneratedName === true
    ? localizeSystemGeneratedNewDocumentName(raw, getRuntimeUiLanguage())
    : raw;
  return getRuntimeUiLanguage() === 'en' ? `Tab ${index + 1}` : `탭 ${index + 1}`;
}

function resultLineColumnLabel(line, column) {
  return getRuntimeUiLanguage() === 'en'
    ? `Line ${line}, Column ${column}`
    : `${line}행 ${column}열`;
}

function resultMoveLabel(label, line, column) {
  return getRuntimeUiLanguage() === 'en'
    ? `Moved to ${label}: line ${line}, column ${column}`
    : `${label}: ${line}행 ${column}열로 이동`;
}

function lineColumnMoveLabel(line, column) {
  return getRuntimeUiLanguage() === 'en'
    ? `Moved to line ${line}, column ${column}`
    : `${line}행 ${column}열로 이동`;
}

function firstDirectionalMatch(matches, backwards) {
  if (!matches.length) return null;
  return backwards ? matches[matches.length - 1] : matches[0];
}

function nextAcrossAllTabs(opt) {
  const docs = Array.isArray(state.documents) ? state.documents : [];
  if (!docs.length) return null;
  const activeIndex = Math.max(0, docs.findIndex(doc => doc.id === state.activeDocumentId));
  const activeDoc = docs[activeIndex];
  const activeText = documentTargetText(activeDoc, opt.target);
  const activeMatches = getMatches(activeText, opt.pattern, opt);
  const local = pickNextMatch(activeMatches, { ...opt, wrap: false });
  if (local) return { doc: activeDoc, docIndex: activeIndex, text: activeText, hit: local };

  const visit = [];
  if (opt.backwards) {
    for (let i = activeIndex - 1; i >= 0; i--) visit.push(i);
    if (opt.wrap) for (let i = docs.length - 1; i > activeIndex; i--) visit.push(i);
  } else {
    for (let i = activeIndex + 1; i < docs.length; i++) visit.push(i);
    if (opt.wrap) for (let i = 0; i < activeIndex; i++) visit.push(i);
  }
  for (const index of visit) {
    const doc = docs[index];
    const text = documentTargetText(doc, opt.target);
    const hit = firstDirectionalMatch(getMatches(text, opt.pattern, opt), opt.backwards);
    if (hit) return { doc, docIndex: index, text, hit };
  }
  if (opt.wrap) {
    const wrapped = firstDirectionalMatch(activeMatches, opt.backwards);
    if (wrapped) return { doc: activeDoc, docIndex: activeIndex, text: activeText, hit: wrapped };
  }
  return null;
}

function activateAllTabHit(opt, result, message, kind = 'find-current') {
  if (!result?.doc || !result?.hit) return false;
  if (result.doc.id !== state.activeDocumentId) activateDocumentInViews(result.doc.id, '모든 탭 찾기: 문서 탭 이동');
  advanceCursor(opt.target, result.hit, opt.backwards, result.doc.id);
  showRange(opt.target, result.hit.start, result.hit.end, message, kind);
  return true;
}

function collectAllTabMatches(opt) {
  const groups = [];
  let total = 0;
  const docs = Array.isArray(state.documents) ? state.documents : [];
  docs.forEach((doc, docIndex) => {
    const text = documentTargetText(doc, opt.target);
    const matches = getMatches(text, opt.pattern, opt);
    if (!matches.length) return;
    groups.push({ doc, docIndex, text, matches });
    total += matches.length;
  });
  return { groups, total };
}

function buildReplacementRawForDocument(doc, opt, matches) {
  const raw = String(doc?.documentText ?? '');
  if (opt.target === 'editor') {
    let next = raw;
    for (let i = matches.length - 1; i >= 0; i--) {
      const hit = matches[i];
      const replacement = replacementFromMatch(opt.replacement, hit, opt);
      next = makeRawCodePatch(next, hit.start, hit.end, editorReplacementFragment(replacement)).rawCode;
    }
    return next;
  }
  const text = raw;
  let out = '';
  let last = 0;
  for (const hit of matches) {
    out += text.slice(last, hit.start) + replacementFromMatch(opt.replacement, hit, opt);
    last = hit.end;
  }
  return normalizeCodePaneRawInput(out + text.slice(last));
}

function renderAllTabResults(opt, groups, total) {
  if (!opt?.results) return;
  opt.results.classList.add('visible');
  const countRow = opt.root.querySelector('.fr-count-row');
  if (countRow) countRow.hidden = false;
  opt.count.textContent = `${total.toLocaleString('ko-KR')}개`;
  if (!total) {
    opt.results.innerHTML = '<div class="fr-empty">찾는 문자열 없음</div>';
    refreshFindWindowSize();
    return;
  }
  opt.results.innerHTML = `<div class="fr-result-summary">총 ${total.toLocaleString('ko-KR')}개 · ${groups.length.toLocaleString('ko-KR')}개 탭</div>`;
  const list = document.createElement('div');
  list.className = 'fr-result-list';
  let resultIndex = 0;
  outer: for (const group of groups) {
    for (const hit of group.matches) {
      if (resultIndex >= 500) break outer;
      const lc = opt.target === 'code' ? codeLineColFromOffset(group.text, hit.start) : lineColFromOffset(group.text, hit.start);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fr-result-item fr-result-item-all-tabs';
      const label = documentTabLabel(group.doc, group.docIndex);
      btn.innerHTML = `<span class="fr-result-pos">${resultIndex + 1}. ${escapeHtml(label)} · ${escapeHtml(resultLineColumnLabel(lc.line, lc.col))}</span><span class="fr-result-text">${escapeHtml(snippetAround(group.text, hit.start, hit.end))}</span>`;
      btn.addEventListener('click', () => {
        if (group.doc.id !== state.activeDocumentId) activateDocumentInViews(group.doc.id, '모든 탭 찾기 결과 이동');
        searchCursor[opt.target] = opt.backwards ? hit.start : hit.end;
        activeMatch = { target: opt.target, documentId: group.doc.id, start: hit.start, end: hit.end };
        showRange(opt.target, hit.start, hit.end, resultMoveLabel(label, lc.line, lc.col), 'find-current');
        list.querySelectorAll('.fr-result-item.selected').forEach(item => item.classList.remove('selected'));
        btn.classList.add('selected');
      });
      list.appendChild(btn);
      resultIndex += 1;
    }
  }
  if (total > 500) {
    const more = document.createElement('div');
    more.className = 'fr-more';
    more.textContent = `표시는 500개까지만 합니다. 나머지 ${total - 500}개는 생략.`;
    list.appendChild(more);
  }
  opt.results.appendChild(list);
  refreshFindWindowSize();
}

function refreshFindWindowSize() {
  if (!findWindow) return;
  findWindow.style.height = 'auto';
  const rect = findWindow.getBoundingClientRect();
  if (rect.bottom > window.innerHeight - 8) {
    findWindow.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
  }
}

function resetResultPanel() {
  const c = getFindControls();
  if (c?.results) {
    c.results.classList.remove('visible');
    c.results.innerHTML = '<div class="fr-empty">모두 찾기를 누르면 결과가 여기에 표시됩니다.</div>';
  }
  setCountIdle();
  refreshFindWindowSize();
}

async function alertNoMatches(tab = activeFindTab) {
  await showAlertModal(tab === 'replace' ? '바꿀 문자열이 없습니다.' : '찾는 문자열이 없습니다.', { title: tab === 'replace' ? '바꾸기' : '찾기' });
  getFindControls()?.findText?.focus({ preventScroll: true });
}

async function alertBoundary(options) {
  const scope = options.allTabs ? '모든 탭의 ' : '문서의 ';
  const msg = options.backwards ? `${scope}처음까지 찾았습니다.` : `${scope}끝까지 찾았습니다.`;
  await showAlertModal(msg, { title: options.backwards ? '이전 찾기' : '다음 찾기' });
  getFindControls()?.findText?.focus({ preventScroll: true });
}

export async function findNext() {
  const opt = currentOptions();
  if (!opt) return false;
  if (!opt.pattern) { setStatusMessage('찾을 문자열을 입력하세요'); opt.findText.focus(); return false; }
  rememberSearch(opt.findText.value);
  if (opt.allTabs) {
    const result = nextAcrossAllTabs(opt);
    if (!result) {
      const any = collectAllTabMatches(opt).total;
      if (!any) await alertNoMatches('find');
      else await alertBoundary(opt);
      return false;
    }
    activateAllTabHit(opt, result, `모든 탭 ${opt.backwards ? '이전' : '다음'} 찾음: ${documentTabLabel(result.doc, result.docIndex)}`, 'find-current');
    resetResultPanel();
    return true;
  }
  const text = getTargetText(opt.target);
  const matches = getMatches(text, opt.pattern, opt);
  if (!matches.length) { await alertNoMatches('find'); return false; }
  const hit = pickNextMatch(matches, opt);
  if (!hit) { await alertBoundary(opt); return false; }
  advanceCursor(opt.target, hit, opt.backwards);
  showRange(opt.target, hit.start, hit.end, `${opt.target === 'code' ? '코드창' : '편집창'}에서 ${opt.backwards ? '이전' : '다음'} 찾음`, 'find-current');
  resetResultPanel();
  return true;
}

export function replaceOne() {
  const opt = currentOptions();
  if (!opt) return false;
  if (!opt.pattern) { setStatusMessage('찾을 문자열을 입력하세요'); opt.findText.focus(); return false; }
  rememberSearch(opt.findText.value);
  rememberReplace(opt.replaceText?.value || '');
  if (opt.allTabs) return replaceOneAcrossAllTabs(opt);
  const text = getTargetText(opt.target);
  const matches = getMatches(text, opt.pattern, opt);
  if (!matches.length) { void alertNoMatches('replace'); return false; }
  const sig = optionsSignature(opt);
  if (replaceSignature && replaceSignature !== sig) activeMatch = null;
  replaceSignature = sig;
  let hit = activeMatch?.target === opt.target ? matches.find(m => matchEquals(m, activeMatch)) : null;
  if (!hit) {
    hit = pickNextMatch(matches, opt);
    if (!hit) { void alertBoundary(opt); return false; }
    setPreviewedReplaceHit(opt.target, hit, opt.backwards);
    showRange(opt.target, hit.start, hit.end, '바꿀 대상 표시', 'replace-next');
    focusReplaceInput();
    resetResultPanel();
    return true;
  }

  const replacement = replacementFromMatch(opt.replacement, hit, opt);
  const replacementVisible = replacementVisibleForTarget(opt.target, replacement);
  const nextText = text.slice(0, hit.start) + replacementVisible + text.slice(hit.end);

  let nextHit = null;
  if (opt.backwards) {
    searchCursor[opt.target] = hit.start;
    const beforeMatches = getMatches(nextText, opt.pattern, opt);
    nextHit = pickNextMatch(beforeMatches, opt);
  } else {
    const originalNext = matches.find(m => m.start >= hit.end);
    nextHit = adjustForwardActiveMatchAfterReplace(hit, originalNext, replacementVisible);
    if (!nextHit && opt.wrap) {
      const afterMatches = getMatches(nextText, opt.pattern, opt);
      nextHit = afterMatches.find(m => m.start < hit.start) || null;
    }
  }

  if (opt.target === 'editor') applyEditorReplaceRange(hit, replacement, replacementVisible ? '바꾸기 완료' : '삭제 완료', 'replace-one-editor-raw');
  else setTargetText(opt.target, nextText, replacementVisible ? '바꾸기 완료' : '삭제 완료');

  if (nextHit) {
    setPreviewedReplaceHit(opt.target, nextHit, opt.backwards);
    showRange(opt.target, nextHit.start, nextHit.end, replacementVisible ? '바꾸기 완료: 다음 대상 표시' : '삭제 완료: 다음 대상 표시', 'replace-next');
    focusReplaceInput();
  } else {
    activeMatch = null;
    replaceSignature = '';
    searchCursor[opt.target] = opt.backwards ? hit.start : hit.start + replacementVisible.length;
    clearMirrorOverlay();
    setStatusMessage(replacementVisible ? '바꾸기 완료: 다음 대상 없음' : '삭제 완료: 다음 대상 없음');
    focusReplaceInput();
  }
  resetResultPanel();
  return true;
}


function replaceOneAcrossAllTabs(opt) {
  const sig = optionsSignature(opt);
  if (replaceSignature && replaceSignature !== sig) activeMatch = null;
  replaceSignature = sig;
  const currentDocId = state.activeDocumentId;
  const currentText = getTargetText(opt.target);
  const currentMatches = getMatches(currentText, opt.pattern, opt);
  let hit = activeMatch?.target === opt.target && activeMatch?.documentId === currentDocId
    ? currentMatches.find(m => matchEquals(m, activeMatch))
    : null;
  if (!hit) {
    const result = nextAcrossAllTabs(opt);
    if (!result) {
      const any = collectAllTabMatches(opt).total;
      if (!any) void alertNoMatches('replace');
      else void alertBoundary(opt);
      return false;
    }
    if (result.doc.id !== state.activeDocumentId) activateDocumentInViews(result.doc.id, '모든 탭 바꾸기 대상 이동');
    setPreviewedReplaceHit(opt.target, result.hit, opt.backwards, result.doc.id);
    showRange(opt.target, result.hit.start, result.hit.end, `바꿀 대상 표시: ${documentTabLabel(result.doc, result.docIndex)}`, 'replace-next');
    focusReplaceInput();
    resetResultPanel();
    return true;
  }

  const replacement = replacementFromMatch(opt.replacement, hit, opt);
  const replacementVisible = replacementVisibleForTarget(opt.target, replacement);
  const nextText = currentText.slice(0, hit.start) + replacementVisible + currentText.slice(hit.end);
  if (opt.target === 'editor') applyEditorReplaceRange(hit, replacement, replacementVisible ? '바꾸기 완료' : '삭제 완료', 'replace-one-editor-raw');
  else setTargetText(opt.target, nextText, replacementVisible ? '바꾸기 완료' : '삭제 완료');

  searchCursor[opt.target] = opt.backwards ? hit.start : hit.start + replacementVisible.length;
  activeMatch = null;
  const next = nextAcrossAllTabs(opt);
  if (next) {
    if (next.doc.id !== state.activeDocumentId) activateDocumentInViews(next.doc.id, '모든 탭 다음 바꾸기 대상 이동');
    setPreviewedReplaceHit(opt.target, next.hit, opt.backwards, next.doc.id);
    showRange(opt.target, next.hit.start, next.hit.end, replacementVisible ? '바꾸기 완료: 다음 대상 표시' : '삭제 완료: 다음 대상 표시', 'replace-next');
    focusReplaceInput();
  } else {
    replaceSignature = '';
    clearMirrorOverlay();
    setStatusMessage(replacementVisible ? '바꾸기 완료: 모든 탭에 다음 대상 없음' : '삭제 완료: 모든 탭에 다음 대상 없음');
    focusReplaceInput();
  }
  resetResultPanel();
  return true;
}

export async function replaceAll() {
  const opt = currentOptions();
  if (!opt) return false;
  if (!opt.pattern) { setStatusMessage('찾을 문자열을 입력하세요'); opt.findText.focus(); return false; }
  rememberSearch(opt.findText.value);
  rememberReplace(opt.replaceText?.value || '');
  if (opt.allTabs) {
    const { groups, total } = collectAllTabMatches(opt);
    if (!total) { await alertNoMatches('replace'); return false; }
    const ok = await showConfirmModal(`${total.toLocaleString('ko-KR')}개 항목을 ${groups.length.toLocaleString('ko-KR')}개 탭에서 모두 바꾸겠습니까?`, { title: '모든 탭 모두 바꾸기' });
    if (!ok) { setStatusMessage('모든 탭 모두 바꾸기 취소'); return false; }
    const originalId = state.activeDocumentId;
    let changedTabs = 0;
    for (const group of groups) {
      const nextRaw = buildReplacementRawForDocument(group.doc, opt, group.matches);
      if (nextRaw === group.doc.documentText) continue;
      if (group.doc.id !== state.activeDocumentId) activateDocumentInViews(group.doc.id, null);
      const label = `모든 탭 모두 바꾸기: ${group.matches.length.toLocaleString('ko-KR')}개`;
      if (applyDocumentTextAction(nextRaw, { source: opt.target, label, snapshot: captureDocumentSnapshot(opt.target), actionType: opt.target === 'editor' ? 'replace-all-editor-raw' : 'replace-all' })) changedTabs += 1;
    }
    if (state.documents.some(doc => doc.id === originalId) && state.activeDocumentId !== originalId) activateDocumentInViews(originalId, null);
    searchCursor[opt.target] = 0;
    activeMatch = null;
    replaceSignature = '';
    clearMirrorOverlay();
    resetResultPanel();
    setStatusMessage(`모든 탭 모두 바꾸기 완료: ${total.toLocaleString('ko-KR')}개 / ${changedTabs.toLocaleString('ko-KR')}개 탭`);
    return true;
  }
  const text = getTargetText(opt.target);
  const matches = getMatches(text, opt.pattern, opt);
  if (!matches.length) { await alertNoMatches('replace'); return false; }
  const ok = await showConfirmModal(`${matches.length.toLocaleString('ko-KR')}개 항목을 모두 바꾸겠습니까?`, { title: '모두 바꾸기' });
  if (!ok) { setStatusMessage('모두 바꾸기 취소'); return false; }
  let out = '';
  let last = 0;
  let firstEnd = matches[0].start;
  for (const m of matches) {
    const replacement = replacementFromMatch(opt.replacement, m, opt);
    const replacementVisible = replacementVisibleForTarget(opt.target, replacement);
    out += text.slice(last, m.start) + replacementVisible;
    if (m === matches[0]) firstEnd = m.start + replacementVisible.length;
    last = m.end;
  }
  out += text.slice(last);
  if (opt.target === 'editor') applyEditorReplaceAll(matches, opt, `모두 바꾸기 완료: ${matches.length.toLocaleString('ko-KR')}개`);
  else setTargetText(opt.target, out, `모두 바꾸기 완료: ${matches.length.toLocaleString('ko-KR')}개`);
  searchCursor[opt.target] = firstEnd;
  activeMatch = null;
  replaceSignature = '';
  clearMirrorOverlay();
  resetResultPanel();
  return true;
}

function setFindReplaceInputValue(input, value) {
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function clearFindReplaceInputs() {
  const c = getFindControls();
  if (!c?.findText) return false;
  setFindReplaceInputValue(c.findText, '');
  if (activeFindTab === 'replace' && c.replaceText) setFindReplaceInputValue(c.replaceText, '');
  c.findText.focus({ preventScroll: true });
  setStatusMessage(activeFindTab === 'replace' ? '찾기/바꾸기 입력란 모두 지우기' : '찾기 입력란 지우기');
  return true;
}

function applyFindReplacePresetSwap() {
  const c = getFindControls();
  if (!c?.findText || !c?.replaceText || activeFindTab !== 'replace') return false;
  const useReverse = c.findText.value === FIND_REPLACE_PRESET_FIND && c.replaceText.value === FIND_REPLACE_PRESET_REPLACE;
  const findValue = useReverse ? FIND_REPLACE_PRESET_REPLACE : FIND_REPLACE_PRESET_FIND;
  const replaceValue = useReverse ? FIND_REPLACE_PRESET_FIND : FIND_REPLACE_PRESET_REPLACE;
  setFindReplaceInputValue(c.findText, findValue);
  setFindReplaceInputValue(c.replaceText, replaceValue);
  c.replaceText.focus({ preventScroll: true });
  c.replaceText.select();
  setStatusMessage(useReverse ? '@Myc → ÿc 입력' : 'ÿc → @Myc 입력');
  return true;
}

function swapFindReplaceStrings() {
  const c = getFindControls();
  if (!c?.findText || !c?.replaceText || activeFindTab !== 'replace') return false;
  const a = c.findText.value;
  const b = c.replaceText.value;
  setFindReplaceInputValue(c.findText, b);
  setFindReplaceInputValue(c.replaceText, a);
  resetCursorForTarget(c.target);
  resetReplaceState();
  resetResultPanel();
  c.replaceText.focus({ preventScroll: true });
  c.replaceText.select();
  setStatusMessage('찾을 문자열과 바꿀 문자열 교환');
  return true;
}

function renderResults(matches = null, activeStart = null, emptyText = null) {
  const opt = currentOptions();
  if (!opt?.results) return;
  opt.results.classList.add('visible');
  const countRow = opt.root.querySelector('.fr-count-row');
  if (countRow) countRow.hidden = false;
  if (matches === null) matches = getMatches(getTargetText(opt.target), opt.pattern, opt);
  if (!opt.pattern) {
    opt.results.innerHTML = '<div class="fr-empty">찾을 문자열을 입력하세요.</div>';
    opt.count.textContent = '0개';
    refreshFindWindowSize();
    return;
  }
  opt.count.textContent = `${matches.length.toLocaleString('ko-KR')}개`;
  if (!matches.length) {
    opt.results.innerHTML = `<div class="fr-empty">${escapeHtml(emptyText || '찾는 문자열 없음')}</div>`;
    refreshFindWindowSize();
    return;
  }
  const text = getTargetText(opt.target);
  opt.results.innerHTML = `<div class="fr-result-summary">총 ${matches.length.toLocaleString('ko-KR')}개</div>`;
  const list = document.createElement('div');
  list.className = 'fr-result-list';
  matches.slice(0, 500).forEach((m, index) => {
    const lc = opt.target === 'code' ? codeLineColFromOffset(text, m.start) : lineColFromOffset(text, m.start);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fr-result-item' + (m.start === activeStart ? ' selected' : '');
    btn.innerHTML = `<span class="fr-result-pos">${index + 1}. ${escapeHtml(resultLineColumnLabel(lc.line, lc.col))}</span><span class="fr-result-text">${escapeHtml(snippetAround(text, m.start, m.end))}</span>`;
    btn.addEventListener('click', () => {
      searchCursor[opt.target] = opt.backwards ? m.start : m.end;
      activeMatch = { target: opt.target, start: m.start, end: m.end };
      showRange(opt.target, m.start, m.end, lineColumnMoveLabel(lc.line, lc.col), 'find-current');
      renderResults(matches, m.start);
    });
    list.appendChild(btn);
  });
  if (matches.length > 500) {
    const more = document.createElement('div');
    more.className = 'fr-more';
    more.textContent = `표시는 500개까지만 합니다. 나머지 ${matches.length - 500}개는 생략.`;
    list.appendChild(more);
  }
  opt.results.appendChild(list);
  refreshFindWindowSize();
}

export async function findAll() {
  const opt = currentOptions();
  if (!opt) return false;
  if (!opt.pattern) { setStatusMessage('찾을 문자열을 입력하세요'); opt.findText.focus(); return false; }
  rememberSearch(opt.findText.value);
  if (opt.allTabs) {
    const { groups, total } = collectAllTabMatches(opt);
    renderAllTabResults(opt, groups, total);
    if (!total) { await alertNoMatches(activeFindTab); return false; }
    setStatusMessage(`모든 탭 모두 찾기: ${total.toLocaleString('ko-KR')}개 / ${groups.length.toLocaleString('ko-KR')}개 탭`);
    return true;
  }
  const matches = getMatches(getTargetText(opt.target), opt.pattern, opt);
  renderResults(matches);
  if (!matches.length) { await alertNoMatches(activeFindTab); return false; }
  setStatusMessage(`모두 찾기: ${matches.length.toLocaleString('ko-KR')}개`);
  return true;
}

function updateDirectionButton() {
  const c = getFindControls();
  if (!c?.findNextButton) return;
  c.findNextButton.textContent = c.backwards ? '이전 찾기' : '다음 찾기';
}

function setActiveFindTab(tab) {
  activeFindTab = tab === 'replace' ? 'replace' : tab === 'color' ? 'color' : 'find';
  if (!findWindow) return;
  const root = findWindow.querySelector('.find-replace-window');
  const colorTab = activeFindTab === 'color';
  root.classList.toggle('color-tab-active', colorTab);
  findWindow?.classList?.toggle('color-tab-active-window', colorTab);
  root.querySelectorAll('.fr-tab').forEach(btn => btn.classList.toggle('selected', btn.dataset.tab === activeFindTab));
  root.querySelectorAll('[data-text-only]').forEach(el => { el.hidden = colorTab; });
  root.querySelectorAll('[data-color-only]').forEach(el => { el.hidden = !colorTab; });
  root.querySelectorAll('[data-replace-only]').forEach(el => { el.hidden = activeFindTab !== 'replace'; });
  const swap = root.querySelector('#frSwapStrings');
  if (swap) swap.disabled = activeFindTab !== 'replace';
  const presetSwap = root.querySelector('#frPresetSwap');
  if (presetSwap) presetSwap.disabled = activeFindTab !== 'replace';
  const clearInputs = root.querySelector('#frClearInputs');
  if (clearInputs) {
    clearInputs.textContent = activeFindTab === 'replace' ? '모두 지우기' : '입력란 지우기';
    clearInputs.title = activeFindTab === 'replace' ? '찾을 문자열과 바꿀 문자열 입력란을 모두 지웁니다.' : '찾을 문자열 입력란을 지웁니다.';
  }
  resetResultPanel();
  if (colorTab) {
    updateColorConvertUi();
    root.querySelector('#frColorFrom')?.focus({ preventScroll: true });
    return;
  }
  root.querySelector('#frFindText')?.focus({ preventScroll: true });
  root.querySelector('#frFindText')?.select();
}

function historyValues(current = '') {
  const out = [];
  const now = String(current || '').trim();
  if (now) out.push(now);
  for (const item of getSearchHistory()) {
    if (item && !out.includes(item)) out.push(item);
  }
  return out.slice(0, historyLimit());
}

function applyHistoryValue(input, value, popup = null) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (popup) popup.hidden = true;
  else closeHistoryPopups();
  input.focus({ preventScroll: true });
  input.select();
}

function historyPopupItems(popup) {
  return Array.from(popup?.querySelectorAll('.fr-history-item') || []);
}

function setHistoryActive(popup, index) {
  const items = historyPopupItems(popup);
  if (!items.length) return;
  const safe = Math.max(0, Math.min(index, items.length - 1));
  items.forEach((item, i) => item.classList.toggle('active', i === safe));
  items[safe].scrollIntoView({ block: 'nearest' });
}

function activeHistoryIndex(popup) {
  const items = historyPopupItems(popup);
  const idx = items.findIndex(item => item.classList.contains('active'));
  return idx >= 0 ? idx : -1;
}

function fillHistoryPopup(wrapper, input, values, emptyText) {
  const popup = wrapper.querySelector('.fr-history-popup');
  popup.innerHTML = '';
  if (!values.length) {
    popup.innerHTML = `<div class="fr-history-empty">${escapeHtml(emptyText)}</div>`;
  } else {
    values.forEach((value) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fr-history-item';
      btn.textContent = value;
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => applyHistoryValue(input, value, popup));
      popup.appendChild(btn);
    });
  }
  return popup;
}

function showHistoryPopup(wrapper, input, options = {}) {
  const popup = wrapper.querySelector('.fr-history-popup');
  if (popup && !popup.hidden && !options.force) { popup.hidden = true; return; }
  closeHistoryPopups();
  const values = historyValues(input.value);
  fillHistoryPopup(wrapper, input, values, '최근 검색어 없음');
  popup.hidden = false;
  if (values.length) setHistoryActive(popup, options.selectIndex === 'last' ? values.length - 1 : 0);
}

function handleHistoryInputKeydown(wrapper, input, event) {
  const popup = wrapper.querySelector('.fr-history-popup');
  const items = () => historyPopupItems(popup);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    if (!popup || popup.hidden || !items().length) {
      showHistoryPopup(wrapper, input, { force: true, selectIndex: event.key === 'ArrowUp' ? 'last' : 0 });
      return;
    }
    const current = activeHistoryIndex(popup);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = (current + delta + items().length) % items().length;
    setHistoryActive(popup, next);
    return;
  }
  if (event.key === 'Enter' && popup && !popup.hidden && items().length) {
    const idx = activeHistoryIndex(popup);
    if (idx >= 0) {
      event.preventDefault();
      event.stopPropagation();
      applyHistoryValue(input, items()[idx].textContent || '', popup);
    }
  }
  if (event.key === 'Escape' && popup && !popup.hidden) {
    event.preventDefault();
    event.stopPropagation();
    popup.hidden = true;
  }
}

function closeHistoryPopups() {
  findWindow?.querySelectorAll('.fr-history-popup').forEach(p => { p.hidden = true; });
}


function historyLimit() { return Math.max(0, Math.min(10, Number(getPreferences().searchHistoryLimit ?? 10))); }

function showLineHistoryPopup(wrapper, input) {
  const popup = wrapper.querySelector('.fr-history-popup');
  if (popup && !popup.hidden) { popup.hidden = true; return; }
  const out = [];
  const now = String(input.value || '').trim();
  if (now) out.push(now);
  for (const item of getLineHistory()) if (item && !out.includes(item)) out.push(item);
  const values = out.slice(0, historyLimit());
  fillHistoryPopup(wrapper, input, values, '최근 행 번호 없음');
  popup.hidden = false;
  if (values.length) setHistoryActive(popup, 0);
}

function createLineComboInput(id, value) {
  return `<span class="fr-combo goto-line-combo" data-history-combo="line"><input id="${id}" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" value="${escapeHtml(value)}" placeholder="행 번호"><div class="fr-history-popup" hidden></div></span>`;
}

function createComboInput(id, value) {
  return `<span class="fr-combo" data-history-combo="search"><input id="${id}" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(value)}"><div class="fr-history-popup" hidden></div></span>`;
}

function showFindTooltip(anchor, text) {
  hideWildcardTooltip();
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'fr-tooltip';
  tooltipEl.textContent = text;
  document.body.appendChild(tooltipEl);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - tooltipEl.offsetWidth - 8);
  if (top + tooltipEl.offsetHeight > window.innerHeight - 8) { hideWildcardTooltip(); return; }
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function showWildcardTooltip(anchor) {
  showFindTooltip(anchor, '찾기 문자열에서 ? 한 글자만 임의 문자로 검색하는 옵션입니다.');
}

function showColorSwapTooltip(anchor) {
  showFindTooltip(anchor, '찾을 색상과 바꿀 색상을 서로 교체해 변환합니다.');
}

function hideWildcardTooltip() { if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; } }


function colorByCode(code) {
  return getColorByCode(code, getPreferences()) || null;
}

function colorSelectOptions(placeholder, selected = '') {
  const options = [`<option value="">${escapeHtml(placeholder)}</option>`];
  for (const item of getActiveColorPalette(getPreferences())) {
    const sel = item.code === selected ? ' selected' : '';
    options.push(`<option value="${escapeHtml(item.code)}"${sel}>${escapeHtml(item.name)} [${escapeHtml(item.code)}]</option>`);
  }
  return options.join('');
}

function updateColorPreview(swatch, code) {
  const item = colorByCode(code);
  if (!swatch) return;
  swatch.hidden = !item;
  swatch.title = item ? `${item.name} ${item.code} ${item.hex}` : '';
  swatch.style.backgroundColor = item?.hex || 'transparent';
}

function updateColorConvertUi() {
  const c = getFindControls();
  if (!c?.colorFrom || !c?.colorTo) return;
  lastColorConvertFrom = c.colorFrom.value || '';
  lastColorConvertTo = c.colorTo.value || '';
  updateColorPreview(c.colorFromSwatch, c.colorFrom.value);
  updateColorPreview(c.colorToSwatch, c.colorTo.value);
  const same = !!c.colorFrom.value && c.colorFrom.value === c.colorTo.value;
  if (c.colorWarning) {
    c.colorWarning.hidden = !same;
    c.colorWarning.textContent = same ? '같은 색상이 선택되어 변환 결과가 없습니다. 다른 색상을 선택하세요.' : '';
  }
}

function swapColorDropdownSelections() {
  const c = getFindControls();
  if (!c?.colorFrom || !c?.colorTo) return;
  const from = c.colorFrom.value || '';
  c.colorFrom.value = c.colorTo.value || '';
  c.colorTo.value = from;
  updateColorConvertUi();
  c.colorFrom.focus({ preventScroll: true });
}

function resetColorDropdownSelections() {
  const c = getFindControls();
  if (!c?.colorFrom || !c?.colorTo) return;
  c.colorFrom.value = DEFAULT_COLOR_CONVERT_FROM;
  c.colorTo.value = DEFAULT_COLOR_CONVERT_TO;
  if (c.colorSwap) c.colorSwap.checked = false;
  updateColorConvertUi();
  c.colorFrom.focus({ preventScroll: true });
}

function replaceDocumentColorCodes(text, fromCode, toCode, swap = false) {
  const source = String(text ?? '');
  let out = '';
  let changed = 0;
  for (let i = 0; i < source.length;) {
    if (source.startsWith('ÿc', i) && i + 2 < source.length) {
      const code = source.slice(i, i + 3);
      let next = code;
      if (swap) {
        if (code === fromCode) next = toCode;
        else if (code === toCode) next = fromCode;
      } else if (code === fromCode) {
        next = toCode;
      }
      if (next !== code) changed += 1;
      out += next;
      i += 3;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return { text: out, changed };
}

async function convertColors() {
  const c = getFindControls();
  if (!c?.colorFrom || !c?.colorTo) return false;
  const fromCode = c.colorFrom.value || '';
  const toCode = c.colorTo.value || '';
  const swap = !!c.colorSwap?.checked;
  if (!fromCode) { setStatusMessage('찾을 색상을 선택하세요'); c.colorFrom.focus({ preventScroll: true }); return false; }
  if (!toCode) { setStatusMessage('바꿀 색상을 선택하세요'); c.colorTo.focus({ preventScroll: true }); return false; }
  updateColorConvertUi();
  if (fromCode === toCode) {
    setStatusMessage('같은 색상이 선택되어 색상변환을 실행하지 않았습니다');
    c.colorTo.focus({ preventScroll: true });
    return false;
  }
  const ok = await showConfirmModal(swap ? '색상을 서로 바꾸시겠습니까?' : '색상을 바꾸시겠습니까?', { title: '색상변환' });
  if (!ok) { setStatusMessage('색상변환 취소'); return false; }
  const result = replaceDocumentColorCodes(state.rawCode, fromCode, toCode, swap);
  if (!result.changed || result.text === state.rawCode) {
    await showAlertModal('변경된 색상이 없습니다.', { title: '색상변환' });
    return false;
  }
  const source = state.activeView === 'code' ? 'code' : 'editor';
  const label = swap ? '색상 서로 바꾸기' : '색상변환';
  const applied = applyDocumentTextAction(result.text, { source, label, snapshot: captureDocumentSnapshot(source), actionType: swap ? 'color-swap' : 'color-convert' });
  if (!applied) return false;
  await showAlertModal(swap ? '색상이 서로 바뀌었습니다' : '색상이 적용되었습니다', { title: '색상변환' });
  return true;
}

function createFindReplaceBody(initialTab) {
  const body = document.createElement('div');
  body.className = 'find-replace-window';
  const target = initialFindTargetOverride || (state.activeView === 'code' ? 'code' : 'editor');
  body.innerHTML = `
    <div class="fr-tabs" role="tablist">
      <button type="button" class="fr-tab selected" data-tab="find">찾기 (Ctrl+F)</button>
      <button type="button" class="fr-tab" data-tab="replace">바꾸기 (Ctrl+H)</button>
      <button type="button" class="fr-tab" data-tab="color">색상변환 (Ctrl+K)</button>
    </div>
    <div class="fr-form">
      <div class="fr-field" data-text-only><label class="fr-field-label" for="frFindText">찾을 문자열</label><div class="fr-input-clear-row">${createComboInput('frFindText', lastFindValue)}<button id="frClearInputs" class="fr-input-clear-button" type="button" title="찾을 문자열 입력란을 지웁니다.">입력란 지우기</button></div></div>
      <div class="fr-field" data-text-only data-replace-only><label class="fr-field-label" for="frReplaceText">바꿀 문자열</label>${createComboInput('frReplaceText', lastReplaceValue)}</div>
      <div class="fr-count-row" data-text-only hidden><span class="fr-count">일치: <strong id="frCount"></strong></span></div>
      <div class="fr-options" data-text-only>
        <div class="fr-options-row">
          <label><input name="frTarget" type="radio" value="editor" ${target === 'editor' ? 'checked' : ''}> 편집창 기준</label>
          <label><input name="frTarget" type="radio" value="code" ${target === 'code' ? 'checked' : ''}> 코드창 기준</label>
          <label><input id="frAllTabs" type="checkbox"> 모든 탭 전체</label>
          <label><input id="frBackwards" type="checkbox"> 이전 방향</label>
          <label><input id="frWrap" type="checkbox" checked> 되돌아찾기</label>
        </div>
        <div class="fr-options-row">
          <label class="fr-wildcard-label"><input id="frWildcard" type="checkbox"> <span class="fr-help-link" tabindex="0">와일드카드 ?</span></label>
          <label><input id="frCase" type="checkbox"> 대소문자 구분</label>
        </div>
      </div>
      <div class="fr-actions" data-text-only>
        <button id="frFindNext" type="button">다음 찾기</button>
        <button id="frFindAll" type="button">모두 찾기</button>
        <button id="frReplaceOne" type="button" data-replace-only>바꾸기</button>
        <button id="frReplaceAll" type="button" data-replace-only>모두 바꾸기</button>
        <button id="frSwapStrings" class="fr-swap-button" type="button" disabled title="찾을 문자열과 바꿀 문자열을 서로 교환합니다.">바꿀 문자열 교환</button>
        <button id="frPresetSwap" class="fr-swap-button" type="button" data-replace-only disabled title="찾을 문자열과 바꿀 문자열에 ÿc와 @Myc를 입력하고, 다시 누르면 서로 교환합니다.">ÿc ↔ @Myc</button>
      </div>
      <p class="fr-note" data-text-only>편집창 기준에서는 입력값의 줄바꿈(<code>\\n</code>), 유니코드 글리프(<code>\\uXXXX</code>), 색상코드기호(<code>ÿ</code>)를 실제 줄바꿈/글리프로 해석합니다.<br>코드창 기준에서는 문자 그대로 찾습니다.<br><span class="fr-shortcut-line"><span class="fr-key">Enter</span>는 다음 찾기, <span class="fr-key">Ctrl+Enter</span>는 모두 찾기, <span class="fr-key fr-key-danger">Alt+Enter</span>는 바꾸기, 모두 바꾸기 단축키는 없습니다.</span></p>
      <div id="frResults" class="fr-results" data-text-only><div class="fr-empty">모두 찾기를 누르면 결과가 여기에 표시됩니다.</div></div>
      <div class="fr-color-panel" data-color-only hidden>
        <div class="fr-color-inline-row">
          <div class="fr-color-unit fr-color-unit-from">
            <span class="fr-color-label">찾을 색상</span>
            <span id="frColorFromSwatch" class="fr-color-swatch" hidden></span>
            <select id="frColorFrom" class="fr-color-select">${colorSelectOptions('찾을 색상을 선택하세요', lastColorConvertFrom)}</select>
          </div>
          <div class="fr-color-unit fr-color-unit-swap">
            <button id="frColorSwapSelections" class="fr-color-swap-values" type="button" title="찾을 색상과 바꿀 색상 선택값을 서로 교환합니다." aria-label="찾을 색상과 바꿀 색상 선택값 교환">↔</button>
          </div>
          <div class="fr-color-unit fr-color-unit-to">
            <span class="fr-color-label">바꿀 색상</span>
            <span id="frColorToSwatch" class="fr-color-swatch" hidden></span>
            <select id="frColorTo" class="fr-color-select">${colorSelectOptions('바꿀 색상을 선택하세요', lastColorConvertTo)}</select>
          </div>
        </div>
        <p id="frColorWarning" class="fr-color-warning" hidden></p>
        <div class="fr-actions fr-color-actions">
          <div class="fr-color-action-buttons">
            <button id="frColorConvert" type="button">색상변환</button>
            <button id="frColorDefaults" type="button">기본값</button>
            <button id="frColorClose" type="button">닫기</button>
          </div>
          <label class="fr-color-swap-check"><input id="frColorSwap" type="checkbox"> <span class="fr-color-swap-help fr-help-link" tabindex="0">서로 바꾸기</span></label>
        </div>
      </div>
    </div>
  `;
  return body;
}


export function openFindReplaceDialog(tab = 'find') {
  const prefill = getFindPrefillFromDocumentSelection();
  if (findWindow) {
    focusFloatingWindow(findWindow);
    applyFindPrefill(prefill);
    setActiveFindTab(tab);
    return;
  }
  if (hasFloatingWindow()) { pokeActiveFloatingWindow(); return; }
  applyFindPrefill(prefill);
  const body = createFindReplaceBody(tab);
  initialFindTargetOverride = null;
  findWindow = createFloatingWindow({
    title: '찾기/바꾸기',
    width: 760,
    height: null,
    content: body,
    opacityControl: false,
    onClose: () => { findWindow = null; hideWildcardTooltip(); clearMirrorOverlay(); resetReplaceState(); },
  });
  if (!findWindow) return;
  findWindow.classList.add('find-replace-floating-window');
  attachFloatingOpacityControl(findWindow, { label: '찾기/바꾸기 창 투명도' });

  const c = getFindControls();
  initInputHistory(c.findText);
  initInputHistory(c.replaceText);
  const update = () => {
    lastFindValue = c.findText.value;
    lastReplaceValue = c.replaceText?.value || '';
    clearMirrorOverlay();
    resetCursorForTarget(c.target);
    resetResultPanel();
  };
  c.root.querySelectorAll('.fr-tab').forEach(btn => btn.addEventListener('click', () => setActiveFindTab(btn.dataset.tab)));
  c.findText.addEventListener('input', update);
  c.replaceText.addEventListener('input', update);
  c.root.querySelectorAll('[data-text-only] input[type="checkbox"], [data-text-only] input[type="radio"]').forEach(el => el.addEventListener('change', () => { clearMirrorOverlay(); resetCursorForTarget(getFindControls()?.target || 'editor'); updateDirectionButton(); resetResultPanel(); }));
  c.root.querySelectorAll('.fr-combo').forEach(wrapper => {
    const input = wrapper.querySelector('input');
    input.addEventListener('mousedown', event => {
      const nearArrow = input.clientWidth - event.offsetX <= 34;
      const popup = wrapper.querySelector('.fr-history-popup');
      if (nearArrow) { event.preventDefault(); showHistoryPopup(wrapper, input); return; }
      if (popup && !popup.hidden) popup.hidden = true;
    });
    input.addEventListener('keydown', event => handleHistoryInputKeydown(wrapper, input, event), true);
  });
  c.root.addEventListener('mousedown', e => { if (!e.target.closest('.fr-combo')) closeHistoryPopups(); }, true);
  attachOverlayInvalidationListeners();
  const wildcardHelp = c.root.querySelector('.fr-wildcard-label .fr-help-link');
  wildcardHelp?.addEventListener('mouseenter', e => showWildcardTooltip(e.currentTarget));
  wildcardHelp?.addEventListener('focus', e => showWildcardTooltip(e.currentTarget));
  wildcardHelp?.addEventListener('mouseleave', hideWildcardTooltip);
  wildcardHelp?.addEventListener('blur', hideWildcardTooltip);
  wildcardHelp?.addEventListener('mousedown', hideWildcardTooltip);
  wildcardHelp?.addEventListener('click', hideWildcardTooltip);
  const colorSwapHelp = c.root.querySelector('.fr-color-swap-help');
  colorSwapHelp?.addEventListener('mouseenter', e => showColorSwapTooltip(e.currentTarget));
  colorSwapHelp?.addEventListener('focus', e => showColorSwapTooltip(e.currentTarget));
  colorSwapHelp?.addEventListener('mouseleave', hideWildcardTooltip);
  colorSwapHelp?.addEventListener('blur', hideWildcardTooltip);
  colorSwapHelp?.addEventListener('mousedown', hideWildcardTooltip);
  colorSwapHelp?.addEventListener('click', hideWildcardTooltip);
    c.root.querySelector('#frFindNext').addEventListener('click', () => { void findNext(); });
  c.root.querySelector('#frFindAll').addEventListener('click', () => { void findAll(); });
  c.root.querySelector('#frReplaceOne').addEventListener('click', replaceOne);
  c.root.querySelector('#frReplaceAll').addEventListener('click', () => { void replaceAll(); });
  c.root.querySelector('#frSwapStrings').addEventListener('click', swapFindReplaceStrings);
  c.clearInputsButton?.addEventListener('click', clearFindReplaceInputs);
  c.presetSwapButton?.addEventListener('click', applyFindReplacePresetSwap);
  c.colorFrom?.addEventListener('change', updateColorConvertUi);
  c.colorTo?.addEventListener('change', updateColorConvertUi);
  c.colorSwap?.addEventListener('change', updateColorConvertUi);
  c.colorSwapSelections?.addEventListener('click', swapColorDropdownSelections);
  c.root.querySelector('#frColorDefaults')?.addEventListener('click', resetColorDropdownSelections);
  c.root.querySelector('#frColorConvert')?.addEventListener('click', () => { void convertColors(); });
  c.root.querySelector('#frColorClose')?.addEventListener('click', () => { closeFloatingWindow(findWindow); });
  updateColorConvertUi();
  function handleFindWindowKeydown(event) {
    if (event.__findReplaceHandled) return;
    const key = String(event.key || '').toLowerCase();
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && key === 'f') { event.__findReplaceHandled = true; event.preventDefault(); event.stopPropagation(); setActiveFindTab('find'); return; }
    if (ctrl && key === 'h') { event.__findReplaceHandled = true; event.preventDefault(); event.stopPropagation(); setActiveFindTab('replace'); return; }
    if (ctrl && key === 'k') { event.__findReplaceHandled = true; event.preventDefault(); event.stopPropagation(); setActiveFindTab('color'); return; }
    if (ctrl && key === 'z') { event.__findReplaceHandled = true; event.preventDefault(); event.stopPropagation(); handleFindReplaceEditCommand(event.shiftKey ? 'redo' : 'undo'); return; }
    if (ctrl && key === 'y') { event.__findReplaceHandled = true; event.preventDefault(); event.stopPropagation(); handleFindReplaceEditCommand('redo'); return; }
    if (event.key === 'Enter' && event.altKey) {
      event.__findReplaceHandled = true;
      event.preventDefault();
      event.stopPropagation();
      if (activeFindTab !== 'replace') { setActiveFindTab('replace'); return; }
      replaceOne();
      return;
    }
    if (event.key === 'Enter' && event.target?.tagName === 'INPUT') {
      event.__findReplaceHandled = true;
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) void findAll();
      else void findNext();
      return;
    }
    if (event.key === 'F3') { event.__findReplaceHandled = true; event.preventDefault(); event.stopPropagation(); setStatusMessage('F3 브라우저 찾기 동작 차단'); return; }
  }
  c.root.addEventListener('keydown', handleFindWindowKeydown);
  findWindow.addEventListener('keydown', handleFindWindowKeydown);
  setActiveFindTab(tab);
  resetCursorForTarget(c.target);
  setCountIdle();
}

export function findDialog() { openFindReplaceDialog('find'); }
export function replaceDialog() { openFindReplaceDialog('replace'); }
export function colorConvertDialog() { openFindReplaceDialog('color'); }

export function gotoLineDialog() {
  if (!gotoWindow && hasFloatingWindow()) { pokeActiveFloatingWindow(); return; }
  if (gotoWindow) {
    focusFloatingWindow(gotoWindow);
    gotoWindow.querySelector('#lineNumberInput')?.focus({ preventScroll: true });
    return;
  }
  const body = document.createElement('div');
  body.className = 'goto-line-window-body';
  body.innerHTML = `
    <div class="form-row"><span>행 번호</span>${createLineComboInput('lineNumberInput', lastLineInput)}</div>
    <div class="radio-row" role="radiogroup" aria-label="이동 위치">
      <label><input name="lineTarget" type="radio" value="end" checked> 행의 끝</label>
      <label><input name="lineTarget" type="radio" value="start"> 행의 시작</label>
    </div>
    <div class="floating-footer"><button id="gotoOk" type="button">확인</button><button id="gotoCancel" type="button">취소</button></div>
  `;
  gotoWindow = createFloatingWindow({
    title: '행 번호 찾아가기',
    width: 400,
    height: null,
    content: body,
    onClose: () => { gotoWindow = null; },
  });
  if (!gotoWindow) return;
  gotoWindow.classList.add('goto-floating-window');
  const input = body.querySelector('#lineNumberInput');
  const ok = body.querySelector('#gotoOk');
  attachDigitInput(input, { maxLength: 6, allowEmpty: true });
  const lineWrapper = body.querySelector('.goto-line-combo');
  input.addEventListener('mousedown', event => {
    const popup = lineWrapper?.querySelector('.fr-history-popup');
    const nearArrow = input.clientWidth - event.offsetX <= 34;
    if (nearArrow) { event.preventDefault(); showLineHistoryPopup(lineWrapper, input); return; }
    if (popup && !popup.hidden) popup.hidden = true;
  });
  if (lineWrapper) input.addEventListener('keydown', event => handleHistoryInputKeydown(lineWrapper, input, event), true);
  body.addEventListener('mousedown', e => { if (!e.target.closest('.goto-line-combo')) lineWrapper?.querySelector('.fr-history-popup')?.setAttribute('hidden', ''); }, true);
  const cancel = body.querySelector('#gotoCancel');
  const apply = async () => {
    const raw = sanitizeDigits(input.value);
    if (!raw) { setStatusMessage('행 번호 입력 필요'); input.focus(); input.select(); return; }
    lastLineInput = raw;
    addLineHistory(raw);
    const line = Number.parseInt(raw, 10) || 0;
    const target = body.querySelector('input[name="lineTarget"]:checked')?.value || 'end';
    if (await gotoLine(line, target === 'start', input)) {
      const win = gotoWindow;
      gotoWindow = null;
      closeFloatingWindow(win);
    }
  };
  ok.addEventListener('click', apply);
  cancel.addEventListener('click', () => { closeFloatingWindow(gotoWindow); gotoWindow = null; setStatusMessage('행 이동 창 닫힘'); });
  body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void apply(); }
    if (event.key === 'Escape') { event.preventDefault(); closeFloatingWindow(gotoWindow); gotoWindow = null; }
  });
  input.focus();
  input.select();
}

async function gotoLine(lineNumber, toStart, input) {
  const editor = getEditorTextArea();
  const maxLine = countEditorLines(editor.value);
  if (lineNumber < 1) {
    await showAlertModal('행 번호는 1 이상의 숫자여야 합니다.', { title: '행 번호 오류' });
    input?.focus({ preventScroll: true });
    input?.select();
    return false;
  }
  if (lineNumber > maxLine) {
    await showAlertModal(`전체 행수(${maxLine}행)보다 큰 행 번호는 입력할 수 없습니다.`, { title: '행 번호 오류' });
    input?.focus({ preventScroll: true });
    input?.select();
    return false;
  }
  const line = lineNumber;
  const pos = toStart ? lineStartOffset(editor.value, line) : lineEndOffset(editor.value, line);
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(pos, pos);
  scrollEditorToLine(line, 0.5);
  setStatusMessage(`${line}행 ${toStart ? '시작' : '끝'}으로 이동`);
  return true;
}
