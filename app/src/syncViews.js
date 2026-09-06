import { state, setRawCode, resetDocument, getDisplayFileName, recordEditAction, getActiveDocument, setActiveDocumentId } from "./state.js";
import { renderDocumentTabs } from "./documentTabs.js";
import { setDocumentStatus, setStatusMessage, setCodeStatusMessage } from "./statusBar.js";
import { normalizeNewlines } from "./textCodec.js";
import { containsColorCodes } from "./colorText.js";
import { rawCodeToVisibleText, makeRawCodePatch, normalizePlainTextToRawFragment, normalizeClipboardToRawFragment, rawOffsetAtVisibleOffset, primeRawIndexAfterPlainInsert, normalizeInitialDefaultColorToken } from "./rawCodeModel.js";
import { DEFAULT_COLOR_CODE } from "./colorPalette.js";
import { getColorInputPolicy } from './colorInputPolicy.js';
import { getPreferences } from './preferences.js';
import { htmlToD2rRawFragment } from './externalColorPaste.js';
import { updateLineNumbers, scrollEditorToLine } from "./lineNumbers.js";
import { refreshLargeTextMode, isLargeTextModeActive, analyzeLargeTextMode, getLargeTextModeAnalysis, LARGE_TEXT_RAW_LENGTH_LIMIT, LARGE_TEXT_VISIBLE_LENGTH_LIMIT, LARGE_TEXT_LINE_COUNT_LIMIT } from "./largeTextMode.js";
import { setFloatingWindowInactive } from "./floatingWindow.js";
import { isLargeEditorViewportActive, isLargeEditorPointerSelectionActive } from './largeEditorViewport.js';

let codeText = null;
let editorText = null;
let externalChangeCallback = null;

let pendingBeforeInput = new WeakMap();
let composingElement = null;
let compositionSnapshot = null;
let pendingCompositionCommit = null;
let nextCompositionCommitId = 1;
let largeCompositionPointerSelection = null;
let largeCompositionPointerIntent = null;
let largeCompositionPointerDown = false;
let largeCompositionPointerContentDown = false;
let largeCompositionPointerRestoreFrame = 0;
let largeCompositionPointerScrollGuard = null;
let lastUserEditorScroll = null;
let userEditorScrollArmedUntil = 0;
let lastUserEditorScrollIntentAt = 0;
let lastLargeEditorCompositionEndAt = 0;
let editorPointerDownShouldAutoRevealCaret = false;
let editorMeasureCanvas = null;
let editorMeasureFont = '';
let editorMeasureNode = null;
let editorMeasureNodeStyleKey = '';
let typingGroup = null;
let typingGroupTimer = null;
let largeDeferredUndoGroup = null;
let largeDeferredUndoTimer = null;
const TYPING_GROUP_IDLE_MS = 650;
const LARGE_DEFERRED_UNDO_IDLE_MS = 1100;
const LARGE_INPUT_STATUS_THROTTLE_MS = 180;
const DIAGNOSTIC_WRITE_THROTTLE_MS = 180;
const LARGE_TEXT_CODE_SYNC_DELAY_MS = 140;
const COMPOSITION_CODE_SYNC_DELAY_MS = 260;
let deferredCodeSyncTimer = 0;
let largeCompositionNativeActive = false;
let largeInputStatusTimer = 0;
let lastLargeInputStatusAt = 0;
let pendingLargeInputStatus = null;
let lastDiagnosticWriteAt = 0;
let lastUndoDiagnosticsMode = '';


let codePanePauseNotice = null;
let codePanePauseNoticeText = null;
let codePanePaused = false;
const CODE_PANE_PAUSED_STATUS = 'Live 중지 (대용량모드)';
const CODE_PANE_PAUSED_STATUS_DETAIL = '편집/저장은 정상처리됨';

function shouldPauseCodePaneForLargeText(rawCode = state.rawCode) {
  try {
    return isLargeTextModeActive() || analyzeLargeTextMode(rawCode).active;
  } catch (_) {
    return isLargeTextModeActive();
  }
}

function thresholdText(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('ko-KR');
}

function codePanePauseMessage() {
  return `대용량 모드에서는 입력 지연을 줄이기 위해 코드창 기능을 일시 중단합니다.

대용량 모드가 해제되면 다시 표시합니다.

문서 저장/편집은 정상처리 됩니다.

대용량 모드에서는 일부 기능이 작동하지 않거나 불완전하게 작동할 수 있습니다.

[대용량모드 진입 기준]
- 전체 문자 수 : ${thresholdText(LARGE_TEXT_RAW_LENGTH_LIMIT)}자 이상 (코드창 기준)
- 실제 표시 문자 : ${thresholdText(LARGE_TEXT_VISIBLE_LENGTH_LIMIT)}자 이상 (색상코드 제외한 기준)
- 줄 수 : ${thresholdText(LARGE_TEXT_LINE_COUNT_LIMIT)}행 이상`;
}

function ensureCodePanePauseNotice() {
  if (codePanePauseNotice || !codeText) return codePanePauseNotice;
  const pane = codeText.closest('.code-pane') || codeText.parentElement;
  if (!pane) return null;
  pane.classList.add('code-pane-pause-host');
  const notice = document.createElement('div');
  notice.className = 'code-pane-large-pause-notice';
  notice.setAttribute('aria-hidden', 'true');
  notice.hidden = true;
  const noticeText = document.createElement('div');
  noticeText.className = 'code-pane-large-pause-notice-text';
  notice.appendChild(noticeText);
  pane.appendChild(notice);
  codePanePauseNotice = notice;
  codePanePauseNoticeText = noticeText;
  return codePanePauseNotice;
}

function applyCodePanePauseState(paused, options = {}) {
  if (!codeText) return false;
  const next = paused === true;
  const pane = codeText.closest('.code-pane') || codeText.parentElement;
  const changed = codePanePaused !== next;
  codePanePaused = next;
  if (pane) pane.classList.toggle('code-pane-large-paused', next);
  codeText.readOnly = next;
  codeText.setAttribute('aria-disabled', next ? 'true' : 'false');
  const notice = ensureCodePanePauseNotice();
  if (notice) {
    const target = codePanePauseNoticeText || notice.querySelector?.('.code-pane-large-pause-notice-text') || notice;
    target.textContent = codePanePauseMessage();
    notice.hidden = !next;
  }
  if (next) {
    if (codeText.value !== '') codeText.value = '';
    codeText.scrollTop = 0;
    codeText.scrollLeft = 0;
    if (document.activeElement === codeText && editorText) editorText.focus({ preventScroll: true });
    if ((changed || options.showStatus) && options.showStatus !== false) {
      setCodeStatusMessage(CODE_PANE_PAUSED_STATUS, { type: 'warning', tone: 'warning', detail: CODE_PANE_PAUSED_STATUS_DETAIL });
    }
  } else {
    setCodeStatusMessage('준비됨', { type: 'info' });
  }
  if (changed) {
    try { window.dispatchEvent(new CustomEvent('ttedit-code-pane-pause-changed', { detail: { paused: next } })); } catch (_) {}
  }
  return changed;
}

function refreshCodePanePauseState(options = {}) {
  const paused = shouldPauseCodePaneForLargeText();
  const changed = applyCodePanePauseState(paused, options);
  if (!paused && (changed || options.forceSync === true)) {
    state.isSyncing = true;
    codeText.value = state.rawCode;
    state.isSyncing = false;
  }
  return paused;
}

export function isCodePaneDisplayPaused() {
  return codePanePaused || shouldPauseCodePaneForLargeText();
}

function showCodePanePausedStatus() {
  setCodeStatusMessage(CODE_PANE_PAUSED_STATUS, { type: 'warning', tone: 'warning', detail: CODE_PANE_PAUSED_STATUS_DETAIL });
}

function clearDeferredCodeSyncTimer() {
  if (deferredCodeSyncTimer) {
    clearTimeout(deferredCodeSyncTimer);
    deferredCodeSyncTimer = 0;
  }
}

function syncCodeFromDocumentDeferred(delayMs = LARGE_TEXT_CODE_SYNC_DELAY_MS) {
  if (!codeText) return;
  clearDeferredCodeSyncTimer();
  if (shouldPauseCodePaneForLargeText()) {
    applyCodePanePauseState(true);
    return;
  }
  deferredCodeSyncTimer = setTimeout(() => {
    deferredCodeSyncTimer = 0;
    syncCodeFromDocument();
    try { window.dispatchEvent(new CustomEvent('ttedit-code-view-deferred-sync', { detail: { documentId: state.activeDocumentId } })); } catch (_) {}
  }, Math.max(0, Number(delayMs) || 0));
}

export function flushDeferredCodeSync() {
  if (shouldPauseCodePaneForLargeText()) {
    clearDeferredCodeSyncTimer();
    applyCodePanePauseState(true, { showStatus: true });
    return false;
  }
  if (!deferredCodeSyncTimer) return false;
  clearDeferredCodeSyncTimer();
  syncCodeFromDocument();
  return true;
}

function shouldDeferCodeSyncForEditorInput(isComposing = false) {
  return isComposing || shouldPauseCodePaneForLargeText();
}


function setLargeCompositionNativeMode(active) {
  const next = active === true;
  if (largeCompositionNativeActive === next) return;
  largeCompositionNativeActive = next;
  // The visual class is owned by colorCodes.js. Toggling it here as well
  // causes off→on body class churn at Korean IME syllable boundaries.
  setRootDatasetValue('editorCompositionSyncMode', next ? 'large-native-deferred' : 'normal');
}

function shouldDeferLargeCompositionRawSync(source, isComposing) {
  return source === 'editor' && isComposing && isLargeTextModeActive();
}

function clearTypingGroupTimer() {
  if (typingGroupTimer) {
    clearTimeout(typingGroupTimer);
    typingGroupTimer = null;
  }
}

function commitTypingGroup() {
  clearTypingGroupTimer();
  typingGroup = null;
}

function armTypingGroupTimer() {
  clearTypingGroupTimer();
  typingGroupTimer = setTimeout(() => { typingGroup = null; typingGroupTimer = null; }, TYPING_GROUP_IDLE_MS);
}

function setUndoDiagnostics(mode, extra = {}) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const nextMode = mode || 'normal';
  const now = Date.now();
  const throttleExtras = shouldThrottleDiagnosticMode(nextMode)
    && nextMode === lastUndoDiagnosticsMode
    && now - lastDiagnosticWriteAt < DIAGNOSTIC_WRITE_THROTTLE_MS;
  setRootDatasetValue('editorUndoMode', nextMode);
  if (!throttleExtras) {
    for (const [key, value] of Object.entries(extra || {})) setRootDatasetValue(key, value);
    lastDiagnosticWriteAt = now;
  }
  lastUndoDiagnosticsMode = nextMode;
}

function clearLargeDeferredUndoTimer() {
  if (largeDeferredUndoTimer) {
    clearTimeout(largeDeferredUndoTimer);
    largeDeferredUndoTimer = null;
  }
}

function flushLargeDeferredUndoGroup(reason = 'flush') {
  const group = largeDeferredUndoGroup;
  if (!group) return false;
  clearLargeDeferredUndoTimer();
  largeDeferredUndoGroup = null;
  if (group.docId !== state.activeDocumentId || group.afterRawCode === snapshotRawCode(group.startSnapshot)) {
    setUndoDiagnostics(`large-deferred-discard:${reason}`);
    return false;
  }
  const afterSnapshot = snapshotWithRawCode(captureDocumentSnapshot(group.source), group.afterRawCode, group.source);
  const recorded = recordEditAction({
    before: group.startSnapshot,
    after: afterSnapshot,
    actionType: 'typing',
    activeView: group.source,
    mergeKey: group.mergeKey,
    merge: false,
    selectionRestoreMode: group.selectionRestoreMode,
    storageMode: 'delta',
  });
  setUndoDiagnostics(recorded ? `large-delta-flush:${reason}` : `large-delta-noop:${reason}`, { editorUndoDeferredLength: group.afterRawCode.length });
  return recorded;
}

function armLargeDeferredUndoTimer() {
  clearLargeDeferredUndoTimer();
  largeDeferredUndoTimer = setTimeout(() => {
    largeDeferredUndoTimer = null;
    flushLargeDeferredUndoGroup('idle');
  }, LARGE_DEFERRED_UNDO_IDLE_MS);
}

const RAW_LINE_BREAK_LITERAL = '\\n';

function getPreferencesSafe() {
  try { return getPreferences(); } catch (_) { return {}; }
}

function setRootDatasetValue(key, value) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (document.documentElement.dataset.developerMode !== 'true') return;
  const next = String(value ?? '');
  if (document.documentElement.dataset[key] !== next) document.documentElement.dataset[key] = next;
}

function shouldThrottleDiagnosticMode(mode = '') {
  const text = String(mode || '');
  return text === 'large-deferred-pending' || text.startsWith('large-deferred-');
}

function isLargeEditorCompositionInProgress() {
  return composingElement === editorText && isLargeTextModeActive();
}

function isPointerInTextareaScrollbar(el, event) {
  if (!el || !event || typeof el.getBoundingClientRect !== 'function') return false;
  try {
    const rect = el.getBoundingClientRect();
    const x = Number(event.clientX) - rect.left;
    const y = Number(event.clientY) - rect.top;
    const hasHorizontal = (el.scrollWidth || 0) > (el.clientWidth || 0);
    const hasVertical = (el.scrollHeight || 0) > (el.clientHeight || 0);
    const horizontalSize = Math.max(0, (el.offsetHeight || 0) - (el.clientHeight || 0));
    const verticalSize = Math.max(0, (el.offsetWidth || 0) - (el.clientWidth || 0));
    const horizontalGutter = Math.max(12, horizontalSize || 0);
    const verticalGutter = Math.max(12, verticalSize || 0);
    if (hasHorizontal && y >= rect.height - horizontalGutter) return true;
    if (hasVertical && x >= rect.width - verticalGutter) return true;
  } catch (_) {}
  return false;
}

function editorPerfNow() {
  try {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  } catch (_) {
    return Date.now();
  }
}

function armUserEditorScrollIntent(durationMs = 250, reason = 'user-scroll') {
  const now = editorPerfNow();
  userEditorScrollArmedUntil = Math.max(userEditorScrollArmedUntil || 0, now + Math.max(0, Number(durationMs) || 0));
  lastUserEditorScrollIntentAt = now;
  setRootDatasetValue('editorUserScrollIntent', reason);
}

function rememberLastUserEditorScroll(reason = 'scroll') {
  if (!editorText) return null;
  const snapshot = {
    documentId: state.activeDocumentId,
    top: editorText.scrollTop || 0,
    left: editorText.scrollLeft || 0,
    at: Date.now(),
    perfAt: editorPerfNow(),
    reason,
  };
  lastUserEditorScroll = snapshot;
  setRootDatasetValue('editorLastUserScrollMode', reason);
  return snapshot;
}

function freshUserEditorScroll(maxAgeMs = 5000) {
  const item = lastUserEditorScroll;
  if (!item || item.documentId !== state.activeDocumentId) return null;
  if (Date.now() - Number(item.at || 0) > Math.max(0, Number(maxAgeMs) || 0)) return null;
  return { top: item.top || 0, left: item.left || 0, source: item.reason || 'user-scroll' };
}

function armLargeCompositionPointerScrollGuard(scroll = null, durationMs = 220, reason = 'guard') {
  if (!editorText || !scroll || state.activeDocumentId == null) return null;
  const now = editorPerfNow();
  largeCompositionPointerScrollGuard = {
    documentId: state.activeDocumentId,
    top: Math.max(0, Number(scroll.top) || 0),
    left: Math.max(0, Number(scroll.left) || 0),
    until: now + Math.max(0, Number(durationMs) || 0),
    issuedAt: now,
    reason,
  };
  setRootDatasetValue('editorCompositionPointerScrollGuard', reason);
  return largeCompositionPointerScrollGuard;
}

function applyLargeCompositionPointerScrollGuard(reason = 'guard') {
  // Native pointer selection owns the viewport until its release transaction has
  // fully settled. Reapplying an old IME scroll guard inside mousedown/mouseup can
  // abort Chromium/WebView2's textarea drag even without touching value/selection.
  if (isLargeEditorPointerSelectionActive()) return false;
  const guard = largeCompositionPointerScrollGuard;
  if (!editorText || !guard || guard.documentId !== state.activeDocumentId) return false;
  const now = editorPerfNow();
  if (now > Number(guard.until || 0)) {
    largeCompositionPointerScrollGuard = null;
    return false;
  }
  if (lastUserEditorScrollIntentAt > Number(guard.issuedAt || 0)) {
    largeCompositionPointerScrollGuard = null;
    setRootDatasetValue('editorCompositionPointerScrollRestore', `guard-cancel:user-scroll:${reason}`);
    return false;
  }
  const expectedTop = Math.max(0, Number(guard.top) || 0);
  const expectedLeft = Math.max(0, Number(guard.left) || 0);
  if (Math.abs((editorText.scrollTop || 0) - expectedTop) <= 1 && Math.abs((editorText.scrollLeft || 0) - expectedLeft) <= 1) return false;
  reapplyLargeCompositionIntentScroll({ top: expectedTop, left: expectedLeft }, `guard:${reason}`);
  return true;
}

function rememberLargeCompositionPointerDown(event = null) {
  // Discard any restore callback left by the preceding IME handoff before this
  // new pointer gesture starts. It is stale as soon as the user presses again.
  cancelLargeCompositionPointerRestoreFrame();
  largeCompositionPointerScrollGuard = null;
  const contentPointer = !!(editorText && !isPointerInTextareaScrollbar(editorText, event));
  const pendingLargeEditorComposition = !!(pendingCompositionCommit && pendingCompositionCommit.el === editorText && isLargeTextModeActive());
  const recentLargeEditorCompositionEnd = isLargeTextModeActive() && editorPerfNow() - Number(lastLargeEditorCompositionEndAt || 0) < 750;
  const compositionActive = isLargeEditorCompositionInProgress() || pendingLargeEditorComposition || recentLargeEditorCompositionEnd;
  largeCompositionPointerDown = !!(contentPointer && compositionActive);
  largeCompositionPointerContentDown = largeCompositionPointerDown;
  editorPointerDownShouldAutoRevealCaret = !!(contentPointer && editorText && isLargeTextModeActive() && (editorText.classList.contains('wrap-disabled') || editorText.wrap === 'off'));
  if (largeCompositionPointerDown) {
    let rect = null;
    try { rect = editorText?.getBoundingClientRect?.() || null; } catch (_) { rect = null; }
    const userScroll = freshUserEditorScroll(5000);
    const liveScroll = { top: editorText.scrollTop || 0, left: editorText.scrollLeft || 0 };
    const scroll = userScroll ? { top: userScroll.top, left: userScroll.left } : liveScroll;
    largeCompositionPointerIntent = {
      documentId: state.activeDocumentId,
      clientX: Number(event?.clientX) || 0,
      clientY: Number(event?.clientY) || 0,
      rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
      scroll,
      liveScroll,
      userScrollSource: userScroll?.source || '',
      createdAt: Date.now(),
      createdPerfAt: editorPerfNow(),
    };
    largeCompositionPointerSelection = null;
    if (userScroll) {
      armLargeCompositionPointerScrollGuard(scroll, 260, 'pointer-down');
      applyLargeCompositionPointerScrollGuard('pointer-down');
    }
    setRootDatasetValue('editorCompositionPointerMode', userScroll ? 'intent:user-scroll' : 'intent:live-scroll');
  } else {
    largeCompositionPointerIntent = null;
  }
}


function captureLargeCompositionPointerSelection(reason = 'pointer') {
  if (!editorText || state.activeDocumentId == null) return null;
  const selection = selectionOf(editorText);
  const scroll = { top: editorText.scrollTop || 0, left: editorText.scrollLeft || 0 };
  largeCompositionPointerSelection = {
    documentId: state.activeDocumentId,
    selection,
    scroll,
    reason,
    createdAt: Date.now(),
  };
  setRootDatasetValue('editorCompositionPointerMode', `captured:${reason}`);
  return largeCompositionPointerSelection;
}

function restoreLargeCompositionPointerSelection(reason = 'restore') {
  const pending = largeCompositionPointerSelection;
  const intent = largeCompositionPointerIntent;
  if (!editorText) return false;
  // Once the user has started a native drag, that gesture is the sole authority
  // for caret/selection. A delayed composition commit can otherwise refocus the
  // textarea, restore an old caret and reapply scroll while the mouse button is
  // still down, which aborts WebView2's selection transaction.
  if (isLargeEditorPointerSelectionActive()) {
    cancelLargeCompositionPointerRestoreFrame();
    largeCompositionPointerSelection = null;
    largeCompositionPointerIntent = null;
    largeCompositionPointerScrollGuard = null;
    largeCompositionPointerDown = false;
    largeCompositionPointerContentDown = false;
    editorPointerDownShouldAutoRevealCaret = false;
    setRootDatasetValue('editorCompositionPointerMode', `native-drag-authoritative:${reason}`);
    return false;
  }
  const activeDocumentId = state.activeDocumentId;
  const hasPending = !!(pending && pending.documentId === activeDocumentId);
  const hasIntent = !!(intent && intent.documentId === activeDocumentId);
  if (!hasPending && !hasIntent) return false;
  const now = Date.now();
  if (hasPending && now - Number(pending.createdAt || 0) > 2500) largeCompositionPointerSelection = null;
  if (hasIntent && now - Number(intent.createdAt || 0) > 2500) largeCompositionPointerIntent = null;
  const livePending = largeCompositionPointerSelection && largeCompositionPointerSelection.documentId === activeDocumentId ? largeCompositionPointerSelection : null;
  const liveIntent = largeCompositionPointerIntent && largeCompositionPointerIntent.documentId === activeDocumentId ? largeCompositionPointerIntent : null;
  if (!livePending && !liveIntent) return false;

  const scroll = liveIntent?.scroll || livePending?.scroll || null;
  const intentCaret = liveIntent ? caretOffsetFromLargePointerIntent(liveIntent) : null;
  const max = editorText.value.length;
  if (intentCaret !== null && intentCaret !== undefined) {
    const pos = Math.max(0, Math.min(Number(intentCaret) || 0, max));
    try {
      editorText.focus({ preventScroll: true });
      editorText.setSelectionRange(pos, pos);
    } catch (_) {}
  } else if (livePending?.selection) {
    const start = Math.max(0, Math.min(Number(livePending.selection.start) || 0, max));
    const end = Math.max(start, Math.min(Number(livePending.selection.end ?? start) || start, max));
    try {
      editorText.focus({ preventScroll: true });
      editorText.setSelectionRange(start, end);
    } catch (_) {}
  }

  if (scroll) {
    armLargeCompositionPointerScrollGuard(scroll, 260, `restore:${reason}`);
    reapplyLargeCompositionIntentScroll(scroll, `restore:${reason}`);
    try { queueMicrotask(() => applyLargeCompositionPointerScrollGuard(`restore-microtask:${reason}`)); } catch (_) {}
    cancelLargeCompositionPointerRestoreFrame();
    largeCompositionPointerRestoreFrame = requestAnimationFrame(() => {
      largeCompositionPointerRestoreFrame = 0;
      applyLargeCompositionPointerScrollGuard(`restore-raf:${reason}`);
    });
  }

  largeCompositionPointerSelection = null;
  largeCompositionPointerIntent = null;
  largeCompositionPointerScrollGuard = null;
  largeCompositionPointerDown = false;
  largeCompositionPointerContentDown = false;
  editorPointerDownShouldAutoRevealCaret = false;
  setRootDatasetValue('editorCompositionPointerMode', intentCaret !== null && intentCaret !== undefined ? `restored-caret:${reason}` : `restored:${reason}`);
  return true;
}

function editorMeasureContext() {
  if (typeof document === 'undefined') return null;
  if (!editorMeasureCanvas) editorMeasureCanvas = document.createElement('canvas');
  const ctx = editorMeasureCanvas.getContext?.('2d') || null;
  if (!ctx || !editorText) return ctx;
  try {
    const cs = getComputedStyle(editorText);
    const font = cs.font || `${cs.fontStyle || 'normal'} ${cs.fontVariant || 'normal'} ${cs.fontWeight || '400'} ${cs.fontSize || '16px'} ${cs.fontFamily || 'sans-serif'}`;
    if (editorMeasureFont !== font) {
      editorMeasureFont = font;
      ctx.font = font;
    }
  } catch (_) {}
  return ctx;
}

const EDITOR_WIDTH_MEASURE_PROPS = [
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch',
  'letter-spacing', 'word-spacing', 'text-rendering', 'text-transform',
  'tab-size', 'direction', 'unicode-bidi', 'font-kerning',
  'font-variant-ligatures', 'font-feature-settings', 'font-variation-settings',
  '-webkit-font-smoothing',
];

function ensureEditorWidthMeasureNode() {
  if (typeof document === 'undefined' || !document.body) return null;
  if (editorMeasureNode) return editorMeasureNode;
  editorMeasureNode = document.createElement('span');
  editorMeasureNode.setAttribute('aria-hidden', 'true');
  editorMeasureNode.style.position = 'absolute';
  editorMeasureNode.style.left = '-100000px';
  editorMeasureNode.style.top = '0';
  editorMeasureNode.style.zIndex = '-1';
  editorMeasureNode.style.visibility = 'hidden';
  editorMeasureNode.style.pointerEvents = 'none';
  editorMeasureNode.style.display = 'inline-block';
  editorMeasureNode.style.whiteSpace = 'pre';
  editorMeasureNode.style.contain = 'layout style paint';
  document.body.appendChild(editorMeasureNode);
  return editorMeasureNode;
}

function syncEditorWidthMeasureNodeStyle(node) {
  if (!node || !editorText) return;
  try {
    const cs = getComputedStyle(editorText);
    const parts = [];
    for (const prop of EDITOR_WIDTH_MEASURE_PROPS) {
      const value = cs.getPropertyValue(prop);
      parts.push(`${prop}:${value}`);
    }
    const key = parts.join(';');
    if (key === editorMeasureNodeStyleKey) return;
    editorMeasureNodeStyleKey = key;
    for (const prop of EDITOR_WIDTH_MEASURE_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value) node.style.setProperty(prop, value);
    }
    node.style.lineHeight = 'normal';
    node.style.whiteSpace = 'pre';
    node.style.overflowWrap = 'normal';
    node.style.wordBreak = 'normal';
  } catch (_) {}
}

function measureEditorTextWidthDom(text = '') {
  const value = String(text ?? '');
  if (!value) return 0;
  const node = ensureEditorWidthMeasureNode();
  if (!node) return null;
  syncEditorWidthMeasureNodeStyle(node);
  try {
    node.textContent = value;
    const rect = node.getBoundingClientRect?.();
    const width = rect?.width;
    if (Number.isFinite(width)) return Math.max(0, width);
  } catch (_) {}
  return null;
}

function measureEditorTextWidth(text = '') {
  const value = String(text ?? '');
  const domWidth = measureEditorTextWidthDom(value);
  if (domWidth !== null) return domWidth;
  const ctx = editorMeasureContext();
  if (ctx?.measureText) {
    try { return ctx.measureText(value.replace(/	/g, '    ')).width; } catch (_) {}
  }
  return value.length * 12;
}

// Shared with the large IME native band. This uses the same DOM-first glyph
// measurement as pointer/caret correction, so the mask starts at the exact
// rendered prefix width without rebuilding transient composition text.
export function measureEditorTextWidthForImeBand(text = '') {
  return measureEditorTextWidth(text);
}


function cancelLargeCompositionPointerRestoreFrame() {
  if (largeCompositionPointerRestoreFrame) {
    try { cancelAnimationFrame(largeCompositionPointerRestoreFrame); } catch (_) {}
    largeCompositionPointerRestoreFrame = 0;
  }
}

function editorTextMetricsForPointer() {
  let paddingLeft = 0;
  let paddingTop = 0;
  let lineHeight = 16;
  try {
    const cs = getComputedStyle(editorText);
    paddingLeft = Number.parseFloat(cs.paddingLeft || '0') || 0;
    paddingTop = Number.parseFloat(cs.paddingTop || '0') || 0;
    const fontSize = Number.parseFloat(cs.fontSize || '16') || 16;
    const parsedLineHeight = Number.parseFloat(cs.lineHeight || '');
    lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0 ? parsedLineHeight : Math.max(1, fontSize * 1.2);
  } catch (_) {}
  return { paddingLeft, paddingTop, lineHeight: Math.max(1, lineHeight) };
}

function lineStartOffsetForRow(text = '', row = 0) {
  const source = String(text ?? '');
  let targetRow = Math.max(0, Number(row) || 0);
  let start = 0;
  while (targetRow > 0) {
    const next = source.indexOf('\n', start);
    if (next < 0) return source.length;
    start = next + 1;
    targetRow -= 1;
  }
  return start;
}

function caretOffsetFromLargePointerIntent(intent = null) {
  if (!editorText || !intent?.rect || !intent?.scroll) return null;
  if (!(editorText.classList.contains('wrap-disabled') || editorText.wrap === 'off')) return null;
  const value = String(editorText.value || '');
  const metrics = editorTextMetricsForPointer();
  const y = Number(intent.clientY || 0) - Number(intent.rect.top || 0) + Number(intent.scroll.top || 0) - metrics.paddingTop;
  const row = Math.max(0, Math.floor(y / metrics.lineHeight));
  const lineStart = lineStartOffsetForRow(value, row);
  const lineEndIndex = value.indexOf('\n', lineStart);
  const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
  const line = value.slice(lineStart, lineEnd);
  const targetX = Math.max(0, Number(intent.clientX || 0) - Number(intent.rect.left || 0) + Number(intent.scroll.left || 0) - metrics.paddingLeft);
  if (!line) return lineStart;
  let lo = 0;
  let hi = line.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const width = measureEditorTextWidth(line.slice(0, mid));
    if (width <= targetX) lo = mid;
    else hi = mid - 1;
  }
  const leftWidth = measureEditorTextWidth(line.slice(0, lo));
  const rightWidth = lo < line.length ? measureEditorTextWidth(line.slice(0, lo + 1)) : Number.POSITIVE_INFINITY;
  const col = (lo < line.length && Math.abs(rightWidth - targetX) < Math.abs(targetX - leftWidth)) ? lo + 1 : lo;
  return Math.max(0, Math.min(lineStart + col, value.length));
}

function reapplyLargeCompositionIntentScroll(scroll = null, reason = 'pointer-intent') {
  if (!editorText || !scroll || isLargeEditorPointerSelectionActive()) return false;
  editorText.scrollTop = Math.max(0, Number(scroll.top) || 0);
  editorText.scrollLeft = Math.max(0, Number(scroll.left) || 0);
  setRootDatasetValue('editorCompositionPointerScrollRestore', reason);
  try { externalChangeCallback?.('scroll', 'editor'); } catch (_) {}
  return true;
}

function ensureEditorCaretHorizontallyVisibleInLargeNoWrap(options = {}) {
  // mouseup listeners run before the browser has fully committed native textarea
  // selection. Any programmatic scroll here can collapse the just-finished drag.
  if (!editorText || !isLargeTextModeActive() || isLargeEditorPointerSelectionActive()) return false;
  if (!(editorText.classList.contains('wrap-disabled') || editorText.wrap === 'off')) return false;
  const pos = Math.max(0, Math.min(editorText.selectionEnd ?? editorText.selectionStart ?? 0, editorText.value.length));
  const text = String(editorText.value || '');
  const lineStart = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  const prefix = text.slice(lineStart, pos);
  let paddingLeft = 0;
  let paddingRight = 0;
  try {
    const cs = getComputedStyle(editorText);
    paddingLeft = Number.parseFloat(cs.paddingLeft || '0') || 0;
    paddingRight = Number.parseFloat(cs.paddingRight || '0') || 0;
  } catch (_) {}
  const caretX = paddingLeft + measureEditorTextWidth(prefix);
  const viewportLeft = editorText.scrollLeft || 0;
  const viewportWidth = Math.max(1, (editorText.clientWidth || 1) - paddingLeft - paddingRight);
  const viewportRight = viewportLeft + viewportWidth;
  const margin = 12;
  if (caretX >= viewportLeft + margin && caretX <= viewportRight - margin) return false;
  const nextLeft = Math.max(0, Math.floor(caretX - viewportWidth / 2));
  if (Math.abs(nextLeft - viewportLeft) < 1) return false;
  editorText.scrollLeft = nextLeft;
  setRootDatasetValue('editorHorizontalCaretScroll', options.reason || 'caret-visible');
  try { externalChangeCallback?.('scroll', 'editor'); } catch (_) {}
  return true;
}

function notifyEditorCompositionOverlay(reason = 'composition-sync') {
  try {
    window.dispatchEvent(new CustomEvent('ttedit-editor-composition-sync', { detail: { documentId: state.activeDocumentId, reason } }));
  } catch (_) {}
}

function normalizeCodePaneRawInput(value) {
  return normalizeNewlines(value).replace(/\n/g, RAW_LINE_BREAK_LITERAL);
}

function codePaneNativeOffsetToRawOffset(value, offset) {
  const normalized = normalizeNewlines(value);
  const end = Math.max(0, Math.min(Number(offset) || 0, normalized.length));
  let rawOffset = 0;
  for (let i = 0; i < end; i++) rawOffset += normalized[i] === '\n' ? RAW_LINE_BREAK_LITERAL.length : 1;
  return rawOffset;
}

function editorProjectionText(rawCode = state.rawCode) {
  return rawCodeToVisibleText(rawCode);
}

function normalizeVisibleRange(start, end, max) {
  const a = Math.max(0, Math.min(Number(start) || 0, max));
  const b = Math.max(0, Math.min(Number(end ?? start) || a, max));
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function snapshotWithEditorSelection(snapshot, rawCode, editorSelection) {
  const pos = Math.max(0, Number(editorSelection?.start ?? editorSelection) || 0);
  const end = Math.max(pos, Number(editorSelection?.end ?? pos) || pos);
  return {
    ...(snapshot || {}),
    rawCode: normalizeNewlines(rawCode),
    text: normalizeNewlines(rawCode),
    activeView: 'editor',
    editorSelection: { start: pos, end },
  };
}

function visibleDiff(beforeVisible, afterVisible) {
  let prefix = 0;
  const minLength = Math.min(beforeVisible.length, afterVisible.length);
  while (prefix < minLength && beforeVisible[prefix] === afterVisible[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeVisible.length - prefix
    && suffix < afterVisible.length - prefix
    && beforeVisible[beforeVisible.length - 1 - suffix] === afterVisible[afterVisible.length - 1 - suffix]
  ) suffix += 1;
  return { prefix, beforeEnd: beforeVisible.length - suffix, replacement: afterVisible.slice(prefix, afterVisible.length - suffix) };
}

function selectionFromOptions(options = {}) {
  const sel = options.beforeSelection || options.selection || null;
  if (!sel) return null;
  const start = Math.max(0, Number(sel.start) || 0);
  const end = Math.max(start, Number(sel.end ?? sel.start) || start);
  return { start, end };
}

function anchoredReplacement(beforeVisible, afterVisible, start, end) {
  const prefix = beforeVisible.slice(0, start);
  const suffix = beforeVisible.slice(end);
  if (afterVisible.startsWith(prefix) && afterVisible.endsWith(suffix) && afterVisible.length >= prefix.length + suffix.length) {
    return afterVisible.slice(prefix.length, afterVisible.length - suffix.length);
  }
  return null;
}

function rangeForInputType(inputType, selection, oldLength) {
  if (!selection) return null;
  const type = String(inputType || '');
  let { start, end } = normalizeVisibleRange(selection.start, selection.end, oldLength);
  if (start !== end) return { start, end };
  if (type === 'deleteContentBackward') return { start: Math.max(0, start - 1), end: start };
  if (type === 'deleteWordBackward' || type === 'deleteHardLineBackward' || type === 'deleteSoftLineBackward') return { start: Math.max(0, start - 1), end: start };
  if (type === 'deleteContentForward') return { start, end: Math.min(oldLength, start + 1) };
  if (type === 'deleteWordForward' || type === 'deleteHardLineForward' || type === 'deleteSoftLineForward') return { start, end: Math.min(oldLength, start + 1) };
  return { start, end };
}

function rawFragmentFromEditorReplacement(replacement, options = {}) {
  const text = normalizeNewlines(replacement);
  if (!text) return '';
  const activeColor = options.newInputDefaultColor === true ? DEFAULT_COLOR_CODE : '';
  return activeColor ? normalizeClipboardToRawFragment(text, { activeColor, preserveColorCodes: false }) : normalizePlainTextToRawFragment(text);
}

function replacementIsPlainRawSafe(text = '') {
  const value = String(text ?? '');
  return !value.includes('ÿ') && !value.includes('\\') && !value.includes('\n') && !value.includes('\r');
}

function rawSyntaxSeamRisk(rawCode, rawStart, rawEnd, rawFragment = '') {
  const fragment = String(rawFragment ?? '');
  if (!fragment) return false;
  const source = normalizeNewlines(rawCode);
  const start = Math.max(0, Math.min(Number(rawStart) || 0, source.length));
  const end = Math.max(start, Math.min(Number(rawEnd) || start, source.length));
  const leftStart = Math.max(0, start - 6);
  const rightEnd = Math.min(source.length, end + 6);
  const left = source.slice(leftStart, start);
  const right = source.slice(end, rightEnd);
  const seam = left + fragment + right;
  const insertedStart = left.length;
  const insertedEnd = insertedStart + fragment.length;
  const overlapsInserted = (tokenStart, tokenEnd) => tokenStart < insertedEnd && tokenEnd > insertedStart;

  for (let i = 0; i < seam.length; i++) {
    let tokenEnd = 0;
    if (seam.startsWith('ÿc', i) && i + 3 <= seam.length) {
      tokenEnd = i + 3;
    } else if (seam.startsWith('\\n', i)) {
      tokenEnd = i + 2;
    } else if (seam[i] === '\\' && seam[i + 1] === 'u' && i + 6 <= seam.length && isHex4(seam.slice(i + 2, i + 6))) {
      tokenEnd = i + 6;
    }
    if (tokenEnd > 0 && overlapsInserted(i, tokenEnd)) return true;
  }
  return false;
}

function rawPlainDocumentSafe(rawCode = '') {
  const raw = String(rawCode ?? '');
  return !raw.includes('ÿ') && !raw.includes('\\');
}



function compositionReplacementFromLocalGuard(beforeVisible, afterVisible, selection, guardSize = 32) {
  if (!selection) return null;
  const start = Math.max(0, Number(selection.start) || 0);
  const end = Math.max(start, Number(selection.end ?? selection.start) || start);
  const replacedLength = end - start;
  const insertedLength = afterVisible.length - beforeVisible.length + replacedLength;
  if (insertedLength < 0) return null;
  const insertedEnd = start + insertedLength;
  if (insertedEnd > afterVisible.length) return null;
  const guardStart = Math.max(0, start - guardSize);
  if (afterVisible.slice(guardStart, start) !== beforeVisible.slice(guardStart, start)) return null;
  if (afterVisible.slice(insertedEnd, insertedEnd + guardSize) !== beforeVisible.slice(end, end + guardSize)) return null;
  return { start, end, insertedText: afterVisible.slice(start, insertedEnd) };
}

function tryBuildLargeCompositionTextDirect(snap) {
  if (!editorText || !snap || !isLargeTextModeActive()) return null;
  if (getColorInputPolicy().newInputDefaultColor === true) return null;
  const beforeSel = selectionFromOptions({ beforeSelection: snap.editorSelection });
  if (!beforeSel || beforeSel.start !== beforeSel.end) return null;
  const beforeRaw = normalizeNewlines(snapshotRawCode(snap));
  const rawEditorValue = normalizeNewlines(editorText.value || '');
  const beforeVisible = rawCodeToVisibleText(beforeRaw);
  const local = compositionReplacementFromLocalGuard(beforeVisible, rawEditorValue, beforeSel, 32);
  if (!local) return null;
  if (!local.insertedText || !replacementIsPlainRawSafe(local.insertedText)) return null;
  const rawStart = rawOffsetAtVisibleOffset(beforeRaw, local.start, 'start');
  const rawEnd = local.end === local.start ? rawStart : rawOffsetAtVisibleOffset(beforeRaw, local.end, 'end');
  if (rawStart < 0 || rawEnd < rawStart) return null;
  const rawFragment = normalizePlainTextToRawFragment(local.insertedText);
  if (rawSyntaxSeamRisk(beforeRaw, rawStart, rawEnd, rawFragment)) return null;
  const nextText = beforeRaw.slice(0, rawStart) + rawFragment + beforeRaw.slice(rawEnd);
  const storedNextText = normalizeEditorCommandLiterals(nextText);
  if (rawEnd === rawStart) {
    primeRawIndexAfterPlainInsert(beforeRaw, storedNextText, {
      rawStart,
      rawFragment,
      visibleStart: local.start,
      insertedVisibleText: local.insertedText,
    });
  }
  setRootDatasetValue('editorCompositionCommitMode', 'large-local-guard-direct');
  return { rawEditorValue, nextText: storedNextText, skipLiteralSync: true };
}

function tryBuildLargePlainCompositionText(snap) {
  if (!editorText || !snap || !isLargeTextModeActive()) return null;
  if (getColorInputPolicy().newInputDefaultColor === true) return null;
  const analysis = getLargeTextModeAnalysis();
  if (analysis.rawPlain === false) return null;
  const beforeRaw = normalizeNewlines(snapshotRawCode(snap));
  if (!rawPlainDocumentSafe(beforeRaw)) return null;
  const beforeSel = normalizeVisibleRange(snap.editorSelection?.start, snap.editorSelection?.end, beforeRaw.length);
  const rawEditorValue = normalizeNewlines(editorText.value || '');
  const afterPos = Math.max(0, Math.min(editorText.selectionEnd ?? editorText.selectionStart ?? beforeSel.start, rawEditorValue.length));
  const replacedLength = beforeSel.end - beforeSel.start;
  const insertedLength = rawEditorValue.length - beforeRaw.length + replacedLength;
  if (insertedLength < 0) return null;
  const insertedEnd = beforeSel.start + insertedLength;
  if (insertedEnd > rawEditorValue.length || afterPos < insertedEnd) return null;
  const insertedText = rawEditorValue.slice(beforeSel.start, insertedEnd);
  if (!replacementIsPlainRawSafe(insertedText)) return null;

  // Local guards avoid an O(cursor-position) prefix comparison while still catching
  // unexpected non-composition edits near the patch boundary.
  const guardStart = Math.max(0, beforeSel.start - 32);
  if (rawEditorValue.slice(guardStart, beforeSel.start) !== beforeRaw.slice(guardStart, beforeSel.start)) return null;
  const beforeTailStart = beforeSel.end;
  const afterTailStart = insertedEnd;
  if (rawEditorValue.slice(afterTailStart, afterTailStart + 32) !== beforeRaw.slice(beforeTailStart, beforeTailStart + 32)) return null;

  const nextText = beforeRaw.slice(0, beforeSel.start) + insertedText + beforeRaw.slice(beforeSel.end);
  setRootDatasetValue('editorCompositionCommitMode', 'large-plain-range-direct');
  return { rawEditorValue, nextText: normalizeEditorCommandLiterals(nextText), skipLiteralSync: true };
}

function shouldUseLargePlainRawFastPath(previousRawCode, options = {}) {
  if (!isLargeTextModeActive()) return false;
  if (options.newInputDefaultColor === true) return false;
  const analysis = getLargeTextModeAnalysis();
  if (analysis.rawPlain === false) return false;
  const previous = String(previousRawCode ?? '');
  // rawPlain is maintained by the last exact/fast large-text analysis. This narrow guard
  // catches immediately inserted raw-control characters before the idle exact pass runs.
  const data = typeof options.data === 'string' ? options.data : '';
  if (!replacementIsPlainRawSafe(data)) return false;
  return previous.length >= LARGE_TEXT_VISIBLE_LENGTH_LIMIT || analysis.active === true;
}

function tryLargePlainRawPatch(previousRawCode, nextEditorText, options = {}) {
  if (!shouldUseLargePlainRawFastPath(previousRawCode, options)) return null;
  const previous = normalizeNewlines(previousRawCode);
  const inputType = String(options.inputType || '');
  const selection = selectionFromOptions(options);
  if (!selection) return null;
  const directTypes = new Set(['insertText', 'insertCompositionText', 'insertReplacementText', 'deleteContentBackward', 'deleteContentForward']);
  if (!directTypes.has(inputType)) return null;
  const isDelete = inputType.startsWith('delete');
  const range = rangeForInputType(inputType, selection, previous.length);
  if (!range) return null;
  let replacement = '';
  if (!isDelete) {
    replacement = typeof options.data === 'string' ? normalizeNewlines(options.data) : '';
    if (!replacement) {
      const anchored = anchoredReplacement(previous, normalizeNewlines(nextEditorText), range.start, range.end);
      if (anchored === null || !replacementIsPlainRawSafe(anchored)) return null;
      replacement = anchored;
    }
    if (!replacementIsPlainRawSafe(replacement)) return null;
  }
  const next = previous.slice(0, range.start) + replacement + previous.slice(range.end);
  if (typeof document !== 'undefined' && document.documentElement) {
    setRootDatasetValue('editorRawPatchMode', 'large-plain-direct-v2');
  }
  return next;
}

function mergeEditorVisibleTextIntoRawCode(previousRawCode, nextEditorText, options = {}) {
  const previous = normalizeNewlines(previousRawCode);
  const directPatch = tryLargePlainRawPatch(previous, nextEditorText, options);
  if (directPatch !== null) return directPatch;
  if (typeof document !== 'undefined' && document.documentElement && isLargeTextModeActive()) {
    setRootDatasetValue('editorRawPatchMode', 'large-model-fallback');
  }
  const inputType = String(options.inputType || '');
  const selection = selectionFromOptions(options);
  const isDelete = inputType.startsWith('delete');
  const isInsert = inputType.startsWith('insert') || inputType === '';

  if (selection && (isDelete || (isInsert && typeof options.data === 'string' && options.data.length > 0))) {
    const oldLength = isDelete ? rawCodeToVisibleText(previous).length : Math.max(selection.start, selection.end);
    const range = rangeForInputType(inputType, selection, oldLength);
    if (range) {
      if (isDelete) return makeRawCodePatch(previous, range.start, range.end, '').rawCode;
      return makeRawCodePatch(previous, range.start, range.end, rawFragmentFromEditorReplacement(options.data, options)).rawCode;
    }
  }

  const beforeVisible = editorProjectionText(previous);
  const afterVisible = normalizeNewlines(nextEditorText);
  if (beforeVisible === afterVisible) return previous;

  const range = rangeForInputType(inputType, selection, beforeVisible.length);

  if (range && (isDelete || isInsert)) {
    let replacement = '';
    if (!isDelete && typeof options.data === 'string' && options.data.length > 0 && inputType !== 'insertCompositionText') {
      replacement = normalizeNewlines(options.data);
    } else {
      const anchored = anchoredReplacement(beforeVisible, afterVisible, range.start, range.end);
      if (anchored !== null) replacement = anchored;
      else if (!isDelete) replacement = normalizeNewlines(options.data || '');
    }
    if (isDelete || replacement || inputType === 'insertCompositionText' || inputType === 'insertText' || inputType === 'insertReplacementText') {
      return makeRawCodePatch(previous, range.start, range.end, rawFragmentFromEditorReplacement(replacement, options)).rawCode;
    }
  }

  const diff = visibleDiff(beforeVisible, afterVisible);
  return makeRawCodePatch(previous, diff.prefix, diff.beforeEnd, rawFragmentFromEditorReplacement(diff.replacement, options)).rawCode;
}

function clearPendingCompositionTimer(pending = pendingCompositionCommit) {
  if (pending?.timer !== null && pending?.timer !== undefined) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
}

function discardPendingCompositionCommit() {
  const pending = pendingCompositionCommit;
  if (pending) clearPendingCompositionTimer(pending);
  pendingCompositionCommit = null;
}

function buildEditorCompositionText(snap) {
  const direct = tryBuildLargePlainCompositionText(snap) || tryBuildLargeCompositionTextDirect(snap);
  if (direct) return direct;
  const rawEditorValue = normalizeNewlines(editorText?.value || '');
  const mergedText = mergeEditorVisibleTextIntoRawCode(snapshotRawCode(snap), rawEditorValue, {
    inputType: 'insertCompositionText',
    data: '',
    beforeSelection: snap.editorSelection,
    newInputDefaultColor: getColorInputPolicy().newInputDefaultColor === true,
  });
  setRootDatasetValue('editorCompositionCommitMode', 'model-fallback');
  return { rawEditorValue, nextText: normalizeEditorCommandLiterals(mergedText) };
}

function flushPendingCompositionCommit(pending = pendingCompositionCommit) {
  if (!pending || pending !== pendingCompositionCommit) return false;
  clearPendingCompositionTimer(pending);
  pendingCompositionCommit = null;

  const { el, source, snap, docId } = pending;
  if (!snap || !el || docId !== state.activeDocumentId) {
    if (compositionSnapshot === snap) compositionSnapshot = null;
    if (composingElement === el) composingElement = null;
    if (el) pendingBeforeInput.delete(el);
    return false;
  }

  if (source === 'editor') {
    const { rawEditorValue, nextText, skipLiteralSync = false } = buildEditorCompositionText(snap);
    if (nextText !== state.rawCode) {
      setRawCode(nextText, 'editor');
      syncCodeFromDocument();
      if (!skipLiteralSync) syncEditorAfterCommandLiteralIfNeeded(rawEditorValue, nextText);
      afterDocumentChanged('편집창 수정', { input: true, source: 'editor', inputType: 'insertCompositionText', data: '' });
    }
    // Always complete the native-text -> colored-overlay handoff, including
    // composition ends caused by cursor movement or pointer clicks.
    notifyEditorCompositionOverlay('composition-commit-sync');
  }

  if (state.rawCode !== snapshotRawCode(snap)) {
    recordDocumentInputUndo(el, source, snap, state.rawCode, { inputType: 'insertCompositionText', data: '' });
  }
  if (composingElement === el && compositionSnapshot === snap) composingElement = null;
  if (compositionSnapshot === snap) compositionSnapshot = null;
  if (source === 'editor') setLargeCompositionNativeMode(false);
  if (source === 'editor') {
    restoreLargeCompositionPointerSelection('composition-commit');
  }
  pendingBeforeInput.delete(el);
  return true;
}

function flushActiveEditorCompositionBeforeNavigation(reason = 'navigation') {
  const finishVisualHandoff = committed => {
    if (!committed) return false;
    try {
      window.dispatchEvent(new CustomEvent('ttedit-editor-composition-force-end', {
        detail: { documentId: state.activeDocumentId, reason },
      }));
    } catch (_) {}
    return true;
  };
  if (pendingCompositionCommit?.el === editorText) {
    return finishVisualHandoff(flushPendingCompositionCommit(pendingCompositionCommit));
  }
  if (composingElement !== editorText || !compositionSnapshot || !isLargeTextModeActive()) return false;
  const pending = {
    id: nextCompositionCommitId++,
    timer: null,
    docId: state.activeDocumentId,
    el: editorText,
    source: 'editor',
    snap: compositionSnapshot,
  };
  pendingCompositionCommit = pending;
  setRootDatasetValue('editorCompositionForcedCommit', reason);
  return finishVisualHandoff(flushPendingCompositionCommit(pending));
}

export function flushDocumentInputUndoState() {
  // Explicit document commands (undo/redo/paste/cut/color apply) end any active
  // editor composition both in the model and in the native-text/overlay handoff.
  // A plain pending flush updates the raw model but can leave the visual IME layer
  // waiting for a compositionend event that WebView2 never sends after navigation.
  if (!flushActiveEditorCompositionBeforeNavigation('explicit-document-command')) {
    flushPendingCompositionCommit();
  }
  flushLargeDeferredUndoGroup('explicit-flush');
}

export function clearDocumentInputUndoState() {
  clearTypingGroupTimer();
  clearLargeDeferredUndoTimer();
  cancelLargeCompositionPointerRestoreFrame();
  if (largeInputStatusTimer) { clearTimeout(largeInputStatusTimer); largeInputStatusTimer = 0; }
  pendingLargeInputStatus = null;
  discardPendingCompositionCommit();
  typingGroup = null;
  largeDeferredUndoGroup = null;
  pendingBeforeInput = new WeakMap();
  composingElement = null;
  compositionSnapshot = null;
  largeCompositionPointerSelection = null;
  largeCompositionPointerIntent = null;
  largeCompositionPointerScrollGuard = null;
  largeCompositionPointerDown = false;
  largeCompositionPointerContentDown = false;
  lastUserEditorScroll = null;
  userEditorScrollArmedUntil = 0;
  lastUserEditorScrollIntentAt = 0;
  lastLargeEditorCompositionEndAt = 0;
  editorPointerDownShouldAutoRevealCaret = false;
}

function isTypingLikeInput(inputType = '', data = '') {
  if (inputType === 'insertText' || inputType === 'insertCompositionText') return true;
  if (inputType === 'insertReplacementText') return true;
  if (!inputType && typeof data === 'string' && data.length > 0) return true;
  return false;
}

function isHardUndoBoundary(inputType = '', data = '') {
  if (inputType === 'insertParagraph' || inputType === 'insertLineBreak') return true;
  if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop' || inputType === 'insertFromYank') return true;
  if (inputType.startsWith('delete') || inputType.startsWith('history')) return true;
  if (data === '\n' || data === '\r') return true;
  return false;
}

function selectionRestoreModeForInput(inputType = '') {
  if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop' || inputType === 'insertFromYank') return 'collapse-end';
  if (inputType.startsWith('delete')) return 'collapse-start';
  return 'preserve';
}

function shouldUseLargeDeferredUndo(source, inputType = '', data = '') {
  if (source !== 'editor') return false;
  if (!isLargeTextModeActive()) return false;
  if (!isTypingLikeInput(inputType, data)) return false;
  if (isHardUndoBoundary(inputType, data)) return false;
  return true;
}

function queueLargeDeferredInputUndo(el, source, beforeSnapshot, afterRawCode, eventLike = {}, beforeSel = null, selectionRestoreMode = 'preserve') {
  const now = Date.now();
  const docId = state.activeDocumentId;
  const mergeKey = `typing:${docId}:${source}:large-deferred`;
  const canContinue = largeDeferredUndoGroup
    && largeDeferredUndoGroup.docId === docId
    && largeDeferredUndoGroup.el === el
    && largeDeferredUndoGroup.source === source
    && now - largeDeferredUndoGroup.lastAt <= TYPING_GROUP_IDLE_MS
    && sameCollapsedSelection(largeDeferredUndoGroup.afterSelection, beforeSel);

  if (!canContinue) {
    flushLargeDeferredUndoGroup('boundary');
    largeDeferredUndoGroup = {
      docId,
      el,
      source,
      startSnapshot: beforeSnapshot,
      afterRawCode: String(afterRawCode ?? ''),
      afterSelection: selectionOf(el),
      lastAt: now,
      mergeKey,
      selectionRestoreMode,
    };
  } else {
    largeDeferredUndoGroup.afterRawCode = String(afterRawCode ?? '');
    largeDeferredUndoGroup.afterSelection = selectionOf(el);
    largeDeferredUndoGroup.lastAt = now;
    largeDeferredUndoGroup.selectionRestoreMode = selectionRestoreMode;
  }
  armLargeDeferredUndoTimer();
  setUndoDiagnostics('large-deferred-pending', { editorUndoDeferredLength: String(afterRawCode ?? '').length });
  return true;
}

function sameCollapsedSelection(a, b) {
  if (!a || !b) return false;
  return a.start === a.end && b.start === b.end && a.start === b.start;
}

function sourceSelection(snapshot, source) {
  return source === 'code' ? snapshot?.codeSelection : snapshot?.editorSelection;
}

function snapshotRawCode(snapshot) {
  return String(snapshot?.rawCode ?? snapshot?.text ?? state.rawCode);
}

function snapshotWithRawCode(snapshot, rawCode, activeView = snapshot?.activeView || state.activeView) {
  const normalized = normalizeNewlines(rawCode);
  return {
    ...(snapshot || {}),
    rawCode: normalized,
    // text is a compatibility alias only; history boundaries are rawCode-first.
    text: normalized,
    activeView: activeView === 'code' ? 'code' : 'editor',
  };
}

function recordDocumentInputUndo(el, source, beforeSnapshot, afterRawCode, eventLike = {}) {
  const inputType = String(eventLike.inputType || '');
  const data = typeof eventLike.data === 'string' ? eventLike.data : '';
  const now = Date.now();
  const docId = state.activeDocumentId;
  const beforeSel = sourceSelection(beforeSnapshot, source);
  const isTyping = isTypingLikeInput(inputType, data);
  const hardBoundary = isHardUndoBoundary(inputType, data) || !isTyping;

  const selectionRestoreMode = selectionRestoreModeForInput(inputType);

  if (shouldUseLargeDeferredUndo(source, inputType, data)) {
    commitTypingGroup();
    if (typeof document !== 'undefined' && document.documentElement) {
      setRootDatasetValue('editorUndoSnapshotMode', 'large-before-only');
    }
    return queueLargeDeferredInputUndo(el, source, beforeSnapshot, afterRawCode, eventLike, beforeSel, selectionRestoreMode);
  }

  const afterSnapshot = snapshotWithRawCode(captureDocumentSnapshot(source), afterRawCode, source);

  if (hardBoundary) {
    flushLargeDeferredUndoGroup('hard-boundary');
    commitTypingGroup();
    return recordEditAction({ before: beforeSnapshot, after: afterSnapshot, actionType: inputType || 'input-command', activeView: source, merge: false, selectionRestoreMode });
  }

  flushLargeDeferredUndoGroup('normal-input-boundary');

  const canContinue = typingGroup
    && typingGroup.docId === docId
    && typingGroup.el === el
    && typingGroup.source === source
    && now - typingGroup.lastAt <= TYPING_GROUP_IDLE_MS
    && sameCollapsedSelection(typingGroup.afterSelection, beforeSel);

  const mergeKey = `typing:${docId}:${source}`;
  const recorded = recordEditAction({ before: canContinue ? typingGroup.startSnapshot : beforeSnapshot, after: afterSnapshot, actionType: 'typing', activeView: source, mergeKey, merge: canContinue, selectionRestoreMode });

  if (!canContinue) typingGroup = { docId, el, source, startSnapshot: beforeSnapshot, lastAt: now, afterSelection: null, mergeKey };
  typingGroup.lastAt = now;
  typingGroup.afterSelection = selectionOf(el);
  armTypingGroupTimer();
  return recorded;
}

function selectionOf(el) {
  return { start: el?.selectionStart ?? 0, end: el?.selectionEnd ?? el?.selectionStart ?? 0 };
}

export function captureDocumentSnapshot(activeView = state.activeView) {
  return {
    rawCode: state.rawCode,
    // text is kept as a compatibility alias while undo/redo is rawCode-first.
    text: state.rawCode,
    activeView: activeView === 'code' ? 'code' : 'editor',
    codeSelection: selectionOf(codeText),
    editorSelection: selectionOf(editorText),
    codeScroll: { top: codeText?.scrollTop || 0, left: codeText?.scrollLeft || 0 },
    editorScroll: { top: editorText?.scrollTop || 0, left: editorText?.scrollLeft || 0 },
  };
}

export function pushCurrentUndoSnapshot(activeView = state.activeView) {
  return recordEditAction({ before: captureDocumentSnapshot(activeView), after: captureDocumentSnapshot(activeView), actionType: 'noop', activeView });
}

export function saveActiveDocumentViewState() {
  const doc = getActiveDocument();
  if (!doc || !codeText || !editorText) return;
  doc.selection = {
    code: selectionOf(codeText),
    editor: selectionOf(editorText),
  };
  doc.scroll = {
    code: { top: codeText.scrollTop || 0, left: codeText.scrollLeft || 0 },
    editor: { top: editorText.scrollTop || 0, left: editorText.scrollLeft || 0 },
  };
}

function restoreDocumentViewState(doc) {
  if (!doc || !codeText || !editorText) return;
  const codeSel = doc.selection?.code;
  const editorSel = doc.selection?.editor;
  if (codeSel) {
    const max = codeText.value.length;
    try { codeText.setSelectionRange(Math.min(codeSel.start, max), Math.min(codeSel.end, max)); } catch (_) {}
  }
  if (editorSel) {
    const max = editorText.value.length;
    try { editorText.setSelectionRange(Math.min(editorSel.start, max), Math.min(editorSel.end, max)); } catch (_) {}
  }
  codeText.scrollTop = doc.scroll?.code?.top || 0;
  codeText.scrollLeft = doc.scroll?.code?.left || 0;
  editorText.scrollTop = doc.scroll?.editor?.top || 0;
  editorText.scrollLeft = doc.scroll?.editor?.left || 0;
}

function captureBeforeInput(source, event = null) {
  pendingBeforeInput.set(source === 'code' ? codeText : editorText, {
    snapshot: captureDocumentSnapshot(source),
    inputType: event?.inputType || '',
    data: typeof event?.data === 'string' ? event.data : '',
  });
}

function takeBeforeInputRecord(el, source, event = null) {
  const record = pendingBeforeInput.get(el) || { snapshot: captureDocumentSnapshot(source), inputType: event?.inputType || '', data: typeof event?.data === 'string' ? event.data : '' };
  pendingBeforeInput.delete(el);
  if (!record.inputType && event?.inputType) record.inputType = event.inputType;
  if (record.data === '' && typeof event?.data === 'string') record.data = event.data;
  return record;
}

function lineAndColumnAtOffset(text, offset) {
  const source = String(text ?? '');
  const end = Math.max(0, Math.min(Number(offset) || 0, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, lineStart, prefix: source.slice(lineStart, end) };
}

function copyTextareaMeasureStyle(target, source) {
  if (!target || !source || typeof getComputedStyle !== 'function') return;
  const cs = getComputedStyle(source);
  const props = [
    'boxSizing', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontStretch',
    'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign', 'textIndent',
    'textTransform', 'tabSize', 'direction', 'unicodeBidi', 'fontKerning',
    'fontVariantLigatures', 'fontFeatureSettings', 'fontVariationSettings',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'overflowWrap', 'wordBreak', 'whiteSpace',
  ];
  for (const prop of props) {
    try { target.style[prop] = cs[prop]; } catch (_) {}
  }
}

function revealTextareaOffsetWithMirror(area, offset) {
  if (!area || typeof document === 'undefined' || !document.body) return false;
  const text = String(area.value ?? '');
  const safe = Math.max(0, Math.min(Number(offset) || 0, text.length));
  const mirror = document.createElement('div');
  const marker = document.createElement('span');
  mirror.setAttribute('aria-hidden', 'true');
  mirror.style.position = 'fixed';
  mirror.style.left = '-100000px';
  mirror.style.top = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.zIndex = '-1';
  mirror.style.width = `${Math.max(1, area.clientWidth || 1)}px`;
  mirror.style.height = 'auto';
  mirror.style.overflow = 'visible';
  copyTextareaMeasureStyle(mirror, area);
  if (area.wrap === 'off' || area.classList?.contains('wrap-disabled')) {
    mirror.style.whiteSpace = 'pre';
    mirror.style.overflowWrap = 'normal';
    mirror.style.wordBreak = 'normal';
  } else {
    mirror.style.whiteSpace = 'pre-wrap';
  }
  mirror.appendChild(document.createTextNode(text.slice(0, safe)));
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  mirror.appendChild(document.createTextNode(text.slice(safe, safe + 1) || '\u200b'));
  document.body.appendChild(mirror);
  try {
    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const x = markerRect.left - mirrorRect.left;
    const y = markerRect.top - mirrorRect.top;
    const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 20;
    area.scrollTop = Math.max(0, y - Math.max(0, (area.clientHeight - lineHeight) * 0.45));
    area.scrollLeft = Math.max(0, x - Math.max(0, area.clientWidth * 0.45));
    return true;
  } finally {
    mirror.remove();
  }
}

function revealRestoredSelection(active, offset) {
  if (!active) return;
  if (active === editorText) {
    const text = String(editorText.value ?? '');
    const location = lineAndColumnAtOffset(text, offset);
    if (isLargeEditorViewportActive()) {
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(editorText) : null;
      const lineHeight = Number.parseFloat(cs?.lineHeight) || 27;
      editorText.scrollTop = Math.max(0, (location.line - 1) * lineHeight - Math.max(0, editorText.clientHeight * 0.45));
    } else {
      scrollEditorToLine(location.line, 0.45);
    }
    if (editorText.wrap === 'off' || editorText.classList?.contains('wrap-disabled')) {
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(editorText) : null;
      const paddingLeft = Number.parseFloat(cs?.paddingLeft) || 0;
      const caretX = paddingLeft + measureEditorTextWidth(location.prefix);
      editorText.scrollLeft = Math.max(0, caretX - Math.max(0, editorText.clientWidth * 0.45));
    }
    return;
  }
  revealTextareaOffsetWithMirror(active, offset);
}

function restorePendingSelection() {
  const snap = state.pendingRestoreSelection;
  if (!snap) return;
  state.pendingRestoreSelection = null;
  const active = snap.activeView === 'code' ? codeText : editorText;
  const sel = snap.activeView === 'code' ? snap.codeSelection : snap.editorSelection;
  if (active && sel) {
    active.focus({ preventScroll: true });
    const max = active.value.length;
    const start = Math.max(0, Math.min(sel.start, max));
    const end = Math.max(start, Math.min(sel.end, max));
    try { active.setSelectionRange(start, end); } catch (_) {}
    revealRestoredSelection(active, start);
  }
}

function isHex4(text) { return /^[0-9a-fA-F]{4}$/.test(String(text ?? '')); }

function editorLiteralOffsetToRenderedOffset(text, offset) {
  const source = normalizeNewlines(text);
  const end = Math.max(0, Math.min(Number(offset) || 0, source.length));
  let visible = 0;
  for (let i = 0; i < end; i++) {
    if (source.startsWith('ÿc', i) && i + 2 < end) {
      i += 2;
      continue;
    }
    if (source[i] === '\\' && source[i + 1] === 'n' && i + 1 < end) {
      visible += 1;
      i += 1;
      continue;
    }
    if (source[i] === '\\' && source[i + 1] === 'u' && i + 5 < end && isHex4(source.slice(i + 2, i + 6))) {
      visible += 1;
      i += 5;
      continue;
    }
    visible += 1;
  }
  return visible;
}

function normalizeEditorCommandLiterals(documentText) {
  return normalizeNewlines(documentText);
}

function syncEditorAfterCommandLiteralIfNeeded(rawEditorValue, nextDocumentText) {
  if (!editorText) return;
  const rendered = editorProjectionText(nextDocumentText);
  if (editorText.value === rendered) return;
  const start = editorLiteralOffsetToRenderedOffset(rawEditorValue, editorText.selectionStart ?? 0);
  const end = editorLiteralOffsetToRenderedOffset(rawEditorValue, editorText.selectionEnd ?? editorText.selectionStart ?? 0);
  state.isSyncing = true;
  editorText.value = rendered;
  state.isSyncing = false;
  try { editorText.setSelectionRange(start, Math.max(start, end)); } catch (_) {}
}

function insertEditorTabCharacter() {
  if (!editorText) return false;
  const start = editorText.selectionStart ?? 0;
  const end = editorText.selectionEnd ?? start;
  const snapshot = captureDocumentSnapshot('editor');
  const patch = makeRawCodePatch(state.rawCode, start, end, '	');
  const nextText = patch.rawCode;
  if (nextText === state.rawCode) {
    setStatusMessage('탭 입력: 변경 없음');
    return false;
  }
  clearDocumentInputUndoState();
  const caret = start + 1;
  const afterSnapshot = snapshotWithEditorSelection(snapshot, nextText, { start: caret, end: caret });
  recordEditAction({ before: snapshot, after: afterSnapshot, actionType: 'insert-tab', activeView: 'editor', selectionRestoreMode: 'preserve' });
  setRawCode(nextText, 'editor');
  syncTextAreasFromState('탭 입력');
  editorText.focus({ preventScroll: true });
  try { editorText.setSelectionRange(caret, caret); } catch (_) {}
  refreshStatus('탭 입력');
  return true;
}

export function initViews({ codeElement, editorElement, onChange }) {
  codeText = codeElement;
  editorText = editorElement;
  externalChangeCallback = onChange || null;

  function rememberDocumentFocus(source) {
    state.activeView = source;
    document.body.dataset.lastDocumentFocus = source;
  }

  codeText.addEventListener("focus", () => {
    if (isCodePaneDisplayPaused()) { showCodePanePausedStatus(); editorText?.focus({ preventScroll: true }); return; }
    flushDeferredCodeSync(); rememberDocumentFocus("code"); setFloatingWindowInactive(true); refreshStatus("코드창");
  });
  editorText.addEventListener("focus", () => { rememberDocumentFocus("editor"); setFloatingWindowInactive(true); refreshStatus("편집창"); });
  codeText.addEventListener("blur", commitTypingGroup);
  editorText.addEventListener("blur", () => { flushActiveEditorCompositionBeforeNavigation('blur'); commitTypingGroup(); });
  codeText.addEventListener("mousedown", (event) => {
    if (isCodePaneDisplayPaused()) { event.preventDefault(); showCodePanePausedStatus(); editorText?.focus({ preventScroll: true }); return; }
    commitTypingGroup(); rememberDocumentFocus("code");
  });
  editorText.addEventListener("mousedown", (event) => { flushActiveEditorCompositionBeforeNavigation('pointer-down'); if (isPointerInTextareaScrollbar(editorText, event)) armUserEditorScrollIntent(1500, "scrollbar-down"); rememberLargeCompositionPointerDown(event); commitTypingGroup(); rememberDocumentFocus("editor"); });
  editorText.addEventListener("wheel", () => { armUserEditorScrollIntent(250, "wheel"); }, { passive: true });

  function handleNativeHistoryBeforeInput(source, event) {
    const inputType = String(event?.inputType || '');
    if (inputType !== 'historyUndo' && inputType !== 'historyRedo') return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    flushPendingCompositionCommit();
    commitTypingGroup();
    pendingBeforeInput.delete(source === 'code' ? codeText : editorText);
    window.dispatchEvent(new CustomEvent('ttedit-document-history-request', { detail: { command: inputType === 'historyRedo' ? 'redo' : 'undo', source } }));
    return true;
  }

  function prepareBeforeInput(source, event) {
    if (source === 'code' && isCodePaneDisplayPaused()) {
      event.preventDefault();
      event.stopPropagation();
      showCodePanePausedStatus();
      return;
    }
    if (handleNativeHistoryBeforeInput(source, event)) return;
    const el = source === 'code' ? codeText : editorText;
    if (pendingCompositionCommit?.el === el) flushPendingCompositionCommit(pendingCompositionCommit);
    const inputType = String(event?.inputType || '');
    if (source === 'editor' && isLargeTextModeActive() && (event?.isComposing || inputType === 'insertCompositionText')) {
      pendingBeforeInput.delete(el);
      setLargeCompositionNativeMode(true);
      if (typeof document !== 'undefined' && document.documentElement) {
        setRootDatasetValue('editorCompositionBeforeInputMode', 'large-skip-snapshot');
      }
      return;
    }
    captureBeforeInput(source, event);
  }

  codeText.addEventListener('beforeinput', (event) => { prepareBeforeInput('code', event); });
  editorText.addEventListener('beforeinput', (event) => { prepareBeforeInput('editor', event); });

  for (const [el, source] of [[codeText, 'code'], [editorText, 'editor']]) {
    el.addEventListener('compositionstart', () => {
      flushPendingCompositionCommit();
      composingElement = el;
      compositionSnapshot = captureDocumentSnapshot(source);
      if (source === 'editor' && isLargeTextModeActive()) {
        lastLargeEditorCompositionEndAt = 0;
        setLargeCompositionNativeMode(true);
      }
    });
    el.addEventListener('compositionend', (event) => {
      if (source === 'editor' && isLargeTextModeActive()) lastLargeEditorCompositionEndAt = editorPerfNow();
      const snap = compositionSnapshot;
      if (!snap) {
        if (composingElement === el) composingElement = null;
        pendingBeforeInput.delete(el);
        return;
      }
      flushPendingCompositionCommit();
      const pending = { id: nextCompositionCommitId++, timer: null, docId: state.activeDocumentId, el, source, snap };
      pendingCompositionCommit = pending;
      pending.timer = setTimeout(() => {
        if (pendingCompositionCommit === pending && pending.id) flushPendingCompositionCommit(pending);
        if (source === 'editor') setLargeCompositionNativeMode(false);
      }, 0);
    });
  }

  codeText.addEventListener("keydown", (event) => {
    if (isCodePaneDisplayPaused()) {
      event.preventDefault();
      event.stopPropagation();
      showCodePanePausedStatus();
      editorText?.focus({ preventScroll: true });
      return;
    }
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Escape'].includes(event.key)) commitTypingGroup();
    if (event.ctrlKey || event.metaKey || event.altKey) commitTypingGroup();
    if (event.key === "Enter") {
      commitTypingGroup();
      event.preventDefault();
      const start = codeText.selectionStart ?? 0;
      const end = codeText.selectionEnd ?? start;
      const beforeSnapshot = captureDocumentSnapshot('code');
      const nextRawCode = String(codeText.value || '').slice(0, start) + RAW_LINE_BREAK_LITERAL + String(codeText.value || '').slice(end);
      applyDocumentTextAction(nextRawCode, { source: 'code', label: '줄바꿈 입력', snapshot: beforeSnapshot, actionType: 'insertLineBreak' });
      const pos = start + RAW_LINE_BREAK_LITERAL.length;
      codeText.focus({ preventScroll: true });
      try { codeText.setSelectionRange(pos, pos); } catch (_) {}
    }
    if (event.key === "Tab") {
      commitTypingGroup();
      event.preventDefault();
      setStatusMessage("Tab 이동은 비활성화됨");
    }
  });
  editorText.addEventListener("keydown", (event) => {
    if (event.key === "PageUp" && !event.ctrlKey && !event.metaKey && !event.altKey && (editorText.scrollTop || 0) <= 1) {
      requestAnimationFrame(() => {
        if ((editorText.scrollTop || 0) > 0) editorText.scrollTop = 0;
      });
    }
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Escape'].includes(event.key)) {
      flushActiveEditorCompositionBeforeNavigation(`keydown:${event.key}`);
      commitTypingGroup();
    }
    if (event.ctrlKey || event.metaKey || event.altKey) commitTypingGroup();
    if (event.key === "Enter" || event.key === "Tab") commitTypingGroup();
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      insertEditorTabCharacter();
    }
  });

  function clipboardEventRawFragment(event) {
    const text = event.clipboardData?.getData?.('text/plain') ?? '';
    const html = event.clipboardData?.getData?.('text/html') ?? '';
    if (html) {
      const rich = htmlToD2rRawFragment(html, { plainText: text, preferences: getPreferencesSafe() });
      if (rich.rawFragment || rich.text) return { rawFragment: rich.rawFragment, label: rich.hadMappedColor ? '외부 색상 근사 붙여넣기' : '붙여넣기', colored: rich.hadMappedColor, actionType: rich.hadMappedColor ? 'paste-external-color' : 'paste-html' };
    }
    if (!text) return null;
    const fragmentRawCode = normalizeClipboardToRawFragment(text, { preserveColorCodes: true });
    return { rawFragment: fragmentRawCode, label: containsColorCodes(text) ? '색상 코드 포함 붙여넣기' : '붙여넣기', colored: containsColorCodes(text), actionType: containsColorCodes(text) ? 'paste-colored-document' : 'paste-plain-document' };
  }

  function applyEditorClipboardPaste(event) {
    if (state.isSyncing || composingElement === editorText) return false;
    const payload = clipboardEventRawFragment(event);
    if (!payload) return false;
    event.preventDefault();
    event.stopPropagation();
    commitTypingGroup();
    pendingBeforeInput.delete(editorText);
    const start = editorText.selectionStart ?? 0;
    const end = editorText.selectionEnd ?? start;
    const snapshot = captureDocumentSnapshot('editor');
    const visibleInsertLength = editorProjectionText(payload.rawFragment).length;
    const pasteStart = start;
    const pasteEnd = end;
    const nextText = makeRawCodePatch(state.rawCode, pasteStart, pasteEnd, payload.rawFragment).rawCode;
    const caret = pasteStart + visibleInsertLength;
    if (!applyDocumentTextAction(nextText, { source: 'editor', label: payload.label, snapshot, actionType: payload.actionType, selectionRestoreMode: 'collapse-end' })) {
      // Replacing a selection with identical clipboard text is a legitimate
      // no-op. Native textarea behavior collapses the selection at the end; it
      // must never reinterpret the no-op as an insertion after the selection.
      editorText.focus({ preventScroll: true });
      try { editorText.setSelectionRange(caret, caret); } catch (_) {}
      setStatusMessage(`${payload.label}: 변경 없음`);
      return true;
    }
    editorText.focus({ preventScroll: true });
    try { editorText.setSelectionRange(caret, caret); } catch (_) {}
    return true;
  }

  function applyCodeClipboardPaste(event) {
    if (isCodePaneDisplayPaused()) {
      event.preventDefault();
      event.stopPropagation();
      showCodePanePausedStatus();
      return true;
    }
    if (state.isSyncing) return false;
    const payload = clipboardEventRawFragment(event);
    if (!payload) return false;
    event.preventDefault();
    event.stopPropagation();
    commitTypingGroup();
    const start = codeText.selectionStart ?? 0;
    const end = codeText.selectionEnd ?? start;
    const snapshot = captureDocumentSnapshot('code');
    const rawInsert = normalizeCodePaneRawInput(payload.rawFragment);
    const nextText = normalizeCodePaneRawInput(String(codeText.value || '').slice(0, start)) + rawInsert + normalizeCodePaneRawInput(String(codeText.value || '').slice(end));
    if (!applyDocumentTextAction(nextText, { source: 'code', label: payload.label, snapshot, actionType: 'paste-code', selectionRestoreMode: 'collapse-end' })) {
      syncCodeFromDocument();
      return true;
    }
    const caret = start + rawInsert.length;
    codeText.focus({ preventScroll: true });
    try { codeText.setSelectionRange(caret, caret); } catch (_) {}
    return true;
  }

  editorText.addEventListener("paste", applyEditorClipboardPaste);
  codeText.addEventListener("paste", applyCodeClipboardPaste);

  codeText.addEventListener("input", (event) => {
    if (isCodePaneDisplayPaused()) {
      if (codeText.value !== '') codeText.value = '';
      showCodePanePausedStatus();
      return;
    }
    if (state.isSyncing) return;
    flushDeferredCodeSync();
    const beforeRecord = takeBeforeInputRecord(codeText, "code", event);
    const isComposing = event.isComposing || composingElement === codeText;
    const beforeText = state.rawCode;
    const rawInput = normalizeCodePaneRawInput(codeText.value);
    if (codeText.value !== rawInput) {
      const pos = codePaneNativeOffsetToRawOffset(codeText.value, codeText.selectionStart ?? rawInput.length);
      codeText.value = rawInput;
      codeText.setSelectionRange(Math.min(pos, rawInput.length), Math.min(pos, rawInput.length));
    }
    const nextText = codeText.value;
    if (!isComposing && nextText !== beforeText) {
      recordDocumentInputUndo(codeText, "code", beforeRecord.snapshot, nextText, beforeRecord);
    }
    setRawCode(nextText, "code");
    syncEditorFromDocument();
    afterDocumentChanged("코드창 수정", { input: true, source: 'code', inputType: beforeRecord.inputType || event.inputType || '', data: beforeRecord.data || event.data || '' });
  });

  editorText.addEventListener("input", (event) => {
    if (state.isSyncing) return;
    const isComposing = event.isComposing || composingElement === editorText;
    if (shouldDeferLargeCompositionRawSync('editor', isComposing)) {
      pendingBeforeInput.delete(editorText);
      setLargeCompositionNativeMode(true);
      if (typeof document !== 'undefined' && document.documentElement) {
        setRootDatasetValue('editorRawPatchMode', 'large-ime-native-deferred');
        setRootDatasetValue('editorCompositionInputMode', 'large-native-skip-model');
      }
      return;
    }
    const beforeRecord = takeBeforeInputRecord(editorText, "editor", event);
    const baseSnapshot = isComposing && compositionSnapshot ? compositionSnapshot : beforeRecord.snapshot;
    const beforeText = isComposing && compositionSnapshot ? snapshotRawCode(compositionSnapshot) : state.rawCode;
    const rawEditorValue = normalizeNewlines(editorText.value);
    const mergedText = mergeEditorVisibleTextIntoRawCode(beforeText, rawEditorValue, {
      inputType: beforeRecord.inputType || event.inputType || '',
      data: beforeRecord.data || event.data || '',
      beforeSelection: baseSnapshot?.editorSelection,
      newInputDefaultColor: getColorInputPolicy().newInputDefaultColor === true,
    });
    const nextText = normalizeEditorCommandLiterals(mergedText);
    if (!isComposing && nextText !== beforeText) {
      recordDocumentInputUndo(editorText, "editor", beforeRecord.snapshot, nextText, beforeRecord);
    }
    setRawCode(nextText, "editor");
    if (shouldDeferCodeSyncForEditorInput(isComposing)) syncCodeFromDocumentDeferred(isComposing ? COMPOSITION_CODE_SYNC_DELAY_MS : LARGE_TEXT_CODE_SYNC_DELAY_MS);
    else syncCodeFromDocument();
    syncEditorAfterCommandLiteralIfNeeded(rawEditorValue, nextText);
    afterDocumentChanged("편집창 수정", { input: true, source: 'editor', inputType: beforeRecord.inputType || event.inputType || '', data: beforeRecord.data || event.data || '' });
    if (isComposing) notifyEditorCompositionOverlay('composition-input-sync');
  });

  window.addEventListener('ttedit-large-text-mode-changed', event => {
    const active = event?.detail?.active === true;
    const changed = applyCodePanePauseState(active, { showStatus: active });
    if (!active && changed) syncCodeFromDocument();
  });

  for (const [el, source, label] of [[codeText, "code", "코드창"], [editorText, "editor", "편집창"]]) {
    el.addEventListener("keyup", () => {
      if (source === 'code' && isCodePaneDisplayPaused()) return;
      if (source === 'editor' && isLargeEditorCompositionInProgress()) return;
      rememberDocumentFocus(source); refreshStatus(label); externalChangeCallback?.("cursor", source);
    });
    el.addEventListener("mouseup", () => {
      if (source === 'code' && isCodePaneDisplayPaused()) return;
      commitTypingGroup();
      if (source === 'editor' && largeCompositionPointerDown) {
        const hasIntent = !!largeCompositionPointerIntent;
        const captured = !hasIntent && largeCompositionPointerContentDown ? captureLargeCompositionPointerSelection('mouseup') : null;
        const shouldReveal = editorPointerDownShouldAutoRevealCaret === true && !hasIntent;
        largeCompositionPointerDown = false;
        largeCompositionPointerContentDown = false;
        editorPointerDownShouldAutoRevealCaret = false;
        if (shouldReveal) ensureEditorCaretHorizontallyVisibleInLargeNoWrap({ reason: 'large-nowrap-click' });
        if (!pendingCompositionCommit && !isLargeEditorCompositionInProgress()) {
          if (hasIntent) restoreLargeCompositionPointerSelection('mouseup-intent');
          else if (!captured) largeCompositionPointerSelection = null;
        }
        rememberDocumentFocus(source); refreshStatus(label); externalChangeCallback?.("cursor", source);
        return;
      }
      if (source === 'editor' && isLargeEditorCompositionInProgress()) return;
      if (source === 'editor' && editorPointerDownShouldAutoRevealCaret === true) ensureEditorCaretHorizontallyVisibleInLargeNoWrap({ reason: 'large-nowrap-mouseup' });
      if (source === 'editor') editorPointerDownShouldAutoRevealCaret = false;
      rememberDocumentFocus(source); refreshStatus(label); externalChangeCallback?.("cursor", source);
    });
    el.addEventListener("select", () => {
      if (source === 'code' && isCodePaneDisplayPaused()) return;
      if (source === 'editor' && isLargeEditorCompositionInProgress()) return;
      rememberDocumentFocus(source); refreshStatus(label);
    });
    el.addEventListener("scroll", () => {
      if (source === 'code' && isCodePaneDisplayPaused()) return;
      const restoredByPointerGuard = source === 'editor' ? applyLargeCompositionPointerScrollGuard('scroll-event') : false;
      if (source === 'editor' && !restoredByPointerGuard && !largeCompositionPointerScrollGuard && editorPerfNow() < userEditorScrollArmedUntil) rememberLastUserEditorScroll('armed-scroll');
      externalChangeCallback?.("scroll", source);
    });
  }
}

function notifyDocumentViewSynced(reason = '', options = {}) {
  try {
    window.dispatchEvent(new CustomEvent('ttedit-document-view-synced', {
      detail: {
        documentId: state.activeDocumentId,
        reason,
        input: options.input === true,
        source: options.source || state.activeView,
        inputType: options.inputType || '',
        data: typeof options.data === 'string' ? options.data : '',
        forceOverlay: options.forceOverlay === true,
      },
    }));
  } catch (_) {}
}

function afterDocumentChanged(message, options = {}) {
  refreshLargeTextMode({ input: options.input === true, editorValue: editorText?.value || "", inputType: options.inputType || '', data: typeof options.data === 'string' ? options.data : '' });
  refreshCodePanePauseState();
  if (!(options.input === true && options.source === 'editor')) updateLineNumbers({ input: options.input === true });
  refreshStatus(message, { input: options.input === true, inputType: options.inputType || '', data: typeof options.data === 'string' ? options.data : '' });
  externalChangeCallback?.("change", state.activeView);
  notifyDocumentViewSynced(message || "change", options);
}

function mapRawOffsetThroughRepresentationChange(beforeRaw, afterRaw, offset) {
  const before = String(beforeRaw ?? '');
  const after = String(afterRaw ?? '');
  const pos = Math.max(0, Math.min(Number(offset) || 0, before.length));
  if (before === after) return Math.min(pos, after.length);
  let prefix = 0;
  const minLength = Math.min(before.length, after.length);
  while (prefix < minLength && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  const beforeChangeEnd = before.length - suffix;
  const afterChangeEnd = after.length - suffix;
  if (pos < prefix) return pos;
  if (pos >= beforeChangeEnd) return Math.max(0, Math.min(pos + (after.length - before.length), after.length));
  return afterChangeEnd;
}

function mapCodeSelectionThroughRepresentationChange(selection, beforeRaw, afterRaw) {
  if (!selection || typeof selection !== 'object') return selection;
  const start = mapRawOffsetThroughRepresentationChange(beforeRaw, afterRaw, selection.start);
  const end = mapRawOffsetThroughRepresentationChange(beforeRaw, afterRaw, selection.end ?? selection.start);
  return { ...selection, start: Math.min(start, end), end: Math.max(start, end) };
}

function normalizeDocumentExplicitDefaultRepresentation(doc, enabled = getPreferences().codePaneExplicitDefaultColor === true) {
  if (!doc) return false;
  const before = String(doc.documentText ?? '');
  const after = normalizeInitialDefaultColorToken(before, enabled === true);
  if (after === before) return false;
  doc.documentText = after;
  if (doc.selection?.code) doc.selection.code = mapCodeSelectionThroughRepresentationChange(doc.selection.code, before, after);
  if (doc.pendingRestoreSelection?.codeSelection) {
    doc.pendingRestoreSelection.codeSelection = mapCodeSelectionThroughRepresentationChange(doc.pendingRestoreSelection.codeSelection, before, after);
  }
  return true;
}

export function normalizeOpenDocumentsExplicitDefaultRepresentation(enabled = getPreferences().codePaneExplicitDefaultColor === true) {
  let changed = 0;
  for (const doc of state.documents || []) if (normalizeDocumentExplicitDefaultRepresentation(doc, enabled)) changed++;
  return changed;
}

function normalizeActiveDocumentExplicitDefaultRepresentation() {
  return normalizeDocumentExplicitDefaultRepresentation(getActiveDocument(), getPreferences().codePaneExplicitDefaultColor === true);
}

function syncCodeFromDocument() {
  clearDeferredCodeSyncTimer();
  if (shouldPauseCodePaneForLargeText()) {
    state.isSyncing = true;
    applyCodePanePauseState(true);
    state.isSyncing = false;
    return;
  }
  state.isSyncing = true;
  applyCodePanePauseState(false);
  codeText.value = state.rawCode;
  state.isSyncing = false;
}

function syncEditorFromDocument() {
  state.isSyncing = true;
  editorText.value = editorProjectionText(state.rawCode);
  state.isSyncing = false;
}

export function setDocumentContent(content, { path = null, dirty = false, source = "file", rendering = null, renderingExplicit = null } = {}) {
  clearDocumentInputUndoState();
  resetDocument({ content: normalizeNewlines(content), path, dirty, rendering, renderingExplicit });
  clearDeferredCodeSyncTimer();
  state.isSyncing = true;
  editorText.value = editorProjectionText(state.rawCode);
  state.isSyncing = false;
  refreshLargeTextMode();
  syncCodeFromDocument();
  updateLineNumbers();
  refreshStatus(source === "file" ? "파일 열기 완료" : "문서 갱신");
  renderDocumentTabs();
  externalChangeCallback?.("change", source);
  notifyDocumentViewSynced(source);
}

function shouldUseLargeInputStatusThrottle(options = {}) {
  const largeAnalysis = getLargeTextModeAnalysis();
  return largeAnalysis?.active === true
    && options.input === true
    && isTypingLikeInput(options.inputType || '', typeof options.data === 'string' ? options.data : '')
    && !isHardUndoBoundary(options.inputType || '', typeof options.data === 'string' ? options.data : '');
}

function scheduleLargeInputStatusRefresh(message, options = {}) {
  pendingLargeInputStatus = { message: null, options: { ...options, forceStatus: true } };
  if (largeInputStatusTimer) return;
  largeInputStatusTimer = setTimeout(() => {
    largeInputStatusTimer = 0;
    const pending = pendingLargeInputStatus;
    pendingLargeInputStatus = null;
    if (pending) refreshStatus(pending.message, pending.options);
  }, LARGE_INPUT_STATUS_THROTTLE_MS);
}

export function refreshStatus(message = null, options = {}) {
  const throttleLargeInput = shouldUseLargeInputStatusThrottle(options);
  if (throttleLargeInput && options.forceStatus !== true) {
    const now = Date.now();
    if (now - lastLargeInputStatusAt < LARGE_INPUT_STATUS_THROTTLE_MS) {
      scheduleLargeInputStatusRefresh(message, options);
      setRootDatasetValue('statusDocumentThrottle', 'large-input');
      return;
    }
    lastLargeInputStatusAt = now;
  }
  const largeAnalysis = getLargeTextModeAnalysis();
  const fastLargeStatus = largeAnalysis?.active === true
    && options.input === true
    && isTypingLikeInput(options.inputType || '', typeof options.data === 'string' ? options.data : '')
    && !isHardUndoBoundary(options.inputType || '', typeof options.data === 'string' ? options.data : '');
  setDocumentStatus({
    fileName: getDisplayFileName(),
    hasPath: !!state.currentFilePath,
    dirty: state.dirty,
    length: state.rawCode.length,
    text: fastLargeStatus ? '' : state.rawCode,
    lineCount: fastLargeStatus ? largeAnalysis.lineCount : null,
    hasZeroWidth: fastLargeStatus ? largeAnalysis.hasZeroWidth === true : null,
    hasTab: fastLargeStatus ? largeAnalysis.hasTab === true : null,
    fastLarge: fastLargeStatus,
  });
  renderDocumentTabs();
  if (message) setStatusMessage(message);
}

export function syncTextAreasFromState(message = null, options = {}) {
  clearDocumentInputUndoState();
  clearDeferredCodeSyncTimer();
  normalizeActiveDocumentExplicitDefaultRepresentation();
  state.isSyncing = true;
  editorText.value = editorProjectionText(state.rawCode);
  state.isSyncing = false;
  refreshLargeTextMode();
  syncCodeFromDocument();
  updateLineNumbers();
  refreshStatus(message);
  restorePendingSelection();
  notifyDocumentViewSynced(message || 'sync', options);
}

export function activateDocumentInViews(id, message = '문서 탭 전환') {
  clearDocumentInputUndoState();
  saveActiveDocumentViewState();
  if (!setActiveDocumentId(id)) return false;
  clearDeferredCodeSyncTimer();
  normalizeActiveDocumentExplicitDefaultRepresentation();
  state.isSyncing = true;
  editorText.value = editorProjectionText(state.rawCode);
  state.isSyncing = false;
  refreshLargeTextMode();
  syncCodeFromDocument();
  updateLineNumbers();
  restoreDocumentViewState(getActiveDocument());
  refreshStatus(message);
  externalChangeCallback?.('change', state.activeView);
  notifyDocumentViewSynced(message || 'activate');
  return true;
}

export function getActiveTextArea() {
  if (document.activeElement === codeText) return codeText;
  if (document.activeElement === editorText) return editorText;
  return state.activeView === "code" ? codeText : editorText;
}

export function getEditorTextArea() { return editorText; }
export function getCodeTextArea() { return codeText; }

export function focusActiveDocumentTextArea() {
  const el = state.activeView === 'code' ? codeText : editorText;
  if (!el) return;
  el.focus({ preventScroll: true });
}

export function applyDocumentTextAction(nextText, { source = state.activeView, label = '문서 수정', snapshot = null, dirty = true, actionType = 'command', mergeKey = null, selectionRestoreMode = 'preserve' } = {}) {
  const normalized = normalizeNewlines(nextText);
  if (normalized === state.rawCode) {
    if (label) setStatusMessage(`${label}: 변경 없음`);
    return false;
  }
  flushDocumentInputUndoState();
  const beforeSnapshot = snapshot || captureDocumentSnapshot(source);
  const afterSnapshot = snapshotWithRawCode(captureDocumentSnapshot(source), normalized, source);
  recordEditAction({ before: beforeSnapshot, after: afterSnapshot, actionType, activeView: source, mergeKey, merge: false, selectionRestoreMode });
  setRawCode(normalized, source, { dirty });
  syncTextAreasFromState(label);
  return true;
}

function replaceRange(text, start, end, insert) {
  return String(text ?? '').slice(0, start) + String(insert ?? '') + String(text ?? '').slice(end);
}

export function insertAtActiveView({ codeLiteral, editorText: editorInsert, label = "입력" }) {
  const el = getActiveTextArea();
  const isCode = el === codeText;
  const source = isCode ? 'code' : 'editor';
  const text = isCode ? String(codeLiteral ?? editorInsert ?? "") : String(editorInsert ?? codeLiteral ?? "");
  el.focus({ preventScroll: true });
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  const snapshot = captureDocumentSnapshot(source);
  const viewText = replaceRange(el.value, start, end, text);
  const nextDocumentText = isCode ? normalizeCodePaneRawInput(viewText) : mergeEditorVisibleTextIntoRawCode(state.rawCode, normalizeNewlines(viewText), { beforeSelection: { start, end }, inputType: 'insertReplacementText', data: text });
  if (!applyDocumentTextAction(nextDocumentText, { source, label, snapshot, actionType: 'insert', selectionRestoreMode: 'collapse-end' })) return;
  const area = isCode ? codeText : editorText;
  const nextPos = start + text.length;
  area.focus({ preventScroll: true });
  try { area.setSelectionRange(nextPos, nextPos); } catch (_) {}
  refreshStatus(label);
}
