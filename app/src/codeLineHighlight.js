import { measureTextareaOffsetTop } from './codeOffsetMeasure.js';
let codeText = null;
let overlay = null;
let rect = null;
let resizeObserver = null;
let currentTarget = null;

function ensureOverlay() {
  if (!codeText || overlay) return overlay;
  const pane = codeText.closest('.code-pane') || codeText.parentElement;
  if (!pane) return null;
  pane.classList.add('code-highlight-host');
  overlay = document.createElement('div');
  overlay.className = 'code-line-highlight-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  rect = document.createElement('div');
  rect.className = 'code-line-highlight-rect';
  overlay.appendChild(rect);
  pane.appendChild(overlay);
  return overlay;
}

function lineHeightPx(textarea) {
  const cs = getComputedStyle(textarea);
  const lh = Number.parseFloat(cs.lineHeight);
  if (Number.isFinite(lh) && lh > 0) return lh;
  const fs = Number.parseFloat(cs.fontSize) || 13;
  return fs * 1.45;
}

function charWidthPx(textarea) {
  const cs = getComputedStyle(textarea);
  const canvas = charWidthPx._canvas || (charWidthPx._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return (Number.parseFloat(cs.fontSize) || 13) * 0.62;
  ctx.font = `${cs.fontStyle || 'normal'} ${cs.fontWeight || '400'} ${cs.fontSize || '13px'} ${cs.fontFamily || 'monospace'}`;
  return Math.max(1, ctx.measureText('0000000000').width / 10);
}

function lineColumnAtOffset(value = '', offset = 0) {
  const source = String(value || '');
  const end = Math.max(0, Math.min(Number(offset) || 0, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i++) {
    if (source[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, lineStart, column: Math.max(0, end - lineStart) };
}

function syncOverlayBox() {
  if (!codeText || !overlay) return;
  overlay.style.left = `${codeText.offsetLeft}px`;
  overlay.style.top = `${codeText.offsetTop}px`;
  overlay.style.width = `${codeText.clientWidth}px`;
  overlay.style.height = `${codeText.clientHeight}px`;
}

export function renderCodeLineHighlight() {
  if (!codeText || !currentTarget) return;
  ensureOverlay();
  if (!overlay || !rect) return;
  syncOverlayBox();
  const rawOffset = Math.max(0, Math.min(Number(currentTarget.rawOffset) || 0, String(codeText.value || '').length));
  const info = lineColumnAtOffset(codeText.value, rawOffset);
  const cs = getComputedStyle(codeText);
  const lineHeight = lineHeightPx(codeText);
  const paddingTop = Number.parseFloat(cs.paddingTop) || 0;
  const paddingLeft = Number.parseFloat(cs.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(cs.paddingRight) || 0;
  const contentWidth = Math.max(1, codeText.clientWidth - paddingLeft - paddingRight);
  const wrapDisabled = codeText.classList.contains('wrap-disabled') || codeText.wrap === 'off';
  let topWithin = paddingTop + ((info.line - 1) * lineHeight);
  if (!wrapDisabled) {
    const measuredTop = measureTextareaOffsetTop(codeText, rawOffset);
    if (Number.isFinite(measuredTop)) topWithin = measuredTop;
    else topWithin += Math.floor((info.column * charWidthPx(codeText)) / contentWidth) * lineHeight;
  }
  const top = topWithin - codeText.scrollTop;
  if (top < -lineHeight || top > codeText.clientHeight + lineHeight) {
    rect.hidden = true;
    return;
  }
  rect.hidden = false;
  rect.style.top = `${top}px`;
  rect.style.height = `${Math.max(2, lineHeight)}px`;
}

export function updateCodeLineHighlight(detail = {}) {
  currentTarget = { rawOffset: Math.max(0, Number(detail.rawOffset) || 0), editorLine: Math.max(1, Number(detail.editorLine) || 1) };
  renderCodeLineHighlight();
}

export function initCodeLineHighlight({ codeElement } = {}) {
  codeText = codeElement || codeText;
  ensureOverlay();
  codeText?.addEventListener('scroll', renderCodeLineHighlight, { passive: true });
  window.addEventListener('resize', renderCodeLineHighlight);
  window.addEventListener('ttedit-code-sync-target', event => updateCodeLineHighlight(event.detail || {}));
  window.addEventListener('ttedit-code-view-deferred-sync', renderCodeLineHighlight);
  if (window.ResizeObserver && codeText) {
    resizeObserver = new ResizeObserver(renderCodeLineHighlight);
    resizeObserver.observe(codeText);
  }
}
