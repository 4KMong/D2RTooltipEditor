import { state, markSaved, setCurrentFilePath, createDocument, createOrActivateDocumentFromPath, closeDocument, getDirtyDocuments, getSavedOpenDocumentPaths, getActiveDocument, reorderDocument, getDefaultRenderingSettings } from "./state.js";
import { setDocumentContent, refreshStatus, activateDocumentInViews, saveActiveDocumentViewState, syncTextAreasFromState, focusActiveDocumentTextArea, applyDocumentTextAction, captureDocumentSnapshot } from "./syncViews.js";
import { setStatusMessage, setErrorMessage } from "./statusBar.js";
import { showInputModal, showModal } from "./modal.js";
import { openFileDialog, readFileAtPath, takePendingOpenFilePaths, saveFileAtPath, saveFileDialog, revealInExplorer, exitApp, isTauriAvailable, fileExists, hideMainWindowToTray } from "./fileApi.js";
import { addRecentDocument, getRecentDocuments, removeRecentDocument, getPreferences, setPreferences, showPreferencesDialog, getOpenDocumentPaths, saveOpenDocumentPaths } from "./preferences.js";
import { normalizeNewlines } from "./textCodec.js";
import { cleanupRawColorCodes, parseRawCode, normalizeInitialDefaultColorToken, rawCodeContainsZeroWidth2060 } from "./rawCodeModel.js";
import { composeTextForSave, splitDisplayMetadata } from "./displayMetadata.js";
import { withNativeDialogGuard } from "./nativeDialogGuard.js";
import { getUiLanguage, translateUiText } from "./language.js";
import { isSystemDefaultNewDocumentPrefix, localizeSystemGeneratedNewDocumentName, localizedDefaultNewDocumentPrefix } from './documentName.js';

let fallbackInput = null;
let recentMenu = null;
let renderRecentCallback = null;
let exitGuardRegistered = false;
let externalOpenRequestsInitialized = false;
let externalOpenChain = Promise.resolve();

function persistOpenDocuments() {
  saveOpenDocumentPaths(getSavedOpenDocumentPaths());
}

function prepareOpenedText(rawContent = '') {
  const split = splitDisplayMetadata(normalizeNewlines(rawContent ?? ''));
  const prefs = getPreferences();
  const hasDisplayMetadata = prefs.saveDisplaySettingsInFile !== false && !!split.metadata;
  return {
    content: prefs.codePaneExplicitDefaultColor === true ? normalizeInitialDefaultColorToken(split.body, true) : split.body,
    rendering: hasDisplayMetadata ? split.metadata : null,
    renderingExplicit: hasDisplayMetadata,
    metadataError: split.parseError,
  };
}

function countRawColorCodeTokens(rawCode = '') {
  return parseRawCode(rawCode).tokens.filter(token => token.type === 'color').length;
}

function cleanupActiveRawCodeBeforeSave() {
  const before = state.rawCode;
  const cleaned = cleanupRawColorCodes(before);
  if (cleaned === before) return { changed: false, removed: 0 };
  const removed = Math.max(0, countRawColorCodeTokens(before) - countRawColorCodeTokens(cleaned));
  const source = state.activeView === 'code' ? 'code' : 'editor';
  const snapshot = captureDocumentSnapshot(source);
  applyDocumentTextAction(cleaned, { source, label: '저장 전 색상코드 정리', snapshot, actionType: 'save-color-cleanup', selectionRestoreMode: 'preserve' });
  return { changed: true, removed };
}

function buildActiveSaveText() {
  const prefs = getPreferences();
  return composeTextForSave(state.rawCode, state.rendering, { includeMetadata: prefs.saveDisplaySettingsInFile !== false, defaults: getDefaultRenderingSettings() });
}

function prepareActiveSaveText() {
  const cleanup = cleanupActiveRawCodeBeforeSave();
  const saveText = buildActiveSaveText();
  return { saveText, cleanup };
}


function parentDirectoryOfPath(path = '') {
  const text = String(path || '');
  const trimmed = text.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx > 0 ? trimmed.slice(0, idx) : '';
}

function closeOpenMenusAfterRecentCommand() {
  try {
    document.querySelectorAll('.menu-group.open, .menu-submenu.open').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.menu-command.keyboard-active, .menu-check.keyboard-active').forEach(el => el.classList.remove('keyboard-active'));
  } catch (_) {}
}

function shouldOpenRecentInNewTab() {
  const active = getActiveDocument();
  return state.documents.length > 1 || !!(active?.currentFilePath || active?.documentText || active?.dirty);
}

async function showSaveContentWarning({ kind, message, preferenceKey }) {
  const body = document.createElement('div');
  body.className = 'save-content-warning';
  const text = document.createElement('div');
  text.className = 'confirm-message';
  text.textContent = message;
  const label = document.createElement('label');
  label.className = 'save-warning-suppress-check';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  const span = document.createElement('span');
  span.textContent = '다음부터 표시 안함';
  label.append(checkbox, span);
  body.append(text, label);
  const result = await showModal({
    title: kind,
    body,
    soundOnOpen: true,
    buttons: [
      { text: '확인', value: 'ok', default: true, shortcutKey: 'y' },
      { text: '취소', value: 'cancel', shortcutKey: 'n' },
    ],
  });
  if (result === 'ok' && checkbox.checked && preferenceKey) setPreferences({ [preferenceKey]: false });
  return result === 'ok';
}

async function confirmActiveSaveContentWarnings() {
  const prefs = getPreferences();
  const raw = String(state.rawCode ?? '');
  if (prefs.showTabSaveWarning !== false && raw.includes('\t')) {
    const ok = await showSaveContentWarning({
      kind: '탭 문자 저장 확인',
      preferenceKey: 'showTabSaveWarning',
      message: '현재 문서에 탭 문자가 삽입되어 있습니다.\n\n탭 문자가 JSON 키값 내부에 저장되면 사용하는 파일 구조에 따라 JSON 파일이 깨질 수 있습니다.\n\n그래도 저장하시겠습니까?',
    });
    if (!ok) return false;
  }
  if (prefs.showZeroWidthSaveWarning !== false && rawCodeContainsZeroWidth2060(raw)) {
    const ok = await showSaveContentWarning({
      kind: '0 너비 문자 저장 확인',
      preferenceKey: 'showZeroWidthSaveWarning',
      message: '현재 문서에 0 너비 문자(U+2060)가 삽입되어 있습니다.\n\nU+2060이 키값 내부에 삽입된 툴팁은 fallback 폰트로 출력될 수 있습니다.\n\n그래도 저장하시겠습니까?',
    });
    if (!ok) return false;
  }
  return true;
}

function activateAndRender(id, message = '문서 탭 전환') {
  const ok = activateDocumentInViews(id, message);
  persistOpenDocuments();
  return ok;
}


function documentTitleForPrompt(doc = getActiveDocument()) {
  const name = localizedDocumentName(doc);
  return name || translateUiText('새 문서');
}

function localizedDocumentName(doc, language = getUiLanguage()) {
  const raw = String(doc?.currentFileName || '');
  return doc?.systemGeneratedName === true
    ? localizeSystemGeneratedNewDocumentName(raw, language)
    : raw;
}

async function askSaveChanges(doc = getActiveDocument()) {
  const body = document.createElement('div');
  body.className = 'confirm-message';
  body.textContent = `"${documentTitleForPrompt(doc)}"에 대한 변경사항을 저장할까요?`;
  return await showModal({
    title: '(문서 저장 확인)',
    body,
    soundOnOpen: true,
    buttons: [
      { text: '예', value: 'save', default: true, shortcutKey: 'y' },
      { text: '아니오', value: 'discard', shortcutKey: 'n' },
      { text: '취소', value: 'cancel', shortcutKey: 'c' },
    ],
  });
}

async function confirmSaveOrDiscardActiveDocument() {
  const doc = getActiveDocument();
  if (!doc.dirty) return 'discard';
  const choice = await askSaveChanges(doc);
  if (choice === 'save') {
    const saved = await saveFile();
    return saved && !state.dirty ? 'save' : 'cancel';
  }
  return choice === 'discard' ? 'discard' : 'cancel';
}

function dirtyDocumentsActiveFirst() {
  const dirtyDocs = getDirtyDocuments();
  const activeId = state.activeDocumentId;
  const active = dirtyDocs.find(doc => doc.id === activeId);
  const rest = dirtyDocs.filter(doc => doc.id !== activeId);
  return active ? [active, ...rest] : rest;
}

async function confirmExitWithUnsavedDocument() {
  const dirtyDocs = dirtyDocumentsActiveFirst();
  if (!dirtyDocs.length) return true;
  const originalId = state.activeDocumentId;
  saveActiveDocumentViewState();
  for (const doc of dirtyDocs.slice()) {
    if (!state.documents.some(item => item.id === doc.id)) continue;
    activateDocumentInViews(doc.id, '저장할 문서 전환');
    const choice = await askSaveChanges(doc);
    if (choice === 'cancel') {
      const fallbackId = state.documents.some(item => item.id === originalId) ? originalId : state.activeDocumentId;
      activateDocumentInViews(fallbackId, '종료 취소');
      syncTextAreasFromState('종료 취소');
      persistOpenDocuments();
      return false;
    }
    if (choice === 'discard') {
      closeDocument(doc.id);
      ensureActiveUntitledDocumentName();
      syncTextAreasFromState('수정내용 폐기');
      persistOpenDocuments();
      continue;
    }
    if (choice === 'save') {
      const saved = await saveFile();
      if (!saved || state.dirty) {
        const fallbackId = state.documents.some(item => item.id === originalId) ? originalId : state.activeDocumentId;
        activateDocumentInViews(fallbackId, '종료 취소');
        syncTextAreasFromState('종료 취소');
        persistOpenDocuments();
        return false;
      }
    }
  }
  persistOpenDocuments();
  return true;
}

function effectiveNewDocumentPrefix(value) {
  const configured = String(value ?? '');
  if (!configured.trim() || isSystemDefaultNewDocumentPrefix(configured)) {
    return localizedDefaultNewDocumentPrefix(getUiLanguage());
  }
  return configured;
}

function sanitizeBaseName(value) {
  const fallback = localizedDefaultNewDocumentPrefix(getUiLanguage());
  return String(value || fallback).replace(/[\\/:*?"<>|]/g, '_').trim() || fallback.trim();
}

function sanitizeNewDocumentPrefix(value) {
  const fallback = localizedDefaultNewDocumentPrefix(getUiLanguage());
  const text = String(value ?? fallback).replace(/[\\/:*?"<>|]/g, '_');
  return text.trim() ? text : fallback;
}

function makeNewDocumentName() {
  const prefs = getPreferences();
  const base = sanitizeNewDocumentPrefix(effectiveNewDocumentPrefix(prefs.newDocumentBaseName));
  const digits = Math.max(1, Math.min(4, Number.parseInt(prefs.newDocumentSequenceDigits, 10) || 2));
  const language = getUiLanguage();
  const names = new Set(state.documents.map(doc => localizedDocumentName(doc, language).replace(/\.txt$/i, '')));
  for (let i = 1; i <= 9999; i++) {
    const name = `${base}${String(i).padStart(digits, '0')}`;
    if (!names.has(name)) return name;
  }
  return `${base}${Date.now().toString(36)}`;
}

function suggestedSaveName(doc = getActiveDocument()) {
  const localizedName = localizedDocumentName(doc);
  const raw = sanitizeBaseName(localizedName || makeNewDocumentName());
  return /\.txt$/i.test(raw) ? raw : `${raw}.txt`;
}

function stripTxtExtension(name) {
  return String(name || '').replace(/\.txt$/i, '');
}

function displayNameFromInput(base) {
  return sanitizeBaseName(stripTxtExtension(base));
}

function setDocumentTabName(doc, name) {
  if (!doc) return false;
  doc.currentFileName = displayNameFromInput(name);
  doc.systemGeneratedName = false;
  return true;
}

function isTxtPath(path) {
  return !path || String(path).toLowerCase().endsWith(".txt");
}

function loadOpenedFile(result, options = {}) {
  if (!result) return;
  if (result.path && !isTxtPath(result.path)) {
    setErrorMessage("지원하지 않는 파일 형식입니다. txt 파일만 열 수 있습니다.");
    return;
  }
  saveActiveDocumentViewState();
  const path = result.path ?? null;
  const providedName = String(result.name || '').trim();
  const prepared = prepareOpenedText(result.content ?? "");
  const content = prepared.content;
  const rendering = prepared.rendering;
  const renderingExplicit = prepared.renderingExplicit;
  const active = getActiveDocument();
  let document = null;
  let created = false;
  const forceNewDocument = options.forceNewDocument === true;
  if (!forceNewDocument && (path || providedName) && state.documents.length === 1 && !active.currentFilePath && !active.documentText && !active.dirty) {
    setDocumentContent(content, { path, dirty: false, source: "file", rendering, renderingExplicit });
    document = getActiveDocument();
    if (!path && providedName) setDocumentTabName(document, providedName);
  } else {
    const res = createOrActivateDocumentFromPath({ path, content, name: !path && providedName ? providedName : null, dirty: false, rendering, renderingExplicit });
    document = res.document;
    created = res.created;
    activateDocumentInViews(document.id, created ? "파일 열기 완료" : "이미 열린 문서로 전환");
  }
  markSaved(path);
  if (path) addRecentDocument(path);
  persistOpenDocuments();
  renderRecentCallback?.();
  refreshStatus(created ? "파일 열기 완료" : "이미 열린 문서");
  if (prepared.metadataError) setStatusMessage('표시 설정 metadata를 읽지 못해 기본 표시 설정으로 열었습니다.', { type: 'warning', timeout: 3000 });
}

function fileNameFromPathForSort(path = '') {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  return parts.pop() || String(path || '');
}

function compareFileNames(a, b) {
  const aName = String(a?.name || fileNameFromPathForSort(a?.path || a) || '');
  const bName = String(b?.name || fileNameFromPathForSort(b?.path || b) || '');
  const byName = aName.localeCompare(bName, 'ko-KR', { numeric: true, sensitivity: 'base' });
  if (byName) return byName;
  return String(a?.path || a || '').localeCompare(String(b?.path || b || ''), 'ko-KR', { numeric: true, sensitivity: 'base' });
}

function uniqueTxtPaths(paths = []) {
  const out = [];
  const seen = new Set();
  for (const raw of paths || []) {
    const path = String(raw || '').trim();
    if (!path || !isTxtPath(path)) continue;
    const key = path.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  out.sort((a, b) => compareFileNames({ path: a }, { path: b }));
  return out;
}

async function openTxtPaths(paths = [], { source = '파일 열기' } = {}) {
  const sourceLabel = translateUiText(source);
  const allPaths = Array.from(paths || []).map(value => String(value || '')).filter(Boolean);
  const txtPaths = uniqueTxtPaths(allPaths);
  const ignored = allPaths.filter(path => !isTxtPath(path)).length;
  if (!txtPaths.length) {
    if (allPaths.length) setErrorMessage(`${sourceLabel}: ${translateUiText('txt 파일이 없습니다.')}`);
    return 0;
  }
  let opened = 0;
  let failed = 0;
  for (const path of txtPaths) {
    try {
      const result = await readFileAtPath(path);
      loadOpenedFile(result);
      opened++;
    } catch (err) {
      failed++;
      console.warn(`${source} 실패`, path, err);
    }
  }
  if (opened > 0) {
    const notes = [];
    if (ignored) notes.push(translateUiText(`비-txt ${ignored}개 제외`));
    if (failed) notes.push(translateUiText(`열기 실패 ${failed}개`));
    const status = getUiLanguage() === 'en'
      ? `${sourceLabel}: opened ${opened} txt file(s)${notes.length ? ` (${notes.join(', ')})` : ''}`
      : `${source}: txt ${opened}개 열기 완료${notes.length ? ` (${notes.join(', ')})` : ''}`;
    setStatusMessage(status);
  } else if (failed) {
    setErrorMessage(`${sourceLabel}: ${translateUiText('txt 파일을 열지 못했습니다.')}`);
  }
  return opened;
}

async function openBrowserDroppedFiles(files = []) {
  const allFiles = Array.from(files || []);
  const txtFiles = allFiles.filter(file => String(file?.name || '').toLowerCase().endsWith('.txt')).sort(compareFileNames);
  const ignored = Math.max(0, allFiles.length - txtFiles.length);
  if (!txtFiles.length) {
    if (allFiles.length) setErrorMessage(`${translateUiText('드래그앤드롭')}: ${translateUiText('txt 파일이 없습니다.')}`);
    return 0;
  }
  let opened = 0;
  let failed = 0;
  for (const file of txtFiles) {
    try {
      const text = await file.text();
      loadOpenedFile({ path: file.path || null, name: file.name || '', content: text });
      opened++;
    } catch (err) {
      failed++;
      console.warn('브라우저 드래그앤드롭 열기 실패', file?.name, err);
    }
  }
  if (opened > 0) {
    const notes = [];
    if (ignored) notes.push(translateUiText(`비-txt ${ignored}개 제외`));
    if (failed) notes.push(translateUiText(`열기 실패 ${failed}개`));
    const sourceLabel = translateUiText('드래그앤드롭');
    const status = getUiLanguage() === 'en'
      ? `${sourceLabel}: opened ${opened} txt file(s)${notes.length ? ` (${notes.join(', ')})` : ''}`
      : `드래그앤드롭: txt ${opened}개 열기 완료${notes.length ? ` (${notes.join(', ')})` : ''}`;
    setStatusMessage(status);
  } else if (failed) {
    setErrorMessage(`${translateUiText('드래그앤드롭')}: ${translateUiText('txt 파일을 열지 못했습니다.')}`);
  }
  return opened;
}

async function drainPendingExternalOpenPaths() {
  if (!isTauriAvailable()) return 0;
  try {
    const paths = await takePendingOpenFilePaths();
    return await openTxtPaths(paths, { source: 'Windows 쉘 열기' });
  } catch (err) {
    console.warn('pending external open failed', err);
    setErrorMessage(`${translateUiText('Windows 쉘 파일 열기 실패:')} ${String(err)}`);
    return 0;
  }
}

function enqueuePendingExternalOpen() {
  externalOpenChain = externalOpenChain.then(() => drainPendingExternalOpenPaths()).catch(err => console.warn('external open queue failed', err));
  return externalOpenChain;
}

async function registerExternalOpenRequestListener() {
  const handler = () => { void enqueuePendingExternalOpen(); };
  try {
    const eventApi = window.__TAURI__?.event;
    if (eventApi?.listen) {
      await eventApi.listen('ttedit-open-file-paths-pending', handler);
      return true;
    }
  } catch (err) {
    console.warn('external open app listener registration failed', err);
  }
  try {
    const current = getCurrentTauriWindowObject();
    if (current?.listen) {
      await current.listen('ttedit-open-file-paths-pending', handler);
      return true;
    }
  } catch (err) {
    console.warn('external open window listener registration failed', err);
  }
  return false;
}

export async function initExternalFileOpenRequests() {
  if (externalOpenRequestsInitialized || !isTauriAvailable()) return;
  externalOpenRequestsInitialized = true;
  // The shell-open event is edge-triggered.  Wait until the listener is truly
  // registered before the initial drain so a request cannot land in-between
  // those two steps and remain queued until some later event.
  await registerExternalOpenRequestListener();
  await enqueuePendingExternalOpen();
}

export function initFileMenu({ fallbackFileInput, recentDocumentsMenu, renderRecent }) {
  fallbackInput = fallbackFileInput;
  recentMenu = recentDocumentsMenu;
  renderRecentCallback = renderRecent;

  fallbackInput.addEventListener("change", async () => {
    const file = fallbackInput.files?.[0];
    fallbackInput.value = "";
    if (!file) return;
    if (!String(file.name || "").toLowerCase().endsWith(".txt")) {
      setErrorMessage("txt 파일만 열 수 있습니다.");
      return;
    }
    const text = await file.text();
    loadOpenedFile({ path: null, content: text });
    setCurrentFilePath(null);
    refreshStatus("브라우저 방식으로 파일 열기 완료");
  });

  initDragDropOpen();
}

export async function newFile() {
  saveActiveDocumentViewState();
  const name = makeNewDocumentName();
  const doc = createDocument({ content: '', path: null, name, dirty: false, systemGeneratedName: true });
  activateDocumentInViews(doc.id, `${name} 문서`);
  state.defaultSaveExtension = "txt";
  persistOpenDocuments();
  refreshStatus("새 문서");
}

export function ensureActiveUntitledDocumentName(message = null) {
  const doc = getActiveDocument();
  if (!doc.currentFilePath && !doc.currentFileName && !doc.documentText && !doc.dirty) {
    doc.currentFileName = makeNewDocumentName();
    doc.systemGeneratedName = true;
    syncTextAreasFromState(message || '새 문서 준비');
  }
  return doc;
}

export async function activateAdjacentDocumentTab(delta = 1) {
  const docs = state.documents;
  if (!Array.isArray(docs) || docs.length <= 1) return false;
  saveActiveDocumentViewState();
  const idx = Math.max(0, docs.findIndex(doc => doc.id === state.activeDocumentId));
  const nextIdx = (idx + delta + docs.length) % docs.length;
  const next = docs[nextIdx];
  if (!next) return false;
  activateDocumentInViews(next.id, '문서 탭 전환');
  focusActiveDocumentTextArea();
  return true;
}

export async function openFile() {
  if (isTauriAvailable()) {
    const result = await withNativeDialogGuard(() => openFileDialog(getPreferences().defaultSaveDirectory));
    if (result) loadOpenedFile(result);
    else setStatusMessage("열기 취소");
    return;
  }
  fallbackInput.click();
}

export async function openRecent(path) {
  if (!isTxtPath(path)) {
    setErrorMessage("최근 문서 항목이 txt 파일이 아닙니다.");
    return;
  }
  try {
    const result = await readFileAtPath(path);
    loadOpenedFile(result, { forceNewDocument: shouldOpenRecentInNewTab() });
  } catch (err) {
    setErrorMessage("최근 문서 열기 실패: " + String(err));
  }
}

export async function saveFile() {
  if (!await confirmActiveSaveContentWarnings()) { setStatusMessage('저장 취소'); return false; }
  const { saveText, cleanup } = prepareActiveSaveText();
  if (state.currentFilePath && isTauriAvailable()) {
    try {
      if (!(await fileExists(state.currentFilePath))) {
        setStatusMessage('원본 파일이 없어 다른 이름으로 저장을 엽니다.');
        return await saveFileAs({ skipWarnings: true });
      }
      const path = await saveFileAtPath(state.currentFilePath, saveText);
      markSaved(path);
      addRecentDocument(path);
      renderRecentCallback?.();
      refreshStatus(cleanup.changed ? `저장 완료 (색상코드 ${cleanup.removed}개 정리)` : "저장 완료");
      return true;
    } catch (err) {
      setErrorMessage("저장 실패: " + String(err));
      return false;
    }
  }
  return await saveFileAs({ skipWarnings: true });
}

export async function saveFileAs({ skipWarnings = false } = {}) {
  if (!skipWarnings && !await confirmActiveSaveContentWarnings()) { setStatusMessage('저장 취소'); return false; }
  const { saveText, cleanup } = prepareActiveSaveText();
  if (isTauriAvailable()) {
    try {
      const path = await withNativeDialogGuard(() => saveFileDialog(saveText, state.currentFilePath, getPreferences().defaultSaveDirectory, suggestedSaveName()));
      if (path) {
        markSaved(path);
        addRecentDocument(path);
        renderRecentCallback?.();
        refreshStatus(cleanup.changed ? `다른이름으로 저장 완료 (색상코드 ${cleanup.removed}개 정리)` : "다른이름으로 저장 완료");
        return true;
      }
      setStatusMessage("저장 취소");
      return false;
    } catch (err) {
      setErrorMessage("저장 실패: " + String(err));
      return false;
    }
  }
  const blob = new Blob([saveText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedSaveName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  markSaved(null);
  refreshStatus(cleanup.changed ? `다운로드 방식으로 저장 (색상코드 ${cleanup.removed}개 정리)` : "다운로드 방식으로 저장");
  return true;
}

export async function revealCurrentFile() {
  if (!state.currentFilePath) { setErrorMessage("현재 파일 경로 없음"); return; }
  await revealInExplorer(state.currentFilePath);
  setStatusMessage("탐색기에서 현재 파일 표시");
}

export async function closeCurrentFile() {
  const doc = getActiveDocument();
  if (!doc.currentFilePath && !doc.documentText && state.documents.length <= 1) { setStatusMessage("닫을 현재 문서 없음"); return; }
  if (doc.dirty) {
    const choice = await confirmSaveOrDiscardActiveDocument();
    if (choice === 'cancel') return;
  }
  closeDocument(doc.id);
  ensureActiveUntitledDocumentName();
  syncTextAreasFromState("현재 문서 닫기");
  persistOpenDocuments();
  refreshStatus("현재 문서 닫기");
}

async function chooseExitMode() {
  const body = document.createElement('div');
  body.className = 'confirm-message';
  body.textContent = '프로그램을 종료하시겠습니까?';
  return await showModal({
    title: '프로그램 종료',
    body,
    soundOnOpen: true,
    buttons: [
      { text: '종료', value: 'exit', shortcutKey: 'y' },
      { text: '취소', value: 'cancel', default: true, shortcutKey: 'c' },
      { text: '트레이로 최소화', value: 'tray', shortcutKey: 't' },
    ],
  });
}

export async function minimizeApplicationToTray() {
  if (!isTauriAvailable()) {
    setErrorMessage('시스템 트레이는 데스크톱 앱에서만 사용할 수 있습니다.');
    return false;
  }
  try {
    persistOpenDocuments();
    await hideMainWindowToTray();
    setStatusMessage('시스템 트레이로 최소화');
    return true;
  } catch (err) {
    setErrorMessage('시스템 트레이 최소화 실패: ' + String(err));
    return false;
  }
}

export async function exitApplication({ showModePrompt = true } = {}) {
  if (showModePrompt) {
    const mode = await chooseExitMode();
    if (mode === 'tray') {
      await minimizeApplicationToTray();
      return;
    }
    if (mode !== 'exit') {
      setStatusMessage('종료 취소');
      return;
    }
  }
  if (!(await confirmExitWithUnsavedDocument())) return;
  persistOpenDocuments();
  if (isTauriAvailable()) await exitApp();
  else window.close();
}



function getCurrentTauriWindowObject() {
  const api = window.__TAURI__ || {};
  return api.window?.getCurrentWindow?.()
    || api.webviewWindow?.getCurrentWebviewWindow?.()
    || api.webviewWindow?.getCurrent?.()
    || null;
}

let windowCloseInProgress = false;
async function handleWindowCloseRequest() {
  if (windowCloseInProgress) return;
  windowCloseInProgress = true;
  try {
    if (getPreferences().systemTrayEnabled !== false) {
      await minimizeApplicationToTray();
      return;
    }
    if (await confirmExitWithUnsavedDocument()) {
      persistOpenDocuments();
      await exitApp();
    }
  } finally {
    windowCloseInProgress = false;
  }
}

function registerTauriEventListener(name, handler) {
  try {
    const eventApi = window.__TAURI__?.event;
    if (eventApi?.listen) {
      void eventApi.listen(name, handler).catch?.(err => console.warn(`${name} listener registration failed`, err));
      return true;
    }
  } catch (err) {
    console.warn(`${name} app listener registration failed`, err);
  }
  try {
    const current = getCurrentTauriWindowObject();
    if (current?.listen) {
      void current.listen(name, handler);
      return true;
    }
  } catch (err) {
    console.warn(`${name} window listener registration failed`, err);
  }
  return false;
}

function registerTrayLifecycleListeners() {
  registerTauriEventListener('ttedit-tray-open-preferences', () => { void showPreferences(); });
  registerTauriEventListener('ttedit-tray-exit-requested', () => { void exitApplication({ showModePrompt: false }); });
}

function registerCustomCloseEventListener() {
  const registered = registerTauriEventListener('ttedit-window-close-requested', () => { void handleWindowCloseRequest(); });
  window.addEventListener('ttedit-window-close-requested', () => { void handleWindowCloseRequest(); });
  return registered;
}

export function initExitGuard() {
  if (exitGuardRegistered) return;
  exitGuardRegistered = true;
  const customRegistered = registerCustomCloseEventListener();
  registerTrayLifecycleListeners();
  if (!customRegistered) window.setTimeout(registerCustomCloseEventListener, 150);
  try {
    const current = getCurrentTauriWindowObject();
    current?.onCloseRequested?.((event) => {
      event.preventDefault();
      void handleWindowCloseRequest();
    });
  } catch (err) {
    console.warn('exit guard registration failed', err);
  }
}


export async function renameDocumentTab(id) {
  const target = state.documents.find(doc => doc.id === id);
  if (!target) return false;
  if (target.currentFilePath) {
    saveActiveDocumentViewState();
    activateDocumentInViews(id, '문서명 변경');
    return await saveFileAs();
  }
  const current = stripTxtExtension(localizedDocumentName(target) || makeNewDocumentName());
  const input = await showInputModal({
    title: '(문서명 변경)',
    label: '문서명',
    defaultValue: current,
    placeholder: '문서명',
    maxLength: 90,
  });
  if (input == null) { setStatusMessage('문서명 변경 취소'); return false; }
  const name = sanitizeBaseName(stripTxtExtension(input));
  setDocumentTabName(target, name);
  refreshStatus('문서명 변경');
  persistOpenDocuments();
  return true;
}

export async function duplicateDocumentTab(id) {
  const target = state.documents.find(doc => doc.id === id);
  if (!target) return false;
  saveActiveDocumentViewState();
  const base = stripTxtExtension(localizedDocumentName(target) || documentTitleForPrompt(target));
  const defaultName = displayNameFromInput(translateUiText(`${base} - 복제`));
  const input = await showInputModal({
    title: '(복제할 문서명)',
    label: '복제할 문서명',
    defaultValue: defaultName,
    placeholder: '복제할 문서명',
    maxLength: 90,
  });
  if (input == null) { setStatusMessage('문서 복제 취소'); return false; }
  const name = displayNameFromInput(input);
  createDocument({ content: target.documentText, name, path: null, dirty: true, activeView: target.activeView || 'editor', rendering: target.rendering, renderingExplicit: target.renderingExplicit === true });
  syncTextAreasFromState('문서 복제');
  persistOpenDocuments();
  focusActiveDocumentTextArea();
  return true;
}

export function reorderDocumentTabs(id, beforeId = null) {
  saveActiveDocumentViewState();
  const ok = reorderDocument(id, beforeId);
  if (!ok) return false;
  persistOpenDocuments();
  syncTextAreasFromState('문서 탭 순서 변경');
  refreshStatus('문서 탭 순서 변경');
  return true;
}

export async function activateDocumentTab(id) {
  saveActiveDocumentViewState();
  activateAndRender(id, '문서 탭 전환');
}

export async function closeDocumentTab(id) {
  const target = state.documents.find(doc => doc.id === id);
  if (!target) return;
  const wasActive = state.activeDocumentId === id;
  if (target.dirty) {
    const currentId = state.activeDocumentId;
    if (!wasActive) activateDocumentInViews(id, '닫을 문서 확인');
    const choice = await confirmSaveOrDiscardActiveDocument();
    if (choice === 'cancel') {
      if (!wasActive) activateDocumentInViews(currentId, '문서 탭 전환 취소');
      return;
    }
  }
  closeDocument(id);
  ensureActiveUntitledDocumentName();
  syncTextAreasFromState('문서 탭 닫기');
  persistOpenDocuments();
  refreshStatus('문서 탭 닫기');
}

export async function restoreOpenDocumentSession() {
  if (getPreferences().restoreOpenDocuments === false) {
    refreshStatus(null);
    return;
  }
  const paths = getOpenDocumentPaths().filter(isTxtPath);
  let restored = 0;
  for (const path of paths) {
    try {
      const result = await readFileAtPath(path);
      const active = getActiveDocument();
      if (state.documents.length === 1 && !active.currentFilePath && !active.documentText && !active.dirty) {
        const prepared = prepareOpenedText(result.content ?? '');
        setDocumentContent(prepared.content, { path: result.path, dirty: false, source: 'session', rendering: prepared.rendering, renderingExplicit: prepared.renderingExplicit });
        markSaved(result.path);
        restored++;
      } else {
        const prepared = prepareOpenedText(result.content ?? '');
        const { created } = createOrActivateDocumentFromPath({ path: result.path, content: prepared.content, dirty: false, rendering: prepared.rendering, renderingExplicit: prepared.renderingExplicit });
        if (created) restored++;
      }
      addRecentDocument(result.path);
    } catch (err) {
      console.warn('session restore failed', path, err);
    }
  }
  if (restored > 0) {
    const first = state.documents.find(doc => doc.currentFilePath === paths[0]) || state.documents[0];
    activateDocumentInViews(first.id, `저장된 문서 ${restored}개 복원`);
    persistOpenDocuments();
  }
  renderRecentCallback?.();
  refreshStatus(restored > 0 ? `저장된 문서 ${restored}개 복원` : null);
}

export function renderRecentDocuments() {
  if (!recentMenu) return;
  const prefs = getPreferences();
  const limit = Math.max(0, Number.parseInt(prefs.recentLimit, 10) || 0);
  const items = limit > 0 ? getRecentDocuments().filter(x => isTxtPath(x.path)).slice(0, limit) : [];
  recentMenu.innerHTML = "";
  const recentBlocks = document.querySelectorAll(".recent-only");
  recentBlocks.forEach(el => el.classList.toggle("hidden", items.length === 0));
  if (!items.length) return;
  const head = document.createElement("div");
  head.className = "menu-command menu-heading";
  head.innerHTML = "<span>최근 문서 목록</span>";
  recentMenu.appendChild(head);
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "recent-item-row";
    const folderPath = parentDirectoryOfPath(item.path);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.tabIndex = -1;
    btn.className = "menu-command recent-open-button";
    btn.title = item.path;
    btn.innerHTML = `<span class="recent-item-content"><strong class="recent-item-name">${escapeHtml(item.name)}</strong><span class="recent-item-path">${escapeHtml(folderPath || item.path)}</span></span>`;
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeOpenMenusAfterRecentCommand();
      await openRecent(item.path);
    });
    const folder = document.createElement("button");
    folder.type = "button";
    folder.tabIndex = -1;
    folder.className = "recent-location-button";
    folder.title = "파일 위치 열기";
    folder.setAttribute('aria-label', '파일 위치 열기');
    folder.innerHTML = '<svg class="recent-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M1.75 4.25h4.1l1.35 1.5h7.05v6.5a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M1.75 6.25h12.5"/></svg>';
    folder.addEventListener("mousedown", event => event.preventDefault());
    folder.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await revealInExplorer(folderPath || item.path);
        setStatusMessage("최근 문서 위치 열기");
      } catch (err) {
        setErrorMessage("최근 문서 위치 열기 실패: " + String(err));
      }
    });
    const del = document.createElement("button");
    del.type = "button";
    del.tabIndex = -1;
    del.className = "recent-delete-button";
    del.title = "최근 문서 목록에서 삭제";
    del.setAttribute('aria-label', '최근 문서 목록에서 삭제');
    del.innerHTML = '<svg class="recent-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    del.addEventListener("mousedown", event => event.preventDefault());
    del.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeRecentDocument(item.path);
      renderRecentDocuments();
      setStatusMessage("최근 문서 항목 삭제");
    });
    row.append(btn, folder, del);
    recentMenu.appendChild(row);
  }
}

export async function showPreferences() {
  await showPreferencesDialog(renderRecentDocuments);
  renderRecentDocuments();
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>\"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function initDragDropOpen() {
  document.addEventListener("dragover", (event) => {
    event.preventDefault();
    document.body.classList.add("drop-active");
  });
  document.addEventListener("dragleave", (event) => {
    if (event.target === document.body || event.clientX <= 0 || event.clientY <= 0) document.body.classList.remove("drop-active");
  });
  document.addEventListener("drop", async (event) => {
    event.preventDefault();
    document.body.classList.remove("drop-active");
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    await openBrowserDroppedFiles(files);
  });

  const tauriWindow = window.__TAURI__?.window;
  try {
    const current = tauriWindow?.getCurrentWindow?.();
    current?.onDragDropEvent?.(async (event) => {
      const payload = event.payload || {};
      const type = payload.type || event.type;
      const paths = payload.paths || payload?.data?.paths || [];
      if (type !== "drop" || !paths.length) return;
      await openTxtPaths(paths, { source: '드래그앤드롭' });
    });
  } catch (_) {}
}
