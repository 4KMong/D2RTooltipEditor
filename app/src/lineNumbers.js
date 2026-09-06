import { normalizeNewlines } from "./textCodec.js";
import { isLargeTextModeActive } from "./largeTextMode.js";

let editor = null;
let gutter = null;
let inner = null;
let measurer = null;
let resizeObserver = null;
let lastMetrics = [];
let lineNumberIdleTimer = 0;
let lastRenderedLineCount = 0;
let lastRenderedWrapDisabled = false;
let lastLineNumberDiagnosticKey = '';

const HEAVY_LINE_VALUE_LENGTH = 80000;
const HEAVY_LINE_COUNT = 1200;
const HEAVY_LINE_MAX_LOGICAL_CHARS = 6000;
const HEAVY_LINE_FULL_RENDER_IDLE_MS = 900;
const HARD_LINE_VALUE_LENGTH = 180000;
const HARD_LINE_COUNT = 3000;
const HARD_LINE_MAX_LOGICAL_CHARS = 18000;

const MEASURE_PROPS = [
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent',
  'text-rendering', 'text-transform', 'tab-size', 'direction', 'unicode-bidi',
  'font-kerning', 'font-variant-ligatures', 'font-variant-caps',
  'font-feature-settings', 'font-variation-settings', '-webkit-font-smoothing',
];

function lineHeightPx() {
  const cs = getComputedStyle(editor);
  const lh = Number.parseFloat(cs.lineHeight);
  if (Number.isFinite(lh) && lh > 0) return lh;
  const fs = Number.parseFloat(cs.fontSize) || 15;
  return fs * 1.45;
}

function ensureMeasurer() {
  if (measurer || !editor) return measurer;
  measurer = document.createElement('div');
  measurer.className = 'line-measurer';
  measurer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(measurer);
  return measurer;
}

function contentWidthPx(cs = getComputedStyle(editor)) {
  const paddingLeft = Number.parseFloat(cs.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(cs.paddingRight) || 0;
  const raw = editor.clientWidth - paddingLeft - paddingRight;
  return Math.max(1, Math.floor(raw));
}

function syncMeasurerStyle() {
  const node = ensureMeasurer();
  if (!node || !editor) return;
  const cs = getComputedStyle(editor);
  for (const prop of MEASURE_PROPS) {
    const value = cs.getPropertyValue(prop);
    if (value) node.style.setProperty(prop, value);
  }
  node.style.width = `${contentWidthPx(cs)}px`;
  node.style.whiteSpace = editor.classList.contains('wrap-disabled') ? 'pre' : 'pre-wrap';
  node.style.overflowWrap = editor.classList.contains('wrap-disabled') ? 'normal' : (cs.overflowWrap || 'anywhere');
  node.style.wordBreak = cs.wordBreak || 'normal';
  node.style.boxSizing = 'content-box';
}

function syncGutterStyle() {
  if (!editor || !gutter || !inner) return;
  const cs = getComputedStyle(editor);
  const lh = `${lineHeightPx()}px`;
  gutter.style.fontFamily = '';
  gutter.style.fontSize = '';
  gutter.style.lineHeight = lh;
  inner.style.paddingTop = cs.paddingTop;
  inner.style.paddingBottom = cs.paddingBottom;
}

function measureLogicalLineHeight(text, baseHeight = lineHeightPx()) {
  const node = ensureMeasurer();
  if (!node) return baseHeight;
  node.textContent = text && text.length ? text : ' ';
  const measured = Math.ceil(node.getBoundingClientRect().height || node.scrollHeight || baseHeight);
  return Math.max(baseHeight, measured);
}

function shouldUseLightweightLineNumbers(value, lines) {
  if (value.length >= HEAVY_LINE_VALUE_LENGTH) return true;
  if (lines.length >= HEAVY_LINE_COUNT) return true;
  for (const line of lines) if (line.length >= HEAVY_LINE_MAX_LOGICAL_CHARS) return true;
  return false;
}

function shouldSkipFullLineNumberMeasurement(value, lines) {
  if (value.length >= HARD_LINE_VALUE_LENGTH) return true;
  if (lines.length >= HARD_LINE_COUNT) return true;
  for (const line of lines) if (line.length >= HARD_LINE_MAX_LOGICAL_CHARS) return true;
  return false;
}

function setLineNumberDiagnostics(mode, lineCount, elapsedMs) {
  const root = document.documentElement;
  if (!root || root.dataset.developerMode !== 'true') return;
  const key = `${mode}|${lineCount || 0}|${Number.isFinite(elapsedMs) ? elapsedMs.toFixed(1) : ''}`;
  if ((mode === 'large-skip-input-fast' || mode === 'event-input-dedup-skip') && key === lastLineNumberDiagnosticKey) return;
  lastLineNumberDiagnosticKey = key;
  if (root.dataset.editorLineNumberMode !== String(mode)) root.dataset.editorLineNumberMode = String(mode);
  const count = String(lineCount || 0);
  if (root.dataset.editorLineNumberCount !== count) root.dataset.editorLineNumberCount = count;
  if (Number.isFinite(elapsedMs)) {
    const ms = elapsedMs.toFixed(1);
    if (root.dataset.editorLineNumberLastMs !== ms) root.dataset.editorLineNumberLastMs = ms;
  }
}

function isNonLineChangingInput(options = {}) {
  const inputType = String(options.inputType || '');
  const data = typeof options.data === 'string' ? options.data : '';
  if (data.includes('\n') || data.includes('\r')) return false;
  if (inputType === 'insertText' || inputType === 'insertCompositionText' || inputType === 'insertReplacementText') return true;
  return false;
}

function scheduleHeavyLineNumberFullRender() {
  if (lineNumberIdleTimer) clearTimeout(lineNumberIdleTimer);
  lineNumberIdleTimer = setTimeout(() => {
    lineNumberIdleTimer = 0;
    updateLineNumbers({ forceFull: true });
  }, HEAVY_LINE_FULL_RENDER_IDLE_MS);
}

function rowsToHtml(lines, getHeight, baseLineHeight) {
  const chunks = [];
  for (let i = 0; i < lines.length; i++) {
    const height = getHeight(lines[i], i);
    chunks.push(`<div class="line-number-row" style="height:${height}px;line-height:${baseLineHeight}px">${i + 1}</div>`);
  }
  return chunks.join('');
}

export function initLineNumbers({ editorElement, gutterElement, innerElement }) {
  editor = editorElement;
  gutter = gutterElement;
  inner = innerElement;
  editor.addEventListener("input", event => updateLineNumbers({ input: true, inputType: event?.inputType || '', data: event?.data || '' }));
  editor.addEventListener("scroll", syncLineNumberScroll, { passive: true });
  window.addEventListener('ttedit-document-view-synced', event => {
    if (event?.detail?.input === true) {
      setLineNumberDiagnostics('event-input-dedup-skip', lastRenderedLineCount, 0);
      return;
    }
    requestAnimationFrame(updateLineNumbers);
  });
  window.addEventListener('ttedit-rendering-changed', () => requestAnimationFrame(updateLineNumbers));
  window.addEventListener('resize', () => requestAnimationFrame(updateLineNumbers));
  if (document.fonts?.ready) document.fonts.ready.then(() => requestAnimationFrame(updateLineNumbers)).catch(() => {});
  if (window.ResizeObserver) {
    resizeObserver = new ResizeObserver(updateLineNumbers);
    resizeObserver.observe(editor);
  }
  updateLineNumbers();
}

export function updateLineNumbers(options = {}) {
  if (!editor || !inner) return;
  const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const forceFull = options && options.forceFull === true;
  const inputUpdate = options && options.input === true;
  const largeMode = isLargeTextModeActive();
  const wrapDisabled = editor.classList.contains('wrap-disabled');
  if (largeMode && inputUpdate && !forceFull && isNonLineChangingInput(options) && lastRenderedLineCount > 0 && wrapDisabled === lastRenderedWrapDisabled) {
    setLineNumberDiagnostics('large-skip-input-fast', lastRenderedLineCount, 0);
    syncLineNumberScroll();
    return;
  }
  syncGutterStyle();
  const value = normalizeNewlines(editor.value);
  const lines = value.split("\n");
  const baseLineHeight = lineHeightPx();
  if (largeMode && inputUpdate && !forceFull && lines.length === lastRenderedLineCount && wrapDisabled === lastRenderedWrapDisabled) {
    setLineNumberDiagnostics('large-skip-input', lines.length, 0);
    syncLineNumberScroll();
    return;
  }
  const hardLightweight = largeMode || shouldSkipFullLineNumberMeasurement(value, lines);
  const lightweight = hardLightweight || (!forceFull && shouldUseLightweightLineNumbers(value, lines));
  lastMetrics = [];
  let top = 0;

  if (lightweight) {
    for (let i = 0; i < lines.length; i++) {
      const height = baseLineHeight;
      lastMetrics.push({ top, height, bottom: top + height });
      top += height;
    }
    inner.innerHTML = rowsToHtml(lines, () => baseLineHeight, baseLineHeight);
    lastRenderedLineCount = lines.length;
    lastRenderedWrapDisabled = wrapDisabled;
    if (!hardLightweight) scheduleHeavyLineNumberFullRender();
    const endedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    setLineNumberDiagnostics(largeMode ? 'large-logical' : hardLightweight ? 'lightweight' : 'lightweight-deferred', lines.length, endedAt - startedAt);
    syncLineNumberScroll();
    return;
  }

  if (lineNumberIdleTimer) { clearTimeout(lineNumberIdleTimer); lineNumberIdleTimer = 0; }
  syncMeasurerStyle();
  const heights = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const height = measureLogicalLineHeight(lines[i], baseLineHeight);
    heights[i] = height;
    lastMetrics.push({ top, height, bottom: top + height });
    top += height;
  }
  inner.innerHTML = rowsToHtml(lines, (_line, i) => heights[i] || baseLineHeight, baseLineHeight);
  lastRenderedLineCount = lines.length;
  lastRenderedWrapDisabled = wrapDisabled;
  const endedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  setLineNumberDiagnostics(forceFull ? 'full-idle' : 'full', lines.length, endedAt - startedAt);
  syncLineNumberScroll();
}

export function syncLineNumberScroll() {
  if (!editor || !inner) return;
  inner.style.transform = `translateY(${-editor.scrollTop}px)`;
}

export function getLineMetrics() { return lastMetrics.slice(); }

export function lineAtScrollTop(scrollTop = editor?.scrollTop ?? 0) {
  const y = Math.max(0, Number(scrollTop) || 0);
  if (!lastMetrics.length) return 1;
  let lo = 0, hi = lastMetrics.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lastMetrics[mid].bottom <= y) { lo = mid + 1; }
    else { ans = mid; hi = mid - 1; }
  }
  return Math.max(1, Math.min(lastMetrics.length, ans + 1));
}

export function scrollEditorToLine(lineNumber, ratio = 0.5) {
  if (!editor) return;
  const idx = Math.max(0, Math.min((Number.parseInt(lineNumber, 10) || 1) - 1, Math.max(0, lastMetrics.length - 1)));
  const metric = lastMetrics[idx] || { top: 0 };
  editor.scrollTop = Math.max(0, metric.top - editor.clientHeight * ratio);
  syncLineNumberScroll();
}
