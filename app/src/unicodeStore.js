const STORE_KEY = 'TooltipEditor.unicodeGlyphs.v1';
const DEFAULT_CODE = '2060';

function hexCode(n) {
  const value = Number(n);
  if (!Number.isInteger(value) || value < 0 || value > 0x10FFFF) return null;
  return value.toString(16).toUpperCase().padStart(4, '0');
}
function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(hexCode(i));
  return out;
}
function numericCode(code) { return parseInt(String(code || '0'), 16); }
function sortCodes(codes = []) { return [...codes].sort((a, b) => numericCode(a) - numericCode(b)); }

export function defaultGlyphCodes() {
  return [
    DEFAULT_CODE,
    ...range(0xE031, 0xE036),
    ...range(0xF020, 0xF07D),
    ...range(0xFF60, 0xFFBF),
  ];
}

export function normalizeGlyphCode(value) {
  let text = String(value ?? '').trim().toUpperCase();
  text = text.replace(/^U\+/i, '').replace(/^\\U/i, '').replace(/^0X/i, '');
  if (!/^[0-9A-F]{1,6}$/.test(text)) return null;
  const cp = Number.parseInt(text, 16);
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return null;
  return hexCode(cp);
}

function uniqueValid(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const code = normalizeGlyphCode(item);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function legacyFavoriteCodes(parsed = {}) {
  if (Array.isArray(parsed.favoriteCodes)) return uniqueValid(parsed.favoriteCodes);
  if (Array.isArray(parsed.codes)) return uniqueValid(parsed.codes);

  if (Array.isArray(parsed.userCodes) || Array.isArray(parsed.removedDefaultCodes)) {
    const removed = new Set(uniqueValid(parsed.removedDefaultCodes || []));
    const merged = defaultGlyphCodes().filter(code => !removed.has(code));
    merged.push(...uniqueValid(parsed.userCodes || []));
    return uniqueValid(merged);
  }
  return defaultGlyphCodes();
}

export function getGlyphSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
    const favoriteCodes = sortCodes(legacyFavoriteCodes(parsed));
    const defaultCode = normalizeGlyphCode(parsed.defaultCode) || DEFAULT_CODE;
    return { favoriteCodes, codes: favoriteCodes.slice(), defaultCode };
  } catch {
    const favoriteCodes = defaultGlyphCodes();
    return { favoriteCodes, codes: favoriteCodes.slice(), defaultCode: DEFAULT_CODE };
  }
}

export function saveGlyphSettings(settings = {}) {
  const favoriteCodes = sortCodes(uniqueValid(settings.favoriteCodes ?? settings.codes ?? defaultGlyphCodes()));
  const defaultCode = normalizeGlyphCode(settings.defaultCode) || DEFAULT_CODE;
  localStorage.setItem(STORE_KEY, JSON.stringify({ model: 2, favoriteCodes, defaultCode }));
  return { favoriteCodes, codes: favoriteCodes.slice(), defaultCode };
}

export function resetGlyphSettings() {
  const favoriteCodes = defaultGlyphCodes();
  const settings = { favoriteCodes, codes: favoriteCodes.slice(), defaultCode: DEFAULT_CODE };
  localStorage.setItem(STORE_KEY, JSON.stringify({ model: 2, favoriteCodes, defaultCode: DEFAULT_CODE }));
  return settings;
}

export function codeToChar(code) {
  const clean = normalizeGlyphCode(code) || DEFAULT_CODE;
  return String.fromCodePoint(parseInt(clean, 16));
}

export function unicodeAddress(code) {
  const clean = normalizeGlyphCode(code) || DEFAULT_CODE;
  return `U+${clean}`;
}

export function codePointToUnicodeEscapes(code) {
  const clean = normalizeGlyphCode(code);
  if (!clean) return null;
  const cp = Number.parseInt(clean, 16);
  if (cp <= 0xFFFF) return `\\u${clean.padStart(4, '0')}`;
  const shifted = cp - 0x10000;
  const hi = 0xD800 + (shifted >> 10);
  const lo = 0xDC00 + (shifted & 0x3FF);
  return `\\u${hi.toString(16).toUpperCase()}\\u${lo.toString(16).toUpperCase()}`;
}

export function shouldEncodeUnicodeCodePoint(cp) {
  return cp === 0x2060 || (cp >= 0xE000 && cp <= 0xF8FF) || (cp >= 0xFF00 && cp <= 0xFFBF);
}
