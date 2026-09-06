import { getPreferences, setPreferences } from './preferences.js';
import { getActiveDocumentRendering, setActiveDocumentRendering, normalizeRenderingSettings, markDirty, getActiveDocument, getDisplayFileName } from './state.js';
import { updateLineNumbers } from './lineNumbers.js';
import { setStatusMessage, setErrorMessage, setDocumentStatus } from './statusBar.js';
import { renderDocumentTabs } from './documentTabs.js';
import { BUILTIN_FONT_CSS_FAMILY, BUILTIN_FONT_DISPLAY_NAME, BUILTIN_FONT_FILE_NAME, BUILTIN_FALLBACK_FONT_SOURCE, FALLBACK_FONT_CSS_FAMILY, FALLBACK_FONT_FILE_NAME, FALLBACK_FONT_DISPLAY_NAME, buildFontEntries, getFontDisplayName as serviceDisplayFontLabel, findFontEntryForRendering, fontCssFamilyForUse, getFontId, isFavoriteFont, renderingPatchFromFontEntry, getFontNameLabel, getFontRoleLabel } from './fontService.js';
import { displayRenderingEquals } from './displayMetadata.js';

const FONT_ROW_HEIGHT = 34;
function fontSampleText() { return getPreferences().uiLanguage === 'en' ? 'Sample ABC 123' : '가나다 ABC 123'; }
const FONT_SIZE_PRESETS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 48, 56, 64, 72, 88, 96, 112];
function fontId(row = {}) { return getFontId(row); }
function isFavorite(row) { return isFavoriteFont(row, getPreferences()); }
function formatNumber(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}
function formatPt(value) { return formatNumber(value, 1); }
function nextPresetSize(current, dir) {
  const n = Number(current);
  if (!Number.isFinite(n)) return dir > 0 ? FONT_SIZE_PRESETS[0] : FONT_SIZE_PRESETS[FONT_SIZE_PRESETS.length - 1];
  if (dir > 0) return FONT_SIZE_PRESETS.find(v => v > n) ?? FONT_SIZE_PRESETS[FONT_SIZE_PRESETS.length - 1];
  for (let i = FONT_SIZE_PRESETS.length - 1; i >= 0; i--) if (FONT_SIZE_PRESETS[i] < n) return FONT_SIZE_PRESETS[i];
  return FONT_SIZE_PRESETS[0];
}
function lineHeightForFontSizeChange(current = {}, nextFontSizePt = 25) {
  const oldSize = clamp(current.fontSizePt, 6, 999, 25);
  const oldLine = clamp(current.lineHeightPt, 6, 2000, 27);
  const nextSize = clamp(nextFontSizePt, 6, 999, oldSize);
  return Math.round(clamp(oldLine * (nextSize / oldSize), 6, 2000, 27) * 10) / 10;
}
function sanitizeDecimalText(value, fallback, min, max, digits = 1) {
  const cleaned = String(value ?? '').replace(/[^0-9.]+/g, '').replace(/(\..*)\./g, '$1');
  const n = Number.parseFloat(cleaned);
  const v = clamp(Number.isFinite(n) ? n : fallback, min, max, fallback);
  return Math.round(v * (10 ** digits)) / (10 ** digits);
}
function sanitizeIntegerText(value, fallback, min, max) {
  const cleaned = String(value ?? '').replace(/[^0-9]+/g, '');
  const n = Number.parseInt(cleaned, 10);
  return Math.round(clamp(Number.isFinite(n) ? n : fallback, min, max, fallback));
}

let editorText = null;
let controls = {};
let allFontRows = [];
let filteredFontRows = [];
let panelOpen = false;
let systemFontsLoaded = false;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function escapeHtml(text) { return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function cssString(text) { return String(text ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function displayFontLabel(row) { return serviceDisplayFontLabel(row); }
function baseFontRows() {
  return [
    { source: 'builtin', familyName: BUILTIN_FONT_CSS_FAMILY, fileName: BUILTIN_FONT_FILE_NAME, path: '', displayName: BUILTIN_FONT_DISPLAY_NAME },
    { source: BUILTIN_FALLBACK_FONT_SOURCE, familyName: FALLBACK_FONT_CSS_FAMILY, fileName: FALLBACK_FONT_FILE_NAME, path: '', displayName: FALLBACK_FONT_DISPLAY_NAME },
    { source: 'system', familyName: 'Malgun Gothic', fileName: 'malgun.ttf', path: '', displayName: '맑은 고딕' },
    { source: 'separator', label: '시스템 설치 글꼴' },
  ];
}
async function loadFontRows() {
  try {
    allFontRows = await buildFontEntries({ prefs: getPreferences(), includeCustom: true });
    systemFontsLoaded = true;
    filterFontRows();
  } catch (err) {
    console.warn('font list failed', err);
    setErrorMessage('글꼴 목록 조회 실패');
    allFontRows = baseFontRows();
    systemFontsLoaded = true;
    filterFontRows();
  }
}
function filterFontRows() {
  const q = String(controls.fontSearch?.value || '').trim().toLowerCase();
  if (!q) filteredFontRows = allFontRows.slice();
  else filteredFontRows = allFontRows.filter(row => row.source === 'separator' || `${row.familyName || ''} ${row.fileName || ''} ${row.path || ''} ${row.displayName || ''}`.toLowerCase().includes(q));
  if (filteredFontRows[filteredFontRows.length - 1]?.source === 'separator') filteredFontRows.pop();
  renderFontList();
}
function renderFontList() {
  if (!controls.fontViewport || !controls.fontItems || !controls.fontSpacer) return;
  const rows = filteredFontRows;
  const total = rows.length * FONT_ROW_HEIGHT;
  controls.fontSpacer.style.height = `${total}px`;
  const scrollTop = controls.fontViewport.scrollTop;
  const height = controls.fontViewport.clientHeight || 240;
  const start = Math.max(0, Math.floor(scrollTop / FONT_ROW_HEIGHT) - 5);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / FONT_ROW_HEIGHT) + 8);
  controls.fontItems.style.transform = `translateY(${start * FONT_ROW_HEIGHT}px)`;
  const current = getActiveDocumentRendering();
  const selectedRow = findFontEntryForRendering(allFontRows, current);
  const selectedId = selectedRow ? fontId(selectedRow) : '';
  controls.fontItems.innerHTML = rows.slice(start, end).map((row, idx) => {
    const realIndex = start + idx;
    if (row.source === 'separator') return `<div class="render-font-separator" style="height:${FONT_ROW_HEIGHT}px">${escapeHtml(row.label || '')}</div>`;
    const family = fontCssFamilyForUse(row);
    const selected = selectedId && fontId(row) === selectedId;
    const canFav = row.source === 'system' && displayFontLabel(row) !== '맑은 고딕';
    const star = canFav ? `<span class="render-font-star${isFavorite(row) ? ' active' : ''}" data-font-star="${realIndex}" title="즐겨찾기 글꼴">${isFavorite(row) ? '★' : '☆'}</span>` : '<span class="render-font-star placeholder"></span>';
    const tag = getFontRoleLabel(row);
    return `<button type="button" class="render-font-row${row.isCustomAlias ? ' custom-font-alias-row' : ''}${selected ? ' active' : ''}" data-font-index="${realIndex}" style="height:${FONT_ROW_HEIGHT}px">${star}<span class="render-font-name">${escapeHtml(getFontNameLabel(row))}</span><span class="render-font-sample" style="font-family:&quot;${escapeHtml(family)}&quot;, Malgun Gothic, sans-serif">${fontSampleText()}</span><span class="render-font-tag">${escapeHtml(tag)}</span></button>`;
  }).join('');
  const count = rows.filter(row => row.source !== 'separator').length;
  controls.fontStatus.textContent = systemFontsLoaded ? `${count.toLocaleString('ko-KR')}개 글꼴 표시` : '글꼴 목록 준비 중';
}
function openFontPanel() {
  if (!controls.fontPanel) return;
  panelOpen = true;
  controls.fontPanel.hidden = false;
  if (!systemFontsLoaded) void loadFontRows();
  filterFontRows();
  controls.fontSearch?.focus({ preventScroll: true });
}
function closeFontPanel() {
  if (!controls.fontPanel) return;
  panelOpen = false;
  controls.fontPanel.hidden = true;
}
function selectedFontRowFromRendering(rendering) { return findFontEntryForRendering(allFontRows, rendering); }
function applyRenderingToDom(rendering = getActiveDocumentRendering()) {
  const r = normalizeRenderingSettings(rendering);
  const selected = findFontEntryForRendering(allFontRows, r);
  const family = fontCssFamilyForUse(selected) || r.fontFamily;
  document.documentElement.style.setProperty('--render-font-family', `"${cssString(family)}", "Malgun Gothic", sans-serif`);
  document.documentElement.style.setProperty('--render-font-size', `${r.fontSizePt}pt`);
  document.documentElement.style.setProperty('--render-line-height', `${r.lineHeightPt}pt`);
  document.documentElement.style.setProperty('--render-text-align', r.textAlign);
  document.documentElement.style.setProperty('--render-tab-size', String(r.tabWidth));
  if (editorText) editorText.style.textAlign = r.textAlign;
  updateLineNumbers();
}
function updateControlsFromRendering(rendering = getActiveDocumentRendering()) {
  const r = normalizeRenderingSettings(rendering);
  if (controls.fontSizeInput) controls.fontSizeInput.value = formatPt(r.fontSizePt);
  if (controls.lineHeightInput) controls.lineHeightInput.value = formatPt(r.lineHeightPt);
  if (controls.tabWidthInput) controls.tabWidthInput.value = String(r.tabWidth);
  if (controls.tabWidthSlider) controls.tabWidthSlider.value = String(r.tabWidth);
  if (controls.fontSizePreset) {
    const defaults = normalizeRenderingSettings(getPreferences().defaultRendering || {});
    controls.fontSizePreset.value = Math.round(Number(r.fontSizePt)) === Math.round(Number(defaults.fontSizePt)) ? 'default' : (FONT_SIZE_PRESETS.includes(Number(r.fontSizePt)) ? String(Number(r.fontSizePt)) : '');
  }
  const row = selectedFontRowFromRendering(r);
  if (controls.fontLabel) controls.fontLabel.textContent = displayFontLabel(row);
  for (const btn of Object.values(controls.alignButtons || {})) btn?.classList.toggle('active', btn.dataset.align === r.textAlign);
  const theme = document.documentElement.dataset.theme === 'day' ? 'day' : 'dark';
  if (controls.themeToggle) controls.themeToggle.textContent = theme === 'dark' ? '☀ 데이모드로 전환' : '☾ 다크모드로 전환';
  renderFontList();
}

function refreshDocumentDirtyStatus() {
  const doc = getActiveDocument();
  setDocumentStatus({ fileName: getDisplayFileName(doc), hasPath: !!doc.currentFilePath, dirty: doc.dirty, length: doc.documentText.length, text: doc.documentText });
  renderDocumentTabs();
}

function updateActiveRendering(partial, { status = null } = {}) {
  const current = getActiveDocumentRendering();
  const nextDraft = { ...current, ...(partial || {}) };
  const next = setActiveDocumentRendering(nextDraft);
  if (getPreferences().saveDisplaySettingsInFile !== false && !displayRenderingEquals(current, next)) { markDirty(); refreshDocumentDirtyStatus(); }
  applyRenderingToDom(next);
  updateControlsFromRendering(next);
  try { window.dispatchEvent(new CustomEvent('ttedit-rendering-changed', { detail: { rendering: next, reason: status || 'rendering-update' } })); } catch (_) {}
  if (status) setStatusMessage(status);
}
function selectFontRow(row) {
  if (!row || row.source === 'separator') return;
  updateActiveRendering(renderingPatchFromFontEntry(row), { status: `편집창 글꼴 변경: ${displayFontLabel(row)}` });
  closeFontPanel();
}
function setThemeMode(mode, persist = true) {
  const theme = mode === 'day' ? 'day' : 'dark';
  document.documentElement.dataset.theme = theme;
  void persist;
  updateControlsFromRendering();
  setStatusMessage(theme === 'dark' ? '다크모드 전환' : '데이모드 전환');
}
function initFontSizePresets() {
  if (!controls.fontSizePreset) return;
  controls.fontSizePreset.innerHTML = '<option value="default">기본값</option>' + FONT_SIZE_PRESETS.map(n => `<option value="${Number(n)}">${Number(n)} pt</option>`).join('');
}
function collectControls() {
  controls = {
    fontButton: document.getElementById('renderFontButton'),
    fontLabel: document.getElementById('renderFontLabel'),
    fontPanel: document.getElementById('renderFontPanel'),
    fontSearch: document.getElementById('renderFontSearch'),
    fontViewport: document.getElementById('renderFontViewport'),
    fontSpacer: document.getElementById('renderFontSpacer'),
    fontItems: document.getElementById('renderFontItems'),
    fontStatus: document.getElementById('renderFontStatus'),
    fontSizeInput: document.getElementById('renderFontSizeInput'),
    fontSizeDown: document.getElementById('renderFontSizeDown'),
    fontSizeUp: document.getElementById('renderFontSizeUp'),
    fontSizePreset: document.getElementById('renderFontSizePreset'),
    lineHeightInput: document.getElementById('renderLineHeightInput'),
    tabWidthInput: document.getElementById('renderTabWidthInput'),
    tabWidthSlider: document.getElementById('renderTabWidthSlider'),
    resetFontButton: document.getElementById('renderResetFontButton'),
    themeToggle: document.getElementById('themeToggleButton'),
    alignButtons: {
      left: document.getElementById('renderAlignLeft'),
      center: document.getElementById('renderAlignCenter'),
      right: document.getElementById('renderAlignRight'),
    },
  };
  document.querySelectorAll('.render-strip input[type="text"], .render-strip input[type="number"], .render-strip textarea').forEach(el => { el.removeAttribute('title'); el.setAttribute('autocomplete', 'off'); });
}
function toggleFavoriteFont(row) {
  if (!row || row.source !== 'system') return;
  const id = fontId(row);
  const prefs = getPreferences();
  const set = new Set(Array.isArray(prefs.renderingFavoriteFonts) ? prefs.renderingFavoriteFonts : []);
  if (set.has(id)) set.delete(id); else set.add(id);
  setPreferences({ renderingFavoriteFonts: Array.from(set) });
  void loadFontRows().then(() => { applyRenderingToDom(); updateControlsFromRendering(); });
}

function installEvents() {
  controls.fontButton?.addEventListener('click', () => panelOpen ? closeFontPanel() : openFontPanel());
  controls.fontSearch?.addEventListener('input', filterFontRows);
  controls.fontViewport?.addEventListener('scroll', renderFontList, { passive: true });
  controls.fontItems?.addEventListener('click', event => {
    const star = event.target?.closest?.('[data-font-star]');
    if (star) { event.preventDefault(); event.stopPropagation(); toggleFavoriteFont(filteredFontRows[Number(star.dataset.fontStar)]); return; }
    const rowButton = event.target?.closest?.('[data-font-index]');
    if (!rowButton) return;
    selectFontRow(filteredFontRows[Number(rowButton.dataset.fontIndex)]);
  });
  document.addEventListener('mousedown', event => {
    if (!panelOpen) return;
    if (event.target?.closest?.('#renderFontPicker')) return;
    closeFontPanel();
  }, true);
  controls.fontPanel?.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeFontPanel(); controls.fontButton?.focus({ preventScroll: true }); }
  });
  controls.fontSizeInput?.addEventListener('change', () => {
    const current = getActiveDocumentRendering();
    const nextSize = sanitizeDecimalText(controls.fontSizeInput.value, current.fontSizePt, 6, 999, 1);
    updateActiveRendering({ fontSizePt: nextSize, lineHeightPt: lineHeightForFontSizeChange(current, nextSize) }, { status: '글꼴 크기 변경' });
  });
  controls.fontSizeInput?.addEventListener('blur', () => {
    const current = getActiveDocumentRendering();
    controls.fontSizeInput.value = formatPt(sanitizeDecimalText(controls.fontSizeInput.value, current.fontSizePt, 6, 999, 1));
  });
  function applyLineHeightPt() {
    const current = getActiveDocumentRendering();
    const nextLineHeight = sanitizeDecimalText(controls.lineHeightInput?.value, current.lineHeightPt, 6, 2000, 1);
    updateActiveRendering({ lineHeightPt: nextLineHeight }, { status: '줄 간격 변경' });
  }
  controls.fontSizePreset?.addEventListener('change', () => {
    if (!controls.fontSizePreset.value) return;
    const current = getActiveDocumentRendering();
    const nextSize = controls.fontSizePreset.value === 'default' ? normalizeRenderingSettings(getPreferences().defaultRendering || {}).fontSizePt : sanitizeDecimalText(controls.fontSizePreset.value, current.fontSizePt, 6, 999, 1);
    if (controls.fontSizeInput) controls.fontSizeInput.value = formatPt(nextSize);
    const defaultRendering = normalizeRenderingSettings(getPreferences().defaultRendering || {});
    const patch = controls.fontSizePreset.value === 'default'
      ? { fontSizePt: defaultRendering.fontSizePt, lineHeightPt: defaultRendering.lineHeightPt }
      : { fontSizePt: nextSize, lineHeightPt: lineHeightForFontSizeChange(current, nextSize) };
    updateActiveRendering(patch, { status: '글꼴 크기 변경' });
  });
  function stepFontSizePreset(dir) {
    const current = getActiveDocumentRendering();
    const nextSize = nextPresetSize(current.fontSizePt, dir);
    if (controls.fontSizeInput) controls.fontSizeInput.value = formatPt(nextSize);
    updateActiveRendering({ fontSizePt: nextSize, lineHeightPt: lineHeightForFontSizeChange(current, nextSize) }, { status: '글꼴 크기 변경' });
  }
  controls.fontSizeDown?.addEventListener('click', () => stepFontSizePreset(-1));
  controls.fontSizeUp?.addEventListener('click', () => stepFontSizePreset(1));
  controls.fontSizeInput?.addEventListener('keydown', event => {
    if (event.key === 'ArrowUp') { event.preventDefault(); stepFontSizePreset(1); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); stepFontSizePreset(-1); }
  });
  controls.lineHeightInput?.addEventListener('change', applyLineHeightPt);
  controls.lineHeightInput?.addEventListener('blur', () => { controls.lineHeightInput.value = formatPt(sanitizeDecimalText(controls.lineHeightInput.value, getActiveDocumentRendering().lineHeightPt, 6, 2000, 1)); });
  function applyTabWidth(value, { live = false } = {}) {
    const current = getActiveDocumentRendering();
    const nextTabWidth = sanitizeIntegerText(value, current.tabWidth, 1, 32);
    if (controls.tabWidthInput) controls.tabWidthInput.value = String(nextTabWidth);
    if (controls.tabWidthSlider) controls.tabWidthSlider.value = String(nextTabWidth);
    updateActiveRendering({ tabWidth: nextTabWidth }, { status: live ? null : `탭 너비 변경: ${nextTabWidth}칸` });
  }
  controls.tabWidthSlider?.addEventListener('input', () => applyTabWidth(controls.tabWidthSlider.value, { live: true }));
  controls.tabWidthSlider?.addEventListener('change', () => applyTabWidth(controls.tabWidthSlider.value));
  controls.tabWidthInput?.addEventListener('change', () => applyTabWidth(controls.tabWidthInput.value));
  controls.tabWidthInput?.addEventListener('blur', () => { controls.tabWidthInput.value = String(sanitizeIntegerText(controls.tabWidthInput.value, getActiveDocumentRendering().tabWidth, 1, 32)); });
  controls.resetFontButton?.addEventListener('click', () => {
    const defaults = normalizeRenderingSettings(getPreferences().defaultRendering || {});
    updateActiveRendering({ fontSizePt: defaults.fontSizePt, lineHeightPt: defaults.lineHeightPt, tabWidth: defaults.tabWidth }, { status: '설정 기본값 적용' });
  });
  for (const btn of Object.values(controls.alignButtons || {})) {
    btn?.addEventListener('click', () => updateActiveRendering({ textAlign: btn.dataset.align || 'left' }, { status: '편집창 정렬 변경' }));
  }
  controls.themeToggle?.addEventListener('click', () => setThemeMode(document.documentElement.dataset.theme === 'dark' ? 'day' : 'dark'));
  document.addEventListener('tooltipeditor:font-face-loaded', () => { applyRenderingToDom(); renderFontList(); });
  document.addEventListener('tooltipeditor:font-face-failed', event => {
    const file = String(event?.detail?.path || '').split(/[\\/]/).filter(Boolean).pop() || '대표 글꼴';
    setErrorMessage(`대표 글꼴 로드 실패: ${file}`);
    renderFontList();
  });
  window.addEventListener('ttedit-document-view-synced', event => {
    if (event?.detail?.input === true) return;
    applyRenderingToDom();
    updateControlsFromRendering();
  });
  document.addEventListener('tooltipeditor:preferences-changed', event => {
    void (event?.detail);
    void loadFontRows().then(() => { applyRenderingToDom(); updateControlsFromRendering(); });
  });
}

export function initRenderingToolbar({ editorElement } = {}) {
  editorText = editorElement || document.getElementById('editorText');
  collectControls();
  initFontSizePresets();
  installEvents();
  document.documentElement.dataset.theme = getPreferences().themeMode === 'day' ? 'day' : 'dark';
  allFontRows = baseFontRows();
  filterFontRows();
  void loadFontRows().then(() => { applyRenderingToDom(); updateControlsFromRendering(); });
  applyRenderingToDom();
  updateControlsFromRendering();
}
