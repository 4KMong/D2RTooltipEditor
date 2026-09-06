import { getDefaultRenderingSettings, normalizeRenderingSettings } from './state.js';
import { FALLBACK_FONT_FILE_NAME } from './fontService.js';
import { normalizeNewlines } from './textCodec.js';

export const DISPLAY_METADATA_BEGIN = '-----BEGIN TTE DISPLAY SETTINGS-----';
export const DISPLAY_METADATA_END = '-----END TTE DISPLAY SETTINGS-----';
const METADATA_VERSION = 1;
const DISPLAY_METADATA_NOTICE = [
  '※ 아래 블록은 D2R TooltipEditor가 다음에 이 파일을 열 때 표시 설정(글꼴, 크기, 줄 간격, 줄 맞춤)을 복원하기 위한 정보입니다.',
  '※ 파일을 다시 열었을 때 같은 표시 설정을 유지하려면 이 블록을 지우지 마세요.',
  '※ TTE에서는 이 블록을 본문으로 표시하지 않습니다.',
];

function escapeRegExp(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const TRAILING_METADATA_RE = new RegExp(`(?:\\r?\\n){0,2}${escapeRegExp(DISPLAY_METADATA_BEGIN)}\\r?\\n([\\s\\S]*?)\\r?\\n${escapeRegExp(DISPLAY_METADATA_END)}\\s*$`);

function extractMetadataJson(blockText = '') {
  const text = String(blockText ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('metadata JSON payload not found');
  return text.slice(start, end + 1);
}

function rounded(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const pow = 10 ** digits;
  return Math.round(n * pow) / pow;
}

export function splitDisplayMetadata(rawText = '') {
  const text = normalizeNewlines(String(rawText ?? ''));
  const match = text.match(TRAILING_METADATA_RE);
  if (!match) return { body: text, metadata: null, hadBlock: false, parseError: null };
  const body = text.slice(0, match.index).replace(/\n{1,2}$/, '');
  try {
    const parsed = JSON.parse(extractMetadataJson(match[1]));
    return { body, metadata: normalizeMetadataRendering(parsed), hadBlock: true, parseError: null };
  } catch (err) {
    return { body, metadata: null, hadBlock: true, parseError: String(err?.message || err) };
  }
}

export function normalizeMetadataRendering(value = {}) {
  const src = value && typeof value === 'object' ? value : {};
  return normalizeRenderingSettings({
    fontSource: src.fontSource,
    fontFamily: src.fontFamily,
    fontPath: src.fontPath,
    fontFileName: src.fontFileName,
    fontSizePt: src.fontSizePt,
    lineHeightPt: src.lineHeightPt,
    textAlign: src.textAlign,
  });
}

export function metadataPayloadFromRendering(rendering = {}) {
  const r = normalizeRenderingSettings(rendering);
  return {
    version: METADATA_VERSION,
    fontSource: r.fontSource,
    fontFamily: r.fontFamily,
    fontPath: r.fontPath || '',
    fontFileName: r.fontSource === 'builtin' ? 'embedded_vanilla.ttf' : (r.fontSource === 'builtinFallback' ? FALLBACK_FONT_FILE_NAME : (r.fontFileName || '')),
    fontSizePt: rounded(r.fontSizePt, 1),
    lineHeightPt: rounded(r.lineHeightPt, 1),
    textAlign: r.textAlign,
  };
}

function displayComparable(rendering = {}) {
  const r = normalizeRenderingSettings(rendering);
  return {
    fontSource: r.fontSource,
    fontFamily: r.fontFamily,
    fontPath: r.fontPath || '',
    fontFileName: r.fontSource === 'builtin' ? 'embedded_vanilla.ttf' : (r.fontSource === 'builtinFallback' ? FALLBACK_FONT_FILE_NAME : (r.fontFileName || '')),
    fontSizePt: rounded(r.fontSizePt, 1),
    lineHeightPt: rounded(r.lineHeightPt, 1),
    textAlign: r.textAlign,
  };
}

export function displayRenderingEquals(a = {}, b = {}) {
  return JSON.stringify(displayComparable(a)) === JSON.stringify(displayComparable(b));
}

export function isDefaultDisplayRendering(rendering = {}, defaults = getDefaultRenderingSettings()) {
  return displayRenderingEquals(rendering, defaults);
}

export function composeTextForSave(bodyText = '', rendering = {}, { includeMetadata = true, defaults = getDefaultRenderingSettings() } = {}) {
  const body = splitDisplayMetadata(normalizeNewlines(bodyText)).body;
  if (!includeMetadata || isDefaultDisplayRendering(rendering, defaults)) return body;
  const json = JSON.stringify(metadataPayloadFromRendering(rendering), null, 2);
  const sep = body.endsWith('\n') || body.length === 0 ? '' : '\n\n';
  const notice = DISPLAY_METADATA_NOTICE.join('\n');
  return `${body}${sep}${DISPLAY_METADATA_BEGIN}\n${notice}\n${json}\n${DISPLAY_METADATA_END}`;
}
