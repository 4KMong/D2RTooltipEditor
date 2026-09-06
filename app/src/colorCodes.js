import { state } from './state.js';
import { applyDocumentTextAction, captureDocumentSnapshot, measureEditorTextWidthForImeBand, refreshStatus, syncTextAreasFromState, normalizeOpenDocumentsExplicitDefaultRepresentation } from './syncViews.js';
import { normalizeNewlines } from './textCodec.js';
import { stripColorCodes as stripColorCodesForEditor, cleanupColorTokensFromRuns, isVisibleColorTargetChar, setRecognizedColorCodes } from './colorText.js';
import { parseRawCode, rawCodeToVisibleText, visibleOffsetToRawOffset, rawOffsetToVisibleOffset, applyColorToRawVisibleRange, activeColorAtVisibleOffset, rawCodeContainsZeroWidth2060 } from './rawCodeModel.js';
import { setStatusMessage } from './statusBar.js';
import { hasBlockingModal } from './modal.js';
import { getPreferences, setPreferences, getDefaultEditorCopyOptions, setEditorCopyOptions, resetEditorCopyOptionsToDefault } from './preferences.js';
import { getColorInputPolicy } from './colorInputPolicy.js';
import { isLargeTextModeActive, getLargeTextModeAnalysis } from './largeTextMode.js';
import { isLargeEditorViewportActive, isLargeEditorPointerSelectionActive, getLargeEditorViewportWindow, getLargeEditorNativeDocumentSelection } from './largeEditorViewport.js';
import { isDeveloperModeEnabled } from './developerMode.js';
import { translateRuntimeUiText } from './uiLanguageRuntime.js';
import { DEFAULT_COLOR_PALETTE, DEFAULT_COLOR_CODE, COLOR_PREFIX, getActiveColorPalette, getToolbarColorPalette, getColorByCode, getColorShortcutMaps, getColorFnShortcutMap, normalizeFnShortcut, colorShortcutDisplay, normalizeColorLinks } from './colorPalette.js';

const DEFAULT_COLOR = DEFAULT_COLOR_CODE;
export const COLOR_PALETTE = DEFAULT_COLOR_PALETTE;


function setRootDatasetValue(key, value) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (document.documentElement.dataset.developerMode !== 'true') return;
  const next = String(value ?? '');
  if (document.documentElement.dataset[key] !== next) document.documentElement.dataset[key] = next;
}

function setZeroWidthPresentState(present) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const next = present ? 'on' : 'off';
  if (document.documentElement.dataset.zeroWidthPresent === next) return;
  document.documentElement.dataset.zeroWidthPresent = next;
  try { window.dispatchEvent(new CustomEvent('ttedit-rendering-changed', { detail: { reason: 'zero-width-fallback-state' } })); } catch (_) {}
}

let editorElement = null;
let codeElement = null;
let colorLayer = null;
let colorLayerInner = null;
let toolbarRoot = null;
let optionToolbarRoot = null;
let hoveredColorCode = '';
let colorChipDrag = null;
let suppressNextColorChipClick = false;
let newInputDefaultColorToggle = null;
let zeroWidthFallbackToolbarToggle = null;
let codePaneExplicitDefaultColorToggle = null;
let copyIncludeColorToggle = null;
let copyLineBreakLiteralToggle = null;
let copyUnicodeToggle = null;
let copyUnicodeModeSelect = null;
let copyIncludeColorText = null;
let copyLineBreakText = null;
let colorShortcutInstalled = false;
let editorPointerAnchorOffset = null;
let editorPointerCorrectionEnabled = false;
let editorPointerDragging = false;
let editorSurfaceMeasureCache = null;
let lastCursorWrapSnapshot = null;
let copiedFontColorCode = '';
const EDITOR_SURFACE_SELECTION_MEASURE_LIMIT = 60000;
const HEAVY_OVERLAY_RUN_LIMIT = 1200;
const HEAVY_OVERLAY_RAW_LENGTH = 80000;
const HARD_OVERLAY_RUN_LIMIT = 5200;
const HARD_OVERLAY_RAW_LENGTH = 260000;
const HEAVY_OVERLAY_FULL_RENDER_IDLE_MS = 420;
const QUICK_OVERLAY_FULL_RENDER_IDLE_MS = 90;
const PASTE_OVERLAY_FULL_RENDER_IDLE_MS = 320;
const HARD_OVERLAY_FULL_RENDER_IDLE_MS = 720;
const LARGE_VIEWPORT_OVERLAY_OVERSCAN_LINES = 80;
const LARGE_VIEWPORT_OVERLAY_MIN_LINES = 80;
let overlayRenderRaf = 0;
let overlayFullRenderTimer = 0;
let pendingOverlayRenderOptions = null;
let lastOverlayPaint = { rawCode: null, mode: null, paletteKey: null, wrap: null, viewportKey: null };
let pointerDeferredOverlayOptions = null;
let pointerDeferredImeFinishReason = '';

function rememberPointerDeferredOverlay(options = {}) {
  const prior = pointerDeferredOverlayOptions || {};
  pointerDeferredOverlayOptions = {
    deferHeavy: prior.deferHeavy !== false && options.deferHeavy !== false,
    preferFull: prior.preferFull === true || options.preferFull === true,
    fullDelayMs: Math.min(
      Number.isFinite(prior.fullDelayMs) ? prior.fullDelayMs : HEAVY_OVERLAY_FULL_RENDER_IDLE_MS,
      Number.isFinite(options.fullDelayMs) ? options.fullDelayMs : HEAVY_OVERLAY_FULL_RENDER_IDLE_MS,
    ),
    renderPolicy: options.renderPolicy || prior.renderPolicy || 'pointer-deferred',
  };
  setRootDatasetValue('editorOverlayPointerDeferred', pointerDeferredOverlayOptions.renderPolicy);
}

function flushPointerDeferredOverlay(reason = 'pointer-release') {
  if (isLargeEditorPointerSelectionActive()) return false;
  const finishReason = pointerDeferredImeFinishReason;
  const overlayOptions = pointerDeferredOverlayOptions;
  if (!finishReason && !overlayOptions) return false;
  pointerDeferredImeFinishReason = '';
  pointerDeferredOverlayOptions = null;
  setRootDatasetValue('editorOverlayPointerDeferred', 'flush');
  requestAnimationFrame(() => {
    if (isLargeEditorPointerSelectionActive()) {
      if (finishReason) pointerDeferredImeFinishReason = finishReason;
      if (overlayOptions) rememberPointerDeferredOverlay(overlayOptions);
      return;
    }
    if (finishReason && largeImeDirectTextOverlayActive) {
      finishLargeImeDirectTextOverlay(`pointer-release:${finishReason}`);
      return;
    }
    if (overlayOptions) {
      renderOverlay({ ...overlayOptions, renderPolicy: overlayOptions.renderPolicy || `pointer-release:${reason}` });
    }
  });
  return true;
}

function rawColorAt(text, index) {
  return String(text || '').startsWith(COLOR_PREFIX, index) && index + 2 < String(text || '').length ? String(text).slice(index, index + 3) : null;
}

function isColorAt(text, index) {
  const code = rawColorAt(text, index);
  return !!code && !!getColorByCode(code, getPreferences());
}

function colorAt(text, index) {
  return isColorAt(text, index) ? rawColorAt(text, index) : null;
}

function syncRecognizedColorCodes() {
  setRecognizedColorCodes(getActiveColorPalette(getPreferences()).map(item => item.code));
}

function colorHex(code) {
  return getColorByCode(code, getPreferences())?.hex || getColorByCode(DEFAULT_COLOR, getPreferences())?.hex || '#FFFFFF';
}

function overlayPaletteSignature() {
  return getActiveColorPalette(getPreferences()).map(item => `${item.code}:${item.hex}`).join('|');
}

function invalidateOverlayPaintCache() {
  lastOverlayPaint = { rawCode: null, mode: null, paletteKey: null, wrap: null, viewportKey: null };
}

function colorCodeLabel(code) { return code; }
function colorCodeSuffix(code) { return String(code || '').slice(2); }


function htmlEscape(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}


const EDITOR_SURFACE_METRIC_PROPERTIES = [
  'box-sizing',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch',
  'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-indent', 'text-rendering', 'text-transform',
  'white-space', 'overflow-wrap', 'word-break', 'tab-size',
  'direction', 'unicode-bidi',
  'font-kerning', 'font-variant-ligatures', 'font-variant-caps',
  'font-feature-settings', 'font-variation-settings',
  'font-optical-sizing', 'font-size-adjust',
  '-webkit-font-smoothing',
];

function syncOverlayMetrics() {
  if (!editorElement || !colorLayerInner || typeof getComputedStyle !== 'function') return;
  const cs = getComputedStyle(editorElement);
  for (const prop of EDITOR_SURFACE_METRIC_PROPERTIES) {
    const value = cs.getPropertyValue(prop);
    if (value) colorLayerInner.style.setProperty(prop, value);
  }

  // The overlay has no native textarea scrollbar, so `inset:0` makes its
  // wrapping area wider than the textarea content box by the scrollbar gutter
  // on Windows. Long soft-wrapped rows then break at different offsets, which
  // is exactly what causes width-dependent cursor drift and row merging.
  const editorClientWidth = Math.max(0, Number(editorElement.clientWidth) || 0);
  const editorClientHeight = Math.max(0, Number(editorElement.clientHeight) || 0);
  if (editorClientWidth > 0) {
    const widthPx = `${editorClientWidth}px`;
    colorLayerInner.style.width = widthPx;
    colorLayerInner.style.minWidth = widthPx;
    colorLayerInner.style.maxWidth = widthPx;
  }
  if (editorClientHeight > 0) {
    const heightPx = `${editorClientHeight + Math.max(editorElement.scrollHeight - editorClientHeight, 0)}px`;
    colorLayerInner.style.minHeight = heightPx;
  }
  setRootDatasetValue('editorSurfaceMetrics', 'synced');
  setRootDatasetValue('editorSurfaceWidthLock', editorClientWidth > 0 ? 'client-width' : 'none');
  setRootDatasetValue('editorSurfaceWidthDelta', String(Math.round(((colorLayerInner.clientWidth || 0) - editorClientWidth) * 100) / 100));
}

function isWhitespaceChar(ch) { return !isVisibleColorTargetChar(ch); }

export function stripColorCodes(text) { return stripColorCodesForEditor(text); }

function activeColorAt(documentText, offset) {
  const text = String(documentText ?? '');
  const end = Math.max(0, Math.min(Number(offset) || 0, text.length));
  let active = DEFAULT_COLOR;
  for (let i = 0; i < end; i++) {
    if (isColorAt(text, i)) {
      active = colorAt(text, i) || active;
      i += 2;
    }
  }
  return active;
}

function snapPositionOutOfColorToken(text, pos, direction = 'start') {
  const source = String(text ?? '');
  let p = Math.max(0, Math.min(Number(pos) || 0, source.length));
  for (let i = Math.max(0, p - 2); i <= p; i++) {
    if (i >= 0 && isColorAt(source, i) && p > i && p < i + 3) return direction === 'end' ? i + 3 : i;
  }
  return p;
}

function suffixHasExplicitColorBeforeTarget(suffix) {
  const text = String(suffix ?? '');
  for (let i = 0; i < text.length; i++) {
    if (isColorAt(text, i)) return true;
    if (!isWhitespaceChar(text[i])) return false;
  }
  return false;
}

function leadingWhitespaceLength(text) {
  const source = String(text ?? '');
  let n = 0;
  while (n < source.length && isWhitespaceChar(source[n])) n++;
  return n;
}

function hasVisibleTarget(text) {
  const stripped = stripColorCodes(text);
  return /\S/.test(stripped);
}

export function cleanupColorCodes(documentText) {
  return cleanupColorTokensFromRuns(documentText);
}


function expectedEditorVisibleText() {
  return rawCodeToVisibleText(state.rawCode || '');
}

function updateOverlayTextConsistencyMarker() {
  if (!editorElement || !colorLayerInner) return;
  if (document.documentElement?.dataset.developerMode !== 'true') return;
  const actual = normalizeNewlines(editorElement.value || '');
  if (isLargeEditorViewportActive()) {
    colorLayerInner.dataset.overlayTextConsistent = 'viewport-window';
    setRootDatasetValue('editorOverlayTextConsistency', 'viewport-window');
    return;
  }
  const rawParseBypassed = colorLayerInner.dataset.rawParseBypass === 'on';
  const expected = rawParseBypassed ? actual : expectedEditorVisibleText();
  if (colorLayerInner.dataset.viewportOverlay === 'on') {
    setRootDatasetValue('editorOverlayTextMatch', actual === expected ? 'viewport-partial' : 'no');
    return;
  }
  const overlay = normalizeNewlines(colorLayerInner.textContent || '');
  const overlayText = expected.length ? overlay : overlay.replace(/\u00a0/g, '');
  setRootDatasetValue('editorOverlayTextMatch', actual === expected && overlayText === expected ? 'yes' : 'no');
}

function clearEditorSurfaceMeasureCache() {
  editorSurfaceMeasureCache = null;
}

function editorSurfaceMeasureKey(expected) {
  if (!editorElement || !colorLayerInner) return '';
  const er = editorElement.getBoundingClientRect();
  const cr = colorLayerInner.getBoundingClientRect();
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(editorElement) : null;
  return [
    expected,
    editorElement.scrollLeft || 0,
    editorElement.scrollTop || 0,
    editorElement.clientWidth || 0,
    editorElement.clientHeight || 0,
    Math.round(er.left * 100) / 100,
    Math.round(er.top * 100) / 100,
    Math.round(cr.left * 100) / 100,
    Math.round(cr.top * 100) / 100,
    cs?.fontFamily || '',
    cs?.fontSize || '',
    cs?.lineHeight || '',
    cs?.letterSpacing || '',
    cs?.wordSpacing || '',
    cs?.whiteSpace || '',
    cs?.overflowWrap || '',
    cs?.wordBreak || '',
  ].join('|');
}

function pointerInEditorContent(event) {
  if (!editorElement || !event) return false;
  const rect = editorElement.getBoundingClientRect();
  const x = Number(event.clientX);
  const y = Number(event.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const right = rect.left + editorElement.clientWidth;
  const bottom = rect.top + editorElement.clientHeight;
  return x >= rect.left && x <= right && y >= rect.top && y <= bottom;
}

function shouldCorrectEditorPointer(event) {
  if (isLargeTextModeActive()) {
    setRootDatasetValue('editorPointerCorrectionReason', 'large-text-native-textarea');
    return false;
  }
  if (!event || event.button !== 0) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (event.detail && event.detail > 1) return false;
  return pointerInEditorContent(event);
}


function collectOverlayCharacterRects() {
  if (!colorLayerInner || !editorElement) return [];
  const doc = colorLayerInner.ownerDocument || document;
  const win = doc.defaultView || window;
  const SHOW_TEXT = win.NodeFilter?.SHOW_TEXT || 4;
  const walker = doc.createTreeWalker(colorLayerInner, SHOW_TEXT);
  const range = doc.createRange();
  const rects = [];
  let visibleOffset = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue || '';
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      for (const rect of Array.from(range.getClientRects())) {
        if (!rect || (rect.width === 0 && rect.height === 0)) continue;
        rects.push({
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          before: visibleOffset + i,
          after: visibleOffset + i + 1,
        });
      }
    }
    visibleOffset += text.length;
    node = walker.nextNode();
  }
  try { range.detach?.(); } catch (_) {}
  return rects;
}

function groupOverlayCharacterRows(charRects) {
  const rows = [];
  const sorted = [...(charRects || [])].sort((a, b) => ((a.top + a.bottom) / 2) - ((b.top + b.bottom) / 2) || a.left - b.left || a.before - b.before);
  for (const item of sorted) {
    const mid = (item.top + item.bottom) / 2;
    let row = rows.find(r => Math.abs(r.midY - mid) <= Math.max(2, r.height * 0.55, (item.bottom - item.top) * 0.55));
    if (!row) {
      row = { top: item.top, right: item.right, bottom: item.bottom, left: item.left, midY: mid, height: Math.max(1, item.bottom - item.top), start: item.before, end: item.after, items: [] };
      rows.push(row);
    }
    row.items.push(item);
    row.top = Math.min(row.top, item.top);
    row.right = Math.max(row.right, item.right);
    row.bottom = Math.max(row.bottom, item.bottom);
    row.left = Math.min(row.left, item.left);
    row.height = Math.max(1, row.bottom - row.top);
    row.midY = (row.top + row.bottom) / 2;
    row.start = Math.min(row.start, item.before);
    row.end = Math.max(row.end, item.after);
  }
  for (const row of rows) row.items.sort((a, b) => a.left - b.left || a.before - b.before);
  rows.sort((a, b) => a.midY - b.midY || a.start - b.start);
  return rows;
}

function getOverlaySurfaceMeasurement(expected) {
  if (!editorElement || !colorLayerInner) return null;
  const text = String(expected ?? expectedEditorVisibleText());
  if (!text.length) return { text, charRects: [], rows: [], mode: 'empty' };
  if (isLargeTextModeActive()) {
    setRootDatasetValue('editorOverlayMeasureMode', 'large-text-native');
    return null;
  }
  if (text.length > EDITOR_SURFACE_SELECTION_MEASURE_LIMIT) {
    setRootDatasetValue('editorOverlayMeasureMode', 'fallback-length-limit');
    return null;
  }
  syncOverlayMetrics();
  const key = editorSurfaceMeasureKey(text);
  if (editorSurfaceMeasureCache?.key === key) return editorSurfaceMeasureCache.measurement;
  const charRects = collectOverlayCharacterRects();
  const rows = augmentRowsWithExplicitEmptyLines(groupOverlayCharacterRows(charRects), text);
  const measurement = { text, charRects, rows, mode: 'range', key };
  editorSurfaceMeasureCache = { key, measurement };
  setRootDatasetValue('editorOverlayMeasureMode', rows.length ? 'range' : 'none');
  setRootDatasetValue('editorSurfaceRowCount', String(rows.length));
  return measurement;
}

function isZeroWidthSurfaceItem(item) {
  if (!item) return false;
  return Math.abs((Number(item.right) || 0) - (Number(item.left) || 0)) <= 0.5;
}

function advanceZeroWidthFollowers(row, offset) {
  if (!row?.items?.length) return offset;
  let next = offset;
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of row.items) {
      if (item.before === next && item.after > next && isZeroWidthSurfaceItem(item)) {
        next = item.after;
        changed = true;
      }
    }
  }
  return next;
}

function rowNonZeroItems(row) {
  return (row?.items || []).filter(item => !isZeroWidthSurfaceItem(item));
}

function offsetFromRowX(row, x, max) {
  if (!row?.items?.length) {
    if (row?.emptyLine) return Math.max(0, Math.min(row.start ?? 0, max));
    return null;
  }
  const measurableItems = rowNonZeroItems(row);
  const items = measurableItems.length ? measurableItems : row.items;
  const first = items[0];
  const last = items[items.length - 1];
  if (x <= first.left) return Math.max(0, Math.min(first.before, max));
  if (x >= last.right) return Math.max(0, Math.min(row.end ?? advanceZeroWidthFollowers(row, last.after), max));
  for (const item of items) {
    if (x >= item.left && x <= item.right) {
      const midX = (item.left + item.right) / 2;
      const offset = x < midX ? item.before : advanceZeroWidthFollowers(row, item.after);
      return Math.max(0, Math.min(offset, max));
    }
  }
  let nearest = null;
  for (const item of items) {
    const beforeDistance = Math.abs(x - item.left);
    const afterDistance = Math.abs(x - item.right);
    if (!nearest || beforeDistance < nearest.distance) nearest = { distance: beforeDistance, offset: item.before };
    if (!nearest || afterDistance < nearest.distance) nearest = { distance: afterDistance, offset: advanceZeroWidthFollowers(row, item.after) };
  }
  return nearest ? Math.max(0, Math.min(nearest.offset, max)) : null;
}


function compactNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function classifyRowX(row, x) {
  if (!row?.items?.length) return row?.emptyLine ? 'empty-line' : 'no-items';
  const first = row.items[0];
  const last = row.items[row.items.length - 1];
  if (x <= first.left) return 'before-row-left';
  if (x >= last.right) return 'after-row-right';
  for (const item of row.items) {
    if (x >= item.left && x <= item.right) return 'inside-char';
  }
  return 'between-chars';
}

function nearestRowItem(row, x) {
  if (!row?.items?.length) return null;
  let best = null;
  for (const item of row.items) {
    const mid = (item.left + item.right) / 2;
    const d = Math.abs(x - mid);
    if (!best || d < best.distance) {
      best = {
        distance: d,
        before: item.before,
        after: item.after,
        left: item.left,
        right: item.right,
        mid,
      };
    }
  }
  if (!best) return null;
  return {
    before: best.before,
    after: best.after,
    left: compactNumber(best.left),
    right: compactNumber(best.right),
    mid: compactNumber(best.mid),
    distance: compactNumber(best.distance),
  };
}

function setCursorWrapDiagnostics(snapshot) {
  const root = document.documentElement;
  if (!snapshot) return;
  lastCursorWrapSnapshot = snapshot;
  const simple = {
    mode: snapshot.mode,
    reason: snapshot.reason,
    clientX: snapshot.clientX,
    clientY: snapshot.clientY,
    offset: snapshot.offset,
    rowIndex: snapshot.rowIndex,
    rowStart: snapshot.rowStart,
    rowEnd: snapshot.rowEnd,
    rowXClass: snapshot.rowXClass,
    rowRightGap: snapshot.rowRightGap,
    rowLeftGap: snapshot.rowLeftGap,
    rowItemCount: snapshot.rowItemCount,
    rowZeroWidthItems: snapshot.rowZeroWidthItems,
    rowCount: snapshot.rowCount,
    syntheticRows: snapshot.syntheticRows,
    explicitLineCount: snapshot.explicitLineCount,
    visibleLength: snapshot.visibleLength,
    editorClientWidth: snapshot.editorClientWidth,
    overlayClientWidth: snapshot.overlayClientWidth,
    editorScrollTop: snapshot.editorScrollTop,
    editorScrollLeft: snapshot.editorScrollLeft,
  };
  for (const [key, value] of Object.entries(simple)) {
    if (value !== null && value !== undefined) root.dataset[`editorCursor${key[0].toUpperCase()}${key.slice(1)}`] = String(value);
  }
  try {
    const win = window;
    const api = win.TTE_CURSOR_DEBUG || { history: [] };
    api.last = snapshot;
    api.history = Array.isArray(api.history) ? api.history : [];
    api.history.push(snapshot);
    if (api.history.length > 25) api.history.shift();
    api.copyLast = () => JSON.stringify(api.last || null, null, 2);
    api.copyHistory = () => JSON.stringify(api.history || [], null, 2);
    win.TTE_CURSOR_DEBUG = api;
    if (root.dataset.editorCursorDebugConsole === 'on') {
      console.info('[TTE cursor debug]', snapshot);
    }
  } catch (_) {}
}

function buildCursorWrapSnapshot({ eventX, eventY, expected, measurement, rows, row, rowIndex, offset, reason }) {
  const editorRect = editorElement?.getBoundingClientRect?.();
  const overlayRect = colorLayerInner?.getBoundingClientRect?.();
  const lineMetrics = getEditorLineMetrics();
  const syntheticRows = rows ? rows.filter(r => r.synthetic).length : 0;
  const xClass = classifyRowX(row, eventX);
  const nearest = nearestRowItem(row, eventX);
  const zeroWidthItems = row?.items?.filter(isZeroWidthSurfaceItem).length || 0;
  return {
    mode: measurement?.mode || 'none',
    reason: reason || '',
    clientX: compactNumber(eventX),
    clientY: compactNumber(eventY),
    offset,
    visibleLength: String(expected || '').length,
    rowIndex,
    rowCount: rows?.length || 0,
    rowStart: row?.start ?? null,
    rowEnd: row?.end ?? null,
    rowTop: compactNumber(row?.top),
    rowBottom: compactNumber(row?.bottom),
    rowMidY: compactNumber(row?.midY),
    rowLeft: compactNumber(row?.left),
    rowRight: compactNumber(row?.right),
    rowLeftGap: row ? compactNumber(eventX - row.left) : null,
    rowRightGap: row ? compactNumber(eventX - row.right) : null,
    rowXClass: xClass,
    rowItemCount: row?.items?.length || 0,
    rowZeroWidthItems: zeroWidthItems,
    rowSynthetic: row?.synthetic === true ? 'yes' : 'no',
    rowEmptyLine: row?.emptyLine === true ? 'yes' : 'no',
    nearestItem: nearest,
    charRectCount: measurement?.charRects?.length || 0,
    syntheticRows,
    explicitLineCount: explicitLineRanges(expected).length,
    editorClientWidth: editorElement?.clientWidth || 0,
    editorClientHeight: editorElement?.clientHeight || 0,
    editorScrollTop: editorElement?.scrollTop || 0,
    editorScrollLeft: editorElement?.scrollLeft || 0,
    editorRectLeft: compactNumber(editorRect?.left),
    editorRectTop: compactNumber(editorRect?.top),
    editorRectRight: compactNumber(editorRect?.right),
    editorRectBottom: compactNumber(editorRect?.bottom),
    overlayClientWidth: colorLayerInner?.clientWidth || 0,
    overlayScrollWidth: colorLayerInner?.scrollWidth || 0,
    overlayRectLeft: compactNumber(overlayRect?.left),
    overlayRectTop: compactNumber(overlayRect?.top),
    overlayRectRight: compactNumber(overlayRect?.right),
    overlayRectBottom: compactNumber(overlayRect?.bottom),
    lineHeight: compactNumber(lineMetrics?.lineHeight),
    paddingTop: compactNumber(lineMetrics?.paddingTop),
    paddingLeft: compactNumber(lineMetrics?.paddingLeft),
  };
}

function getEditorLineMetrics() {
  if (!editorElement) return null;
  const rect = editorElement.getBoundingClientRect();
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(editorElement) : null;
  const fontSize = Number.parseFloat(cs?.fontSize || '') || 14;
  const lineHeight = Number.parseFloat(cs?.lineHeight || '') || fontSize * 1.35;
  const paddingTop = Number.parseFloat(cs?.paddingTop || '') || 0;
  const paddingLeft = Number.parseFloat(cs?.paddingLeft || '') || 0;
  return { rect, lineHeight: Math.max(1, lineHeight), paddingTop, paddingLeft };
}

function explicitLineRanges(text) {
  const source = String(text ?? '');
  const ranges = [];
  let start = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === '\n') {
      ranges.push({ line: ranges.length, start, end: i, empty: start === i });
      start = i + 1;
    }
  }
  return ranges.length ? ranges : [{ line: 0, start: 0, end: 0, empty: true }];
}

function rowTouchesExplicitLine(row, line) {
  if (!row || !line || !row.items?.length || line.empty) return false;
  return row.items.some(item => item.before >= line.start && item.before < line.end);
}

function augmentRowsWithExplicitEmptyLines(rows, text) {
  const baseRows = [...(rows || [])].sort((a, b) => a.midY - b.midY || a.start - b.start);
  const metrics = getEditorLineMetrics();
  if (!metrics) return baseRows;
  const lines = explicitLineRanges(text);
  const out = [];
  let previousVisualTop = metrics.rect.top + metrics.paddingTop - (editorElement?.scrollTop || 0) - metrics.lineHeight;
  let syntheticCount = 0;

  for (const line of lines) {
    const lineRows = baseRows.filter(row => rowTouchesExplicitLine(row, line));
    if (lineRows.length) {
      out.push(...lineRows);
      previousVisualTop = lineRows[lineRows.length - 1].top;
      continue;
    }
    if (!line.empty) continue;
    const top = previousVisualTop + metrics.lineHeight;
    const row = {
      top,
      bottom: top + metrics.lineHeight,
      midY: top + metrics.lineHeight / 2,
      height: metrics.lineHeight,
      left: metrics.rect.left + metrics.paddingLeft,
      right: metrics.rect.left + metrics.paddingLeft,
      start: line.start,
      end: line.end,
      items: [],
      emptyLine: true,
      synthetic: true,
    };
    out.push(row);
    previousVisualTop = top;
    syntheticCount += 1;
  }

  out.sort((a, b) => a.midY - b.midY || a.start - b.start);
  setRootDatasetValue('editorSurfaceSyntheticRows', String(syntheticCount));
  return out;
}


function overlayEditorOffsetFromPoint(clientX, clientY) {
  if (!editorElement || !colorLayerInner) return null;
  const expected = expectedEditorVisibleText();
  const editorValue = normalizeNewlines(editorElement.value || '');
  if (editorValue !== expected) return null;
  if (!expected.length) {
    setCursorWrapDiagnostics({ mode: 'empty', reason: 'empty-text', clientX: compactNumber(clientX), clientY: compactNumber(clientY), offset: 0, visibleLength: 0 });
    return 0;
  }
  const x = Number(clientX);
  const y = Number(clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const measurement = getOverlaySurfaceMeasurement(expected);
  if (!measurement?.rows?.length) {
    setCursorWrapDiagnostics(buildCursorWrapSnapshot({ eventX: x, eventY: y, expected, measurement, rows: [], row: null, rowIndex: -1, offset: null, reason: 'native-no-measured-rows' }));
    return null;
  }
  const rows = measurement.rows;
  const max = editorValue.length;

  let row = null;
  let rowIndex = -1;
  let rowReason = 'direct-row-hit';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (y >= r.top && y <= r.bottom) { row = r; rowIndex = i; break; }
  }
  if (!row) {
    for (let i = 0; i < rows.length - 1; i++) {
      const upper = rows[i];
      const lower = rows[i + 1];
      if (y > upper.bottom && y < lower.top) {
        const gap = lower.top - upper.bottom;
        const threshold = Math.max(3, Math.min(upper.height, lower.height) * 0.35);
        if (gap > threshold) {
          const useUpper = (y - upper.bottom) < (lower.top - y);
          row = useUpper ? upper : lower;
          rowIndex = useUpper ? i : i + 1;
          rowReason = 'gap-nearest-row';
        } else {
          const useUpper = Math.abs(y - upper.midY) <= Math.abs(y - lower.midY);
          row = useUpper ? upper : lower;
          rowIndex = useUpper ? i : i + 1;
          rowReason = 'tight-gap-nearest-mid';
        }
        break;
      }
    }
  }
  if (!row) {
    if (y < rows[0].top) { row = rows[0]; rowIndex = 0; rowReason = 'before-first-row'; }
    else if (y > rows[rows.length - 1].bottom) { row = rows[rows.length - 1]; rowIndex = rows.length - 1; rowReason = 'after-last-row'; }
  }
  if (!row) {
    setCursorWrapDiagnostics(buildCursorWrapSnapshot({ eventX: x, eventY: y, expected, measurement, rows, row: null, rowIndex: -1, offset: null, reason: 'native-no-row-selected' }));
    return null;
  }

  const got = offsetFromRowX(row, x, max);
  if (got === null || got === undefined) {
    setCursorWrapDiagnostics(buildCursorWrapSnapshot({ eventX: x, eventY: y, expected, measurement, rows, row, rowIndex, offset: null, reason: `${rowReason}:native-null-offset` }));
    return null;
  }
  setCursorWrapDiagnostics(buildCursorWrapSnapshot({ eventX: x, eventY: y, expected, measurement, rows, row, rowIndex, offset: got, reason: rowReason }));
  return got;
}

function shouldUseNativeRowEndAffinity(snapshot) {
  if (!snapshot || snapshot.mode !== 'range') return false;
  if (snapshot.rowEmptyLine === 'yes' || snapshot.rowSynthetic === 'yes') return false;
  if (snapshot.rowXClass === 'after-row-right') return true;
  const gap = Number(snapshot.rowRightGap);
  return Number.isFinite(gap) && gap > 0;
}

function setEditorSelectionFromSurface(anchor, focus) {
  if (!editorElement) return false;
  const a = Number(anchor);
  const f = Number(focus);
  if (!Number.isFinite(a) || !Number.isFinite(f)) return false;
  const max = editorElement.value.length;
  const start = Math.max(0, Math.min(Math.min(a, f), max));
  const end = Math.max(start, Math.min(Math.max(a, f), max));
  try {
    editorElement.focus({ preventScroll: true });
    editorElement.setSelectionRange(start, end, a <= f ? 'forward' : 'backward');
    editorElement.dispatchEvent(new Event('select', { bubbles: true }));
    return true;
  } catch (_) {
    return false;
  }
}

function setEditorPointerDiagnostics({ anchor = null, focus = null, nativeStart = null, nativeEnd = null, applied = false, reason = '' } = {}) {
  const root = document.documentElement;
  if (!root || root.dataset.developerMode !== 'true') return;
  if (anchor !== null && anchor !== undefined) setRootDatasetValue('editorPointerAnchor', anchor);
  if (focus !== null && focus !== undefined) setRootDatasetValue('editorPointerFocus', focus);
  if (nativeStart !== null && nativeStart !== undefined) setRootDatasetValue('editorPointerNativeStart', nativeStart);
  if (nativeEnd !== null && nativeEnd !== undefined) setRootDatasetValue('editorPointerNativeEnd', nativeEnd);
  if (anchor !== null && focus !== null && nativeStart !== null && nativeEnd !== null) {
    const expectedStart = Math.min(anchor, focus);
    const expectedEnd = Math.max(anchor, focus);
    setRootDatasetValue('editorPointerDelta', Math.max(Math.abs(expectedStart - nativeStart), Math.abs(expectedEnd - nativeEnd)));
  }
  setRootDatasetValue('editorPointerCorrection', applied ? 'applied' : 'skipped');
  if (reason) setRootDatasetValue('editorPointerCorrectionReason', reason);
}

function correctEditorSelectionFromPointerEvent(event, { final = false } = {}) {
  const anchor = editorPointerAnchorOffset;
  if (anchor === null || anchor === undefined) {
    setEditorPointerDiagnostics({ applied: false, reason: 'no-anchor' });
    return false;
  }
  if (!pointerInEditorContent(event)) {
    setEditorPointerDiagnostics({ anchor, applied: false, reason: 'outside-editor' });
    return false;
  }
  const focus = overlayEditorOffsetFromPoint(event.clientX, event.clientY);
  if (focus === null || focus === undefined) {
    setEditorPointerDiagnostics({ anchor, applied: false, reason: 'no-focus-offset' });
    return false;
  }
  const nativeStart = editorElement?.selectionStart ?? 0;
  const nativeEnd = editorElement?.selectionEnd ?? nativeStart;
  const apply = () => {
    const ok = setEditorSelectionFromSurface(anchor, focus);
    setEditorPointerDiagnostics({ anchor, focus, nativeStart, nativeEnd, applied: ok, reason: final ? 'pointerup-final' : 'pointermove' });
  };
  if (final) requestAnimationFrame(apply);
  else apply();
  return true;
}

function handleEditorPointerDownForSurfaceSelection(event) {
  editorPointerAnchorOffset = null;
  editorPointerDragging = false;
  if (!shouldCorrectEditorPointer(event)) return;
  editorPointerAnchorOffset = overlayEditorOffsetFromPoint(event.clientX, event.clientY);
  if (shouldUseNativeRowEndAffinity(lastCursorWrapSnapshot)) {
    editorPointerAnchorOffset = null;
    setEditorPointerDiagnostics({ applied: false, reason: 'row-end-native-affinity' });
    return;
  }
  editorPointerDragging = editorPointerAnchorOffset !== null && editorPointerAnchorOffset !== undefined;
  if (editorPointerDragging) {
    event.preventDefault();
    setEditorSelectionFromSurface(editorPointerAnchorOffset, editorPointerAnchorOffset);
    setEditorPointerDiagnostics({ anchor: editorPointerAnchorOffset, focus: editorPointerAnchorOffset, applied: true, reason: 'pointerdown-anchor' });
  } else {
    setEditorPointerDiagnostics({ applied: false, reason: 'pointerdown-no-offset' });
  }
}

function handleEditorPointerMoveForSurfaceSelection(event) {
  if (!editorPointerDragging || !(event.buttons & 1)) return;
  correctEditorSelectionFromPointerEvent(event);
}

function handleEditorPointerUpForSurfaceSelection(event) {
  const hadAnchor = editorPointerAnchorOffset !== null && editorPointerAnchorOffset !== undefined;
  editorPointerDragging = false;
  if (!hadAnchor) return;
  correctEditorSelectionFromPointerEvent(event, { final: true });
  editorPointerAnchorOffset = null;
}

function handleEditorPointerCancelForSurfaceSelection() {
  editorPointerAnchorOffset = null;
  editorPointerDragging = false;
}

function installEditorSurfaceSelectionCorrection() {
  if (!editorElement || editorPointerCorrectionEnabled) return;
  editorPointerCorrectionEnabled = true;
  editorElement.addEventListener('mousedown', handleEditorPointerDownForSurfaceSelection);
  editorElement.addEventListener('mousemove', handleEditorPointerMoveForSurfaceSelection);
  editorElement.addEventListener('mouseup', handleEditorPointerUpForSurfaceSelection);
  editorElement.addEventListener('mouseleave', handleEditorPointerCancelForSurfaceSelection);
}

export function applyColorToDocumentRange(documentText, start, end, colorCode) {
  const color = getColorByCode(colorCode, getPreferences())?.code === colorCode ? colorCode : DEFAULT_COLOR;
  const original = normalizeNewlines(documentText);
  let s = snapPositionOutOfColorToken(original, start, 'start');
  let e = snapPositionOutOfColorToken(original, end, 'end');
  if (e < s) [s, e] = [e, s];
  if (e <= s) return { changed: false, text: cleanupColorCodes(original), caret: s, reason: 'empty' };

  const before = original.slice(0, s);
  const selectedRaw = original.slice(s, e);
  const after = original.slice(e);
  const selectedClean = stripColorCodes(selectedRaw);
  if (!hasVisibleTarget(selectedClean)) {
    const cleanedOnly = cleanupColorCodes(original);
    return { changed: cleanedOnly !== original, text: cleanedOnly, caret: s, reason: 'no-target' };
  }

  const leading = leadingWhitespaceLength(selectedClean);
  const selectedWithColor = selectedClean.slice(0, leading) + color + selectedClean.slice(leading);
  const restore = activeColorAt(original, e);
  const needsRestore = restore !== color && hasVisibleTarget(after) && !suffixHasExplicitColorBeforeTarget(after);
  const restoreOffsetInAfter = needsRestore ? leadingWhitespaceLength(after) : -1;
  const afterWithRestore = needsRestore ? after.slice(0, restoreOffsetInAfter) + restore + after.slice(restoreOffsetInAfter) : after;
  const next = cleanupColorCodes(before + selectedWithColor + afterWithRestore);
  const approxCaret = Math.min(next.length, before.length + selectedWithColor.length + (needsRestore ? restore.length : 0));
  return { changed: next !== original, text: next, caret: approxCaret, reason: 'applied' };
}

function isHeavyOverlayModel(model) {
  return model.rawLength >= HEAVY_OVERLAY_RAW_LENGTH || model.colorRuns.length >= HEAVY_OVERLAY_RUN_LIMIT;
}

function isHardOverlayModel(model) {
  return model.rawLength >= HARD_OVERLAY_RAW_LENGTH || model.colorRuns.length >= HARD_OVERLAY_RUN_LIMIT;
}

function overlayRenderOptionsFromReason(reason = '') {
  const text = String(reason || '');
  if (/색상 적용|색상변환|색상연결|rendering|렌더링|팔레트/.test(text)) {
    return { deferHeavy: true, preferFull: true, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, policy: 'prefer-full' };
  }
  if (/붙여넣기|paste|Paste/i.test(text)) {
    return { deferHeavy: true, preferFull: false, fullDelayMs: PASTE_OVERLAY_FULL_RENDER_IDLE_MS, policy: 'paste-deferred' };
  }
  if (/삭제|잘라내기|cut|delete/i.test(text)) {
    return { deferHeavy: true, preferFull: false, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, policy: 'delete-quick-restore' };
  }
  if (/수정|입력|typing|input/i.test(text)) {
    return { deferHeavy: true, preferFull: false, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, policy: 'edit-quick-restore' };
  }
  return { deferHeavy: true, preferFull: false, fullDelayMs: HEAVY_OVERLAY_FULL_RENDER_IDLE_MS, policy: 'default-deferred' };
}

function mergeOverlayRenderOptions(a = {}, b = {}) {
  const preferFull = a.preferFull === true || b.preferFull === true;
  const fullDelayMs = Math.min(
    Number.isFinite(a.fullDelayMs) ? a.fullDelayMs : HEAVY_OVERLAY_FULL_RENDER_IDLE_MS,
    Number.isFinite(b.fullDelayMs) ? b.fullDelayMs : HEAVY_OVERLAY_FULL_RENDER_IDLE_MS,
  );
  return {
    deferHeavy: a.deferHeavy !== false && b.deferHeavy !== false,
    preferFull,
    fullDelayMs,
    policy: b.policy || a.policy || 'merged',
  };
}

function cancelScheduledOverlayPaint({ cancelFull = false } = {}) {
  if (overlayRenderRaf) {
    try { cancelAnimationFrame(overlayRenderRaf); } catch (_) {}
    overlayRenderRaf = 0;
  }
  if (cancelFull && overlayFullRenderTimer) {
    clearTimeout(overlayFullRenderTimer);
    overlayFullRenderTimer = 0;
  }
}

function setOverlayRenderDiagnostics(model, mode, elapsedMs, policy = '') {
  setRootDatasetValue('editorOverlayRenderMode', mode);
  setRootDatasetValue('editorOverlayRunCount', model.colorRuns.length);
  setRootDatasetValue('editorOverlayRawLength', model.rawLength);
  setRootDatasetValue('editorOverlayVisibleLength', model.visibleLength);
  setRootDatasetValue('editorOverlayHard', isHardOverlayModel(model) ? 'yes' : 'no');
  if (policy) setRootDatasetValue('editorOverlayPolicy', policy);
  if (Number.isFinite(elapsedMs)) setRootDatasetValue('editorOverlayLastMs', elapsedMs.toFixed(1));
}

function lightweightOverlayHtml(model) {
  return lightweightOverlayHtmlFromVisible(model.visibleText);
}

function lightweightOverlayHtmlFromVisible(visibleText = '') {
  const text = normalizeNewlines(visibleText);
  if (!text) return '<span class="editor-color-text">&nbsp;</span>';
  return `<span class="editor-color-text" style="color:${colorHex(DEFAULT_COLOR)}">${htmlEscape(text)}</span>`;
}

function fullOverlayHtml(model) {
  const chunks = [];
  const hexCache = new Map();
  for (const run of model.colorRuns) {
    const text = model.visibleText.slice(run.visibleStart, run.visibleEnd);
    if (!text) continue;
    let hex = hexCache.get(run.color);
    if (!hex) {
      hex = colorHex(run.color);
      hexCache.set(run.color, hex);
    }
    chunks.push(`<span class="editor-color-text" style="color:${hex}">${htmlEscape(text)}</span>`);
  }
  return chunks.length ? chunks.join('') : '<span class="editor-color-text">&nbsp;</span>';
}

function editorLineHeightPx() {
  if (!editorElement || typeof getComputedStyle !== 'function') return 24;
  const cs = getComputedStyle(editorElement);
  const lineHeight = Number.parseFloat(cs.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = Number.parseFloat(cs.fontSize) || 16;
  return Math.max(1, fontSize * 1.45);
}

function lineOffsetAt(model, lineIndex) {
  const line = model.lineIndex[Math.max(0, Math.min(lineIndex, Math.max(0, model.lineIndex.length - 1)))];
  return Math.max(0, Math.min(line?.visibleOffset ?? 0, model.visibleLength));
}

function computeLargeViewportOverlayWindow(model) {
  const lineHeight = editorLineHeightPx();
  const lineCount = Math.max(1, model.lineIndex.length || 1);
  const scrollTop = Math.max(0, Number(editorElement?.scrollTop) || 0);
  const clientHeight = Math.max(lineHeight, Number(editorElement?.clientHeight) || lineHeight);
  const firstVisibleLine = Math.max(0, Math.floor(scrollTop / lineHeight));
  const visibleLineCapacity = Math.max(LARGE_VIEWPORT_OVERLAY_MIN_LINES, Math.ceil(clientHeight / lineHeight));
  const startLine = Math.max(0, firstVisibleLine - LARGE_VIEWPORT_OVERLAY_OVERSCAN_LINES);
  const endLine = Math.min(lineCount - 1, firstVisibleLine + visibleLineCapacity + LARGE_VIEWPORT_OVERLAY_OVERSCAN_LINES);
  const visibleStart = lineOffsetAt(model, startLine);
  const visibleEnd = endLine + 1 < lineCount ? lineOffsetAt(model, endLine + 1) : model.visibleLength;
  return {
    lineHeight,
    lineCount,
    firstVisibleLine,
    startLine,
    endLine,
    visibleStart,
    visibleEnd: Math.max(visibleStart, visibleEnd),
    key: `${startLine}:${endLine}:${visibleStart}:${visibleEnd}:${Math.round(lineHeight * 100) / 100}`,
  };
}

function viewportColorOverlayHtml(model, viewport) {
  if (!model.visibleText) return '<span class="editor-color-text">&nbsp;</span>';
  const rawStart = visibleOffsetToRawOffset(model, viewport.visibleStart, 'start');
  const rawEnd = visibleOffsetToRawOffset(model, viewport.visibleEnd, 'end');
  const inheritedColor = activeColorAtVisibleOffset(model, viewport.visibleStart);
  const rawFragment = model.rawCode.slice(rawStart, rawEnd);
  const fragmentModel = parseRawCode(`${inheritedColor}${rawFragment}`);
  const topHeight = Math.max(0, viewport.startLine * viewport.lineHeight);
  const renderedLineCount = Math.max(0, viewport.endLine - viewport.startLine + 1);
  const bottomLineCount = Math.max(0, viewport.lineCount - viewport.startLine - renderedLineCount);
  const bottomHeight = Math.max(0, bottomLineCount * viewport.lineHeight);
  const chunks = [];
  if (topHeight > 0) chunks.push(`<div class="editor-color-viewport-spacer" style="height:${topHeight}px"></div>`);
  chunks.push(fullOverlayHtml(fragmentModel));
  if (bottomHeight > 0) chunks.push(`<div class="editor-color-viewport-spacer" style="height:${bottomHeight}px"></div>`);
  return chunks.join('');
}



function scheduleHeavyOverlayFullRender(delayMs = HEAVY_OVERLAY_FULL_RENDER_IDLE_MS, policy = 'idle-full') {
  if (overlayFullRenderTimer) clearTimeout(overlayFullRenderTimer);
  const safeDelay = Math.max(0, Number.isFinite(delayMs) ? delayMs : HEAVY_OVERLAY_FULL_RENDER_IDLE_MS);
  setRootDatasetValue('editorOverlayFullDelayMs', safeDelay);
  overlayFullRenderTimer = setTimeout(() => {
    overlayFullRenderTimer = 0;
    renderOverlay({ deferHeavy: false, renderPolicy: policy });
  }, safeDelay);
}

function renderOverlay({ deferHeavy = false, preferFull = false, fullDelayMs = HEAVY_OVERLAY_FULL_RENDER_IDLE_MS, renderPolicy = '' } = {}) {
  if (!editorElement || !colorLayerInner) return;
  if (isLargeEditorPointerSelectionActive()) {
    // A native textarea drag must remain visually and structurally stable until
    // mouseup. Rebuilding the color DOM or switching the textarea back to
    // transparent text during that interval can make WebView2 drop or visually
    // erase the in-progress selection even though the document model is current.
    rememberPointerDeferredOverlay({ deferHeavy, preferFull, fullDelayMs, renderPolicy });
    return;
  }
  const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  syncOverlayMetrics();
  const wrap = editorElement.classList.contains('wrap-disabled') ? 'disabled' : 'enabled';
  colorLayerInner.classList.toggle('wrap-disabled', wrap === 'disabled');
  colorLayerInner.classList.toggle('wrap-enabled', wrap !== 'disabled');
  const largeMode = isLargeTextModeActive();
  const paletteKey = overlayPaletteSignature();

  if (largeMode && isLargeEditorViewportActive()) {
    cancelScheduledOverlayPaint({ cancelFull: true });
    const viewport = getLargeEditorViewportWindow();
    const visibleFragment = normalizeNewlines(viewport.text || '');
    const mode = 'large-editor-window-color';
    const viewportKey = `${viewport.start}:${viewport.end}:${viewport.startLine}:${viewport.endLine}`;
    const model = parseRawCode(state.rawCode || '');
    const rawStart = visibleOffsetToRawOffset(model, viewport.start, 'start');
    const rawEnd = visibleOffsetToRawOffset(model, viewport.end, 'end');
    const inheritedColor = activeColorAtVisibleOffset(model, viewport.start);
    const rawFragment = model.rawCode.slice(rawStart, rawEnd);
    const fragmentModel = parseRawCode(`${inheritedColor}${rawFragment}`);
    const diagnosticModel = model;
    const html = fullOverlayHtml(fragmentModel);
    // Color application can change only raw color codes while leaving the visible
    // window text exactly the same. Cache by the raw fragment as well, or the old
    // colored HTML is incorrectly reused and the application looks like a no-op.
    const paintSignature = `${inheritedColor}|${rawFragment}`;
    const samePaint = lastOverlayPaint.rawCode === paintSignature
      && lastOverlayPaint.mode === mode
      && lastOverlayPaint.paletteKey === paletteKey
      && lastOverlayPaint.wrap === wrap
      && lastOverlayPaint.viewportKey === viewportKey;
    if (!samePaint) {
      colorLayerInner.dataset.viewportOverlay = 'on';
      colorLayerInner.dataset.rawParseBypass = 'off';
      colorLayerInner.innerHTML = html;
      lastOverlayPaint = { rawCode: paintSignature, mode, paletteKey, wrap, viewportKey };
      clearEditorSurfaceMeasureCache();
    }
    colorLayerInner.style.width = '100%';
    colorLayerInner.style.minWidth = '100%';
    colorLayerInner.style.maxWidth = '100%';
    colorLayerInner.style.minHeight = '100%';
    colorLayerInner.style.transform = 'none';
    const policy = getColorInputPolicy();
    setZeroWidthPresentState(policy.zeroWidthFallbackEnabled && rawCodeContainsZeroWidth2060(model.rawCode));
    const endedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    setOverlayRenderDiagnostics(diagnosticModel, samePaint ? `${mode}-cached` : mode, endedAt - startedAt, `large:${getLargeTextModeAnalysis().reason}:editor-window`);
    updateOverlayTextConsistencyMarker();
    return;
  }

  const model = parseRawCode(state.rawCode || '');
  const policy = getColorInputPolicy();
  setZeroWidthPresentState(policy.zeroWidthFallbackEnabled && rawCodeContainsZeroWidth2060(model.rawCode));
  const heavy = isHeavyOverlayModel(model);
  const hard = isHardOverlayModel(model);
  if (!deferHeavy || largeMode) cancelScheduledOverlayPaint({ cancelFull: true });
  const shouldDefer = heavy && deferHeavy && !(preferFull && !hard);
  const mode = largeMode ? 'large-color-viewport' : shouldDefer ? 'lightweight-deferred' : 'full';
  const viewport = mode === 'large-color-viewport' ? computeLargeViewportOverlayWindow(model) : null;
  const viewportKey = viewport?.key || '';
  const samePaint = lastOverlayPaint.rawCode === model.rawCode
    && lastOverlayPaint.mode === mode
    && lastOverlayPaint.paletteKey === paletteKey
    && lastOverlayPaint.wrap === wrap
    && lastOverlayPaint.viewportKey === viewportKey;
  if (!samePaint) {
    colorLayerInner.dataset.viewportOverlay = mode === 'large-color-viewport' ? 'on' : 'off';
    colorLayerInner.dataset.rawParseBypass = 'off';
    colorLayerInner.innerHTML = mode === 'large-color-viewport' ? viewportColorOverlayHtml(model, viewport) : mode === 'lightweight-deferred' ? lightweightOverlayHtml(model) : fullOverlayHtml(model);
    lastOverlayPaint = { rawCode: model.rawCode, mode, paletteKey, wrap, viewportKey };
    clearEditorSurfaceMeasureCache();
  }
  if (samePaint && colorLayerInner.dataset.viewportOverlay !== (mode === 'large-color-viewport' ? 'on' : 'off')) {
    colorLayerInner.dataset.viewportOverlay = mode === 'large-color-viewport' ? 'on' : 'off';
  }
  if (samePaint && colorLayerInner.dataset.rawParseBypass !== 'off') colorLayerInner.dataset.rawParseBypass = 'off';
  if (mode === 'large-color-viewport') {
    if (overlayFullRenderTimer) { clearTimeout(overlayFullRenderTimer); overlayFullRenderTimer = 0; }
  } else if (mode === 'lightweight-deferred') scheduleHeavyOverlayFullRender(hard ? HARD_OVERLAY_FULL_RENDER_IDLE_MS : fullDelayMs, renderPolicy || (hard ? 'hard-deferred' : 'deferred'));
  else if (overlayFullRenderTimer) { clearTimeout(overlayFullRenderTimer); overlayFullRenderTimer = 0; }
  const endedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const largePolicy = largeMode ? `large:${getLargeTextModeAnalysis().reason}:color-viewport` : '';
  if (viewport) {
    setRootDatasetValue('editorOverlayViewportStartLine', viewport.startLine + 1);
    setRootDatasetValue('editorOverlayViewportEndLine', viewport.endLine + 1);
    setRootDatasetValue('editorOverlayViewportFirstVisibleLine', viewport.firstVisibleLine + 1);
  }
  setOverlayRenderDiagnostics(model, samePaint ? `${mode}-cached` : mode, endedAt - startedAt, largePolicy || renderPolicy || (hard ? 'hard' : heavy ? 'soft-heavy' : 'normal')); 
  updateOverlayTextConsistencyMarker();
  syncOverlayScroll();
}

export function flushEditorColorOverlayNow(reason = 'external-force') {
  if (!editorElement || !colorLayerInner) return false;
  pendingOverlayRenderOptions = null;
  cancelScheduledOverlayPaint({ cancelFull: true });
  invalidateOverlayPaintCache();
  renderOverlay({
    deferHeavy: false,
    preferFull: true,
    fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS,
    renderPolicy: `forced:${reason}`,
  });
  // History commands can arrive while WebView2 still exposes the just-finished
  // native IME surface. Once the restored overlay has been painted synchronously,
  // do not leave that stale native surface above it waiting for another input.
  if (String(reason || '').includes('history')) {
    editorCompositionActive = false;
    setLargeImeDirectTextOverlay(false, `history:${reason}`);
  }
  return true;
}

function scheduleOverlayRender(options = {}) {
  const reasonOptions = overlayRenderOptionsFromReason(options.reason || '');
  const nextOptions = mergeOverlayRenderOptions(reasonOptions, options);
  pendingOverlayRenderOptions = pendingOverlayRenderOptions ? mergeOverlayRenderOptions(pendingOverlayRenderOptions, nextOptions) : nextOptions;
  if (overlayRenderRaf) return;
  overlayRenderRaf = requestAnimationFrame(() => {
    overlayRenderRaf = 0;
    const opts = pendingOverlayRenderOptions || overlayRenderOptionsFromReason('');
    pendingOverlayRenderOptions = null;
    renderOverlay({ ...opts, renderPolicy: opts.renderPolicy || opts.policy || '' });
  });
}

let largeImeDirectTextOverlayActive = false;
let largeImeDirectTextEndTimer = 0;
let largeImeDirectTextFinishToken = 0;
let editorCompositionActive = false;
let largeImeNativeBandSession = null;

function clearLargeImeCompositionMarker(reason = '') {
  if (editorElement) {
    editorElement.style.removeProperty('--ime-composition-marker-left');
    editorElement.style.removeProperty('--ime-composition-marker-top');
    editorElement.style.removeProperty('--ime-composition-marker-width');
    editorElement.style.removeProperty('--ime-composition-marker-height');
  }
  document.body?.classList.remove('large-ime-composition-marked');
  if (reason) setRootDatasetValue('editorImeCompositionMarker', `clear:${reason}`);
}

function readNativeEditorCompositionGeometry() {
  if (!editorElement || typeof HTMLTextAreaElement === 'undefined') return null;
  try {
    const proto = HTMLTextAreaElement.prototype;
    const valueGetter = Object.getOwnPropertyDescriptor(proto, 'value')?.get;
    const selectionEndGetter = Object.getOwnPropertyDescriptor(proto, 'selectionEnd')?.get;
    if (typeof valueGetter !== 'function' || typeof selectionEndGetter !== 'function') return null;
    const value = String(valueGetter.call(editorElement) || '');
    const selectionEnd = Math.max(0, Math.min(value.length, Number(selectionEndGetter.call(editorElement)) || 0));
    return { value, selectionEnd };
  } catch (_) {
    return null;
  }
}

function computeLargeImeNativeCaretX() {
  if (!editorElement) return null;
  const native = readNativeEditorCompositionGeometry();
  if (!native) return null;
  const lineStart = native.value.lastIndexOf('\n', Math.max(0, native.selectionEnd - 1)) + 1;
  const prefix = native.value.slice(lineStart, native.selectionEnd);
  const prefixWidth = Number(measureEditorTextWidthForImeBand(prefix));
  if (!Number.isFinite(prefixWidth) || prefixWidth < 0) return null;
  let paddingLeft = 12;
  let borderLeft = 0;
  try {
    const cs = getComputedStyle(editorElement);
    paddingLeft = Math.max(0, Number.parseFloat(cs.paddingLeft) || 0);
    borderLeft = Math.max(0, Number.parseFloat(cs.borderLeftWidth) || 0);
  } catch (_) {}
  return Math.max(0, borderLeft + paddingLeft + prefixWidth - 1);
}

function syncLargeImeCompositionMarker(startBand, startX, reason = 'composition') {
  if (!editorElement || !startBand || largeImeNativeBandSession?.fullSurface === true) {
    clearLargeImeCompositionMarker(`${reason}:fallback`);
    return false;
  }
  const safeStartX = Number(startX);
  const liveX = Number(computeLargeImeNativeCaretX());
  if (!Number.isFinite(safeStartX) || !Number.isFinite(liveX) || liveX <= safeStartX + 0.5) {
    clearLargeImeCompositionMarker(`${reason}:geometry`);
    return false;
  }
  const left = Math.max(0, safeStartX - 1);
  const top = Math.max(0, Number(startBand.top) + 1);
  const width = Math.max(3, liveX - safeStartX + 2);
  const height = Math.max(3, Number(startBand.height) - 2);
  editorElement.style.setProperty('--ime-composition-marker-left', `${left}px`);
  editorElement.style.setProperty('--ime-composition-marker-top', `${top}px`);
  editorElement.style.setProperty('--ime-composition-marker-width', `${width}px`);
  editorElement.style.setProperty('--ime-composition-marker-height', `${height}px`);
  document.body?.classList.add('large-ime-composition-marked');
  setRootDatasetValue(
    'editorImeCompositionMarker',
    `${reason}:${Math.round(left * 100) / 100}:${Math.round(width * 100) / 100}:${Math.round(top * 100) / 100}:${Math.round(height * 100) / 100}`,
  );
  return true;
}

function clearLargeImeNativeBand(reason = '') {
  clearLargeImeCompositionMarker(reason || 'band-clear');
  if (editorElement) {
    editorElement.style.removeProperty('--large-ime-native-band-top');
    editorElement.style.removeProperty('--large-ime-native-band-height');
    editorElement.style.removeProperty('--large-ime-native-band-left');
  }
  document.body?.classList.remove('large-ime-native-full-surface');
  if (reason) setRootDatasetValue('editorImeNativeBand', `clear:${reason}`);
}

function clearLargeImeNativeBandSession(reason = '') {
  largeImeNativeBandSession = null;
  clearLargeImeNativeBand(reason);
  if (reason) setRootDatasetValue('editorImeNativeBandSession', `clear:${reason}`);
}

function computeLargeImeNativeBand(documentStart, viewport, lineHeight, paddingTop = 12) {
  const viewportText = String(viewport?.text || '');
  const viewportStart = Math.max(0, Number(viewport?.start) || 0);
  const localStart = Math.max(0, Math.min(viewportText.length, (Number(documentStart) || 0) - viewportStart));
  let localLine = 0;
  for (let i = 0; i < localStart; i++) if (viewportText.charCodeAt(i) === 10) localLine += 1;
  const safeLineHeight = Math.max(1, Number(lineHeight) || 1);
  const safePaddingTop = Math.max(0, Number(paddingTop) || 0);
  return {
    localLine,
    top: Math.max(0, safePaddingTop + localLine * safeLineHeight - 1),
    height: Math.max(1, safeLineHeight + 2),
  };
}


function computeLargeImeNativeBandStartX(documentStart, visibleText = '') {
  if (!editorElement) return null;
  const text = String(visibleText || '');
  const safeStart = Math.max(0, Math.min(text.length, Number(documentStart) || 0));
  const lineStart = text.lastIndexOf('\n', Math.max(0, safeStart - 1)) + 1;
  const prefix = text.slice(lineStart, safeStart);
  let paddingLeft = 12;
  let borderLeft = 0;
  try {
    const cs = getComputedStyle(editorElement);
    paddingLeft = Math.max(0, Number.parseFloat(cs.paddingLeft) || 0);
    borderLeft = Math.max(0, Number.parseFloat(cs.borderLeftWidth) || 0);
  } catch (_) {}
  const prefixWidth = Number(measureEditorTextWidthForImeBand(prefix));
  if (!Number.isFinite(prefixWidth) || prefixWidth < 0) return null;
  const measured = Math.max(0, borderLeft + paddingLeft + prefixWidth - 1);
  let maxWidth = 0;
  try { maxWidth = Math.max(0, Number(editorElement.scrollWidth) || 0); } catch (_) {}
  return maxWidth > 0 ? Math.min(measured, maxWidth) : measured;
}

function syncLargeImeNativeBand(reason = 'composition') {
  if (!editorElement || !largeImeNativeBandSession) return false;
  document.body?.classList.toggle('large-ime-native-full-surface', largeImeNativeBandSession.fullSurface === true);
  if (largeImeNativeBandSession.fullSurface === true) {
    clearLargeImeCompositionMarker(`${reason}:full-surface`);
    setRootDatasetValue('editorImeNativeBand', `${reason}:full-surface`);
    return true;
  }
  if (!isLargeEditorViewportActive()) return false;
  const viewport = getLargeEditorViewportWindow();
  if (!viewport?.active) return false;

  const nativeSelection = getLargeEditorNativeDocumentSelection();
  const liveCaret = nativeSelection && Number.isFinite(Number(nativeSelection.end))
    ? Number(nativeSelection.end)
    : Number(largeImeNativeBandSession.start) || 0;
  const documentStart = Math.max(0, Number(largeImeNativeBandSession.start) || 0);
  const lineHeight = editorLineHeightPx();
  let paddingTop = 12;
  try {
    const cs = getComputedStyle(editorElement);
    paddingTop = Math.max(0, Number.parseFloat(cs.paddingTop) || 0);
  } catch (_) {}

  const startBand = computeLargeImeNativeBand(documentStart, viewport, lineHeight, paddingTop);
  const liveBand = computeLargeImeNativeBand(Math.max(0, liveCaret), viewport, lineHeight, paddingTop);
  // A one-line suffix band is only valid while the native caret remains on the
  // composition start line and does not move before the original anchor. If that
  // invariant breaks, do not estimate transient geometry: expose the bounded
  // native viewport, which is the established correctness fallback.
  if (liveBand.localLine !== startBand.localLine || liveCaret < documentStart) {
    largeImeNativeBandSession.fullSurface = true;
    document.body?.classList.add('large-ime-native-full-surface');
    editorElement.style.removeProperty('--large-ime-native-band-left');
    clearLargeImeCompositionMarker(`${reason}:line-change`);
    setRootDatasetValue('editorImeNativeBand', `${reason}:full-surface-line-change:${documentStart}:${liveCaret}`);
    return true;
  }

  editorElement.style.setProperty('--large-ime-native-band-top', `${startBand.top}px`);
  editorElement.style.setProperty('--large-ime-native-band-height', `${startBand.height}px`);
  const startX = Number(largeImeNativeBandSession.startX);
  if (Number.isFinite(startX) && startX >= 0) {
    editorElement.style.setProperty('--large-ime-native-band-left', `${startX}px`);
    syncLargeImeCompositionMarker(startBand, startX, reason);
  } else {
    // X measurement failure keeps the proven 0169 whole-line band rather than
    // guessing a narrow range and reintroducing ghost/overlap artifacts.
    editorElement.style.removeProperty('--large-ime-native-band-left');
    clearLargeImeCompositionMarker(`${reason}:x-fallback`);
  }
  setRootDatasetValue(
    'editorImeNativeBand',
    `${reason}:${documentStart}:${startBand.localLine}:${Number.isFinite(startX) ? Math.round(startX * 100) / 100 : 'line'}:${Math.round(startBand.top * 100) / 100}:${Math.round(startBand.height * 100) / 100}`,
  );
  return true;
}

function beginLargeImeNativeBandSession(reason = 'composition-start') {
  if (!editorElement || !isLargeTextModeActive()) {
    clearLargeImeNativeBandSession('inactive');
    return false;
  }
  const visibleText = String(editorElement.value || '');
  const visibleLength = visibleText.length;
  const nativeSelection = getLargeEditorNativeDocumentSelection();
  const start = Math.max(0, Math.min(visibleLength, Number(nativeSelection?.start ?? editorElement.selectionStart) || 0));
  const end = Math.max(start, Math.min(visibleLength, Number(nativeSelection?.end ?? editorElement.selectionEnd ?? start) || start));
  // Replacing a multi-line selection shifts every later line before commit. One
  // native line cannot cover that geometry mismatch, so use the full bounded
  // viewport surface for that rare composition case.
  const fullSurface = !isLargeEditorViewportActive()
    || (start !== end && visibleText.slice(start, end).includes('\n'));
  // Measure once at composition start. The native suffix from this X to the row
  // end owns both the transient preedit and every shifted character after it;
  // the overlay prefix to the left keeps its original colors without per-key DOM
  // rebuilding or transient-string reconstruction.
  const startX = fullSurface ? null : computeLargeImeNativeBandStartX(start, visibleText);
  largeImeNativeBandSession = { visibleLength, start, end, startX, fullSurface };
  syncLargeImeNativeBand(reason);
  setRootDatasetValue('editorImeNativeBandSession', `begin:${reason}:${start}:${end}`);
  return true;
}

function setLargeImeDirectTextOverlay(active, reason = '') {
  const next = active === true;
  // Final choke point for the native IME line-band surface.
  // Callers such as history/forced navigation can bypass finishLargeImeDirectTextOverlay,
  // so never change the composition surface while a native pointer drag is active.
  if (!next && largeImeDirectTextOverlayActive && isLargeEditorPointerSelectionActive()) {
    pointerDeferredImeFinishReason = String(reason || 'direct-overlay-off');
    setRootDatasetValue('editorImePointerDeferredFinish', `setter:${pointerDeferredImeFinishReason}`);
    return true;
  }
  if (largeImeDirectTextEndTimer) {
    clearTimeout(largeImeDirectTextEndTimer);
    largeImeDirectTextEndTimer = 0;
  }
  largeImeDirectTextFinishToken += 1;
  const mode = next ? `large-native-band:${reason || 'composition'}` : 'normal';
  if (largeImeDirectTextOverlayActive === next && document.documentElement?.dataset.editorImeOverlayMode === mode) {
    if (!next) clearLargeImeNativeBandSession(`already-off:${reason || 'normal'}`);
    return next;
  }
  largeImeDirectTextOverlayActive = next;
  if (!next) pointerDeferredImeFinishReason = '';
  document.body?.classList.toggle('large-ime-direct-text', next);
  if (next) syncLargeImeNativeBand(reason || 'composition');
  else clearLargeImeNativeBandSession(`overlay-off:${reason || 'normal'}`);
  setRootDatasetValue('editorImeOverlayMode', mode);
  return next;
}

function beginLargeImeDirectTextOverlay(reason = 'composition-start') {
  if (!isLargeTextModeActive()) return false;
  if (!beginLargeImeNativeBandSession(reason)) return false;
  const wasActive = largeImeDirectTextOverlayActive === true;
  setLargeImeDirectTextOverlay(true, reason);
  cancelScheduledOverlayPaint({ cancelFull: true });
  if (wasActive) syncOverlayTransformOnly();
  else syncOverlayScroll();
  return true;
}

function finishLargeImeDirectTextOverlay(reason = 'composition-end') {
  if (!largeImeDirectTextOverlayActive) return false;
  if (isLargeEditorPointerSelectionActive()) {
    // Keep the native IME text surface and its native selection painting intact
    // until the user's drag ends. The committed model is already current; only
    // the visual color handoff is postponed.
    pointerDeferredImeFinishReason = String(reason || 'composition-end');
    setRootDatasetValue('editorImePointerDeferredFinish', pointerDeferredImeFinishReason);
    return false;
  }
  if (largeImeDirectTextEndTimer) {
    clearTimeout(largeImeDirectTextEndTimer);
    largeImeDirectTextEndTimer = 0;
  }
  // Paint the committed colored overlay underneath the native active-line band.
  // The band is removed only after the committed overlay reaches a paint boundary.
  pendingOverlayRenderOptions = null;
  cancelScheduledOverlayPaint({ cancelFull: true });
  renderOverlay({ deferHeavy: false, preferFull: true, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, renderPolicy: `large-ime-handoff:${reason}` });
  const token = ++largeImeDirectTextFinishToken;
  // Keep the historical two-frame handoff token so late composition/pointer events
  // cannot clear the mode until the committed overlay has reached a paint boundary.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!largeImeDirectTextOverlayActive || editorCompositionActive || token !== largeImeDirectTextFinishToken) return;
    // The drag can start after this handoff was scheduled but before the second
    // frame executes. Re-check here so the textarea never becomes transparent in
    // the middle of an active native selection gesture.
    if (isLargeEditorPointerSelectionActive()) {
      pointerDeferredImeFinishReason = String(reason || 'composition-end');
      setRootDatasetValue('editorImePointerDeferredFinish', `late:${pointerDeferredImeFinishReason}`);
      return;
    }
    setLargeImeDirectTextOverlay(false, reason);
  }));
  return true;
}

function finishLargeImeDirectTextOverlaySoon(reason = 'composition-end') {
  if (!largeImeDirectTextOverlayActive) return;
  if (largeImeDirectTextEndTimer) clearTimeout(largeImeDirectTextEndTimer);
  // This is only a fallback. The normal path finishes immediately after the
  // document-model composition commit notification.
  largeImeDirectTextEndTimer = setTimeout(() => {
    largeImeDirectTextEndTimer = 0;
    finishLargeImeDirectTextOverlay(reason);
  }, 160);
}

function renderOverlayForComposition(reason = 'composition-sync') {
  const textReason = String(reason || '');
  if (largeImeDirectTextOverlayActive) {
    if (textReason.includes('commit')) {
      if (editorCompositionActive) {
        // Pointer/arrow navigation can force the model commit before WebView2 emits
        // compositionend. Prepare the committed overlay now, but keep native text
        // visible until the real composition handoff finishes.
        pendingOverlayRenderOptions = null;
        cancelScheduledOverlayPaint({ cancelFull: true });
        renderOverlay({ deferHeavy: false, preferFull: true, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, renderPolicy: `large-ime-prepared:${reason}` });
        syncOverlayTransformOnly();
      } else finishLargeImeDirectTextOverlay(reason);
    } else if (textReason.includes('end')) {
      finishLargeImeDirectTextOverlaySoon(reason);
    } else {
      syncLargeImeNativeBand(reason || 'composition-sync');
    }
    return;
  }
  pendingOverlayRenderOptions = null;
  cancelScheduledOverlayPaint({ cancelFull: false });
  renderOverlay({ deferHeavy: false, preferFull: false, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, renderPolicy: reason });
}

function warmupEditorOverlay() {
  renderOverlay({ deferHeavy: false, preferFull: true, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, renderPolicy: 'startup-warmup-immediate' });
  const run = reason => renderOverlay({ deferHeavy: false, preferFull: true, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, renderPolicy: reason });
  requestAnimationFrame(() => run('startup-warmup-raf-1'));
  requestAnimationFrame(() => requestAnimationFrame(() => run('startup-warmup-raf-2')));
  setTimeout(() => run('startup-warmup-timer-80'), 80);
  setTimeout(() => run('startup-warmup-timer-240'), 240);
}

function syncOverlayScroll() {
  if (!editorElement || !colorLayerInner) return;
  // In the virtual editor the overlay does not need a transform while the user is
  // selecting. Even metric/style writes can trigger WebView2 selection repaint, so
  // freeze the whole visual surface until the pointer transaction is complete.
  if (isLargeEditorPointerSelectionActive()) {
    rememberPointerDeferredOverlay({ deferHeavy: false, preferFull: false, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, renderPolicy: 'pointer-scroll-deferred' });
    return;
  }
  syncOverlayMetrics();
  if (isLargeEditorViewportActive()) colorLayerInner.style.transform = 'none';
  else colorLayerInner.style.transform = `translate(${-editorElement.scrollLeft}px, ${-editorElement.scrollTop}px)`;
  clearEditorSurfaceMeasureCache();
}

function syncOverlayTransformOnly() {
  if (!editorElement || !colorLayerInner) return;
  if (isLargeEditorPointerSelectionActive()) return;
  if (isLargeEditorViewportActive()) colorLayerInner.style.transform = 'none';
  else colorLayerInner.style.transform = `translate(${-editorElement.scrollLeft}px, ${-editorElement.scrollTop}px)`;
  clearEditorSurfaceMeasureCache();
}

function handleEditorOverlayScroll() {
  syncOverlayScroll();
  if (!isLargeTextModeActive()) return;
  scheduleOverlayRender({ reason: '대용량 viewport scroll', policy: 'large-viewport-scroll', preferFull: false });
}

function ensureEditorColorLayer() {
  if (!editorElement || colorLayer) return;
  const parent = editorElement.parentElement;
  if (!parent) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'editor-color-wrap';
  parent.insertBefore(wrapper, editorElement);
  wrapper.appendChild(editorElement);
  colorLayer = document.createElement('div');
  colorLayer.className = 'editor-color-layer';
  colorLayer.setAttribute('aria-hidden', 'true');
  colorLayerInner = document.createElement('div');
  colorLayerInner.className = 'editor-color-layer-inner wrap-enabled';
  colorLayer.appendChild(colorLayerInner);
  wrapper.appendChild(colorLayer);
  editorElement.classList.add('editor-color-source');
  installEditorSurfaceSelectionCorrection();
  editorElement.addEventListener('scroll', handleEditorOverlayScroll);
  editorElement.addEventListener('input', () => {
    if (largeImeDirectTextOverlayActive) {
      // Native textarea owns the transient preedit. Keep only its active line visible;
      // never synthesize composition text in the color overlay.
      syncLargeImeNativeBand('composition-input');
      return;
    }
    scheduleOverlayRender({ reason: '편집창 입력', fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, policy: 'editor-input' });
  });
  editorElement.addEventListener('compositionstart', () => {
    editorCompositionActive = true;
    if (!beginLargeImeDirectTextOverlay('composition-start')) renderOverlayForComposition('composition-start');
  });
  editorElement.addEventListener('compositionupdate', () => {
    if (!largeImeDirectTextOverlayActive) return;
    syncLargeImeNativeBand('composition-update');
  });
  editorElement.addEventListener('compositionend', () => {
    editorCompositionActive = false;
    clearLargeImeCompositionMarker('composition-end');
    finishLargeImeDirectTextOverlaySoon('composition-end');
  });
  try {
    new MutationObserver(() => {
      if (largeImeDirectTextOverlayActive) return;
      scheduleOverlayRender();
    }).observe(editorElement, { attributes: true, attributeFilter: ['class', 'style'] });
  } catch (_) {}
  window.addEventListener('ttedit-document-view-synced', event => {
    if (event?.detail?.input === true && event?.detail?.source === 'editor') return;
    const reason = event?.detail?.reason || '';
    if (event?.detail?.forceOverlay === true) {
      // Undo/redo must repaint the transparent editor immediately, not wait for
      // the next input event or a queued animation frame.
      flushEditorColorOverlayNow(`view-sync:${reason}`);
      return;
    }
    scheduleOverlayRender({ reason, policy: 'view-synced' });
  });
  window.addEventListener('ttedit-editor-composition-sync', event => renderOverlayForComposition(event?.detail?.reason || 'composition-sync'));
  window.addEventListener('ttedit-editor-composition-force-end', event => {
    // Cursor navigation is an explicit end to the app-side composition session.
    // WebView2 does not reliably deliver a later compositionend after the model
    // has been force-committed, so complete the visual handoff idempotently here.
    editorCompositionActive = false;
    finishLargeImeDirectTextOverlay(`forced-navigation:${event?.detail?.reason || 'navigation'}`);
  });
  window.addEventListener('ttedit-large-editor-pointer-selection-changed', event => {
    if (event?.detail?.active !== false) return;
    // Wait until the mouseup dispatch and native selection update are complete,
    // then perform the color/native-text handoff that was deferred during drag.
    flushPointerDeferredOverlay(event?.detail?.reason || 'pointer-release');
  });
  window.addEventListener('ttedit-large-text-mode-changed', event => {
    if (event?.detail?.active !== true) {
      finishLargeImeDirectTextOverlay('large-mode-off');
      clearLargeImeNativeBandSession('large-mode-off');
    }
  });
  window.addEventListener('ttedit-large-editor-window-changed', () => { invalidateOverlayPaintCache(); scheduleOverlayRender({ reason: '대용량 편집창 window 변경', preferFull: false, policy: 'large-editor-window' }); });
  window.addEventListener('ttedit-rendering-changed', () => { invalidateOverlayPaintCache(); scheduleOverlayRender({ reason: 'rendering changed', preferFull: true, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, policy: 'rendering-changed' }); });
  warmupEditorOverlay();
}

function getCodeSelectionAsVisibleRange(model) {
  const max = String(codeElement?.value || '').length;
  const rawStart = Math.max(0, Math.min(codeElement?.selectionStart ?? 0, max, model.rawLength));
  const rawEnd = Math.max(0, Math.min(codeElement?.selectionEnd ?? codeElement?.selectionStart ?? 0, max, model.rawLength));
  const orderedStart = Math.min(rawStart, rawEnd);
  const orderedEnd = Math.max(rawStart, rawEnd);
  const start = rawOffsetToVisibleOffset(model, orderedStart, 'start');
  const end = rawOffsetToVisibleOffset(model, orderedEnd, 'end');
  return { source: 'code', start, end, rawStart: orderedStart, rawEnd: orderedEnd, element: codeElement };
}

function getEditorSelectionAsVisibleRange(model) {
  const max = model.visibleLength;
  const start = Math.max(0, Math.min(editorElement?.selectionStart ?? 0, max));
  const end = Math.max(0, Math.min(editorElement?.selectionEnd ?? editorElement?.selectionStart ?? 0, max));
  return { source: 'editor', start: Math.min(start, end), end: Math.max(start, end), element: editorElement };
}

function activeSelectionAsVisibleRange() {
  const active = document.activeElement;
  const model = parseRawCode(state.rawCode || '');
  if (active === codeElement) return getCodeSelectionAsVisibleRange(model);
  if (active === editorElement) return getEditorSelectionAsVisibleRange(model);

  // 색상칩/툴바 클릭은 textarea focus를 빼앗을 수 있다.
  // 이때는 마지막 문서 focus인 state.activeView를 기준으로 기존 textarea selection을 사용한다.
  if (state.activeView === 'code' && codeElement) return getCodeSelectionAsVisibleRange(model);
  return getEditorSelectionAsVisibleRange(model);
}

function restoreCaret(source, documentText, documentOffset) {
  if (source === 'code') {
    const pos = Math.max(0, Math.min(Number(documentOffset) || 0, String(documentText || '').length));
    codeElement?.focus({ preventScroll: true });
    try { codeElement?.setSelectionRange(pos, pos); } catch (_) {}
    return;
  }
  editorElement?.focus({ preventScroll: true });
  const pos = Math.max(0, Math.min(rawOffsetToVisibleOffset(parseRawCode(documentText || ''), documentOffset, 'end'), editorElement?.value?.length || 0));
  try { editorElement?.setSelectionRange(pos, pos); } catch (_) {}
}

function restoreEditorCaretVisible(visibleOffset) {
  if (!editorElement) return;
  const pos = Math.max(0, Math.min(Number(visibleOffset) || 0, editorElement.value?.length || 0));
  editorElement.focus({ preventScroll: true });
  try { editorElement.setSelectionRange(pos, pos); } catch (_) {}
}

function developerModeColorLinks(links) {
  const normalized = normalizeColorLinks(links).map(item => ({ ...item }));
  if (!isDeveloperModeEnabled()) return normalized;
  return normalized.map(item => normalizeFnShortcut(item.shortcutKey, '') === 'F12' ? { ...item, shortcutKey: '', developerModeSuspendedFn: 'F12' } : item);
}

function effectiveColorPreferencesForRuntime() {
  const prefs = getPreferences();
  if (!isDeveloperModeEnabled()) return prefs;
  return { ...prefs, colorLinks: developerModeColorLinks(prefs.colorLinks) };
}

function shortcutLabelHtml(item) {
  const label = colorShortcutDisplay(item);
  const isFn = !!normalizeFnShortcut(item?.shortcutKey, '');
  const cls = isFn ? 'color-chip-code-suffix color-fn-shortcut' : 'color-chip-code-suffix';
  return `<span class="${cls}">${htmlEscape(label || colorCodeSuffix(item.code))}</span>`;
}

function isDocumentShortcutTarget() {
  const active = document.activeElement;
  return active === editorElement || active === codeElement;
}

function isFnKeyEvent(event) {
  if (!event || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.isComposing) return '';
  const fn = normalizeFnShortcut(event.key || event.code || '', '');
  if (fn === 'F12' && isDeveloperModeEnabled()) return '';
  return fn;
}


function isFnColorItem(item) { return !!normalizeFnShortcut(item?.shortcutKey, ''); }

function currentColorLinks() { return normalizeColorLinks(getPreferences().colorLinks).map(item => ({ ...item })); }

function orderedRegularCodesFromLinks(links) {
  return links.filter(item => !isFnColorItem(item)).map(item => item.code);
}

function reorderRegularColorLinksByCodes(links, orderedRegularCodes) {
  const regularByCode = new Map(links.filter(item => !isFnColorItem(item)).map(item => [item.code, item]));
  const nextRegular = [];
  for (const code of orderedRegularCodes) {
    const item = regularByCode.get(code);
    if (item && !nextRegular.includes(item)) nextRegular.push(item);
  }
  for (const item of links) {
    if (!isFnColorItem(item) && !nextRegular.includes(item)) nextRegular.push(item);
  }
  let regularIndex = 0;
  return links.map(item => isFnColorItem(item) ? item : nextRegular[regularIndex++] || item);
}

function saveRegularColorOrder(dragCode, beforeCode) {
  if (!dragCode || dragCode === beforeCode) return false;
  const links = currentColorLinks();
  const dragItem = links.find(item => item.code === dragCode);
  if (!dragItem || isFnColorItem(dragItem)) return false;
  const regularCodes = orderedRegularCodesFromLinks(links).filter(code => code !== dragCode);
  let insertAt = beforeCode ? regularCodes.indexOf(beforeCode) : -1;
  if (insertAt < 0) regularCodes.push(dragCode);
  else regularCodes.splice(insertAt, 0, dragCode);
  const nextLinks = reorderRegularColorLinksByCodes(links, regularCodes);
  const before = JSON.stringify(links.map(item => item.code));
  const after = JSON.stringify(nextLinks.map(item => item.code));
  if (before === after) return false;
  setPreferences({ colorLinks: nextLinks });
  setStatusMessage('색상 버튼 순서 변경');
  return true;
}

function clearColorChipDropHints() {
  if (!toolbarRoot) return;
  toolbarRoot.querySelectorAll('.color-chip-dragging, .color-chip-drop-before, .color-chip-drop-after').forEach(el => {
    el.classList.remove('color-chip-dragging', 'color-chip-drop-before', 'color-chip-drop-after');
  });
  toolbarRoot.classList.remove('color-strip-dragging');
}

function getRegularChipBeforePointer(clientX, draggingCode) {
  if (!toolbarRoot) return '';
  const chips = Array.from(toolbarRoot.querySelectorAll('.color-chip')).filter(chip => {
    const code = chip.dataset.colorCode || '';
    return code && code !== draggingCode && chip.dataset.fnAssigned !== 'true';
  });
  for (const chip of chips) {
    const rect = chip.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    if (clientX < midpoint) return chip.dataset.colorCode || '';
  }
  return '';
}

function updateColorChipDropHint(clientX, draggingCode) {
  if (!toolbarRoot || !colorChipDrag) return;
  toolbarRoot.querySelectorAll('.color-chip-drop-before, .color-chip-drop-after').forEach(el => el.classList.remove('color-chip-drop-before', 'color-chip-drop-after'));
  const beforeCode = getRegularChipBeforePointer(clientX, draggingCode);
  colorChipDrag.beforeCode = beforeCode;
  if (beforeCode) toolbarRoot.querySelector(`.color-chip[data-color-code="${CSS.escape(beforeCode)}"]`)?.classList.add('color-chip-drop-before');
  else {
    const regularChips = Array.from(toolbarRoot.querySelectorAll('.color-chip')).filter(chip => chip.dataset.fnAssigned !== 'true' && chip.dataset.colorCode !== draggingCode);
    regularChips.at(-1)?.classList.add('color-chip-drop-after');
  }
}

function startColorChipCtrlDrag(button, item, event) {
  if (!toolbarRoot || !event?.ctrlKey || isFnColorItem(item) || item?.developerModeSuspendedFn) return false;
  event.preventDefault();
  event.stopPropagation();
  if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  suppressNextColorChipClick = true;
  colorChipDrag = { code: item.code, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, beforeCode: '' };
  button.classList.add('color-chip-dragging');
  toolbarRoot.classList.add('color-strip-dragging');
  try { button.setPointerCapture?.(event.pointerId); } catch (_) {}
  setStatusMessage('Ctrl+드래그로 색상 순서 이동');
  return true;
}

function onColorChipDragMove(event) {
  if (!colorChipDrag || event.pointerId !== colorChipDrag.pointerId) return;
  const dx = Math.abs(event.clientX - colorChipDrag.startX);
  const dy = Math.abs(event.clientY - colorChipDrag.startY);
  if (!colorChipDrag.moved && (dx > 5 || dy > 5)) colorChipDrag.moved = true;
  if (!colorChipDrag.moved) return;
  event.preventDefault();
  updateColorChipDropHint(event.clientX, colorChipDrag.code);
}

function finishColorChipDrag(event, cancelled = false) {
  if (!colorChipDrag || event.pointerId !== colorChipDrag.pointerId) return;
  const drag = colorChipDrag;
  colorChipDrag = null;
  clearColorChipDropHints();
  if (!cancelled && drag.moved) saveRegularColorOrder(drag.code, drag.beforeCode || '');
  setTimeout(() => { suppressNextColorChipClick = false; }, 0);
}

function assignFnShortcutToColor(colorCode, fnKey) {
  const fn = normalizeFnShortcut(fnKey, '');
  if (!colorCode || !fn) return false;
  const prefs = getPreferences();
  const links = normalizeColorLinks(prefs.colorLinks).map(item => ({ ...item }));
  let target = null;
  let wasSameTargetFn = false;
  for (const item of links) {
    if (item.code === colorCode) {
      target = item;
      wasSameTargetFn = item.shortcutKey === fn;
    }
  }
  if (!target) return false;
  for (const item of links) {
    if (item.shortcutKey === fn) item.shortcutKey = '';
  }
  const name = target.name || colorCodeLabel(colorCode);
  if (wasSameTargetFn) {
    setPreferences({ colorLinks: links });
    setStatusMessage(`${name}: ${fn} 해제, 기본 문자 단축키로 복귀`);
    return true;
  }
  target.shortcutKey = fn;
  setPreferences({ colorLinks: links });
  setStatusMessage(`${name}: ${fn} 단축키 지정`);
  return true;
}

export function hasCopiedFontColor() {
  return !!copiedFontColorCode;
}

export function copySelectedFontColor() {
  const selection = activeSelectionAsVisibleRange();
  if (selection.source !== 'editor') {
    setStatusMessage('글꼴 색상 복사는 편집창 선택 영역에서만 사용할 수 있습니다.');
    return false;
  }
  if (selection.end <= selection.start) {
    setStatusMessage('글꼴 색상을 복사할 선택 영역 없음');
    return false;
  }
  const model = parseRawCode(state.rawCode || '');
  const colorCode = activeColorAtVisibleOffset(model, selection.start) || DEFAULT_COLOR;
  copiedFontColorCode = colorCode;
  const info = getColorByCode(colorCode, getPreferences());
  setStatusMessage(`글꼴 색상 복사: ${translateRuntimeUiText(info?.name || colorCodeLabel(colorCode))}`);
  return true;
}

export function pasteCopiedFontColor() {
  if (!copiedFontColorCode) {
    setStatusMessage('복사한 글꼴 색상 없음');
    return false;
  }
  const selection = activeSelectionAsVisibleRange();
  if (selection.source !== 'editor') {
    setStatusMessage('복사한 색상 붙여넣기는 편집창 선택 영역에서만 사용할 수 있습니다.');
    return false;
  }
  if (selection.end <= selection.start) {
    setStatusMessage('복사한 색상을 붙여넣을 선택 영역 없음');
    return false;
  }
  return applyColorCode(copiedFontColorCode);
}

export function applyColorCode(colorCode) {
  const { source, start, end } = activeSelectionAsVisibleRange();
  if (end <= start) { setStatusMessage('색상을 적용할 선택 영역 없음'); return false; }
  const snapshot = captureDocumentSnapshot(source);
  const result = applyColorToRawVisibleRange(state.rawCode, start, end, colorCode);
  if (!result.changed) {
    if (result.reason === 'no-target') setStatusMessage('색상 적용 대상 없음');
    else setStatusMessage('색상 적용: 변경 없음');
    return false;
  }
  const info = getColorByCode(colorCode, getPreferences()) || getColorByCode(DEFAULT_COLOR, getPreferences());
  // The visible string may remain unchanged when only raw color tokens change.
  // Invalidate the viewport overlay cache before the document action.
  invalidateOverlayPaintCache();
  const applied = applyDocumentTextAction(result.rawCode, { source, label: `색상 적용: ${info.name}`, snapshot, actionType: 'color-apply-raw', selectionRestoreMode: 'collapse-end' });
  if (!applied) return false;
  if (source === 'editor' && Number.isFinite(result.caretVisibleOffset)) restoreEditorCaretVisible(result.caretVisibleOffset);
  else restoreCaret(source, result.rawCode, result.caretRawOffset);
  // 색상 적용은 결과 확인이 중요하므로 soft-heavy 문서에서도 plain/lightweight가
  // full color를 다시 덮지 않게 하고, hard 문서만 안전하게 deferred fallback을 쓴다.
  renderOverlay({ deferHeavy: true, preferFull: true, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, renderPolicy: 'color-apply-prefer-full' });
  refreshStatus(`색상 적용: ${info.name}`);
  return true;
}

function makeColorChip(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'color-chip';
  button.dataset.colorCode = item.code;
  button.dataset.fnAssigned = isFnColorItem(item) ? 'true' : 'false';
  button.draggable = false;
  if (isFnColorItem(item)) button.dataset.tooltipPrefix = 'Fn 자동 정렬';
  if (item.developerModeSuspendedFn) button.dataset.tooltipPrefix = '개발자모드 임시 해제';
  button.style.setProperty('--chip-color', item.hex);
  button.dataset.tooltip = `${item.hex} ${item.memo || item.name}`;
  const fn = normalizeFnShortcut(item.shortcutKey, '');
  const dragHint = item.developerModeSuspendedFn ? '개발자모드 중 F12 색상 단축키는 임시 비활성화됩니다.' : (fn ? 'Fn 지정 색상은 자동 정렬됩니다.' : 'Ctrl+드래그로 순서 이동.');
  button.setAttribute('aria-label', `${item.name} ${colorCodeLabel(item.code)} ${item.hex} ${dragHint}`);
  button.innerHTML = `<span class="color-chip-swatch"></span><span class="color-chip-name">${htmlEscape(item.name)}</span><span class="color-chip-code">${shortcutLabelHtml(item)}</span>`;
  button.addEventListener('mouseenter', () => { hoveredColorCode = item.code; });
  button.addEventListener('mouseleave', () => { if (hoveredColorCode === item.code && !colorChipDrag) hoveredColorCode = ''; });
  button.addEventListener('focus', () => { hoveredColorCode = item.code; });
  button.addEventListener('blur', () => { if (hoveredColorCode === item.code && !colorChipDrag) hoveredColorCode = ''; });
  button.addEventListener('pointerdown', event => {
    if (startColorChipCtrlDrag(button, item, event)) return;
  });
  button.addEventListener('pointermove', onColorChipDragMove);
  button.addEventListener('pointerup', event => finishColorChipDrag(event, false));
  button.addEventListener('pointercancel', event => finishColorChipDrag(event, true));
  button.addEventListener('mousedown', event => {
    // mouse click으로 색상칩에 focus가 이동하면 코드창/편집창 selection 기준을 잃을 수 있다.
    // keyboard activation은 유지하되 mouse activation에서는 기존 textarea selection을 보존한다.
    event.preventDefault();
  });
  button.addEventListener('click', event => {
    if (suppressNextColorChipClick || event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    applyColorCode(item.code);
  });
  return button;
}

function syncCopyOptionToolbar() {
  const prefs = getPreferences();
  if (copyIncludeColorToggle) copyIncludeColorToggle.checked = prefs.editorCopyIncludeColorCodes !== false;
  if (copyLineBreakLiteralToggle) copyLineBreakLiteralToggle.checked = prefs.editorCopyUseLineBreakLiterals !== false;
  const unicodeMode = ['escape', 'glyph', 'omit'].includes(prefs.editorCopyUnicodeMode) ? prefs.editorCopyUnicodeMode : getDefaultEditorCopyOptions().editorCopyUnicodeMode;
  const unicodeEnabled = unicodeMode !== 'omit';
  if (copyUnicodeToggle) copyUnicodeToggle.checked = unicodeEnabled;
  if (copyUnicodeModeSelect) {
    copyUnicodeModeSelect.value = unicodeMode === 'glyph' ? 'glyph' : 'escape';
    copyUnicodeModeSelect.disabled = !unicodeEnabled;
    copyUnicodeModeSelect.setAttribute('aria-disabled', unicodeEnabled ? 'false' : 'true');
  }
  if (copyIncludeColorText) {
    const enabled = prefs.editorCopyIncludeColorCodes !== false;
    copyIncludeColorText.textContent = enabled ? '색상기호 포함 (현재)' : '색상기호 미포함 (현재)';
    copyIncludeColorText.classList.toggle('copy-option-muted', !enabled);
  }
  if (copyLineBreakText) {
    copyLineBreakText.textContent = prefs.editorCopyUseLineBreakLiterals !== false ? '줄바꿈 문자 포함 (현재)' : '줄바꿈 적용 (현재)';
  }
}

function syncToolbarOptionToggles() {
  const prefs = getPreferences();
  if (newInputDefaultColorToggle) newInputDefaultColorToggle.checked = prefs.newInputDefaultColor === true;
  if (zeroWidthFallbackToolbarToggle) zeroWidthFallbackToolbarToggle.checked = prefs.zeroWidthFallbackEnabled !== false;
  if (codePaneExplicitDefaultColorToggle) codePaneExplicitDefaultColorToggle.checked = prefs.codePaneExplicitDefaultColor === true;
  syncCopyOptionToolbar();
}

async function setEditorCopyOptionFromToolbar(patch) {
  setEditorCopyOptions({ ...getPreferences(), ...(patch || {}) });
  syncCopyOptionToolbar();
  setStatusMessage('편집창 복사 옵션 변경');
}

async function resetEditorCopyOptionToolbar() {
  resetEditorCopyOptionsToDefault();
  syncCopyOptionToolbar();
  setStatusMessage('편집창 복사 옵션 기본값');
}

async function setNewInputDefaultColorFromToolbar(checked) {
  setPreferences({ newInputDefaultColor: checked === true });
  syncToolbarOptionToggles();
  setStatusMessage(checked ? '새 입력 시 기본 색: 켜짐' : '새 입력 시 기본 색: 꺼짐');
}

async function setZeroWidthFallbackFromToolbar(checked) {
  setPreferences({ zeroWidthFallbackEnabled: checked !== false });
  syncToolbarOptionToggles();
  setStatusMessage(checked ? 'U+2060 대체 글꼴: 켜짐' : 'U+2060 대체 글꼴: 꺼짐');
}

async function setCodePaneExplicitDefaultColorFromToolbar(checked) {
  const enabled = checked === true;
  setPreferences({ codePaneExplicitDefaultColor: enabled });
  normalizeOpenDocumentsExplicitDefaultRepresentation(enabled);
  syncToolbarOptionToggles();
  syncTextAreasFromState(enabled ? '코드창 ÿc0 반영: 켜짐' : '코드창 ÿc0 반영: 꺼짐');
}

function ensureOptionToolbar() {
  if (optionToolbarRoot) return;
  if (!toolbarRoot) return;
  optionToolbarRoot = document.createElement('section');
  optionToolbarRoot.className = 'color-option-strip';
  optionToolbarRoot.setAttribute('aria-label', '색상 입력 옵션 도구모음');
  const defaultColorLabel = document.createElement('label');
  defaultColorLabel.className = 'tool-check color-input-default-option copy-option-control';
  defaultColorLabel.dataset.tooltip = '새로 입력하는 일반 문자를 기본색으로 추가합니다. 붙여넣기와 코드창 입력에는 적용하지 않습니다.';
  newInputDefaultColorToggle = document.createElement('input');
  newInputDefaultColorToggle.type = 'checkbox';
  newInputDefaultColorToggle.id = 'newInputDefaultColorToolbarToggle';
  const defaultColorText = document.createElement('span');
  defaultColorText.textContent = '새 입력 시 기본 색';
  defaultColorLabel.append(newInputDefaultColorToggle, defaultColorText);

  const defaultColorSeparator = document.createElement('span');
  defaultColorSeparator.className = 'tool-separator default-color-separator';

  const fallbackLabel = document.createElement('label');
  fallbackLabel.className = 'tool-check color-zero-width-fallback-option';
  zeroWidthFallbackToolbarToggle = document.createElement('input');
  zeroWidthFallbackToolbarToggle.type = 'checkbox';
  zeroWidthFallbackToolbarToggle.id = 'zeroWidthFallbackToolbarToggle';
  const fallbackText = document.createElement('span');
  fallbackText.textContent = 'U+2060 입력 시 대체 글꼴';
  fallbackLabel.append(zeroWidthFallbackToolbarToggle, fallbackText);

  const explicitDefaultSeparator = document.createElement('span');
  explicitDefaultSeparator.className = 'tool-separator explicit-default-toolbar-separator';
  explicitDefaultSeparator.setAttribute('aria-hidden', 'true');

  const explicitDefaultLabel = document.createElement('label');
  explicitDefaultLabel.className = 'tool-check color-explicit-default-option copy-option-control';
  explicitDefaultLabel.dataset.tooltip = '켜면 코드창에서 생략된 기본색(ÿc0)도 표시하고, 명시적으로 적용한 ÿc0 토큰은 저장 데이터에 유지합니다.';
  codePaneExplicitDefaultColorToggle = document.createElement('input');
  codePaneExplicitDefaultColorToggle.type = 'checkbox';
  codePaneExplicitDefaultColorToggle.id = 'codePaneExplicitDefaultColorToggle';
  const explicitDefaultText = document.createElement('span');
  explicitDefaultText.textContent = '코드창 ÿc0 반영';
  explicitDefaultLabel.append(codePaneExplicitDefaultColorToggle, explicitDefaultText);

  const fallbackOptionGroup = document.createElement('div');
  fallbackOptionGroup.className = 'color-fallback-option-group';
  fallbackOptionGroup.append(fallbackLabel, explicitDefaultSeparator, explicitDefaultLabel);

  const copySeparator = document.createElement('span');
  copySeparator.className = 'tool-separator color-copy-separator';

  const copyGroup = document.createElement('div');
  copyGroup.className = 'editor-copy-options';
  const copyTitle = document.createElement('span');
  copyTitle.className = 'editor-copy-title';
  copyTitle.textContent = '편집창 복사 옵션';

  const copyColorLabel = document.createElement('label');
  copyColorLabel.className = 'tool-check copy-option-control copy-color-control';
  copyColorLabel.dataset.tooltip = '편집창 선택 영역을 복사할 때 ÿc 색상기호를 함께 복사합니다. 끄면 화면에 보이는 일반 텍스트만 복사합니다.';
  copyIncludeColorToggle = document.createElement('input');
  copyIncludeColorToggle.type = 'checkbox';
  copyIncludeColorToggle.id = 'editorCopyIncludeColorCodesToggle';
  copyIncludeColorText = document.createElement('span');
  copyIncludeColorText.className = 'copy-option-text';
  copyColorLabel.append(copyIncludeColorToggle, copyIncludeColorText);

  const copyLineLabel = document.createElement('label');
  copyLineLabel.className = 'tool-check copy-option-control copy-linebreak-control';
  copyLineLabel.dataset.tooltip = '켜면 줄바꿈을 실제 줄바꿈이 아니라 \\n 문자로 복사합니다. 끄면 줄바꿈이 적용된 상태로 복사합니다.';
  copyLineBreakLiteralToggle = document.createElement('input');
  copyLineBreakLiteralToggle.type = 'checkbox';
  copyLineBreakLiteralToggle.id = 'editorCopyLineBreakLiteralToggle';
  copyLineBreakText = document.createElement('span');
  copyLineBreakText.className = 'copy-option-text';
  copyLineLabel.append(copyLineBreakLiteralToggle, copyLineBreakText);

  const unicodeLabel = document.createElement('label');
  unicodeLabel.className = 'tool-check copy-unicode-control copy-option-control';
  unicodeLabel.dataset.tooltip = '체크하면 유니코드 기호를 선택한 형식으로 복사합니다. 해제하면 유니코드 기호를 제외하고 드롭다운을 잠급니다.';
  copyUnicodeToggle = document.createElement('input');
  copyUnicodeToggle.type = 'checkbox';
  copyUnicodeToggle.id = 'editorCopyUnicodeEnabledToggle';
  const unicodeText = document.createElement('span');
  unicodeText.className = 'copy-option-text';
  unicodeText.textContent = '유니코드';
  copyUnicodeModeSelect = document.createElement('select');
  copyUnicodeModeSelect.id = 'editorCopyUnicodeModeSelect';
  copyUnicodeModeSelect.className = 'tool-select editor-copy-unicode-select';
  copyUnicodeModeSelect.innerHTML = '<option value="escape">\\u 문자열로 복사 (기본값)</option><option value="glyph">글리프로 복사</option>';
  unicodeLabel.append(copyUnicodeToggle, unicodeText, copyUnicodeModeSelect);

  const copyDefaultButton = document.createElement('button');
  copyDefaultButton.id = 'editorCopyDefaultsButton';
  copyDefaultButton.className = 'tool-mini-button editor-copy-default-button copy-option-control';
  copyDefaultButton.type = 'button';
  copyDefaultButton.textContent = '기본값';
  copyDefaultButton.dataset.tooltip = '편집창 복사 옵션만 기본값으로 되돌립니다.';

  copyGroup.append(copyTitle, copyDefaultButton, copyColorLabel, copyLineLabel, unicodeLabel);
  attachImmediateTooltipDismiss(copyGroup);

  const scrollSyncLabel = document.getElementById('scrollSyncToggle')?.closest('label');
  if (scrollSyncLabel) {
    scrollSyncLabel.classList.add('color-scroll-sync-option', 'copy-option-control');
    scrollSyncLabel.dataset.tooltip = '코드창과 편집창 스크롤 위치를 행 기준으로 동기화합니다.';
    scrollSyncLabel.setAttribute('title', '코드창과 편집창 스크롤 위치를 행 기준으로 동기화합니다.');
  }
  const scrollSyncSeparator = document.createElement('span');
  scrollSyncSeparator.className = 'tool-separator scroll-sync-toolbar-separator';
  scrollSyncSeparator.setAttribute('aria-hidden', 'true');

  const themeToggleButton = document.getElementById('themeToggleButton');
  const themeSeparator = document.createElement('span');
  themeSeparator.className = 'tool-separator theme-toggle-toolbar-separator';
  themeSeparator.setAttribute('aria-hidden', 'true');

  optionToolbarRoot.append(defaultColorLabel, defaultColorSeparator, fallbackOptionGroup, copySeparator, copyGroup);
  if (scrollSyncLabel) optionToolbarRoot.append(scrollSyncSeparator, scrollSyncLabel);
  if (themeToggleButton) optionToolbarRoot.append(themeSeparator, themeToggleButton);
  attachImmediateTooltipDismiss(optionToolbarRoot);
  toolbarRoot.insertAdjacentElement('afterend', optionToolbarRoot);
  newInputDefaultColorToggle.addEventListener('change', () => { void setNewInputDefaultColorFromToolbar(newInputDefaultColorToggle.checked); });
  zeroWidthFallbackToolbarToggle.addEventListener('change', () => { void setZeroWidthFallbackFromToolbar(zeroWidthFallbackToolbarToggle.checked); });
  codePaneExplicitDefaultColorToggle.addEventListener('change', () => { void setCodePaneExplicitDefaultColorFromToolbar(codePaneExplicitDefaultColorToggle.checked); });
  copyIncludeColorToggle.addEventListener('change', () => { void setEditorCopyOptionFromToolbar({ editorCopyIncludeColorCodes: copyIncludeColorToggle.checked }); });
  copyLineBreakLiteralToggle.addEventListener('change', () => { void setEditorCopyOptionFromToolbar({ editorCopyUseLineBreakLiterals: copyLineBreakLiteralToggle.checked }); });
  copyUnicodeToggle.addEventListener('change', () => {
    const nextMode = copyUnicodeToggle.checked ? (copyUnicodeModeSelect.value === 'glyph' ? 'glyph' : 'escape') : 'omit';
    void setEditorCopyOptionFromToolbar({ editorCopyUnicodeMode: nextMode });
  });
  copyUnicodeModeSelect.addEventListener('change', () => {
    if (!copyUnicodeToggle.checked) return;
    void setEditorCopyOptionFromToolbar({ editorCopyUnicodeMode: copyUnicodeModeSelect.value === 'glyph' ? 'glyph' : 'escape' });
  });
  copyDefaultButton.addEventListener('click', () => { void resetEditorCopyOptionToolbar(); });
  window.addEventListener('ttedit-color-input-policy-changed', syncToolbarOptionToggles);
  document.addEventListener('tooltipeditor:preferences-changed', () => { syncRecognizedColorCodes(); syncToolbarOptionToggles(); renderColorToolbar(); syncTextAreasFromState('색상연결 변경'); scheduleOverlayRender({ reason: '색상연결 변경', preferFull: true, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, policy: 'preferences-changed' }); });
  syncRecognizedColorCodes();
  syncToolbarOptionToggles();
}


function attachImmediateTooltipDismiss(root) {
  const getControl = (target) => target?.closest?.('.color-chip, .copy-option-control') || null;
  const suppress = (control) => {
    if (!control || !root.contains(control)) return;
    control.classList.add('tooltip-suppressed');
  };
  const releaseIfLeft = (event) => {
    const control = getControl(event.target);
    if (!control || !root.contains(control)) return;
    if (event.relatedTarget && control.contains(event.relatedTarget)) return;
    control.classList.remove('tooltip-suppressed');
  };
  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    suppress(getControl(event.target));
  }, true);
  root.addEventListener('click', (event) => {
    suppress(getControl(event.target));
  }, true);
  root.addEventListener('pointerout', releaseIfLeft, true);
  root.addEventListener('focusout', releaseIfLeft, true);
}


function renderColorToolbar() {
  if (!toolbarRoot) return;
  hoveredColorCode = '';
  colorChipDrag = null;
  suppressNextColorChipClick = false;
  toolbarRoot.innerHTML = '';
  const toolbar = getToolbarColorPalette(effectiveColorPreferencesForRuntime());
  for (const item of toolbar.fnItems) toolbarRoot.appendChild(makeColorChip(item));
  if (toolbar.hasFn && toolbar.normalItems.length) {
    const separator = document.createElement('span');
    separator.className = 'color-chip-separator';
    separator.setAttribute('aria-hidden', 'true');
    toolbarRoot.appendChild(separator);
  }
  for (const item of toolbar.normalItems) toolbarRoot.appendChild(makeColorChip(item));
}

function ensureToolbar() {
  if (toolbarRoot) return;
  const renderStrip = document.querySelector('.render-strip');
  const appShell = document.querySelector('.app-shell');
  if (!renderStrip || !appShell) return;
  toolbarRoot = document.createElement('section');
  toolbarRoot.className = 'color-strip';
  toolbarRoot.setAttribute('aria-label', '색상 도구모음');
  renderColorToolbar();
  attachImmediateTooltipDismiss(toolbarRoot);
  renderStrip.insertAdjacentElement('afterend', toolbarRoot);
  ensureOptionToolbar();
}

function installColorShortcuts() {
  if (colorShortcutInstalled) return;
  colorShortcutInstalled = true;
  document.addEventListener('keydown', (event) => {
    const fn = isFnKeyEvent(event);
    if (fn && hoveredColorCode && !hasBlockingModal() && !event.target?.closest?.('.modal-window, .menu-bar, .floating-window')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      assignFnShortcutToColor(hoveredColorCode, fn);
      return;
    }
    if (fn && isDocumentShortcutTarget() && !hasBlockingModal()) {
      const fnMap = getColorFnShortcutMap(effectiveColorPreferencesForRuntime());
      const code = fnMap.get(fn);
      if (!code) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      applyColorCode(code);
      return;
    }
    if (!event.ctrlKey || !event.altKey || event.metaKey || event.isComposing) return;
    const active = document.activeElement;
    if (active !== editorElement && active !== codeElement) return;
    const key = String(event.key || '').toUpperCase();
    const maps = getColorShortcutMaps(getPreferences());
    const code = maps.exact.get(key) || maps.ignoreShift.get(key);
    if (!code) return;
    event.preventDefault();
    event.stopPropagation();
    applyColorCode(code);
  }, true);
}

export function initColorToolbar({ editorElement: editor, codeElement: code } = {}) {
  editorElement = editor;
  codeElement = code;
  syncRecognizedColorCodes();
  ensureToolbar();
  ensureOptionToolbar();
  syncToolbarOptionToggles();
  ensureEditorColorLayer();
  window.addEventListener('resize', () => scheduleOverlayRender({ reason: 'resize', policy: 'resize' }));
  window.addEventListener('ttedit-color-input-policy-changed', () => scheduleOverlayRender({ reason: '색상 입력 정책 변경', preferFull: true, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, policy: 'color-input-policy' }));
  document.addEventListener('tooltipeditor:preferences-changed', () => scheduleOverlayRender({ reason: '환경설정 변경', preferFull: true, fullDelayMs: QUICK_OVERLAY_FULL_RENDER_IDLE_MS, policy: 'preferences-changed' }));
  window.addEventListener('ttedit-developer-mode-changed', () => {
    renderColorToolbar();
    scheduleOverlayRender({ reason: '개발자모드 변경', preferFull: false, policy: 'developer-mode-changed' });
  });
  installColorShortcuts();
}
