import { playDong } from './sound.js';
import { isVisibleElement, trapTabInside as trapTabFocus } from './focusTools.js';
import { isModalLayerActive } from './focusHierarchy.js';
import { hasActiveBlockingModal, focusTopBlockingModal } from './blockingModalManager.js';

let zTop = 300;
const windows = new Set();
let activeTopLevel = null;
let inactiveOpacity = 0.40;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function isVisibleTextArea(el) { return isVisibleElement(el); }

function preferredDocumentTextArea() {
  const code = document.getElementById('codeText');
  const editor = document.getElementById('editorText');
  const last = document.body.dataset.lastDocumentFocus || 'editor';
  const order = last === 'code' ? [code, editor] : [editor, code];
  return order.find(isVisibleTextArea) || editor || code || null;
}

function restoreDocumentFocusAfterFloatingClosed() {
  if (hasActiveBlockingModal()) { focusTopBlockingModal(); return; }
  const active = document.activeElement;
  if (active && active.matches?.('textarea.editor-box')) return;
  const target = preferredDocumentTextArea();
  if (!target) return;
  const now = document.activeElement;
  if (now && now.matches?.('textarea.editor-box')) return;
  target.focus({ preventScroll: true });
}
function scheduleDocumentFocusAfterFloatingClosed() {
  requestAnimationFrame(() => {
    if (activeTopLevel || hasActiveBlockingModal()) {
      if (hasActiveBlockingModal()) focusTopBlockingModal();
      return;
    }
    restoreDocumentFocusAfterFloatingClosed();
  });
}

function constrain(win) {
  const rect = win.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width);
  const maxTop = Math.max(0, window.innerHeight - rect.height);
  const left = clamp(rect.left, 0, maxLeft);
  const top = clamp(rect.top, 0, maxTop);
  win.style.left = `${left}px`;
  win.style.top = `${top}px`;
}


function closeActiveInlinePopupFromEvent(event) {
  const combo = event.target?.closest?.('.fr-combo');
  const popup = combo?.querySelector?.('.fr-history-popup:not([hidden])');
  if (popup) {
    popup.hidden = true;
    const input = combo.querySelector?.('input');
    if (input) {
      input.focus({ preventScroll: true });
      if (typeof input.setSelectionRange === 'function') {
        const pos = input.selectionStart ?? input.value.length;
        try { input.setSelectionRange(pos, pos); } catch (_) {}
      }
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  const prefPanel = document.querySelector('.pref-font-panel:not([hidden])');
  if (prefPanel && (prefPanel.contains(event.target) || event.target?.closest?.('.pref-font-picker-button'))) {
    prefPanel.hidden = true;
    const button = document.querySelector('.pref-font-picker-button');
    button?.focus?.({ preventScroll: true });
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  return false;
}

function blink(win) {
  if (!win) return;
  playDong();
  win.classList.remove('modal-blink');
  void win.offsetWidth;
  win.classList.add('modal-blink');
}


function trapFloatingTab(win, event) {
  return trapTabFocus(win, event, { fallbackFocus: win });
}


export function setFloatingInactiveOpacity(value) {
  const n = Number(value);
  inactiveOpacity = Number.isFinite(n) ? Math.max(0.1, Math.min(1, n)) : 0.40;
  document.documentElement.style.setProperty('--inactive-floating-opacity', String(inactiveOpacity));
}
export function getFloatingInactiveOpacity() { return inactiveOpacity; }
export function hasFloatingWindow() { return !!activeTopLevel; }
export function getActiveFloatingWindow() { return activeTopLevel; }
export function pokeActiveFloatingWindow() { if (activeTopLevel) { focusFloatingWindow(activeTopLevel); blink(activeTopLevel); return true; } return false; }
export function setFloatingWindowInactive(inactive) { if (activeTopLevel) activeTopLevel.classList.toggle('floating-inactive', !!inactive); }

export function attachFloatingOpacityControl(win, { label = '창 투명도' } = {}) {
  const header = win?.querySelector?.('.floating-header');
  const closeBtn = win?.querySelector?.('.floating-close');
  if (!header || !closeBtn) return null;
  if (header.querySelector('.floating-header-opacity')) return header.querySelector('.floating-header-opacity');
  const box = document.createElement('span');
  box.className = 'floating-header-opacity fr-header-opacity';
  box.innerHTML = `<input type="range" min="35" max="100" step="1" value="100" aria-label="${label}" title="${label}">`;
  header.insertBefore(box, closeBtn);
  const slider = box.querySelector('input');
  slider.addEventListener('mousedown', event => event.stopPropagation());
  slider.addEventListener('pointerdown', event => event.stopPropagation());
  slider.addEventListener('input', () => { win.style.opacity = String(Number(slider.value) / 100); });
  return box;
}

export function focusFloatingWindow(win) {
  if (!win) return false;
  if (hasActiveBlockingModal()) {
    focusTopBlockingModal();
    return false;
  }
  zTop += 1;
  win.style.zIndex = String(zTop);
  for (const other of windows) other.classList.toggle('floating-inactive', other !== win);
  win.classList.remove('floating-inactive');
  try { win.focus({ preventScroll: true }); } catch (_) {}
  return true;
}

export function createFloatingWindow({ title, width = 760, height = 520, content, onClose = null, topLevel = true, opacityControl = topLevel }) {
  if (topLevel && activeTopLevel) {
    pokeActiveFloatingWindow();
    return null;
  }
  const win = document.createElement('section');
  win.className = 'floating-window';
  win.style.width = `${width}px`;
  if (height != null) win.style.height = `${height}px`;
  win.style.left = `${Math.max(12, Math.round((window.innerWidth - width) / 2))}px`;
  win.style.top = `${Math.max(12, Math.round((window.innerHeight - (height || 300)) / 2))}px`;

  const header = document.createElement('div');
  header.className = 'floating-header';
  const titleEl = document.createElement('span');
  titleEl.className = 'floating-title-text';
  titleEl.textContent = title || '';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'floating-close';
  closeBtn.textContent = '×';
  closeBtn.title = '닫기';
  header.append(titleEl, closeBtn);

  const body = document.createElement('div');
  body.className = 'floating-body';
  if (content) body.appendChild(content);
  win.append(header, body);
  win.tabIndex = -1;
  document.body.appendChild(win);
  windows.add(win);
  if (topLevel) activeTopLevel = win;
  if (opacityControl) attachFloatingOpacityControl(win);
  focusFloatingWindow(win);
  constrain(win);

  const close = () => closeFloatingWindow(win, onClose);
  closeBtn.addEventListener('click', close);
  win.addEventListener('mousedown', () => { if (focusFloatingWindow(win)) setFloatingWindowInactive(false); }, true);
  win.addEventListener('contextmenu', (event) => event.preventDefault());
  win.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (closeActiveInlinePopupFromEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target !== header) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = win.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    header.setPointerCapture(event.pointerId);
    focusFloatingWindow(win);
    event.preventDefault();
  });
  header.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = win.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    win.style.left = `${clamp(startLeft + event.clientX - startX, 0, maxLeft)}px`;
    win.style.top = `${clamp(startTop + event.clientY - startY, 0, maxTop)}px`;
  });
  function finish(event) {
    if (!dragging) return;
    dragging = false;
    try { header.releasePointerCapture(event.pointerId); } catch (_) {}
    constrain(win);
  }
  header.addEventListener('pointerup', finish);
  header.addEventListener('pointercancel', finish);

  const resizeHandler = () => constrain(win);
  window.addEventListener('resize', resizeHandler);
  win.__floatingResizeHandler = resizeHandler;
  win.__floatingOnClose = onClose;
  return win;
}

export function closeFloatingWindow(win, onClose = null) {
  if (!win) return;
  windows.delete(win);
  if (activeTopLevel === win) activeTopLevel = null;
  if (win.__floatingResizeHandler) window.removeEventListener('resize', win.__floatingResizeHandler);
  win.remove();
  const callback = onClose || win.__floatingOnClose;
  win.__floatingOnClose = null;
  callback?.();
  const top = [...windows].sort((a, b) => Number(b.style.zIndex || 0) - Number(a.style.zIndex || 0))[0];
  if (top) focusFloatingWindow(top);
  else scheduleDocumentFocusAfterFloatingClosed();
}


document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  if (!activeTopLevel) return;
  if (isModalLayerActive()) return;
  if (event.key === 'Escape') {
    if (closeActiveInlinePopupFromEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    closeFloatingWindow(activeTopLevel);
    return;
  }
  if (event.key === 'Tab') {
    trapFloatingTab(activeTopLevel, event);
  }
}, true);


window.addEventListener('focus', () => {
  // Alt+Tab 복귀 시 blocking modal이 있으면 modal manager가 최상위 modal을 가진다.
  if (hasActiveBlockingModal()) { focusTopBlockingModal(); return; }
  if (!activeTopLevel || isModalLayerActive()) return;
  if (!document.contains(activeTopLevel)) return;
  const active = document.activeElement;
  if (activeTopLevel.contains(active)) {
    activeTopLevel.classList.remove('floating-inactive');
    return;
  }
  if (focusFloatingWindow(activeTopLevel)) activeTopLevel.classList.remove('floating-inactive');
});
