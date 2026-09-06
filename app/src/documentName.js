export const DEFAULT_NEW_DOCUMENT_PREFIX_KO = '새 문서 ';
export const DEFAULT_NEW_DOCUMENT_PREFIX_EN = 'New ';
export const LEGACY_NEW_DOCUMENT_PREFIX_EN = 'New Document ';

const SYSTEM_PREFIXES = [
  DEFAULT_NEW_DOCUMENT_PREFIX_KO,
  DEFAULT_NEW_DOCUMENT_PREFIX_EN,
  LEGACY_NEW_DOCUMENT_PREFIX_EN,
];

export function localizedDefaultNewDocumentPrefix(language = 'ko') {
  return language === 'en' ? DEFAULT_NEW_DOCUMENT_PREFIX_EN : DEFAULT_NEW_DOCUMENT_PREFIX_KO;
}

export function isSystemDefaultNewDocumentPrefix(value = '') {
  return SYSTEM_PREFIXES.includes(String(value ?? ''));
}

function splitTxtExtension(name = '') {
  const text = String(name ?? '');
  return /\.txt$/i.test(text)
    ? { stem: text.slice(0, -4), extension: text.slice(-4) }
    : { stem: text, extension: '' };
}

export function systemNewDocumentSuffix(name = '') {
  const { stem } = splitTxtExtension(name);
  for (const prefix of SYSTEM_PREFIXES) {
    if (!stem.startsWith(prefix)) continue;
    const suffix = stem.slice(prefix.length);
    if (/^[0-9]{1,4}$/u.test(suffix) || /^[0-9a-z]+$/u.test(suffix)) return suffix;
  }
  return null;
}

export function isSystemGeneratedNewDocumentName(name = '') {
  return systemNewDocumentSuffix(name) !== null;
}

export function localizeSystemGeneratedNewDocumentName(name = '', language = 'ko') {
  const text = String(name ?? '');
  const suffix = systemNewDocumentSuffix(text);
  if (suffix === null) return text;
  const { extension } = splitTxtExtension(text);
  return `${localizedDefaultNewDocumentPrefix(language)}${suffix}${extension}`;
}
