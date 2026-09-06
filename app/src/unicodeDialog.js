import { createFloatingWindow, focusFloatingWindow, closeFloatingWindow, hasFloatingWindow, pokeActiveFloatingWindow } from './floatingWindow.js';
import { showConfirmModal, showAlertModal } from './modal.js';
import { setStatusMessage, setErrorMessage } from './statusBar.js';
import { getGlyphSettings, saveGlyphSettings, resetGlyphSettings, normalizeGlyphCode, codeToChar, unicodeAddress } from './unicodeStore.js';
import { insertUnicodeGlyph } from './editMenu.js';
import { openFileDialog, saveFileDialog } from './fileApi.js';
import { getPreferences } from './preferences.js';
import { hasActiveBlockingModal } from './blockingModalManager.js';
import { getActiveDocumentRendering } from './state.js';
import {
  BUILTIN_FONT_CSS_FAMILY,
  BUILTIN_FALLBACK_FONT_SOURCE,
  FALLBACK_FONT_CSS_FAMILY,
  buildFontEntries,
  findFontEntryForRendering,
  fontCssFamilyForUse,
  getFontDisplayName,
} from './fontService.js';
import { loadFontCmapCodes } from './fontCmap.js';

let unicodeWindow = null;
let grid = null;
let gridItems = null;
let gridSpacer = null;
let previewGlyphDefault = null;
let previewGlyphOutput = null;
let previewCode = null;
let fontNameEl = null;
let glyphStatusEl = null;
let contextMenu = null;
let resizeObserver = null;
let renderFrame = 0;
let loadSequence = 0;
let instantTooltipEl = null;
let unicodeRoot = null;

const FAVORITES_MAGIC = '# TTEDIT_UNICODE_FAVORITES v1';
const LEGACY_LIST_MAGIC = '# TTEDIT_UNICODE_LIST v1';
const CELL_HEIGHT = 78;
const ROW_GAP = 8;
const ROW_HEIGHT = CELL_HEIGHT + ROW_GAP;
const GRID_PADDING = 8;
const MIN_CELL_WIDTH = 74;
const COLUMN_GAP = 8;
const VIRTUAL_OVERSCAN_ROWS = 4;

const state = {
  favoriteCodes: [],
  defaultCode: '2060',
  selectedCode: '2060',
  supportedCodes: [],
  supportedSet: new Set(),
  vanillaSupportedSet: new Set(),
  displayCodes: [],
  outputFontEntry: null,
  outputFontFamily: BUILTIN_FONT_CSS_FAMILY,
  loading: false,
  editMode: false,
  selectedCodes: new Set(),
  selectionAnchorCode: null,
};

function numericCode(code) { return parseInt(String(code || '0'), 16); }
function sortCodes(codes = []) {
  return [...new Set((codes || []).map(normalizeGlyphCode).filter(Boolean))]
    .sort((a, b) => numericCode(a) - numericCode(b));
}
function favoriteSet() { return new Set(state.favoriteCodes); }

function rebuildDisplayCodes() {
  const seen = new Set();
  const out = [];
  for (const code of sortCodes(state.favoriteCodes)) {
    if (!seen.has(code)) { seen.add(code); out.push(code); }
  }
  const defaultCode = normalizeGlyphCode(state.defaultCode);
  if (defaultCode && !seen.has(defaultCode)) { seen.add(defaultCode); out.push(defaultCode); }
  for (const code of state.supportedCodes) {
    const clean = normalizeGlyphCode(code);
    if (clean && !seen.has(clean)) { seen.add(clean); out.push(clean); }
  }
  state.displayCodes = out;
  if (!state.displayCodes.includes(state.selectedCode)) {
    state.selectedCode = state.displayCodes.includes(state.defaultCode)
      ? state.defaultCode
      : state.displayCodes[0] || state.defaultCode;
  }
}

function loadState() {
  const settings = getGlyphSettings();
  state.favoriteCodes = sortCodes(settings.favoriteCodes || settings.codes || []);
  state.defaultCode = normalizeGlyphCode(settings.defaultCode) || '2060';
  state.selectedCode = state.defaultCode;
  state.supportedCodes = [];
  state.supportedSet = new Set();
  state.vanillaSupportedSet = new Set();
  state.displayCodes = [];
  state.editMode = false;
  state.selectedCodes = new Set();
  state.selectionAnchorCode = null;
  rebuildDisplayCodes();
}

function saveState() {
  const saved = saveGlyphSettings({ favoriteCodes: state.favoriteCodes, defaultCode: state.defaultCode });
  state.favoriteCodes = sortCodes(saved.favoriteCodes || []);
  state.defaultCode = normalizeGlyphCode(saved.defaultCode) || '2060';
  rebuildDisplayCodes();
}

function parseFavoriteLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('#')) return { skip: true };
  const match = text.match(/^(?:U\+|\\u|0x)?([0-9a-fA-F]{1,6})$/i);
  if (!match) return { error: true };
  const code = normalizeGlyphCode(match[1]);
  return code ? { code } : { error: true };
}

function exportFavoritesText() {
  return [
    FAVORITES_MAGIC,
    '# 즐겨찾기 유니코드 주소만 저장합니다.',
    '# U+E031, E031, \\uE031 형식을 사용할 수 있습니다.',
    ...sortCodes(state.favoriteCodes).map(unicodeAddress),
    '',
  ].join('\n');
}

function importFavoritesText(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const magic = String(lines[0] || '').trim();
  if (magic !== FAVORITES_MAGIC && magic !== LEGACY_LIST_MAGIC) return { badFormat: true };
  const codes = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const parsed = parseFavoriteLine(lines[i]);
    if (parsed.error) errors.push(i + 1);
    if (parsed.code) codes.push(parsed.code);
  }
  return { codes: sortCodes(codes), errors, legacy: magic === LEGACY_LIST_MAGIC };
}

function outputFontCss() {
  return state.outputFontFamily || BUILTIN_FONT_CSS_FAMILY;
}

function updatePreview() {
  if (!previewGlyphDefault || !previewGlyphOutput || !previewCode) return;
  const ch = codeToChar(state.selectedCode);
  previewGlyphDefault.textContent = state.vanillaSupportedSet.has(state.selectedCode) ? ch : '';
  previewGlyphOutput.textContent = state.supportedSet.has(state.selectedCode) ? ch : '';
  previewCode.textContent = unicodeAddress(state.selectedCode);
  previewGlyphDefault.style.fontFamily = `"${BUILTIN_FONT_CSS_FAMILY}", "${FALLBACK_FONT_CSS_FAMILY}"`;
  previewGlyphOutput.style.fontFamily = `"${outputFontCss()}", "Malgun Gothic", sans-serif`;
}

function editSelectionCodes() {
  return state.displayCodes.filter(code => state.selectedCodes.has(code));
}

function favoriteSelectionCodes() {
  const favorites = favoriteSet();
  return editSelectionCodes().filter(code => favorites.has(code));
}

function nonFavoriteSelectionCodes() {
  const favorites = favoriteSet();
  return editSelectionCodes().filter(code => !favorites.has(code));
}

function syncVisibleSelectionClasses() {
  gridItems?.querySelectorAll('.glyph-cell').forEach(cell => {
    const code = cell.dataset.code;
    const selected = state.editMode ? state.selectedCodes.has(code) : code === state.selectedCode;
    cell.classList.toggle('selected', selected);
    cell.classList.toggle('edit-selected', state.editMode && selected);
    cell.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function pruneEditSelection() {
  const available = new Set(state.displayCodes);
  state.selectedCodes = new Set([...state.selectedCodes].filter(code => available.has(code)));
  if (state.selectionAnchorCode && !available.has(state.selectionAnchorCode)) state.selectionAnchorCode = null;
}

function updateActionState() {
  if (!unicodeWindow) return;
  const defaultBtn = unicodeWindow.querySelector('[data-unicode-action="setDefault"]');
  const inputBtn = unicodeWindow.querySelector('[data-unicode-action="input"]');
  const editBtn = unicodeWindow.querySelector('[data-unicode-action="editMode"]');
  const addBtn = unicodeWindow.querySelector('[data-unicode-action="addFavorites"]');
  const removeBtn = unicodeWindow.querySelector('[data-unicode-action="removeFavorites"]');
  unicodeRoot?.classList.toggle('favorites-edit-mode', state.editMode);
  if (inputBtn) inputBtn.disabled = state.editMode;
  if (defaultBtn) {
    defaultBtn.disabled = state.editMode;
    defaultBtn.textContent = state.selectedCode === state.defaultCode && state.defaultCode !== '2060'
      ? '기본값 해제'
      : '기본값 지정';
  }
  if (editBtn) {
    editBtn.classList.toggle('active', state.editMode);
    editBtn.setAttribute('aria-pressed', state.editMode ? 'true' : 'false');
    editBtn.textContent = state.editMode ? '편집 모드 종료' : '편집 모드';
  }
  if (addBtn) {
    addBtn.hidden = !state.editMode;
    addBtn.disabled = !state.editMode || nonFavoriteSelectionCodes().length === 0;
  }
  if (removeBtn) {
    removeBtn.hidden = !state.editMode;
    removeBtn.disabled = !state.editMode || favoriteSelectionCodes().length === 0;
  }
}

function visibleCellByCode(code) {
  return gridItems?.querySelector?.(`[data-code="${CSS.escape(code)}"]`) || null;
}

function currentColumns() {
  const width = Math.max(1, (grid?.clientWidth || 700) - GRID_PADDING * 2);
  return Math.max(1, Math.floor((width + COLUMN_GAP) / (MIN_CELL_WIDTH + COLUMN_GAP)));
}

function scrollCodeIntoView(code) {
  if (!grid) return;
  const index = state.displayCodes.indexOf(code);
  if (index < 0) return;
  const columns = currentColumns();
  const row = Math.floor(index / columns);
  const top = GRID_PADDING + row * ROW_HEIGHT;
  const bottom = top + CELL_HEIGHT;
  const viewTop = grid.scrollTop;
  const viewBottom = viewTop + grid.clientHeight;
  if (top < viewTop) grid.scrollTop = Math.max(0, top - GRID_PADDING);
  else if (bottom > viewBottom) grid.scrollTop = Math.max(0, bottom - grid.clientHeight + GRID_PADDING);
}

function selectCode(code, scroll = false) {
  const clean = normalizeGlyphCode(code);
  if (!clean || !state.displayCodes.includes(clean)) return;
  state.selectedCode = clean;
  syncVisibleSelectionClasses();
  updateActionState();
  updatePreview();
  if (scroll) {
    scrollCodeIntoView(clean);
    scheduleVirtualRender();
  }
}

function setEditSelection(codes, { primaryCode = null, anchorCode = undefined, scroll = false } = {}) {
  const available = new Set(state.displayCodes);
  const cleanCodes = sortCodes(codes).filter(code => available.has(code));
  state.selectedCodes = new Set(cleanCodes);
  const primary = normalizeGlyphCode(primaryCode);
  if (primary && available.has(primary)) state.selectedCode = primary;
  else if (cleanCodes.length && !state.selectedCodes.has(state.selectedCode)) state.selectedCode = cleanCodes[cleanCodes.length - 1];
  if (anchorCode !== undefined) {
    const cleanAnchor = normalizeGlyphCode(anchorCode);
    state.selectionAnchorCode = cleanAnchor && available.has(cleanAnchor) ? cleanAnchor : null;
  }
  syncVisibleSelectionClasses();
  updateActionState();
  updatePreview();
  if (scroll && state.selectedCode) {
    scrollCodeIntoView(state.selectedCode);
    scheduleVirtualRender();
  }
}

function handleEditSelection(code, event = {}) {
  const clean = normalizeGlyphCode(code);
  const index = state.displayCodes.indexOf(clean);
  if (index < 0) return;
  const additive = !!(event.ctrlKey || event.metaKey);
  const rangeMode = !!event.shiftKey;
  let next = new Set(state.selectedCodes);
  let anchor = state.selectionAnchorCode;

  if (rangeMode) {
    const anchorIndex = state.displayCodes.indexOf(anchor);
    const from = anchorIndex >= 0 ? anchorIndex : index;
    if (!additive) next = new Set();
    const start = Math.min(from, index);
    const end = Math.max(from, index);
    for (let i = start; i <= end; i++) next.add(state.displayCodes[i]);
    if (anchorIndex < 0) anchor = clean;
  } else if (additive) {
    if (next.has(clean)) next.delete(clean);
    else next.add(clean);
    anchor = clean;
  } else {
    next = new Set([clean]);
    anchor = clean;
  }
  setEditSelection([...next], { primaryCode: clean, anchorCode: anchor });
  if (!hasActiveBlockingModal()) grid?.focus({ preventScroll: true });
}

function toggleEditMode() {
  state.editMode = !state.editMode;
  closeGlyphContextMenu();
  hideInstantTooltip();
  if (state.editMode) {
    const initial = state.displayCodes.includes(state.selectedCode) ? [state.selectedCode] : [];
    setEditSelection(initial, { primaryCode: state.selectedCode, anchorCode: state.selectedCode });
  } else {
    state.selectedCodes = new Set();
    state.selectionAnchorCode = null;
    syncVisibleSelectionClasses();
    updateActionState();
    updatePreview();
  }
  scheduleVirtualRender();
}

function makeCell(code, favorites) {
  const cell = document.createElement('div');
  const selected = state.editMode ? state.selectedCodes.has(code) : code === state.selectedCode;
  const favorite = favorites.has(code);
  const isDefault = code === state.defaultCode;
  const supported = state.supportedSet.has(code);
  cell.className = `glyph-cell${selected ? ' selected' : ''}${state.editMode && selected ? ' edit-selected' : ''}${!supported ? ' glyph-not-supported' : ''}`;
  cell.dataset.code = code;
  cell.setAttribute('role', 'option');
  cell.setAttribute('aria-selected', selected ? 'true' : 'false');
  if (!supported) cell.setAttribute('data-tip', '현재 출력 폰트에서는 이 글리프를 지원하지 않습니다.');
  const favoriteTip = !state.editMode
    ? '즐겨찾기 변경은 편집 모드에서만 가능합니다.'
    : favorite
      ? '즐겨찾기에서 해제합니다. 해제 전 확인창이 표시됩니다.'
      : '즐겨찾기에 추가합니다.';
  cell.innerHTML = `
    <button type="button" class="glyph-favorite-toggle${favorite ? ' active' : ''}${state.editMode ? '' : ' locked'}" aria-label="즐겨찾기 ${favorite ? '해제' : '등록'}" aria-disabled="${state.editMode ? 'false' : 'true'}" data-tip="${favoriteTip}" data-glyph-favorite>${favorite ? '★' : '☆'}</button>
    <span class="glyph-default-marker${isDefault ? ' active' : ''}" aria-label="기본값" data-tip="기본값으로 지정된 글리프">●</span>
    <span class="glyph-char"></span>
    <span class="glyph-code"></span>
  `;
  cell.querySelector('.glyph-char').textContent = supported ? codeToChar(code) : '';
  cell.querySelector('.glyph-char').style.fontFamily = `"${outputFontCss()}"`;
  cell.querySelector('.glyph-code').textContent = unicodeAddress(code);

  cell.addEventListener('click', event => {
    if (event.target.closest('[data-glyph-favorite]')) return;
    if (state.editMode) handleEditSelection(code, event);
    else selectCode(code);
  });
  cell.addEventListener('dblclick', event => {
    if (event.target.closest('[data-glyph-favorite]')) return;
    event.preventDefault();
    if (state.editMode) {
      handleEditSelection(code, event);
      return;
    }
    selectCode(code);
    inputSelected(false);
  });
  cell.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (state.editMode) {
      if (!state.selectedCodes.has(code)) setEditSelection([code], { primaryCode: code, anchorCode: code });
      else selectCode(code);
    } else {
      selectCode(code);
    }
    showGlyphContextMenu(event.clientX, event.clientY);
  });
  cell.querySelector('[data-glyph-favorite]').addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    if (!state.editMode) return;
    if (favorite) await removeFavorites([code]);
    else addFavorites([code]);
  });
  return cell;
}

function renderVirtualGrid() {
  renderFrame = 0;
  if (!grid || !gridItems || !gridSpacer) return;
  const columns = currentColumns();
  const totalRows = Math.ceil(state.displayCodes.length / columns);
  gridSpacer.style.height = `${GRID_PADDING * 2 + totalRows * ROW_HEIGHT}px`;

  const scrollTop = grid.scrollTop;
  const viewportHeight = Math.max(1, grid.clientHeight || 400);
  const startRow = Math.max(0, Math.floor((scrollTop - GRID_PADDING) / ROW_HEIGHT) - VIRTUAL_OVERSCAN_ROWS);
  const endRow = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight - GRID_PADDING) / ROW_HEIGHT) + VIRTUAL_OVERSCAN_ROWS);
  const startIndex = startRow * columns;
  const endIndex = Math.min(state.displayCodes.length, endRow * columns);
  const slice = state.displayCodes.slice(startIndex, endIndex);
  const favorites = favoriteSet();

  gridItems.style.transform = `translateY(${GRID_PADDING + startRow * ROW_HEIGHT}px)`;
  gridItems.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  gridItems.innerHTML = '';
  for (const code of slice) gridItems.appendChild(makeCell(code, favorites));
  updateActionState();
  updatePreview();
}

function scheduleVirtualRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(renderVirtualGrid);
}

function updateGlyphSummary() {
  if (fontNameEl) fontNameEl.textContent = state.outputFontEntry ? getFontDisplayName(state.outputFontEntry) : '알 수 없음';
  if (glyphStatusEl) {
    glyphStatusEl.textContent = state.loading
      ? '글리프 목록 준비 중...'
      : `즐겨찾기 ${state.favoriteCodes.length.toLocaleString()}개 · 현재 폰트 지원 ${state.supportedCodes.length.toLocaleString()}개`;
  }
}

async function refreshFontGlyphs() {
  const sequence = ++loadSequence;
  state.loading = true;
  state.supportedCodes = [];
  state.supportedSet = new Set();
  rebuildDisplayCodes();
  updateGlyphSummary();
  renderVirtualGrid();

  try {
    const rows = await buildFontEntries({ prefs: getPreferences(), includeCustom: true });
    const rendering = getActiveDocumentRendering();
    const entry = findFontEntryForRendering(rows, rendering);
    const family = fontCssFamilyForUse(entry);
    if (sequence !== loadSequence || !unicodeWindow) return;
    state.outputFontEntry = entry;
    state.outputFontFamily = family || rendering.fontFamily || BUILTIN_FONT_CSS_FAMILY;
    updateGlyphSummary();
    updatePreview();

    const [outputResult, vanillaResult, vanillaFallbackResult] = await Promise.allSettled([
      loadFontCmapCodes(entry),
      loadFontCmapCodes({ source: 'builtin' }),
      loadFontCmapCodes({ source: BUILTIN_FALLBACK_FONT_SOURCE }),
    ]);
    if (sequence !== loadSequence || !unicodeWindow) return;
    const vanillaCodes = [];
    if (vanillaResult.status === 'fulfilled') vanillaCodes.push(...vanillaResult.value);
    if (vanillaFallbackResult.status === 'fulfilled') vanillaCodes.push(...vanillaFallbackResult.value);
    state.vanillaSupportedSet = new Set(sortCodes(vanillaCodes));
    if (outputResult.status !== 'fulfilled') throw outputResult.reason || new Error('font cmap unavailable');
    state.supportedCodes = sortCodes(outputResult.value);
    state.supportedSet = new Set(state.supportedCodes);
    state.loading = false;
    rebuildDisplayCodes();
    updateGlyphSummary();
    renderVirtualGrid();
    selectCode(state.selectedCode, true);
  } catch (err) {
    if (sequence !== loadSequence || !unicodeWindow) return;
    state.loading = false;
    state.supportedCodes = [];
    state.supportedSet = new Set();
    rebuildDisplayCodes();
    updateGlyphSummary();
    renderVirtualGrid();
    setErrorMessage('현재 폰트의 글리프 목록을 읽을 수 없습니다: ' + String(err?.message || err));
  }
}

function selectMovedCode(code) {
  if (state.editMode) setEditSelection([code], { primaryCode: code, anchorCode: code, scroll: true });
  else selectCode(code, true);
}

function moveSelectionLinear(delta) {
  const index = state.displayCodes.indexOf(state.selectedCode);
  if (index < 0 || !state.displayCodes.length) return;
  const next = Math.max(0, Math.min(state.displayCodes.length - 1, index + delta));
  selectMovedCode(state.displayCodes[next]);
}

function moveSelectionRows(delta) {
  const index = state.displayCodes.indexOf(state.selectedCode);
  if (index < 0 || !state.displayCodes.length) return;
  const next = Math.max(0, Math.min(state.displayCodes.length - 1, index + delta * currentColumns()));
  selectMovedCode(state.displayCodes[next]);
}

async function exportFavorites() {
  try {
    const path = await saveFileDialog(exportFavoritesText(), null, getPreferences().defaultSaveDirectory, 'ttedit_unicode_favorites.txt');
    setStatusMessage(path ? `유니코드 즐겨찾기 ${state.favoriteCodes.length}개 내보내기 완료` : '유니코드 즐겨찾기 내보내기 취소');
  } catch (err) {
    setErrorMessage('유니코드 즐겨찾기 내보내기 실패: ' + String(err));
  }
}

async function importFavorites() {
  try {
    const opened = await openFileDialog(getPreferences().defaultSaveDirectory);
    if (!opened) { setStatusMessage('유니코드 즐겨찾기 불러오기 취소'); return; }
    const parsed = importFavoritesText(opened.content || '');
    if (parsed.badFormat) {
      await showAlertModal('잘못된 형식입니다. 유니코드 즐겨찾기 백업 파일만 불러올 수 있습니다.', { title: '즐겨찾기 불러오기' });
      return;
    }
    if (parsed.errors?.length) {
      await showAlertModal(`잘못된 주소가 있습니다. 문제 줄: ${parsed.errors.slice(0, 12).join(', ')}${parsed.errors.length > 12 ? ' ...' : ''}`, { title: '즐겨찾기 불러오기' });
      return;
    }
    state.favoriteCodes = parsed.codes;
    saveState();
    pruneEditSelection();
    renderVirtualGrid();
    selectCode(state.selectedCode, true);
    setStatusMessage(`유니코드 즐겨찾기 불러오기 완료: ${state.favoriteCodes.length}개 복원`);
  } catch (err) {
    setErrorMessage('유니코드 즐겨찾기 불러오기 실패: ' + String(err));
  }
}

async function inputSelected(closeAfter = false) {
  if (state.editMode) return;
  insertUnicodeGlyph(state.selectedCode);
  if (closeAfter && unicodeWindow) {
    closeFloatingWindow(unicodeWindow);
    unicodeWindow = null;
  }
}

function formatCodeSummary(codes, limit = 18) {
  const clean = sortCodes(codes);
  const shown = clean.slice(0, limit).map(unicodeAddress);
  const more = clean.length > limit ? ` (+${clean.length - limit})` : '';
  return `${shown.join(', ')}${more}`;
}

function addFavorites(codes) {
  if (!state.editMode) return;
  const favorites = favoriteSet();
  const targets = sortCodes(codes).filter(code => state.displayCodes.includes(code) && !favorites.has(code));
  if (!targets.length) {
    setStatusMessage('즐겨찾기에 추가할 글리프가 없습니다.');
    return;
  }
  for (const code of targets) favorites.add(code);
  state.favoriteCodes = sortCodes([...favorites]);
  saveState();
  pruneEditSelection();
  renderVirtualGrid();
  updateActionState();
  setStatusMessage(`즐겨찾기에 ${targets.length.toLocaleString()}개 추가`);
}

async function removeFavorites(codes) {
  if (!state.editMode) return;
  const favorites = favoriteSet();
  const targets = sortCodes(codes).filter(code => favorites.has(code));
  if (!targets.length) {
    setStatusMessage('즐겨찾기에서 해제할 글리프가 없습니다.');
    return;
  }
  const ok = await showConfirmModal(
    `선택한 ${targets.length.toLocaleString()}개 글리프를 즐겨찾기에서 해제하시겠습니까?\n${formatCodeSummary(targets)}`,
    { title: '즐겨찾기 해제 확인' },
  );
  if (!ok) return;
  for (const code of targets) favorites.delete(code);
  state.favoriteCodes = sortCodes([...favorites]);
  saveState();
  pruneEditSelection();
  if (!state.selectedCodes.size && state.displayCodes.includes(state.selectedCode)) {
    state.selectedCodes.add(state.selectedCode);
    state.selectionAnchorCode = state.selectedCode;
  }
  renderVirtualGrid();
  updateActionState();
  updatePreview();
  setStatusMessage(`즐겨찾기에서 ${targets.length.toLocaleString()}개 해제`);
}

async function setOrClearDefault() {
  if (state.editMode) return;
  if (state.selectedCode === state.defaultCode && state.defaultCode !== '2060') {
    state.defaultCode = '2060';
    saveState();
    renderVirtualGrid();
    selectCode(state.defaultCode, true);
    setStatusMessage('유니코드 기본값 해제');
    return;
  }
  state.defaultCode = state.selectedCode;
  saveState();
  renderVirtualGrid();
  selectCode(state.selectedCode, true);
  setStatusMessage(`기본 글리프 ${unicodeAddress(state.defaultCode)} 지정`);
}

async function restoreSystemDefaults() {
  if (!await showConfirmModal('즐겨찾기와 기본값을 시스템 초기값으로 복원하시겠습니까?', { title: '시스템 초기값 복원' })) return;
  const settings = resetGlyphSettings();
  state.favoriteCodes = sortCodes(settings.favoriteCodes || settings.codes || []);
  state.defaultCode = normalizeGlyphCode(settings.defaultCode) || '2060';
  state.selectedCode = state.defaultCode;
  rebuildDisplayCodes();
  if (state.editMode) {
    state.selectedCodes = new Set([state.selectedCode]);
    state.selectionAnchorCode = state.selectedCode;
  } else {
    state.selectedCodes = new Set();
    state.selectionAnchorCode = null;
  }
  renderVirtualGrid();
  selectCode(state.selectedCode, true);
  updateGlyphSummary();
  updateActionState();
  setStatusMessage('유니코드 즐겨찾기와 기본값을 시스템 초기값으로 복원했습니다.');
}

function appendContextMenuItem(label, fn, disabled = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.disabled = !!disabled;
  btn.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    if (btn.disabled) return;
    closeGlyphContextMenu();
    await fn();
  });
  contextMenu.appendChild(btn);
}

function showGlyphContextMenu(x, y) {
  closeGlyphContextMenu();
  contextMenu = document.createElement('div');
  contextMenu.className = 'glyph-context-menu context-menu';
  contextMenu.addEventListener('mousedown', event => event.stopPropagation(), true);
  contextMenu.addEventListener('click', event => event.stopPropagation());

  if (state.editMode) {
    const selected = editSelectionCodes();
    const addable = nonFavoriteSelectionCodes();
    const removable = favoriteSelectionCodes();
    appendContextMenuItem('즐겨찾기에 추가', () => addFavorites(selected), addable.length === 0);
    appendContextMenuItem('즐겨찾기 해제', () => removeFavorites(selected), removable.length === 0);
  } else {
    appendContextMenuItem(
      state.selectedCode === state.defaultCode && state.defaultCode !== '2060' ? '기본값 해제' : '기본값으로 지정',
      setOrClearDefault,
    );
  }

  document.body.appendChild(contextMenu);
  const rect = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  contextMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  setTimeout(() => document.addEventListener('mousedown', closeGlyphContextMenu, { once: true }), 0);
}

function closeGlyphContextMenu() {
  if (contextMenu) contextMenu.remove();
  contextMenu = null;
}

function hideInstantTooltip() {
  if (instantTooltipEl) instantTooltipEl.remove();
  instantTooltipEl = null;
}

function showInstantTooltip(anchor) {
  const text = String(anchor?.dataset?.tip || '').trim();
  if (!text) return;
  hideInstantTooltip();
  instantTooltipEl = document.createElement('div');
  instantTooltipEl.className = 'pref-instant-tooltip unicode-instant-tooltip';
  instantTooltipEl.textContent = text;
  document.body.appendChild(instantTooltipEl);
  const rect = anchor.getBoundingClientRect();
  const gap = 6;
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - instantTooltipEl.offsetWidth - 8));
  let top = rect.bottom + gap;
  if (top + instantTooltipEl.offsetHeight > window.innerHeight - 8) top = rect.top - instantTooltipEl.offsetHeight - gap;
  if (top < 8) top = 8;
  instantTooltipEl.style.left = `${left}px`;
  instantTooltipEl.style.top = `${top}px`;
}

function bindInstantTooltips(root) {
  const findAnchor = target => target?.closest?.('[data-tip]');
  root.addEventListener('mouseover', event => {
    const anchor = findAnchor(event.target);
    if (anchor && root.contains(anchor)) showInstantTooltip(anchor);
  });
  root.addEventListener('mouseout', event => {
    const anchor = findAnchor(event.target);
    if (!anchor) return;
    if (event.relatedTarget && anchor.contains(event.relatedTarget)) return;
    hideInstantTooltip();
  });
  root.addEventListener('focusin', event => {
    const anchor = findAnchor(event.target);
    if (anchor && root.contains(anchor)) showInstantTooltip(anchor);
  });
  root.addEventListener('focusout', hideInstantTooltip);
  grid?.addEventListener('scroll', hideInstantTooltip, true);
}

function createContent() {
  const root = document.createElement('div');
  root.className = 'unicode-dialog';
  unicodeRoot = root;
  root.innerHTML = `
    <div class="unicode-font-summary">
      <span>현재 폰트: <strong class="unicode-current-font">준비 중...</strong></span>
      <span class="unicode-glyph-status">글리프 목록 준비 중...</span>
    </div>
    <div class="unicode-main">
      <div class="unicode-grid-wrap" role="listbox" aria-label="유니코드 글리프 목록" tabindex="0">
        <div class="unicode-grid-spacer" aria-hidden="true"></div>
        <div class="unicode-grid-items"></div>
      </div>
      <aside class="unicode-preview">
        <div class="unicode-preview-panel unicode-preview-default">
          <div class="unicode-preview-label">기본 폰트 <button type="button" class="unicode-help-icon" aria-label="기본 폰트 설명" data-tip="기본 폰트 미리보기는 내장된 D2R 바닐라 Kodia를 우선 사용하고, Kodia에 없는 글리프는 내장 바닐라 대체 폰트에서도 확인합니다. 커스텀 Unicode 글리프가 기본 게임 환경에서 어떻게 보일지 추측하기 위한 참고용입니다.">?</button></div>
          <div class="unicode-preview-glyph unicode-preview-glyph-default"></div>
        </div>
        <div class="unicode-preview-panel unicode-preview-output">
          <div class="unicode-preview-label">출력 폰트</div>
          <div class="unicode-preview-glyph unicode-preview-glyph-output"></div>
        </div>
        <div class="unicode-preview-code"></div>
      </aside>
    </div>
    <div class="unicode-list-actions">
      <div class="unicode-list-actions-left">
        <button type="button" data-unicode-action="editMode" aria-pressed="false" data-tip="즐겨찾기 편집 모드를 켜면 Ctrl/Shift 복수선택, 우클릭 일괄 추가/해제, Delete 키 삭제를 사용할 수 있습니다. 편집 모드에서는 글리프 입력과 기본값 지정이 비활성화됩니다.">편집 모드</button>
        <button type="button" class="unicode-edit-only" data-unicode-action="addFavorites" data-tip="선택한 글리프를 즐겨찾기에 추가합니다." hidden>즐겨찾기에 추가</button>
        <button type="button" class="unicode-edit-only" data-unicode-action="removeFavorites" data-tip="선택한 글리프를 즐겨찾기에서 해제합니다. 해제 전 확인창이 표시됩니다." hidden>즐겨찾기 해제</button>
        <button type="button" data-unicode-action="restoreDefaults" data-tip="즐겨찾기와 기본값을 시스템 초기값으로 복원합니다.">시스템 초기값으로 복원</button>
      </div>
      <div class="unicode-list-actions-right">
        <button type="button" data-unicode-action="importFavorites">즐겨찾기 불러오기..</button>
        <button type="button" data-unicode-action="exportFavorites">즐겨찾기 내보내기..</button>
      </div>
    </div>
    <div class="unicode-actions">
      <button type="button" data-unicode-action="input">입력</button>
      <button type="button" data-unicode-action="setDefault" data-tip="기본값으로 지정할 경우 오른쪽 마우스 메뉴를 통해 편집창에서 간단하게 입력할 수 있습니다.">기본값 지정</button>
      <button type="button" data-unicode-action="close">닫기</button>
    </div>
  `;
  grid = root.querySelector('.unicode-grid-wrap');
  gridSpacer = root.querySelector('.unicode-grid-spacer');
  gridItems = root.querySelector('.unicode-grid-items');
  previewGlyphDefault = root.querySelector('.unicode-preview-glyph-default');
  previewGlyphOutput = root.querySelector('.unicode-preview-glyph-output');
  previewCode = root.querySelector('.unicode-preview-code');
  fontNameEl = root.querySelector('.unicode-current-font');
  glyphStatusEl = root.querySelector('.unicode-glyph-status');

  root.querySelector('[data-unicode-action="editMode"]').addEventListener('click', toggleEditMode);
  root.querySelector('[data-unicode-action="addFavorites"]').addEventListener('click', () => addFavorites(editSelectionCodes()));
  root.querySelector('[data-unicode-action="removeFavorites"]').addEventListener('click', () => removeFavorites(editSelectionCodes()));
  root.querySelector('[data-unicode-action="restoreDefaults"]').addEventListener('click', restoreSystemDefaults);
  root.querySelector('[data-unicode-action="importFavorites"]').addEventListener('click', importFavorites);
  root.querySelector('[data-unicode-action="exportFavorites"]').addEventListener('click', exportFavorites);
  root.querySelector('[data-unicode-action="input"]').addEventListener('click', () => inputSelected(false));
  root.querySelector('[data-unicode-action="setDefault"]').addEventListener('click', setOrClearDefault);
  root.querySelector('[data-unicode-action="close"]').addEventListener('click', () => {
    if (unicodeWindow) {
      closeFloatingWindow(unicodeWindow);
      unicodeWindow = null;
    }
  });

  grid.addEventListener('scroll', scheduleVirtualRender, { passive: true });
  grid.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      if (!state.editMode) { event.preventDefault(); inputSelected(false); }
    } else if (state.editMode && event.key === 'Delete') {
      event.preventDefault();
      void removeFavorites(editSelectionCodes());
    } else if (event.key === 'ArrowRight') { event.preventDefault(); moveSelectionLinear(1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); moveSelectionLinear(-1); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); moveSelectionRows(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveSelectionRows(-1); }
    else if (event.key === 'Home') { event.preventDefault(); selectMovedCode(state.displayCodes[0]); }
    else if (event.key === 'End') { event.preventDefault(); selectMovedCode(state.displayCodes[state.displayCodes.length - 1]); }
  });
  root.addEventListener('contextmenu', event => {
    if (!event.target.closest('.glyph-cell')) event.preventDefault();
  });
  bindInstantTooltips(root);
  return root;
}

function dialogSize() {
  return {
    width: Math.min(1160, Math.max(720, window.innerWidth - 32)),
    height: Math.min(790, Math.max(440, window.innerHeight - 32)),
  };
}

export function openUnicodeDialog() {
  if (!unicodeWindow && hasFloatingWindow()) { pokeActiveFloatingWindow(); return; }
  if (unicodeWindow) {
    if (focusFloatingWindow(unicodeWindow) && !hasActiveBlockingModal()) grid?.focus({ preventScroll: true });
    return;
  }
  loadState();
  const content = createContent();
  const size = dialogSize();
  unicodeWindow = createFloatingWindow({
    title: '유니코드 목록표',
    width: size.width,
    height: size.height,
    content,
    onClose: () => {
      unicodeWindow = null;
      closeGlyphContextMenu();
      hideInstantTooltip();
      loadSequence += 1;
      if (renderFrame) cancelAnimationFrame(renderFrame);
      renderFrame = 0;
      resizeObserver?.disconnect?.();
      resizeObserver = null;
      grid = null;
      gridItems = null;
      gridSpacer = null;
      unicodeRoot = null;
    },
  });
  if (!unicodeWindow) return;

  resizeObserver = new ResizeObserver(scheduleVirtualRender);
  resizeObserver.observe(grid);
  updateActionState();
  renderVirtualGrid();
  selectCode(state.defaultCode, true);
  updateGlyphSummary();
  void refreshFontGlyphs();
  if (!hasActiveBlockingModal()) grid?.focus({ preventScroll: true });
}
