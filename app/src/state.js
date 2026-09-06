import { BUILTIN_FONT_CSS_FAMILY, FALLBACK_FONT_CSS_FAMILY } from './fontService.js';
let nextDocumentSeq = 1;
let nextUndoSeq = 1;

const DEFAULT_UNDO_HISTORY_LIMIT = 100;
let undoHistoryLimit = DEFAULT_UNDO_HISTORY_LIMIT;

const DEFAULT_RENDERING_SETTINGS = {
  fontSource: 'builtin',
  fontFamily: BUILTIN_FONT_CSS_FAMILY,
  fontPath: '',
  fontFileName: '',
  fontSizePt: 25.0,
  lineHeightPt: 27.0,
  textAlign: 'left',
  tabWidth: 4,
};
let defaultDocumentRendering = normalizeRenderingSettings(DEFAULT_RENDERING_SETTINGS);

function makeDocumentId() { return `doc-${Date.now().toString(36)}-${nextDocumentSeq++}`; }
function makeUndoId() { return `edit-${Date.now().toString(36)}-${nextUndoSeq++}`; }

function fileNameFromPath(path) {
  if (!path) return null;
  return String(path).split(/[\\/]/).filter(Boolean).pop() || String(path);
}

export function setUndoHistoryLimit(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  undoHistoryLimit = Math.max(10, Math.min(200, Number.isFinite(n) ? n : DEFAULT_UNDO_HISTORY_LIMIT));
  for (const doc of appState.documents) trimUndoStack(doc);
}

export function getUndoHistoryLimit() { return undoHistoryLimit; }


function clampNumberValue(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeRenderingSettings(value = {}) {
  const src = value && typeof value === 'object' ? value : {};
  const fontSource = ['builtin', 'builtinFallback', 'custom', 'system'].includes(src.fontSource) ? src.fontSource : DEFAULT_RENDERING_SETTINGS.fontSource;
  const fontFamily = fontSource === 'builtin' ? BUILTIN_FONT_CSS_FAMILY : fontSource === 'builtinFallback' ? FALLBACK_FONT_CSS_FAMILY : (String(src.fontFamily || 'Malgun Gothic').trim() || 'Malgun Gothic');
  const fontSizePt = Math.round(clampNumberValue(src.fontSizePt, 6, 999, DEFAULT_RENDERING_SETTINGS.fontSizePt) * 10) / 10;
  const defaultRatio = DEFAULT_RENDERING_SETTINGS.lineHeightPt / DEFAULT_RENDERING_SETTINGS.fontSizePt;
  const derivedLineHeight = Math.round((fontSizePt * defaultRatio) * 10) / 10;
  const lineHeightPt = Math.round(clampNumberValue(src.lineHeightPt, 6, 2000, derivedLineHeight) * 10) / 10;
  const textAlign = ['left', 'center', 'right'].includes(src.textAlign) ? src.textAlign : DEFAULT_RENDERING_SETTINGS.textAlign;
  const tabWidth = Math.round(clampNumberValue(src.tabWidth, 1, 32, DEFAULT_RENDERING_SETTINGS.tabWidth));
  return {
    fontSource,
    fontFamily,
    fontPath: fontSource === 'custom' ? String(src.fontPath || '').trim() : '',
    fontFileName: fontSource === 'custom' ? String(src.fontFileName || '').trim() : '',
    fontSizePt,
    lineHeightPt,
    textAlign,
    tabWidth,
  };
}

export function getDefaultRenderingSettings() { return { ...defaultDocumentRendering }; }
export function setDefaultDocumentRendering(value = {}) {
  defaultDocumentRendering = normalizeRenderingSettings(value);
  for (const doc of appState.documents) {
    if (doc && doc.renderingExplicit !== true) doc.rendering = normalizeRenderingSettings(defaultDocumentRendering);
  }
}

export function createDocumentState({ id = null, content = '', path = null, name = null, dirty = false, activeView = 'editor', rendering = null, renderingExplicit = null, systemGeneratedName = false } = {}) {
  const hasRendering = rendering !== null && rendering !== undefined;
  const doc = {
    id: id || makeDocumentId(),
    documentText: String(content ?? ''),
    currentFilePath: path || null,
    currentFileName: name || fileNameFromPath(path),
    systemGeneratedName: !!systemGeneratedName && !path,
    dirty: !!dirty,
    undoStack: [],
    redoStack: [],
    pendingRestoreSelection: null,
    activeView: activeView === 'code' ? 'code' : 'editor',
    selection: { code: null, editor: null },
    scroll: { code: { top: 0, left: 0 }, editor: { top: 0, left: 0 } },
    renderingExplicit: renderingExplicit == null ? hasRendering : renderingExplicit === true,
    rendering: normalizeRenderingSettings(hasRendering ? rendering : defaultDocumentRendering),
  };
  return doc;
}

const appState = {
  documents: [createDocumentState()],
  activeDocumentId: null,
  isSyncing: false,
  scrollSyncEnabled: true,
  defaultSaveExtension: 'txt',
};
appState.activeDocumentId = appState.documents[0].id;

function normalizeSelection(sel) {
  if (!sel) return null;
  const start = Math.max(0, Number(sel.start) || 0);
  const end = Math.max(start, Number(sel.end) || start);
  return { start, end };
}

function normalizeScroll(scroll) {
  if (!scroll) return null;
  return { top: Math.max(0, Number(scroll.top) || 0), left: Math.max(0, Number(scroll.left) || 0) };
}

const SELECTION_RESTORE_MODES = new Set(['preserve', 'collapse-start', 'collapse-end']);

function normalizeSelectionRestoreMode(value) {
  const mode = String(value || 'preserve');
  return SELECTION_RESTORE_MODES.has(mode) ? mode : 'preserve';
}

function collapseSelection(sel, mode = 'preserve') {
  const normalized = normalizeSelection(sel);
  if (!normalized || mode === 'preserve') return normalized;
  const pos = mode === 'collapse-end' ? normalized.end : normalized.start;
  return { start: pos, end: pos };
}

function normalizeSelectionForRestore(sel, mode = 'preserve') {
  return mode === 'preserve' ? normalizeSelection(sel) : collapseSelection(sel, mode);
}

function normalizeSnapshot(snapshot = null) {
  if (typeof snapshot === 'string') return { rawCode: snapshot, text: snapshot, activeView: state.activeView };
  const src = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const rawCode = String(src.rawCode ?? src.text ?? state.rawCode);
  return {
    rawCode,
    // text is kept as a compatibility alias while the history boundary is rawCode-first.
    text: rawCode,
    activeView: src.activeView === 'code' ? 'code' : 'editor',
    codeSelection: normalizeSelection(src.codeSelection),
    editorSelection: normalizeSelection(src.editorSelection),
    codeScroll: normalizeScroll(src.codeScroll),
    editorScroll: normalizeScroll(src.editorScroll),
  };
}

function trimUndoStack(doc) {
  if (!doc) return;
  while (doc.undoStack.length > undoHistoryLimit) doc.undoStack.shift();
  while (doc.redoStack.length > undoHistoryLimit) doc.redoStack.shift();
}

function setPendingRestoreFromSnapshot(doc, snap) {
  doc.pendingRestoreSelection = normalizeSnapshot(snap);
}

function makeRawDeltaPatch(beforeRawCode = '', afterRawCode = '') {
  const beforeRaw = String(beforeRawCode ?? '');
  const afterRaw = String(afterRawCode ?? '');
  if (beforeRaw === afterRaw) return null;
  let start = 0;
  const beforeLength = beforeRaw.length;
  const afterLength = afterRaw.length;
  const minLength = Math.min(beforeLength, afterLength);
  while (start < minLength && beforeRaw.charCodeAt(start) === afterRaw.charCodeAt(start)) start += 1;
  let suffix = 0;
  while (
    suffix < beforeLength - start
    && suffix < afterLength - start
    && beforeRaw.charCodeAt(beforeLength - 1 - suffix) === afterRaw.charCodeAt(afterLength - 1 - suffix)
  ) suffix += 1;
  const removedText = beforeRaw.slice(start, beforeLength - suffix);
  const insertedText = afterRaw.slice(start, afterLength - suffix);
  return { start, removedText, insertedText, beforeLength, afterLength };
}

function applyRawDeltaPatch(currentRawCode = '', patch = null, direction = 'forward') {
  if (!patch || typeof patch !== 'object') return null;
  const current = String(currentRawCode ?? '');
  const start = Math.max(0, Number(patch.start) || 0);
  const removedText = String(patch.removedText ?? '');
  const insertedText = String(patch.insertedText ?? '');
  if (direction === 'reverse') {
    if (current.length !== Number(patch.afterLength)) return null;
    if (current.slice(start, start + insertedText.length) !== insertedText) return null;
    return current.slice(0, start) + removedText + current.slice(start + insertedText.length);
  }
  if (current.length !== Number(patch.beforeLength)) return null;
  if (current.slice(start, start + removedText.length) !== removedText) return null;
  return current.slice(0, start) + insertedText + current.slice(start + removedText.length);
}

function makeDeltaPatchForAction(beforeSnap, afterSnap, storageMode = 'full') {
  if (storageMode !== 'delta') return null;
  if (!beforeSnap || !afterSnap) return null;
  if (beforeSnap.rawCode === afterSnap.rawCode) return null;
  const patch = makeRawDeltaPatch(beforeSnap.rawCode, afterSnap.rawCode);
  if (!patch) return null;
  const changedLength = patch.removedText.length + patch.insertedText.length;
  const fullLength = beforeSnap.rawCode.length + afterSnap.rawCode.length;
  if (fullLength < 50000) return null;
  if (changedLength > Math.max(65536, Math.floor(fullLength / 8))) return null;
  return patch;
}

function makeEditAction({ documentId = null, before = null, after = null, actionType = 'edit', activeView = null, mergeKey = null, selectionRestoreMode = 'preserve', storageMode = 'full' } = {}) {
  const doc = getActiveDocument();
  const beforeSnap = normalizeSnapshot(before || { rawCode: doc.documentText, activeView: activeView || doc.activeView });
  const afterSnap = normalizeSnapshot(after || { rawCode: doc.documentText, activeView: activeView || beforeSnap.activeView });
  const restoreMode = normalizeSelectionRestoreMode(selectionRestoreMode);
  const deltaPatch = makeDeltaPatchForAction(beforeSnap, afterSnap, storageMode);
  const useDelta = !!deltaPatch;
  const action = {
    id: makeUndoId(),
    documentId: documentId || doc.id,
    beforeRawCode: beforeSnap.rawCode,
    // beforeText is a compatibility alias for older callers/static diagnostics.
    beforeText: beforeSnap.rawCode,
    actionType: String(actionType || 'edit'),
    selectionRestoreMode: restoreMode,
    activeView: (activeView || afterSnap.activeView || beforeSnap.activeView) === 'code' ? 'code' : 'editor',
    selectionBefore: {
      code: beforeSnap.codeSelection,
      editor: beforeSnap.editorSelection,
    },
    selectionAfter: {
      code: afterSnap.codeSelection,
      editor: afterSnap.editorSelection,
    },
    scrollBefore: {
      code: beforeSnap.codeScroll,
      editor: beforeSnap.editorScroll,
    },
    scrollAfter: {
      code: afterSnap.codeScroll,
      editor: afterSnap.editorScroll,
    },
    timestamp: Date.now(),
    mergeKey: mergeKey || null,
  };
  if (useDelta) {
    action.undoStorage = 'delta';
    action.deltaPatch = deltaPatch;
    action.deltaBeforeLength = deltaPatch.beforeLength;
    action.deltaAfterLength = deltaPatch.afterLength;
    action.deltaChangedLength = deltaPatch.removedText.length + deltaPatch.insertedText.length;
  } else {
    action.afterRawCode = afterSnap.rawCode;
    action.afterText = afterSnap.rawCode;
  }
  return action;
}

function isDeltaAction(action) {
  return action?.undoStorage === 'delta' && action?.deltaPatch;
}

function rawCodeFromAction(action, side = 'before', currentRawCode = null) {
  if (!action) return '';
  if (isDeltaAction(action)) {
    if (side === 'after') {
      const beforeRaw = String(action.beforeRawCode ?? action.beforeText ?? '');
      const applied = applyRawDeltaPatch(beforeRaw, action.deltaPatch, 'forward');
      if (applied !== null) return applied;
      if (currentRawCode !== null && currentRawCode !== undefined) {
        const fromCurrent = applyRawDeltaPatch(currentRawCode, action.deltaPatch, 'forward');
        if (fromCurrent !== null) return fromCurrent;
      }
      return String(action.afterRawCode ?? action.afterText ?? '');
    }
    if (currentRawCode !== null && currentRawCode !== undefined) {
      const reversed = applyRawDeltaPatch(currentRawCode, action.deltaPatch, 'reverse');
      if (reversed !== null) return reversed;
    }
    return String(action.beforeRawCode ?? action.beforeText ?? '');
  }
  if (side === 'after') return String(action.afterRawCode ?? action.afterText ?? '');
  return String(action.beforeRawCode ?? action.beforeText ?? '');
}

function snapshotFromAction(action, side = 'before', rawOverride = null) {
  const isAfter = side === 'after';
  const selection = isAfter ? action.selectionAfter : action.selectionBefore;
  const scroll = isAfter ? action.scrollAfter : action.scrollBefore;
  const rawCode = rawOverride === null || rawOverride === undefined ? rawCodeFromAction(action, side) : String(rawOverride);
  const restoreMode = normalizeSelectionRestoreMode(action?.selectionRestoreMode);
  return {
    rawCode,
    text: rawCode,
    activeView: action.activeView,
    codeSelection: normalizeSelectionForRestore(selection?.code || null, restoreMode),
    editorSelection: normalizeSelectionForRestore(selection?.editor || null, restoreMode),
    codeScroll: scroll?.code || null,
    editorScroll: scroll?.editor || null,
  };
}

function sameRawDeltaPatch(a, b) {
  const pa = a?.deltaPatch || null;
  const pb = b?.deltaPatch || null;
  if (!pa || !pb) return false;
  return Number(pa.start) === Number(pb.start)
    && Number(pa.beforeLength) === Number(pb.beforeLength)
    && Number(pa.afterLength) === Number(pb.afterLength)
    && String(pa.removedText ?? '') === String(pb.removedText ?? '')
    && String(pa.insertedText ?? '') === String(pb.insertedText ?? '');
}

function sameActionRawCode(a, b) {
  if (!a || !b) return false;
  if (isDeltaAction(a) && isDeltaAction(b)) {
    return String(a.beforeRawCode ?? a.beforeText ?? '') === String(b.beforeRawCode ?? b.beforeText ?? '')
      && sameRawDeltaPatch(a, b);
  }
  return rawCodeFromAction(a, 'before') === rawCodeFromAction(b, 'before')
    && rawCodeFromAction(a, 'after') === rawCodeFromAction(b, 'after');
}


export function listDocuments() { return appState.documents.slice(); }
export function getActiveDocumentId() { return appState.activeDocumentId; }
export function getActiveDocument() {
  let doc = appState.documents.find(x => x.id === appState.activeDocumentId);
  if (!doc) {
    doc = appState.documents[0] || createDocumentState();
    if (!appState.documents.length) appState.documents.push(doc);
    appState.activeDocumentId = doc.id;
  }
  return doc;
}

export function setActiveDocumentId(id) {
  if (!appState.documents.some(x => x.id === id)) return false;
  appState.activeDocumentId = id;
  return true;
}

export function createDocument(options = {}) {
  const doc = createDocumentState(options);
  appState.documents.push(doc);
  appState.activeDocumentId = doc.id;
  return doc;
}

export function createOrActivateDocumentFromPath({ path = null, content = '', name = null, dirty = false, rendering = null, renderingExplicit = null } = {}) {
  if (path) {
    const existing = appState.documents.find(x => x.currentFilePath === path);
    if (existing) {
      appState.activeDocumentId = existing.id;
      return { document: existing, created: false };
    }
  }
  return { document: createDocument({ content, path, name, dirty, rendering, renderingExplicit }), created: true };
}

export function replaceActiveDocument({ content = '', path = null, name = null, dirty = false, rendering = null, renderingExplicit = null, systemGeneratedName = false } = {}) {
  const doc = getActiveDocument();
  doc.documentText = String(content ?? '');
  doc.currentFilePath = path || null;
  doc.currentFileName = name || fileNameFromPath(path);
  doc.systemGeneratedName = !!systemGeneratedName && !path;
  doc.dirty = !!dirty;
  doc.undoStack = [];
  doc.redoStack = [];
  doc.pendingRestoreSelection = null;
  doc.activeView = 'editor';
  doc.selection = { code: null, editor: null };
  doc.scroll = { code: { top: 0, left: 0 }, editor: { top: 0, left: 0 } };
  const hasRendering = rendering !== null && rendering !== undefined;
  doc.renderingExplicit = renderingExplicit == null ? hasRendering : renderingExplicit === true;
  doc.rendering = normalizeRenderingSettings(hasRendering ? rendering : defaultDocumentRendering);
  return doc;
}

export function closeDocument(id = appState.activeDocumentId) {
  const idx = appState.documents.findIndex(x => x.id === id);
  if (idx < 0) return getActiveDocument();
  appState.documents.splice(idx, 1);
  if (!appState.documents.length) {
    const doc = createDocumentState();
    appState.documents.push(doc);
    appState.activeDocumentId = doc.id;
    return doc;
  }
  if (appState.activeDocumentId === id) {
    const next = appState.documents[Math.max(0, Math.min(idx, appState.documents.length - 1))];
    appState.activeDocumentId = next.id;
  }
  return getActiveDocument();
}

export function reorderDocument(id, beforeId = null) {
  const from = appState.documents.findIndex(doc => doc.id === id);
  if (from < 0) return false;
  const [doc] = appState.documents.splice(from, 1);
  let to = beforeId ? appState.documents.findIndex(item => item.id === beforeId) : appState.documents.length;
  if (to < 0) to = appState.documents.length;
  appState.documents.splice(to, 0, doc);
  return true;
}

export function getDirtyDocuments() { return appState.documents.filter(x => x.dirty); }
export function getSavedOpenDocumentPaths() { return appState.documents.map(x => x.currentFilePath).filter(Boolean); }

function setPathOnDocument(doc, path) {
  doc.currentFilePath = path || null;
  doc.currentFileName = fileNameFromPath(path);
  doc.systemGeneratedName = false;
}

export const state = {
  get documents() { return appState.documents; },
  get activeDocumentId() { return appState.activeDocumentId; },
  set activeDocumentId(value) { setActiveDocumentId(value); },
  get documentText() { return getActiveDocument().documentText; },
  set documentText(value) { getActiveDocument().documentText = String(value ?? ''); },
  get rawCode() { return getActiveDocument().documentText; },
  set rawCode(value) { getActiveDocument().documentText = String(value ?? ''); },
  get dirty() { return getActiveDocument().dirty; },
  set dirty(value) { getActiveDocument().dirty = !!value; },
  get currentFilePath() { return getActiveDocument().currentFilePath; },
  set currentFilePath(value) { setPathOnDocument(getActiveDocument(), value); },
  get currentFileName() { return getActiveDocument().currentFileName; },
  set currentFileName(value) { const doc = getActiveDocument(); doc.currentFileName = value || null; doc.systemGeneratedName = false; },
  get activeView() { return getActiveDocument().activeView || 'editor'; },
  set activeView(value) { getActiveDocument().activeView = value === 'code' ? 'code' : 'editor'; },
  get undoStack() { return getActiveDocument().undoStack; },
  set undoStack(value) { getActiveDocument().undoStack = Array.isArray(value) ? value : []; },
  get redoStack() { return getActiveDocument().redoStack; },
  set redoStack(value) { getActiveDocument().redoStack = Array.isArray(value) ? value : []; },
  get pendingRestoreSelection() { return getActiveDocument().pendingRestoreSelection; },
  set pendingRestoreSelection(value) { getActiveDocument().pendingRestoreSelection = value; },
  get isSyncing() { return appState.isSyncing; },
  set isSyncing(value) { appState.isSyncing = !!value; },
  get scrollSyncEnabled() { return appState.scrollSyncEnabled; },
  set scrollSyncEnabled(value) { appState.scrollSyncEnabled = !!value; },
  get defaultSaveExtension() { return appState.defaultSaveExtension; },
  set defaultSaveExtension(value) { appState.defaultSaveExtension = String(value || 'txt'); },
  get rendering() { return getActiveDocument().rendering || (getActiveDocument().rendering = normalizeRenderingSettings(defaultDocumentRendering)); },
  set rendering(value) { const doc = getActiveDocument(); doc.rendering = normalizeRenderingSettings(value); doc.renderingExplicit = true; },
};

export function getDocumentText() { return state.documentText; }
export function getRawCode() { return state.rawCode; }
export function setRawCode(value, source = null, options = {}) { return setDocumentText(value, source, options); }
export function getActiveDocumentRendering() { return { ...state.rendering }; }
export function setActiveDocumentRendering(value = {}) {
  const doc = getActiveDocument();
  doc.rendering = normalizeRenderingSettings({ ...state.rendering, ...(value || {}) });
  doc.renderingExplicit = true;
  return getActiveDocumentRendering();
}
export function hasActiveDocumentExplicitRendering() { return getActiveDocument().renderingExplicit === true; }

export function setDocumentText(value, source = null, options = {}) {
  const doc = getActiveDocument();
  doc.documentText = String(value ?? '');
  if (options.dirty !== false) doc.dirty = true;
  if (source) doc.activeView = source;
}

export function setCurrentFilePath(path) { setPathOnDocument(getActiveDocument(), path); }

export function markSaved(path = state.currentFilePath) {
  if (path) setCurrentFilePath(path);
  state.dirty = false;
}

export function markDirty() { state.dirty = true; }

export function resetDocument({ content = '', path = null, dirty = false, rendering = null, renderingExplicit = null } = {}) {
  replaceActiveDocument({ content, path, dirty, rendering, renderingExplicit });
}

export function getDisplayFileName(doc = getActiveDocument()) {
  const name = doc.currentFileName || '저장되지 않음';
  return doc.dirty ? `*${name}` : name;
}

export function recordEditAction({ before = null, after = null, actionType = 'edit', activeView = null, mergeKey = null, merge = false, selectionRestoreMode = 'preserve', storageMode = 'full' } = {}) {
  const doc = getActiveDocument();
  const action = makeEditAction({ documentId: doc.id, before, after, actionType, activeView, mergeKey, selectionRestoreMode, storageMode });
  if (action.beforeRawCode === action.afterRawCode) return false;
  const last = doc.undoStack[doc.undoStack.length - 1];
  if (merge && last && last.documentId === doc.id && last.mergeKey && last.mergeKey === action.mergeKey && last.actionType === action.actionType) {
    if (isDeltaAction(action)) {
      delete last.afterRawCode;
      delete last.afterText;
      last.undoStorage = action.undoStorage;
      last.deltaPatch = action.deltaPatch;
      last.deltaBeforeLength = action.deltaBeforeLength;
      last.deltaAfterLength = action.deltaAfterLength;
      last.deltaChangedLength = action.deltaChangedLength;
    } else {
      last.afterRawCode = action.afterRawCode;
      last.afterText = action.afterRawCode;
      delete last.undoStorage;
      delete last.deltaPatch;
      delete last.deltaBeforeLength;
      delete last.deltaAfterLength;
      delete last.deltaChangedLength;
    }
    last.selectionAfter = action.selectionAfter;
    last.scrollAfter = action.scrollAfter;
    last.selectionRestoreMode = action.selectionRestoreMode;
    last.timestamp = action.timestamp;
  } else if (!sameActionRawCode(last, action)) {
    doc.undoStack.push(action);
  }
  trimUndoStack(doc);
  doc.redoStack = [];
  return true;
}

export function pushUndoSnapshot(snapshot = null) {
  const doc = getActiveDocument();
  const before = normalizeSnapshot(snapshot);
  const after = normalizeSnapshot({ rawCode: doc.documentText, activeView: before.activeView });
  return recordEditAction({ before, after, actionType: 'raw-snapshot', activeView: before.activeView });
}

export function restoreUndo() {
  const doc = getActiveDocument();
  while (doc.undoStack.length) {
    const action = doc.undoStack.pop();
    if (!action || action.documentId !== doc.id) continue;
    doc.redoStack.push(action);
    trimUndoStack(doc);
    const restoredRaw = rawCodeFromAction(action, 'before', doc.documentText);
    doc.documentText = restoredRaw;
    doc.activeView = action.activeView === 'code' ? 'code' : 'editor';
    setPendingRestoreFromSnapshot(doc, snapshotFromAction(action, 'before', restoredRaw));
    doc.dirty = true;
    return true;
  }
  return false;
}

export function restoreRedo() {
  const doc = getActiveDocument();
  while (doc.redoStack.length) {
    const action = doc.redoStack.pop();
    if (!action || action.documentId !== doc.id) continue;
    doc.undoStack.push(action);
    trimUndoStack(doc);
    const restoredRaw = rawCodeFromAction(action, 'after', doc.documentText);
    doc.documentText = restoredRaw;
    doc.activeView = action.activeView === 'code' ? 'code' : 'editor';
    setPendingRestoreFromSnapshot(doc, snapshotFromAction(action, 'after', restoredRaw));
    doc.dirty = true;
    return true;
  }
  return false;
}
