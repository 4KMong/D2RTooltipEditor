import { normalizeNewlines } from './textCodec.js';
import { DEFAULT_COLOR_PALETTE } from './colorPalette.js';

export const COLOR_PREFIX = 'ÿc';
export const DEFAULT_COLOR_CODE = 'ÿc0';
export const COLOR_CODE_LENGTH = 3;

let recognizedColorCodes = new Set(DEFAULT_COLOR_PALETTE.map(item => item.code));

export function setRecognizedColorCodes(codes = []) {
  const next = Array.from(codes || []).filter(code => isColorCodeAt(code, 0));
  recognizedColorCodes = new Set(next.length ? next : DEFAULT_COLOR_PALETTE.map(item => item.code));
}

export function isRecognizedColorCodeAt(text, index) {
  const code = colorCodeAt(text, index);
  return !!code && recognizedColorCodes.has(code);
}

export function recognizedColorCodeAt(text, index) {
  return isRecognizedColorCodeAt(text, index) ? colorCodeAt(text, index) : null;
}

export function isColorCodeAt(text, index) {
  const source = String(text ?? '');
  return source.startsWith(COLOR_PREFIX, index) && index + COLOR_CODE_LENGTH <= source.length;
}

export function colorCodeAt(text, index) {
  return isColorCodeAt(text, index) ? String(text).slice(index, index + COLOR_CODE_LENGTH) : null;
}

export function isVisibleColorTargetChar(ch) {
  if (!ch) return false;
  // 색상 적용 대상에서 제외하는 것은 Unicode whitespace 계열만이다.
  // U+2060 WORD JOINER처럼 폭이 0인 format 문자는 화면 폭이 없어도 실제 삽입 문자라서 색상 대상에 포함한다.
  return !/\s/u.test(ch);
}

export function stripColorCodes(text) {
  const source = normalizeNewlines(text);
  let out = '';
  for (let i = 0; i < source.length; i++) {
    if (isRecognizedColorCodeAt(source, i)) { i += COLOR_CODE_LENGTH - 1; continue; }
    out += source[i];
  }
  return out;
}

export function containsColorCodes(text) {
  const source = normalizeNewlines(text);
  for (let i = 0; i < source.length; i++) {
    if (isRecognizedColorCodeAt(source, i)) return true;
  }
  return false;
}

export function documentToEditorText(documentText) { return stripColorCodes(documentText); }

function hasVisibleColorTarget(text = '') {
  return Array.from(String(text ?? '')).some(isVisibleColorTargetChar);
}

export function parseColoredCharacters(documentText) {
  const source = normalizeNewlines(documentText);
  const chars = [];
  let active = DEFAULT_COLOR_CODE;
  for (let i = 0; i < source.length; i++) {
    if (isRecognizedColorCodeAt(source, i)) {
      active = recognizedColorCodeAt(source, i) || active;
      i += COLOR_CODE_LENGTH - 1;
      continue;
    }
    chars.push({ ch: source[i], color: active });
  }
  return chars;
}

export function serializeColoredCharacters(chars = []) {
  let out = '';
  let active = DEFAULT_COLOR_CODE;
  let pendingColor = null;
  for (const item of chars) {
    const ch = String(item?.ch ?? '');
    if (!ch) continue;
    const color = isColorCodeAt(item?.color || '', 0) ? item.color : DEFAULT_COLOR_CODE;
    if (color !== active) pendingColor = color;
    else pendingColor = null;
    if (pendingColor && isVisibleColorTargetChar(ch)) {
      out += pendingColor;
      active = pendingColor;
      pendingColor = null;
    }
    out += ch;
  }
  return out;
}

export function cleanupColorTokensFromRuns(documentText) { return serializeColoredCharacters(parseColoredCharacters(documentText)); }

export function editorOffsetToDocumentOffset(documentText, editorOffset) {
  const source = normalizeNewlines(documentText);
  const wanted = Math.max(0, Number(editorOffset) || 0);
  let visible = 0;
  for (let i = 0; i < source.length; i++) {
    if (isRecognizedColorCodeAt(source, i)) { i += COLOR_CODE_LENGTH - 1; continue; }
    if (visible >= wanted) return i;
    visible += 1;
  }
  return source.length;
}

export function documentOffsetToEditorOffset(documentText, documentOffset) {
  const source = normalizeNewlines(documentText);
  const end = Math.max(0, Math.min(Number(documentOffset) || 0, source.length));
  let visible = 0;
  for (let i = 0; i < end; i++) {
    if (isRecognizedColorCodeAt(source, i)) {
      if (end < i + COLOR_CODE_LENGTH) return visible;
      i += COLOR_CODE_LENGTH - 1;
      continue;
    }
    visible += 1;
  }
  return visible;
}

function normalizeVisibleRange(start, end, max) {
  const a = Math.max(0, Math.min(Number(start) || 0, max));
  const b = Math.max(0, Math.min(Number(end) || a, max));
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function activeColorAtEditorOffset(documentText, editorOffset) {
  const source = normalizeNewlines(documentText);
  const wanted = Math.max(0, Number(editorOffset) || 0);
  let visible = 0;
  let active = DEFAULT_COLOR_CODE;
  for (let i = 0; i < source.length; i++) {
    if (isRecognizedColorCodeAt(source, i)) {
      if (visible <= wanted) active = recognizedColorCodeAt(source, i) || active;
      i += COLOR_CODE_LENGTH - 1;
      continue;
    }
    if (visible >= wanted) break;
    visible += 1;
  }
  return active;
}

export function replaceEditorVisibleRangeInDocument(documentText, editorStart, editorEnd, replacement = '', options = {}) {
  const source = normalizeNewlines(documentText);
  const chars = parseColoredCharacters(source);
  const range = normalizeVisibleRange(editorStart, editorEnd, chars.length);
  const insert = normalizeNewlines(replacement);
  const forcedColor = options.forceColorCode || '';
  const hasVisibleInsert = hasVisibleColorTarget(insert);
  const boundaryColor = activeColorAtEditorOffset(source, range.start);
  const inheritedColor = boundaryColor || (range.start > 0
    ? chars[range.start - 1]?.color || DEFAULT_COLOR_CODE
    : chars[range.start]?.color || DEFAULT_COLOR_CODE);
  const insertColor = isColorCodeAt(forcedColor, 0)
    ? forcedColor
    : (options.newInputDefaultColor && hasVisibleInsert ? DEFAULT_COLOR_CODE : inheritedColor);
  const insertChars = Array.from(insert).map(ch => ({ ch, color: insertColor }));
  const nextChars = chars.slice(0, range.start).concat(insertChars, chars.slice(range.end));
  return serializeColoredCharacters(nextChars);
}

export function replaceEditorVisibleRangeWithDocumentFragment(documentText, editorStart, editorEnd, fragmentDocumentText = '') {
  const source = normalizeNewlines(documentText);
  const chars = parseColoredCharacters(source);
  const range = normalizeVisibleRange(editorStart, editorEnd, chars.length);
  const insertChars = parseColoredCharacters(normalizeNewlines(fragmentDocumentText));
  const nextChars = chars.slice(0, range.start).concat(insertChars, chars.slice(range.end));
  return serializeColoredCharacters(nextChars);
}

function visibleDiff(beforeVisible, afterVisible) {
  let prefix = 0;
  const minLength = Math.min(beforeVisible.length, afterVisible.length);
  while (prefix < minLength && beforeVisible[prefix] === afterVisible[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeVisible.length - prefix &&
    suffix < afterVisible.length - prefix &&
    beforeVisible[beforeVisible.length - 1 - suffix] === afterVisible[afterVisible.length - 1 - suffix]
  ) suffix += 1;
  return { prefix, beforeEnd: beforeVisible.length - suffix, replacement: afterVisible.slice(prefix, afterVisible.length - suffix) };
}

function selectionFromOptions(options = {}) {
  const sel = options.beforeSelection || options.selection || null;
  if (!sel) return null;
  const start = Math.max(0, Number(sel.start) || 0);
  const end = Math.max(start, Number(sel.end ?? sel.start) || start);
  return { start, end };
}

function anchoredReplacement(beforeVisible, afterVisible, start, end) {
  const prefix = beforeVisible.slice(0, start);
  const suffix = beforeVisible.slice(end);
  if (afterVisible.startsWith(prefix) && afterVisible.endsWith(suffix) && afterVisible.length >= prefix.length + suffix.length) {
    return afterVisible.slice(prefix.length, afterVisible.length - suffix.length);
  }
  return null;
}

function rangeForInputType(inputType, selection, oldLength) {
  if (!selection) return null;
  const type = String(inputType || '');
  let { start, end } = normalizeVisibleRange(selection.start, selection.end, oldLength);
  if (start !== end) return { start, end };
  if (type === 'deleteContentBackward') return { start: Math.max(0, start - 1), end: start };
  if (type === 'deleteWordBackward' || type === 'deleteHardLineBackward' || type === 'deleteSoftLineBackward') return { start: Math.max(0, start - 1), end: start };
  if (type === 'deleteContentForward') return { start, end: Math.min(oldLength, start + 1) };
  if (type === 'deleteWordForward' || type === 'deleteHardLineForward' || type === 'deleteSoftLineForward') return { start, end: Math.min(oldLength, start + 1) };
  return { start, end };
}

export function mergeEditorTextIntoDocument(previousDocumentText, nextEditorText, options = {}) {
  const previous = normalizeNewlines(previousDocumentText);
  const oldChars = parseColoredCharacters(previous);
  const beforeVisible = oldChars.map(item => item.ch).join('');
  const afterVisible = normalizeNewlines(nextEditorText);
  if (beforeVisible === afterVisible) return previous;

  const inputType = String(options.inputType || '');
  const selection = selectionFromOptions(options);
  const range = rangeForInputType(inputType, selection, beforeVisible.length);
  const isDelete = inputType.startsWith('delete');
  const isInsert = inputType.startsWith('insert') || inputType === '';

  if (range && (isDelete || isInsert)) {
    let replacement = '';
    if (!isDelete && typeof options.data === 'string' && options.data.length > 0 && inputType !== 'insertCompositionText') {
      replacement = normalizeNewlines(options.data);
    } else {
      const anchored = anchoredReplacement(beforeVisible, afterVisible, range.start, range.end);
      if (anchored !== null) replacement = anchored;
      else if (!isDelete) replacement = normalizeNewlines(options.data || '');
    }
    if (isDelete || replacement || inputType === 'insertCompositionText' || inputType === 'insertText' || inputType === 'insertReplacementText') {
      return replaceEditorVisibleRangeInDocument(previous, range.start, range.end, replacement, options);
    }
  }

  const diff = visibleDiff(beforeVisible, afterVisible);
  return replaceEditorVisibleRangeInDocument(previous, diff.prefix, diff.beforeEnd, diff.replacement, options);
}
