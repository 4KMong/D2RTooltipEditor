import { state } from './state.js';
import { rawCodeContainsZeroWidth2060 } from './rawCodeModel.js';
import { setStatusMessage, setStatusSlot } from './statusBar.js';

export const LARGE_TEXT_RAW_LENGTH_LIMIT = 35000;
export const LARGE_TEXT_VISIBLE_LENGTH_LIMIT = 15000;
export const LARGE_TEXT_LINE_COUNT_LIMIT = 1000;

let editorText = null;
let codeText = null;
let editorWrapToggle = null;
let codeWrapToggle = null;
let active = false;
const keepColorOverlay = true;
let lastAnalysis = {
  active: false,
  rawLength: 0,
  visibleLength: 0,
  lineCount: 1,
  reason: 'empty',
  rawPlain: true,
  hasZeroWidth: false,
  hasTab: false,
};
let pendingExactAnalysisTimer = 0;
const LARGE_TEXT_EXACT_ANALYSIS_IDLE_MS = 520;
const LARGE_TEXT_DIAGNOSTIC_INPUT_THROTTLE_MS = 220;
let lastDynamicDiagnosticAt = 0;

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function setRootDatasetValue(key, value) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (document.documentElement.dataset.developerMode !== 'true') return;
  const next = String(value ?? '');
  if (document.documentElement.dataset[key] !== next) document.documentElement.dataset[key] = next;
}

function setLargeTextAnalysisDiagnostics(mode, elapsedMs) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  setRootDatasetValue('largeTextAnalysisMode', mode);
  if (Number.isFinite(elapsedMs)) setRootDatasetValue('largeTextAnalysisLastMs', elapsedMs.toFixed(1));
}

function scanVisibleStats(rawCode = '') {
  const source = String(rawCode ?? '');
  let visibleLength = 0;
  let lineCount = 1;
  let rawPlain = true;
  const hasZeroWidth = rawCodeContainsZeroWidth2060(source);
  let hasTab = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === 'ÿ') rawPlain = false;
    if (ch === '\\') rawPlain = false;
    if (ch === '\t') hasTab = true;
    if (source.startsWith('ÿc', i) && i + 2 < source.length) {
      i += 2;
      continue;
    }
    visibleLength += 1;
    if (ch === '\n') lineCount += 1;
  }
  return { visibleLength, lineCount, rawPlain, hasZeroWidth, hasTab };
}

function applyTextareaWrap(textarea, enabled, forced = false) {
  if (!textarea) return;
  textarea.wrap = enabled ? 'soft' : 'off';
  textarea.classList.toggle('wrap-enabled', enabled);
  textarea.classList.toggle('wrap-disabled', !enabled);
  textarea.dataset.largeTextWrapForced = forced ? 'true' : 'false';
}

function computeReason({ rawLength, visibleLength, lineCount }) {
  const reasons = [];
  if (rawLength >= LARGE_TEXT_RAW_LENGTH_LIMIT) reasons.push('raw-length');
  if (visibleLength >= LARGE_TEXT_VISIBLE_LENGTH_LIMIT) reasons.push('visible-length');
  if (lineCount >= LARGE_TEXT_LINE_COUNT_LIMIT) reasons.push('line-count');
  return reasons.join('+') || 'normal';
}

export function analyzeLargeTextMode(rawCode = state.rawCode) {
  const startedAt = nowMs();
  const raw = String(rawCode ?? '');
  const rawLength = raw.length;
  const { visibleLength, lineCount, rawPlain, hasZeroWidth, hasTab } = scanVisibleStats(raw);
  const reason = computeReason({ rawLength, visibleLength, lineCount });
  const analysis = {
    active: reason !== 'normal',
    rawLength,
    visibleLength,
    lineCount,
    reason,
    rawPlain,
    hasZeroWidth,
    hasTab,
  };
  setLargeTextAnalysisDiagnostics('exact', nowMs() - startedAt);
  return analysis;
}

function inputDataBreaksPlainRaw(options = {}) {
  const data = typeof options.data === 'string' ? options.data : '';
  return data.includes('ÿ') || data.includes('\\');
}

function fastInputAnalysis(rawCode = state.rawCode, options = {}) {
  const startedAt = nowMs();
  const raw = String(rawCode ?? '');
  const rawLength = raw.length;
  const editorValue = typeof options.editorValue === 'string' ? options.editorValue : null;
  const visibleLength = editorValue ? editorValue.length : Math.min(lastAnalysis.visibleLength || 0, rawLength);
  // 입력 중에는 전체 raw scan을 피한다. 줄 수는 직전 exact 값을 유지하고,
  // idle exact 분석에서 다시 보정한다. 대용량 해제 판정도 idle exact에서 수행한다.
  const lineCount = Math.max(1, Number(lastAnalysis.lineCount) || 1);
  const reason = computeReason({ rawLength, visibleLength, lineCount });
  const analysis = {
    active: lastAnalysis.active || reason !== 'normal',
    rawLength,
    visibleLength,
    lineCount,
    reason: lastAnalysis.active && reason === 'normal' ? lastAnalysis.reason : reason,
    rawPlain: lastAnalysis.rawPlain !== false && !inputDataBreaksPlainRaw(options),
    hasZeroWidth: lastAnalysis.hasZeroWidth === true || rawCodeContainsZeroWidth2060(options.data || ''),
    hasTab: lastAnalysis.hasTab === true || String(options.data || '').includes('\t'),
  };
  setLargeTextAnalysisDiagnostics('fast-input', nowMs() - startedAt);
  return analysis;
}

function scheduleExactLargeTextAnalysis() {
  if (pendingExactAnalysisTimer) clearTimeout(pendingExactAnalysisTimer);
  pendingExactAnalysisTimer = setTimeout(() => {
    pendingExactAnalysisTimer = 0;
    refreshLargeTextMode({ exact: true });
  }, LARGE_TEXT_EXACT_ANALYSIS_IDLE_MS);
}

export function isLargeTextModeActive() { return active; }
export function getLargeTextModeAnalysis() { return { ...lastAnalysis, keepColorOverlay }; }

function updateDiagnostics(analysis, options = {}) {
  const fastInput = options.fastInput === true;
  const now = Date.now();
  const writeDynamic = !fastInput || now - lastDynamicDiagnosticAt >= LARGE_TEXT_DIAGNOSTIC_INPUT_THROTTLE_MS;
  setRootDatasetValue('largeTextMode', analysis.active ? 'on' : 'off');
  setRootDatasetValue('largeTextReason', analysis.reason);
  if (writeDynamic) {
    setRootDatasetValue('largeTextRawLength', analysis.rawLength);
    setRootDatasetValue('largeTextVisibleLength', analysis.visibleLength);
    setRootDatasetValue('largeTextLineCount', analysis.lineCount);
    lastDynamicDiagnosticAt = now;
  }
  setRootDatasetValue('largeTextColorOverlay', 'on');
  setRootDatasetValue('largeTextRawPlain', analysis.rawPlain === false ? 'no' : 'yes');
  setRootDatasetValue('largeTextHasZeroWidth', analysis.hasZeroWidth === true ? 'yes' : 'no');
  setRootDatasetValue('largeTextHasTab', analysis.hasTab === true ? 'yes' : 'no');
  document.body?.classList.toggle('large-text-mode', analysis.active);
  document.body?.classList.toggle('large-text-color-overlay', analysis.active && keepColorOverlay);
}

function updateStatusSlot(analysis) {
  if (!analysis.active) {
    setStatusSlot('mode', '', { visible: false });
    return;
  }
  const text = keepColorOverlay ? '대용량 모드 · 색상 표시' : '대용량 모드';
  setStatusSlot('mode', text, { label: '모드', order: 10, visible: true, type: 'mode', tone: 'warning' });
}


function applyEffectiveWrapPolicy(analysis) {
  const forced = !!analysis.active;
  if (forced) {
    applyTextareaWrap(editorText, false, true);
    applyTextareaWrap(codeText, false, true);
  } else {
    applyTextareaWrap(editorText, editorWrapToggle ? !!editorWrapToggle.checked : true, false);
    applyTextareaWrap(codeText, codeWrapToggle ? !!codeWrapToggle.checked : true, false);
  }
  for (const toggle of [editorWrapToggle, codeWrapToggle]) {
    if (!toggle) continue;
    toggle.disabled = forced;
    toggle.closest?.('label')?.classList.toggle('large-text-wrap-disabled', forced);
    if (forced) toggle.closest?.('label')?.setAttribute('data-tip', '대용량 모드에서는 행번호/커서 안정성을 위해 자동 줄바꿈을 임시로 끕니다.');
    else toggle.closest?.('label')?.removeAttribute('data-tip');
  }
}

export function refreshLargeTextMode(options = {}) {
  const previous = active;
  const rawCode = options.rawCode ?? state.rawCode;
  const useFastInput = options.input === true && active && options.exact !== true;
  const analysis = useFastInput ? fastInputAnalysis(rawCode, options) : analyzeLargeTextMode(rawCode);
  if (useFastInput) scheduleExactLargeTextAnalysis();
  active = analysis.active;
  lastAnalysis = analysis;
  updateDiagnostics(analysis, { fastInput: useFastInput });
  updateStatusSlot(analysis);
  applyEffectiveWrapPolicy(analysis);
  if (previous !== active) {
    try { window.dispatchEvent(new CustomEvent('ttedit-large-text-mode-changed', { detail: analysis })); } catch (_) {}
    if (options.showStatus || active) {
      setStatusMessage(
        active
          ? `대용량 최적화 ON: 편집창은 화면 주변 구간만 불러오며 색상 표시는 계속 유지합니다 (${analysis.visibleLength.toLocaleString('ko-KR')}자 / ${analysis.lineCount.toLocaleString('ko-KR')}행)`
          : '대용량 모드 OFF: 자동 줄바꿈 설정 복귀',
        { timeout: active ? 2600 : 1800 }
      );
    }
  }
  return analysis;
}

export function applyLargeTextWrapPolicy(options = {}) {
  return refreshLargeTextMode(options);
}

export function initLargeTextMode({ editorElement, codeElement, editorToggle, codeToggle } = {}) {
  editorText = editorElement || editorText;
  codeText = codeElement || codeText;
  editorWrapToggle = editorToggle || editorWrapToggle;
  codeWrapToggle = codeToggle || codeWrapToggle;
  window.addEventListener('ttedit-document-view-synced', event => {
    if (event?.detail?.input === true) return;
    refreshLargeTextMode();
  });
  window.addEventListener('ttedit-rendering-changed', () => refreshLargeTextMode());
  refreshLargeTextMode();
}
