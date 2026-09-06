import { playDong } from './sound.js';
import { attachHex4Input } from './inputFilter.js';
import { trapTabInside as trapTabFocus } from './focusTools.js';
import { registerBlockingModal, hasActiveBlockingModal } from './blockingModalManager.js';

let modalSeq = 0;
const modalStack = [];

function root() {
  let r = document.getElementById('modalRoot');
  if (!r) {
    r = document.createElement('div');
    r.id = 'modalRoot';
    r.className = 'modal-root';
    r.hidden = true;
    document.body.appendChild(r);
  }
  return r;
}

function stripWindowSuffix(title) { return String(title || '').replace(/\.\.$/, ''); }
function escapeHtml(text) { return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }


function normalizeModalButtonText(text = '') { return String(text || '').replace(/\s+/g, ''); }
function inferModalShortcutKey(buttons = [], index = 0) {
  const button = buttons[index] || {};
  if (button.shortcutKey) return String(button.shortcutKey).toLowerCase();
  const labels = buttons.map(btn => normalizeModalButtonText(btn?.text));
  const label = labels[index] || '';
  if (labels.length === 1) {
    if (label === '확인' || label === '예') return 'y';
    return '';
  }
  if (labels.length === 2) {
    if (label === '확인' || label === '예') return 'y';
    if (label === '취소' || label === '아니오') return 'n';
    return '';
  }
  if (labels.length === 3 && labels.includes('예') && labels.includes('아니오') && labels.includes('취소')) {
    if (label === '예') return 'y';
    if (label === '아니오') return 'n';
    if (label === '취소') return 'c';
  }
  return '';
}

function topEntry() { return modalStack[modalStack.length - 1] || null; }

function footerButtonsInDialogOrder(footer) {
  return Array.from(footer?.querySelectorAll?.('button[data-modal-value]') || []).filter(btn => !btn.disabled && !btn.hidden);
}

function defaultFooterButton(footer, buttons = footerButtonsInDialogOrder(footer)) {
  return buttons.find(btn => btn.dataset.defaultButton === 'true') || buttons[0] || null;
}

function moveFooterButtonFocus(footer, direction) {
  const buttons = footerButtonsInDialogOrder(footer);
  if (!buttons.length) return false;
  const active = document.activeElement;
  const current = buttons.indexOf(active);
  const start = current >= 0 ? current : Math.max(0, buttons.indexOf(defaultFooterButton(footer, buttons)));
  const next = (start + direction + buttons.length) % buttons.length;
  buttons[next].focus({ preventScroll: true });
  return true;
}

function footerButtonForShortcut(footer, key) {
  const wanted = String(key || '').toLowerCase();
  if (!wanted || wanted.length !== 1) return null;
  return footerButtonsInDialogOrder(footer).find(btn => String(btn.dataset.shortcutKey || '').toLowerCase() === wanted) || null;
}

function keyToShortcut(event) {
  if (!event) return '';
  if (event.key && event.key.length === 1) return event.key.toLowerCase();
  const code = String(event.code || '');
  const match = /^Key([A-Z])$/.exec(code);
  return match ? match[1].toLowerCase() : '';
}

function focusedFooterButton(footer) {
  const active = document.activeElement;
  const buttons = footerButtonsInDialogOrder(footer);
  return buttons.includes(active) ? active : null;
}

function isTopModalEvent(entry) {
  return !!entry && topEntry() === entry;
}

function isTextEditingTarget(target) {
  const el = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  if (!el) return false;
  if (el.closest?.('.modal-footer')) return false;
  if (el.isContentEditable) return true;
  if (!el.matches?.('input, textarea, select')) return false;
  const type = String(el.type || '').toLowerCase();
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(type);
}


function trapModalTab(entry, event) {
  return trapTabFocus(entry?.win, event, { fallbackFocus: entry?.layer });
}


export function hasBlockingModal() { return hasActiveBlockingModal(); }

export function pokeTopModal(sound = true) {
  const top = topEntry();
  if (!top) return false;
  blinkWindow(top.win, sound);
  return true;
}

function blinkWindow(win, sound = true) {
  if (!win) return;
  if (sound) playDong();
  win.classList.remove('modal-blink');
  void win.offsetWidth;
  win.classList.add('modal-blink');
}

function centerWindow(win) {
  const rect = win.getBoundingClientRect();
  win.style.left = `${Math.max(18, Math.round((window.innerWidth - rect.width) / 2))}px`;
  win.style.top = `${Math.max(18, Math.round((window.innerHeight - rect.height) / 2))}px`;
  constrainWindow(win);
}

function constrainWindow(win) {
  const rect = win.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width);
  const maxTop = Math.max(0, window.innerHeight - rect.height);
  win.style.left = `${clamp(rect.left, 0, maxLeft)}px`;
  win.style.top = `${clamp(rect.top, 0, maxTop)}px`;
}

function makeDraggable(win, header) {
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
    constrainWindow(win);
  }
  header.addEventListener('pointerup', finish);
  header.addEventListener('pointercancel', finish);
}

function removeModalEntry(entry) {
  const idx = modalStack.indexOf(entry);
  if (idx >= 0) modalStack.splice(idx, 1);
  entry.layer.remove();
  const r = root();
  r.hidden = modalStack.length === 0;
}

export function showModal({ title, body, buttons = [], allowEsc = true, soundOnOpen = false, windowClass = '' }) {
  return new Promise((resolve) => {
    const restoreFocus = document.activeElement;
    const r = root();
    r.hidden = false;
    if (soundOnOpen) playDong();

    const layer = document.createElement('div');
    layer.className = 'modal-layer';
    layer.tabIndex = -1;
    layer.dataset.modalId = String(++modalSeq);

    const win = document.createElement('div');
    win.className = 'modal-window';
    if (windowClass) win.classList.add(...String(windowClass).split(/\s+/).filter(Boolean));
    const header = document.createElement('div');
    header.className = 'modal-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'modal-title-text';
    titleEl.textContent = stripWindowSuffix(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close-button';
    closeBtn.textContent = '×';
    closeBtn.title = '닫기';
    header.append(titleEl, closeBtn);

    const content = document.createElement('div');
    content.className = 'modal-body';
    if (typeof body === 'string') content.innerHTML = body;
    else content.appendChild(body);
    const footer = document.createElement('div');
    footer.className = 'modal-footer';

    const entry = { layer, win, footer, getDefaultButton: () => defaultButton, finish: (value) => finish(value), allowEsc };
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      removeModalEntry(entry);
      entry.unregisterBlocking?.();
      resolve(value);
    };
    closeBtn.addEventListener('click', () => finish('cancel'));

    let defaultButton = null;
    for (const [buttonIndex, btn] of buttons.entries()) {
      const b = document.createElement('button');
      b.type = 'button';
      const shortcutKey = inferModalShortcutKey(buttons, buttonIndex);
      if (btn.html) b.innerHTML = btn.html;
      else b.textContent = btn.text;
      if (shortcutKey) {
        b.dataset.shortcutKey = shortcutKey;
        if (!btn.html && btn.text) b.innerHTML = `${escapeHtml(btn.text)}(<u>${escapeHtml(shortcutKey.toUpperCase())}</u>)`;
      }
      b.dataset.modalValue = btn.value;
      if (btn.default || (!defaultButton && buttons.length === 1)) b.dataset.defaultButton = 'true';
      b.addEventListener('click', () => finish(btn.value));
      footer.appendChild(b);
      if (btn.default || (!defaultButton && buttons.length === 1)) defaultButton = b;
    }

    win.append(header, content, footer);
    layer.appendChild(win);
    r.appendChild(layer);
    modalStack.push(entry);
    const initialFocus = win.querySelector('[data-initial-focus]');
    entry.unregisterBlocking = registerBlockingModal({ layer, win, allowEsc, onCancel: () => finish('cancel'), initialFocus, defaultFocus: defaultButton, restoreFocus });
    makeDraggable(win, header);
    requestAnimationFrame(() => centerWindow(win));

    layer.addEventListener('mousedown', (event) => {
      if (event.target === layer) {
        event.preventDefault();
        event.stopPropagation();
        blinkWindow(win, true);
      }
    });
    layer.addEventListener('contextmenu', (event) => event.preventDefault());
  });
}

export function showInputModal({ title, label, defaultValue = '', placeholder = '', maxLength = null, pattern = null, filter = null }) {
  const wrap = document.createElement('div');
  const row = document.createElement('label');
  row.className = 'form-row';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.initialFocus = 'true';
  input.value = defaultValue;
  input.placeholder = placeholder;
  if (maxLength) input.maxLength = maxLength;
  row.append(span, input);
  wrap.appendChild(row);

  input.dataset.selectOnFocus = 'true';
  if (filter === 'hex4' || pattern === '[0-9a-fA-F]') attachHex4Input(input);
  const promise = showModal({ title, body: wrap, buttons: [{ text: '확인', value: 'ok', default: true, shortcutKey: 'y' }, { text: '취소', value: 'cancel', shortcutKey: 'n' }] });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const layer = input.closest('.modal-layer');
      layer?.querySelector('.modal-footer button[data-modal-value="ok"]')?.click();
    }
  });
  return promise.then((value) => value === 'ok' ? input.value : null);
}

export async function showConfirmModal(message, { title = '확인' } = {}) {
  const body = document.createElement('div');
  body.className = 'confirm-message';
  body.textContent = message;
  const result = await showModal({
    title,
    body,
    soundOnOpen: true,
    buttons: [{ text: '확인', value: 'ok', default: true, shortcutKey: 'y' }, { text: '취소', value: 'cancel', shortcutKey: 'n' }],
  });
  return result === 'ok';
}

export async function showAlertModal(message, { title = '알림' } = {}) {
  const body = document.createElement('div');
  body.className = 'confirm-message';
  body.textContent = message;
  await showModal({
    title,
    body,
    soundOnOpen: true,
    buttons: [{ text: '확인', value: 'ok', default: true, shortcutKey: 'y' }],
  });
}


function routeTopModalKeydown(event) {
  const entry = topEntry();
  if (!isTopModalEvent(entry)) return;
  const footer = entry.footer;
  const defaultButton = entry.getDefaultButton?.();

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (entry.allowEsc !== false) entry.finish?.('cancel');
    else blinkWindow(entry.win, true);
    return;
  }

  if (event.key === 'Tab') {
    trapModalTab(entry, event);
    event.stopImmediatePropagation();
    return;
  }

  const arrowDirection = event.key === 'ArrowRight' ? 1 : (event.key === 'ArrowLeft' ? -1 : 0);
  if (arrowDirection && !event.altKey && !event.ctrlKey && !event.metaKey && !isTextEditingTarget(event.target)) {
    if (moveFooterButtonFocus(footer, arrowDirection)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  }

  if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
    const shortcut = keyToShortcut(event);
    const targetButton = footerButtonForShortcut(footer, shortcut);
    const plainShortcutAllowed = !event.altKey && !isTextEditingTarget(event.target);
    const altShortcutAllowed = event.altKey;
    if (targetButton && (plainShortcutAllowed || altShortcutAllowed)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      targetButton.click();
      return;
    }
  }

  if (event.key === 'Enter' || event.key === ' ') {
    const activeButton = focusedFooterButton(footer);
    const targetButton = activeButton || (!isTextEditingTarget(event.target) ? defaultButton : null);
    if (targetButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      targetButton.click();
    }
  }
}

document.addEventListener('keydown', routeTopModalKeydown, true);
