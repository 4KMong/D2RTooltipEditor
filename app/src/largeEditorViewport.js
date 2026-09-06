import { isLargeTextModeActive } from './largeTextMode.js';

export const LARGE_EDITOR_VIEWPORT_TARGET_LINES = 1000;
export const LARGE_EDITOR_VIEWPORT_MAX_CHARS = 20000;
export const LARGE_EDITOR_VIEWPORT_EDGE_LINES = 180;

let editor = null;
let host = null;
let spacer = null;
let surface = null;
let enabled = false;
let fullSurfaceFallback = false;
let compositionActive = false;
let documentValue = '';
let windowValue = '';
let windowStart = 0;
let windowEnd = 0;
let windowStartLine = 0;
let windowEndLine = 0;
let lineStarts = [0];
let scrollFrame = 0;
let recenterTimer = 0;
let syntheticScrollDispatch = false;
let virtualSelectAll = false;
let storedSelection = { start: 0, end: 0, direction: 'none' };
let nativeSelectionRepresentsDocument = true;
let lastWindowReason = '';
let pointerSelectionActive = false;
let pendingShiftClick = null;
let deferredScrollWindowRefresh = false;
let deferredPointerDocumentSync = false;
let deferredPointerDocumentReason = '';
let pointerReleaseFrame = 0;
let pointerReleaseToken = 0;

function setPointerSelectionActive(active, reason = '') {
  const next = active === true;
  const changed = pointerSelectionActive !== next;
  pointerSelectionActive = next;
  document.body?.classList.toggle('large-editor-pointer-selecting', next);
  setRootDatasetValue('largeEditorPointerSelection', next ? 'active' : 'idle');
  if (!changed) return next;
  try {
    window.dispatchEvent(new CustomEvent('ttedit-large-editor-pointer-selection-changed', {
      detail: { active: next, reason: String(reason || '') },
    }));
  } catch (_) {}
  return next;
}

const proto = typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement.prototype : null;
const valueDescriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
const selectionStartDescriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'selectionStart') : null;
const selectionEndDescriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'selectionEnd') : null;
const selectionDirectionDescriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'selectionDirection') : null;
const nativeSetSelectionRange = proto?.setSelectionRange;
const nativeSetRangeText = proto?.setRangeText;
const nativeSelect = proto?.select;

function nativeValueGet() {
  return valueDescriptor?.get?.call(editor) ?? '';
}

function nativeValueSet(value) {
  valueDescriptor?.set?.call(editor, String(value ?? ''));
}

function nativeSelectionStartGet() {
  return selectionStartDescriptor?.get?.call(editor) ?? 0;
}

function nativeSelectionEndGet() {
  return selectionEndDescriptor?.get?.call(editor) ?? nativeSelectionStartGet();
}

function nativeSelectionDirectionGet() {
  return selectionDirectionDescriptor?.get?.call(editor) || 'none';
}

function nativeSelectionStartSet(value) {
  selectionStartDescriptor?.set?.call(editor, Math.max(0, Number(value) || 0));
}

function nativeSelectionEndSet(value) {
  selectionEndDescriptor?.set?.call(editor, Math.max(0, Number(value) || 0));
}

function nativeMetricDescriptor(prop) {
  if (typeof Element !== 'undefined') {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (descriptor) return descriptor;
  }
  if (typeof HTMLElement !== 'undefined') {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    if (descriptor) return descriptor;
  }
  return null;
}

function nativeMetricGet(prop) {
  return nativeMetricDescriptor(prop)?.get?.call(editor) || 0;
}

function nativeMetricSet(prop, value) {
  nativeMetricDescriptor(prop)?.set?.call(editor, Math.max(0, Number(value) || 0));
}

function nowMs() {
  try { return performance.now(); } catch (_) { return Date.now(); }
}

function setRootDatasetValue(key, value) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (document.documentElement.dataset.developerMode !== 'true') return;
  const next = String(value ?? '');
  if (document.documentElement.dataset[key] !== next) document.documentElement.dataset[key] = next;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function nativeTextareaVisualLineCount(text = '') {
  const source = String(text ?? '');
  let lines = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lines += 1;
  return lines;
}

function resetNativeViewportScroll(reason = 'native-scroll-reset') {
  if (!viewportActive() || !editor) return false;
  const nativeTop = Math.max(0, Number(nativeMetricGet('scrollTop')) || 0);
  const nativeLeft = Math.max(0, Number(nativeMetricGet('scrollLeft')) || 0);
  if (nativeTop < 0.5 && nativeLeft < 0.5) return false;
  nativeMetricSet('scrollTop', 0);
  nativeMetricSet('scrollLeft', 0);
  setRootDatasetValue('largeEditorNativeScrollReset', `${reason}:${Math.round(nativeTop * 100) / 100}:${Math.round(nativeLeft * 100) / 100}`);
  return true;
}

function scheduleNativeViewportScrollReset(reason = 'native-scroll-reset') {
  if (!viewportActive()) return false;
  try { queueMicrotask(() => resetNativeViewportScroll(`${reason}:microtask`)); } catch (_) {}
  requestAnimationFrame(() => resetNativeViewportScroll(`${reason}:raf`));
  return true;
}

function buildLineStarts(text = documentValue) {
  const source = String(text ?? '');
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineHeightPx() {
  if (!editor || typeof getComputedStyle !== 'function') return 27;
  const cs = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(cs.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = Number.parseFloat(cs.fontSize) || 16;
  return Math.max(1, fontSize * 1.45);
}

function paddingTopPx() {
  if (!editor || typeof getComputedStyle !== 'function') return 12;
  return Math.max(0, Number.parseFloat(getComputedStyle(editor).paddingTop) || 0);
}


function lineAtOffset(offset) {
  const target = Math.max(0, Math.min(Number(offset) || 0, documentValue.length));
  let lo = 0;
  let hi = lineStarts.length - 1;
  let answer = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= target) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

function offsetAtLine(line) {
  const index = Math.max(0, Math.min(Number(line) || 0, Math.max(0, lineStarts.length - 1)));
  return lineStarts[index] ?? documentValue.length;
}

function normalizeSelection(selection = null) {
  const source = selection || storedSelection || { start: 0, end: 0, direction: 'none' };
  const start = Math.max(0, Math.min(documentValue.length, Number(source.start) || 0));
  const end = Math.max(start, Math.min(documentValue.length, Number(source.end) || start));
  return { start, end, direction: source.direction || 'none' };
}

function rememberSelection(selection = null) {
  storedSelection = normalizeSelection(selection);
  return storedSelection;
}

function syncStoredSelectionFromNative() {
  if (!editor) return storedSelection;
  if (!enabled || fullSurfaceFallback) {
    return rememberSelection({
      start: nativeSelectionStartGet(),
      end: nativeSelectionEndGet(),
      direction: nativeSelectionDirectionGet(),
    });
  }
  if (!nativeSelectionRepresentsDocument) return storedSelection;
  return rememberSelection({
    start: windowStart + nativeSelectionStartGet(),
    end: windowStart + nativeSelectionEndGet(),
    direction: nativeSelectionDirectionGet(),
  });
}

function documentSelection() {
  if (virtualSelectAll) return { start: 0, end: documentValue.length, direction: 'none' };
  if (!enabled || fullSurfaceFallback) return syncStoredSelectionFromNative();
  return normalizeSelection(storedSelection);
}

function selectionFitsWindow(selection = storedSelection, start = windowStart, end = windowEnd) {
  const safe = normalizeSelection(selection);
  return safe.start >= start && safe.end <= end;
}

function selectionAnchor(selection = storedSelection) {
  const safe = normalizeSelection(selection);
  if (safe.start === safe.end) return safe.start;
  return safe.direction === 'backward' ? safe.end : safe.start;
}

function nativeSelectionFocusOffset() {
  const start = nativeSelectionStartGet();
  const end = nativeSelectionEndGet();
  return nativeSelectionDirectionGet() === 'backward' ? start : end;
}

function finishDeferredScrollWindowRefresh(reason = 'pointer-release') {
  if ((!deferredScrollWindowRefresh && !deferredPointerDocumentSync)
    || !viewportActive() || compositionActive || pointerSelectionActive) return false;
  const needsDocumentSync = deferredPointerDocumentSync;
  const documentReason = deferredPointerDocumentReason || reason;
  deferredScrollWindowRefresh = false;
  deferredPointerDocumentSync = false;
  deferredPointerDocumentReason = '';
  if (needsDocumentSync) {
    const selection = normalizeSelection(storedSelection);
    const focus = selection.direction === 'backward' ? selection.start : selection.end;
    return renderWindow({
      anchorOffset: focus,
      selection,
      includeSelection: true,
      preserveScroll: true,
      reason: `pointer-release:${documentReason}`,
    });
  }
  return renderWindowForScroll(reason);
}

function cancelPointerSelectionRelease() {
  pointerReleaseToken += 1;
  if (pointerReleaseFrame) {
    try { cancelAnimationFrame(pointerReleaseFrame); } catch (_) {}
    pointerReleaseFrame = 0;
  }
}

function commitPendingShiftClick(reason = 'shift-click-release') {
  if (!viewportActive() || !pendingShiftClick) return false;
  const pending = pendingShiftClick;
  pendingShiftClick = null;
  const nativeStart = nativeSelectionStartGet();
  const nativeEnd = nativeSelectionEndGet();
  let nativeFocus = nativeSelectionFocusOffset();
  if (pending.anchor < pending.windowStart) nativeFocus = nativeEnd;
  else if (pending.anchor > pending.windowEnd) nativeFocus = nativeStart;
  const localFocus = Math.max(0, Math.min(windowValue.length, nativeFocus));
  const focus = Math.max(0, Math.min(documentValue.length, pending.windowStart + localFocus));
  rememberSelection({
    start: Math.min(pending.anchor, focus),
    end: Math.max(pending.anchor, focus),
    direction: pending.anchor <= focus ? 'forward' : 'backward',
  });
  virtualSelectAll = false;
  applyNativeWindowSelection(storedSelection);
  setRootDatasetValue('largeEditorPointerReleaseSelection', `${storedSelection.start}:${storedSelection.end}:${reason}`);
  return true;
}

function schedulePointerSelectionRelease(reason = 'pointer-release') {
  if (!pointerSelectionActive) return false;
  // `mouseup` capture runs before the browser has completed its native textarea
  // selection default action. Releasing the barrier there lets deferred value,
  // selection and color-overlay work overwrite the drag inside the same event.
  // Keep the gesture exclusive through the next animation frame, then read the
  // final native range and only afterwards flush deferred projection/rendering.
  if (pointerReleaseFrame) return true;
  const token = ++pointerReleaseToken;
  pointerReleaseFrame = requestAnimationFrame(() => {
    pointerReleaseFrame = 0;
    if (token !== pointerReleaseToken || !pointerSelectionActive) return;
    if (viewportActive()) {
      if (!commitPendingShiftClick(reason)) {
        nativeSelectionRepresentsDocument = true;
        syncStoredSelectionFromNative();
      }
    } else if (fullSurfaceFallback) {
      syncStoredSelectionFromNative();
    }
    setPointerSelectionActive(false, reason);
    finishDeferredScrollWindowRefresh(reason);
    if (fullSurfaceFallback) {
      const selection = documentSelection();
      if (enabled && !compositionActive && selection.end - selection.start <= LARGE_EDITOR_VIEWPORT_MAX_CHARS) {
        scheduleFallbackResume('pointer-resume', 30);
      }
    }
  });
  return true;
}

function applyNativeWindowSelection(selection = storedSelection) {
  const safe = normalizeSelection(selection);
  const exact = selectionFitsWindow(safe);
  let localStart = 0;
  let localEnd = 0;
  if (safe.start === safe.end) {
    const local = Math.max(0, Math.min(windowValue.length, safe.start - windowStart));
    localStart = local;
    localEnd = local;
  } else {
    const intersectionStart = Math.max(safe.start, windowStart);
    const intersectionEnd = Math.min(safe.end, windowEnd);
    if (intersectionEnd > intersectionStart) {
      localStart = Math.max(0, Math.min(windowValue.length, intersectionStart - windowStart));
      localEnd = Math.max(localStart, Math.min(windowValue.length, intersectionEnd - windowStart));
    } else if (safe.end <= windowStart) {
      localStart = 0;
      localEnd = 0;
    } else {
      localStart = windowValue.length;
      localEnd = windowValue.length;
    }
  }
  try { nativeSetSelectionRange?.call(editor, localStart, localEnd, safe.direction || 'none'); } catch (_) {}
  nativeSelectionRepresentsDocument = exact;
  return exact;
}

function viewportActive() {
  return enabled && !fullSurfaceFallback;
}

function attachViewportHost() {
  if (!surface || !host || !spacer) return false;
  if (surface.parentElement === spacer && spacer.parentElement === host && host.parentElement) return true;
  const parent = surface.parentElement;
  if (!parent) return false;
  parent.insertBefore(host, surface);
  host.appendChild(spacer);
  spacer.appendChild(surface);
  return true;
}

function detachViewportHost() {
  if (!surface || !host || !spacer) return false;
  const parent = host.parentElement;
  if (!parent || surface.parentElement !== spacer) return false;
  parent.insertBefore(surface, host);
  host.remove();
  return true;
}

function visibleLineRange(scrollTop = host?.scrollTop || 0) {
  const lh = lineHeightPx();
  const firstLine = Math.max(0, Math.floor((Math.max(0, Number(scrollTop) || 0) - paddingTopPx()) / lh));
  const visibleLines = Math.max(1, Math.ceil((host?.clientHeight || lh) / lh) + 1);
  const lastLine = Math.max(firstLine, Math.min(Math.max(0, lineStarts.length - 1), firstLine + visibleLines - 1));
  return { firstLine, lastLine, visibleLines, centerLine: Math.floor((firstLine + lastLine) / 2) };
}

function renderWindowForScroll(reason = 'scroll-window') {
  if (!viewportActive() || compositionActive) return false;
  const range = visibleLineRange();
  const anchorOffset = offsetAtLine(range.centerLine);
  return renderWindow({
    anchorOffset,
    selection: storedSelection,
    includeSelection: false,
    preserveScroll: true,
    reason,
  });
}

function revealStoredSelectionForKeyboard(reason = 'keyboard-reveal') {
  if (!viewportActive() || nativeSelectionRepresentsDocument || compositionActive) return false;
  const selection = normalizeSelection(storedSelection);
  const rendered = renderWindow({
    anchorOffset: selection.end,
    selection,
    includeSelection: true,
    preserveScroll: false,
    reason,
  });
  if (rendered && host) {
    const line = lineAtOffset(selection.end);
    host.scrollTop = Math.max(0, line * lineHeightPx() - (host.clientHeight || 0) * 0.45);
  }
  return rendered;
}

function updateSpacerGeometry() {
  if (!host || !spacer || !surface || !editor || !viewportActive()) return;
  const lh = lineHeightPx();
  const topPadding = paddingTopPx();
  const trailing = Math.max(12, Math.round((host.clientHeight || 0) * 0.5));
  const totalHeight = Math.max(host.clientHeight || 0, Math.ceil(topPadding + lineStarts.length * lh + trailing));
  // A bounded window usually ends at the next line start, so windowValue often
  // includes the trailing `\n`. Native textarea layout therefore owns one more
  // blank visual row than (windowEndLine - windowStartLine + 1). If the surface
  // is one row too short, Chromium internally scrolls the textarea to reveal the
  // IME caret while the outer virtual host still assumes native scrollTop === 0.
  // That hidden internal scroll is the source of intermittent one-row caret jumps.
  const windowVisualLineCount = nativeTextareaVisualLineCount(windowValue);
  const top = Math.max(0, Math.floor(windowStartLine * lh));
  const contentSurfaceHeight = Math.max(lh + topPadding + 12, Math.ceil(topPadding + windowVisualLineCount * lh + 12));
  // The final viewport window must also own the blank area below the last line.
  // Otherwise that area belongs to the spacer, gets an arrow cursor, and clicking it
  // cannot place the native textarea caret at the document end.
  const reachesDocumentEnd = windowEnd >= documentValue.length || windowEndLine >= lineStarts.length - 1;
  const surfaceHeight = reachesDocumentEnd
    ? Math.max(contentSurfaceHeight, Math.ceil(totalHeight - top))
    : contentSurfaceHeight;

  spacer.style.height = `${totalHeight}px`;
  surface.style.top = `${top}px`;
  surface.style.height = `${surfaceHeight}px`;
  surface.style.minHeight = `${surfaceHeight}px`;

  const priorLeft = host.scrollLeft || 0;
  const baseWidth = Math.max(1, host.clientWidth || 1);
  surface.style.width = `${baseWidth}px`;
  spacer.style.minWidth = `${baseWidth}px`;
  let desiredWidth = baseWidth;
  try {
    desiredWidth = Math.max(baseWidth, Number(nativeMetricGet('scrollWidth')) || baseWidth);
  } catch (_) {}
  surface.style.width = `${Math.ceil(desiredWidth)}px`;
  spacer.style.minWidth = `${Math.ceil(desiredWidth)}px`;
  host.scrollLeft = priorLeft;
  resetNativeViewportScroll('geometry');
}

function notifyWindowChanged(reason = 'window') {
  lastWindowReason = reason;
  setRootDatasetValue('largeEditorViewport', viewportActive() ? 'on' : fullSurfaceFallback ? 'full-fallback' : 'off');
  setRootDatasetValue('largeEditorViewportWindowStart', windowStart);
  setRootDatasetValue('largeEditorViewportWindowEnd', windowEnd);
  setRootDatasetValue('largeEditorViewportStartLine', windowStartLine + 1);
  setRootDatasetValue('largeEditorViewportEndLine', windowEndLine + 1);
  setRootDatasetValue('largeEditorViewportWindowLength', windowValue.length);
  setRootDatasetValue('largeEditorViewportReason', reason);
  try {
    window.dispatchEvent(new CustomEvent('ttedit-large-editor-window-changed', {
      detail: getLargeEditorViewportWindow(),
    }));
  } catch (_) {}
}

function chooseWindow(anchorOffset, selectionStart = anchorOffset, selectionEnd = anchorOffset, includeSelection = true) {
  const count = Math.max(1, lineStarts.length);
  const anchorLine = lineAtOffset(anchorOffset);
  let startLine = Math.max(0, anchorLine - Math.floor(LARGE_EDITOR_VIEWPORT_TARGET_LINES / 2));
  let endLine = Math.min(count - 1, startLine + LARGE_EDITOR_VIEWPORT_TARGET_LINES - 1);
  startLine = Math.max(0, endLine - LARGE_EDITOR_VIEWPORT_TARGET_LINES + 1);

  const selectionFirstLine = lineAtOffset(selectionStart);
  const selectionLastLine = lineAtOffset(selectionEnd);
  if (includeSelection && selectionLastLine - selectionFirstLine + 1 <= LARGE_EDITOR_VIEWPORT_TARGET_LINES) {
    if (selectionFirstLine < startLine) {
      startLine = selectionFirstLine;
      endLine = Math.min(count - 1, startLine + LARGE_EDITOR_VIEWPORT_TARGET_LINES - 1);
    }
    if (selectionLastLine > endLine) {
      endLine = selectionLastLine;
      startLine = Math.max(0, endLine - LARGE_EDITOR_VIEWPORT_TARGET_LINES + 1);
    }
  }

  let start = offsetAtLine(startLine);
  let end = endLine + 1 < count ? offsetAtLine(endLine + 1) : documentValue.length;

  while (end - start > LARGE_EDITOR_VIEWPORT_MAX_CHARS && endLine > startLine) {
    const topDistance = anchorLine - startLine;
    const bottomDistance = endLine - anchorLine;
    if (bottomDistance >= topDistance) endLine -= 1;
    else startLine += 1;
    start = offsetAtLine(startLine);
    end = endLine + 1 < count ? offsetAtLine(endLine + 1) : documentValue.length;
  }

  return { start, end, startLine, endLine };
}

function renderWindow({ anchorOffset = 0, selection = null, preserveScroll = true, includeSelection = true, reason = 'render' } = {}) {
  if (!viewportActive() || !editor) return false;
  // A native textarea drag owns both its anchor and focus until mouseup. Any
  // value rewrite or programmatic selection during that interval cancels the
  // browser selection, even when the rewrite was triggered only by an IME/color
  // handoff. Keep the model current but postpone the native window rewrite.
  if (pointerSelectionActive) {
    deferredPointerDocumentSync = true;
    deferredPointerDocumentReason = reason;
    setRootDatasetValue('largeEditorPointerDeferredWindow', reason);
    return false;
  }
  const startedAt = nowMs();
  const docSelection = selection || documentSelection();
  const safeStart = Math.max(0, Math.min(documentValue.length, Number(docSelection.start) || 0));
  const safeEnd = Math.max(safeStart, Math.min(documentValue.length, Number(docSelection.end) || safeStart));
  if (includeSelection && safeEnd - safeStart > LARGE_EDITOR_VIEWPORT_MAX_CHARS) {
    enterFullSurfaceFallback({ selection: { start: safeStart, end: safeEnd, direction: docSelection.direction }, reason: 'wide-selection' });
    return false;
  }

  const priorTop = preserveScroll ? host?.scrollTop || 0 : 0;
  const priorLeft = preserveScroll ? host?.scrollLeft || 0 : 0;
  const next = chooseWindow(anchorOffset, safeStart, safeEnd, includeSelection);
  const nextValue = documentValue.slice(next.start, next.end);
  const sameWindow = next.start === windowStart && next.end === windowEnd && nextValue === windowValue;
  rememberSelection({ start: safeStart, end: safeEnd, direction: docSelection.direction || 'none' });
  if (sameWindow) {
    if (includeSelection) applyNativeWindowSelection(storedSelection);
    updateSpacerGeometry();
    return false;
  }
  windowStart = next.start;
  windowEnd = next.end;
  windowStartLine = next.startLine;
  windowEndLine = next.endLine;
  windowValue = nextValue;
  nativeValueSet(windowValue);
  applyNativeWindowSelection(storedSelection);
  updateSpacerGeometry();
  if (preserveScroll && host) {
    host.scrollTop = priorTop;
    host.scrollLeft = priorLeft;
  }
  notifyWindowChanged(reason);
  setRootDatasetValue('largeEditorViewportSwapMs', (nowMs() - startedAt).toFixed(1));
  return true;
}

function setDocumentValue(nextValue, { selection = null, reason = 'set-value' } = {}) {
  documentValue = normalizeText(nextValue);
  lineStarts = buildLineStarts(documentValue);
  virtualSelectAll = false;
  if (!enabled) {
    rememberSelection(selection || storedSelection);
    nativeValueSet(documentValue);
    return;
  }
  if (viewportActive() && pointerSelectionActive) {
    // The native value already contains the text the user is dragging across.
    // Replacing it here (typically from a forced IME commit) destroys that drag.
    // The native selection captured on mouseup becomes authoritative, then the
    // latest documentValue is projected back into the bounded window.
    deferredPointerDocumentSync = true;
    deferredPointerDocumentReason = reason;
    setRootDatasetValue('largeEditorPointerDeferredValue', reason);
    return;
  }
  rememberSelection(selection || storedSelection);
  if (fullSurfaceFallback) {
    nativeValueSet(documentValue);
    try { nativeSetSelectionRange?.call(editor, storedSelection.start, storedSelection.end, storedSelection.direction || 'none'); } catch (_) {}
    nativeSelectionRepresentsDocument = true;
    return;
  }
  const docSelection = normalizeSelection(storedSelection);
  renderWindow({ anchorOffset: docSelection.end, selection: docSelection, reason });
}

function updateLineStartsForEdit(editStart, editEnd, insertedText) {
  const delta = insertedText.length - (editEnd - editStart);
  const next = [];
  for (const start of lineStarts) {
    if (start > editStart && start <= editEnd) continue;
    if (start > editEnd) next.push(start + delta);
    else next.push(start);
  }
  for (let i = 0; i < insertedText.length; i++) {
    if (insertedText[i] === '\n') next.push(editStart + i + 1);
  }
  next.sort((a, b) => a - b);
  const deduped = [];
  for (const value of next) if (!deduped.length || deduped[deduped.length - 1] !== value) deduped.push(value);
  lineStarts = deduped.length ? deduped : [0];
}

function patchDocumentFromNativeWindow() {
  if (!viewportActive()) return false;
  const current = normalizeText(nativeValueGet());
  const previous = windowValue;
  if (current === previous) return false;

  let prefix = 0;
  const prefixLimit = Math.min(previous.length, current.length);
  while (prefix < prefixLimit && previous.charCodeAt(prefix) === current.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  const suffixLimit = Math.min(previous.length - prefix, current.length - prefix);
  while (suffix < suffixLimit
    && previous.charCodeAt(previous.length - 1 - suffix) === current.charCodeAt(current.length - 1 - suffix)) suffix += 1;

  const editStart = windowStart + prefix;
  const editEnd = windowStart + previous.length - suffix;
  const insertedText = current.slice(prefix, current.length - suffix);
  documentValue = documentValue.slice(0, editStart) + insertedText + documentValue.slice(editEnd);
  updateLineStartsForEdit(editStart, editEnd, insertedText);
  windowValue = current;
  windowEnd = windowStart + current.length;
  windowEndLine = lineAtOffset(Math.max(windowStart, windowEnd - 1));
  nativeSelectionRepresentsDocument = true;
  rememberSelection({
    start: windowStart + nativeSelectionStartGet(),
    end: windowStart + nativeSelectionEndGet(),
    direction: nativeSelectionDirectionGet(),
  });
  virtualSelectAll = false;
  updateSpacerGeometry();
  notifyWindowChanged('native-input');
  return true;
}

function scheduleRecenter(reason = 'idle', delayMs = 80) {
  if (recenterTimer) clearTimeout(recenterTimer);
  recenterTimer = setTimeout(() => {
    recenterTimer = 0;
    if (!viewportActive() || compositionActive) return;
    const selection = documentSelection();
    if (selection.start !== selection.end) return;
    const caretLine = lineAtOffset(selection.end);
    if (caretLine < windowStartLine + LARGE_EDITOR_VIEWPORT_EDGE_LINES
      || caretLine > windowEndLine - LARGE_EDITOR_VIEWPORT_EDGE_LINES) {
      renderWindow({ anchorOffset: selection.end, selection, reason });
    }
  }, Math.max(0, Number(delayMs) || 0));
}

function enterFullSurfaceFallback({ selection = null, reason = 'fallback' } = {}) {
  if (!enabled || fullSurfaceFallback || !editor) return false;
  const docSelection = rememberSelection(selection || documentSelection());
  const top = host?.scrollTop || 0;
  const left = host?.scrollLeft || 0;
  fullSurfaceFallback = true;
  document.body?.classList.remove('large-editor-viewport-active');
  document.body?.classList.add('large-editor-full-surface-fallback');
  nativeValueSet(documentValue);
  try { nativeSetSelectionRange?.call(editor, docSelection.start, docSelection.end, docSelection.direction || 'none'); } catch (_) {}
  nativeSelectionRepresentsDocument = true;
  if (host) { host.scrollTop = 0; host.scrollLeft = 0; }
  try { editor.scrollTop = top; editor.scrollLeft = left; } catch (_) {}
  notifyWindowChanged(reason);
  return true;
}

function leaveFullSurfaceFallback(reason = 'resume') {
  if (!enabled || !fullSurfaceFallback || compositionActive || !editor) return false;
  const selection = rememberSelection({
    start: nativeSelectionStartGet(),
    end: nativeSelectionEndGet(),
    direction: nativeSelectionDirectionGet(),
  });
  const top = editor.scrollTop || 0;
  const left = editor.scrollLeft || 0;
  documentValue = normalizeText(nativeValueGet());
  lineStarts = buildLineStarts(documentValue);
  fullSurfaceFallback = false;
  virtualSelectAll = false;
  document.body?.classList.remove('large-editor-full-surface-fallback');
  document.body?.classList.add('large-editor-viewport-active');
  renderWindow({ anchorOffset: selection.end, selection, preserveScroll: false, reason });
  if (host) { host.scrollTop = top; host.scrollLeft = left; }
  return true;
}

function scheduleFallbackResume(reason = 'fallback-idle', delayMs = 160) {
  if (recenterTimer) clearTimeout(recenterTimer);
  recenterTimer = setTimeout(() => {
    recenterTimer = 0;
    if (!compositionActive) leaveFullSurfaceFallback(reason);
  }, Math.max(0, Number(delayMs) || 0));
}

function setDocumentSelection(start, end = start, direction = 'none') {
  if (!enabled) {
    const nativeLength = nativeValueGet().length;
    const nativeStart = Math.max(0, Math.min(nativeLength, Number(start) || 0));
    const nativeEnd = Math.max(nativeStart, Math.min(nativeLength, Number(end) || nativeStart));
    try { nativeSetSelectionRange?.call(editor, nativeStart, nativeEnd, direction); } catch (_) {}
    return;
  }
  const safeStart = Math.max(0, Math.min(documentValue.length, Number(start) || 0));
  const safeEnd = Math.max(safeStart, Math.min(documentValue.length, Number(end) || safeStart));
  if (viewportActive() && pointerSelectionActive) {
    // Programmatic selection restoration during mousedown (notably a forced IME
    // commit) must not replace the user's in-progress native drag selection.
    setRootDatasetValue('largeEditorPointerDeferredSelection', `${safeStart}:${safeEnd}`);
    return;
  }
  const nextSelection = rememberSelection({ start: safeStart, end: safeEnd, direction });
  virtualSelectAll = false;
  if (fullSurfaceFallback) {
    try { nativeSetSelectionRange?.call(editor, safeStart, safeEnd, direction); } catch (_) {}
    nativeSelectionRepresentsDocument = true;
    // Programmatic commands such as paste/undo can collapse a temporary
    // full-document selection without producing a native input event. Resume the
    // bounded viewport after that small selection is established, or the editor
    // can remain on the expensive full textarea indefinitely.
    if (!compositionActive && safeEnd - safeStart <= LARGE_EDITOR_VIEWPORT_MAX_CHARS) {
      scheduleFallbackResume('selection-set-resume', 30);
    }
    return;
  }
  if (safeEnd - safeStart > LARGE_EDITOR_VIEWPORT_MAX_CHARS) {
    enterFullSurfaceFallback({ selection: { start: safeStart, end: safeEnd, direction }, reason: 'selection-span' });
    return;
  }
  if (safeStart < windowStart || safeEnd > windowEnd) {
    renderWindow({ anchorOffset: safeEnd, selection: nextSelection, includeSelection: true, reason: 'selection-reveal' });
    const line = lineAtOffset(safeEnd);
    if (host) host.scrollTop = Math.max(0, line * lineHeightPx() - (host.clientHeight || 0) * 0.45);
    return;
  }
  applyNativeWindowSelection(nextSelection);
}

function installPropertyCompatibility() {
  if (!editor || editor.dataset.largeViewportPatched === 'true') return;
  editor.dataset.largeViewportPatched = 'true';

  Object.defineProperty(editor, 'value', {
    configurable: true,
    get() { return enabled ? documentValue : nativeValueGet(); },
    set(value) {
      if (!enabled) nativeValueSet(normalizeText(value));
      else setDocumentValue(value, { reason: 'property-set' });
    },
  });

  Object.defineProperty(editor, 'selectionStart', {
    configurable: true,
    get() { return enabled ? documentSelection().start : nativeSelectionStartGet(); },
    set(value) {
      if (!enabled || fullSurfaceFallback) {
        nativeSelectionStartSet(value);
        return;
      }
      const prior = documentSelection();
      const nextStart = Math.max(0, Math.min(documentValue.length, Number(value) || 0));
      const nextEnd = nextStart > prior.end ? nextStart : prior.end;
      setDocumentSelection(nextStart, nextEnd, prior.direction);
    },
  });

  Object.defineProperty(editor, 'selectionEnd', {
    configurable: true,
    get() { return enabled ? documentSelection().end : nativeSelectionEndGet(); },
    set(value) {
      if (!enabled || fullSurfaceFallback) {
        nativeSelectionEndSet(value);
        return;
      }
      const prior = documentSelection();
      const nextEnd = Math.max(0, Math.min(documentValue.length, Number(value) || 0));
      const nextStart = nextEnd < prior.start ? nextEnd : prior.start;
      setDocumentSelection(nextStart, nextEnd, prior.direction);
    },
  });

  Object.defineProperty(editor, 'selectionDirection', {
    configurable: true,
    get() { return enabled ? documentSelection().direction : nativeSelectionDirectionGet(); },
    set(value) {
      if (!enabled) {
        selectionDirectionDescriptor?.set?.call(editor, value || 'none');
        return;
      }
      const selection = documentSelection();
      setDocumentSelection(selection.start, selection.end, value || 'none');
    },
  });

  editor.setSelectionRange = function(start, end, direction = 'none') {
    if (!enabled) return nativeSetSelectionRange?.call(editor, start, end, direction);
    setDocumentSelection(start, end, direction);
  };

  editor.setRangeText = function(replacement, start, end, selectionMode = 'preserve') {
    if (!enabled) return nativeSetRangeText?.call(editor, replacement, start, end, selectionMode);
    const priorSelection = documentSelection();
    const rangeStart = arguments.length < 3 ? priorSelection.start : start;
    const rangeEnd = arguments.length < 3 ? priorSelection.end : end;
    const safeStart = Math.max(0, Math.min(documentValue.length, Number(rangeStart) || 0));
    const safeEnd = Math.max(safeStart, Math.min(documentValue.length, Number(rangeEnd) || safeStart));
    const text = normalizeText(replacement);
    const next = documentValue.slice(0, safeStart) + text + documentValue.slice(safeEnd);
    let nextStart = safeStart;
    let nextEnd = safeStart + text.length;
    if (selectionMode === 'start') nextEnd = nextStart;
    else if (selectionMode === 'end') nextStart = nextEnd;
    else if (selectionMode === 'select') { /* keep replacement selected */ }
    else {
      const prior = priorSelection;
      const delta = text.length - (safeEnd - safeStart);
      if (prior.end <= safeStart) {
        nextStart = prior.start;
        nextEnd = prior.end;
      } else if (prior.start >= safeEnd) {
        nextStart = prior.start + delta;
        nextEnd = prior.end + delta;
      } else {
        nextStart = safeStart;
        nextEnd = safeStart + text.length;
      }
    }
    setDocumentValue(next, { selection: { start: nextStart, end: nextEnd, direction: 'none' }, reason: 'set-range-text' });
  };

  editor.select = function() {
    if (!enabled) return nativeSelect?.call(editor);
    virtualSelectAll = true;
    enterFullSurfaceFallback({ selection: { start: 0, end: documentValue.length, direction: 'none' }, reason: 'select-all' });
    try { nativeSelect?.call(editor); } catch (_) {}
  };

  Object.defineProperty(editor, 'scrollTop', {
    configurable: true,
    get() { return viewportActive() ? (host?.scrollTop || 0) : nativeMetricGet('scrollTop'); },
    set(value) {
      if (viewportActive()) {
        if (host) host.scrollTop = Math.max(0, Number(value) || 0);
      } else {
        nativeMetricSet('scrollTop', value);
      }
    },
  });

  Object.defineProperty(editor, 'scrollLeft', {
    configurable: true,
    get() {
      if (viewportActive()) return host?.scrollLeft || 0;
      return nativeMetricGet('scrollLeft');
    },
    set(value) {
      if (viewportActive()) {
        if (host) host.scrollLeft = Math.max(0, Number(value) || 0);
      } else {
        nativeMetricSet('scrollLeft', value);
      }
    },
  });

  for (const prop of ['scrollHeight', 'scrollWidth', 'clientHeight', 'clientWidth', 'offsetHeight', 'offsetWidth']) {
    try {
      Object.defineProperty(editor, prop, {
        configurable: true,
        get() {
          if (viewportActive() && host) return Number(host[prop]) || 0;
          return nativeMetricGet(prop);
        },
      });
    } catch (_) {}
  }

  const nativeRect = editor.getBoundingClientRect.bind(editor);
  editor.getBoundingClientRect = function() {
    if (viewportActive() && host) return host.getBoundingClientRect();
    return nativeRect();
  };
}

function activateViewport(reason = 'large-mode-on') {
  if (!editor || enabled) return false;
  const selection = {
    start: nativeSelectionStartGet(),
    end: nativeSelectionEndGet(),
    direction: nativeSelectionDirectionGet(),
  };
  const top = nativeMetricGet('scrollTop');
  const left = nativeMetricGet('scrollLeft');
  documentValue = normalizeText(nativeValueGet());
  lineStarts = buildLineStarts(documentValue);
  rememberSelection(selection);
  enabled = true;
  fullSurfaceFallback = false;
  virtualSelectAll = false;
  nativeSelectionRepresentsDocument = true;
  cancelPointerSelectionRelease();
  setPointerSelectionActive(false, 'activate-reset');
  deferredScrollWindowRefresh = false;
  deferredPointerDocumentSync = false;
  deferredPointerDocumentReason = '';
  if (!attachViewportHost()) {
    enabled = false;
    return false;
  }
  document.body?.classList.add('large-editor-viewport-active');
  document.body?.classList.remove('large-editor-full-surface-fallback');

  const range = visibleLineRange(top);
  const selectionLine = lineAtOffset(selection.end);
  const selectionVisible = selectionLine >= range.firstLine && selectionLine <= range.lastLine;
  const anchorOffset = selectionVisible ? selection.end : offsetAtLine(range.centerLine);
  renderWindow({
    anchorOffset,
    selection: storedSelection,
    includeSelection: selectionVisible,
    preserveScroll: false,
    reason: selectionVisible ? reason : `${reason}-scroll-anchor`,
  });
  if (host) { host.scrollTop = top; host.scrollLeft = left; }
  return true;
}

function deactivateViewport(reason = 'large-mode-off') {
  if (!editor || !enabled) return false;
  const selection = documentSelection();
  const top = viewportActive() ? host?.scrollTop || 0 : editor.scrollTop || 0;
  const left = viewportActive() ? host?.scrollLeft || 0 : editor.scrollLeft || 0;
  enabled = false;
  fullSurfaceFallback = false;
  virtualSelectAll = false;
  nativeSelectionRepresentsDocument = true;
  cancelPointerSelectionRelease();
  setPointerSelectionActive(false, 'deactivate');
  pendingShiftClick = null;
  deferredScrollWindowRefresh = false;
  deferredPointerDocumentSync = false;
  deferredPointerDocumentReason = '';
  document.body?.classList.remove('large-editor-viewport-active', 'large-editor-full-surface-fallback');
  nativeValueSet(documentValue);
  try { nativeSetSelectionRange?.call(editor, selection.start, selection.end, selection.direction || 'none'); } catch (_) {}
  surface.style.top = '';
  surface.style.height = '';
  surface.style.minHeight = '';
  surface.style.width = '';
  spacer.style.height = '';
  spacer.style.minWidth = '';
  if (host) { host.scrollTop = 0; host.scrollLeft = 0; }
  detachViewportHost();
  try { editor.scrollTop = top; editor.scrollLeft = left; } catch (_) {}
  notifyWindowChanged(reason);
  return true;
}

function handleHostScroll() {
  if (!viewportActive() || syntheticScrollDispatch) return;
  const range = visibleLineRange();
  const needsWindow = range.firstLine < windowStartLine + LARGE_EDITOR_VIEWPORT_EDGE_LINES
    || range.lastLine > windowEndLine - LARGE_EDITOR_VIEWPORT_EDGE_LINES;
  if (needsWindow && !compositionActive) {
    if (pointerSelectionActive) deferredScrollWindowRefresh = true;
    else renderWindowForScroll('scroll-window');
  }

  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (!viewportActive()) return;
    syntheticScrollDispatch = true;
    try { editor.dispatchEvent(new Event('scroll')); } catch (_) {}
    syntheticScrollDispatch = false;
  });
}

function installEventBridge() {
  editor.addEventListener('input', event => {
    if (!enabled) return;
    if (viewportActive()) {
      patchDocumentFromNativeWindow();
      syncStoredSelectionFromNative();
      resetNativeViewportScroll('input-capture');
      if (event.isComposing || compositionActive) scheduleNativeViewportScrollReset('composition-input');
      if (!event.isComposing && !compositionActive) scheduleRecenter('input-idle', 120);
    } else if (fullSurfaceFallback) {
      documentValue = normalizeText(nativeValueGet());
      lineStarts = buildLineStarts(documentValue);
      syncStoredSelectionFromNative();
      if (!event.isComposing && !compositionActive) scheduleFallbackResume('full-input-resume', 180);
    }
  }, true);

  editor.addEventListener('compositionstart', () => {
    syncStoredSelectionFromNative();
    compositionActive = true;
    resetNativeViewportScroll('composition-start');
    scheduleNativeViewportScrollReset('composition-start');
    if (recenterTimer) { clearTimeout(recenterTimer); recenterTimer = 0; }
  }, true);

  editor.addEventListener('compositionupdate', () => {
    if (!viewportActive()) return;
    resetNativeViewportScroll('composition-update');
    scheduleNativeViewportScrollReset('composition-update');
  }, true);

  editor.addEventListener('compositionend', () => {
    if (viewportActive()) patchDocumentFromNativeWindow();
    else if (fullSurfaceFallback) {
      documentValue = normalizeText(nativeValueGet());
      lineStarts = buildLineStarts(documentValue);
      syncStoredSelectionFromNative();
    }
    compositionActive = false;
    resetNativeViewportScroll('composition-end');
    if (fullSurfaceFallback) scheduleFallbackResume('composition-fallback-resume', 30);
    else scheduleRecenter('composition-end', 30);
  }, true);

  editor.addEventListener('pointerdown', event => {
    if (!viewportActive() || event?.button !== 0) return;
    cancelPointerSelectionRelease();
    setPointerSelectionActive(true, 'pointerdown');
  }, true);

  editor.addEventListener('pointerup', () => {
    if (!pointerSelectionActive) return;
    schedulePointerSelectionRelease(pendingShiftClick ? 'shift-pointer-release' : 'pointerup-release');
  }, true);

  editor.addEventListener('pointercancel', () => {
    if (!pointerSelectionActive) return;
    schedulePointerSelectionRelease('pointercancel-release');
  }, true);

  editor.addEventListener('mousedown', event => {
    virtualSelectAll = false;
    if (!viewportActive()) return;

    if (event?.button === 0) {
      cancelPointerSelectionRelease();
      setPointerSelectionActive(true, event.shiftKey ? 'shift-mousedown' : 'mousedown');
    }

    if (event?.button === 0 && event.shiftKey) {
      // Keep the bounded viewport and let the native textarea resolve the clicked
      // row/column. The browser's local Shift anchor is intentionally ignored;
      // mouseup combines the native focus with this preserved document anchor.
      pendingShiftClick = {
        anchor: selectionAnchor(documentSelection()),
        windowStart,
        windowEnd,
      };
      nativeSelectionRepresentsDocument = false;
      return;
    }

    pendingShiftClick = null;
    nativeSelectionRepresentsDocument = true;
  }, true);

  editor.addEventListener('select', () => {
    if (enabled && (fullSurfaceFallback || nativeSelectionRepresentsDocument)) syncStoredSelectionFromNative();
  }, true);

  editor.addEventListener('mouseup', () => {
    schedulePointerSelectionRelease(pendingShiftClick ? 'shift-click-release' : 'pointer-release');
  }, true);

  editor.addEventListener('keyup', () => {
    if (enabled && (fullSurfaceFallback || nativeSelectionRepresentsDocument)) syncStoredSelectionFromNative();
  }, true);

  editor.addEventListener('keydown', event => {
    if (!enabled) return;
    const key = String(event.key || '');
    const lowerKey = key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && lowerKey === 'a') {
      virtualSelectAll = true;
      rememberSelection({ start: 0, end: documentValue.length, direction: 'none' });
      enterFullSurfaceFallback({ selection: storedSelection, reason: 'native-select-all' });
      return;
    }

    if (viewportActive() && !nativeSelectionRepresentsDocument) {
      const documentCommandUsesStoredSelection = (event.ctrlKey || event.metaKey)
        && ['c','x','v','z','y'].includes(lowerKey);
      const navigationOrEdit = key.length === 1
        || ['Process','Unidentified','Backspace','Delete','Enter','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(key)
        || documentCommandUsesStoredSelection;
      if (navigationOrEdit && !documentCommandUsesStoredSelection) revealStoredSelectionForKeyboard('keydown-reveal');
    }

    if (fullSurfaceFallback && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Escape'].includes(key)) {
      const selection = documentSelection();
      if (selection.end - selection.start <= LARGE_EDITOR_VIEWPORT_MAX_CHARS) scheduleFallbackResume('navigation-resume', 30);
    }
  }, true);

  editor.addEventListener('scroll', event => {
    if (!viewportActive() || syntheticScrollDispatch || event?.isTrusted === false) return;
    // The outer host owns document scrolling. A trusted scroll event from the
    // hidden native textarea is Chromium's caret auto-reveal and must never become
    // a second, invisible coordinate system.
    if (resetNativeViewportScroll('trusted-native-scroll')) {
      try { event.stopPropagation(); } catch (_) {}
    }
  }, true);

  host.addEventListener('scroll', handleHostScroll, { passive: true });
  window.addEventListener('mouseup', () => {
    if (!pointerSelectionActive) return;
    schedulePointerSelectionRelease(pendingShiftClick ? 'shift-click-window-release' : 'pointer-window-release');
  });
  window.addEventListener('blur', () => {
    if (!pointerSelectionActive) return;
    schedulePointerSelectionRelease('pointer-window-blur');
  });
  window.addEventListener('resize', () => {
    if (viewportActive()) {
      updateSpacerGeometry();
      renderWindowForScroll('resize-window');
    }
  });
  window.addEventListener('ttedit-rendering-changed', () => {
    if (viewportActive()) {
      updateSpacerGeometry();
      renderWindowForScroll('rendering-change');
    }
  });
  window.addEventListener('ttedit-large-text-mode-changed', event => {
    if (event?.detail?.active === true) activateViewport('large-mode-on');
    else deactivateViewport('large-mode-off');
  });
}

export function initLargeEditorViewport({ editorElement } = {}) {
  editor = editorElement || editor;
  if (!editor || editor.dataset.largeViewportInitialized === 'true') return false;
  editor.dataset.largeViewportInitialized = 'true';
  surface = editor.closest('.editor-color-wrap') || editor;
  const parent = surface.parentElement;
  if (!parent) return false;

  host = document.createElement('div');
  host.className = 'large-editor-scroll-host';
  host.setAttribute('aria-label', '편집창 스크롤 영역');
  spacer = document.createElement('div');
  spacer.className = 'large-editor-scroll-spacer';
  host.appendChild(spacer);

  installPropertyCompatibility();
  installEventBridge();
  documentValue = normalizeText(nativeValueGet());
  lineStarts = buildLineStarts(documentValue);
  if (isLargeTextModeActive()) activateViewport('init-large');
  return true;
}

export function isLargeEditorViewportActive() {
  return viewportActive();
}

export function isLargeEditorViewportEnabled() {
  return enabled;
}

export function isLargeEditorPointerSelectionActive() {
  return enabled && pointerSelectionActive;
}

export function getLargeEditorNativeDocumentSelection() {
  if (!editor) return null;
  const localStart = Math.max(0, Number(nativeSelectionStartGet()) || 0);
  const localEnd = Math.max(localStart, Number(nativeSelectionEndGet()) || localStart);
  const direction = nativeSelectionDirectionGet();
  if (!enabled || fullSurfaceFallback) {
    return {
      start: Math.min(documentValue.length, localStart),
      end: Math.min(documentValue.length, localEnd),
      direction,
    };
  }
  if (!viewportActive()) return null;
  return {
    start: Math.max(0, Math.min(documentValue.length, windowStart + Math.min(windowValue.length, localStart))),
    end: Math.max(0, Math.min(documentValue.length, windowStart + Math.min(windowValue.length, localEnd))),
    direction,
  };
}

export function getLargeEditorViewportWindow() {
  return {
    active: viewportActive(),
    enabled,
    fullSurfaceFallback,
    start: windowStart,
    end: windowEnd,
    text: viewportActive() ? windowValue : documentValue,
    startLine: windowStartLine,
    endLine: windowEndLine,
    lineCount: lineStarts.length,
    documentLength: documentValue.length,
    top: windowStartLine * lineHeightPx(),
    reason: lastWindowReason,
  };
}

export function getLargeEditorDocumentValue() {
  return enabled ? documentValue : normalizeText(nativeValueGet());
}
