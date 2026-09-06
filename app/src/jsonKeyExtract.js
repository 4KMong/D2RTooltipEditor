export const JSON_KEY_EXTRACT_LANGUAGES = Object.freeze([
  'koKR',
  'enUS',
  'zhTW',
  'deDE',
  'esES',
  'frFR',
  'itIT',
  'plPL',
  'esMX',
  'jaJP',
  'ptBR',
  'ruRU',
  'zhCN',
]);

export const DEFAULT_JSON_KEY_EXTRACT_LANGUAGE = 'koKR';

export function normalizeJsonKeyExtractLanguage(value) {
  const text = String(value || '').trim();
  return JSON_KEY_EXTRACT_LANGUAGES.includes(text) ? text : DEFAULT_JSON_KEY_EXTRACT_LANGUAGE;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

export function jsonKeyExtractLanguageOptionsHtml({ selected = DEFAULT_JSON_KEY_EXTRACT_LANGUAGE, defaultLanguage = DEFAULT_JSON_KEY_EXTRACT_LANGUAGE } = {}) {
  const normalizedSelected = normalizeJsonKeyExtractLanguage(selected);
  const normalizedDefault = normalizeJsonKeyExtractLanguage(defaultLanguage);
  return JSON_KEY_EXTRACT_LANGUAGES.map(lang => {
    const mark = lang === normalizedDefault ? ' (기본값)' : '';
    return `<option value="${escapeHtml(lang)}" ${lang === normalizedSelected ? 'selected' : ''}>${escapeHtml(lang + mark)}</option>`;
  }).join('');
}

function parseJsonStringLiteral(source, quoteIndex) {
  const text = String(source ?? '');
  if (text[quoteIndex] !== '"') return null;
  let escaped = false;
  for (let i = quoteIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') {
      const literal = text.slice(quoteIndex, i + 1);
      try { return { value: JSON.parse(literal), end: i + 1 }; }
      catch (_) { return null; }
    }
  }
  return null;
}

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

export function extractJsonKeyValues(source, key) {
  const text = String(source ?? '');
  const wanted = normalizeJsonKeyExtractLanguage(key);
  const values = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') { i++; continue; }
    const keyLiteral = parseJsonStringLiteral(text, i);
    if (!keyLiteral) { i++; continue; }
    let next = skipWhitespace(text, keyLiteral.end);
    if (text[next] !== ':') {
      i = keyLiteral.end;
      continue;
    }
    next = skipWhitespace(text, next + 1);
    if (keyLiteral.value === wanted && text[next] === '"') {
      const valueLiteral = parseJsonStringLiteral(text, next);
      if (valueLiteral) {
        values.push(String(valueLiteral.value ?? ''));
        i = valueLiteral.end;
        continue;
      }
    }
    i = keyLiteral.end;
  }
  return values;
}
