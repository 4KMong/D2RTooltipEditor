import { fileExists, isTauriAvailable, listSystemFonts, readFontFileDataUrl } from './fileApi.js';

export const FONT_SIZE_PRESETS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 48, 56, 64, 72, 88, 96, 112];

const FONT_KO_NAME_MAP = new Map([
  ['malgun gothic', '맑은 고딕'], ['malgun', '맑은 고딕'], ['malgun.ttf', '맑은 고딕'], ['malgunbd.ttf', '맑은 고딕'],
  ['gulim', '굴림'], ['gulim.ttc', '굴림'], ['dotum', '돋움'], ['batang', '바탕'], ['batang.ttc', '바탕'], ['gungsuh', '궁서'],
]);

const FALLBACK_SYSTEM_FONTS = [
  { familyName: 'Malgun Gothic', fileName: 'malgun.ttf', path: '', source: 'system' },
  { familyName: 'Gulim', fileName: 'gulim.ttc', path: '', source: 'system' },
  { familyName: 'Dotum', fileName: 'gulim.ttc', path: '', source: 'system' },
  { familyName: 'Batang', fileName: 'batang.ttc', path: '', source: 'system' },
  { familyName: 'Consolas', fileName: 'consola.ttf', path: '', source: 'system' },
  { familyName: 'Segoe UI', fileName: 'segoeui.ttf', path: '', source: 'system' },
  { familyName: 'Arial', fileName: 'arial.ttf', path: '', source: 'system' },
];

export const BUILTIN_FONT_SOURCE = 'builtin';
export const BUILTIN_FALLBACK_FONT_SOURCE = 'builtinFallback';
export const BUILTIN_FONT_CSS_FAMILY = 'TTE Embedded Vanilla';
export const BUILTIN_FONT_FILE_NAME = 'embedded_vanilla.ttf';
export const BUILTIN_FONT_DISPLAY_NAME = '[TTE 내장] Vanilla';
export const FALLBACK_FONT_CSS_FAMILY = 'TTE Embedded Fallback';
export const FALLBACK_FONT_FILE_NAME = 'embedded_fallback.ttf';
export const FALLBACK_FONT_DISPLAY_NAME = '[TTE 내장] FallBack';
export const CUSTOM_FONT_ROLE_LABEL = '대표 글꼴';
export const FALLBACK_FONT_ROLE_LABEL = '대체 글꼴';

const faceRegistry = new Map();
let cachedSystemFonts = null;

function canonical(text = '') { return String(text || '').trim().toLowerCase(); }
function normalizeFilePath(path = '') { return String(path || '').trim().replace(/\//g, '\\'); }
function basename(path = '') { return String(path || '').split(/[\\/]/).filter(Boolean).pop() || ''; }
function stripFontExt(file = '') { return String(file || '').replace(/\.(ttf|otf|ttc)$/i, ''); }
function hashText(text = '') {
  let h = 2166136261;
  for (const ch of String(text || '')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
function koName(name = '', file = '') {
  return FONT_KO_NAME_MAP.get(canonical(name)) || FONT_KO_NAME_MAP.get(canonical(file)) || String(name || file || '글꼴').trim();
}
function fontPathKey(path = '') { return normalizeFilePath(path).toLowerCase(); }
function isFontFileName(file = '') { return /\.(ttf|otf|ttc)$/i.test(String(file || '')); }
function normalizeSource(source = '') {
  if (source === BUILTIN_FONT_SOURCE) return BUILTIN_FONT_SOURCE;
  if (source === BUILTIN_FALLBACK_FONT_SOURCE) return BUILTIN_FALLBACK_FONT_SOURCE;
  if (source === 'custom' || source === 'customPath') return 'custom';
  return 'system';
}

export function makeFontEntry({ source = 'system', familyName = '', fileName = '', path = '', displayName = '', aliasRole = '' } = {}) {
  const normalizedSource = normalizeSource(source);
  const normalizedPath = normalizeFilePath(path);
  const normalizedFile = fileName || basename(normalizedPath);
  let family = koName(familyName || stripFontExt(normalizedFile), normalizedFile);
  if (normalizedSource === BUILTIN_FONT_SOURCE) family = BUILTIN_FONT_CSS_FAMILY;
  if (normalizedSource === BUILTIN_FALLBACK_FONT_SOURCE) family = FALLBACK_FONT_CSS_FAMILY;
  const entry = { source: normalizedSource, familyName: family, fileName: normalizedFile, path: normalizedPath };
  if (aliasRole) entry.aliasRole = aliasRole;
  entry.id = getFontId(entry);
  entry.displayName = displayName || getFontDisplayName(entry);
  entry.cssFamily = getFontCssFamily(entry);
  return entry;
}

export function getFontId(entry = {}) {
  const source = normalizeSource(entry.source || 'system');
  return [source, entry.path || '', entry.fileName || '', entry.familyName || ''].join('|').toLowerCase();
}
export function getFontDisplayName(entry = {}) {
  if (entry.source === 'separator') return entry.label || '';
  if (entry.source === BUILTIN_FONT_SOURCE) return BUILTIN_FONT_DISPLAY_NAME;
  if (entry.source === BUILTIN_FALLBACK_FONT_SOURCE) return FALLBACK_FONT_DISPLAY_NAME;
  if (entry.isCustomAlias && entry.displayName) return entry.displayName;
  if (entry.source === 'custom') {
    const file = entry.fileName || basename(entry.path) || entry.familyName || '글꼴';
    const suffix = entry.aliasRole === 'fallback' ? FALLBACK_FONT_ROLE_LABEL : CUSTOM_FONT_ROLE_LABEL;
    return entry.displayName || `${file} (${suffix})`;
  }
  return entry.displayName || koName(entry.familyName, entry.fileName);
}
export function getFontCssFamily(entry = {}) {
  if (!entry || entry.source === BUILTIN_FONT_SOURCE) return BUILTIN_FONT_CSS_FAMILY;
  if (entry.source === BUILTIN_FALLBACK_FONT_SOURCE) return FALLBACK_FONT_CSS_FAMILY;
  if (entry.source === 'custom') return `TTEditCustomFont_${hashText(entry.path || entry.fileName || entry.familyName)}`;
  return entry.familyName || entry.fileName || 'Malgun Gothic';
}
export function getFontSource(entry = {}) { return normalizeSource(entry?.source || 'system'); }
function cssString(text = '') { return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
async function loadCustomFontFace(entry = {}, family = getFontCssFamily(entry)) {
  const path = normalizeFilePath(entry.path);
  try {
    const dataUrl = await readFontFileDataUrl(path);
    if (!dataUrl) throw new Error('font data is empty');
    const ext = basename(path).toLowerCase().split('.').pop();
    const format = ext === 'otf' ? 'opentype' : ext === 'ttc' ? 'truetype-collection' : 'truetype';
    const style = document.createElement('style');
    style.dataset.tteditFontFace = family;
    style.textContent = `@font-face{font-family:"${cssString(family)}";src:url("${cssString(dataUrl)}") format("${format}");font-display:swap}`;
    document.head.appendChild(style);
    faceRegistry.set(family, { status: 'loaded', style, path });
    try { await document.fonts?.load?.(`16px "${cssString(family)}"`); } catch (_) {}
    document.dispatchEvent(new CustomEvent('tooltipeditor:font-face-loaded', { detail: { family, path } }));
  } catch (err) {
    const message = String(err?.message || err || 'unknown error');
    faceRegistry.set(family, { status: 'failed', path, error: message });
    console.warn('custom font load failed', path, err);
    document.dispatchEvent(new CustomEvent('tooltipeditor:font-face-failed', { detail: { family, path, error: message } }));
  }
}

export function ensureFontFace(entry = {}) {
  if (entry?.source !== 'custom') return getFontCssFamily(entry);
  if (!entry?.path || !isFontFileName(entry.fileName || entry.path)) return getFontCssFamily(entry);
  const family = getFontCssFamily(entry);
  if (faceRegistry.has(family)) return family;
  faceRegistry.set(family, { status: 'loading', path: normalizeFilePath(entry.path) });
  void loadCustomFontFace(entry, family);
  return family;
}
export function fontCssFamilyForUse(entry = {}) {
  if (entry?.source === BUILTIN_FONT_SOURCE) return BUILTIN_FONT_CSS_FAMILY;
  if (entry?.source === BUILTIN_FALLBACK_FONT_SOURCE) return FALLBACK_FONT_CSS_FAMILY;
  if (entry?.source === 'custom') return ensureFontFace(entry);
  return getFontCssFamily(entry);
}

async function pathExists(path = '') {
  if (!path || !isTauriAvailable()) return false;
  try { return await fileExists(path); } catch { return false; }
}
export async function resolveCustomFontEntry(path = '', aliasRole = '') {
  const configured = normalizeFilePath(path);
  if (!configured || !isFontFileName(configured)) return null;
  if (!await pathExists(configured)) return null;
  const file = basename(configured);
  return makeFontEntry({ source: 'custom', path: configured, fileName: file, familyName: stripFontExt(file), aliasRole });
}


function fontDisplayKey(entry = {}) {
  return canonical(getFontDisplayName(entry) || entry.familyName || entry.fileName || entry.path || '');
}
function isUserFontPath(path = '') {
  const p = normalizeFilePath(path).toLowerCase();
  return p.includes('\\appdata\\local\\microsoft\\windows\\fonts') || p.includes('\\appdata\\roaming\\microsoft\\windows\\fonts');
}
function systemFontPriority(row = {}) {
  const p = normalizeFilePath(row.path || '').toLowerCase();
  if (isUserFontPath(p)) return 0;
  if (p.includes('\\windows\\fonts')) return 1;
  if (!p) return 3;
  return 2;
}
function dedupeSystemFontRows(rows = []) {
  const byName = new Map();
  for (const row of rows) {
    const key = fontDisplayKey(row);
    if (!key) continue;
    const prev = byName.get(key);
    if (!prev || systemFontPriority(row) < systemFontPriority(prev) || (systemFontPriority(row) === systemFontPriority(prev) && String(row.path || '').length > String(prev.path || '').length)) {
      byName.set(key, row);
    }
  }
  return Array.from(byName.values());
}
function pushUniqueFontRow(rows, row, seen) {
  if (!row || row.source === 'separator') { rows.push(row); return true; }
  const key = fontDisplayKey(row);
  if (key && seen.has(key)) return false;
  if (key) seen.add(key);
  rows.push(row);
  return true;
}
export function getFontRoleLabel(entry = {}) {
  if (!entry || entry.source === 'separator') return '';
  if (entry.source === BUILTIN_FONT_SOURCE) return '내장';
  if (entry.source === BUILTIN_FALLBACK_FONT_SOURCE) return '내장 대체';
  if (entry.aliasRole === 'fallback') return FALLBACK_FONT_ROLE_LABEL;
  if (entry.aliasRole === 'custom' || entry.source === 'custom') return CUSTOM_FONT_ROLE_LABEL;
  return '';
}
export function getFontNameLabel(entry = {}) {
  if (!entry || entry.source === 'separator') return entry?.label || '';
  if (entry.isCustomAlias) {
    return entry.aliasBaseName || entry.fileName || entry.familyName || '글꼴';
  }
  return getFontDisplayName(entry);
}

export async function listSystemFontEntries() {
  if (cachedSystemFonts) return cachedSystemFonts.slice();
  let rows = [];
  if (isTauriAvailable()) {
    try {
      const raw = await listSystemFonts();
      rows = (Array.isArray(raw) ? raw : [])
        .map(item => makeFontEntry({
          source: 'system',
          familyName: String(item.family_name || item.familyName || item.file_name || item.fileName || '').trim(),
          fileName: String(item.file_name || item.fileName || '').trim(),
          path: String(item.path || '').trim(),
        }))
        .filter(item => item.familyName || item.fileName);
    } catch (_) { rows = []; }
  }
  if (!rows.length) rows = FALLBACK_SYSTEM_FONTS.map(makeFontEntry);
  cachedSystemFonts = dedupeSystemFontRows(rows).sort((a, b) => getFontDisplayName(a).localeCompare(getFontDisplayName(b), 'ko') || (a.fileName || '').localeCompare(b.fileName || '', 'ko') || (a.path || '').localeCompare(b.path || '', 'ko'));
  return cachedSystemFonts.slice();
}

export function favoriteSetFromPreferences(prefs = {}) { return new Set(Array.isArray(prefs.renderingFavoriteFonts) ? prefs.renderingFavoriteFonts : []); }
export function isFavoriteFont(entry, prefs = {}) { return favoriteSetFromPreferences(prefs).has(getFontId(entry)); }

async function resolveCustomAliasEntry(systemRows = [], path = '', aliasRole = 'custom') {
  const custom = await resolveCustomFontEntry(path, aliasRole === 'fallback' ? 'fallback' : 'custom');
  if (!custom) return null;
  const requestedPath = fontPathKey(custom.path);
  const systemMatch = systemRows.find(row => fontPathKey(row.path) === requestedPath);
  const displayBase = systemMatch ? getFontDisplayName(systemMatch) : (custom.fileName || custom.familyName || '글꼴');
  const suffix = aliasRole === 'fallback' ? FALLBACK_FONT_ROLE_LABEL : CUSTOM_FONT_ROLE_LABEL;
  return {
    ...custom,
    familyName: systemMatch?.familyName || custom.familyName,
    fileName: systemMatch?.fileName || custom.fileName,
    path: systemMatch?.path || custom.path,
    isCustomAlias: true,
    aliasRole: aliasRole === 'fallback' ? 'fallback' : 'custom',
    aliasBaseName: displayBase,
    displayName: `${displayBase} (${suffix})`,
  };
}

async function resolveFallbackAliasEntry(systemRows = [], prefs = {}) {
  const path = prefs?.zeroWidthFallbackFontPath || '';
  const pathAlias = await resolveCustomAliasEntry(systemRows, path, 'fallback');
  if (pathAlias) return pathAlias;
  const family = String(prefs?.zeroWidthFallbackFontFamily || '').trim();
  const fileName = String(prefs?.zeroWidthFallbackFontFileName || '').trim();
  if (!family && !fileName) return null;
  const source = normalizeSource(prefs?.zeroWidthFallbackFontSource || 'system');
  if (source === BUILTIN_FONT_SOURCE || source === BUILTIN_FALLBACK_FONT_SOURCE) return null;
  const systemMatch = systemRows.find(row => canonical(getFontCssFamily(row)) === canonical(family) || canonical(row.familyName) === canonical(family) || canonical(row.fileName) === canonical(fileName));
  const base = systemMatch || makeFontEntry({ source: 'system', familyName: family || stripFontExt(fileName), fileName, path: '' });
  const displayBase = getFontDisplayName(base);
  return {
    ...base,
    source: getFontSource(base),
    isCustomAlias: true,
    aliasRole: 'fallback',
    aliasBaseName: displayBase,
    displayName: `${displayBase} (${FALLBACK_FONT_ROLE_LABEL})`,
    cssFamily: getFontCssFamily(base),
    id: `${getFontId(base)}|fallback-alias`,
  };
}

export async function buildFontEntries({ prefs = {}, includeCustom = true } = {}) {
  const builtin = makeFontEntry({ source: BUILTIN_FONT_SOURCE, familyName: BUILTIN_FONT_CSS_FAMILY, fileName: BUILTIN_FONT_FILE_NAME, displayName: BUILTIN_FONT_DISPLAY_NAME });
  const builtinFallback = makeFontEntry({ source: BUILTIN_FALLBACK_FONT_SOURCE, familyName: FALLBACK_FONT_CSS_FAMILY, fileName: FALLBACK_FONT_FILE_NAME, displayName: FALLBACK_FONT_DISPLAY_NAME });
  const malgun = makeFontEntry({ source: 'system', familyName: 'Malgun Gothic', fileName: 'malgun.ttf', displayName: '맑은 고딕' });
  const system = await listSystemFontEntries();
  const rows = [];
  const seen = new Set();
  pushUniqueFontRow(rows, builtin, seen);
  pushUniqueFontRow(rows, builtinFallback, seen);
  pushUniqueFontRow(rows, malgun, seen);
  if (includeCustom) {
    const customAlias = await resolveCustomAliasEntry(system, prefs?.defaultRendering?.fontPath || '', 'custom');
    const fallbackAlias = await resolveFallbackAliasEntry(system, prefs);
    if (customAlias) pushUniqueFontRow(rows, customAlias, seen);
    if (fallbackAlias) pushUniqueFontRow(rows, fallbackAlias, seen);
  }
  const favs = favoriteSetFromPreferences(prefs);
  const favorites = [];
  const rest = [];
  const systemSeen = new Set(seen);
  for (const row of system) {
    const key = fontDisplayKey(row);
    if (key && systemSeen.has(key)) continue;
    if (key) systemSeen.add(key);
    if (favs.has(getFontId(row))) favorites.push(row);
    else rest.push(row);
  }
  for (const row of favorites) pushUniqueFontRow(rows, row, seen);
  if (rest.length) rows.push({ source: 'separator', label: '시스템 설치 글꼴' });
  for (const row of rest) pushUniqueFontRow(rows, row, seen);
  return rows;
}

export function findFontEntryForRendering(rows = [], rendering = {}) {
  const source = normalizeSource(rendering.fontSource);
  const requestedPath = normalizeFilePath(rendering.fontPath).toLowerCase();
  if (source === 'custom' && requestedPath) {
    const byPath = rows.find(row => row.source !== 'separator' && normalizeFilePath(row.path).toLowerCase() === requestedPath);
    if (byPath) return byPath;
  }
  return rows.find(row => row.source !== 'separator' && source === getFontSource(row) && (source !== 'custom' || normalizeFilePath(row.path) === normalizeFilePath(rendering.fontPath)) && (source === 'custom' || getFontCssFamily(row) === rendering.fontFamily || row.familyName === rendering.fontFamily))
    || rows.find(row => row.source === BUILTIN_FONT_SOURCE)
    || makeFontEntry({ source: BUILTIN_FONT_SOURCE });
}

export function renderingPatchFromFontEntry(entry = {}) {
  const source = getFontSource(entry);
  return {
    fontSource: source,
    fontFamily: fontCssFamilyForUse(entry),
    fontPath: source === 'custom' ? entry.path : '',
    fontFileName: source === 'custom' ? entry.fileName : '',
  };
}
