import { shouldEncodeUnicodeCodePoint } from './unicodeStore.js';

export function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function formatCopyLineBreaks(text, useLineBreakLiterals = true) {
  const normalized = normalizeNewlines(text);
  return useLineBreakLiterals !== false
    ? normalized.replace(/\n/g, '\\n')
    : normalized.replace(/\\n/g, '\n');
}

function isHex4(s) { return /^[0-9a-fA-F]{4}$/.test(s); }

export function documentToCodeText(documentText) {
  let out = '';
  for (const ch of normalizeNewlines(documentText)) {
    if (ch === '\n') { out += '\\n'; continue; }
    const cp = ch.codePointAt(0);
    if (shouldEncodeUnicodeCodePoint(cp)) out += '\\u' + cp.toString(16).toUpperCase().padStart(4, '0');
    else out += ch;
  }
  return out;
}

export function codeTextToDocument(codeText) {
  const oneLineCode = normalizeNewlines(codeText).replace(/\n/g, '\\n');
  let out = '';
  for (let i = 0; i < oneLineCode.length; i++) {
    if (oneLineCode[i] === '\\' && oneLineCode[i + 1] === 'n') {
      out += '\n';
      i++;
      continue;
    }
    if (oneLineCode[i] === '\\' && oneLineCode[i + 1] === 'u' && isHex4(oneLineCode.slice(i + 2, i + 6))) {
      out += String.fromCodePoint(parseInt(oneLineCode.slice(i + 2, i + 6), 16));
      i += 5;
      continue;
    }
    out += oneLineCode[i];
  }
  return out;
}

export function documentTextToSaveText(documentText) {
  return documentToCodeText(documentText);
}

export function countEditorLines(documentText) {
  return normalizeNewlines(documentText).split('\n').length;
}

export function lineStartOffset(text, lineNumber) {
  const normalized = normalizeNewlines(text);
  const target = Math.max(1, Number.parseInt(lineNumber, 10) || 1);
  if (target <= 1) return 0;
  let line = 1;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '\n') {
      line++;
      if (line === target) return i + 1;
    }
  }
  return normalized.length;
}

export function lineEndOffset(text, lineNumber) {
  const normalized = normalizeNewlines(text);
  const start = lineStartOffset(normalized, lineNumber);
  const next = normalized.indexOf('\n', start);
  return next < 0 ? normalized.length : next;
}

export function offsetToLineNumber(text, offset) {
  const normalized = normalizeNewlines(text);
  const end = Math.max(0, Math.min(Number(offset) || 0, normalized.length));
  let line = 1;
  for (let i = 0; i < end; i++) if (normalized[i] === '\n') line++;
  return line;
}

export function codeOffsetToEditorLine(codeText, offset) {
  const text = String(codeText ?? '');
  const end = Math.max(0, Math.min(Number(offset) || 0, text.length));
  let line = 1;
  for (let i = 0; i < end; i++) {
    if (text[i] === '\\' && text[i + 1] === 'n') { line++; i++; continue; }
    if (text[i] === '\\' && text[i + 1] === 'u' && isHex4(text.slice(i + 2, i + 6))) { i += 5; continue; }
  }
  return line;
}

export function editorLineToCodeOffset(documentText, lineNumber) {
  const normalized = normalizeNewlines(documentText);
  const target = Math.max(1, Number.parseInt(lineNumber, 10) || 1);
  let line = 1;
  let codeOffset = 0;
  for (const ch of normalized) {
    if (line === target) return codeOffset;
    if (ch === '\n') { line++; codeOffset += 2; }
    else {
      const cp = ch.codePointAt(0);
      codeOffset += shouldEncodeUnicodeCodePoint(cp) ? 6 : ch.length;
    }
  }
  return codeOffset;
}


export function codeOffsetToDocumentOffset(codeText, offset) {
  const text = normalizeNewlines(codeText).replace(/\n/g, '\\n');
  const end = Math.max(0, Math.min(Number(offset) || 0, text.length));
  let docOffset = 0;
  for (let i = 0; i < end; i++) {
    if (text[i] === '\\' && text[i + 1] === 'n') {
      docOffset += 1;
      i += 1;
      continue;
    }
    if (text[i] === '\\' && text[i + 1] === 'u' && isHex4(text.slice(i + 2, i + 6))) {
      docOffset += 1;
      i += 5;
      continue;
    }
    docOffset += 1;
  }
  return docOffset;
}

export function documentOffsetToCodeOffset(documentText, offset) {
  const normalized = normalizeNewlines(documentText);
  const end = Math.max(0, Math.min(Number(offset) || 0, normalized.length));
  let codeOffset = 0;
  for (let i = 0; i < end; i++) {
    const ch = normalized[i];
    if (ch === '\n') { codeOffset += 2; continue; }
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) i++;
    codeOffset += shouldEncodeUnicodeCodePoint(cp) ? 6 : ch.length;
  }
  return codeOffset;
}
