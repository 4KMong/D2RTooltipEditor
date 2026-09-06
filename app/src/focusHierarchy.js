import { hasActiveBlockingModal } from './blockingModalManager.js';
export const FOCUS_LAYERS = Object.freeze({
  MODAL: 'modal',
  FLOATING: 'floating-window',
  MENU: 'menu-bar',
  TOOLBAR_INPUT: 'toolbar-input',
  CODE_EDITOR: 'code-editor',
  PREVIEW_EDITOR: 'preview-editor',
  DOCUMENT_BODY: 'document-body',
});

export const FOCUS_PRIORITY = Object.freeze([
  FOCUS_LAYERS.MODAL,
  FOCUS_LAYERS.FLOATING,
  FOCUS_LAYERS.MENU,
  FOCUS_LAYERS.TOOLBAR_INPUT,
  FOCUS_LAYERS.CODE_EDITOR,
  FOCUS_LAYERS.PREVIEW_EDITOR,
  FOCUS_LAYERS.DOCUMENT_BODY,
]);

function asElement(target = document.activeElement) {
  if (!target) return null;
  if (target.nodeType === Node.ELEMENT_NODE) return target;
  return target.parentElement || null;
}

export function isModalLayerActive() {
  return hasActiveBlockingModal();
}

export function isFloatingLayerActive() {
  return !!document.querySelector('.floating-window');
}

export function isInsideFloatingWindow(target = document.activeElement) {
  return !!asElement(target)?.closest?.('.floating-window');
}

export function isInsideMenu(target = document.activeElement) {
  const el = asElement(target);
  return !!(el?.closest?.('.menu-bar, .menu-popup, .submenu-popup') || document.querySelector('.menu-group.open'));
}

export function isToolbarOrInputLayer(target = document.activeElement) {
  const el = asElement(target);
  if (!el) return false;
  if (el.closest?.('header, .toolbar, .status-bar')) return true;
  if (el.matches?.('input, select, button')) return true;
  return false;
}

export function isDocumentEditor(target = document.activeElement) {
  const el = asElement(target);
  return el?.id === 'codeText' || el?.id === 'editorText';
}

export function getFocusLayer(target = document.activeElement) {
  const el = asElement(target);
  if (isModalLayerActive()) return FOCUS_LAYERS.MODAL;
  if (isInsideFloatingWindow(el)) return FOCUS_LAYERS.FLOATING;
  if (isInsideMenu(el)) return FOCUS_LAYERS.MENU;
  if (el?.id === 'codeText') return FOCUS_LAYERS.CODE_EDITOR;
  if (el?.id === 'editorText') return FOCUS_LAYERS.PREVIEW_EDITOR;
  if (isToolbarOrInputLayer(el)) return FOCUS_LAYERS.TOOLBAR_INPUT;
  return FOCUS_LAYERS.DOCUMENT_BODY;
}

export function layerPriorityIndex(layer) {
  const index = FOCUS_PRIORITY.indexOf(layer);
  return index >= 0 ? index : FOCUS_PRIORITY.length - 1;
}

export function shouldYieldGlobalShortcutToFocusLayer(event) {
  const layer = getFocusLayer(event?.target || document.activeElement);
  return layer === FOCUS_LAYERS.MODAL || layer === FOCUS_LAYERS.FLOATING || layer === FOCUS_LAYERS.MENU;
}

export function focusLayerLabel(layer = getFocusLayer()) {
  switch (layer) {
    case FOCUS_LAYERS.MODAL: return 'modal';
    case FOCUS_LAYERS.FLOATING: return 'floating window';
    case FOCUS_LAYERS.MENU: return 'menu bar/menu popup';
    case FOCUS_LAYERS.TOOLBAR_INPUT: return 'toolbar/input';
    case FOCUS_LAYERS.CODE_EDITOR: return 'code editor';
    case FOCUS_LAYERS.PREVIEW_EDITOR: return 'preview editor';
    default: return 'document body';
  }
}
