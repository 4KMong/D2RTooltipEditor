import { showAlertModal, showConfirmModal, showModal } from './modal.js';
import { DEFAULT_NEW_DOCUMENT_PREFIX_KO, isSystemDefaultNewDocumentPrefix, localizedDefaultNewDocumentPrefix } from './documentName.js';
import { setStatusMessage, setErrorMessage } from './statusBar.js';
import { sanitizeDigits, attachFilteredInputHint, showInputHint, hideInputHint } from './inputFilter.js';
import { isTauriAvailable, readSettingsJson, writeSettingsJson, exportSettingsJsonDialog, importSettingsJsonDialog, getDefaultSaveDirectory, selectDefaultSaveDirectoryDialog, selectFontFileDialog, getUserFontDirectory, cacheCustomFont, cleanupUserDataAndExit } from './fileApi.js';
import { withNativeDialogGuard } from './nativeDialogGuard.js';
import { setFloatingInactiveOpacity } from './floatingWindow.js';
import { setUndoHistoryLimit, normalizeRenderingSettings, setDefaultDocumentRendering } from './state.js';
import { BUILTIN_FONT_CSS_FAMILY, BUILTIN_FONT_DISPLAY_NAME, BUILTIN_FALLBACK_FONT_SOURCE, FALLBACK_FONT_CSS_FAMILY, FALLBACK_FONT_FILE_NAME, FALLBACK_FONT_DISPLAY_NAME, buildFontEntries, getFontDisplayName as serviceDisplayFontLabel, favoriteSetFromPreferences, getFontId, getFontCssFamily, getFontSource, fontCssFamilyForUse, makeFontEntry } from './fontService.js';
import { setColorInputPolicy, DEFAULT_COLOR_INPUT_POLICY } from './colorInputPolicy.js';
import { DEFAULT_JSON_KEY_EXTRACT_LANGUAGE, jsonKeyExtractLanguageOptionsHtml, normalizeJsonKeyExtractLanguage } from './jsonKeyExtract.js';
import { defaultColorLinks, normalizeColorLinks, normalizeColorKey, normalizeColorMemo, normalizeFnShortcut, fnShortcutNumber, colorShortcutDisplay } from './colorPalette.js';
import { setPreserveExplicitDefaultColorTokens } from './rawCodeModel.js';

const LEGACY_PREF_KEY = 'TooltipEditor.preferences.v1';
const LEGACY_RECENT_KEY = 'TooltipEditor.recentDocuments.v1';
const LEGACY_SEARCH_HISTORY_KEY = 'TooltipEditor.searchHistory.v1';
const FALLBACK_SETTINGS_KEY = 'TooltipEditor.tteditSettingsJson.v1';
const SETTINGS_VERSION = 3;
const CURRENT_LAYOUT_LABEL_STANDARD = 'left-editor-label-2026-06-17';
const DEFAULT_PREFS = { uiLanguage: 'ko', recentLimit: 10, searchHistoryLimit: 10, inactiveFloatingOpacity: 0.40, undoHistoryLimit: 100, toolbarFontSizePt: 10, colorPreviewSizePx: 24, toolbarRowHeightPx: 42, lineNumberFontSizePx: 12, lineNumberGutterWidthPx: 46, newInputDefaultColor: false, zeroWidthFallbackEnabled: true, codePaneExplicitDefaultColor: false, editorCopyIncludeColorCodes: true, editorCopyUseLineBreakLiterals: false, editorCopyUnicodeMode: 'escape', jsonKeyExtractLanguage: DEFAULT_JSON_KEY_EXTRACT_LANGUAGE, colorLinks: defaultColorLinks(), colorShortcutIgnoreShift: true, zeroWidthFallbackFontFamily: DEFAULT_COLOR_INPUT_POLICY.zeroWidthFallbackFontFamily, zeroWidthFallbackFontSource: BUILTIN_FALLBACK_FONT_SOURCE, zeroWidthFallbackFontPath: '', zeroWidthFallbackFontFileName: FALLBACK_FONT_FILE_NAME, zeroWidthFallbackFontSelectionMode: 'system', zeroWidthFallbackFontSizePt: DEFAULT_COLOR_INPUT_POLICY.zeroWidthFallbackFontSizePt, zeroWidthFallbackLineHeightPt: DEFAULT_COLOR_INPUT_POLICY.zeroWidthFallbackLineHeightPt, startMaximized: true, systemTrayEnabled: true, windowsShellTxtContextMenu: true, themeMode: 'dark', defaultLayoutMode: 'right-editor', layoutMode: 'right-editor', defaultSaveDirectory: '', restoreOpenDocuments: true, saveDisplaySettingsInFile: true, showTabSaveWarning: true, showZeroWidthSaveWarning: true, newDocumentBaseName: DEFAULT_NEW_DOCUMENT_PREFIX_KO, newDocumentSequenceDigits: 2, renderingFavoriteFonts: [], customFontSelectionMode: 'path', editorThemeColors: { dayEditorBg: '#44444F', dayCodeBg: '#4D4D4D', dayText: '#FFFFFF', dayCaret: '#FFFFFF', dayMarker: '#2BBE5C', dayFocus: '#00FFEE', darkEditorBg: '#07080A', darkCodeBg: '#0F1116', darkText: '#FFFFFF', darkCaret: '#FFFFFF', darkMarker: '#FFD166', darkFocus: '#5B8DFF' }, defaultRendering: { fontSource: 'builtin', fontFamily: BUILTIN_FONT_CSS_FAMILY, fontPath: '', fontFileName: '', fontSizePt: 25, lineHeightPt: 27, textAlign: 'left', tabWidth: 4 }, leftPanePercent: 30, verticalCodePercent: 20, bottomCodePercent: 20, layoutLabelStandard: CURRENT_LAYOUT_LABEL_STANDARD };

let settings = makeDefaultSettings();
let loaded = false;
let prefWindow = null;

let prefInstantTooltipEl = null;

function hidePrefInstantTooltip() {
  if (prefInstantTooltipEl) {
    prefInstantTooltipEl.remove();
    prefInstantTooltipEl = null;
  }
}

function showPrefInstantTooltip(anchor) {
  const text = String(anchor?.dataset?.tip || '').trim();
  if (!text) return;
  hidePrefInstantTooltip();
  prefInstantTooltipEl = document.createElement('div');
  prefInstantTooltipEl.className = 'pref-instant-tooltip';
  prefInstantTooltipEl.textContent = text;
  document.body.appendChild(prefInstantTooltipEl);
  const r = anchor.getBoundingClientRect();
  const gap = 6;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - prefInstantTooltipEl.offsetWidth - 8));
  let top = r.bottom + gap;
  if (top + prefInstantTooltipEl.offsetHeight > window.innerHeight - 8) {
    top = r.top - prefInstantTooltipEl.offsetHeight - gap;
  }
  if (top < 8) top = 8;
  prefInstantTooltipEl.style.left = `${left}px`;
  prefInstantTooltipEl.style.top = `${top}px`;
}

function bindPrefInstantTooltips(root) {
  const panel = root?.querySelector?.('.pref-color-link-panel');
  if (!panel) return;
  const findTipAnchor = target => target?.closest?.('[data-tip]');
  panel.addEventListener('mouseover', event => {
    const anchor = findTipAnchor(event.target);
    if (anchor && panel.contains(anchor)) showPrefInstantTooltip(anchor);
  });
  panel.addEventListener('mouseout', event => {
    const anchor = findTipAnchor(event.target);
    if (!anchor) return;
    const next = event.relatedTarget;
    if (next && anchor.contains(next)) return;
    hidePrefInstantTooltip();
  });
  panel.addEventListener('focusin', event => {
    const anchor = findTipAnchor(event.target);
    if (anchor && panel.contains(anchor)) showPrefInstantTooltip(anchor);
  });
  panel.addEventListener('focusout', hidePrefInstantTooltip);
  panel.addEventListener('scroll', hidePrefInstantTooltip, true);
}

function makeDefaultSettings() {
  return {
    version: SETTINGS_VERSION,
    preferences: { ...DEFAULT_PREFS },
    recentDocuments: [],
    searchHistory: [],
    lineHistory: [],
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeOpacity(value) {
  return Math.round(clampNumber(value, 0.1, 1, DEFAULT_PREFS.inactiveFloatingOpacity) * 100) / 100;
}

function normalizeLayoutMode(value) { return ['split', 'right-editor', 'bottom-code', 'vertical', 'editor-only', 'code-only'].includes(value) ? value : DEFAULT_PREFS.defaultLayoutMode; }
function normalizePercent(value, min, max, fallback) { return Math.round(clampNumber(Number(value), min, max, fallback) * 10) / 10; }

function normalizeLimit(value, fallback = 10) {
  return Math.round(clampNumber(Number.parseInt(sanitizeDigits(String(value ?? '')), 10), 0, 10, fallback));
}

function normalizeRecentLimit(value) { return normalizeLimit(value, DEFAULT_PREFS.recentLimit); }
function normalizeSearchHistoryLimit(value) { return normalizeLimit(value, DEFAULT_PREFS.searchHistoryLimit); }
function normalizeUndoHistoryLimit(value) { return Math.round(clampNumber(Number.parseInt(sanitizeDigits(String(value ?? '')), 10), 10, 200, DEFAULT_PREFS.undoHistoryLimit)); }

function normalizePathText(value, fallback = '') { return String(value ?? fallback ?? '').trim(); }
function normalizeNewDocumentBaseName(value) {
  const text = String(value ?? DEFAULT_PREFS.newDocumentBaseName).replace(/[\\/:*?"<>|]/g, '_');
  return text.trim() ? text : DEFAULT_PREFS.newDocumentBaseName;
}

function localizedDefaultNewDocumentBaseName() {
  return localizedDefaultNewDocumentPrefix(normalizeUiLanguage(getPreferences().uiLanguage));
}

function displayNewDocumentBaseName(value) {
  const normalized = normalizeNewDocumentBaseName(value);
  return isSystemDefaultNewDocumentPrefix(normalized)
    ? localizedDefaultNewDocumentBaseName()
    : normalized;
}

function normalizeSequenceDigits(value) { return Math.round(clampNumber(Number.parseInt(sanitizeDigits(String(value ?? '')), 10), 1, 4, DEFAULT_PREFS.newDocumentSequenceDigits)); }

function normalizeUiLanguage(value) { return value === 'en' ? 'en' : 'ko'; }
function normalizeThemeMode(value) { return value === 'day' ? 'day' : 'dark'; }
function normalizeEditorCopyUnicodeMode(value) { return ['escape', 'glyph', 'omit'].includes(value) ? value : DEFAULT_PREFS.editorCopyUnicodeMode; }
function normalizeHexColor(value, fallback = '#000000') {
  const raw = String(value ?? '').trim().replace(/^#/, '').replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
  return raw.length === 6 ? `#${raw.toUpperCase()}` : fallback;
}
function normalizeEditorThemeColors(value = {}) {
  const base = DEFAULT_PREFS.editorThemeColors;
  const src = value && typeof value === 'object' ? value : {};
  return {
    dayEditorBg: normalizeHexColor(src.dayEditorBg, base.dayEditorBg),
    dayCodeBg: normalizeHexColor(src.dayCodeBg, base.dayCodeBg),
    dayText: normalizeHexColor(src.dayText, base.dayText),
    dayCaret: normalizeHexColor(src.dayCaret, base.dayCaret),
    dayMarker: normalizeHexColor(src.dayMarker, base.dayMarker),
    dayFocus: normalizeHexColor(src.dayFocus, base.dayFocus),
    darkEditorBg: normalizeHexColor(src.darkEditorBg, base.darkEditorBg),
    darkCodeBg: normalizeHexColor(src.darkCodeBg, base.darkCodeBg),
    darkText: normalizeHexColor(src.darkText, base.darkText),
    darkCaret: normalizeHexColor(src.darkCaret, base.darkCaret),
    darkMarker: normalizeHexColor(src.darkMarker, base.darkMarker),
    darkFocus: normalizeHexColor(src.darkFocus, base.darkFocus),
  };
}
function normalizeToolbarFontSizePt(value) {
  const n = Number.parseInt(sanitizeDigits(String(value ?? '')), 10);
  return Math.round(clampNumber(Number.isFinite(n) ? n : DEFAULT_PREFS.toolbarFontSizePt, 8, 18, DEFAULT_PREFS.toolbarFontSizePt));
}
function colorPreviewEmToPx(value) {
  const raw = String(value ?? '').replace(/[^0-9.]/g, '');
  const normalized = raw.replace(/(\..*)\./g, '$1');
  const n = Number.parseFloat(normalized);
  return Math.round(clampNumber(Number.isFinite(n) ? n * 16 : DEFAULT_PREFS.colorPreviewSizePx, 13, 32, DEFAULT_PREFS.colorPreviewSizePx));
}
function normalizeColorPreviewSizePx(value) {
  const n = Number.parseInt(sanitizeDigits(String(value ?? '')), 10);
  return Math.round(clampNumber(Number.isFinite(n) ? n : DEFAULT_PREFS.colorPreviewSizePx, 13, 32, DEFAULT_PREFS.colorPreviewSizePx));
}
function colorPreviewSizeText(value) {
  return String(normalizeColorPreviewSizePx(value));
}
function normalizeToolbarRowHeightPx(value) {
  const n = Number.parseInt(sanitizeDigits(String(value ?? '')), 10);
  return Math.round(clampNumber(Number.isFinite(n) ? n : DEFAULT_PREFS.toolbarRowHeightPx, 32, 72, DEFAULT_PREFS.toolbarRowHeightPx));
}
function normalizeLineNumberFontSizePx(value) {
  const n = Number.parseInt(sanitizeDigits(String(value ?? '')), 10);
  return Math.round(clampNumber(Number.isFinite(n) ? n : DEFAULT_PREFS.lineNumberFontSizePx, 8, 32, DEFAULT_PREFS.lineNumberFontSizePx));
}
function normalizeLineNumberGutterWidthPx(value) {
  const n = Number.parseInt(sanitizeDigits(String(value ?? '')), 10);
  return Math.round(clampNumber(Number.isFinite(n) ? n : DEFAULT_PREFS.lineNumberGutterWidthPx, 32, 120, DEFAULT_PREFS.lineNumberGutterWidthPx));
}
function applyEditorThemeColorsToDom(colors = getPreferences().editorThemeColors) {
  const c = normalizeEditorThemeColors(colors);
  const root = document.documentElement;
  root.style.setProperty('--day-editor-bg', c.dayEditorBg);
  root.style.setProperty('--day-code-bg', c.dayCodeBg);
  root.style.setProperty('--day-editor-text', c.dayText);
  root.style.setProperty('--day-editor-caret', c.dayCaret);
  root.style.setProperty('--day-find-marker-bg', c.dayMarker);
  root.style.setProperty('--day-editor-focus', c.dayFocus);
  root.style.setProperty('--dark-editor-bg', c.darkEditorBg);
  root.style.setProperty('--dark-code-bg', c.darkCodeBg);
  root.style.setProperty('--dark-editor-text', c.darkText);
  root.style.setProperty('--dark-editor-caret', c.darkCaret);
  root.style.setProperty('--dark-find-marker-bg', c.darkMarker);
  root.style.setProperty('--dark-editor-focus', c.darkFocus);
}
function applyToolbarFontSizeToDom(value = getPreferences().toolbarFontSizePt) {
  document.documentElement.style.setProperty('--toolbar-font-size', `${normalizeToolbarFontSizePt(value)}pt`);
}
function applyColorPreviewSizeToDom(value = getPreferences().colorPreviewSizePx) {
  document.documentElement.style.setProperty('--color-preview-size-px', `${normalizeColorPreviewSizePx(value)}px`);
}
function applyToolbarRowHeightToDom(value = getPreferences().toolbarRowHeightPx) {
  document.documentElement.style.setProperty('--toolbar-row-height', `${normalizeToolbarRowHeightPx(value)}px`);
}
function applyLineNumberFontSizeToDom(value = getPreferences().lineNumberFontSizePx) {
  document.documentElement.style.setProperty('--line-number-font-size', `${normalizeLineNumberFontSizePx(value)}px`);
}
function applyLineNumberGutterWidthToDom(value = getPreferences().lineNumberGutterWidthPx) {
  document.documentElement.style.setProperty('--line-gutter-width', `${normalizeLineNumberGutterWidthPx(value)}px`);
}
function normalizeFavoriteFonts(value) { return Array.isArray(value) ? value.map(v => String(v || '').trim()).filter(Boolean).slice(0, 80) : []; }
function normalizeRenderingPreferences(value = {}) { return normalizeRenderingSettings({ ...DEFAULT_PREFS.defaultRendering, ...(value || {}) }); }
function normalizePtInput(value, min, max, fallback) {
  const raw = String(value ?? '').replace(/[^0-9.]/g, '');
  const n = Number.parseFloat(raw);
  return Math.round(clampNumber(Number.isFinite(n) ? n : fallback, min, max, fallback) * 10) / 10;
}
function fontFileNameFromPath(path = '') {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}
function escapeHtml(text) { return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
function timeoutValue(ms, value = '') { return new Promise(resolve => setTimeout(() => resolve(value), ms)); }


function normalizeFontCacheRole(role = '') {
  return String(role || '').trim().toLowerCase() === 'fallback' ? 'fallback' : 'primary';
}
function isCachedAppFontPath(path = '') {
  const text = String(path || '').trim();
  const oldRoleCache = /[\\/]fonts[\\/](primary|fallback)_custom_font(?:_\d{8}_\d{6}(?:_\d+)?)?\.(ttf|otf|ttc)$/i;
  const originalNameCache = /[\\/]fonts[\\/][^\\/]+_\d{8}_\d{6}(?:_\d+)?\.(ttf|otf|ttc)$/i;
  return oldRoleCache.test(text) || originalNameCache.test(text);
}
async function cacheFontPathForRole(path = '', role = 'primary') {
  const original = normalizePathText(path, '');
  if (!original || isCachedAppFontPath(original) || !isTauriAvailable()) return original;
  const result = await cacheCustomFont(original, normalizeFontCacheRole(role));
  return normalizePathText(result?.path || original, original);
}

async function resolveSystemDefaultSaveDirectory() {
  if (DEFAULT_PREFS.defaultSaveDirectory) return DEFAULT_PREFS.defaultSaveDirectory;
  if (!isTauriAvailable()) return '';
  try {
    const dir = await Promise.race([getDefaultSaveDirectory(), timeoutValue(700, '')]);
    DEFAULT_PREFS.defaultSaveDirectory = normalizePathText(dir);
  } catch (err) {
    console.warn('default save directory lookup failed', err);
  }
  return DEFAULT_PREFS.defaultSaveDirectory || '';
}

async function preparePreferencesDefaultSaveDirectory() {
  if (settings.preferences?.defaultSaveDirectory) return;
  const dir = await resolveSystemDefaultSaveDirectory();
  if (!dir) return;
  settings.preferences.defaultSaveDirectory = dir;
  settings = normalizeSettings(settings);
  persistSoon();
}

function normalizeSettings(raw) {
  const base = makeDefaultSettings();
  const src = raw && typeof raw === 'object' ? raw : {};
  if (src.version !== SETTINGS_VERSION) return base;
  const prefs = src.preferences && typeof src.preferences === 'object' ? src.preferences : {};
  base.preferences.recentLimit = normalizeRecentLimit(prefs.recentLimit ?? DEFAULT_PREFS.recentLimit);
  base.preferences.searchHistoryLimit = normalizeSearchHistoryLimit(prefs.searchHistoryLimit ?? DEFAULT_PREFS.searchHistoryLimit);
  base.preferences.inactiveFloatingOpacity = normalizeOpacity(prefs.inactiveFloatingOpacity ?? DEFAULT_PREFS.inactiveFloatingOpacity);
  base.preferences.toolbarFontSizePt = normalizeToolbarFontSizePt(prefs.toolbarFontSizePt ?? DEFAULT_PREFS.toolbarFontSizePt);
  base.preferences.colorPreviewSizePx = normalizeColorPreviewSizePx(prefs.colorPreviewSizePx ?? (prefs.colorPreviewSizeEm !== undefined ? colorPreviewEmToPx(prefs.colorPreviewSizeEm) : DEFAULT_PREFS.colorPreviewSizePx));
  base.preferences.toolbarRowHeightPx = normalizeToolbarRowHeightPx(prefs.toolbarRowHeightPx ?? DEFAULT_PREFS.toolbarRowHeightPx);
  base.preferences.lineNumberFontSizePx = normalizeLineNumberFontSizePx(prefs.lineNumberFontSizePx ?? DEFAULT_PREFS.lineNumberFontSizePx);
  base.preferences.lineNumberGutterWidthPx = normalizeLineNumberGutterWidthPx(prefs.lineNumberGutterWidthPx ?? DEFAULT_PREFS.lineNumberGutterWidthPx);
  base.preferences.newInputDefaultColor = prefs.newInputDefaultColor === true;
  base.preferences.zeroWidthFallbackEnabled = prefs.zeroWidthFallbackEnabled !== false;
  base.preferences.codePaneExplicitDefaultColor = prefs.codePaneExplicitDefaultColor === true;
  base.preferences.editorCopyIncludeColorCodes = prefs.editorCopyIncludeColorCodes !== false;
  base.preferences.editorCopyUseLineBreakLiterals = prefs.editorCopyUseLineBreakLiterals === true;
  base.preferences.editorCopyUnicodeMode = normalizeEditorCopyUnicodeMode(prefs.editorCopyUnicodeMode ?? DEFAULT_PREFS.editorCopyUnicodeMode);
  base.preferences.jsonKeyExtractLanguage = normalizeJsonKeyExtractLanguage(prefs.jsonKeyExtractLanguage ?? DEFAULT_PREFS.jsonKeyExtractLanguage);
  base.preferences.colorLinks = normalizeColorLinks(prefs.colorLinks ?? DEFAULT_PREFS.colorLinks);
  base.preferences.colorShortcutIgnoreShift = prefs.colorShortcutIgnoreShift !== false;
  base.preferences.zeroWidthFallbackFontFamily = normalizePathText(prefs.zeroWidthFallbackFontFamily, DEFAULT_PREFS.zeroWidthFallbackFontFamily) || DEFAULT_PREFS.zeroWidthFallbackFontFamily;
  base.preferences.zeroWidthFallbackFontSource = ['builtin', 'builtinFallback', 'system', 'custom'].includes(prefs.zeroWidthFallbackFontSource) ? prefs.zeroWidthFallbackFontSource : DEFAULT_PREFS.zeroWidthFallbackFontSource;
  base.preferences.zeroWidthFallbackFontPath = normalizePathText(prefs.zeroWidthFallbackFontPath, DEFAULT_PREFS.zeroWidthFallbackFontPath);
  base.preferences.zeroWidthFallbackFontFileName = normalizePathText(prefs.zeroWidthFallbackFontFileName, fontFileNameFromPath(base.preferences.zeroWidthFallbackFontPath) || DEFAULT_PREFS.zeroWidthFallbackFontFileName);
  base.preferences.zeroWidthFallbackFontSelectionMode = prefs.zeroWidthFallbackFontSelectionMode === 'system' ? 'system' : 'path';
  base.preferences.zeroWidthFallbackFontSizePt = normalizePtInput(prefs.zeroWidthFallbackFontSizePt, 6, 999, DEFAULT_PREFS.zeroWidthFallbackFontSizePt);
  base.preferences.zeroWidthFallbackLineHeightPt = normalizePtInput(prefs.zeroWidthFallbackLineHeightPt, 6, 2000, DEFAULT_PREFS.zeroWidthFallbackLineHeightPt);
  base.preferences.undoHistoryLimit = normalizeUndoHistoryLimit(prefs.undoHistoryLimit ?? DEFAULT_PREFS.undoHistoryLimit);
  base.preferences.uiLanguage = normalizeUiLanguage(prefs.uiLanguage ?? DEFAULT_PREFS.uiLanguage);
  base.preferences.themeMode = normalizeThemeMode(prefs.themeMode ?? DEFAULT_PREFS.themeMode);
  base.preferences.editorThemeColors = normalizeEditorThemeColors(prefs.editorThemeColors ?? DEFAULT_PREFS.editorThemeColors);
  base.preferences.customFontSelectionMode = prefs.customFontSelectionMode === 'system' ? 'system' : 'path';
  base.preferences.renderingFavoriteFonts = normalizeFavoriteFonts(prefs.renderingFavoriteFonts);
  base.preferences.defaultRendering = normalizeRenderingPreferences(prefs.defaultRendering ?? DEFAULT_PREFS.defaultRendering);
  base.preferences.startMaximized = prefs.startMaximized !== false;
  base.preferences.systemTrayEnabled = prefs.systemTrayEnabled !== false;
  base.preferences.windowsShellTxtContextMenu = prefs.windowsShellTxtContextMenu !== false;
  base.preferences.defaultSaveDirectory = normalizePathText(prefs.defaultSaveDirectory, DEFAULT_PREFS.defaultSaveDirectory);
  base.preferences.restoreOpenDocuments = prefs.restoreOpenDocuments !== false;
  base.preferences.saveDisplaySettingsInFile = prefs.saveDisplaySettingsInFile !== false;
  base.preferences.showTabSaveWarning = prefs.showTabSaveWarning !== false;
  base.preferences.showZeroWidthSaveWarning = prefs.showZeroWidthSaveWarning !== false;
  base.preferences.newDocumentBaseName = normalizeNewDocumentBaseName(prefs.newDocumentBaseName ?? DEFAULT_PREFS.newDocumentBaseName);
  base.preferences.newDocumentSequenceDigits = normalizeSequenceDigits(prefs.newDocumentSequenceDigits ?? DEFAULT_PREFS.newDocumentSequenceDigits);
  base.preferences.defaultLayoutMode = normalizeLayoutMode(prefs.defaultLayoutMode ?? prefs.layoutMode ?? DEFAULT_PREFS.defaultLayoutMode);
  base.preferences.layoutMode = normalizeLayoutMode(prefs.layoutMode ?? base.preferences.defaultLayoutMode);
  // hotfix7e: 과거 표기 혼선 기간에 저장된 기본 레이아웃(split=우측 편집창)을
  // 새 표기 기준의 배포판 기본값(좌측 편집창=right-editor)으로 1회 보정한다.
  // 현재 표기 기준 확립 이후에는 layoutLabelStandard가 저장되므로 다시 보정하지 않는다.
  if (prefs.layoutLabelStandard !== CURRENT_LAYOUT_LABEL_STANDARD && base.preferences.defaultLayoutMode === 'split') {
    base.preferences.defaultLayoutMode = DEFAULT_PREFS.defaultLayoutMode;
    if (!prefs.layoutMode || prefs.layoutMode === 'split') base.preferences.layoutMode = DEFAULT_PREFS.layoutMode;
  }
  base.preferences.layoutLabelStandard = CURRENT_LAYOUT_LABEL_STANDARD;
  base.preferences.leftPanePercent = normalizePercent(prefs.leftPanePercent ?? DEFAULT_PREFS.leftPanePercent, 15, 80, DEFAULT_PREFS.leftPanePercent);
  base.preferences.verticalCodePercent = normalizePercent(prefs.verticalCodePercent ?? DEFAULT_PREFS.verticalCodePercent, 10, 75, DEFAULT_PREFS.verticalCodePercent);
  base.preferences.bottomCodePercent = normalizePercent(prefs.bottomCodePercent ?? DEFAULT_PREFS.bottomCodePercent, 10, 75, DEFAULT_PREFS.bottomCodePercent);
  base.recentDocuments = Array.isArray(src.recentDocuments) ? src.recentDocuments.filter(x => x && x.path).slice(0, 10) : [];
  base.searchHistory = Array.isArray(src.searchHistory) ? src.searchHistory.filter(Boolean).map(String).slice(0, base.preferences.searchHistoryLimit) : [];
  base.lineHistory = Array.isArray(src.lineHistory) ? src.lineHistory.filter(Boolean).map(String).slice(0, base.preferences.searchHistoryLimit) : [];
  base.openDocumentPaths = Array.isArray(src.openDocumentPaths) ? [...new Set(src.openDocumentPaths.filter(Boolean).map(String))].slice(0, 10) : [];
  return base;
}

function readLegacySettings() {
  const out = makeDefaultSettings();
  try {
    const legacyPrefs = JSON.parse(localStorage.getItem(LEGACY_PREF_KEY) || '{}') || {};
    out.preferences = { ...out.preferences, ...legacyPrefs };
  } catch (_) {}
  try { out.recentDocuments = JSON.parse(localStorage.getItem(LEGACY_RECENT_KEY) || '[]') || []; } catch (_) {}
  try { out.searchHistory = JSON.parse(localStorage.getItem(LEGACY_SEARCH_HISTORY_KEY) || '[]') || []; } catch (_) {}
  return normalizeSettings(out);
}

function parseSettingsJson(text) {
  if (!text || !String(text).trim()) return makeDefaultSettings();
  return normalizeSettings(JSON.parse(text));
}

function snapshotJson() { return JSON.stringify(settings, null, 2); }

async function persistSettings() {
  const content = snapshotJson();
  try {
    if (isTauriAvailable()) await writeSettingsJson(content);
    else localStorage.setItem(FALLBACK_SETTINGS_KEY, content);
  } catch (err) {
    console.warn('settings persist failed', err);
  }
}

function persistSoon() { void persistSettings(); }

export async function initSettingsStore() {
  if (loaded) return;
  try {
    if (isTauriAvailable()) {
      const text = await readSettingsJson();
      if (text && String(text).trim() && String(text).trim() !== '{}') settings = parseSettingsJson(text);
      else settings = readLegacySettings();
    } else {
      const text = localStorage.getItem(FALLBACK_SETTINGS_KEY) || '';
      settings = text ? parseSettingsJson(text) : readLegacySettings();
    }
  } catch (err) {
    console.warn('settings load failed', err);
    settings = readLegacySettings();
  }
  loaded = true;
  applyPreferencesToRuntime();
  document.documentElement.dataset.theme = normalizeThemeMode(getPreferences().themeMode);
  document.dispatchEvent(new CustomEvent('tooltipeditor:preferences-changed', { detail: getPreferences() }));
  persistSoon();
}

export function applyPreferencesToRuntime() {
  const prefs = getPreferences();
  setFloatingInactiveOpacity(prefs.inactiveFloatingOpacity);
  applyEditorThemeColorsToDom(prefs.editorThemeColors);
  applyToolbarFontSizeToDom(prefs.toolbarFontSizePt);
  applyColorPreviewSizeToDom(prefs.colorPreviewSizePx);
  applyToolbarRowHeightToDom(prefs.toolbarRowHeightPx);
  applyLineNumberFontSizeToDom(prefs.lineNumberFontSizePx);
  applyLineNumberGutterWidthToDom(prefs.lineNumberGutterWidthPx);
  setColorInputPolicy(prefs);
  setPreserveExplicitDefaultColorTokens(prefs.codePaneExplicitDefaultColor === true);
  setUndoHistoryLimit(prefs.undoHistoryLimit);
  setDefaultDocumentRendering(prefs.defaultRendering);
}
export function getSettingsSnapshot() { return normalizeSettings(settings); }
export function getPreferences() { return { ...DEFAULT_PREFS, ...(settings.preferences || {}) }; }

export function setPreferences(next) {
  settings.preferences = { ...getPreferences(), ...(next || {}) };
  settings = normalizeSettings(settings);
  applyPreferencesToRuntime();
  document.dispatchEvent(new CustomEvent('tooltipeditor:preferences-changed', { detail: getPreferences() }));
  persistSoon();
}
export function setNewInputDefaultColorPreference(value) {
  setPreferences({ newInputDefaultColor: value === true });
}
export function setZeroWidthFallbackEnabledPreference(value) {
  setPreferences({ zeroWidthFallbackEnabled: value !== false });
}
export function getDefaultEditorCopyOptions() {
  return {
    editorCopyIncludeColorCodes: DEFAULT_PREFS.editorCopyIncludeColorCodes,
    editorCopyUseLineBreakLiterals: DEFAULT_PREFS.editorCopyUseLineBreakLiterals,
    editorCopyUnicodeMode: DEFAULT_PREFS.editorCopyUnicodeMode,
  };
}
export function setEditorCopyOptions(next = {}) {
  const current = getPreferences();
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(next || {}, key);
  setPreferences({
    editorCopyIncludeColorCodes: hasOwn('editorCopyIncludeColorCodes') ? next.editorCopyIncludeColorCodes !== false : current.editorCopyIncludeColorCodes !== false,
    editorCopyUseLineBreakLiterals: hasOwn('editorCopyUseLineBreakLiterals') ? next.editorCopyUseLineBreakLiterals !== false : current.editorCopyUseLineBreakLiterals !== false,
    editorCopyUnicodeMode: normalizeEditorCopyUnicodeMode(hasOwn('editorCopyUnicodeMode') ? next.editorCopyUnicodeMode : current.editorCopyUnicodeMode),
  });
}
export function resetEditorCopyOptionsToDefault() { setEditorCopyOptions(getDefaultEditorCopyOptions()); }


export function getRecentDocuments() { return (settings.recentDocuments || []).filter(x => x && x.path); }
export function saveRecentDocuments(items) { settings.recentDocuments = (items || []).filter(x => x && x.path).slice(0, getPreferences().recentLimit); persistSoon(); }
export function clearRecentDocuments() { saveRecentDocuments([]); }
export function removeRecentDocument(path) { saveRecentDocuments(getRecentDocuments().filter(x => x.path !== path)); }
export function getSearchHistory() { return (settings.searchHistory || []).filter(Boolean).slice(0, getPreferences().searchHistoryLimit); }
export function saveSearchHistory(items) { settings.searchHistory = (items || []).filter(Boolean).map(String).slice(0, getPreferences().searchHistoryLimit); persistSoon(); }
export function clearSearchHistory() { saveSearchHistory([]); }
export function getLineHistory() { return (settings.lineHistory || []).filter(Boolean).slice(0, getPreferences().searchHistoryLimit); }
export function saveLineHistory(items) { settings.lineHistory = (items || []).filter(Boolean).map(String).slice(0, getPreferences().searchHistoryLimit); persistSoon(); }
export function clearLineHistory() { saveLineHistory([]); }
export function getOpenDocumentPaths() { return Array.isArray(settings.openDocumentPaths) ? settings.openDocumentPaths.filter(Boolean).map(String) : []; }
export function saveOpenDocumentPaths(paths) { settings.openDocumentPaths = [...new Set((paths || []).filter(Boolean).map(String))].slice(0, 10); persistSoon(); }

export function addLineHistory(text) {
  const value = String(text || '').trim();
  if (!value) return;
  saveLineHistory([value, ...getLineHistory().filter(x => x !== value)]);
}

export function addSearchHistory(text) {
  const value = String(text || '').trim();
  if (!value) return;
  saveSearchHistory([value, ...getSearchHistory().filter(x => x !== value)]);
}

export function addRecentDocument(path) {
  if (!path) return;
  const prefs = getPreferences();
  const limit = Math.max(0, Math.min(10, Number.parseInt(prefs.recentLimit, 10) || 0));
  if (limit <= 0) { clearRecentDocuments(); return; }
  const name = String(path).split(/[\\/]/).filter(Boolean).pop() || path;
  const now = new Date().toISOString();
  const prev = getRecentDocuments().filter(x => x.path !== path);
  saveRecentDocuments([{ path, name, openedAt: now }, ...prev].slice(0, limit));
}


function layoutOptionsHtml(selected) {
  const entries = [
    ['right-editor', '좌측 편집창'],
    ['split', '우측 편집창'],
    ['bottom-code', '상단 편집창'],
    ['vertical', '하단 편집창'],
    ['editor-only', '편집창만'],
    ['code-only', '코드창만'],
  ];
  return entries.map(([value, label]) => {
    const mark = value === selected ? ' (기본값)' : '';
    return `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}${mark}</option>`;
  }).join('');
}

function createGeneralPanel(prefs) {
  const panel = document.createElement('div');
  const opacityPercent = Math.round(normalizeOpacity(prefs.inactiveFloatingOpacity) * 100);
  panel.className = 'pref-category-panel';
  panel.dataset.category = 'general';
  panel.innerHTML = `
    <div class="pref-section pref-section-layout">
      <div class="form-row">
        <span>기본 레이아웃</span>
        <select id="defaultLayoutModeSelect" class="pref-select">${layoutOptionsHtml(prefs.defaultLayoutMode || DEFAULT_PREFS.defaultLayoutMode)}</select>
      </div>
      <div class="form-row pref-start-maximized-row">
        <span>실행 시 창 상태</span>
        <label class="pref-check-inline"><input id="startMaximizedToggle" type="checkbox" ${prefs.startMaximized !== false ? 'checked' : ''}> 실행 시 최대화된 창으로 실행</label>
      </div>
      <div class="form-row pref-system-tray-row">
        <span>시스템 트레이</span>
        <label class="pref-check-inline"><input id="systemTrayEnabledToggle" type="checkbox" ${prefs.systemTrayEnabled !== false ? 'checked' : ''}> 시스템 트레이 사용 (닫기 시 트레이로 보냄)</label>
      </div>
      <div class="form-row pref-shell-menu-row">
        <span>Windows 쉘 메뉴</span>
        <label class="pref-check-inline"><input id="windowsShellTxtContextMenuToggle" type="checkbox" ${prefs.windowsShellTxtContextMenu !== false ? 'checked' : ''}> txt 우클릭 메뉴에 "D2R 툴팁편집기로 열기" 추가</label>
      </div>
      <div class="form-row pref-json-key-extract-row">
        <span>JSON 키 추출 시 언어</span>
        <select id="jsonKeyExtractLanguageSelect" class="pref-select">${jsonKeyExtractLanguageOptionsHtml({ selected: prefs.jsonKeyExtractLanguage || DEFAULT_PREFS.jsonKeyExtractLanguage, defaultLanguage: prefs.jsonKeyExtractLanguage || DEFAULT_PREFS.jsonKeyExtractLanguage })}</select>
      </div>
    </div>


    <div class="pref-section pref-section-opacity">
      <div class="form-row pref-opacity-row">
        <span>창 비활성화 시 투명도</span>
        <div class="pref-range-box">
          <input id="inactiveOpacitySlider" type="range" min="10" max="100" step="1" value="${opacityPercent}">
          <div class="input-with-unit opacity-input-unit">
            <div class="input-unit-row">
              <input id="inactiveOpacityInput" type="number" min="10" max="100" step="1" data-input-hint="숫자만 입력할 수 있습니다. 범위: 10~100." value="${opacityPercent}">
              <span class="unit">%</span>
            </div>
            <div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 10~100.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="pref-section pref-section-limits">
      <div class="form-row">
        <span>실행취소 히스토리 횟수</span>
        <div class="pref-number-field"><input id="undoHistoryLimitInput" type="number" min="10" max="200" step="1" data-input-hint="숫자만 입력할 수 있습니다. 범위: 10~200." value="${normalizeUndoHistoryLimit(prefs.undoHistoryLimit)}"><div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 10~200.</div></div>
      </div>
      <div class="form-row">
        <span>도구모음 글꼴 크기</span>
        <div class="pref-number-field pref-number-field-with-unit">
          <div class="input-unit-row pref-number-with-unit pref-native-number-unit"><input id="toolbarFontSizePtInput" type="number" min="8" max="18" step="1" data-input-hint="숫자만 입력할 수 있습니다. 범위: 8~18." value="${normalizeToolbarFontSizePt(prefs.toolbarFontSizePt)}"><span class="unit">pt</span></div>
          <div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 8~18.</div>
        </div>
      </div>
      <div class="form-row">
        <span>색상 미리보기 크기</span>
        <div class="pref-number-field pref-number-field-with-unit">
          <div class="input-unit-row pref-number-with-unit pref-native-number-unit"><input id="colorPreviewSizePxInput" type="number" min="13" max="32" step="1" data-input-hint="숫자만 입력할 수 있습니다. 범위: 13~32." value="${colorPreviewSizeText(prefs.colorPreviewSizePx)}"><span class="unit">px</span></div>
          <div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 13~32.</div>
        </div>
      </div>
      <div class="form-row">
        <span>도구모음 행 높이</span>
        <div class="pref-number-field pref-number-field-with-unit">
          <div class="input-unit-row pref-number-with-unit pref-native-number-unit"><input id="toolbarRowHeightPxInput" type="number" min="32" max="72" step="1" data-input-hint="숫자만 입력할 수 있습니다. 범위: 32~72." value="${normalizeToolbarRowHeightPx(prefs.toolbarRowHeightPx)}"><span class="unit">px</span></div>
          <div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 32~72.</div>
        </div>
      </div>
      <div class="form-row">
        <span>최근 문서 저장 갯수</span>
        <div class="pref-number-field"><input id="recentLimitInput" type="number" min="0" max="10" step="1" data-input-hint="숫자만 입력할 수 있습니다. 범위: 0~10." value="${Number(prefs.recentLimit) || 0}"><div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 0~10.</div></div>
      </div>
      <div class="form-row">
        <span>최근 검색어 저장 갯수</span>
        <div class="pref-number-field"><input id="searchHistoryLimitInput" type="number" min="0" max="10" step="1" data-input-hint="숫자만 입력할 수 있습니다. 범위: 0~10." value="${Number(prefs.searchHistoryLimit) || 0}"><div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 0~10.</div></div>
      </div>
    </div>

    <div class="pref-section pref-section-maintenance">
      <div class="pref-maintenance-row pref-maintenance-row-basic">
        <button id="clearRecentBtn" type="button">최근 파일목록 삭제</button>
        <button id="clearSearchBtn" type="button">검색기록 삭제</button>
      </div>
      <div class="pref-maintenance-danger-row">
        <button id="deleteUserDataBtn" class="pref-danger-button" type="button">프로그램이 만든 사용자 데이터 삭제..</button>
      </div>
    </div>
  `;
  return panel;
}


function sequenceDigitOptionsHtml(selected) {
  const value = normalizeSequenceDigits(selected);
  return [1, 2, 3, 4].map(n => `<option value="${n}" ${n === value ? 'selected' : ''}>${n}자리</option>`).join('');
}

function newDocumentNameExample(base, digits) {
  const name = normalizeNewDocumentBaseName(base);
  const width = normalizeSequenceDigits(digits);
  return `${name}${String(1).padStart(width, '0')}`;
}

function createSavePanel(prefs) {
  const panel = document.createElement('div');
  panel.className = 'pref-category-panel';
  panel.dataset.category = 'save';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="pref-section pref-section-save-title">
      <div class="form-row">
        <span>새 문서 제목</span>
        <input id="newDocumentBaseNameInput" type="text" value="${escapeHtml(displayNewDocumentBaseName(prefs.newDocumentBaseName))}" autocomplete="off" spellcheck="false">
      </div>
      <div class="form-row">
        <span>일련번호 자릿수</span>
        <select id="newDocumentSequenceDigitsSelect" class="pref-select">${sequenceDigitOptionsHtml(prefs.newDocumentSequenceDigits)}</select>
      </div>
      <div class="form-row pref-save-example-row">
        <span></span>
        <div id="newDocumentNameExample" class="pref-save-example">예시명 : ${escapeHtml(newDocumentNameExample(displayNewDocumentBaseName(prefs.newDocumentBaseName), prefs.newDocumentSequenceDigits))}</div>
      </div>
    </div>

    <div class="pref-section pref-section-save-session">
      <div class="form-row">
        <span>시작 시 문서 복원</span>
        <label class="pref-check-inline"><input id="restoreOpenDocumentsToggle" type="checkbox" ${prefs.restoreOpenDocuments !== false ? 'checked' : ''}> 마지막으로 열려 있던 저장 문서 다시 열기</label>
      </div>
      <div class="form-row">
        <span>문서 표시 설정</span>
        <label class="pref-check-inline"><input id="saveDisplaySettingsToggle" type="checkbox" ${prefs.saveDisplaySettingsInFile !== false ? 'checked' : ''}> 표시 설정을 파일 내부에 저장</label>
      </div>
    </div>

    <div class="pref-section pref-section-save-warnings">
      <div class="form-row">
        <span>저장 경고</span>
        <label class="pref-check-inline"><input id="showTabSaveWarningToggle" type="checkbox" ${prefs.showTabSaveWarning !== false ? 'checked' : ''}> 탭 문자 포함 시 저장 확인</label>
      </div>
      <div class="form-row">
        <span></span>
        <label class="pref-check-inline"><input id="showZeroWidthSaveWarningToggle" type="checkbox" ${prefs.showZeroWidthSaveWarning !== false ? 'checked' : ''}> 0 너비 문자(U+2060) 포함 시 저장 확인</label>
      </div>
    </div>

    <div class="pref-section pref-section-save-path">
      <div class="form-row pref-save-path-row">
        <span>기본 저장 경로</span>
        <div class="pref-path-box">
          <input id="defaultSaveDirectoryInput" type="text" value="${escapeHtml(prefs.defaultSaveDirectory || DEFAULT_PREFS.defaultSaveDirectory || '')}" placeholder="${escapeHtml(DEFAULT_PREFS.defaultSaveDirectory || '')}" autocomplete="off" spellcheck="false">
          <button id="browseDefaultSaveDirectoryBtn" type="button">찾아보기..</button>
        </div>
      </div>
    </div>
  `;
  return panel;
}


function fontSourceOptionsHtml(selected) {
  const value = ['builtin', 'builtinFallback', 'system', 'custom'].includes(selected) ? selected : DEFAULT_PREFS.defaultRendering.fontSource;
  const entries = [['builtin', BUILTIN_FONT_DISPLAY_NAME], ['builtinFallback', FALLBACK_FONT_DISPLAY_NAME], ['system', '맑은 고딕'], ['custom', '대표 글꼴']];
  return entries.map(([v, label]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`).join('');
}

function alignOptionsHtml(selected) {
  const value = ['left', 'center', 'right'].includes(selected) ? selected : DEFAULT_PREFS.defaultRendering.textAlign;
  const entries = [['left', '왼쪽 정렬'], ['center', '가운데 정렬'], ['right', '오른쪽 정렬']];
  return entries.map(([v, label]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`).join('');
}

function fontRowId(row = {}) { return getFontId(row); }
function prefFontLabel(row = {}) { return serviceDisplayFontLabel(row); }

function colorFieldHtml(id, label, value) {
  const hex = normalizeHexColor(value, '#000000');
  const bare = hex.slice(1);
  return `<div class="form-row pref-color-row"><span>${label}</span><div class="pref-color-box"><input id="${id}Picker" type="color" value="${hex}" aria-label="${label} 색상 선택"><input id="${id}Input" type="text" inputmode="text" maxlength="6" value="${bare}" data-hex-color="${id}" data-input-hint="6자리 HEX 값(0-9, A-F)만 입력할 수 있습니다."><div class="input-inline-hint">⚠ 6자리 HEX 값(0-9, A-F)만 입력할 수 있습니다.</div></div></div>`;
}

function createThemePanel(prefs) {
  const panel = document.createElement('div');
  panel.className = 'pref-category-panel';
  panel.dataset.category = 'theme';
  panel.hidden = true;
  const colors = prefs.editorThemeColors || DEFAULT_PREFS.editorThemeColors;
  panel.innerHTML = `
    <div class="pref-section pref-section-theme">
      <div class="form-row">
        <span>최초 실행 테마</span>
        <select id="themeModeSelect" class="pref-select">
          <option value="dark" ${normalizeThemeMode(prefs.themeMode) === 'dark' ? 'selected' : ''}>다크모드</option>
          <option value="day" ${normalizeThemeMode(prefs.themeMode) === 'day' ? 'selected' : ''}>데이모드</option>
        </select>
      </div>
      <p class="pref-note">이 항목은 다음 실행 시작 테마만 정합니다. 현재 화면 전환은 메인 패널의 테마 전환 버튼을 사용합니다.</p>
      <hr class="pref-section-divider pref-theme-intro-divider">
      <div class="pref-theme-color-grid">
        <div class="pref-theme-subtitle">데이모드 색상</div>
        ${colorFieldHtml('dayEditorBg', '데이모드 편집창 배경', colors.dayEditorBg)}
        ${colorFieldHtml('dayCodeBg', '데이모드 코드창 배경', colors.dayCodeBg)}
        ${colorFieldHtml('dayText', '데이모드 글꼴 색상', colors.dayText)}
        ${colorFieldHtml('dayCaret', '데이모드 커서 색상', colors.dayCaret)}
        ${colorFieldHtml('dayMarker', '데이모드 블록 색상', colors.dayMarker)}
        ${colorFieldHtml('dayFocus', '데이모드 창 둘레 강조', colors.dayFocus)}
        <hr class="pref-section-divider pref-theme-mode-divider">
        <div class="pref-theme-subtitle">다크모드 색상</div>
        ${colorFieldHtml('darkEditorBg', '다크모드 편집창 배경', colors.darkEditorBg)}
        ${colorFieldHtml('darkCodeBg', '다크모드 코드창 배경', colors.darkCodeBg)}
        ${colorFieldHtml('darkText', '다크모드 글꼴 색상', colors.darkText)}
        ${colorFieldHtml('darkCaret', '다크모드 커서 색상', colors.darkCaret)}
        ${colorFieldHtml('darkMarker', '다크모드 블록 색상', colors.darkMarker)}
        ${colorFieldHtml('darkFocus', '다크모드 창 둘레 강조', colors.darkFocus)}
      </div>
    </div>
  `;
  return panel;
}

function createRenderingPanel(prefs) {
  const panel = document.createElement('div');
  panel.className = 'pref-category-panel';
  panel.dataset.category = 'rendering';
  panel.hidden = true;
  const rendering = normalizeRenderingPreferences(prefs.defaultRendering || DEFAULT_PREFS.defaultRendering);
  const customMode = prefs.customFontSelectionMode === 'system' ? 'system' : 'path';
  panel.innerHTML = `
    <div class="pref-section pref-section-rendering-defaults">
      <div class="pref-section-caption">새 문서를 열었을 때 :</div>
      <div class="form-row">
        <span>기본 글꼴</span>
        <select id="defaultRenderFontSourceSelect" class="pref-select">${fontSourceOptionsHtml(rendering.fontSource)}</select>
      </div>
      <div class="form-row">
        <span>기본 글꼴 크기</span>
        <div class="pref-number-field pref-number-field-with-unit pref-rendering-number-field"><div class="input-unit-row pref-number-with-unit pref-native-number-unit"><input id="defaultFontSizePtInput" type="number" min="6" max="999" step="1" value="${String(Math.round(rendering.fontSizePt))}" autocomplete="off" data-input-hint="숫자만 입력할 수 있습니다. 범위: 6~999."><span class="unit">pt</span></div><div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 6~999.</div></div>
      </div>
      <div class="form-row">
        <span>기본 줄 간격 크기</span>
        <div class="pref-number-field pref-number-field-with-unit pref-rendering-number-field"><div class="input-unit-row pref-number-with-unit pref-native-number-unit"><input id="defaultLineHeightSizePtInput" type="number" min="6" max="2000" step="1" value="${String(Math.round(rendering.lineHeightPt || DEFAULT_PREFS.defaultRendering.lineHeightPt))}" autocomplete="off" data-input-hint="숫자만 입력할 수 있습니다. 범위: 6~2000."><span class="unit">pt</span></div><div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 6~2000.</div></div>
      </div>
      <div class="form-row">
        <span>기본 정렬</span>
        <select id="defaultTextAlignSelect" class="pref-select">${alignOptionsHtml(rendering.textAlign)}</select>
      </div>
      <div class="form-row">
        <span>기본 탭 너비</span>
        <div class="pref-number-inline-hint pref-number-no-unit"><input id="defaultTabWidthInput" type="number" min="1" max="32" step="1" value="${rendering.tabWidth}" autocomplete="off" data-input-hint="숫자만 입력할 수 있습니다. 범위: 1~32."><div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 1~32.</div></div>
      </div>
      <hr class="pref-section-divider">
      <div class="form-row pref-fallback-font-row">
        <span>대체 글꼴 경로</span>
        <div class="pref-path-box">
          <input id="zeroWidthFallbackFontPathInput" type="text" value="${escapeHtml(prefs.zeroWidthFallbackFontPath || '')}" placeholder="예: C:\\Windows\\Fonts\\fallback.ttf" autocomplete="off" spellcheck="false">
          <button id="browseZeroWidthFallbackFontBtn" type="button">찾아보기..</button>
        </div>
      </div>
      <input id="zeroWidthFallbackFontFamilyInput" type="hidden" value="${escapeHtml(prefs.zeroWidthFallbackFontFamily || DEFAULT_PREFS.zeroWidthFallbackFontFamily)}">
      <input id="zeroWidthFallbackFontSourceInput" type="hidden" value="${escapeHtml(prefs.zeroWidthFallbackFontSource || DEFAULT_PREFS.zeroWidthFallbackFontSource)}">
      <input id="zeroWidthFallbackFontModeInput" type="hidden" value="${escapeHtml(prefs.zeroWidthFallbackFontSelectionMode || 'path')}">
      <div class="form-row pref-fallback-font-picker-row">
        <span>대체 글꼴 선택</span>
        <div class="pref-font-picker" id="zeroWidthFallbackFontPicker">
          <button id="zeroWidthFallbackFontPickerButton" class="render-font-button pref-font-picker-button" type="button"><span id="zeroWidthFallbackFontPickerLabel">대체 글꼴 불러오는 중</span><span class="render-arrow">▾</span></button>
          <button id="zeroWidthFallbackFontPathModeBtn" type="button" class="pref-font-path-mode-button">직접 경로 사용</button>
          <div id="zeroWidthFallbackFontPickerPanel" class="render-font-panel pref-font-panel" hidden>
            <input id="zeroWidthFallbackFontSearchInput" class="render-font-search" type="text" placeholder="글꼴 검색" autocomplete="off" spellcheck="false">
            <div id="zeroWidthFallbackFontPickerStatus" class="render-font-status">시스템 글꼴 목록을 불러옵니다.</div>
            <div id="zeroWidthFallbackFontList" class="pref-font-list"></div>
          </div>
        </div>
      </div>
      <div class="form-row">
        <span>대체 글꼴 크기</span>
        <div class="pref-number-field pref-number-field-with-unit pref-rendering-number-field"><div class="input-unit-row pref-number-with-unit pref-native-number-unit"><input id="zeroWidthFallbackFontSizePtInput" type="number" min="6" max="999" step="1" value="${String(Math.round(prefs.zeroWidthFallbackFontSizePt || DEFAULT_PREFS.zeroWidthFallbackFontSizePt))}" autocomplete="off" data-input-hint="숫자만 입력할 수 있습니다. 범위: 6~999."><span class="unit">pt</span></div><div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 6~999.</div></div>
      </div>
      <div class="form-row">
        <span>대체 줄 간격 크기</span>
        <div class="pref-number-field pref-number-field-with-unit pref-rendering-number-field"><div class="input-unit-row pref-number-with-unit pref-native-number-unit"><input id="zeroWidthFallbackLineHeightPtInput" type="number" min="6" max="2000" step="1" value="${String(Math.round(prefs.zeroWidthFallbackLineHeightPt || DEFAULT_PREFS.zeroWidthFallbackLineHeightPt))}" autocomplete="off" data-input-hint="숫자만 입력할 수 있습니다. 범위: 6~2000."><span class="unit">pt</span></div><div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 6~2000.</div></div>
      </div>
      <hr class="pref-section-divider">
      <div class="form-row pref-custom-font-row">
        <span>대표 글꼴 경로</span>
        <div class="pref-path-box">
          <input id="customFontPathInput" type="text" value="${escapeHtml(rendering.fontPath || '')}" placeholder="예: C:\\Windows\\Fonts\\custom.ttf" autocomplete="off" spellcheck="false">
          <button id="browseCustomFontBtn" type="button">찾아보기..</button>
        </div>
      </div>
      <input id="customFontModeInput" type="hidden" value="${customMode}">
      <div class="form-row pref-custom-font-picker-row">
        <span>대표 글꼴 선택</span>
        <div class="pref-font-picker" id="prefCustomFontPicker">
          <button id="prefFontPickerButton" class="render-font-button pref-font-picker-button" type="button"><span id="prefFontPickerLabel">글꼴 목록 불러오는 중</span><span class="render-arrow">▾</span></button>
          <button id="prefFontPathModeBtn" type="button" class="pref-font-path-mode-button">직접 경로 사용</button>
          <div id="prefFontPickerPanel" class="render-font-panel pref-font-panel" hidden>
            <input id="prefFontSearchInput" class="render-font-search" type="text" placeholder="글꼴 검색" autocomplete="off">
            <div id="prefFontPickerStatus" class="render-font-status">시스템 글꼴 목록을 불러옵니다.</div>
            <div id="prefFontList" class="pref-font-list"></div>
          </div>
        </div>
      </div>
      <hr class="pref-section-divider">
      <div class="form-row">
        <span>행 번호 크기</span>
        <div class="pref-number-field pref-number-field-with-unit pref-rendering-number-field"><div class="input-unit-row pref-number-with-unit pref-native-number-unit"><input id="lineNumberFontSizePxInput" type="number" min="8" max="32" step="1" value="${String(normalizeLineNumberFontSizePx(prefs.lineNumberFontSizePx))}" autocomplete="off" data-input-hint="숫자만 입력할 수 있습니다. 범위: 8~32."><span class="unit">px</span></div><div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 8~32.</div></div>
      </div>
      <div class="form-row">
        <span>행 번호 열 너비</span>
        <div class="pref-number-field pref-number-field-with-unit pref-rendering-number-field"><div class="input-unit-row pref-number-with-unit pref-native-number-unit"><input id="lineNumberGutterWidthPxInput" type="number" min="32" max="120" step="1" value="${String(normalizeLineNumberGutterWidthPx(prefs.lineNumberGutterWidthPx))}" autocomplete="off" data-input-hint="숫자만 입력할 수 있습니다. 범위: 32~120."><span class="unit">px</span></div><div class="input-inline-hint">⚠ 숫자만 입력할 수 있습니다. 범위: 32~120.</div></div>
      </div>
    </div>
  `;
  return panel;
}


function colorShortcutDisplayHtml(item = {}) {
  const label = colorShortcutDisplay(item);
  const fn = normalizeFnShortcut(item.shortcutKey, '');
  const cls = fn ? 'pref-color-link-key pref-color-link-fn-shortcut' : 'pref-color-link-key';
  return { label: label || ' ', className: cls, isFn: !!fn };
}

function toolbarOrderedColorLinks(colorLinks = DEFAULT_PREFS.colorLinks) {
  const links = normalizeColorLinks(colorLinks);
  const fnRows = [];
  const normalRows = [];
  links.forEach((item, index) => {
    const row = { item, index };
    if (normalizeFnShortcut(item.shortcutKey, '')) fnRows.push(row);
    else normalRows.push(row);
  });
  fnRows.sort((a, b) => {
    const n = fnShortcutNumber(a.item.shortcutKey) - fnShortcutNumber(b.item.shortcutKey);
    return n || a.index - b.index;
  });
  return [...fnRows, ...normalRows].map(row => row.item);
}

function colorLinkRowsHtml(colorLinks = DEFAULT_PREFS.colorLinks, selectedIndices = []) {
  const links = normalizeColorLinks(colorLinks);
  const selectedSet = new Set((Array.isArray(selectedIndices) ? selectedIndices : []).map(value => Number(value)).filter(value => Number.isInteger(value) && value >= 0));
  return links.map((item, index) => {
    const displayName = String(item.name || '').trim() || '이름 없음';
    const selected = selectedSet.has(index);
    return `
    <div class="pref-color-link-row ${selected ? 'pref-color-link-row-selected' : ''}" data-color-link-row data-index="${index}">
      <label class="pref-color-link-select-cell" aria-label="${escapeHtml(displayName)} 선택"><input type="checkbox" data-color-select ${selected ? 'checked' : ''}></label>
      <div class="pref-color-link-color-cell">
        <button type="button" class="pref-color-link-swatch" data-color-action="pick" data-tip="색상 선택" style="--link-color:${escapeHtml(item.hex)}" aria-label="${escapeHtml(displayName)} 색상 선택"><span></span></button>
        <input type="color" class="pref-color-link-picker" data-color-field="hexPicker" value="${escapeHtml(item.hex)}" aria-label="${escapeHtml(displayName)} 색상 선택">
      </div>
      <div class="pref-color-link-name-cell">
        <input type="hidden" data-color-field="name" value="${escapeHtml(item.name)}">
        <button type="button" class="pref-color-link-name" data-color-action="editName" data-tip="이름 편집" aria-label="${escapeHtml(displayName)} 이름 편집">${escapeHtml(displayName)}</button>
      </div>
      <div class="pref-color-link-key-cell">
        <input type="hidden" data-color-field="key" value="${escapeHtml(item.key)}">
        <input type="hidden" data-color-field="shortcutKey" value="${escapeHtml(item.shortcutKey || '')}">
        ${(() => { const shortcut = colorShortcutDisplayHtml(item); return `<button type="button" class="${shortcut.className}" data-color-action="editKey" data-tip="문자/Fn 편집" aria-label="${escapeHtml(displayName)} 문자 또는 Fn 단축키 편집">${escapeHtml(shortcut.label)}</button>`; })()}
      </div>
      <div class="pref-color-link-memo-cell">
        <textarea class="pref-color-link-memo-store" data-color-field="memo" aria-hidden="true" tabindex="-1">${escapeHtml(item.memo)}</textarea>
        <button type="button" class="pref-color-link-memo" data-color-action="editMemo" data-tip="메모 편집" aria-label="${escapeHtml(displayName)} 메모 편집">${escapeHtml(item.memo || '메모 없음')}</button>
      </div>
    </div>`;
  }).join('');
}

function createColorPanel(prefs = getPreferences()) {
  const links = toolbarOrderedColorLinks(prefs.colorLinks || DEFAULT_PREFS.colorLinks);
  const panel = document.createElement('div');
  panel.className = 'pref-category-panel pref-color-link-panel';
  panel.dataset.category = 'color';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="pref-section pref-color-link-section">
      <div class="pref-color-link-header">
        <div>
          <strong>색상연결</strong>
          <p>도구모음 색상 순서, 이름, 색상 문자, tooltip 메모를 설정합니다.<br>옛 버전의 색상코드를 포함한 문서 내용은 바꾸기 기능으로 직접 바꿔야 합니다.</p>
        </div>
        <div id="colorLinkCount" class="pref-color-link-count">총 색상 수: ${links.length}개</div>
      </div>
      <label class="pref-check-inline pref-color-shift-option"><input id="colorShortcutIgnoreShiftToggle" type="checkbox" ${prefs.colorShortcutIgnoreShift !== false ? 'checked' : ''}> <a href="#" class="pref-color-shift-label pref-color-shift-help-link" data-tip="Shift가 필요한 색상도 충돌이 없으면 Ctrl+Alt+문자로 입력합니다. 겹치면 제외합니다.">색상 단축키에서 Shift 강제 제외 (실험기능)</a></label>
      <div class="pref-color-link-grid" role="table" aria-label="색상연결 목록">
        <div class="pref-color-link-head" role="row">
          <span>선택</span>
          <span><a href="#" class="pref-color-link-help-link" data-tip="클릭해 색상을 바꿉니다. 도구모음에도 반영됩니다." aria-label="색상 도움말">색상</a></span>
          <span><a href="#" class="pref-color-link-help-link" data-tip="도구모음에 보이는 이름입니다. 최대 5자." aria-label="이름 도움말">이름</a></span>
          <span><a href="#" class="pref-color-link-help-link" data-tip="ÿc 뒤에 붙는 1글자 코드 또는 F1~F12 단축키입니다. Fn은 실제 색상코드를 바꾸지 않습니다." aria-label="문자/Fn 도움말">문자/Fn</a></span>
          <span><a href="#" class="pref-color-link-help-link" data-tip="색상 툴팁에 보일 짧은 메모입니다." aria-label="메모 도움말">메모</a></span>
        </div>
        <div id="colorLinkRows" class="pref-color-link-rows">${colorLinkRowsHtml(links)}</div>
      </div>
      <div class="pref-color-link-actions">
        <div class="pref-color-link-actions-main">
          <div class="pref-color-link-order-tools">
            <span class="pref-color-link-order-label">선택 순서</span>
            <button id="moveColorLinksTopBtn" type="button">맨 위로</button>
            <button id="moveColorLinksUpBtn" type="button">위로</button>
            <button id="moveColorLinksDownBtn" type="button">아래로</button>
            <button id="moveColorLinksBottomBtn" type="button">맨 아래로</button>
          </div>
          <div class="pref-color-link-row-actions">
            <button id="addColorLinkBtn" type="button">색상 추가</button>
            <button id="deleteColorLinkBtn" type="button">색상 삭제..</button>
          </div>
        </div>
        <div class="pref-color-link-sort-tools">
          <span class="pref-color-link-order-label">색상 정렬</span>
          <button id="sortColorLinksColorBtn" type="button" class="pref-color-link-tooltip-button" data-tip="색상군 기준으로 정렬합니다. 다시 누르면 반대순.">색상순</button>
          <button id="sortColorLinksNameBtn" type="button" class="pref-color-link-tooltip-button" data-tip="이름순으로 정렬합니다. 다시 누르면 반대순.">이름순</button>
          <button id="sortColorLinksKeyBtn" type="button" class="pref-color-link-tooltip-button" data-tip="문자순으로 정렬합니다. 다시 누르면 반대순.">문자순</button>
        </div>
      </div>
    </div>
  `;
  return panel;
}

function createPreferencesBody(prefs) {
  const body = document.createElement('div');
  body.className = 'preferences-dialog';
  const generalPanel = createGeneralPanel(prefs);
  const savePanel = createSavePanel(prefs);
  const themePanel = createThemePanel(prefs);
  const renderingPanel = createRenderingPanel(prefs);
  const colorPanel = createColorPanel(prefs);
  body.innerHTML = `
    <div class="pref-layout">
      <div class="pref-category-list" role="tablist" aria-label="환경설정 범주">
        <button type="button" class="pref-category selected" data-category="general">일반</button>
        <button type="button" class="pref-category" data-category="save">저장</button>
        <button type="button" class="pref-category" data-category="theme">테마</button>
        <button type="button" class="pref-category" data-category="rendering">편집창</button>
        <button type="button" class="pref-category" data-category="color">색상연결</button>
      </div>
      <div class="pref-category-content"></div>
    </div>
    <div class="floating-footer pref-footer">
      <div class="pref-footer-left">
        <button id="importSettingsBtn" type="button">설정 가져오기..</button>
        <button id="exportSettingsBtn" type="button">설정 내보내기..</button>
      </div>
      <div class="pref-footer-right">
        <button id="resetAllSettingsBtn" type="button">초기화</button>
        <button id="prefDefaultBtn" type="button">기본값</button>
        <button id="prefOkBtn" type="button">확인</button>
        <button id="prefCancelBtn" type="button">취소</button>
        <button id="prefApplyBtn" type="button">적용</button>
      </div>
    </div>
  `;
  body.querySelector('.pref-category-content').append(generalPanel, savePanel, themePanel, renderingPanel, colorPanel);
  return body;
}

export async function showPreferencesDialog(onApply) {
  if (prefWindow) {
    try { prefWindow.focus({ preventScroll: true }); } catch (_) {}
    prefWindow.classList.remove('modal-blink');
    void prefWindow.offsetWidth;
    prefWindow.classList.add('modal-blink');
    return;
  }

  await preparePreferencesDefaultSaveDirectory();
  const prefs = getPreferences();
  const body = createPreferencesBody(prefs);
  let activeCategory = 'general';
  let applyButton = null;
  let lastApplied = { general: '', save: '', theme: '', rendering: '', color: '{}' };

  const modalPromise = showModal({
    title: '환경설정',
    body,
    buttons: [],
    allowEsc: true,
    windowClass: 'preferences-modal-window',
  });
  prefWindow = body.closest('.modal-window');
  if (!prefWindow) return;

  const recentInput = body.querySelector('#recentLimitInput');
  const undoHistoryLimitInput = body.querySelector('#undoHistoryLimitInput');
  const searchHistoryLimitInput = body.querySelector('#searchHistoryLimitInput');
  const toolbarFontSizePtInput = body.querySelector('#toolbarFontSizePtInput');
  const colorPreviewSizePxInput = body.querySelector('#colorPreviewSizePxInput');
  const toolbarRowHeightPxInput = body.querySelector('#toolbarRowHeightPxInput');
  const defaultLayoutModeSelect = body.querySelector('#defaultLayoutModeSelect');
  const jsonKeyExtractLanguageSelect = body.querySelector('#jsonKeyExtractLanguageSelect');
  const defaultSaveDirectoryInput = body.querySelector('#defaultSaveDirectoryInput');
  const newDocumentBaseNameInput = body.querySelector('#newDocumentBaseNameInput');
  const newDocumentSequenceDigitsSelect = body.querySelector('#newDocumentSequenceDigitsSelect');
  const newDocumentNameExampleEl = body.querySelector('#newDocumentNameExample');
  const restoreOpenDocumentsToggle = body.querySelector('#restoreOpenDocumentsToggle');
  const saveDisplaySettingsToggle = body.querySelector('#saveDisplaySettingsToggle');
  const showTabSaveWarningToggle = body.querySelector('#showTabSaveWarningToggle');
  const showZeroWidthSaveWarningToggle = body.querySelector('#showZeroWidthSaveWarningToggle');
  const startMaximizedToggle = body.querySelector('#startMaximizedToggle');
  const systemTrayEnabledToggle = body.querySelector('#systemTrayEnabledToggle');
  const windowsShellTxtContextMenuToggle = body.querySelector('#windowsShellTxtContextMenuToggle');
  const browseDefaultSaveDirectoryBtn = body.querySelector('#browseDefaultSaveDirectoryBtn');
  const opacitySlider = body.querySelector('#inactiveOpacitySlider');
  const opacityInput = body.querySelector('#inactiveOpacityInput');
  const clearRecentBtn = body.querySelector('#clearRecentBtn');
  const clearSearchBtn = body.querySelector('#clearSearchBtn');
  const deleteUserDataBtn = body.querySelector('#deleteUserDataBtn');
  const resetAllSettingsBtn = body.querySelector('#resetAllSettingsBtn');
  const importBtn = body.querySelector('#importSettingsBtn');
  const exportBtn = body.querySelector('#exportSettingsBtn');
  const okBtn = body.querySelector('#prefOkBtn');
  const cancelBtn = body.querySelector('#prefCancelBtn');
  const defaultBtn = body.querySelector('#prefDefaultBtn');
  applyButton = body.querySelector('#prefApplyBtn');
  body.querySelectorAll('input[type="text"], input[type="number"], textarea').forEach(el => {
    el.removeAttribute('title');
    el.closest('label')?.removeAttribute('title');
    const row = el.closest('.form-row');
    row?.removeAttribute('title');
  });
  body.querySelectorAll('input[type="text"], input[type="number"], textarea').forEach(el => { el.removeAttribute('title'); el.setAttribute('autocomplete', 'off'); });
  const themeModeSelect = body.querySelector('#themeModeSelect');
  const defaultRenderFontSourceSelect = body.querySelector('#defaultRenderFontSourceSelect');
  const customFontPathInput = body.querySelector('#customFontPathInput');
  const browseCustomFontBtn = body.querySelector('#browseCustomFontBtn');
  const customFontModeInput = body.querySelector('#customFontModeInput');
  const prefFontPickerButton = body.querySelector('#prefFontPickerButton');
  const prefFontPickerLabel = body.querySelector('#prefFontPickerLabel');
  const prefFontPickerPanel = body.querySelector('#prefFontPickerPanel');
  const prefFontSearchInput = body.querySelector('#prefFontSearchInput');
  const prefFontList = body.querySelector('#prefFontList');
  const prefFontPickerStatus = body.querySelector('#prefFontPickerStatus');
  const prefFontPathModeBtn = body.querySelector('#prefFontPathModeBtn');
  const defaultFontSizePtInput = body.querySelector('#defaultFontSizePtInput');
  const defaultLineHeightSizePtInput = body.querySelector('#defaultLineHeightSizePtInput');
  const defaultTextAlignSelect = body.querySelector('#defaultTextAlignSelect');
  const defaultTabWidthInput = body.querySelector('#defaultTabWidthInput');
  const lineNumberFontSizePxInput = body.querySelector('#lineNumberFontSizePxInput');
  const lineNumberGutterWidthPxInput = body.querySelector('#lineNumberGutterWidthPxInput');
  const zeroWidthFallbackFontFamilyInput = body.querySelector('#zeroWidthFallbackFontFamilyInput');
  const zeroWidthFallbackFontSourceInput = body.querySelector('#zeroWidthFallbackFontSourceInput');
  const zeroWidthFallbackFontModeInput = body.querySelector('#zeroWidthFallbackFontModeInput');
  const zeroWidthFallbackFontPathInput = body.querySelector('#zeroWidthFallbackFontPathInput');
  const browseZeroWidthFallbackFontBtn = body.querySelector('#browseZeroWidthFallbackFontBtn');
  const zeroWidthFallbackFontPathModeBtn = body.querySelector('#zeroWidthFallbackFontPathModeBtn');
  const zeroWidthFallbackFontSizePtInput = body.querySelector('#zeroWidthFallbackFontSizePtInput');
  const zeroWidthFallbackLineHeightPtInput = body.querySelector('#zeroWidthFallbackLineHeightPtInput');
  const zeroWidthFallbackFontPickerButton = body.querySelector('#zeroWidthFallbackFontPickerButton');
  const zeroWidthFallbackFontPickerLabel = body.querySelector('#zeroWidthFallbackFontPickerLabel');
  const zeroWidthFallbackFontPickerPanel = body.querySelector('#zeroWidthFallbackFontPickerPanel');
  const zeroWidthFallbackFontSearchInput = body.querySelector('#zeroWidthFallbackFontSearchInput');
  const zeroWidthFallbackFontList = body.querySelector('#zeroWidthFallbackFontList');
  const zeroWidthFallbackFontPickerStatus = body.querySelector('#zeroWidthFallbackFontPickerStatus');
  const themeColorKeys = ['dayEditorBg','dayCodeBg','dayText','dayCaret','dayMarker','dayFocus','darkEditorBg','darkCodeBg','darkText','darkCaret','darkMarker','darkFocus'];
  const themeColorControls = Object.fromEntries(themeColorKeys.map(key => [key, { picker: body.querySelector(`#${key}Picker`), input: body.querySelector(`#${key}Input`) }]));
  const colorShortcutIgnoreShiftToggle = body.querySelector('#colorShortcutIgnoreShiftToggle');
  const colorLinkRowsEl = body.querySelector('#colorLinkRows');
  const colorLinkGridEl = body.querySelector('.pref-color-link-grid');
  const colorLinkCountEl = body.querySelector('#colorLinkCount');
  const addColorLinkBtn = body.querySelector('#addColorLinkBtn');
  const deleteColorLinkBtn = body.querySelector('#deleteColorLinkBtn');
  const moveColorLinksTopBtn = body.querySelector('#moveColorLinksTopBtn');
  const moveColorLinksUpBtn = body.querySelector('#moveColorLinksUpBtn');
  const moveColorLinksDownBtn = body.querySelector('#moveColorLinksDownBtn');
  const moveColorLinksBottomBtn = body.querySelector('#moveColorLinksBottomBtn');
  const sortColorLinksColorBtn = body.querySelector('#sortColorLinksColorBtn');
  const sortColorLinksNameBtn = body.querySelector('#sortColorLinksNameBtn');
  const sortColorLinksKeyBtn = body.querySelector('#sortColorLinksKeyBtn');
  let colorLinkSortState = { field: '', descending: false };
  let defaultLineRatioFontSizePt = normalizePtInput(defaultFontSizePtInput?.value, 6, 999, DEFAULT_PREFS.defaultRendering.fontSizePt);

  function syncDefaultLineHeightForFontSizeChange() {
    if (!defaultFontSizePtInput || !defaultLineHeightSizePtInput) return;
    const nextSize = normalizePtInput(defaultFontSizePtInput.value, 6, 999, defaultLineRatioFontSizePt);
    const currentLine = normalizePtInput(defaultLineHeightSizePtInput.value, 6, 2000, DEFAULT_PREFS.defaultRendering.lineHeightPt);
    if (nextSize === defaultLineRatioFontSizePt) return;
    const nextLine = Math.round(Math.max(6, Math.min(2000, currentLine * (nextSize / defaultLineRatioFontSizePt))) * 10) / 10;
    defaultLineHeightSizePtInput.value = String(Math.round(nextLine));
    defaultLineRatioFontSizePt = nextSize;
  }

  if (toolbarFontSizePtInput) {
    toolbarFontSizePtInput.removeAttribute('title');
    toolbarFontSizePtInput.setAttribute('autocomplete', 'off');
  }
  if (colorPreviewSizePxInput) {
    colorPreviewSizePxInput.removeAttribute('title');
    colorPreviewSizePxInput.setAttribute('autocomplete', 'off');
  }

  function cleanHexInputText(value, fallback = '#000000') { return normalizeHexColor(value, fallback).slice(1); }

  function numberHintBox(input) { return input?.closest?.('.pref-number-field, .pref-number-inline-hint, .input-with-unit')?.querySelector?.('.input-inline-hint') || null; }
  function hideNumberHint(input) { numberHintBox(input)?.classList.remove('visible'); }
  function attachPreferenceNumberHint(input) {
    if (!input) return;
    attachFilteredInputHint(input, { validKeyPattern: /^\d$/, validInputPattern: /^\d+$/ });
  }
  function attachPreferenceHexHint(input) {
    if (!input) return;
    attachFilteredInputHint(input, { validKeyPattern: /^[0-9a-fA-F]$/, validInputPattern: /^[0-9a-fA-F]+$/ });
  }


  function readThemeColorForm() {
    const base = normalizeEditorThemeColors(getPreferences().editorThemeColors || DEFAULT_PREFS.editorThemeColors);
    const out = {};
    for (const key of themeColorKeys) out[key] = normalizeHexColor(themeColorControls[key]?.input?.value, base[key] || DEFAULT_PREFS.editorThemeColors[key]);
    return normalizeEditorThemeColors(out);
  }

  function setThemeColorForm(nextPrefs = getPreferences()) {
    const colors = normalizeEditorThemeColors(nextPrefs.editorThemeColors || DEFAULT_PREFS.editorThemeColors);
    for (const key of themeColorKeys) {
      const hex = colors[key];
      if (themeColorControls[key]?.input) themeColorControls[key].input.value = hex.slice(1);
      if (themeColorControls[key]?.picker) themeColorControls[key].picker.value = hex;
    }
  }


  function readColorLinksFromDom() {
    const rows = [...(colorLinkRowsEl?.querySelectorAll('[data-color-link-row]') || [])];
    return normalizeColorLinks(rows.map(row => ({
      key: normalizeColorKey(row.querySelector('[data-color-field="key"]')?.value || '', ''),
      shortcutKey: normalizeFnShortcut(row.querySelector('[data-color-field="shortcutKey"]')?.value || '', ''),
      name: row.querySelector('[data-color-field="name"]')?.value || '',
      hex: row.querySelector('[data-color-field="hexPicker"]')?.value || '',
      memo: normalizeColorMemo(row.querySelector('[data-color-field="memo"]')?.value || ''),
    })));
  }

  function readColorForm() {
    return {
      colorLinks: readColorLinksFromDom(),
      colorShortcutIgnoreShift: colorShortcutIgnoreShiftToggle?.checked !== false,
    };
  }

  function setColorForm(nextPrefs = getPreferences(), { selectedIndices = [] } = {}) {
    const links = toolbarOrderedColorLinks(nextPrefs.colorLinks ?? DEFAULT_PREFS.colorLinks);
    if (colorShortcutIgnoreShiftToggle) colorShortcutIgnoreShiftToggle.checked = nextPrefs.colorShortcutIgnoreShift !== false;
    if (colorLinkCountEl) colorLinkCountEl.textContent = `총 색상 수: ${links.length}개`;
    if (colorLinkRowsEl) colorLinkRowsEl.innerHTML = colorLinkRowsHtml(links, selectedIndices);
  }

  function selectedColorLinkIndices() {
    return Array.from(colorLinkRowsEl?.querySelectorAll('[data-color-link-row]') || [])
      .map((row, index) => row.querySelector('[data-color-select]')?.checked ? index : -1)
      .filter(index => index >= 0);
  }

  function syncSelectedColorLinkRows() {
    colorLinkRowsEl?.querySelectorAll('[data-color-link-row]').forEach(row => {
      row.classList.toggle('pref-color-link-row-selected', !!row.querySelector('[data-color-select]')?.checked);
    });
  }

  function syncColorLinkTextButtons(row) {
    if (!row) return;
    const rawName = String(row.querySelector('[data-color-field="name"]')?.value || '').trim();
    const name = rawName || '이름 없음';
    const memo = normalizeColorMemo(row.querySelector('[data-color-field="memo"]')?.value || '');
    const nameButton = row.querySelector('[data-color-action="editName"]');
    const memoButton = row.querySelector('[data-color-action="editMemo"]');
    const keyInput = row.querySelector('[data-color-field="key"]');
    const shortcutInput = row.querySelector('[data-color-field="shortcutKey"]');
    const keyButton = row.querySelector('[data-color-action="editKey"]');
    if (nameButton) {
      nameButton.textContent = name;
      nameButton.title = '이름 편집';
      nameButton.setAttribute('aria-label', `${name} 이름 편집`);
    }
    if (keyButton) {
      const fn = normalizeFnShortcut(shortcutInput?.value || '', '');
      keyButton.textContent = fn || normalizeColorKey(keyInput?.value || '', '') || ' ';
      keyButton.classList.toggle('pref-color-link-fn-shortcut', !!fn);
      keyButton.title = fn ? 'Fn 단축키 편집' : '문자/Fn 편집';
      keyButton.setAttribute('aria-label', `${name} 문자 또는 Fn 단축키 편집`);
    }
    if (memoButton) {
      memoButton.textContent = memo || '메모 없음';
      memoButton.title = '메모 편집';
      memoButton.setAttribute('aria-label', `${name} 메모 편집`);
    }
  }

  function syncColorLinkRow(row) {
    if (!row) return;
    const picker = row.querySelector('[data-color-field="hexPicker"]');
    const swatch = row.querySelector('.pref-color-link-swatch');
    if (picker && swatch) swatch.style.setProperty('--link-color', normalizeHexColor(picker.value, '#FFFFFF'));
  }

  function limitColorMemoInputValue(value) {
    return String(value || '').replace(/\r\n?/g, '\n').split('\n').slice(0, 2).map(line => line.slice(0, 15)).join('\n');
  }

  async function editColorLinkName(row) {
    if (!row) return;
    const input = row.querySelector('[data-color-field="name"]');
    const visibleName = row.querySelector('[data-color-action="editName"]')?.textContent;
    const current = String(visibleName || input?.value || '').trim();
    const wrap = document.createElement('div');
    wrap.className = 'color-link-edit-modal';
    wrap.innerHTML = `
      <label class="color-link-edit-row"><span>색상 이름</span><input type="text" maxlength="5" value="${escapeHtml(current)}" data-initial-focus autocomplete="off"></label>
      <div class="color-link-edit-hint">최대 5자까지 입력할 수 있습니다. 공백 이름은 적용/확인 시 저장할 수 없습니다.</div>
    `;
    const textInput = wrap.querySelector('input');
    const promise = showModal({ title: '색상 이름 편집', body: wrap, buttons: [{ text: '확인', value: 'ok', default: true, shortcutKey: 'y' }, { text: '취소', value: 'cancel', shortcutKey: 'n' }] });
    requestAnimationFrame(() => { try { textInput?.focus({ preventScroll: true }); textInput?.select(); } catch (_) {} });
    textInput?.addEventListener('input', () => { textInput.value = String(textInput.value || '').slice(0, 5); });
    textInput?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        textInput.closest('.modal-window')?.querySelector('.modal-footer button[data-modal-value="ok"]')?.click();
      }
    });
    if (await promise !== 'ok') return;
    const next = String(textInput?.value || '').trim().slice(0, 5);
    if (input) input.value = next;
    syncColorLinkTextButtons(row);
    refreshApplyButton();
  }

  async function editColorLinkMemo(row) {
    if (!row) return;
    const input = row.querySelector('[data-color-field="memo"]');
    const current = normalizeColorMemo(input?.value || '');
    const wrap = document.createElement('div');
    wrap.className = 'color-link-edit-modal color-link-edit-memo-modal';
    wrap.innerHTML = `
      <label class="color-link-edit-row color-link-edit-textarea-row"><span>색상 메모</span><textarea rows="2" data-initial-focus>${escapeHtml(current)}</textarea></label>
      <div class="color-link-edit-hint">최대 2행, 1행 15자까지 입력할 수 있습니다. RGB HEX 값은 툴팁에 자동으로 포함됩니다.</div>
    `;
    const textArea = wrap.querySelector('textarea');
    const promise = showModal({ title: '색상 메모 편집', body: wrap, buttons: [{ text: '확인', value: 'ok', default: true, shortcutKey: 'y' }, { text: '취소', value: 'cancel', shortcutKey: 'n' }] });
    requestAnimationFrame(() => { try { textArea?.focus({ preventScroll: true }); textArea?.select(); } catch (_) {} });
    textArea?.addEventListener('input', () => { textArea.value = limitColorMemoInputValue(textArea.value); });
    if (await promise !== 'ok') return;
    const next = normalizeColorMemo(textArea?.value || '');
    if (input) input.value = next;
    syncColorLinkTextButtons(row);
    refreshApplyButton();
  }


  function normalizeCapturedColorShortcutFromEvent(event) {
    if (!event || event.ctrlKey || event.altKey || event.metaKey) return { type: '', value: '' };
    const fn = !event.shiftKey ? normalizeFnShortcut(event.key || event.code || '', '') : '';
    if (fn) return { type: 'fn', value: fn };
    const key = String(event.key || '');
    if (key.length !== 1 || /\s/u.test(key)) return { type: '', value: '' };
    return { type: 'char', value: normalizeColorKey(key, '0') };
  }

  function colorLinkDefaultShortcutForRow(row) {
    const currentKey = normalizeColorKey(row?.querySelector('[data-color-field="key"]')?.value || '', '');
    return { type: 'char', value: currentKey || '0' };
  }

  function setColorShortcutDraftPreview({ preview, status, draft, message = '' }) {
    if (!preview || !draft) return;
    const fn = draft.type === 'fn' ? normalizeFnShortcut(draft.value, '') : '';
    const value = fn || normalizeColorKey(draft.value, '');
    preview.textContent = value || ' ';
    preview.classList.toggle('pref-color-link-fn-shortcut', !!fn);
    if (status && message) status.textContent = message;
  }

  async function editColorLinkKey(row) {
    if (!row) return;
    const input = row.querySelector('[data-color-field="key"]');
    const shortcutInput = row.querySelector('[data-color-field="shortcutKey"]');
    const currentFn = normalizeFnShortcut(shortcutInput?.value || '', '');
    const currentKey = normalizeColorKey(input?.value || '', '') || ' ';
    const current = currentFn || currentKey;
    const wrap = document.createElement('div');
    wrap.className = 'color-link-key-capture-modal';
    wrap.innerHTML = `
      <div class="color-link-key-capture-main" data-initial-focus tabindex="0">
        <strong>새 색상 문자 또는 F1~F12를 누르세요.</strong>
        <span>일반 문자는 Ctrl+Alt 단축키에 사용됩니다. F1~F12는 단독 Fn 단축키로 사용되며 실제 ÿc 색상코드는 바꾸지 않습니다.</span>
        <kbd class="${currentFn ? 'pref-color-link-fn-shortcut' : ''}">${escapeHtml(current)}</kbd>
      </div>
      <div class="color-link-key-capture-status">단일 비공백 문자 또는 F1~F12만 사용할 수 있습니다. 개발자모드가 켜져 있을 때만 F12는 개발자도구 단축키로 예약됩니다.</div>
    `;
    const status = wrap.querySelector('.color-link-key-capture-status');
    const preview = wrap.querySelector('kbd');
    let captured = currentFn ? { type: 'fn', value: currentFn } : { type: 'char', value: normalizeColorKey(currentKey, '0') };
    const promise = showModal({ title: '색상 문자 지정', body: wrap, buttons: [{ text: '확인', value: 'ok', default: true, shortcutKey: 'y' }, { text: '취소', value: 'cancel', shortcutKey: 'n' }], allowEsc: true, windowClass: 'color-link-key-capture-window' });
    const modalWin = wrap.closest('.modal-window');
    const footer = modalWin?.querySelector('.modal-footer');
    if (footer) {
      const defaultButton = document.createElement('button');
      defaultButton.type = 'button';
      defaultButton.textContent = '기본값';
      defaultButton.dataset.modalLocalDefault = 'true';
      defaultButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        captured = colorLinkDefaultShortcutForRow(row);
        setColorShortcutDraftPreview({ preview, status, draft: captured, message: `기본값 불러옴: ${captured.value}` });
        try { wrap.querySelector('[data-initial-focus]')?.focus({ preventScroll: true }); } catch (_) {}
      });
      footer.insertBefore(defaultButton, footer.firstChild);
    }
    requestAnimationFrame(() => { try { wrap.querySelector('[data-initial-focus]')?.focus({ preventScroll: true }); } catch (_) {} });
    modalWin?.addEventListener('keydown', async (event) => {
      if (event.key === 'Escape' || event.key === 'Tab') return;
      const next = normalizeCapturedColorShortcutFromEvent(event);
      if (!next.value) {
        event.preventDefault();
        event.stopPropagation();
        if (status) status.textContent = '단일 비공백 문자 또는 F1~F12만 사용할 수 있습니다. Ctrl/Alt/Meta 조합은 지정하지 않습니다. 개발자모드가 켜져 있으면 F12는 개발자도구용으로 동작합니다.';
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const rows = Array.from(colorLinkRowsEl?.querySelectorAll('[data-color-link-row]') || []);
      if (next.type === 'char') {
        const duplicate = rows.find(other => other !== row && normalizeColorKey(other.querySelector('[data-color-field="key"]')?.value || '', '')?.toUpperCase() === next.value.toUpperCase());
        if (duplicate) {
          if (preview) preview.textContent = next.value;
          preview?.classList.remove('pref-color-link-fn-shortcut');
          if (status) status.textContent = `이미 다른 색상에서 사용 중인 문자입니다: ${next.value}`;
          await showAlertModal(`이미 다른 색상 단축키와 겹치는 문자입니다.\n\n문자: ${next.value}`, { title: '색상 문자 중복' });
          try { wrap.querySelector('[data-initial-focus]')?.focus({ preventScroll: true }); } catch (_) {}
          return;
        }
      }
      captured = next;
      setColorShortcutDraftPreview({ preview, status, draft: captured, message: `${captured.value} 지정 대기 중입니다. 확인을 누르면 적용됩니다.` });
    }, true);
    const result = await promise;
    if (result !== 'ok' || !captured?.value) return;
    if (captured.type === 'fn') {
      const rows = Array.from(colorLinkRowsEl?.querySelectorAll('[data-color-link-row]') || []);
      for (const other of rows) {
        if (other !== row && normalizeFnShortcut(other.querySelector('[data-color-field="shortcutKey"]')?.value || '', '') === captured.value) {
          const otherInput = other.querySelector('[data-color-field="shortcutKey"]');
          if (otherInput) otherInput.value = '';
          syncColorLinkTextButtons(other);
        }
      }
      if (shortcutInput) shortcutInput.value = captured.value;
    } else {
      if (input) input.value = captured.value;
      if (shortcutInput) shortcutInput.value = '';
    }
    syncColorLinkTextButtons(row);
    refreshApplyButton();
  }




  function nextColorLinkName(links = readColorLinksFromDom()) {
    const used = new Set((links || []).map(item => String(item.name || '').trim()));
    const base = normalizeUiLanguage(getPreferences().uiLanguage) === 'en' ? 'Color' : '색상';
    for (let i = 1; i < 10000; i++) {
      const name = `${base}${i}`;
      if (!used.has(name)) return name;
    }
    return base;
  }

  function scrollColorLinkListToBottom() {
    requestAnimationFrame(() => {
      if (!colorLinkGridEl) return;
      colorLinkGridEl.scrollTop = colorLinkGridEl.scrollHeight;
    });
  }

  function reorderSelectedColorLinks(mode) {
    const links = readColorLinksFromDom();
    const selected = selectedColorLinkIndices();
    if (!selected.length) {
      showAlertModal('순서를 바꿀 색상을 선택해주세요.', { title: '색상 순서 편집' });
      return;
    }
    const selectedSet = new Set(selected);
    let nextLinks = links.slice();
    let nextSelected = selected.slice();
    if (mode === 'top') {
      const chosen = nextLinks.filter((_, index) => selectedSet.has(index));
      const rest = nextLinks.filter((_, index) => !selectedSet.has(index));
      nextLinks = [...chosen, ...rest];
      nextSelected = chosen.map((_, index) => index);
    } else if (mode === 'bottom') {
      const chosen = nextLinks.filter((_, index) => selectedSet.has(index));
      const rest = nextLinks.filter((_, index) => !selectedSet.has(index));
      nextLinks = [...rest, ...chosen];
      nextSelected = chosen.map((_, index) => rest.length + index);
    } else if (mode === 'up') {
      const selectedAfter = new Set(selected);
      for (let i = 1; i < nextLinks.length; i++) {
        if (selectedAfter.has(i) && !selectedAfter.has(i - 1)) {
          [nextLinks[i - 1], nextLinks[i]] = [nextLinks[i], nextLinks[i - 1]];
          selectedAfter.delete(i);
          selectedAfter.add(i - 1);
        }
      }
      nextSelected = Array.from(selectedAfter).sort((a, b) => a - b);
    } else if (mode === 'down') {
      const selectedAfter = new Set(selected);
      for (let i = nextLinks.length - 2; i >= 0; i--) {
        if (selectedAfter.has(i) && !selectedAfter.has(i + 1)) {
          [nextLinks[i + 1], nextLinks[i]] = [nextLinks[i], nextLinks[i + 1]];
          selectedAfter.delete(i);
          selectedAfter.add(i + 1);
        }
      }
      nextSelected = Array.from(selectedAfter).sort((a, b) => a - b);
    } else return;
    setColorForm({ colorLinks: nextLinks, colorShortcutIgnoreShift: colorShortcutIgnoreShiftToggle?.checked !== false }, { selectedIndices: nextSelected });
    refreshApplyButton();
    setStatusMessage('색상 순서 변경');
  }

  function colorSortKey(item) {
    const hex = String(item?.hex || '#FFFFFF').replace(/^#/, '');
    const r = Number.parseInt(hex.slice(0, 2), 16) || 0;
    const g = Number.parseInt(hex.slice(2, 4), 16) || 0;
    const b = Number.parseInt(hex.slice(4, 6), 16) || 0;
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    let s = 0;
    if (d > 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r / 255) h = 60 * (((g - b) / 255 / d) % 6);
      else if (max === g / 255) h = 60 * (((b - r) / 255 / d) + 2);
      else h = 60 * (((r - g) / 255 / d) + 4);
      if (h < 0) h += 360;
    }
    let group = 0;
    if (s < 0.12) group = 0;
    else if (h >= 345 || h < 15) group = 1;
    else if (h < 45) group = 2;
    else if (h < 75) group = 3;
    else if (h < 170) group = 4;
    else if (h < 220) group = 5;
    else if (h < 255) group = 6;
    else if (h < 305) group = 7;
    else group = 8;
    return [group, group === 0 ? -l : h, -s, -l, String(item?.name || '')];
  }

  function compareColorSortKeys(a, b) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i];
      const bv = b[i];
      if (typeof av === 'number' && typeof bv === 'number') {
        if (av !== bv) return av - bv;
      } else {
        const cmp = String(av ?? '').localeCompare(String(bv ?? ''), 'ko-KR', { numeric: true, sensitivity: 'base' });
        if (cmp) return cmp;
      }
    }
    return 0;
  }

  function sortSelectedStateWithLinks(links, selectedIndices, field, descending) {
    const selected = new Set(selectedIndices);
    const rows = links.map((item, index) => ({ item, selected: selected.has(index), index }));
    rows.sort((a, b) => {
      let cmp = 0;
      if (field === 'color') cmp = compareColorSortKeys(colorSortKey(a.item), colorSortKey(b.item));
      else if (field === 'name') cmp = String(a.item?.name || '').localeCompare(String(b.item?.name || ''), 'ko-KR', { numeric: true, sensitivity: 'base' });
      else if (field === 'key') {
        const afn = normalizeFnShortcut(a.item?.shortcutKey, '');
        const bfn = normalizeFnShortcut(b.item?.shortcutKey, '');
        const ak = String(colorShortcutDisplay(a.item) || '').toUpperCase();
        const bk = String(colorShortcutDisplay(b.item) || '').toUpperCase();
        if (afn && !bfn) cmp = -1;
        else if (!afn && bfn) cmp = 1;
        else if (!ak && bk) cmp = 1;
        else if (ak && !bk) cmp = -1;
        else cmp = ak.localeCompare(bk, 'ko-KR', { numeric: true, sensitivity: 'base' });
        if (afn === bfn && cmp && descending) cmp = -cmp;
        if (!cmp) cmp = a.index - b.index;
        return cmp;
      }
      if (!cmp) cmp = a.index - b.index;
      return descending ? -cmp : cmp;
    });
    return {
      colorLinks: rows.map(row => row.item),
      selectedIndices: rows.map((row, index) => row.selected ? index : -1).filter(index => index >= 0),
    };
  }

  function sortColorLinks(field) {
    const links = readColorLinksFromDom();
    const selected = selectedColorLinkIndices();
    const descending = colorLinkSortState.field === field ? !colorLinkSortState.descending : true;
    colorLinkSortState = { field, descending };
    const sorted = sortSelectedStateWithLinks(links, selected, field, descending);
    setColorForm({ colorLinks: sorted.colorLinks, colorShortcutIgnoreShift: colorShortcutIgnoreShiftToggle?.checked !== false }, { selectedIndices: sorted.selectedIndices });
    refreshApplyButton();
    const label = field === 'color' ? '색상순' : field === 'name' ? '이름순' : '문자순';
    setStatusMessage(`${label} ${descending ? '내림차순' : '오름차순'} 정렬`);
  }

  function addColorLinkRow() {
    const links = readColorLinksFromDom();
    links.push({ key: '', shortcutKey: '', code: '', name: nextColorLinkName(links), hex: '#FFFFFF', memo: '' });
    setColorForm({ colorLinks: links, colorShortcutIgnoreShift: colorShortcutIgnoreShiftToggle?.checked !== false });
    scrollColorLinkListToBottom();
    refreshApplyButton();
    setStatusMessage('색상 추가');
  }

  async function deleteSelectedColorLinkRows() {
    const rows = Array.from(colorLinkRowsEl?.querySelectorAll('[data-color-link-row]') || []);
    const selected = rows.filter(row => row.querySelector('[data-color-select]')?.checked);
    if (!selected.length) {
      await showAlertModal('삭제할 색상을 선택해주세요.', { title: '색상 삭제' });
      return;
    }
    const names = selected.map(row => String(row.querySelector('[data-color-field="name"]')?.value || '').trim() || '색상');
    const message = `선택한 색상들을 삭제하시겠습니까?\n\n총 갯수: ${selected.length}개\n대상 색상:\n${names.map(name => `- ${name}`).join('\n')}`;
    if (!await showConfirmModal(message, { title: '색상 삭제' })) return;
    const selectedSet = new Set(selected);
    const kept = rows.filter(row => !selectedSet.has(row)).map(row => ({
      key: normalizeColorKey(row.querySelector('[data-color-field="key"]')?.value || '', ''),
      shortcutKey: normalizeFnShortcut(row.querySelector('[data-color-field="shortcutKey"]')?.value || '', ''),
      name: row.querySelector('[data-color-field="name"]')?.value || '',
      hex: row.querySelector('[data-color-field="hexPicker"]')?.value || '',
      memo: normalizeColorMemo(row.querySelector('[data-color-field="memo"]')?.value || ''),
    }));
    setColorForm({ colorLinks: kept, colorShortcutIgnoreShift: colorShortcutIgnoreShiftToggle?.checked !== false });
    refreshApplyButton();
    setStatusMessage('색상 삭제');
    await showAlertModal('삭제되었습니다.', { title: '색상 삭제' });
  }

  let prefFontRows = [];

  function updateCustomFontModeControls() {
    const mode = customFontModeInput?.value === 'system' ? 'system' : 'path';
    if (customFontPathInput) customFontPathInput.disabled = mode === 'system';
    if (browseCustomFontBtn) browseCustomFontBtn.disabled = mode === 'system';
    if (prefFontPathModeBtn) prefFontPathModeBtn.disabled = mode !== 'system';
    body.querySelector('.pref-custom-font-row')?.classList.toggle('disabled', mode === 'system');
  }

  function updateFallbackFontModeControls() {
    const mode = zeroWidthFallbackFontModeInput?.value === 'system' ? 'system' : 'path';
    if (zeroWidthFallbackFontPathInput) zeroWidthFallbackFontPathInput.disabled = mode === 'system';
    if (browseZeroWidthFallbackFontBtn) browseZeroWidthFallbackFontBtn.disabled = mode === 'system';
    if (zeroWidthFallbackFontPathModeBtn) zeroWidthFallbackFontPathModeBtn.disabled = mode !== 'system';
    body.querySelector('.pref-fallback-font-row')?.classList.toggle('disabled', mode === 'system');
  }

  function updatePrefFontPickerLabel() {
    if (!prefFontPickerLabel) return;
    const source = defaultRenderFontSourceSelect?.value || DEFAULT_PREFS.defaultRendering.fontSource;
    if (source === 'builtin') { prefFontPickerLabel.textContent = BUILTIN_FONT_DISPLAY_NAME; return; }
    if (source === 'builtinFallback') { prefFontPickerLabel.textContent = FALLBACK_FONT_DISPLAY_NAME; return; }
    if (source === 'system') { prefFontPickerLabel.textContent = '맑은 고딕'; return; }
    const path = normalizePathText(customFontPathInput?.value || '', '');
    const file = fontFileNameFromPath(path);
    const row = prefFontRows.find(r => normalizePathText(r.path || '', '').toLowerCase() === path.toLowerCase() && r.aliasRole !== 'fallback');
    prefFontPickerLabel.textContent = row ? prefFontLabel(row) : (file ? `${file} (대표 글꼴)` : '대표 글꼴 선택');
  }

  function updateFallbackFontPickerLabel() {
    if (!zeroWidthFallbackFontPickerLabel) return;
    const source = zeroWidthFallbackFontSourceInput?.value || DEFAULT_PREFS.zeroWidthFallbackFontSource;
    if (source === 'builtin') { zeroWidthFallbackFontPickerLabel.textContent = BUILTIN_FONT_DISPLAY_NAME; return; }
    if (source === 'builtinFallback') { zeroWidthFallbackFontPickerLabel.textContent = FALLBACK_FONT_DISPLAY_NAME; return; }
    const family = normalizePathText(zeroWidthFallbackFontFamilyInput?.value || '', DEFAULT_PREFS.zeroWidthFallbackFontFamily) || DEFAULT_PREFS.zeroWidthFallbackFontFamily;
    const path = normalizePathText(zeroWidthFallbackFontPathInput?.value || '', '');
    const lowerPath = path.toLowerCase();
    const aliasRow = prefFontRows.find(r => r.aliasRole === 'fallback' && ((lowerPath && normalizePathText(r.path || '', '').toLowerCase() === lowerPath) || getFontCssFamily(r) === family || r.familyName === family));
    const row = aliasRow || prefFontRows.find(r => getFontSource(r) === source && (getFontCssFamily(r) === family || r.familyName === family || prefFontLabel(r) === family));
    zeroWidthFallbackFontPickerLabel.textContent = row ? prefFontLabel(row) : (path ? `${fontFileNameFromPath(path)} (대체 글꼴)` : family);
  }

  function markCustomFontSelected(mode = 'path') {
    if (defaultRenderFontSourceSelect) defaultRenderFontSourceSelect.value = 'custom';
    if (customFontModeInput) customFontModeInput.value = mode === 'system' ? 'system' : 'path';
  }

  function markFallbackFontSelected(row = null, mode = 'system') {
    if (zeroWidthFallbackFontModeInput) zeroWidthFallbackFontModeInput.value = mode === 'path' ? 'path' : 'system';
    if (!row) return;
    const source = getFontSource(row);
    if (source === 'builtin' || source === 'builtinFallback') {
      if (zeroWidthFallbackFontSourceInput) zeroWidthFallbackFontSourceInput.value = source;
      if (zeroWidthFallbackFontFamilyInput) zeroWidthFallbackFontFamilyInput.value = fontCssFamilyForUse(row) || getFontCssFamily(row) || DEFAULT_PREFS.zeroWidthFallbackFontFamily;
      if (zeroWidthFallbackFontPathInput) zeroWidthFallbackFontPathInput.value = '';
      return;
    }
    const path = normalizePathText(row.path || '', '');
    if (path) {
      const aliasEntry = makeFontEntry({ source: 'custom', path, fileName: row.fileName || fontFileNameFromPath(path), familyName: row.familyName || row.fileName || '글꼴', aliasRole: 'fallback' });
      if (zeroWidthFallbackFontSourceInput) zeroWidthFallbackFontSourceInput.value = 'custom';
      if (zeroWidthFallbackFontFamilyInput) zeroWidthFallbackFontFamilyInput.value = fontCssFamilyForUse(aliasEntry) || getFontCssFamily(aliasEntry) || DEFAULT_PREFS.zeroWidthFallbackFontFamily;
      if (zeroWidthFallbackFontPathInput) zeroWidthFallbackFontPathInput.value = path;
      return;
    }
    if (zeroWidthFallbackFontSourceInput) zeroWidthFallbackFontSourceInput.value = source;
    if (zeroWidthFallbackFontFamilyInput) zeroWidthFallbackFontFamilyInput.value = fontCssFamilyForUse(row) || getFontCssFamily(row) || DEFAULT_PREFS.zeroWidthFallbackFontFamily;
    if (zeroWidthFallbackFontPathInput) zeroWidthFallbackFontPathInput.value = '';
  }

  function markFallbackFontPathMode(path = zeroWidthFallbackFontPathInput?.value || '') {
    const cleanPath = normalizePathText(path, '');
    const file = fontFileNameFromPath(cleanPath);
    if (zeroWidthFallbackFontModeInput) zeroWidthFallbackFontModeInput.value = 'path';
    if (zeroWidthFallbackFontSourceInput) zeroWidthFallbackFontSourceInput.value = cleanPath ? 'custom' : DEFAULT_PREFS.zeroWidthFallbackFontSource;
    if (zeroWidthFallbackFontFamilyInput) {
      zeroWidthFallbackFontFamilyInput.value = cleanPath
        ? fontCssFamilyForUse(makeFontEntry({ source: 'custom', path: cleanPath, fileName: file, familyName: file.replace(/\.(ttf|otf|ttc)$/i, ''), aliasRole: 'fallback' }))
        : DEFAULT_PREFS.zeroWidthFallbackFontFamily;
    }
  }

  function favoriteSetFromPrefs() { return favoriteSetFromPreferences(getPreferences()); }
  function rowSearchText(row = {}) { return `${row.familyName || ''} ${row.fileName || ''} ${row.path || ''} ${row.displayName || ''} ${prefFontLabel(row) || ''}`.toLowerCase(); }
  function appendFontRowButton(list, row, { onClick, showStar = true } = {}) {
    const favs = favoriteSetFromPrefs();
    const id = fontRowId(row);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `render-font-row pref-font-row pref-font-row-no-sample${row.isCustomAlias ? ' custom-font-alias-row' : ''}`;
    btn.dataset.fontPath = row.path || '';
    const star = document.createElement('span');
    const canFav = row.source === 'system' && prefFontLabel(row) !== '맑은 고딕';
    star.className = `render-font-star${canFav && favs.has(id) ? ' active' : ''}${canFav && showStar ? '' : ' placeholder'}`;
    star.textContent = canFav && showStar ? (favs.has(id) ? '★' : '☆') : '';
    star.title = canFav && showStar ? '즐겨찾기 글꼴' : '';
    const name = document.createElement('span');
    name.className = 'render-font-name';
    name.textContent = prefFontLabel(row);
    btn.append(star, name);
    if (canFav && showStar) {
      star.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        const set = favoriteSetFromPrefs();
        if (set.has(id)) set.delete(id); else set.add(id);
        setPreferences({ renderingFavoriteFonts: Array.from(set) });
        renderPrefFontRows(prefFontSearchInput?.value || '');
        renderFallbackFontRows(zeroWidthFallbackFontSearchInput?.value || '');
      });
    }
    btn.addEventListener('click', () => onClick?.(row));
    list.appendChild(btn);
  }

  function renderPrefFontRows(filter = '') {
    if (!prefFontList) return;
    const q = String(filter || '').trim().toLowerCase();
    const rows = prefFontRows.filter(row => row.source !== 'separator' && (!q || rowSearchText(row).includes(q)));
    prefFontPickerStatus.textContent = rows.length ? `${rows.length}개 글꼴` : '표시할 글꼴 없음';
    prefFontList.innerHTML = '';
    for (const row of rows) {
      appendFontRowButton(prefFontList, row, { onClick: (selected) => {
        const source = getFontSource(selected);
        if (source === 'builtin' || source === 'builtinFallback') {
          if (defaultRenderFontSourceSelect) defaultRenderFontSourceSelect.value = source;
          if (customFontPathInput) customFontPathInput.value = '';
          if (customFontModeInput) customFontModeInput.value = 'path';
        } else {
          markCustomFontSelected('system');
          if (customFontPathInput) customFontPathInput.value = selected.path || '';
        }
        updateCustomFontModeControls();
        updatePrefFontPickerLabel();
        if (prefFontPickerPanel) prefFontPickerPanel.hidden = true;
        refreshApplyButton();
        setStatusMessage('대표 글꼴 선택됨');
      }});
    }
  }

  function renderFallbackFontRows(filter = '') {
    if (!zeroWidthFallbackFontList) return;
    const q = String(filter || '').trim().toLowerCase();
    const rows = prefFontRows.filter(row => row.source !== 'separator' && (!q || rowSearchText(row).includes(q)));
    if (zeroWidthFallbackFontPickerStatus) zeroWidthFallbackFontPickerStatus.textContent = rows.length ? `${rows.length}개 글꼴` : '표시할 글꼴 없음';
    zeroWidthFallbackFontList.innerHTML = '';
    for (const row of rows) {
      appendFontRowButton(zeroWidthFallbackFontList, row, { onClick: (selected) => {
        markFallbackFontSelected(selected, selected.source === 'custom' ? 'path' : 'system');
        updateFallbackFontModeControls();
        updateFallbackFontPickerLabel();
        if (zeroWidthFallbackFontPickerPanel) zeroWidthFallbackFontPickerPanel.hidden = true;
        refreshApplyButton();
        setStatusMessage('대체 글꼴 선택됨');
      }});
    }
  }

  function parentDirectoryOf(path = '') {
    const text = String(path || '');
    const idx = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
    return idx > 0 ? text.slice(0, idx) : '';
  }

  async function defaultFontBrowseDirectory(pathInput = customFontPathInput) {
    const current = parentDirectoryOf(pathInput?.value || '');
    try {
      const userDir = await getUserFontDirectory();
      if (userDir && (!current || /\\Windows\\Fonts$/i.test(current))) return userDir;
    } catch (_) {}
    if (current) return current;
    return getPreferences().defaultSaveDirectory || '';
  }

  function positionPrefFontPanel(panel = prefFontPickerPanel, button = prefFontPickerButton) {
    if (!panel || !button) return;
    const win = body.closest('.floating-window, .modal-window') || body;
    const wr = win.getBoundingClientRect();
    const br = button.getBoundingClientRect();
    const margin = 14;
    const available = Math.max(360, window.innerWidth - margin * 2);
    const width = Math.min(860, Math.max(760, available));
    let left = Math.max(margin, Math.min(wr.left + margin, window.innerWidth - width - margin));
    let top = br.bottom + 6;
    let maxHeight = window.innerHeight - top - margin;
    const minHeight = 240;
    if (maxHeight < minHeight && br.top > window.innerHeight - br.bottom) {
      maxHeight = Math.max(minHeight, br.top - margin * 2);
      top = Math.max(margin, br.top - maxHeight - 6);
    }
    panel.style.position = 'fixed';
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.width = `${width}px`;
    const finalMaxHeight = Math.max(minHeight, maxHeight);
    panel.style.maxHeight = `${finalMaxHeight}px`;
    panel.style.setProperty('--pref-font-panel-max-height', `${finalMaxHeight}px`);
  }

  async function loadPrefFontRows() {
    if (!prefFontList && !zeroWidthFallbackFontList) return;
    if (prefFontPickerStatus) prefFontPickerStatus.textContent = '시스템 글꼴 목록을 불러오는 중...';
    if (zeroWidthFallbackFontPickerStatus) zeroWidthFallbackFontPickerStatus.textContent = '시스템 글꼴 목록을 불러오는 중...';
    try {
      const basePrefs = {
        ...getPreferences(),
        defaultRendering: { ...getPreferences().defaultRendering, fontPath: customFontPathInput?.value || getPreferences().defaultRendering?.fontPath || '' },
        zeroWidthFallbackFontPath: zeroWidthFallbackFontPathInput?.value || getPreferences().zeroWidthFallbackFontPath || '',
      };
      prefFontRows = await buildFontEntries({ prefs: basePrefs, includeCustom: true });
      renderPrefFontRows(prefFontSearchInput?.value || '');
      renderFallbackFontRows(zeroWidthFallbackFontSearchInput?.value || '');
      updatePrefFontPickerLabel();
      updateFallbackFontPickerLabel();
    } catch (err) {
      prefFontRows = [];
      if (prefFontPickerStatus) prefFontPickerStatus.textContent = '시스템 글꼴 목록 조회 실패';
      if (zeroWidthFallbackFontPickerStatus) zeroWidthFallbackFontPickerStatus.textContent = '시스템 글꼴 목록 조회 실패';
      setErrorMessage('글꼴 목록 조회 실패: ' + String(err));
    }
  }

  function readOpacityPercent() {
    const parsed = Number.parseInt(sanitizeDigits(opacityInput.value), 10);
    const value = Number.isFinite(parsed) ? parsed : Math.round(DEFAULT_PREFS.inactiveFloatingOpacity * 100);
    return Math.max(10, Math.min(100, value));
  }

  function readGeneralForm() {
    return {
      recentLimit: Math.max(0, Math.min(10, Number.parseInt(sanitizeDigits(recentInput?.value), 10) || 0)),
      undoHistoryLimit: normalizeUndoHistoryLimit(undoHistoryLimitInput?.value),
      searchHistoryLimit: Math.max(0, Math.min(10, Number.parseInt(sanitizeDigits(searchHistoryLimitInput?.value), 10) || 0)),
      toolbarFontSizePt: normalizeToolbarFontSizePt(toolbarFontSizePtInput?.value),
      colorPreviewSizePx: normalizeColorPreviewSizePx(colorPreviewSizePxInput?.value),
      toolbarRowHeightPx: normalizeToolbarRowHeightPx(toolbarRowHeightPxInput?.value),
      defaultLayoutMode: normalizeLayoutMode(defaultLayoutModeSelect?.value || DEFAULT_PREFS.defaultLayoutMode),
      jsonKeyExtractLanguage: normalizeJsonKeyExtractLanguage(jsonKeyExtractLanguageSelect?.value || DEFAULT_PREFS.jsonKeyExtractLanguage),
      startMaximized: !!startMaximizedToggle?.checked,
      systemTrayEnabled: systemTrayEnabledToggle?.checked !== false,
      windowsShellTxtContextMenu: windowsShellTxtContextMenuToggle?.checked !== false,
      inactiveFloatingOpacity: readOpacityPercent() / 100,
    };
  }

  function readSaveForm() {
    return {
      defaultSaveDirectory: normalizePathText(defaultSaveDirectoryInput?.value, DEFAULT_PREFS.defaultSaveDirectory),
      restoreOpenDocuments: !!restoreOpenDocumentsToggle?.checked,
      saveDisplaySettingsInFile: saveDisplaySettingsToggle?.checked !== false,
      showTabSaveWarning: showTabSaveWarningToggle?.checked !== false,
      showZeroWidthSaveWarning: showZeroWidthSaveWarningToggle?.checked !== false,
      newDocumentBaseName: normalizeNewDocumentBaseName(newDocumentBaseNameInput?.value),
      newDocumentSequenceDigits: normalizeSequenceDigits(newDocumentSequenceDigitsSelect?.value),
    };
  }


  function readRenderingForm() {
    const fontSource = ['builtin', 'builtinFallback', 'system', 'custom'].includes(defaultRenderFontSourceSelect?.value) ? defaultRenderFontSourceSelect.value : DEFAULT_PREFS.defaultRendering.fontSource;
    const fontPath = normalizePathText(customFontPathInput?.value || '', '');
    const customFile = fontFileNameFromPath(fontPath);
    const fallbackPath = normalizePathText(zeroWidthFallbackFontPathInput?.value || '', '');
    const fallbackFile = fontFileNameFromPath(fallbackPath);
    const fallbackSource = ['builtin', 'builtinFallback', 'system', 'custom'].includes(zeroWidthFallbackFontSourceInput?.value) ? zeroWidthFallbackFontSourceInput.value : DEFAULT_PREFS.zeroWidthFallbackFontSource;
    const fallbackFamily = normalizePathText(zeroWidthFallbackFontFamilyInput?.value, DEFAULT_PREFS.zeroWidthFallbackFontFamily) || DEFAULT_PREFS.zeroWidthFallbackFontFamily;
    return {
      customFontSelectionMode: fontSource === 'custom' && customFontModeInput?.value === 'system' ? 'system' : 'path',
      zeroWidthFallbackEnabled: getPreferences().zeroWidthFallbackEnabled !== false,
      zeroWidthFallbackFontSource: (fallbackSource === 'builtin' || fallbackSource === 'builtinFallback') ? fallbackSource : (fallbackPath ? 'custom' : fallbackSource),
      zeroWidthFallbackFontFamily: fallbackFamily,
      zeroWidthFallbackFontPath: (fallbackSource === 'builtin' || fallbackSource === 'builtinFallback') ? '' : fallbackPath,
      zeroWidthFallbackFontFileName: fallbackPath ? fallbackFile : (fallbackSource === 'builtinFallback' ? FALLBACK_FONT_FILE_NAME : ''),
      zeroWidthFallbackFontSelectionMode: zeroWidthFallbackFontModeInput?.value === 'system' ? 'system' : 'path',
      zeroWidthFallbackFontSizePt: normalizePtInput(zeroWidthFallbackFontSizePtInput?.value, 6, 999, DEFAULT_PREFS.zeroWidthFallbackFontSizePt),
      zeroWidthFallbackLineHeightPt: normalizePtInput(zeroWidthFallbackLineHeightPtInput?.value, 6, 2000, DEFAULT_PREFS.zeroWidthFallbackLineHeightPt),
      lineNumberFontSizePx: normalizeLineNumberFontSizePx(lineNumberFontSizePxInput?.value),
      lineNumberGutterWidthPx: normalizeLineNumberGutterWidthPx(lineNumberGutterWidthPxInput?.value),
      defaultRendering: normalizeRenderingPreferences({
        fontSource,
        fontFamily: fontSource === 'builtin' ? BUILTIN_FONT_CSS_FAMILY : fontSource === 'builtinFallback' ? FALLBACK_FONT_CSS_FAMILY : fontSource === 'custom' ? getFontCssFamily(makeFontEntry({ source: 'custom', path: fontPath, fileName: customFile, familyName: customFile.replace(/\.(ttf|otf|ttc)$/i, '') })) : 'Malgun Gothic',
        fontPath: fontSource === 'custom' ? fontPath : '',
        fontFileName: fontSource === 'custom' ? customFile : '',
        fontSizePt: normalizePtInput(defaultFontSizePtInput?.value, 6, 999, DEFAULT_PREFS.defaultRendering.fontSizePt),
        lineHeightPt: normalizePtInput(defaultLineHeightSizePtInput?.value, 6, 2000, DEFAULT_PREFS.defaultRendering.lineHeightPt),
        textAlign: ['left', 'center', 'right'].includes(defaultTextAlignSelect?.value) ? defaultTextAlignSelect.value : DEFAULT_PREFS.defaultRendering.textAlign,
        tabWidth: Math.round(clampNumber(Number.parseInt(sanitizeDigits(defaultTabWidthInput?.value), 10), 1, 32, DEFAULT_PREFS.defaultRendering.tabWidth)),
      }),
    };
  }

  function readThemeForm() {
    return {
      themeMode: normalizeThemeMode(themeModeSelect?.value || DEFAULT_PREFS.themeMode),
      editorThemeColors: readThemeColorForm(),
    };
  }


  async function prepareRenderingFontCacheInputs() {
    let changed = false;
    if (defaultRenderFontSourceSelect?.value === 'custom' && customFontModeInput?.value !== 'system' && customFontPathInput?.value) {
      const before = normalizePathText(customFontPathInput.value, '');
      const after = await cacheFontPathForRole(before, 'primary');
      if (after && after !== before) {
        customFontPathInput.value = after;
        changed = true;
      }
    }
    const fallbackPath = normalizePathText(zeroWidthFallbackFontPathInput?.value || '', '');
    if (fallbackPath && zeroWidthFallbackFontModeInput?.value !== 'system' && zeroWidthFallbackFontSourceInput?.value !== 'builtin' && zeroWidthFallbackFontSourceInput?.value !== 'builtinFallback') {
      const after = await cacheFontPathForRole(fallbackPath, 'fallback');
      if (after && after !== fallbackPath) {
        zeroWidthFallbackFontPathInput.value = after;
        markFallbackFontPathMode(after);
        changed = true;
      }
    }
    if (changed) {
      updatePrefFontPickerLabel();
      updateFallbackFontPickerLabel();
      void loadPrefFontRows();
    }
  }

  function setGeneralForm(nextPrefs = getPreferences()) {
    recentInput.value = String(Math.max(0, Math.min(10, Number(nextPrefs.recentLimit) || 0)));
    if (undoHistoryLimitInput) undoHistoryLimitInput.value = String(normalizeUndoHistoryLimit(nextPrefs.undoHistoryLimit));
    searchHistoryLimitInput.value = String(Math.max(0, Math.min(10, Number(nextPrefs.searchHistoryLimit) || 0)));
    if (toolbarFontSizePtInput) toolbarFontSizePtInput.value = String(normalizeToolbarFontSizePt(nextPrefs.toolbarFontSizePt));
    if (colorPreviewSizePxInput) colorPreviewSizePxInput.value = colorPreviewSizeText(nextPrefs.colorPreviewSizePx);
    if (toolbarRowHeightPxInput) toolbarRowHeightPxInput.value = String(normalizeToolbarRowHeightPx(nextPrefs.toolbarRowHeightPx));
    if (defaultLayoutModeSelect) {
      const mode = normalizeLayoutMode(nextPrefs.defaultLayoutMode || DEFAULT_PREFS.defaultLayoutMode);
      defaultLayoutModeSelect.innerHTML = layoutOptionsHtml(mode);
      defaultLayoutModeSelect.value = mode;
    }
    if (jsonKeyExtractLanguageSelect) {
      const language = normalizeJsonKeyExtractLanguage(nextPrefs.jsonKeyExtractLanguage || DEFAULT_PREFS.jsonKeyExtractLanguage);
      jsonKeyExtractLanguageSelect.innerHTML = jsonKeyExtractLanguageOptionsHtml({ selected: language, defaultLanguage: language });
      jsonKeyExtractLanguageSelect.value = language;
    }
    if (startMaximizedToggle) startMaximizedToggle.checked = nextPrefs.startMaximized !== false;
    if (systemTrayEnabledToggle) systemTrayEnabledToggle.checked = nextPrefs.systemTrayEnabled !== false;
    if (windowsShellTxtContextMenuToggle) windowsShellTxtContextMenuToggle.checked = nextPrefs.windowsShellTxtContextMenu !== false;
    const pct = Math.round(normalizeOpacity(nextPrefs.inactiveFloatingOpacity) * 100);
    opacitySlider.value = String(pct);
    opacityInput.value = String(pct);
  }

  function setSaveForm(nextPrefs = getPreferences()) {
    if (defaultSaveDirectoryInput) defaultSaveDirectoryInput.value = normalizePathText(nextPrefs.defaultSaveDirectory, DEFAULT_PREFS.defaultSaveDirectory);
    if (newDocumentBaseNameInput) newDocumentBaseNameInput.value = displayNewDocumentBaseName(nextPrefs.newDocumentBaseName);
    if (newDocumentSequenceDigitsSelect) newDocumentSequenceDigitsSelect.value = String(normalizeSequenceDigits(nextPrefs.newDocumentSequenceDigits));
    if (restoreOpenDocumentsToggle) restoreOpenDocumentsToggle.checked = nextPrefs.restoreOpenDocuments !== false;
    if (saveDisplaySettingsToggle) saveDisplaySettingsToggle.checked = nextPrefs.saveDisplaySettingsInFile !== false;
    if (showTabSaveWarningToggle) showTabSaveWarningToggle.checked = nextPrefs.showTabSaveWarning !== false;
    if (showZeroWidthSaveWarningToggle) showZeroWidthSaveWarningToggle.checked = nextPrefs.showZeroWidthSaveWarning !== false;
    updateSaveExample();
  }


  function setRenderingForm(nextPrefs = getPreferences()) {
    const rendering = normalizeRenderingPreferences(nextPrefs.defaultRendering || DEFAULT_PREFS.defaultRendering);
    if (defaultRenderFontSourceSelect) defaultRenderFontSourceSelect.value = rendering.fontSource;
    if (customFontPathInput) customFontPathInput.value = rendering.fontPath || '';
    if (customFontModeInput) customFontModeInput.value = rendering.fontSource === 'custom' && nextPrefs.customFontSelectionMode === 'system' ? 'system' : 'path';
    updateCustomFontModeControls();
    updatePrefFontPickerLabel();
    if (defaultFontSizePtInput) defaultFontSizePtInput.value = String(Math.round(rendering.fontSizePt));
    if (defaultLineHeightSizePtInput) defaultLineHeightSizePtInput.value = String(Math.round(rendering.lineHeightPt));
    if (defaultTextAlignSelect) defaultTextAlignSelect.value = rendering.textAlign;
    if (defaultTabWidthInput) defaultTabWidthInput.value = String(rendering.tabWidth);
    if (lineNumberFontSizePxInput) lineNumberFontSizePxInput.value = String(normalizeLineNumberFontSizePx(nextPrefs.lineNumberFontSizePx));
    if (lineNumberGutterWidthPxInput) lineNumberGutterWidthPxInput.value = String(normalizeLineNumberGutterWidthPx(nextPrefs.lineNumberGutterWidthPx));
    if (zeroWidthFallbackFontFamilyInput) zeroWidthFallbackFontFamilyInput.value = normalizePathText(nextPrefs.zeroWidthFallbackFontFamily, DEFAULT_PREFS.zeroWidthFallbackFontFamily) || DEFAULT_PREFS.zeroWidthFallbackFontFamily;
    if (zeroWidthFallbackFontSourceInput) zeroWidthFallbackFontSourceInput.value = ['builtin', 'builtinFallback', 'system', 'custom'].includes(nextPrefs.zeroWidthFallbackFontSource) ? nextPrefs.zeroWidthFallbackFontSource : DEFAULT_PREFS.zeroWidthFallbackFontSource;
    if (zeroWidthFallbackFontPathInput) zeroWidthFallbackFontPathInput.value = normalizePathText(nextPrefs.zeroWidthFallbackFontPath, '');
    if (zeroWidthFallbackFontModeInput) zeroWidthFallbackFontModeInput.value = nextPrefs.zeroWidthFallbackFontSelectionMode === 'system' ? 'system' : 'path';
    if (zeroWidthFallbackFontSizePtInput) zeroWidthFallbackFontSizePtInput.value = String(Math.round(normalizePtInput(nextPrefs.zeroWidthFallbackFontSizePt, 6, 999, DEFAULT_PREFS.zeroWidthFallbackFontSizePt)));
    if (zeroWidthFallbackLineHeightPtInput) zeroWidthFallbackLineHeightPtInput.value = String(Math.round(normalizePtInput(nextPrefs.zeroWidthFallbackLineHeightPt, 6, 2000, DEFAULT_PREFS.zeroWidthFallbackLineHeightPt)));
    updateFallbackFontModeControls();
    updateFallbackFontPickerLabel();
  }

  function updateSaveExample() {
    if (!newDocumentNameExampleEl) return;
    newDocumentNameExampleEl.textContent = `예시명 : ${newDocumentNameExample(newDocumentBaseNameInput?.value, newDocumentSequenceDigitsSelect?.value)}`;
  }

  function updateMaintenanceButtons() {
    clearRecentBtn.disabled = getRecentDocuments().length <= 0;
    clearSearchBtn.disabled = getSearchHistory().length <= 0;
  }

  function categoryState(category = activeCategory) {
    if (category === 'general') return JSON.stringify(readGeneralForm());
    if (category === 'save') return JSON.stringify(readSaveForm());
    if (category === 'theme') return JSON.stringify(readThemeForm());
    if (category === 'rendering') return JSON.stringify(readRenderingForm());
    if (category === 'color') return JSON.stringify(readColorForm());
    return '{}';
  }

  function refreshApplyButton() {
    applyButton.disabled = categoryState(activeCategory) === lastApplied[activeCategory];
  }

  function previewOpacityFromForm() {
    const pct = readOpacityPercent();
    opacitySlider.value = String(pct);
    opacityInput.value = String(pct);
    setFloatingInactiveOpacity(pct / 100);
  }

  function selectCategory(category) {
    activeCategory = category;
    body.querySelectorAll('.pref-category').forEach(btn => btn.classList.toggle('selected', btn.dataset.category === category));
    body.querySelectorAll('.pref-category-panel').forEach(panel => { panel.hidden = panel.dataset.category !== category; });
    refreshApplyButton();
  }

  lastApplied.general = categoryState('general');
  lastApplied.save = categoryState('save');
  lastApplied.theme = categoryState('theme');
  lastApplied.rendering = categoryState('rendering');
  lastApplied.color = categoryState('color');

  function closePreferencesWindow() {
    hidePrefInstantTooltip();
    const win = prefWindow;
    prefWindow = null;
    win?.querySelector?.('.modal-close-button')?.click();
  }

  function applyGeneralCategory({ silent = false } = {}) {
    const values = readGeneralForm();
    setGeneralForm(values);
    setPreferences(values);
    if (values.recentLimit === 0) clearRecentDocuments();
    onApply?.();
    updateMaintenanceButtons();
    lastApplied.general = categoryState('general');
    if (!silent) setStatusMessage('일반 환경설정 적용됨');
  }

  function applySaveCategory({ silent = false } = {}) {
    const values = readSaveForm();
    setSaveForm(values);
    setPreferences(values);
    onApply?.();
    lastApplied.save = categoryState('save');
    if (!silent) setStatusMessage('저장 환경설정 적용됨');
  }

  function applyThemeCategory({ silent = false } = {}) {
    const values = readThemeForm();
    setThemeColorForm({ ...getPreferences(), ...values });
    setPreferences(values);
    onApply?.();
    lastApplied.theme = categoryState('theme');
    if (!silent) setStatusMessage('테마 환경설정 적용됨');
  }

  async function applyRenderingCategory({ silent = false } = {}) {
    try {
      await prepareRenderingFontCacheInputs();
    } catch (err) {
      setErrorMessage('사용자 글꼴 캐시 저장 실패: ' + String(err));
      return false;
    }
    const values = readRenderingForm();
    setRenderingForm({ ...getPreferences(), ...values });
    setPreferences(values);
    onApply?.();
    lastApplied.rendering = categoryState('rendering');
    if (!silent) setStatusMessage('편집창 환경설정 적용됨');
    return true;
  }


  async function validateColorLinkNames() {
    const rows = Array.from(colorLinkRowsEl?.querySelectorAll('[data-color-link-row]') || []);
    const invalid = rows.find(row => !String(row.querySelector('[data-color-field="name"]')?.value || '').trim());
    if (!invalid) return true;
    selectCategory('color');
    invalid.classList.add('pref-color-link-row-error');
    invalid.scrollIntoView?.({ block: 'nearest' });
    await showAlertModal('색상 이름은 공백일 수 없습니다.', { title: '색상연결' });
    invalid.querySelector('[data-color-action="editName"]')?.focus({ preventScroll: true });
    return false;
  }

  async function applyColorCategory({ silent = false } = {}) {
    if (!await validateColorLinkNames()) return false;
    const values = readColorForm();
    setColorForm(values);
    setPreferences(values);
    onApply?.();
    lastApplied.color = categoryState('color');
    if (!silent) setStatusMessage('색상연결 환경설정 적용됨');
    return true;
  }

  async function applyActiveCategory() {
    if (activeCategory === 'general') applyGeneralCategory();
    else if (activeCategory === 'save') applySaveCategory();
    else if (activeCategory === 'theme') applyThemeCategory();
    else if (activeCategory === 'rendering' && !await applyRenderingCategory()) return;
    else if (activeCategory === 'color' && !await applyColorCategory()) return;
    refreshApplyButton();
  }

  async function applyAllCategoriesAndClose() {
    if (!await validateColorLinkNames()) return;
    applyGeneralCategory({ silent: true });
    applySaveCategory({ silent: true });
    applyThemeCategory({ silent: true });
    if (!await applyRenderingCategory({ silent: true })) return;
    if (!await applyColorCategory({ silent: true })) return;
    await persistSettings();
    refreshApplyButton();
    setStatusMessage('환경설정 적용 완료');
    closePreferencesWindow();
  }

  function resetActiveCategoryToSaved() {
    if (activeCategory === 'general') {
      setGeneralForm(getPreferences());
      applyPreferencesToRuntime();
      setStatusMessage('일반 설정 변경 취소');
    } else if (activeCategory === 'save') {
      setSaveForm(getPreferences());
      setStatusMessage('저장 설정 변경 취소');
    } else if (activeCategory === 'theme') {
      if (themeModeSelect) themeModeSelect.value = normalizeThemeMode(getPreferences().themeMode || DEFAULT_PREFS.themeMode);
      setThemeColorForm(getPreferences());
      applyPreferencesToRuntime();
      setStatusMessage('테마 설정 변경 취소');
    } else if (activeCategory === 'rendering') {
      setRenderingForm(getPreferences());
      applyPreferencesToRuntime();
      setStatusMessage('편집창 설정 변경 취소');
    } else if (activeCategory === 'color') {
      setColorForm(getPreferences());
      setStatusMessage('색상연결 설정 변경 취소');
    }
    refreshApplyButton();
  }

  async function resetActiveCategoryToDefault() {
    if (activeCategory === 'general') {
      setGeneralForm(DEFAULT_PREFS);
      previewOpacityFromForm();
      setStatusMessage('일반 설정 기본값 불러옴');
    } else if (activeCategory === 'save') {
      const dir = await resolveSystemDefaultSaveDirectory();
      setSaveForm({ ...DEFAULT_PREFS, defaultSaveDirectory: dir });
      setStatusMessage('저장 설정 기본값 불러옴');
    } else if (activeCategory === 'theme') {
      if (themeModeSelect) themeModeSelect.value = normalizeThemeMode(DEFAULT_PREFS.themeMode);
      setThemeColorForm(DEFAULT_PREFS);
      setStatusMessage('테마 설정 기본값 불러옴');
    } else if (activeCategory === 'rendering') {
      setRenderingForm(DEFAULT_PREFS);
      setStatusMessage('편집창 설정 기본값 불러옴');
    } else if (activeCategory === 'color') {
      setColorForm(DEFAULT_PREFS);
      setStatusMessage('색상연결 기본값 불러옴');
    }
    refreshApplyButton();
  }

  opacitySlider.addEventListener('input', () => {
    opacityInput.value = opacitySlider.value;
    previewOpacityFromForm();
    refreshApplyButton();
  });
  opacityInput.addEventListener('input', () => {
    previewOpacityFromForm();
    refreshApplyButton();
  });
  attachPreferenceNumberHint(opacityInput);
  opacityInput.addEventListener('blur', () => {
    hideNumberHint(opacityInput);
    opacityInput.value = String(readOpacityPercent());
    opacitySlider.value = opacityInput.value;
  });
  recentInput.addEventListener('input', refreshApplyButton);
  undoHistoryLimitInput?.addEventListener('input', refreshApplyButton);
  searchHistoryLimitInput.addEventListener('input', refreshApplyButton);
  toolbarFontSizePtInput?.addEventListener('input', () => { applyToolbarFontSizeToDom(toolbarFontSizePtInput.value); refreshApplyButton(); });
  colorPreviewSizePxInput?.addEventListener('input', () => { applyColorPreviewSizeToDom(colorPreviewSizePxInput.value); refreshApplyButton(); });
  toolbarRowHeightPxInput?.addEventListener('input', () => { applyToolbarRowHeightToDom(toolbarRowHeightPxInput.value); refreshApplyButton(); });
  startMaximizedToggle?.addEventListener('change', refreshApplyButton);
  systemTrayEnabledToggle?.addEventListener('change', refreshApplyButton);
  windowsShellTxtContextMenuToggle?.addEventListener('change', refreshApplyButton);
  defaultSaveDirectoryInput?.addEventListener('input', refreshApplyButton);
  restoreOpenDocumentsToggle?.addEventListener('change', refreshApplyButton);
  saveDisplaySettingsToggle?.addEventListener('change', refreshApplyButton);
  showTabSaveWarningToggle?.addEventListener('change', refreshApplyButton);
  showZeroWidthSaveWarningToggle?.addEventListener('change', refreshApplyButton);
  newDocumentBaseNameInput?.addEventListener('input', () => { updateSaveExample(); refreshApplyButton(); });
  newDocumentSequenceDigitsSelect?.addEventListener('change', () => { updateSaveExample(); refreshApplyButton(); });
  themeModeSelect?.addEventListener('change', refreshApplyButton);
  for (const key of themeColorKeys) {
    const pair = themeColorControls[key];
    pair?.picker?.addEventListener('input', () => { if (pair.input) pair.input.value = String(pair.picker.value || '').replace(/^#/, '').toUpperCase(); refreshApplyButton(); });
    pair?.input?.addEventListener('input', () => { const raw = String(pair.input.value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 6); if (pair.input.value !== raw) { pair.input.value = raw; showInputHint(pair.input); } else hideInputHint(pair.input); if (raw.length === 6 && pair.picker) pair.picker.value = `#${raw}`; refreshApplyButton(); });
    attachPreferenceHexHint(pair?.input);
    pair?.input?.addEventListener('blur', () => { pair.input.value = cleanHexInputText(pair.input.value, DEFAULT_PREFS.editorThemeColors[key]); pair.picker && (pair.picker.value = `#${pair.input.value}`); hideInputHint(pair.input); });
  }
  prefFontPickerButton?.addEventListener('click', () => {
    if (!prefFontPickerPanel) return;
    prefFontPickerPanel.hidden = !prefFontPickerPanel.hidden;
    if (!prefFontPickerPanel.hidden) {
      positionPrefFontPanel();
      prefFontPickerStatus.textContent = '글꼴 목록을 불러오는 중...';
      void loadPrefFontRows().then(positionPrefFontPanel);
      prefFontSearchInput?.focus({ preventScroll: true });
    }
  });
  prefFontSearchInput?.addEventListener('input', () => renderPrefFontRows(prefFontSearchInput.value));
  zeroWidthFallbackFontPickerButton?.addEventListener('click', () => {
    if (!zeroWidthFallbackFontPickerPanel) return;
    zeroWidthFallbackFontPickerPanel.hidden = !zeroWidthFallbackFontPickerPanel.hidden;
    if (!zeroWidthFallbackFontPickerPanel.hidden) {
      positionPrefFontPanel(zeroWidthFallbackFontPickerPanel, zeroWidthFallbackFontPickerButton);
      if (zeroWidthFallbackFontPickerStatus) zeroWidthFallbackFontPickerStatus.textContent = '글꼴 목록을 불러오는 중...';
      void loadPrefFontRows().then(() => positionPrefFontPanel(zeroWidthFallbackFontPickerPanel, zeroWidthFallbackFontPickerButton));
      zeroWidthFallbackFontSearchInput?.focus({ preventScroll: true });
    }
  });
  zeroWidthFallbackFontSearchInput?.addEventListener('input', () => renderFallbackFontRows(zeroWidthFallbackFontSearchInput.value));
  zeroWidthFallbackFontPickerPanel?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    zeroWidthFallbackFontPickerPanel.hidden = true;
    zeroWidthFallbackFontPickerButton?.focus({ preventScroll: true });
  }, true);
  prefFontPickerPanel?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    prefFontPickerPanel.hidden = true;
    prefFontPickerButton?.focus({ preventScroll: true });
  }, true);
  document.addEventListener('mousedown', event => {
    if (prefFontPickerPanel && !prefFontPickerPanel.hidden && !prefFontPickerPanel.contains(event.target) && !prefFontPickerButton?.contains(event.target)) prefFontPickerPanel.hidden = true;
    if (zeroWidthFallbackFontPickerPanel && !zeroWidthFallbackFontPickerPanel.hidden && !zeroWidthFallbackFontPickerPanel.contains(event.target) && !zeroWidthFallbackFontPickerButton?.contains(event.target)) zeroWidthFallbackFontPickerPanel.hidden = true;
  }, true);
  prefFontPathModeBtn?.addEventListener('click', () => {
    markCustomFontSelected('path');
    updateCustomFontModeControls();
    updatePrefFontPickerLabel();
    refreshApplyButton();
    customFontPathInput?.focus({ preventScroll: true });
  });
  customFontPathInput?.addEventListener('input', () => { markCustomFontSelected('path'); updateCustomFontModeControls(); updatePrefFontPickerLabel(); refreshApplyButton(); });
  zeroWidthFallbackFontPathModeBtn?.addEventListener('click', () => {
    markFallbackFontPathMode();
    updateFallbackFontModeControls();
    updateFallbackFontPickerLabel();
    refreshApplyButton();
    zeroWidthFallbackFontPathInput?.focus({ preventScroll: true });
  });
  zeroWidthFallbackFontPathInput?.addEventListener('input', () => { markFallbackFontPathMode(); updateFallbackFontModeControls(); updateFallbackFontPickerLabel(); refreshApplyButton(); });
  zeroWidthFallbackFontSizePtInput?.addEventListener('input', refreshApplyButton);
  zeroWidthFallbackLineHeightPtInput?.addEventListener('input', refreshApplyButton);

  defaultRenderFontSourceSelect?.addEventListener('change', () => { updateCustomFontModeControls(); updatePrefFontPickerLabel(); refreshApplyButton(); });
  defaultFontSizePtInput?.addEventListener('input', () => { syncDefaultLineHeightForFontSizeChange(); refreshApplyButton(); });
  defaultLineHeightSizePtInput?.addEventListener('input', refreshApplyButton);
  defaultTextAlignSelect?.addEventListener('change', refreshApplyButton);
  defaultTabWidthInput?.addEventListener('input', refreshApplyButton);
  lineNumberFontSizePxInput?.addEventListener('input', refreshApplyButton);
  lineNumberGutterWidthPxInput?.addEventListener('input', () => { applyLineNumberGutterWidthToDom(lineNumberGutterWidthPxInput.value); refreshApplyButton(); });

  [toolbarFontSizePtInput, colorPreviewSizePxInput, toolbarRowHeightPxInput, defaultFontSizePtInput, defaultLineHeightSizePtInput, zeroWidthFallbackFontSizePtInput, zeroWidthFallbackLineHeightPtInput, defaultTabWidthInput, lineNumberFontSizePxInput, lineNumberGutterWidthPxInput].forEach(input => {
    attachPreferenceNumberHint(input);
  });
  browseDefaultSaveDirectoryBtn?.addEventListener('click', async () => {
    try {
      const dir = await withNativeDialogGuard(() => selectDefaultSaveDirectoryDialog(getPreferences().defaultSaveDirectory));
      if (!dir) { setStatusMessage('기본 저장 경로 선택 취소'); return; }
      defaultSaveDirectoryInput.value = dir;
      refreshApplyButton();
      setStatusMessage('기본 저장 경로 선택됨');
    } catch (err) {
      setErrorMessage('기본 저장 경로 선택 실패: ' + String(err));
    }
  });
  browseCustomFontBtn?.addEventListener('click', async () => {
    try {
      const path = await withNativeDialogGuard(() => defaultFontBrowseDirectory().then(dir => selectFontFileDialog(dir)));
      if (!path) { setStatusMessage('대표 글꼴 선택 취소'); return; }
      const cachedPath = await cacheFontPathForRole(path, 'primary');
      markCustomFontSelected('path');
      if (customFontPathInput) customFontPathInput.value = cachedPath;
      updateCustomFontModeControls();
      updatePrefFontPickerLabel();
      refreshApplyButton();
      setStatusMessage('대표 글꼴 캐시 저장됨');
    } catch (err) {
      setErrorMessage('대표 글꼴 선택 실패: ' + String(err));
    }
  });
  browseZeroWidthFallbackFontBtn?.addEventListener('click', async () => {
    try {
      const path = await withNativeDialogGuard(() => defaultFontBrowseDirectory(zeroWidthFallbackFontPathInput).then(dir => selectFontFileDialog(dir)));
      if (!path) { setStatusMessage('대체 글꼴 선택 취소'); return; }
      const cachedPath = await cacheFontPathForRole(path, 'fallback');
      if (zeroWidthFallbackFontPathInput) zeroWidthFallbackFontPathInput.value = cachedPath;
      markFallbackFontPathMode(cachedPath);
      updateFallbackFontModeControls();
      updateFallbackFontPickerLabel();
      refreshApplyButton();
      setStatusMessage('대체 글꼴 캐시 저장됨');
    } catch (err) {
      setErrorMessage('대체 글꼴 선택 실패: ' + String(err));
    }
  });
  defaultLayoutModeSelect?.addEventListener('change', () => {
    const mode = normalizeLayoutMode(defaultLayoutModeSelect.value || DEFAULT_PREFS.defaultLayoutMode);
    defaultLayoutModeSelect.innerHTML = layoutOptionsHtml(mode);
    defaultLayoutModeSelect.value = mode;
    refreshApplyButton();
  });
  jsonKeyExtractLanguageSelect?.addEventListener('change', () => {
    const language = normalizeJsonKeyExtractLanguage(jsonKeyExtractLanguageSelect.value || DEFAULT_PREFS.jsonKeyExtractLanguage);
    jsonKeyExtractLanguageSelect.innerHTML = jsonKeyExtractLanguageOptionsHtml({ selected: language, defaultLanguage: language });
    jsonKeyExtractLanguageSelect.value = language;
    refreshApplyButton();
  });
  attachPreferenceNumberHint(recentInput);
  recentInput?.addEventListener('blur', () => { hideNumberHint(recentInput); recentInput.value = String(Math.max(0, Math.min(10, Number.parseInt(sanitizeDigits(recentInput.value), 10) || 0))); });
  attachPreferenceNumberHint(undoHistoryLimitInput);
  undoHistoryLimitInput?.addEventListener('blur', () => {
    hideNumberHint(undoHistoryLimitInput);
    const raw = Number.parseInt(sanitizeDigits(undoHistoryLimitInput.value), 10);
    undoHistoryLimitInput.value = String(Math.max(10, Math.min(200, Number.isFinite(raw) ? raw : DEFAULT_PREFS.undoHistoryLimit)));
  });
  attachPreferenceNumberHint(searchHistoryLimitInput);
  searchHistoryLimitInput?.addEventListener('blur', () => { hideNumberHint(searchHistoryLimitInput); searchHistoryLimitInput.value = String(Math.max(0, Math.min(10, Number.parseInt(sanitizeDigits(searchHistoryLimitInput.value), 10) || 0))); });
  toolbarFontSizePtInput?.addEventListener('blur', () => { hideNumberHint(toolbarFontSizePtInput); toolbarFontSizePtInput.value = String(normalizeToolbarFontSizePt(toolbarFontSizePtInput.value)); });
  colorPreviewSizePxInput?.addEventListener('blur', () => { hideNumberHint(colorPreviewSizePxInput); colorPreviewSizePxInput.value = colorPreviewSizeText(colorPreviewSizePxInput.value); applyColorPreviewSizeToDom(colorPreviewSizePxInput.value); });
  toolbarRowHeightPxInput?.addEventListener('blur', () => { hideNumberHint(toolbarRowHeightPxInput); toolbarRowHeightPxInput.value = String(normalizeToolbarRowHeightPx(toolbarRowHeightPxInput.value)); });
  defaultFontSizePtInput?.addEventListener('blur', () => { hideNumberHint(defaultFontSizePtInput); syncDefaultLineHeightForFontSizeChange(); defaultFontSizePtInput.value = String(Math.round(normalizePtInput(defaultFontSizePtInput.value, 6, 999, DEFAULT_PREFS.defaultRendering.fontSizePt))); });
  defaultLineHeightSizePtInput?.addEventListener('blur', () => { hideNumberHint(defaultLineHeightSizePtInput); defaultLineHeightSizePtInput.value = String(Math.round(normalizePtInput(defaultLineHeightSizePtInput.value, 6, 2000, DEFAULT_PREFS.defaultRendering.lineHeightPt))); defaultLineRatioFontSizePt = normalizePtInput(defaultFontSizePtInput?.value, 6, 999, DEFAULT_PREFS.defaultRendering.fontSizePt); });
  zeroWidthFallbackFontSizePtInput?.addEventListener('blur', () => { hideNumberHint(zeroWidthFallbackFontSizePtInput); zeroWidthFallbackFontSizePtInput.value = String(Math.round(normalizePtInput(zeroWidthFallbackFontSizePtInput.value, 6, 999, DEFAULT_PREFS.zeroWidthFallbackFontSizePt))); });
  zeroWidthFallbackLineHeightPtInput?.addEventListener('blur', () => { hideNumberHint(zeroWidthFallbackLineHeightPtInput); zeroWidthFallbackLineHeightPtInput.value = String(Math.round(normalizePtInput(zeroWidthFallbackLineHeightPtInput.value, 6, 2000, DEFAULT_PREFS.zeroWidthFallbackLineHeightPt))); });
  defaultTabWidthInput?.addEventListener('blur', () => { hideNumberHint(defaultTabWidthInput); defaultTabWidthInput.value = String(Math.round(clampNumber(Number.parseInt(sanitizeDigits(defaultTabWidthInput.value), 10), 1, 32, DEFAULT_PREFS.defaultRendering.tabWidth))); });
  lineNumberFontSizePxInput?.addEventListener('blur', () => { hideNumberHint(lineNumberFontSizePxInput); lineNumberFontSizePxInput.value = String(normalizeLineNumberFontSizePx(lineNumberFontSizePxInput.value)); });
  lineNumberGutterWidthPxInput?.addEventListener('blur', () => { hideNumberHint(lineNumberGutterWidthPxInput); lineNumberGutterWidthPxInput.value = String(normalizeLineNumberGutterWidthPx(lineNumberGutterWidthPxInput.value)); applyLineNumberGutterWidthToDom(lineNumberGutterWidthPxInput.value); });

  colorShortcutIgnoreShiftToggle?.addEventListener('change', refreshApplyButton);
  body.querySelectorAll('.pref-color-link-help-link, .pref-color-shift-help-link').forEach(link => link.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); }));
  bindPrefInstantTooltips(body);
  addColorLinkBtn?.addEventListener('click', addColorLinkRow);
  deleteColorLinkBtn?.addEventListener('click', deleteSelectedColorLinkRows);
  moveColorLinksTopBtn?.addEventListener('click', () => reorderSelectedColorLinks('top'));
  moveColorLinksUpBtn?.addEventListener('click', () => reorderSelectedColorLinks('up'));
  moveColorLinksDownBtn?.addEventListener('click', () => reorderSelectedColorLinks('down'));
  moveColorLinksBottomBtn?.addEventListener('click', () => reorderSelectedColorLinks('bottom'));
  sortColorLinksColorBtn?.addEventListener('click', () => sortColorLinks('color'));
  sortColorLinksNameBtn?.addEventListener('click', () => sortColorLinks('name'));
  sortColorLinksKeyBtn?.addEventListener('click', () => sortColorLinks('key'));
  colorLinkRowsEl?.addEventListener('change', (event) => {
    if (event.target?.matches?.('[data-color-select]')) syncSelectedColorLinkRows();
  });

  colorLinkRowsEl?.addEventListener('click', (event) => {
    const target = event.target;
    const row = target?.closest?.('[data-color-link-row]');
    const action = target?.closest?.('[data-color-action]')?.dataset?.colorAction;
    if (!row || !action) return;
    if (action === 'pick') {
      row.querySelector('[data-color-field="hexPicker"]')?.click();
      return;
    }
    if (action === 'editName') { editColorLinkName(row); return; }
    if (action === 'editMemo') { editColorLinkMemo(row); return; }
    if (action === 'editKey') { editColorLinkKey(row); return; }
    return;
  });
  colorLinkRowsEl?.addEventListener('input', (event) => {
    const target = event.target;
    const row = target?.closest?.('[data-color-link-row]');
    if (!row) return;
    if (target?.dataset?.colorField === 'key') {
      const next = normalizeColorKey(target.value, '');
      target.value = next;
    } else if (target?.dataset?.colorField === 'memo') {
      const lines = String(target.value || '').replace(/\r\n?/g, '\n').split('\n').slice(0, 2).map(line => line.slice(0, 15));
      target.value = lines.join('\n');
    }
    if (target?.dataset?.colorField === 'hexPicker') syncColorLinkRow(row);
    refreshApplyButton();
  });
  colorLinkRowsEl?.addEventListener('blur', (event) => {
    const target = event.target;
    if (!target?.dataset?.colorField) return;
    if (target.dataset.colorField === 'name') target.value = String(target.value || '').trim().slice(0, 5) || (normalizeUiLanguage(getPreferences().uiLanguage) === 'en' ? 'Color' : '색상');
    if (target.dataset.colorField === 'memo') target.value = normalizeColorMemo(target.value || '');
    refreshApplyButton();
  }, true);
  body.querySelectorAll('.pref-category').forEach(btn => btn.addEventListener('click', () => selectCategory(btn.dataset.category)));

  clearRecentBtn.addEventListener('click', async () => {
    if (!await showConfirmModal('최근 파일목록을 삭제하시겠습니까?', { title: '최근 파일목록 삭제' })) return;
    clearRecentDocuments();
    onApply?.();
    updateMaintenanceButtons();
    setStatusMessage('최근 파일목록 삭제 완료');
  });
  clearSearchBtn.addEventListener('click', async () => {
    if (!await showConfirmModal('검색기록을 삭제하시겠습니까?', { title: '검색기록 삭제' })) return;
    clearSearchHistory();
    updateMaintenanceButtons();
    setStatusMessage('검색기록 삭제 완료');
  });

  deleteUserDataBtn?.addEventListener('click', async () => {
    const firstMessage = '프로그램이 만든 사용자 데이터를 삭제합니다.\n\n이 작업은 환경설정, 최근 파일 목록, 검색기록, 사용자 색상 연결, 사용자 지정 폰트 캐시 등 프로그램이 저장한 데이터를 제거합니다.\n\n실행 파일, 사용자가 편집한 txt 문서, 사용자가 원래 가지고 있던 폰트 파일은 삭제하지 않습니다. 확인을 누르면 한 번 더 확인한 뒤 프로그램이 종료됩니다.\n\n계속하시겠습니까?';
    if (!await showConfirmModal(firstMessage, { title: '사용자 데이터 삭제' })) return;
    const secondMessage = '정말 프로그램이 만든 사용자 데이터를 삭제하시겠습니까?\n\n이 작업은 되돌릴 수 없습니다.';
    if (!await showConfirmModal(secondMessage, { title: '최종 확인' })) return;
    await showAlertModal('프로그램이 종료됩니다.', { title: '사용자 데이터 삭제' });
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (_) {}
    try {
      await cleanupUserDataAndExit();
    } catch (err) {
      setErrorMessage('사용자 데이터 삭제 실패: ' + String(err));
    }
  });

  resetAllSettingsBtn?.addEventListener('click', async () => {
    if (!await showConfirmModal('컴퓨터에 저장된 환경설정, 최근 문서 목록, 검색 기록, 유니코드 글리프 목록을 기본값으로 되돌립니다. 이 작업은 현재 설정 파일을 기본값으로 덮어씁니다. 진행하시겠습니까?', { title: '전체 설정 초기화' })) return;
    try {
      localStorage.removeItem(LEGACY_PREF_KEY);
      localStorage.removeItem(LEGACY_RECENT_KEY);
      localStorage.removeItem(LEGACY_SEARCH_HISTORY_KEY);
      localStorage.removeItem(FALLBACK_SETTINGS_KEY);
      localStorage.removeItem('TooltipEditor.unicodeGlyphs.v1');
    } catch (_) {}
    settings = normalizeSettings(makeDefaultSettings());
    applyPreferencesToRuntime();
    await persistSettings();
    document.dispatchEvent(new CustomEvent('tooltipeditor:preferences-changed', { detail: getPreferences() }));
    setGeneralForm(getPreferences());
    setSaveForm(getPreferences());
    if (themeModeSelect) themeModeSelect.value = normalizeThemeMode(getPreferences().themeMode);
    setThemeColorForm(getPreferences());
    setRenderingForm(getPreferences());
    setColorForm(getPreferences());
    updateMaintenanceButtons();
    lastApplied.general = categoryState('general');
    lastApplied.save = categoryState('save');
    lastApplied.theme = categoryState('theme');
    lastApplied.rendering = categoryState('rendering');
    lastApplied.color = categoryState('color');
    refreshApplyButton();
    onApply?.();
    setStatusMessage('전체 설정 초기화 완료');
  });

  exportBtn.addEventListener('click', async () => {
    try {
      await persistSettings();
      if (isTauriAvailable()) {
        const path = await withNativeDialogGuard(() => exportSettingsJsonDialog(snapshotJson(), getPreferences().defaultSaveDirectory));
        setStatusMessage(path ? '설정 내보내기 완료' : '설정 내보내기 취소');
      } else {
        const blob = new Blob([snapshotJson()], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ttedit_settings.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatusMessage('설정 JSON 다운로드 완료');
      }
    } catch (err) { setErrorMessage('설정 내보내기 실패: ' + String(err)); }
  });

  importBtn.addEventListener('click', async () => {
    try {
      let text = null;
      if (isTauriAvailable()) text = await withNativeDialogGuard(() => importSettingsJsonDialog(getPreferences().defaultSaveDirectory));
      else { setStatusMessage('브라우저 실행에서는 설정 가져오기를 지원하지 않습니다.'); return; }
      if (!text) { setStatusMessage('설정 가져오기 취소'); return; }
      settings = parseSettingsJson(text);
      applyPreferencesToRuntime();
      document.dispatchEvent(new CustomEvent('tooltipeditor:preferences-changed', { detail: getPreferences() }));
      await persistSettings();
      setGeneralForm(getPreferences());
      setSaveForm(getPreferences());
      if (themeModeSelect) themeModeSelect.value = normalizeThemeMode(getPreferences().themeMode);
      setThemeColorForm(getPreferences());
      setRenderingForm(getPreferences());
      setColorForm(getPreferences());
      onApply?.();
      updateMaintenanceButtons();
      lastApplied.general = categoryState('general');
      lastApplied.save = categoryState('save');
      lastApplied.theme = categoryState('theme');
      lastApplied.rendering = categoryState('rendering');
      lastApplied.color = categoryState('color');
      refreshApplyButton();
      setStatusMessage('설정 가져오기 완료');
    } catch (err) { setErrorMessage('설정 가져오기 실패: ' + String(err)); }
  });

  okBtn.addEventListener('click', applyAllCategoriesAndClose);
  cancelBtn.addEventListener('click', () => {
    if (categoryState(activeCategory) === lastApplied[activeCategory]) { closePreferencesWindow(); return; }
    resetActiveCategoryToSaved();
  });
  defaultBtn.addEventListener('click', async () => {
    const label = body.querySelector(`.pref-category[data-category=\"${activeCategory}\"]`)?.textContent?.trim() || '현재';
    if (!await showConfirmModal(`${label} 탭의 설정값만 기본값으로 불러옵니다. 초기값으로 돌아간 뒤에도 취소를 누르면 저장된 설정값으로 되돌릴 수 있습니다. 진행하시겠습니까?`, { title: '기본값 확인' })) return;
    await resetActiveCategoryToDefault();
  });
  applyButton.addEventListener('click', () => { void applyActiveCategory(); });
  body.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (prefFontPickerPanel && !prefFontPickerPanel.hidden) {
        event.preventDefault();
        event.stopPropagation();
        prefFontPickerPanel.hidden = true;
        prefFontPickerButton?.focus({ preventScroll: true });
        return;
      }
      if (zeroWidthFallbackFontPickerPanel && !zeroWidthFallbackFontPickerPanel.hidden) {
        event.preventDefault();
        event.stopPropagation();
        zeroWidthFallbackFontPickerPanel.hidden = true;
        zeroWidthFallbackFontPickerButton?.focus({ preventScroll: true });
        return;
      }
      event.preventDefault();
      closePreferencesWindow();
    }
    if (event.key === 'Enter' && !event.target.matches('textarea, button')) { event.preventDefault(); okBtn.click(); }
  });

  updateCustomFontModeControls();
  updateFallbackFontModeControls();
  updatePrefFontPickerLabel();
  updateFallbackFontPickerLabel();
  void loadPrefFontRows();
  updateMaintenanceButtons();
  refreshApplyButton();
  prefWindow.focus({ preventScroll: true });
  await modalPromise;
  hidePrefInstantTooltip();
  prefWindow = null;
  applyPreferencesToRuntime();
}
