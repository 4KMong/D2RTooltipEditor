import { COLOR_PREFIX, DEFAULT_COLOR_CODE, DEFAULT_COLOR_PALETTE } from './colorPalette.js';

const COLOR_CODE_LENGTH = 3;
const LINE_BREAK_LITERAL = '\\n';
const UNICODE_LITERAL_LENGTH = 6;
const HEX4_RE = /^[0-9a-fA-F]{4}$/;
const DEFAULT_COLOR_SET = new Set(DEFAULT_COLOR_PALETTE.map(item => item.code));
const PARSE_CACHE_LIMIT = 6;
const parseCache = new Map();
let preserveExplicitDefaultColorTokens = false;

export function setPreserveExplicitDefaultColorTokens(value) { preserveExplicitDefaultColorTokens = value === true; }
export function getPreserveExplicitDefaultColorTokens() { return preserveExplicitDefaultColorTokens; }

// ---------------------------------------------------------------------------
// rawIndex : "visible 텍스트" 와 "visible -> raw 오프셋 체크포인트" 를
//            문서 한 번의 스캔으로 같이 만들어 캐시한다.
//
// 배경:
//   IME 커밋 1회는 지금까지 문서를 최소 두 번 통째로 훑고 있었다.
//     1) rawCodeToVisibleText(before)  : 전체 스캔
//     2) visible -> raw 오프셋 변환     : 문서 앞에서 커서까지 선형 스캔 (O(커서 위치))
//   그래서 커서가 문서 후반부로 갈수록 한글 입력이 선형으로 느려졌다.
//
// 해결:
//   스캔을 한 번만 돌면서 visibleText 와 체크포인트를 동시에 만든다.
//   오프셋 조회는 "체크포인트 이진 탐색 + 최대 RAW_INDEX_STEP 자 지역 스캔" 이므로
//   커서 위치와 무관한 상수 시간이 된다.
//
// 정확성:
//   rawOffsetAtVisibleOffset() 의 결과는 parseRawCode() 의
//   visibleToRawIndex / visibleToRawEndIndex (즉 visibleOffsetToRawOffset) 와
//   완전히 동일하다. 토큰 객체는 하나도 만들지 않고 인덱스 산술로만 처리한다.
//
// 참고:
//   예전 visibleTextCache 는 이 rawIndexCache 로 대체되어 제거되었다.
//   (visibleText 가 rawIndex 안에 함께 들어 있으므로 별도 캐시가 필요 없다.)
// ---------------------------------------------------------------------------
const RAW_INDEX_STEP = 512;
const RAW_INDEX_CACHE_LIMIT = 4;
const rawIndexCache = new Map();

function isDefaultParseOptions(options = {}) {
  return !options || (options.strict !== true && !options.recognizedColorCodes);
}

function rememberParseModel(source, model) {
  if (!source && source !== '') return model;
  if (parseCache.has(source)) parseCache.delete(source);
  parseCache.set(source, model);
  while (parseCache.size > PARSE_CACHE_LIMIT) parseCache.delete(parseCache.keys().next().value);
  return model;
}

export function clearRawCodeModelCache() {
  parseCache.clear();
  rawIndexCache.clear();
}

export function normalizeRawCode(rawCode) {
  return String(rawCode ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function rawCodeContainsZeroWidth2060(rawCode) {
  const source = String(rawCode ?? '');
  return source.includes('\u2060') || source.includes('\\u2060');
}

export function normalizeInitialDefaultColorToken(rawCode, enabled = true) {
  const source = normalizeRawCode(rawCode);
  if (!source) return source;
  const model = parseRawCode(source);
  const leadingColors = [];
  let target = null;
  for (const token of model.tokens) {
    if (token.type === 'color') {
      leadingColors.push(token);
      continue;
    }
    if (token.visibleEnd > token.visibleStart && isVisibleColorTarget(token.visibleText)) {
      target = token;
      break;
    }
  }
  if (!target) return source;
  const effective = leadingColors.length ? leadingColors[leadingColors.length - 1].color : DEFAULT_COLOR_CODE;
  if (enabled) {
    if (leadingColors.length || effective !== DEFAULT_COLOR_CODE) return source;
    return source.slice(0, target.rawStart) + DEFAULT_COLOR_CODE + source.slice(target.rawStart);
  }
  if (!leadingColors.length || effective !== DEFAULT_COLOR_CODE) return source;
  let out = '';
  let cursor = 0;
  for (const token of leadingColors) {
    out += source.slice(cursor, token.rawStart);
    cursor = token.rawEnd;
  }
  return out + source.slice(cursor);
}

export function isRawColorCodeAt(rawCode, index, { strict = false, recognizedColorCodes = null } = {}) {
  const source = String(rawCode ?? '');
  const i = Number(index) || 0;
  if (!source.startsWith(COLOR_PREFIX, i) || i + COLOR_CODE_LENGTH > source.length) return false;
  if (!strict) return true;
  const codes = recognizedColorCodes ? new Set(recognizedColorCodes) : DEFAULT_COLOR_SET;
  return codes.has(source.slice(i, i + COLOR_CODE_LENGTH));
}

export function rawColorCodeAt(rawCode, index, options = {}) {
  return isRawColorCodeAt(rawCode, index, options) ? String(rawCode).slice(index, index + COLOR_CODE_LENGTH) : null;
}

export function isRawLineBreakAt(rawCode, index) {
  const source = String(rawCode ?? '');
  return source.startsWith(LINE_BREAK_LITERAL, Number(index) || 0);
}

export function isRawUnicodeEscapeAt(rawCode, index) {
  const source = String(rawCode ?? '');
  const i = Number(index) || 0;
  return source[i] === '\\' && source[i + 1] === 'u' && i + UNICODE_LITERAL_LENGTH <= source.length && HEX4_RE.test(source.slice(i + 2, i + 6));
}

export function decodeRawUnicodeEscape(rawCode, index) {
  return String.fromCodePoint(Number.parseInt(String(rawCode).slice(index + 2, index + 6), 16));
}

function pushVisibleToken(result, token) {
  result.tokens.push(token);
  result.visibleTextChunks.push(token.visibleText);
  result.visibleLength = token.visibleEnd;
  const rawStart = token.rawStart;
  const rawEnd = token.rawEnd;
  const visibleStart = token.visibleStart;
  const visibleEnd = token.visibleEnd;
  for (let r = rawStart; r < rawEnd; r++) result.rawToVisibleIndex[r] = visibleStart;
  result.rawToVisibleIndex[rawEnd] = visibleEnd;
  result.visibleToRawIndex[visibleStart] = rawStart;
  result.visibleToRawEndIndex[visibleEnd] = rawEnd;
  if (visibleEnd > visibleStart) {
    for (let v = visibleStart + 1; v <= visibleEnd; v++) {
      if (result.visibleToRawIndex[v] === undefined) result.visibleToRawIndex[v] = rawEnd;
      if (result.visibleToRawEndIndex[v] === undefined) result.visibleToRawEndIndex[v] = rawEnd;
    }
  }
  if (token.visibleText === '\n') result.lineIndex.push({ visibleOffset: visibleStart + 1, rawOffset: rawEnd });
}

function finalizeIndexes(result) {
  const rawLength = result.rawCode.length;
  if (Array.isArray(result.visibleTextChunks)) {
    result.visibleText = result.visibleTextChunks.join('');
    delete result.visibleTextChunks;
  }
  const visibleLength = result.visibleLength;
  let lastVisible = 0;
  for (let i = 0; i <= rawLength; i++) {
    if (result.rawToVisibleIndex[i] === undefined) result.rawToVisibleIndex[i] = lastVisible;
    else lastVisible = result.rawToVisibleIndex[i];
  }
  let lastRaw = 0;
  for (let i = 0; i <= visibleLength; i++) {
    if (result.visibleToRawIndex[i] === undefined) result.visibleToRawIndex[i] = lastRaw;
    else lastRaw = result.visibleToRawIndex[i];
    if (result.visibleToRawEndIndex[i] === undefined) result.visibleToRawEndIndex[i] = result.visibleToRawIndex[i];
  }
  result.rawLength = rawLength;
  result.visibleLength = visibleLength;
  result.lineCount = result.lineIndex.length;
  return result;
}

export function parseRawCode(rawCode, options = {}) {
  const source = normalizeRawCode(rawCode);
  const cacheable = isDefaultParseOptions(options);
  if (cacheable && parseCache.has(source)) {
    const cached = parseCache.get(source);
    parseCache.delete(source);
    parseCache.set(source, cached);
    return cached;
  }
  const result = {
    rawCode: source,
    rawLength: source.length,
    visibleText: '',
    visibleTextChunks: [],
    visibleLength: 0,
    tokens: [],
    colorRuns: [],
    rawToVisibleIndex: new Array(source.length + 1),
    visibleToRawIndex: [],
    visibleToRawEndIndex: [],
    lineIndex: [{ visibleOffset: 0, rawOffset: 0 }],
    // colorStops: 색상 토큰만 모은 정렬된 배열. rawOffset 오름차순이 보장된다.
    // activeColorAtRawOffset() 이 tokens 전체(문자 1개당 1객체)를 앞에서부터
    // 순회하던 O(커서 위치) 비용을 이진 탐색 O(log n) 으로 바꾸기 위한 인덱스다.
    colorStops: [],
  };
  let activeColor = DEFAULT_COLOR_CODE;
  let run = null;

  function closeRun(visibleEnd = result.visibleLength) {
    if (!run) return;
    run.visibleEnd = visibleEnd;
    if (run.visibleEnd > run.visibleStart) result.colorRuns.push(run);
    run = null;
  }

  function ensureRun(color, visibleStart) {
    if (run && run.color === color) return;
    closeRun(visibleStart);
    run = { color, visibleStart, visibleEnd: visibleStart };
  }

  for (let i = 0; i < source.length; i++) {
    if (isRawColorCodeAt(source, i, options)) {
      const code = source.slice(i, i + COLOR_CODE_LENGTH);
      activeColor = code;
      result.tokens.push({ type: 'color', raw: code, color: code, rawStart: i, rawEnd: i + COLOR_CODE_LENGTH, visibleStart: result.visibleLength, visibleEnd: result.visibleLength });
      result.colorStops.push({ rawOffset: i, color: code });
      for (let r = i; r <= i + COLOR_CODE_LENGTH; r++) result.rawToVisibleIndex[r] = result.visibleLength;
      i += COLOR_CODE_LENGTH - 1;
      continue;
    }

    const visibleStart = result.visibleLength;
    let rawEnd = i + 1;
    let visibleText = source[i];
    let raw = source[i];
    let type = 'char';

    if (isRawLineBreakAt(source, i)) {
      type = 'lineBreak';
      raw = LINE_BREAK_LITERAL;
      rawEnd = i + 2;
      visibleText = '\n';
      i += 1;
    } else if (isRawUnicodeEscapeAt(source, i)) {
      type = 'unicodeEscape';
      raw = source.slice(i, i + UNICODE_LITERAL_LENGTH);
      rawEnd = i + UNICODE_LITERAL_LENGTH;
      visibleText = decodeRawUnicodeEscape(source, i);
      i += UNICODE_LITERAL_LENGTH - 1;
    } else if (source[i] === '\n') {
      type = 'lineBreak';
      visibleText = '\n';
    }

    ensureRun(activeColor, visibleStart);
    const token = { type, raw, visibleText, color: activeColor, rawStart: rawEnd - raw.length, rawEnd, visibleStart, visibleEnd: visibleStart + visibleText.length };
    pushVisibleToken(result, token);
  }
  closeRun(result.visibleLength);
  const finalized = finalizeIndexes(result);
  return cacheable ? rememberParseModel(source, finalized) : finalized;
}

function asModel(rawOrModel) {
  return rawOrModel && typeof rawOrModel === 'object' && Array.isArray(rawOrModel.tokens) ? rawOrModel : parseRawCode(rawOrModel);
}

// 현재 raw 위치 i 에서 시작하는 visible 토큰 하나의 raw 길이와 visible 길이를 구한다.
// parseRawCode() 의 토큰 경계 규칙과 정확히 같은 규칙을 쓰되, 객체를 만들지 않는다.
// (색상코드는 여기서 다루지 않는다. 호출 전에 이미 건너뛴 상태여야 한다.)
function rawTokenRawEndAt(source, i) {
  if (isRawLineBreakAt(source, i)) return i + 2;                 // '\n' literal
  if (isRawUnicodeEscapeAt(source, i)) return i + UNICODE_LITERAL_LENGTH; // '\uXXXX' literal
  return i + 1;                                                  // 일반 문자, 실제 줄바꿈, 단독 '\', 단독 'ÿ'
}

function rawTokenVisibleLengthAt(source, i) {
  if (isRawLineBreakAt(source, i)) return 1;
  if (isRawUnicodeEscapeAt(source, i)) return decodeRawUnicodeEscape(source, i).length;
  return 1;
}

function buildRawIndex(source) {
  const cpVisible = [];      // 체크포인트의 visible 오프셋
  const cpRawStart = [];     // 그 visible 오프셋에서 시작하는 토큰의 rawStart (앞의 색상코드는 이미 건너뛴 위치)
  const cpPrevRawEnd = [];   // 그 직전 visible 토큰의 rawEnd (없으면 -1)

  const chunks = [];
  let plainStart = -1;       // 연속된 일반 문자 구간의 시작. slice 로 한 번에 push 하기 위한 것.
  let visible = 0;
  let prevRawEnd = -1;
  let nextCheckpointAt = 0;
  let i = 0;

  const flushPlain = (end) => {
    if (plainStart >= 0 && end > plainStart) chunks.push(source.slice(plainStart, end));
    plainStart = -1;
  };

  // 문서 선두의 색상코드를 먼저 건너뛴다.
  while (i < source.length && isRawColorCodeAt(source, i)) i += COLOR_CODE_LENGTH;

  // 루프 진입 시점에서 i 는 항상 "다음 visible 토큰의 rawStart" 를 가리킨다.
  while (i < source.length) {
    if (visible >= nextCheckpointAt) {
      cpVisible.push(visible);
      cpRawStart.push(i);
      cpPrevRawEnd.push(prevRawEnd);
      nextCheckpointAt = visible + RAW_INDEX_STEP;
    }

    let rawEnd;
    let visibleLength;
    if (isRawLineBreakAt(source, i)) {
      flushPlain(i);
      chunks.push('\n');
      rawEnd = i + 2;
      visibleLength = 1;
    } else if (isRawUnicodeEscapeAt(source, i)) {
      flushPlain(i);
      const decoded = decodeRawUnicodeEscape(source, i);
      chunks.push(decoded);
      rawEnd = i + UNICODE_LITERAL_LENGTH;
      visibleLength = decoded.length;
    } else {
      // 일반 문자 / 실제 줄바꿈 / 단독 '\' / 단독 'ÿ' : raw 그대로가 visible 이다.
      if (plainStart < 0) plainStart = i;
      rawEnd = i + 1;
      visibleLength = 1;
    }

    visible += visibleLength;
    prevRawEnd = rawEnd;
    i = rawEnd;

    if (i < source.length && isRawColorCodeAt(source, i)) {
      flushPlain(i);
      while (i < source.length && isRawColorCodeAt(source, i)) i += COLOR_CODE_LENGTH;
    }
  }
  flushPlain(source.length);

  return {
    rawCode: source,
    rawLength: source.length,
    visibleText: chunks.join(''),
    visibleLength: visible,
    cpVisible,
    cpRawStart,
    cpPrevRawEnd,
  };
}

function rememberRawIndex(source, index) {
  if (!source && source !== '') return index;
  if (rawIndexCache.has(source)) rawIndexCache.delete(source);
  rawIndexCache.set(source, index);
  while (rawIndexCache.size > RAW_INDEX_CACHE_LIMIT) rawIndexCache.delete(rawIndexCache.keys().next().value);
  return index;
}

export function getRawIndex(rawCode) {
  const source = normalizeRawCode(rawCode);
  if (rawIndexCache.has(source)) {
    const cached = rawIndexCache.get(source);
    rawIndexCache.delete(source);
    rawIndexCache.set(source, cached);
    return cached;
  }
  return rememberRawIndex(source, buildRawIndex(source));
}

function lastCheckpointAtOrBefore(cpVisible, visibleOffset) {
  let lo = 0;
  let hi = (cpVisible?.length || 0) - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cpVisible[mid] <= visibleOffset) { found = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return found;
}

export function primeRawIndexAfterPlainInsert(beforeRawCode, nextRawCode, options = {}) {
  const beforeSource = normalizeRawCode(beforeRawCode);
  const before = rawIndexCache.get(beforeSource);
  if (!before || before.rawCode !== beforeSource) return false;

  const nextSource = normalizeRawCode(nextRawCode);
  const rawStart = Math.max(0, Math.min(Number(options.rawStart) || 0, before.rawLength));
  const rawFragment = String(options.rawFragment ?? '');
  const visibleStart = Math.max(0, Math.min(Number(options.visibleStart) || 0, before.visibleLength));
  const insertedVisibleText = String(options.insertedVisibleText ?? '');
  const rawFragmentLength = rawFragment.length;
  const insertedVisibleLength = insertedVisibleText.length;

  if (!rawFragment || rawFragmentLength <= 0 || insertedVisibleLength <= 0) return false;
  if (rawFragment.includes(COLOR_PREFIX) || rawFragment.includes('ÿ') || rawFragment.includes('\\') || rawFragment.includes('\n') || rawFragment.includes('\r')) return false;
  if (rawStart > 0) {
    const prev = before.rawCode[rawStart - 1];
    if (prev === 'ÿ' || prev === '\\') return false;
  }
  if (rawCodeToVisibleText(rawFragment) !== insertedVisibleText) return false;
  if (nextSource !== before.rawCode.slice(0, rawStart) + rawFragment + before.rawCode.slice(rawStart)) return false;

  const cpVisible = before.cpVisible.slice();
  const cpRawStart = before.cpRawStart.slice();
  const cpPrevRawEnd = before.cpPrevRawEnd.slice();
  if (cpVisible.length !== cpRawStart.length || cpVisible.length !== cpPrevRawEnd.length) return false;

  const k0 = lastCheckpointAtOrBefore(cpVisible, visibleStart);
  if (k0 >= 0) {
    if (k0 + 1 < cpVisible.length && (cpVisible[k0 + 1] + insertedVisibleLength) - cpVisible[k0] > 2 * RAW_INDEX_STEP) return false;
    const newVisibleLength = before.visibleLength + insertedVisibleLength;
    if (k0 === cpVisible.length - 1 && newVisibleLength - cpVisible[k0] > 2 * RAW_INDEX_STEP) return false;
  }

  for (let i = 0; i < cpVisible.length; i++) {
    if (cpVisible[i] > visibleStart) {
      cpVisible[i] += insertedVisibleLength;
      cpRawStart[i] += rawFragmentLength;
      if (cpPrevRawEnd[i] >= 0) cpPrevRawEnd[i] += rawFragmentLength;
    }
  }

  const index = {
    rawCode: nextSource,
    rawLength: nextSource.length,
    visibleText: before.visibleText.slice(0, visibleStart) + insertedVisibleText + before.visibleText.slice(visibleStart),
    visibleLength: before.visibleLength + insertedVisibleLength,
    cpVisible,
    cpRawStart,
    cpPrevRawEnd,
  };
  if (index.visibleLength !== index.visibleText.length) return false;
  return rememberRawIndex(nextSource, index) === index;
}

// parseRawCode() 없이 visible 오프셋을 raw 오프셋으로 변환한다.
// 결과는 visibleOffsetToRawOffset(parseRawCode(rawCode), visibleOffset, side) 와 100% 동일하다.
//   side === 'start' -> visibleToRawIndex[offset]      (앞의 색상코드를 건너뛴 뒤의 위치)
//   side === 'end'   -> visibleToRawEndIndex[offset]   (앞의 색상코드 바로 앞의 위치)
// 커서 위치에 무관한 상수 시간(이진 탐색 + 최대 RAW_INDEX_STEP 자 지역 스캔)이다.
export function rawOffsetAtVisibleOffset(rawCode, visibleOffset, side = 'start') {
  const index = getRawIndex(rawCode);
  const source = index.rawCode;

  if (index.visibleLength <= 0) return index.rawLength;
  const offset = Math.max(0, Math.min(Number(visibleOffset) || 0, index.visibleLength));
  if (offset >= index.visibleLength) return index.rawLength;

  // cpVisible[cp] <= offset 인 마지막 체크포인트를 이진 탐색으로 찾는다.
  let lo = 0;
  let hi = index.cpVisible.length - 1;
  let cp = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.cpVisible[mid] <= offset) { cp = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }

  let visible = index.cpVisible[cp];
  let i = index.cpRawStart[cp];
  let prevRawEnd = index.cpPrevRawEnd[cp];

  // 체크포인트에서 목표 오프셋까지만 지역 스캔한다 (최대 RAW_INDEX_STEP 자).
  // offset < visibleLength 이 보장되므로 반드시 루프 안에서 반환된다.
  for (;;) {
    const visibleStart = visible;
    const visibleEnd = visibleStart + rawTokenVisibleLengthAt(source, i);

    if (offset === visibleStart) {
      if (side === 'end') return prevRawEnd >= 0 ? prevRawEnd : i;
      return i;
    }
    if (offset < visibleEnd) return rawTokenRawEndAt(source, i);

    const rawEnd = rawTokenRawEndAt(source, i);
    visible = visibleEnd;
    prevRawEnd = rawEnd;
    i = rawEnd;
    while (i < source.length && isRawColorCodeAt(source, i)) i += COLOR_CODE_LENGTH;
  }
}

// visible 문자열은 rawIndex 를 만들 때 함께 만들어지므로 그것을 재사용한다.
// 결과 문자열은 parseRawCode(rawCode).visibleText 와 완전히 동일하다.
export function rawCodeToVisibleText(rawCode) {
  const source = normalizeRawCode(rawCode);
  const cachedModel = parseCache.get(source);
  if (cachedModel) return cachedModel.visibleText;
  return getRawIndex(source).visibleText;
}

// tokens / colorStops 는 rawStart(rawOffset) 오름차순으로만 push 되므로 이진 탐색이 가능하다.
// rawStart < offset 을 만족하는 마지막 원소의 index 를 돌려준다. 없으면 -1.
function lastIndexBeforeRawOffset(list, offset, key) {
  let lo = 0;
  let hi = (list?.length || 0) - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][key] < offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function rawOffsetToVisibleOffset(rawOrModel, rawOffset, side = 'start') {
  const model = asModel(rawOrModel);
  const offset = Math.max(0, Math.min(Number(rawOffset) || 0, model.rawLength));
  const visible = model.rawToVisibleIndex[offset];
  if (side === 'end') {
    // 기존 tokens.find() 는 문서 앞에서부터 선형 탐색이라 O(커서 위치)였다.
    // 토큰 구간은 서로 겹치지 않으므로, rawStart < offset 인 마지막 토큰 하나만
    // 검사하면 기존 find() 와 완전히 동일한 결과가 나온다.
    const idx = lastIndexBeforeRawOffset(model.tokens, offset, 'rawStart');
    const token = idx >= 0 ? model.tokens[idx] : null;
    if (token && offset > token.rawStart && offset < token.rawEnd && token.visibleEnd > token.visibleStart) {
      return token.visibleEnd;
    }
  }
  return Math.max(0, Math.min(Number(visible) || 0, model.visibleLength));
}

export function visibleOffsetToRawOffset(rawOrModel, visibleOffset, side = 'start') {
  const model = asModel(rawOrModel);
  const offset = Math.max(0, Math.min(Number(visibleOffset) || 0, model.visibleLength));
  if (model.visibleLength <= 0) return model.rawLength;
  if (offset >= model.visibleLength) return model.rawLength;
  if (side === 'end') return model.visibleToRawEndIndex[offset] ?? model.rawLength;
  return model.visibleToRawIndex[offset] ?? model.rawLength;
}

export function activeColorAtRawOffset(rawOrModel, rawOffset) {
  const model = asModel(rawOrModel);
  const offset = Math.max(0, Math.min(Number(rawOffset) || 0, model.rawLength));

  // 대용량 IME 지연의 핵심 원인이던 O(커서 위치) 순회를 제거한다.
  // 기존 구현은 "rawStart < offset 인 토큰 중 마지막 color 토큰"을 찾기 위해
  // tokens(문자 1개당 1객체)를 앞에서부터 전부 훑었다.
  // colorStops 는 color 토큰만 담은 정렬 배열이므로 같은 답을 이진 탐색으로 구한다.
  if (Array.isArray(model.colorStops)) {
    const idx = lastIndexBeforeRawOffset(model.colorStops, offset, 'rawOffset');
    return idx >= 0 ? (model.colorStops[idx].color || DEFAULT_COLOR_CODE) : DEFAULT_COLOR_CODE;
  }

  // colorStops 가 없는 외부/구버전 model 이 들어온 경우를 위한 fallback (기존 동작과 동일).
  let color = DEFAULT_COLOR_CODE;
  for (const token of model.tokens) {
    if (token.rawStart >= offset) break;
    if (token.type === 'color') color = token.color || color;
  }
  return color;
}

export function activeColorAtVisibleOffset(rawOrModel, visibleOffset) {
  const model = asModel(rawOrModel);
  return activeColorAtRawOffset(model, visibleOffsetToRawOffset(model, visibleOffset, 'start'));
}

function activeColorAfterRawFragment(rawFragment, inheritedColor = DEFAULT_COLOR_CODE) {
  const source = normalizeRawCode(rawFragment);
  let color = isRawColorCodeAt(inheritedColor, 0) ? inheritedColor : DEFAULT_COLOR_CODE;
  for (let i = 0; i < source.length; i++) {
    if (isRawColorCodeAt(source, i)) {
      color = source.slice(i, i + COLOR_CODE_LENGTH);
      i += COLOR_CODE_LENGTH - 1;
    } else if (isRawLineBreakAt(source, i)) {
      i += 1;
    } else if (isRawUnicodeEscapeAt(source, i)) {
      i += UNICODE_LITERAL_LENGTH - 1;
    }
  }
  return color;
}

export function spliceRawCode(rawCode, rawStart, rawEnd, rawFragment = '') {
  const source = normalizeRawCode(rawCode);
  const start = Math.max(0, Math.min(Number(rawStart) || 0, source.length));
  const end = Math.max(start, Math.min(Number(rawEnd) || start, source.length));
  return source.slice(0, start) + String(rawFragment ?? '') + source.slice(end);
}

export function spliceRawByVisibleRange(rawCode, visibleStart, visibleEnd, rawFragment = '') {
  const model = parseRawCode(rawCode);
  const start = visibleOffsetToRawOffset(model, Math.min(visibleStart, visibleEnd), 'start');
  const end = visibleOffsetToRawOffset(model, Math.max(visibleStart, visibleEnd), 'end');
  return spliceRawCode(model.rawCode, start, end, rawFragment);
}

export function rawFragmentFromVisibleRange(rawOrModel, visibleStart, visibleEnd) {
  const model = asModel(rawOrModel);
  const startVisible = Math.max(0, Math.min(Number(visibleStart) || 0, Number(visibleEnd) || 0, model.visibleLength));
  const endVisible = Math.max(startVisible, Math.min(Math.max(Number(visibleStart) || 0, Number(visibleEnd) || 0), model.visibleLength));
  if (endVisible <= startVisible) return '';

  let out = '';
  let active = DEFAULT_COLOR_CODE;
  let pending = null;
  for (const token of model.tokens) {
    if (token.visibleEnd <= token.visibleStart) continue;
    if (token.visibleStart < startVisible || token.visibleEnd > endVisible) continue;
    const color = isRawColorCodeAt(token.color || '', 0) ? token.color : DEFAULT_COLOR_CODE;
    if (color !== active) pending = color;
    else pending = null;
    if (pending && isVisibleColorTarget(token.visibleText)) {
      out += pending;
      active = pending;
      pending = null;
    }
    out += token.raw;
  }
  return out;
}

export function stripRawColorCodes(rawCode, options = {}) {
  const source = normalizeRawCode(rawCode);
  let out = '';
  for (let i = 0; i < source.length; i++) {
    if (isRawColorCodeAt(source, i, options)) { i += COLOR_CODE_LENGTH - 1; continue; }
    out += source[i];
  }
  return out;
}

function isVisibleColorTarget(text) {
  return Array.from(String(text ?? '')).some(ch => !/\s/u.test(ch));
}

function firstVisibleTargetRawOffset(rawCode) {
  const model = parseRawCode(rawCode);
  for (const token of model.tokens) {
    if (token.visibleEnd > token.visibleStart && isVisibleColorTarget(token.visibleText)) return token.rawStart;
  }
  return -1;
}

function suffixHasExplicitColorBeforeTarget(rawCode) {
  const model = parseRawCode(rawCode);
  for (const token of model.tokens) {
    if (token.type === 'color') return true;
    if (token.visibleEnd > token.visibleStart && isVisibleColorTarget(token.visibleText)) return false;
  }
  return false;
}

function colorApplyCaretVisibleOffset(model, startVisible, endVisible) {
  const visibleText = String(model?.visibleText ?? '');
  let caret = Math.max(startVisible, Math.min(Number(endVisible) || 0, visibleText.length));
  while (caret > startVisible && visibleText[caret - 1] === '\n') caret--;
  return caret;
}

export function cleanupRawColorCodes(rawCode, options = {}) {
  const model = parseRawCode(rawCode, options);
  const preserveDefault = options.preserveExplicitDefaultColor === true || (options.preserveExplicitDefaultColor !== false && preserveExplicitDefaultColorTokens);
  let out = '';
  let active = DEFAULT_COLOR_CODE;
  let pending = null;
  for (const token of model.tokens) {
    if (token.type === 'color') {
      pending = token.color;
      continue;
    }
    if (pending && isVisibleColorTarget(token.visibleText)) {
      if (pending !== active || (preserveDefault && pending === DEFAULT_COLOR_CODE)) out += pending;
      active = pending;
      pending = null;
    }
    out += token.raw;
  }
  return preserveDefault ? normalizeInitialDefaultColorToken(out, true) : out;
}

export function applyColorToRawVisibleRange(rawCode, visibleStart, visibleEnd, colorCode = DEFAULT_COLOR_CODE) {
  const model = parseRawCode(rawCode);
  const startVisible = Math.max(0, Math.min(Number(visibleStart) || 0, Number(visibleEnd) || 0, model.visibleLength));
  const endVisible = Math.max(startVisible, Math.min(Math.max(Number(visibleStart) || 0, Number(visibleEnd) || 0), model.visibleLength));
  if (endVisible <= startVisible) return { changed: false, rawCode: model.rawCode, caretRawOffset: visibleOffsetToRawOffset(model, startVisible), reason: 'empty' };

  const rawStart = visibleOffsetToRawOffset(model, startVisible, 'start');
  const rawEnd = visibleOffsetToRawOffset(model, endVisible, 'end');
  const before = model.rawCode.slice(0, rawStart);
  const selected = model.rawCode.slice(rawStart, rawEnd);
  const after = model.rawCode.slice(rawEnd);
  const selectedClean = stripRawColorCodes(selected);
  const targetOffset = firstVisibleTargetRawOffset(selectedClean);
  if (targetOffset < 0) return { changed: false, rawCode: cleanupRawColorCodes(model.rawCode), caretRawOffset: rawStart, reason: 'no-target' };

  const color = isRawColorCodeAt(colorCode, 0) ? colorCode : DEFAULT_COLOR_CODE;
  const restore = activeColorAtRawOffset(model, rawEnd);
  const withColor = selectedClean.slice(0, targetOffset) + color + selectedClean.slice(targetOffset);
  const needsRestore = restore !== color && isVisibleColorTarget(rawCodeToVisibleText(after)) && !suffixHasExplicitColorBeforeTarget(after);
  const next = cleanupRawColorCodes(before + withColor + (needsRestore ? restore : '') + after);
  const nextModel = parseRawCode(next);
  const caretVisibleOffset = colorApplyCaretVisibleOffset(model, startVisible, endVisible);
  const caretRawOffset = visibleOffsetToRawOffset(nextModel, caretVisibleOffset, 'end');
  return { changed: next !== model.rawCode, rawCode: next, caretRawOffset, caretVisibleOffset, reason: 'applied' };
}

export function normalizePlainTextToRawFragment(text) {
  return normalizeRawCode(text).replace(/\n/g, LINE_BREAK_LITERAL);
}

export function normalizeClipboardToRawFragment(text, { activeColor = '', preserveColorCodes = true } = {}) {
  const source = normalizePlainTextToRawFragment(text);
  const hasColor = preserveColorCodes && source.includes(COLOR_PREFIX);
  if (hasColor || !activeColor || !isVisibleColorTarget(rawCodeToVisibleText(source))) return source;
  return isRawColorCodeAt(activeColor, 0) ? activeColor + source : source;
}

function rawCodeHasVisibleTarget(rawCode) {
  const source = normalizeRawCode(rawCode);
  for (let i = 0; i < source.length; i++) {
    if (isRawColorCodeAt(source, i)) { i += COLOR_CODE_LENGTH - 1; continue; }
    let visible = source[i];
    if (isRawLineBreakAt(source, i)) { i += 1; visible = '\n'; }
    else if (isRawUnicodeEscapeAt(source, i)) { visible = decodeRawUnicodeEscape(source, i); i += UNICODE_LITERAL_LENGTH - 1; }
    if (isVisibleColorTarget(visible)) return true;
  }
  return false;
}

function shouldCleanupVisiblePatch(rawCode, visibleStart, visibleEnd, rawFragment) {
  const start = Number(visibleStart) || 0;
  const end = Number(visibleEnd) || 0;
  // 삭제/잘라내기/선택 치환은 orphan color token을 만들 수 있으므로 cleanup한다.
  if (start !== end || String(rawFragment ?? '').length === 0) return true;
  // 색상코드만 남은 빈 문서에 붙여넣는 경우는 stale active color 상속을 막기 위해 cleanup한다.
  if (String(rawCode ?? '').includes(COLOR_PREFIX) && !rawCodeHasVisibleTarget(rawCode)) return true;
  // collapsed insert/paste는 보통 orphan을 만들지 않으므로 전체 cleanup을 건너뛰어 긴 color-heavy 문서의 입력 지연을 줄인다.
  return false;
}

export function makeRawCodePatch(rawCode, visibleStart, visibleEnd, rawFragment = '', options = {}) {
  const cleanupMode = options.cleanup || 'auto';
  const cleanupNeeded = cleanupMode === 'always' || (cleanupMode !== 'never' && shouldCleanupVisiblePatch(rawCode, visibleStart, visibleEnd, rawFragment));
  const source = cleanupNeeded ? cleanupRawColorCodes(rawCode) : normalizeRawCode(rawCode);
  const model = parseRawCode(source);
  const startVisible = Math.min(Number(visibleStart) || 0, Number(visibleEnd) || 0);
  const endVisible = Math.max(Number(visibleStart) || 0, Number(visibleEnd) || 0);
  const start = visibleOffsetToRawOffset(model, startVisible, 'start');
  const end = visibleOffsetToRawOffset(model, endVisible, 'end');
  const fragment = String(rawFragment ?? '');
  const before = model.rawCode.slice(0, start);
  const after = model.rawCode.slice(end);
  const startColor = activeColorAtRawOffset(model, start);
  const endColor = activeColorAtRawOffset(model, end);
  const fragmentEndColor = activeColorAfterRawFragment(fragment, startColor);
  const preserveTrailingColor = options.preserveTrailingColor !== false && start !== end;
  const restoreTrailingColor = preserveTrailingColor
    && endColor !== fragmentEndColor
    && rawCodeHasVisibleTarget(after)
    && !suffixHasExplicitColorBeforeTarget(after)
      ? endColor
      : '';
  const next = before + fragment + restoreTrailingColor + after;
  const rawCodeNext = cleanupNeeded ? cleanupRawColorCodes(next) : next;
  return {
    rawCode: rawCodeNext,
    rawStart: start,
    rawEnd: end,
    insertedRawLength: fragment.length,
    trailingColorRestore: restoreTrailingColor,
    cleanupApplied: cleanupNeeded,
  };
}
