import { focusableElements } from './focusTools.js';

const modalStack = [];
let installed = false;
let refocusing = false;

function topEntry() { return modalStack[modalStack.length - 1] || null; }
function asElement(target) {
  if (!target) return null;
  if (target.nodeType === Node.ELEMENT_NODE) return target;
  return target.parentElement || null;
}
function containsTarget(entry, target) {
  const el = asElement(target);
  return !!entry?.layer?.contains?.(el);
}
function isFocusableCandidate(el, entry) {
  if (!el || !entry?.layer?.contains?.(el) || !document.contains(el)) return false;
  if (el.disabled || el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return true;
}
function firstUsable(candidates, entry) {
  for (const candidate of candidates) {
    if (isFocusableCandidate(candidate, entry)) return candidate;
  }
  return null;
}
function fallbackDocumentFocusTarget() {
  const last = document.body.dataset.lastDocumentFocus || 'editor';
  const code = document.getElementById('codeText');
  const editor = document.getElementById('editorText');
  const ordered = last === 'code' ? [code, editor] : [editor, code];
  return ordered.find(el => el && document.contains(el) && !el.disabled && !el.hidden) || document.body;
}
function resolveFocusTarget(entry = topEntry()) {
  if (!entry) return null;
  const explicit = firstUsable([entry.initialFocus], entry);
  if (explicit) return explicit;
  const marked = firstUsable([...(entry.layer.querySelectorAll?.('[data-initial-focus]') || [])], entry);
  if (marked) return marked;
  const preferred = firstUsable([
    ...(entry.layer.querySelectorAll?.('input, textarea, select') || []),
    entry.defaultFocus,
    ...focusableElements(entry.win || entry.layer),
    entry.win,
    entry.layer,
  ], entry);
  return preferred;
}
function focusEntry(entry = topEntry()) {
  if (!entry || refocusing) return false;
  const target = resolveFocusTarget(entry);
  if (!target) return false;
  try {
    refocusing = true;
    target.focus?.({ preventScroll: true });
    if (!entry.didSelectInitial && target.dataset?.selectOnFocus === 'true' && typeof target.select === 'function') {
      target.select();
      entry.didSelectInitial = true;
    }
    return true;
  } catch (_) {
    return false;
  } finally {
    refocusing = false;
  }
}
function isRestorableTarget(target) {
  const el = asElement(target);
  if (!el || !document.contains(el) || el.closest?.('.modal-layer')) return false;
  if (el.disabled || el.hidden) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}
function restoreAfterClose(entry) {
  const next = topEntry();
  if (next) {
    focusEntry(next);
    return;
  }
  const target = isRestorableTarget(entry?.restoreFocus) ? entry.restoreFocus : fallbackDocumentFocusTarget();
  try { target?.focus?.({ preventScroll: true }); } catch (_) {}
}

function installGlobalGuards() {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', (event) => {
    const entry = topEntry();
    if (!entry) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (entry.allowEsc !== false) entry.onCancel?.();
    else focusEntry(entry);
  }, true);
  document.addEventListener('focusin', (event) => {
    const entry = topEntry();
    if (!entry || containsTarget(entry, event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    focusEntry(entry);
  }, true);
  document.addEventListener('pointerdown', (event) => {
    const entry = topEntry();
    if (!entry || containsTarget(entry, event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    focusEntry(entry);
  }, true);
  document.addEventListener('contextmenu', (event) => {
    const entry = topEntry();
    if (!entry || containsTarget(entry, event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    focusEntry(entry);
  }, true);
  window.addEventListener('focus', (event) => {
    const entry = topEntry();
    if (!entry || containsTarget(entry, event.target)) return;
    focusEntry(entry);
  }, true);
}

export function registerBlockingModal({ layer, win, onCancel, allowEsc = true, initialFocus = null, defaultFocus = null, restoreFocus = document.activeElement } = {}) {
  installGlobalGuards();
  const entry = { layer, win, onCancel, allowEsc, initialFocus, defaultFocus, restoreFocus };
  modalStack.push(entry);
  focusEntry(entry);
  return () => {
    const idx = modalStack.indexOf(entry);
    if (idx >= 0) modalStack.splice(idx, 1);
    restoreAfterClose(entry);
  };
}

export function hasActiveBlockingModal() { return modalStack.length > 0; }
export function getActiveBlockingModalElement() { return topEntry()?.layer || null; }
export function isTargetInsideTopBlockingModal(target) { return containsTarget(topEntry(), target); }
export function focusTopBlockingModal() { return focusEntry(topEntry()); }
