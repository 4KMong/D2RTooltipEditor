import { parseRawCode } from './rawCodeModel.js';
import { normalizeNewlines } from './textCodec.js';

const SPACE_CHAR_RE = /^[ \u00A0\u1680\u202F\u205F\u3000]$/u;
const HORIZONTAL_TRIM_RE = /^[ \t\u00A0\u1680\u202F\u205F\u3000]$/u;

function isSpaceChar(ch) { return SPACE_CHAR_RE.test(String(ch ?? '')); }
function isHorizontalTrimChar(ch) { return HORIZONTAL_TRIM_RE.test(String(ch ?? '')); }
function isTabChar(ch) { return String(ch ?? '') === '\t'; }
function isLineBreakUnit(unit) { return unit && unit.kind === 'text' && unit.text === '\n'; }
function isZeroWidthUnit(unit) { return unit && unit.kind === 'text' && unit.text === '\u2060'; }

function cleanupUnitsFromRawCode(rawCode) {
  const model = parseRawCode(normalizeNewlines(String(rawCode ?? '')));
  return model.tokens.map((token) => {
    if (token.type === 'color') return { kind: 'color', raw: token.raw, text: '', tokenType: token.type };
    return { kind: 'text', raw: token.raw, text: token.visibleText, tokenType: token.type };
  });
}

function serializeCleanupUnits(units) {
  return units.map(unit => unit.raw).join('');
}

function removeCleanupUnit(unit) {
  unit.raw = '';
  unit.text = '';
  unit.removed = true;
}

function replaceCleanupUnit(unit, raw, text = String(raw ?? '')) {
  unit.raw = String(raw ?? '');
  unit.text = String(text ?? '');
  unit.tokenType = 'char';
}

function trimDocumentEdges(units, stats) {
  let left = 0;
  while (left < units.length) {
    const unit = units[left];
    if (unit.kind === 'color') { left += 1; continue; }
    if (unit.kind === 'text' && (isHorizontalTrimChar(unit.text) || isLineBreakUnit(unit))) { removeCleanupUnit(unit); stats.documentEdges += 1; left += 1; continue; }
    break;
  }
  let right = units.length - 1;
  while (right >= 0) {
    const unit = units[right];
    if (unit.kind === 'color') { right -= 1; continue; }
    if (unit.kind === 'text' && (isHorizontalTrimChar(unit.text) || isLineBreakUnit(unit))) { removeCleanupUnit(unit); stats.documentEdges += 1; right -= 1; continue; }
    break;
  }
}

function trimLineEdges(units, { start = false, end = false, includeTabs = false } = {}, stats) {
  if (start) {
    let atLineStart = true;
    for (const unit of units) {
      if (unit.kind === 'color') continue;
      if (isLineBreakUnit(unit)) { atLineStart = true; continue; }
      if (atLineStart && (isSpaceChar(unit.text) || (includeTabs && isTabChar(unit.text)))) {
        removeCleanupUnit(unit);
        stats.lineStart += 1;
        continue;
      }
      atLineStart = false;
    }
  }
  if (end) {
    let trailing = [];
    for (const unit of units) {
      if (unit.kind === 'color') continue;
      if (isLineBreakUnit(unit)) {
        for (const item of trailing) { removeCleanupUnit(item); stats.lineEnd += 1; }
        trailing = [];
        continue;
      }
      if (isSpaceChar(unit.text) || (includeTabs && isTabChar(unit.text))) trailing.push(unit);
      else trailing = [];
    }
    for (const item of trailing) { removeCleanupUnit(item); stats.lineEnd += 1; }
  }
}

function removeSpacesFromUnits(units, stats) {
  for (const unit of units) {
    if (unit.kind !== 'text') continue;
    if (isSpaceChar(unit.text)) { removeCleanupUnit(unit); stats.spacesRemoved += 1; }
  }
}

function collapseSpacesInUnits(units, stats) {
  let run = [];
  const flush = () => {
    if (run.length <= 1) { run = []; return; }
    for (let i = 1; i < run.length; i++) { removeCleanupUnit(run[i]); stats.spacesCollapsed += 1; }
    replaceCleanupUnit(run[0], ' ', ' ');
    run = [];
  };
  for (const unit of units) {
    if (unit.kind === 'color') continue;
    if (unit.kind === 'text' && isSpaceChar(unit.text)) run.push(unit);
    else flush();
  }
  flush();
}

function removeEolFromUnits(units, stats) {
  for (const unit of units) {
    if (isLineBreakUnit(unit)) { removeCleanupUnit(unit); stats.eolRemoved += 1; }
  }
}

function removeDuplicateEolFromUnits(units, stats) {
  let previousVisibleWasEol = false;
  for (const unit of units) {
    if (unit.kind === 'color') continue;
    if (isLineBreakUnit(unit)) {
      if (previousVisibleWasEol) { removeCleanupUnit(unit); stats.duplicateEolRemoved += 1; }
      else previousVisibleWasEol = true;
      continue;
    }
    if (unit.kind === 'text' && unit.raw !== '') previousVisibleWasEol = false;
  }
}

function removeZeroWidthFromUnits(units, stats) {
  for (const unit of units) {
    if (isZeroWidthUnit(unit)) { removeCleanupUnit(unit); stats.zeroWidthRemoved += 1; }
  }
}

function cleanupUnsafeCharUnit(unit) {
  if (!unit || unit.kind !== 'text') return { removed: 0, replaced: 0 };
  // 기존 정책과 동일하게 \uXXXX 리터럴로 입력된 문자는 불필요한 문자열 정리에서 보존한다.
  if (unit.tokenType === 'unicodeEscape' || unit.tokenType === 'lineBreak') return { removed: 0, replaced: 0 };
  const ch = unit.text;
  if (!ch) return { removed: 0, replaced: 0 };
  const cp = ch.codePointAt(0);
  if (cp === 0x00A0 || cp === 0x1680 || cp === 0x202F || cp === 0x205F || cp === 0x3000) {
    replaceCleanupUnit(unit, ' ', ' ');
    return { removed: 0, replaced: 1 };
  }
  if (cp === 0x2028 || cp === 0x2029) {
    replaceCleanupUnit(unit, '\n', '\n');
    return { removed: 0, replaced: 1 };
  }
  const remove =
    (cp >= 0x0000 && cp <= 0x0008) || cp === 0x000B || cp === 0x000C || (cp >= 0x000E && cp <= 0x001F) ||
    (cp >= 0x007F && cp <= 0x009F) ||
    cp === 0x00AD || cp === 0x034F || cp === 0x061C ||
    (cp >= 0x200B && cp <= 0x200F && cp !== 0x200A) ||
    (cp >= 0x202A && cp <= 0x202E) ||
    (cp >= 0x2061 && cp <= 0x206F) ||
    (cp >= 0xFE00 && cp <= 0xFE0F) ||
    cp === 0xFEFF ||
    (cp >= 0xD800 && cp <= 0xDFFF);
  if (remove) { removeCleanupUnit(unit); return { removed: 1, replaced: 0 }; }
  return { removed: 0, replaced: 0 };
}

function cleanupUnsafeUnits(units, stats) {
  for (const unit of units) {
    const r = cleanupUnsafeCharUnit(unit);
    stats.unsafeRemoved += r.removed;
    stats.unsafeReplaced += r.replaced;
  }
}

function removeTabsFromUnits(units, stats) {
  for (const unit of units) {
    if (unit.kind === 'text' && isTabChar(unit.text)) { removeCleanupUnit(unit); stats.tabsRemoved += 1; }
  }
}

function replaceTabsInUnits(units, replacement, stats) {
  const rawReplacement = String(replacement ?? '');
  for (const unit of units) {
    if (unit.kind !== 'text' || !isTabChar(unit.text)) continue;
    replaceCleanupUnit(unit, rawReplacement, rawReplacement);
    if (rawReplacement === '') stats.tabsRemoved += 1;
    else stats.tabsReplaced += 1;
  }
}

export function cleanupUnsafeInvisibleText(text) {
  const stats = { removed: 0, replaced: 0 };
  let out = '';
  const source = String(text ?? '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      if (source[i + 1] === 'n') { out += source.slice(i, i + 2); i += 1; continue; }
      if (source[i + 1] === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) { out += source.slice(i, i + 6); i += 5; continue; }
    }
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) i++;
    if (cp === 0x00A0 || cp === 0x1680 || cp === 0x202F || cp === 0x205F || cp === 0x3000) { out += ' '; stats.replaced++; continue; }
    if (cp === 0x2028 || cp === 0x2029) { out += '\n'; stats.replaced++; continue; }
    const remove =
      (cp >= 0x0000 && cp <= 0x0008) || cp === 0x000B || cp === 0x000C || (cp >= 0x000E && cp <= 0x001F) ||
      (cp >= 0x007F && cp <= 0x009F) ||
      cp === 0x00AD || cp === 0x034F || cp === 0x061C ||
      (cp >= 0x200B && cp <= 0x200F && cp !== 0x200A) ||
      (cp >= 0x202A && cp <= 0x202E) ||
      (cp >= 0x2061 && cp <= 0x206F) ||
      (cp >= 0xFE00 && cp <= 0xFE0F) ||
      cp === 0xFEFF ||
      (cp >= 0xD800 && cp <= 0xDFFF);
    if (remove) { stats.removed++; continue; }
    out += ch;
  }
  return { text: out, stats };
}

export function buildTextCleanupResult(text, options = {}) {
  const opts = {
    trimDocumentEdges: false,
    trimLineStart: false,
    trimLineEnd: false,
    removeSpaces: false,
    collapseSpaces: false,
    removeEol: false,
    removeDuplicateEol: false,
    removeZeroWidth: false,
    cleanupUnsafe: false,
    removeTabs: false,
    replaceTabs: false,
    tabReplacement: '',
    includeTabsInLineTrim: false,
    ...options,
  };
  const stats = {
    documentEdges: 0,
    lineStart: 0,
    lineEnd: 0,
    spacesRemoved: 0,
    spacesCollapsed: 0,
    eolRemoved: 0,
    duplicateEolRemoved: 0,
    zeroWidthRemoved: 0,
    unsafeRemoved: 0,
    unsafeReplaced: 0,
    tabsRemoved: 0,
    tabsReplaced: 0,
  };
  const source = normalizeNewlines(String(text ?? ''));
  const units = cleanupUnitsFromRawCode(source);

  if (opts.trimDocumentEdges) trimDocumentEdges(units, stats);
  if (opts.trimLineStart || opts.trimLineEnd) trimLineEdges(units, { start: opts.trimLineStart, end: opts.trimLineEnd, includeTabs: opts.includeTabsInLineTrim }, stats);
  if (opts.removeSpaces) removeSpacesFromUnits(units, stats);
  else if (opts.collapseSpaces) collapseSpacesInUnits(units, stats);
  if (opts.removeEol) removeEolFromUnits(units, stats);
  else if (opts.removeDuplicateEol) removeDuplicateEolFromUnits(units, stats);
  if (opts.removeZeroWidth) removeZeroWidthFromUnits(units, stats);
  if (opts.cleanupUnsafe) cleanupUnsafeUnits(units, stats);
  if (opts.removeTabs) removeTabsFromUnits(units, stats);
  else if (opts.replaceTabs) replaceTabsInUnits(units, opts.tabReplacement, stats);

  const out = serializeCleanupUnits(units);
  const changed = out !== source;
  return { text: out, changed, stats, options: opts };
}

export function textCleanupSummary(stats = {}) {
  const rows = [
    ['양쪽 끝 공백', stats.documentEdges],
    ['행 시작', stats.lineStart],
    ['행 꼬리', stats.lineEnd],
    ['공백 제거', stats.spacesRemoved],
    ['다중 공백 축약', stats.spacesCollapsed],
    ['줄바꿈 제거', stats.eolRemoved],
    ['중복 줄바꿈 제거', stats.duplicateEolRemoved],
    ['0 너비 문자 제거', stats.zeroWidthRemoved],
    ['탭 문자 제거', stats.tabsRemoved],
    ['탭 문자 교체', stats.tabsReplaced],
  ].filter(([, value]) => Number(value) > 0).map(([label, value]) => `${label}: ${value}개`);
  const unsafeRemoved = Number(stats.unsafeRemoved || 0);
  const unsafeReplaced = Number(stats.unsafeReplaced || 0);
  if (unsafeRemoved || unsafeReplaced) {
    const parts = [];
    if (unsafeRemoved) parts.push(`제거 ${unsafeRemoved}개`);
    if (unsafeReplaced) parts.push(`치환 ${unsafeReplaced}개`);
    rows.push(`불필요한 문자열 정리: ${parts.join(', ')}`);
  }
  return rows.join('\n') || '변경된 항목 없음';
}

export function removeDuplicateEolFromText(text) {
  let removed = 0;
  const normalized = normalizeNewlines(String(text ?? ''));
  const out = normalized.replace(/\n{2,}/g, (m) => { removed += m.length - 1; return '\n'; });
  return { text: out, removed, changed: out !== normalized };
}
