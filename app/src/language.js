import { getPreferences, setPreferences } from './preferences.js';
import { isTauriAvailable, setNativeUiLanguage } from './fileApi.js';
import { setRuntimeUiLanguage } from './uiLanguageRuntime.js';

const LANGUAGE_ASSETS = Object.freeze({
  ko: './assets/Korean.lng',
  en: './assets/English.lng',
});
const SUPPORTED_LANGUAGES = new Set(Object.keys(LANGUAGE_ASSETS));
const TRANSLATABLE_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'data-tooltip', 'data-tip', 'data-input-hint'];
const SKIP_SELECTOR = [
  'script', 'style', 'textarea', 'code', 'pre',
  '[data-i18n-skip]',
  '.recent-item-name', '.recent-item-path',
  '.document-tab', '.document-tab-title', '.editor-file-name',
  '.recent-open-button', '.recent-item-row',
].join(',');

let activeLanguage = 'ko';
let packs = new Map();
let observer = null;
let applying = false;
const textRecords = new WeakMap();
const attributeRecords = new WeakMap();

function normalizeLanguage(value) {
  return SUPPORTED_LANGUAGES.has(String(value || '').toLowerCase())
    ? String(value).toLowerCase()
    : 'ko';
}

async function loadPack(code) {
  const normalized = normalizeLanguage(code);
  if (packs.has(normalized)) return packs.get(normalized);
  const response = await fetch(LANGUAGE_ASSETS[normalized], { cache: 'no-cache' });
  if (!response.ok) throw new Error(`language asset load failed: ${normalized} (${response.status})`);
  const pack = await response.json();
  if (pack?.format !== 'TTE_LANGUAGE_V1' || pack?.code !== normalized) {
    throw new Error(`invalid language asset: ${normalized}`);
  }
  const compiled = {
    ...pack,
    strings: pack.strings && typeof pack.strings === 'object' ? pack.strings : {},
    replacements: Array.isArray(pack.replacements)
      ? pack.replacements
          .filter(row => Array.isArray(row) && row.length >= 2 && row[0])
          .map(([source, target]) => [String(source), String(target)])
          .sort((a, b) => b[0].length - a[0].length)
      : [],
    patterns: Array.isArray(pack.patterns)
      ? pack.patterns
          .filter(row => Array.isArray(row) && row.length >= 2)
          .sort((a, b) => {
            const sourceA = String(a[0]);
            const sourceB = String(b[0]);
            const broadA = (sourceA.match(/\(\.\+\)|\(\.\*\)|\[\\s\\S\]\+/g) || []).length;
            const broadB = (sourceB.match(/\(\.\+\)|\(\.\*\)|\[\\s\\S\]\+/g) || []).length;
            if (broadA !== broadB) return broadA - broadB;
            const alternativesA = (sourceA.match(/\|/g) || []).length;
            const alternativesB = (sourceB.match(/\|/g) || []).length;
            if (alternativesA !== alternativesB) return alternativesA - alternativesB;
            return sourceB.length - sourceA.length;
          })
          .flatMap(row => {
            try {
              const replacement = String(row[1]).replace(/\\+([1-9][0-9]*)/g, (_, index) => `$${index}`);
              return [[new RegExp(String(row[0]), 'u'), replacement]];
            }
            catch (_) { return []; }
          })
      : [],
  };
  packs.set(normalized, compiled);
  return compiled;
}

function preserveOuterWhitespace(source, translated) {
  const match = String(source).match(/^(\s*)([\s\S]*?)(\s*)$/u);
  if (!match) return translated;
  return `${match[1]}${translated}${match[3]}`;
}

export function translateUiText(value, language = activeLanguage) {
  const source = String(value ?? '');
  const code = normalizeLanguage(language);
  if (code === 'ko' || !source || !/[가-힣]/u.test(source)) return source;
  const pack = packs.get(code);
  if (!pack) return source;

  const trimmed = source.trim();
  if (!trimmed) return source;
  const exact = pack.strings[trimmed];
  if (typeof exact === 'string') return preserveOuterWhitespace(source, exact);

  for (const [pattern, replacement] of pack.patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(trimmed)) {
      pattern.lastIndex = 0;
      return preserveOuterWhitespace(source, trimmed.replace(pattern, replacement));
    }
  }

  let result = trimmed;
  for (const [from, to] of pack.replacements) {
    if (result.includes(from)) result = result.split(from).join(to);
  }
  result = result
    .replace(/[ \t]+([,.:;!?%)])/gu, '$1')
    .replace(/([(])[ \t]+/gu, '$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
  return preserveOuterWhitespace(source, result);
}

function shouldSkipElement(element) {
  return !element || element.matches?.(SKIP_SELECTOR) || !!element.closest?.(SKIP_SELECTOR);
}

function translateTextNode(node) {
  const parent = node.parentElement;
  if (!parent || shouldSkipElement(parent)) return;
  const current = String(node.nodeValue ?? '');
  let record = textRecords.get(node);
  if (!record || current !== record.lastRendered) {
    record = { source: current, lastRendered: current };
  }
  const next = translateUiText(record.source);
  if (current !== next) node.nodeValue = next;
  record.lastRendered = next;
  textRecords.set(node, record);
}

function translateElementAttributes(element) {
  if (!element || shouldSkipElement(element)) return;
  let records = attributeRecords.get(element);
  if (!records) records = new Map();
  for (const name of TRANSLATABLE_ATTRIBUTES) {
    if (!element.hasAttribute(name)) continue;
    const current = element.getAttribute(name) ?? '';
    let record = records.get(name);
    if (!record || current !== record.lastRendered) record = { source: current, lastRendered: current };
    const next = translateUiText(record.source);
    if (current !== next) element.setAttribute(name, next);
    record.lastRendered = next;
    records.set(name, record);
  }
  attributeRecords.set(element, records);
}

function translateSubtree(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) translateElementAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
    else translateElementAttributes(node);
    node = walker.nextNode();
  }
}

function updateLanguageMenuChecks() {
  document.querySelectorAll('[data-language-code]').forEach(button => {
    const selected = button.dataset.languageCode === activeLanguage;
    button.classList.toggle('current-language', selected);
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
  });
}

function updateDocumentLanguage() {
  document.documentElement.lang = activeLanguage === 'en' ? 'en' : 'ko';
  document.title = activeLanguage === 'en' ? 'D2R Tooltip Editor' : 'D2R 툴팁편집기';
  const root = document.documentElement;
  root.dataset.uiLanguage = activeLanguage;
  root.style.setProperty('--drop-open-text', activeLanguage === 'en' ? '"Drop File to Open"' : '"파일을 놓으면 열기"');
  root.style.setProperty('--large-mode-suffix', activeLanguage === 'en' ? '"  (Large-File Mode)"' : '"  (대용량 모드)"');
}

function applyCurrentLanguage(root = document.documentElement) {
  if (applying) return;
  applying = true;
  try {
    updateDocumentLanguage();
    translateSubtree(root);
    updateLanguageMenuChecks();
  } finally {
    applying = false;
  }
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(mutations => {
    if (applying) return;
    applying = true;
    try {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') translateTextNode(mutation.target);
        else if (mutation.type === 'attributes') translateElementAttributes(mutation.target);
        else {
          for (const node of mutation.addedNodes) translateSubtree(node);
        }
      }
      updateLanguageMenuChecks();
    } finally {
      applying = false;
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRIBUTES,
  });
}

async function syncNativeLanguage() {
  if (!isTauriAvailable()) return;
  try { await setNativeUiLanguage(activeLanguage); }
  catch (error) { console.warn('native language sync failed', error); }
}

export async function initLanguage() {
  try {
    await loadPack('ko');
  } catch (error) {
    console.warn('Korean language asset initialization failed; source UI remains available', error);
  }
  const requested = normalizeLanguage(getPreferences().uiLanguage);
  if (requested === 'en') {
    try { await loadPack('en'); }
    catch (error) {
      console.warn('English language asset initialization failed; falling back to Korean', error);
      setPreferences({ uiLanguage: 'ko' });
    }
  } else {
    loadPack('en').catch(error => console.warn('English language asset preload failed', error));
  }
  activeLanguage = requested === 'en' && packs.has('en') ? 'en' : 'ko';
  setRuntimeUiLanguage(activeLanguage, value => translateUiText(value, activeLanguage));
  applyCurrentLanguage();
  startObserver();
  await syncNativeLanguage();
  document.dispatchEvent(new CustomEvent('tooltipeditor:language-changed', {
    detail: { language: activeLanguage },
  }));
}

export async function setUiLanguage(language) {
  const next = normalizeLanguage(language);
  if (next === activeLanguage) {
    updateLanguageMenuChecks();
    return activeLanguage;
  }
  await loadPack(next);
  activeLanguage = next;
  setRuntimeUiLanguage(activeLanguage, value => translateUiText(value, activeLanguage));
  applyCurrentLanguage();
  await syncNativeLanguage();
  setPreferences({ uiLanguage: next });
  document.dispatchEvent(new CustomEvent('tooltipeditor:language-changed', {
    detail: { language: activeLanguage },
  }));
  return activeLanguage;
}

export function getUiLanguage() {
  return activeLanguage;
}

export function getLocalizedHelpText() {
  return String(packs.get(activeLanguage)?.help || packs.get('ko')?.help || '');
}

export function retranslateUi(root = document.documentElement) {
  applyCurrentLanguage(root);
}
