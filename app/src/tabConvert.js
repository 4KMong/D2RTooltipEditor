import { parseRawCode, normalizeRawCode, normalizeClipboardToRawFragment, isRawColorCodeAt, rawCodeToVisibleText } from './rawCodeModel.js';
import { COLOR_PREFIX, DEFAULT_COLOR_CODE } from './colorPalette.js';

const TAB_CHAR = '\t';
const BLACK_CODE = `${COLOR_PREFIX}6`;
const COLOR_CODE_LENGTH = 3;
const DEFAULT_DOT_WIDTH = 7;
const DEFAULT_SPACE_WIDTH = 7;
const DEFAULT_FONT_SIZE_PT = 25;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function cssLengthPt(value, fallback = DEFAULT_FONT_SIZE_PT) {
  const n = clampNumber(value, 1, 2000, fallback);
  return `${n}pt`;
}

function escapeText(text = '') { return String(text ?? ''); }

let domMeasureBox = null;
function ensureDomMeasureBox() {
  if (typeof document === 'undefined') return null;
  if (domMeasureBox && document.body.contains(domMeasureBox)) return domMeasureBox;
  domMeasureBox = document.createElement('span');
  domMeasureBox.className = 'tab-convert-measure-box';
  domMeasureBox.setAttribute('aria-hidden', 'true');
  domMeasureBox.style.position = 'fixed';
  domMeasureBox.style.left = '-100000px';
  domMeasureBox.style.top = '-100000px';
  domMeasureBox.style.visibility = 'hidden';
  domMeasureBox.style.pointerEvents = 'none';
  domMeasureBox.style.whiteSpace = 'pre';
  domMeasureBox.style.fontKerning = 'none';
  domMeasureBox.style.fontVariantLigatures = 'none';
  domMeasureBox.style.fontFeatureSettings = '"kern" 0, "liga" 0, "clig" 0';
  document.body.appendChild(domMeasureBox);
  return domMeasureBox;
}

function applyMeasureStyle(el, rendering = {}, editorElement = null) {
  if (!el) return;
  const computed = typeof getComputedStyle === 'function' && editorElement ? getComputedStyle(editorElement) : null;
  if (computed) {
    for (const prop of ['font-family', 'font-size', 'line-height', 'font-weight', 'letter-spacing', 'word-spacing', 'font-kerning', 'font-variant-ligatures', 'font-feature-settings', 'text-rendering']) {
      const value = computed.getPropertyValue(prop);
      if (value) el.style.setProperty(prop, value);
    }
  } else {
    if (rendering.fontFamily) el.style.fontFamily = rendering.fontFamily;
    el.style.fontSize = cssLengthPt(rendering.fontSizePt, DEFAULT_FONT_SIZE_PT);
    el.style.lineHeight = cssLengthPt(rendering.lineHeightPt || rendering.fontSizePt, rendering.fontSizePt || DEFAULT_FONT_SIZE_PT);
  }
  el.style.tabSize = String(Math.round(clampNumber(rendering.tabWidth, 1, 32, 4)));
}

export function createTabWidthMeasurer(rendering = {}, { editorElement = null } = {}) {
  const box = ensureDomMeasureBox();
  if (box) applyMeasureStyle(box, rendering, editorElement);
  const pxPerPt = 96 / 72;
  const approxChar = Math.max(1, Number(rendering.fontSizePt || DEFAULT_FONT_SIZE_PT) * pxPerPt * 0.52);
  const tabColumns = Math.round(clampNumber(rendering.tabWidth, 1, 32, 4));
  const cache = new Map();
  return function measure(text) {
    const value = escapeText(text);
    if (!value) return 0;
    const key = value.length <= 512 ? value : null;
    if (key && cache.has(key)) return cache.get(key);
    let width = 0;
    if (box) {
      box.textContent = value;
      width = box.getBoundingClientRect().width;
    }
    if (!Number.isFinite(width) || width <= 0) {
      width = 0;
      for (const ch of Array.from(value)) width += ch === TAB_CHAR ? approxChar * tabColumns : approxChar;
    }
    if (key) cache.set(key, width);
    return width;
  };
}

// New tab fillers must stay safe when copied into common quoted code/JSON strings.
// Do not generate quote delimiters, backslashes, or control characters.
const TAB_FILLER_CANDIDATES = ['.', ',', ':', ';', '!', '|', '·', ' '];
// Keep recognizing fillers produced by older builds so "탭 문자로 복원" remains backward-compatible.
const TAB_FILLER_LEGACY_RESTORE_CANDIDATES = ['.', ',', ':', ';', "'", '"', '`', '!', '|', '·', ' '];
const TAB_FILLER_RESTORE_CHAR_SET = new Set(TAB_FILLER_LEGACY_RESTORE_CANDIDATES);
const TAB_FILLER_NON_SPACE = TAB_FILLER_CANDIDATES.filter(ch => ch !== ' ');
const TAB_FILLER_WIDTH_QUANTUM = 0.25;
const TAB_FILLER_VERIFY_WINDOW = 18;
const TAB_FILLER_MAX_CATALOG_LEN = 96;

function isTabFillerChar(ch) {
  return TAB_FILLER_RESTORE_CHAR_SET.has(ch);
}

function fallbackCandidateWidthMap(measure = null) {
  const widths = new Map();
  for (const ch of TAB_FILLER_CANDIDATES) {
    const measured = typeof measure === 'function' ? measure(ch) : NaN;
    const fallback = ch === ' ' ? DEFAULT_SPACE_WIDTH : DEFAULT_DOT_WIDTH;
    widths.set(ch, Number.isFinite(measured) && measured > 0 ? measured : fallback);
  }
  return widths;
}

function fillerStats(text = '') {
  const chars = Array.from(String(text));
  const nonSpace = chars.filter(ch => ch !== ' ').length;
  const uniqueNonSpace = new Set(chars.filter(ch => ch !== ' ')).size;
  return { length: chars.length, nonSpace, uniqueNonSpace };
}

function compareFillerCandidate(a, b) {
  if (!b) return -1;
  const errorDelta = a.error - b.error;
  if (Math.abs(errorDelta) > 0.05) return errorDelta;
  if (a.uniqueNonSpace !== b.uniqueNonSpace) return b.uniqueNonSpace - a.uniqueNonSpace;
  if (a.length !== b.length) return a.length - b.length;
  if (a.nonSpace !== b.nonSpace) return b.nonSpace - a.nonSpace;
  return a.text.localeCompare(b.text);
}

function compareFillerShape(a, b) {
  if (!b) return -1;
  if (a.uniqueNonSpace !== b.uniqueNonSpace) return b.uniqueNonSpace - a.uniqueNonSpace;
  if (a.length !== b.length) return a.length - b.length;
  if (a.nonSpace !== b.nonSpace) return b.nonSpace - a.nonSpace;
  return a.text.localeCompare(b.text);
}

function binarySearchFillerCatalog(catalog, width) {
  let lo = 0, hi = catalog.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (catalog[mid].width < width) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function createTabFillerSelector({ dotWidth = DEFAULT_DOT_WIDTH, spaceWidth = DEFAULT_SPACE_WIDTH, measure = null, maxTargetWidth = 256 } = {}) {
  const widthMap = fallbackCandidateWidthMap(measure);
  if (!widthMap.has('.')) widthMap.set('.', Math.max(1, Number(dotWidth) || DEFAULT_DOT_WIDTH));
  if (!widthMap.has(' ')) widthMap.set(' ', Math.max(1, Number(spaceWidth) || DEFAULT_SPACE_WIDTH));
  const widths = TAB_FILLER_CANDIDATES.map(ch => ({ ch, width: Math.max(0.1, Number(widthMap.get(ch)) || (ch === ' ' ? spaceWidth : dotWidth)) }));
  const minWidth = Math.max(0.1, Math.min(...widths.map(item => item.width).filter(v => Number.isFinite(v) && v > 0)));
  const maxCharWidth = Math.max(...widths.map(item => item.width).filter(v => Number.isFinite(v) && v > 0));
  let catalog = [];
  let catalogMaxWidth = 0;

  const makeCatalogItem = (text, width) => ({ text, width, ...fillerStats(text) });

  const betterShape = (candidate, previous) => compareFillerShape(candidate, previous) < 0;

  function ensureCatalog(requestedTarget) {
    const requested = Math.max(1, Number(requestedTarget) || 1);
    if (catalog.length && catalogMaxWidth >= requested + maxCharWidth) return;
    const maxWidth = Math.max(32, Math.min(4096, Math.max(requested, Number(maxTargetWidth) || 1) + maxCharWidth * 3));
    const maxLen = Math.max(1, Math.min(TAB_FILLER_MAX_CATALOG_LEN, Math.ceil(maxWidth / minWidth) + 4));
    const maxQ = Math.ceil(maxWidth / TAB_FILLER_WIDTH_QUANTUM);
    const empty = { text: '', width: 0, length: 0, nonSpace: 0, uniqueNonSpace: 0 };
    let frontier = new Map([[0, empty]]);
    const catalogByQ = new Map();

    for (let len = 1; len <= maxLen; len++) {
      const next = new Map();
      for (const item of frontier.values()) {
        for (const { ch, width } of widths) {
          const nextWidth = item.width + width;
          if (nextWidth > maxWidth) continue;
          const text = item.text + ch;
          const q = Math.round(nextWidth / TAB_FILLER_WIDTH_QUANTUM);
          if (q < 0 || q > maxQ) continue;
          const candidate = makeCatalogItem(text, nextWidth);
          const prevNext = next.get(q);
          if (!prevNext || betterShape(candidate, prevNext)) next.set(q, candidate);
          const prevCatalog = catalogByQ.get(q);
          if (!prevCatalog || betterShape(candidate, prevCatalog)) catalogByQ.set(q, candidate);
        }
      }
      if (!next.size) break;
      frontier = next;
    }

    catalog = Array.from(catalogByQ.values()).sort((a, b) => a.width - b.width || compareFillerShape(a, b));
    if (!catalog.length) catalog = TAB_FILLER_NON_SPACE.map(ch => makeCatalogItem(ch, widthMap.get(ch) || DEFAULT_DOT_WIDTH));
    catalogMaxWidth = maxWidth;
  }

  function select(targetWidth, { prefixText = '', prefixWidth = null, targetAbsoluteWidth = null } = {}) {
    const target = Math.max(1, Number(targetWidth) || 1);
    ensureCatalog(target);
    const prefix = String(prefixText || '');
    const measuredPrefix = Number.isFinite(Number(prefixWidth)) ? Math.max(0, Number(prefixWidth)) : (typeof measure === 'function' ? Math.max(0, Number(measure(prefix)) || 0) : 0);
    const absoluteTarget = Number.isFinite(Number(targetAbsoluteWidth)) ? Number(targetAbsoluteWidth) : measuredPrefix + target;
    const insertAt = binarySearchFillerCatalog(catalog, target);
    const candidates = [];
    const seen = new Set();
    const addCandidate = (item) => {
      if (!item?.text || seen.has(item.text)) return;
      seen.add(item.text);
      candidates.push(item);
    };
    for (let i = Math.max(0, insertAt - TAB_FILLER_VERIFY_WINDOW); i < Math.min(catalog.length, insertAt + TAB_FILLER_VERIFY_WINDOW + 1); i++) addCandidate(catalog[i]);
    for (const ch of TAB_FILLER_NON_SPACE) addCandidate(makeCatalogItem(ch, widthMap.get(ch) || DEFAULT_DOT_WIDTH));

    let best = null;
    for (const item of candidates) {
      let width = item.width;
      if (typeof measure === 'function') {
        const measured = Number(measure(prefix + item.text)) - measuredPrefix;
        if (Number.isFinite(measured) && measured > 0) width = measured;
      }
      const error = Math.abs((measuredPrefix + width) - absoluteTarget);
      const candidate = { ...item, width, error, target };
      if (compareFillerCandidate(candidate, best) < 0) best = candidate;
    }
    return best?.text || '.';
  }

  return { select, ensureCatalog, widthMap };
}

export function buildTabFillerForWidth(targetWidth, {
  dotWidth = DEFAULT_DOT_WIDTH,
  spaceWidth = DEFAULT_SPACE_WIDTH,
  measure = null,
  prefixText = '',
  prefixWidth = null,
  targetAbsoluteWidth = null,
} = {}) {
  const selector = createTabFillerSelector({ dotWidth, spaceWidth, measure, maxTargetWidth: Math.max(32, Number(targetWidth) || 32) });
  return selector.select(targetWidth, { prefixText, prefixWidth, targetAbsoluteWidth });
}

function countActualTabs(rawCode = '') {
  return (String(rawCode || '').match(/\t/g) || []).length;
}

function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function createConversionContext(rendering = {}, { measure = null, editorElement = null } = {}) {
  const measurer = typeof measure === 'function' ? measure : createTabWidthMeasurer(rendering, { editorElement });
  const widthOfDot = Math.max(1, measurer('.') || DEFAULT_DOT_WIDTH);
  const widthOfSpace = Math.max(1, measurer(' ') || DEFAULT_SPACE_WIDTH);
  const tabWidthPx = Math.max(widthOfSpace, measurer(TAB_CHAR) || widthOfSpace * Math.round(clampNumber(rendering.tabWidth, 1, 32, 4)));
  const selector = createTabFillerSelector({
    dotWidth: widthOfDot,
    spaceWidth: widthOfSpace,
    measure: measurer,
    maxTargetWidth: Math.max(tabWidthPx * 1.6, widthOfSpace * 16, 64),
  });
  selector.ensureCatalog(Math.max(tabWidthPx * 1.6, widthOfSpace * 16, 64));
  return { measurer, widthOfDot, widthOfSpace, selector };
}

function convertTabToken({ token, logicalLineText, renderedLineText, context }) {
  const { measurer, selector } = context;
  const targetAbsolute = Math.max(1, measurer(`${logicalLineText}${TAB_CHAR}`) || 0);
  const renderedWidth = Math.max(0, measurer(renderedLineText) || 0);
  const target = Math.max(1, targetAbsolute - renderedWidth);
  const filler = selector.select(target, {
    prefixText: renderedLineText,
    prefixWidth: renderedWidth,
    targetAbsoluteWidth: targetAbsolute,
  });
  const restoreColor = isRawColorCodeAt(token.color || '', 0) ? token.color : DEFAULT_COLOR_CODE;
  return { raw: BLACK_CODE + filler + restoreColor, filler };
}

export function convertTabsToFillers(rawCode, { rendering = {}, measure = null, editorElement = null } = {}) {
  const model = parseRawCode(rawCode);
  const context = createConversionContext(rendering, { measure, editorElement });
  let logicalLineText = '';
  let renderedLineText = '';
  let converted = 0;
  let out = '';

  for (const token of model.tokens) {
    if (token.type === 'color') {
      out += token.raw;
      continue;
    }
    if (token.visibleText === TAB_CHAR) {
      const convertedTab = convertTabToken({ token, logicalLineText, renderedLineText, context });
      out += convertedTab.raw;
      logicalLineText += TAB_CHAR;
      renderedLineText += convertedTab.filler;
      converted += 1;
      continue;
    }
    out += token.raw;
    if (token.visibleText === '\n') {
      logicalLineText = '';
      renderedLineText = '';
    } else {
      logicalLineText += token.visibleText;
      renderedLineText += token.visibleText;
    }
  }
  return { rawCode: out, converted, changed: out !== model.rawCode };
}

export async function convertTabsToFillersAsync(rawCode, { rendering = {}, measure = null, editorElement = null, onProgress = null, chunkTabs = 12 } = {}) {
  const model = parseRawCode(rawCode);
  const total = countActualTabs(model.rawCode);
  let logicalLineText = '';
  let renderedLineText = '';
  let converted = 0;
  let out = '';
  let tabsSinceYield = 0;
  let lastYieldAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const report = async (phase = 'converting', force = false) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const shouldYield = force || tabsSinceYield >= chunkTabs || now - lastYieldAt >= 14;
    if ((shouldYield || phase === 'done') && typeof onProgress === 'function') onProgress({ done: converted, total, phase });
    if (shouldYield) {
      tabsSinceYield = 0;
      lastYieldAt = now;
      await yieldToBrowser();
    }
  };

  await report('start', true);
  const context = createConversionContext(rendering, { measure, editorElement });
  await report('measure-ready', true);
  for (const token of model.tokens) {
    if (token.type === 'color') {
      out += token.raw;
      continue;
    }
    if (token.visibleText === TAB_CHAR) {
      const convertedTab = convertTabToken({ token, logicalLineText, renderedLineText, context });
      out += convertedTab.raw;
      logicalLineText += TAB_CHAR;
      renderedLineText += convertedTab.filler;
      converted += 1;
      tabsSinceYield += 1;
      await report('converting');
      continue;
    }
    out += token.raw;
    if (token.visibleText === '\n') {
      logicalLineText = '';
      renderedLineText = '';
    } else {
      logicalLineText += token.visibleText;
      renderedLineText += token.visibleText;
    }
  }
  await report('done', true);
  return { rawCode: out, converted, changed: out !== model.rawCode };
}

function activeColorAfterRaw(rawFragment, inheritedColor = DEFAULT_COLOR_CODE) {
  const source = normalizeRawCode(rawFragment);
  let color = isRawColorCodeAt(inheritedColor, 0) ? inheritedColor : DEFAULT_COLOR_CODE;
  for (let i = 0; i < source.length; i++) {
    if (isRawColorCodeAt(source, i)) {
      color = source.slice(i, i + COLOR_CODE_LENGTH);
      i += COLOR_CODE_LENGTH - 1;
    }
  }
  return color;
}

function startsWithColorCode(source, index) {
  return isRawColorCodeAt(source, index);
}

function suffixStartsWithVisibleTarget(source, index) {
  const visible = rawCodeToVisibleText(source.slice(index));
  return Array.from(visible).some(ch => !/\s/u.test(ch));
}

function normalizeRestoreReplacement({ mode = 'tab', customText = '' } = {}) {
  if (mode === 'custom') return normalizeClipboardToRawFragment(String(customText ?? ''), { preserveColorCodes: true });
  return TAB_CHAR;
}

function readTabFillerUnit(source, index, activeBeforeBlack) {
  if (!source.startsWith(BLACK_CODE, index)) return null;
  let j = index + COLOR_CODE_LENGTH;
  while (j < source.length && isTabFillerChar(source[j])) j += 1;
  if (j <= index + COLOR_CODE_LENGTH) return null;
  if (source.startsWith(activeBeforeBlack, j)) j += COLOR_CODE_LENGTH;
  return { end: j };
}

export function restoreTabFillers(rawCode, options = {}) {
  const source = normalizeRawCode(rawCode);
  const replacement = normalizeRestoreReplacement(options);
  const customScope = options.customScope === 'all-consecutive' ? 'all-consecutive' : 'per-tab';
  let out = '';
  let restored = 0;
  let active = DEFAULT_COLOR_CODE;

  for (let i = 0; i < source.length; i++) {
    const unit = readTabFillerUnit(source, i, active);
    if (unit) {
      const activeBeforeBlack = active;
      let end = unit.end;
      let count = 1;
      if (options.mode === 'custom' && customScope === 'all-consecutive') {
        while (true) {
          const next = readTabFillerUnit(source, end, activeBeforeBlack);
          if (!next) break;
          end = next.end;
          count += 1;
        }
      }
      const replacementRun = options.mode === 'custom' && customScope === 'all-consecutive' ? replacement : replacement.repeat(count);
      out += replacementRun;
      const replacementEndColor = activeColorAfterRaw(replacementRun, activeBeforeBlack);
      const needsRestore = replacementEndColor !== activeBeforeBlack && !startsWithColorCode(source, end) && suffixStartsWithVisibleTarget(source, end);
      if (needsRestore) out += activeBeforeBlack;
      active = activeBeforeBlack;
      restored += count;
      i = end - 1;
      continue;
    }
    if (isRawColorCodeAt(source, i)) {
      active = source.slice(i, i + COLOR_CODE_LENGTH);
      out += active;
      i += COLOR_CODE_LENGTH - 1;
      continue;
    }
    out += source[i];
  }
  return { rawCode: out, restored, changed: out !== source, replacement };
}
