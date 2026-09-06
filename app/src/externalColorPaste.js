import { getActiveColorPalette, DEFAULT_COLOR_CODE } from './colorPalette.js';
import { normalizeClipboardToRawFragment, normalizePlainTextToRawFragment } from './rawCodeModel.js';

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);

const NAMED_COLORS = Object.freeze({
  black: '#000000', silver: '#C0C0C0', gray: '#808080', white: '#FFFFFF', maroon: '#800000', red: '#FF0000',
  purple: '#800080', fuchsia: '#FF00FF', magenta: '#FF00FF', green: '#008000', lime: '#00FF00', olive: '#808000',
  yellow: '#FFFF00', navy: '#000080', blue: '#0000FF', teal: '#008080', aqua: '#00FFFF', cyan: '#00FFFF', orange: '#FFA500',
  transparent: 'transparent'
});

function clampByte(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHexColor(raw) {
  const hex = String(raw || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  }
  return null;
}

function parseRgbPart(part) {
  const text = String(part || '').trim();
  if (text.endsWith('%')) return clampByte(Number.parseFloat(text) * 2.55);
  return clampByte(Number.parseFloat(text));
}

export function parseCssColor(value) {
  let raw = String(value || '').trim();
  if (!raw) return null;
  raw = raw.replace(/!important\s*$/i, '').trim();
  const lower = raw.toLowerCase();
  if (NAMED_COLORS[lower] === 'transparent') return null;
  if (NAMED_COLORS[lower]) raw = NAMED_COLORS[lower];
  if (raw.startsWith('#')) return parseHexColor(raw);
  const rgbMatch = raw.match(/^rgba?\((.*)\)$/i);
  if (rgbMatch) {
    const body = rgbMatch[1].replace(/\s*\/\s*/g, ',');
    const parts = body.includes(',') ? body.split(',') : body.trim().split(/\s+/);
    if (parts.length >= 3) {
      const rgb = { r: parseRgbPart(parts[0]), g: parseRgbPart(parts[1]), b: parseRgbPart(parts[2]) };
      const alpha = parts.length >= 4 ? Math.max(0, Math.min(1, Number.parseFloat(String(parts[3]).trim()))) : 1;
      if (Number.isFinite(alpha) && alpha < 1) {
        // Treat semitransparent pasted text as composited over white, matching common document paste backgrounds.
        return {
          r: clampByte(rgb.r * alpha + 255 * (1 - alpha)),
          g: clampByte(rgb.g * alpha + 255 * (1 - alpha)),
          b: clampByte(rgb.b * alpha + 255 * (1 - alpha)),
        };
      }
      return rgb;
    }
  }
  return null;
}

function hexToRgb(hex) {
  return parseHexColor(String(hex || '').trim());
}

function colorDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  // Slightly favor perceived luminance without being overly clever; this is a deterministic nearest-palette mapping.
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
}

function isDefaultBlackTextColor(rgb) {
  if (!rgb) return false;
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  return max <= 64 && max - min <= 32;
}

export function nearestPaletteColorCode(rgb, preferences = {}) {
  if (!rgb) return '';
  if (isDefaultBlackTextColor(rgb)) return DEFAULT_COLOR_CODE;
  const palette = getActiveColorPalette(preferences);
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of palette) {
    const candidate = hexToRgb(item.hex);
    const dist = colorDistance(rgb, candidate);
    if (dist < bestDistance) {
      best = item;
      bestDistance = dist;
    }
  }
  return best?.code || DEFAULT_COLOR_CODE;
}

function cssDeclarationColor(styleAttr, propertyName) {
  const name = String(propertyName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(styleAttr || '').match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i'));
  const value = match ? match[1].trim() : '';
  return parseCssColor(value) ? value : '';
}

function inlineColorForElement(element) {
  if (!element || element.nodeType !== 1) return '';
  const textFillColor = element.style?.webkitTextFillColor || element.style?.getPropertyValue?.('-webkit-text-fill-color') || '';
  if (parseCssColor(textFillColor)) return textFillColor;
  const styleColor = element.style?.color || '';
  if (parseCssColor(styleColor)) return styleColor;
  const styleAttr = element.getAttribute?.('style') || '';
  const styleFill = cssDeclarationColor(styleAttr, '-webkit-text-fill-color');
  if (styleFill) return styleFill;
  const styleTextColor = cssDeclarationColor(styleAttr, 'color');
  if (styleTextColor) return styleTextColor;
  if (String(element.tagName || '').toUpperCase() === 'FONT') {
    const fontColor = element.getAttribute?.('color') || '';
    if (parseCssColor(fontColor)) return fontColor;
  }
  return '';
}

function appendTextSegment(segments, text, colorCode) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!normalized) return;
  const last = segments[segments.length - 1];
  const code = colorCode || '';
  if (last && last.colorCode === code) last.text += normalized;
  else segments.push({ text: normalized, colorCode: code });
}

function appendNewline(segments) {
  const allText = segments.map(s => s.text).join('');
  if (!allText || allText.endsWith('\n')) return;
  appendTextSegment(segments, '\n', segments[segments.length - 1]?.colorCode || '');
}

function elementChildrenToSegments(node, inheritedColor, preferences, segments, stats) {
  for (const child of Array.from(node.childNodes || [])) {
    nodeToSegments(child, inheritedColor, preferences, segments, stats);
  }
}

function nodeToSegments(node, inheritedColor, preferences, segments, stats) {
  if (!node) return;
  if (node.nodeType === 3) {
    appendTextSegment(segments, node.nodeValue || '', inheritedColor);
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = String(node.tagName || '').toUpperCase();
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'META' || tag === 'LINK' || tag === 'IMG' || tag === 'SVG') return;
  if (tag === 'BR') { appendTextSegment(segments, '\n', inheritedColor); return; }

  const explicitColor = inlineColorForElement(node);
  let nextColor = inheritedColor;
  if (explicitColor) {
    const mapped = nearestPaletteColorCode(parseCssColor(explicitColor), preferences);
    if (mapped) {
      nextColor = mapped;
      stats.mappedColorCount += 1;
    }
  }

  const isBlock = BLOCK_TAGS.has(tag);
  if (isBlock) appendNewline(segments);
  elementChildrenToSegments(node, nextColor, preferences, segments, stats);
  if (isBlock) appendNewline(segments);
}

function segmentsToRawFragment(segments) {
  let raw = '';
  let active = '';
  for (const segment of segments) {
    const text = segment.text;
    if (!text) continue;
    const code = segment.colorCode || '';
    if (code && code !== active) {
      raw += code;
      active = code;
    } else if (!code && active) {
      raw += DEFAULT_COLOR_CODE;
      active = '';
    }
    raw += normalizePlainTextToRawFragment(text);
  }
  return raw.replace(/(?:\\n)+$/g, '');
}

function textFromSegments(segments) {
  return segments.map(segment => segment.text).join('').replace(/\n+$/g, '');
}

export function htmlToD2rRawFragment(html, { plainText = '', preferences = {} } = {}) {
  const source = String(html || '');
  if (!source.trim() || typeof DOMParser === 'undefined') {
    const fallback = String(plainText || '');
    return { rawFragment: normalizeClipboardToRawFragment(fallback, { preserveColorCodes: true }), text: fallback, hadHtml: false, hadMappedColor: false, mappedColorCount: 0 };
  }
  let doc = null;
  try { doc = new DOMParser().parseFromString(source, 'text/html'); }
  catch (_) { doc = null; }
  if (!doc) {
    const fallback = String(plainText || '');
    return { rawFragment: normalizeClipboardToRawFragment(fallback, { preserveColorCodes: true }), text: fallback, hadHtml: false, hadMappedColor: false, mappedColorCount: 0 };
  }
  const segments = [];
  const stats = { mappedColorCount: 0 };
  elementChildrenToSegments(doc.body || doc, DEFAULT_COLOR_CODE, preferences, segments, stats);
  let text = textFromSegments(segments);
  if (!text && plainText) text = String(plainText || '');
  if (!segments.length && text) appendTextSegment(segments, text, '');
  const rawFragment = segments.length ? segmentsToRawFragment(segments) : normalizeClipboardToRawFragment(text, { preserveColorCodes: true });
  return {
    rawFragment,
    text,
    hadHtml: true,
    hadMappedColor: stats.mappedColorCount > 0,
    mappedColorCount: stats.mappedColorCount,
  };
}
