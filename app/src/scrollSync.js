import { state } from "./state.js";
import { getCodeTextArea, getEditorTextArea, isCodePaneDisplayPaused } from "./syncViews.js";
import { offsetToLineNumber } from "./textCodec.js";
import { lineAtScrollTop } from "./lineNumbers.js";
import { parseRawCode } from "./rawCodeModel.js";
import { measureTextareaOffsetTop } from './codeOffsetMeasure.js';

export function initScrollSync() {}

function enabled() {
  return !!state.scrollSyncEnabled;
}

export function handleViewActivity(kind, source) {
  if (!enabled()) return;
  if (kind === "change") return;
  // v0.01-beta 보정: 스크롤 동기화의 기준은 항상 편집창이다.
  // 코드 텍스트창 스크롤이 다시 편집창을 움직이면 양쪽이 서로 반사되어 멈춘 것처럼 보인다.
  if (source !== "editor") return;
  syncCodeFromEditor(kind);
}

function syncCodeFromEditor(kind) {
  if (isCodePaneDisplayPaused()) return;
  const editor = getEditorTextArea();
  const code = getCodeTextArea();
  if (!editor || !code) return;
  const line = kind === "cursor"
    ? offsetToLineNumber(editor.value, editor.selectionStart ?? 0)
    : lineAtScrollTop(editor.scrollTop);
  const offset = rawOffsetForVisibleLine(state.rawCode, line);
  scrollCodeNearOffset(code, offset);
  notifyCodeLineHighlight(offset, line);
}


function rawOffsetForVisibleLine(rawCode = '', lineNumber = 1) {
  const model = parseRawCode(rawCode || '');
  const line = Math.max(1, Number.parseInt(lineNumber, 10) || 1);
  const entry = model.lineIndex?.[line - 1];
  return Math.max(0, Math.min(entry?.rawOffset ?? model.rawLength ?? 0, model.rawLength ?? 0));
}

function textareaCharWidth(textarea) {
  const cs = getComputedStyle(textarea);
  const font = `${cs.fontStyle || 'normal'} ${cs.fontWeight || '400'} ${cs.fontSize || '13px'} ${cs.fontFamily || 'monospace'}`;
  const canvas = textareaCharWidth._canvas || (textareaCharWidth._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return (Number.parseFloat(cs.fontSize) || 13) * 0.62;
  ctx.font = font;
  return Math.max(1, ctx.measureText('0000000000').width / 10);
}

function codeLineColumnAtOffset(value = '', offset = 0) {
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

function notifyCodeLineHighlight(offset, editorLine) {
  try {
    window.dispatchEvent(new CustomEvent('ttedit-code-sync-target', { detail: { rawOffset: offset, editorLine } }));
  } catch (_) {}
}

function codeLineHeight(textarea) {
  const cs = getComputedStyle(textarea);
  const lh = Number.parseFloat(cs.lineHeight);
  if (Number.isFinite(lh) && lh > 0) return lh;
  const fs = Number.parseFloat(cs.fontSize) || 15;
  return fs * 1.45;
}

function scrollCodeNearOffset(textarea, offset) {
  const value = String(textarea.value || "");
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, value.length));
  const lineInfo = codeLineColumnAtOffset(value, safeOffset);
  const lineHeight = codeLineHeight(textarea);
  const charWidth = textareaCharWidth(textarea);
  const cs = getComputedStyle(textarea);
  const paddingLeft = Number.parseFloat(cs.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(cs.paddingRight) || 0;
  const contentWidth = Math.max(1, textarea.clientWidth - paddingLeft - paddingRight);
  const wrapDisabled = textarea.classList.contains('wrap-disabled') || textarea.wrap === 'off';
  let targetContentTop = (lineInfo.line - 1) * lineHeight;
  if (!wrapDisabled) {
    const measuredTop = measureTextareaOffsetTop(textarea, safeOffset);
    if (Number.isFinite(measuredTop)) targetContentTop = measuredTop;
    else targetContentTop += Math.floor((lineInfo.column * charWidth) / contentWidth) * lineHeight;
  }
  const targetTop = targetContentTop - Math.max(0, (textarea.clientHeight - lineHeight) * 0.5);
  const maxTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
  textarea.scrollTop = Math.max(0, Math.min(maxTop, targetTop));
  if (wrapDisabled) {
    const targetLeft = lineInfo.column * charWidth - Math.max(0, textarea.clientWidth * 0.35);
    const maxLeft = Math.max(0, textarea.scrollWidth - textarea.clientWidth);
    textarea.scrollLeft = Math.max(0, Math.min(maxLeft, targetLeft));
  } else {
    textarea.scrollLeft = 0;
  }
}
