import { FALLBACK_FONT_CSS_FAMILY } from './fontService.js';

const DEFAULT_POLICY = {
  newInputDefaultColor: false,
  zeroWidthFallbackEnabled: true,
  zeroWidthFallbackFontFamily: FALLBACK_FONT_CSS_FAMILY,
  zeroWidthFallbackFontSizePt: 20,
  zeroWidthFallbackLineHeightPt: 24,
};

let policy = { ...DEFAULT_POLICY };

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function normalizePt(value, min, max, fallback) { return Math.round(clampNumber(value, min, max, fallback) * 10) / 10; }
function normalizeFontFamily(value) {
  const text = String(value ?? '').trim();
  return text || DEFAULT_POLICY.zeroWidthFallbackFontFamily;
}

function cssFontFamily(value) {
  return normalizeFontFamily(value).split(',').map(part => {
    const name = part.trim();
    if (!name) return '';
    if (/^['"].*['"]$/.test(name)) return name;
    return `'${name.replace(/'/g, "\\'")}'`;
  }).filter(Boolean).join(', ');
}

function emitPolicyChanged() {
  try { window.dispatchEvent(new CustomEvent('ttedit-color-input-policy-changed', { detail: { ...policy } })); } catch (_) {}
}

function applyPolicyToDom() {
  const root = document.documentElement;
  root.dataset.newInputDefaultColor = policy.newInputDefaultColor ? 'on' : 'off';
  root.dataset.zeroWidthFallback = policy.zeroWidthFallbackEnabled ? 'on' : 'off';
  root.style.setProperty('--zero-width-fallback-font-family', cssFontFamily(policy.zeroWidthFallbackFontFamily));
  root.style.setProperty('--zero-width-fallback-font-size', `${policy.zeroWidthFallbackFontSizePt}pt`);
  root.style.setProperty('--zero-width-fallback-line-height', `${policy.zeroWidthFallbackLineHeightPt}pt`);
}

export function normalizeColorInputPolicy(value = {}) {
  const src = value && typeof value === 'object' ? value : {};
  return {
    newInputDefaultColor: src.newInputDefaultColor === true,
    zeroWidthFallbackEnabled: src.zeroWidthFallbackEnabled !== false,
    zeroWidthFallbackFontFamily: normalizeFontFamily(src.zeroWidthFallbackFontFamily),
    zeroWidthFallbackFontSizePt: normalizePt(src.zeroWidthFallbackFontSizePt, 6, 999, DEFAULT_POLICY.zeroWidthFallbackFontSizePt),
    zeroWidthFallbackLineHeightPt: normalizePt(src.zeroWidthFallbackLineHeightPt, 6, 2000, DEFAULT_POLICY.zeroWidthFallbackLineHeightPt),
  };
}

export function setColorInputPolicy(value = {}) {
  policy = normalizeColorInputPolicy(value);
  if (typeof document !== 'undefined') applyPolicyToDom();
  emitPolicyChanged();
  return getColorInputPolicy();
}

export function setNewInputDefaultColor(value) {
  policy = { ...policy, newInputDefaultColor: value === true };
  if (typeof document !== 'undefined') applyPolicyToDom();
  emitPolicyChanged();
  return getColorInputPolicy();
}

export function setZeroWidthFallbackEnabled(value) {
  policy = { ...policy, zeroWidthFallbackEnabled: value !== false };
  if (typeof document !== 'undefined') applyPolicyToDom();
  emitPolicyChanged();
  return getColorInputPolicy();
}

export function setZeroWidthFallbackFontFamily(value) {
  policy = { ...policy, zeroWidthFallbackFontFamily: normalizeFontFamily(value) };
  if (typeof document !== 'undefined') applyPolicyToDom();
  emitPolicyChanged();
  return getColorInputPolicy();
}

export function getColorInputPolicy() { return { ...policy }; }
export const DEFAULT_COLOR_INPUT_POLICY = { ...DEFAULT_POLICY };
