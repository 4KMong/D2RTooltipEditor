export const COLOR_PREFIX = 'ÿc';
export const DEFAULT_COLOR_CODE = 'ÿc0';

export const DEFAULT_COLOR_PALETTE = Object.freeze([
  { code: 'ÿc0', name: '기본', hex: '#FFFFFF', memo: '기본 복귀' },
  { code: 'ÿcE', name: '백색', hex: '#F0F0F0', memo: '일반 흰색' },
  { code: 'ÿc5', name: '회색', hex: '#6D6D6D', memo: '회색' },
  { code: 'ÿc6', name: '검정', hex: '#010101', memo: '검정' },
  { code: 'ÿc1', name: '빨강', hex: '#FF5151', memo: '빨강' },
  { code: 'ÿcV', name: '진홍', hex: '#FF0101', memo: '화염 / 강한 빨강' },
  { code: 'ÿcT', name: '적갈', hex: '#D14242', memo: '생명력' },
  { code: 'ÿc8', name: '주황', hex: '#FFAA01', memo: '스킬 / 마법 / 주황' },
  { code: 'ÿc4', name: '금색', hex: '#C9B57A', memo: '금색' },
  { code: 'ÿc7', name: '소색', hex: '#D1C480', memo: '물리 / 방어' },
  { code: 'ÿc9', name: '노랑', hex: '#FFFF68', memo: '번개 / 노랑' },
  { code: 'ÿcS', name: '미색', hex: '#FFFF79', memo: '달리기 / 발차기' },
  { code: 'ÿc2', name: '초록', hex: '#01FF01', memo: '수치 / 초록' },
  { code: 'ÿc<', name: '녹색', hex: '#01CA01', memo: '초록' },
  { code: 'ÿcA', name: '진녹', hex: '#018301', memo: '독' },
  { code: 'ÿcO', name: '청록', hex: '#08A8DE', memo: '마나 회복 / 충전' },
  { code: 'ÿcU', name: '하늘', hex: '#85C7FF', memo: '냉기 / 빙결' },
  { code: 'ÿcQ', name: '연청', hex: '#ACACFF', memo: '마나' },
  { code: 'ÿc3', name: '파랑', hex: '#6F78FF', memo: '매직 옵션 기본색' },
  { code: 'ÿc;', name: '보라', hex: '#B001FF', memo: '강타 / 치명 / 패캐' },
  { code: 'ÿcM', name: '자주', hex: '#9F4FFC', memo: '속도류' },
  { code: 'ÿcP', name: '분홍', hex: '#FF83FF', memo: '모든 저항 / 핑크' },
]);

const SHIFT_TO_BASE_KEY = Object.freeze({
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
});

function normalizeHexColor(value, fallback = '#FFFFFF') {
  const raw = String(value ?? '').trim().replace(/^#/, '').replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
  return raw.length === 6 ? `#${raw.toUpperCase()}` : fallback;
}

function trimLimitedText(value, fallback, limit) {
  if (value === undefined || value === null) return String(fallback || '').slice(0, limit);
  const text = String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return text.slice(0, limit);
}

export function normalizeColorKey(value, fallback = '0') {
  const raw = String(value ?? '').replace(/^ÿc/, '');
  for (const ch of raw) {
    if (ch && !/\s/u.test(ch)) return ch;
  }
  return String(fallback ?? '').slice(0, 1);
}

export function normalizeFnShortcut(value, fallback = '') {
  const raw = String(value ?? '').trim().toUpperCase().replace(/^FN(\d{1,2})$/, 'F$1');
  const match = /^F([1-9]|10|11|12)$/.exec(raw);
  return match ? `F${match[1]}` : String(fallback || '');
}
export function isFnShortcut(value) { return !!normalizeFnShortcut(value, ''); }
export function fnShortcutNumber(value) {
  const fn = normalizeFnShortcut(value, '');
  return fn ? Number.parseInt(fn.slice(1), 10) || 0 : 0;
}
export function colorShortcutDisplay(item = {}) {
  const fn = normalizeFnShortcut(item.shortcutKey, '');
  return fn || normalizeColorKey(item.key, '');
}

export function colorCodeFromKey(key) {
  const normalized = normalizeColorKey(key, '');
  return normalized ? `${COLOR_PREFIX}${normalized}` : '';
}
export function colorKeyFromCode(code) { return normalizeColorKey(String(code ?? '').replace(/^ÿc/, ''), ''); }

export function defaultColorLinks() {
  return DEFAULT_COLOR_PALETTE.map(item => ({ ...item, key: colorKeyFromCode(item.code) }));
}

export function normalizeColorLinks(value) {
  const source = Array.isArray(value) ? value : defaultColorLinks();
  const defaults = defaultColorLinks();
  const fallbackByKey = new Map(defaults.map(item => [item.key, item]));
  const used = new Set();
  const usedFn = new Set();
  const result = [];
  for (let i = 0; i < source.length; i++) {
    const raw = source[i] && typeof source[i] === 'object' ? source[i] : {};
    const fallback = defaults[Math.min(i, DEFAULT_COLOR_PALETTE.length - 1)] || defaults[0];
    const rawKeyValue = raw.key ?? raw.code;
    const legacyFnInKey = normalizeFnShortcut(rawKeyValue, '');
    let key = legacyFnInKey ? normalizeColorKey(fallback.key, '') : normalizeColorKey(rawKeyValue, '');
    if (key && used.has(key)) key = normalizeColorKey(fallback.key, '');
    if (key && used.has(key)) {
      const spare = defaults.find(item => !used.has(item.key));
      key = spare ? spare.key : '';
    }
    if (key) used.add(key);
    let shortcutKey = normalizeFnShortcut(raw.shortcutKey ?? raw.fnShortcut ?? raw.shortcut?.key ?? legacyFnInKey, '');
    if (shortcutKey && usedFn.has(shortcutKey)) shortcutKey = '';
    if (shortcutKey) usedFn.add(shortcutKey);
    const code = colorCodeFromKey(key);
    const previous = (key && fallbackByKey.get(key)) || fallback;
    result.push({
      code,
      key,
      shortcutKey,
      name: trimLimitedText(raw.name, previous.name || '색상', 5),
      hex: normalizeHexColor(raw.hex, previous.hex || '#FFFFFF'),
      memo: normalizeColorMemo(raw.memo ?? previous.memo ?? ''),
    });
  }
  return result.map(item => ({ ...item, code: colorCodeFromKey(item.key), shortcutKey: normalizeFnShortcut(item.shortcutKey, '') }));
}

export function normalizeColorMemo(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n').slice(0, 2).map(line => line.trim().slice(0, 15));
  return lines.filter((line, index) => line || index === 0).join('\n').trim();
}

export function getActiveColorPalette(preferences = {}) {
  return normalizeColorLinks(preferences?.colorLinks).filter(item => item.key && item.code && String(item.name || '').trim());
}

export function getToolbarColorPalette(preferences = {}) {
  const palette = getActiveColorPalette(preferences);
  const fnItems = [];
  const normalItems = [];
  for (const item of palette) {
    if (normalizeFnShortcut(item.shortcutKey, '')) fnItems.push(item);
    else normalItems.push(item);
  }
  fnItems.sort((a, b) => {
    const n = fnShortcutNumber(a.shortcutKey) - fnShortcutNumber(b.shortcutKey);
    if (n) return n;
    return palette.indexOf(a) - palette.indexOf(b);
  });
  return { fnItems, normalItems, items: [...fnItems, ...normalItems], hasFn: fnItems.length > 0 };
}

export function getColorByCode(code, preferences = {}) {
  const palette = getActiveColorPalette(preferences);
  return palette.find(item => item.code === code) || null;
}

export function isActiveColorCode(code, preferences = {}) {
  return !!getColorByCode(code, preferences);
}

function normalizeShortcutKey(key) { return String(key || '').toUpperCase(); }
function unshiftedShortcutKey(key) {
  const text = String(key || '');
  const base = SHIFT_TO_BASE_KEY[text] || SHIFT_TO_BASE_KEY[text.toUpperCase()] || text;
  return normalizeShortcutKey(base);
}

export function getColorFnShortcutMap(preferences = {}) {
  const palette = getActiveColorPalette(preferences);
  const map = new Map();
  for (const item of palette) {
    const fn = normalizeFnShortcut(item.shortcutKey, '');
    if (fn && !map.has(fn)) map.set(fn, item.code);
  }
  return map;
}

export function getColorShortcutMaps(preferences = {}) {
  const palette = getActiveColorPalette(preferences);
  const exact = new Map();
  for (const item of palette) {
    if (normalizeFnShortcut(item.shortcutKey, '')) continue;
    const key = normalizeShortcutKey(item.key);
    if (key) exact.set(key, item.code);
  }
  const ignoreShift = new Map();
  const bucket = new Map();
  if (preferences?.colorShortcutIgnoreShift !== false) {
    for (const item of palette) {
      if (normalizeFnShortcut(item.shortcutKey, '')) continue;
      const exactKey = normalizeShortcutKey(item.key);
      const baseKey = unshiftedShortcutKey(item.key);
      if (!baseKey || baseKey === exactKey) continue;
      const list = bucket.get(baseKey) || [];
      list.push(item.code);
      bucket.set(baseKey, list);
    }
    for (const [baseKey, codes] of bucket.entries()) {
      if (codes.length !== 1) continue;
      if (exact.has(baseKey)) continue;
      ignoreShift.set(baseKey, codes[0]);
    }
  }
  return { exact, ignoreShift };
}
