import { readFontFileDataUrl } from './fileApi.js';
import {
  BUILTIN_FONT_SOURCE,
  BUILTIN_FALLBACK_FONT_SOURCE,
  BUILTIN_FONT_FILE_NAME,
  FALLBACK_FONT_FILE_NAME,
  listSystemFontEntries,
  getFontCssFamily,
} from './fontService.js';

const MAX_CODE_POINT = 0x10FFFF;
const cmapCache = new Map();

function u16(view, offset) {
  if (offset < 0 || offset + 2 > view.byteLength) throw new Error('font data truncated');
  return view.getUint16(offset, false);
}
function i16(view, offset) {
  if (offset < 0 || offset + 2 > view.byteLength) throw new Error('font data truncated');
  return view.getInt16(offset, false);
}
function u32(view, offset) {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error('font data truncated');
  return view.getUint32(offset, false);
}
function tag(view, offset) {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error('font data truncated');
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}
function validCodePoint(cp) {
  return Number.isInteger(cp) && cp >= 0 && cp <= MAX_CODE_POINT && !(cp >= 0xD800 && cp <= 0xDFFF) && cp !== 0xFFFF;
}

function parseFormat0(view, offset, out) {
  const length = u16(view, offset + 2);
  if (length < 262 || offset + length > view.byteLength) return;
  for (let cp = 0; cp < 256; cp++) {
    if (view.getUint8(offset + 6 + cp) !== 0 && validCodePoint(cp)) out.add(cp);
  }
}

function parseFormat4(view, offset, out) {
  const length = u16(view, offset + 2);
  if (length < 16 || offset + length > view.byteLength) return;
  const segCount = u16(view, offset + 6) >> 1;
  if (!segCount || segCount > 0x8000) return;
  const endBase = offset + 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  if (rangeBase + segCount * 2 > offset + length) return;

  for (let i = 0; i < segCount; i++) {
    const end = u16(view, endBase + i * 2);
    const start = u16(view, startBase + i * 2);
    const delta = i16(view, deltaBase + i * 2);
    const rangeOffset = u16(view, rangeBase + i * 2);
    if (start > end) continue;
    for (let cp = start; cp <= end; cp++) {
      if (!validCodePoint(cp)) continue;
      let glyph = 0;
      if (rangeOffset === 0) {
        glyph = (cp + delta) & 0xFFFF;
      } else {
        const rangeWord = rangeBase + i * 2;
        const glyphOffset = rangeWord + rangeOffset + (cp - start) * 2;
        if (glyphOffset + 2 > offset + length) continue;
        glyph = u16(view, glyphOffset);
        if (glyph !== 0) glyph = (glyph + delta) & 0xFFFF;
      }
      if (glyph !== 0) out.add(cp);
    }
  }
}

function parseFormat6(view, offset, out) {
  const length = u16(view, offset + 2);
  if (length < 10 || offset + length > view.byteLength) return;
  const first = u16(view, offset + 6);
  const count = u16(view, offset + 8);
  const glyphBase = offset + 10;
  if (glyphBase + count * 2 > offset + length) return;
  for (let i = 0; i < count; i++) {
    const cp = first + i;
    if (validCodePoint(cp) && u16(view, glyphBase + i * 2) !== 0) out.add(cp);
  }
}

function parseFormat10(view, offset, out) {
  const length = u32(view, offset + 4);
  if (length < 20 || offset + length > view.byteLength) return;
  const first = u32(view, offset + 12);
  const count = u32(view, offset + 16);
  const glyphBase = offset + 20;
  if (count > MAX_CODE_POINT + 1 || glyphBase + count * 2 > offset + length) return;
  for (let i = 0; i < count; i++) {
    const cp = first + i;
    if (validCodePoint(cp) && u16(view, glyphBase + i * 2) !== 0) out.add(cp);
  }
}

function parseFormat12Or13(view, offset, out, constantGlyph = false) {
  const length = u32(view, offset + 4);
  if (length < 16 || offset + length > view.byteLength) return;
  const groups = u32(view, offset + 12);
  if (groups > 0x200000 || offset + 16 + groups * 12 > offset + length) return;
  for (let i = 0; i < groups; i++) {
    const row = offset + 16 + i * 12;
    let start = u32(view, row);
    let end = u32(view, row + 4);
    const glyph = u32(view, row + 8);
    if (start > end || start > MAX_CODE_POINT) continue;
    end = Math.min(end, MAX_CODE_POINT);
    if (constantGlyph && glyph === 0) continue;
    for (let cp = start; cp <= end; cp++) {
      if (!validCodePoint(cp)) continue;
      if (constantGlyph || glyph + (cp - start) !== 0) out.add(cp);
    }
  }
}

function parseCmapTable(view, cmapOffset, out) {
  if (cmapOffset < 0 || cmapOffset + 4 > view.byteLength) return;
  const numTables = u16(view, cmapOffset + 2);
  const recordsEnd = cmapOffset + 4 + numTables * 8;
  if (recordsEnd > view.byteLength) return;
  const parsedSubtables = new Set();
  for (let i = 0; i < numTables; i++) {
    const rec = cmapOffset + 4 + i * 8;
    const platformId = u16(view, rec);
    const encodingId = u16(view, rec + 2);
    const unicodeTable = platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (!unicodeTable) continue;
    const subOffset = cmapOffset + u32(view, rec + 4);
    if (subOffset + 2 > view.byteLength || parsedSubtables.has(subOffset)) continue;
    parsedSubtables.add(subOffset);
    const format = u16(view, subOffset);
    try {
      if (format === 0) parseFormat0(view, subOffset, out);
      else if (format === 4) parseFormat4(view, subOffset, out);
      else if (format === 6) parseFormat6(view, subOffset, out);
      else if (format === 10) parseFormat10(view, subOffset, out);
      else if (format === 12) parseFormat12Or13(view, subOffset, out, false);
      else if (format === 13) parseFormat12Or13(view, subOffset, out, true);
    } catch (_) {
      // Ignore malformed/unsupported duplicate subtables and continue with the others.
    }
  }
}

function parseSfntFace(view, faceOffset, out) {
  if (faceOffset < 0 || faceOffset + 12 > view.byteLength) return;
  const numTables = u16(view, faceOffset + 4);
  const tableEnd = faceOffset + 12 + numTables * 16;
  if (tableEnd > view.byteLength) return;
  for (let i = 0; i < numTables; i++) {
    const rec = faceOffset + 12 + i * 16;
    if (tag(view, rec) !== 'cmap') continue;
    const cmapOffset = u32(view, rec + 8);
    parseCmapTable(view, cmapOffset, out);
  }
}

export function parseFontCmap(buffer) {
  const bytes = buffer instanceof ArrayBuffer
    ? buffer
    : buffer?.buffer instanceof ArrayBuffer
      ? buffer.buffer.slice(buffer.byteOffset || 0, (buffer.byteOffset || 0) + buffer.byteLength)
      : null;
  if (!bytes || bytes.byteLength < 12) throw new Error('invalid font data');
  const view = new DataView(bytes);
  const out = new Set();
  if (tag(view, 0) === 'ttcf') {
    const count = u32(view, 8);
    if (!count || count > 4096 || 12 + count * 4 > view.byteLength) throw new Error('invalid font collection');
    for (let i = 0; i < count; i++) parseSfntFace(view, u32(view, 12 + i * 4), out);
  } else {
    parseSfntFace(view, 0, out);
  }
  return [...out].sort((a, b) => a - b);
}

function dataUrlToArrayBuffer(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  if (comma < 0) throw new Error('invalid font data url');
  const meta = text.slice(0, comma);
  const payload = text.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  return new TextEncoder().encode(decodeURIComponent(payload)).buffer;
}

async function resolveSystemEntryPath(entry = {}) {
  if (entry.path) return entry.path;
  const family = String(entry.familyName || '').trim().toLowerCase();
  const file = String(entry.fileName || '').trim().toLowerCase();
  const css = String(getFontCssFamily(entry) || '').trim().toLowerCase();
  const rows = await listSystemFontEntries();
  const matched = rows.find(row => {
    const rowFamily = String(row.familyName || '').trim().toLowerCase();
    const rowFile = String(row.fileName || '').trim().toLowerCase();
    const rowCss = String(getFontCssFamily(row) || '').trim().toLowerCase();
    return (file && rowFile === file) || (family && rowFamily === family) || (css && rowCss === css);
  });
  return matched?.path || '';
}

export async function loadFontCmapCodes(entry = {}) {
  let resolvedPath = String(entry.path || '');
  if (entry.source !== BUILTIN_FONT_SOURCE && entry.source !== BUILTIN_FALLBACK_FONT_SOURCE && !resolvedPath) {
    resolvedPath = await resolveSystemEntryPath(entry);
  }
  const key = entry.source === BUILTIN_FONT_SOURCE
    ? 'builtin:vanilla'
    : entry.source === BUILTIN_FALLBACK_FONT_SOURCE
      ? 'builtin:fallback'
      : `${String(entry.source || 'system')}:${resolvedPath.toLowerCase()}`;
  if (cmapCache.has(key)) return (await cmapCache.get(key)).slice();

  const task = (async () => {
    let buffer = null;
    if (entry.source === BUILTIN_FONT_SOURCE) {
      const response = await fetch(`./assets/${BUILTIN_FONT_FILE_NAME}`, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`built-in font load failed (${response.status})`);
      buffer = await response.arrayBuffer();
    } else if (entry.source === BUILTIN_FALLBACK_FONT_SOURCE) {
      const response = await fetch(`./assets/${FALLBACK_FONT_FILE_NAME}`, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`built-in fallback font load failed (${response.status})`);
      buffer = await response.arrayBuffer();
    } else {
      if (!resolvedPath) throw new Error('font file path unavailable');
      buffer = dataUrlToArrayBuffer(await readFontFileDataUrl(resolvedPath));
    }
    return parseFontCmap(buffer).map(cp => cp.toString(16).toUpperCase().padStart(4, '0'));
  })();
  cmapCache.set(key, task);
  try { return (await task).slice(); }
  catch (error) { cmapCache.delete(key); throw error; }
}
