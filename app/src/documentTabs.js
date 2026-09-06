import { getActiveDocumentId, listDocuments } from './state.js';
import { getRuntimeUiLanguage, translateRuntimeUiText } from './uiLanguageRuntime.js';
import { localizeSystemGeneratedNewDocumentName } from './documentName.js';

let root = null;
let onActivate = null;
let onClose = null;
let onNew = null;
let onReorder = null;
let onRename = null;
let onDuplicate = null;
let tabContextMenu = null;
let pointerDrag = null;
let suppressClickDocumentId = null;
let languageChangeListenerRegistered = false;

function escapeHtml(text) { return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

function clearDragClasses() {
  if (!root) return;
  root.querySelectorAll('.document-tab.dragging, .document-tab.drop-before, .document-tab.drop-after, .document-tab-add.drop-before').forEach(el => {
    el.classList.remove('dragging', 'drop-before', 'drop-after');
  });
}

function tabTitle(doc) {
  const rawName = doc.currentFileName || '';
  const name = (doc.systemGeneratedName === true
    ? localizeSystemGeneratedNewDocumentName(rawName, getRuntimeUiLanguage())
    : rawName) || translateRuntimeUiText('새 문서');
  return doc.dirty ? `*${name}` : name;
}


function getBeforeIdFromPointerX(clientX, draggingId) {
  if (!root) return null;
  const tabs = Array.from(root.querySelectorAll('.document-tab'));
  for (const tab of tabs) {
    const id = tab.dataset.documentId;
    if (!id || id === draggingId) continue;
    const rect = tab.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return id;
  }
  return null;
}

function updatePointerDropHint(clientX, draggingId) {
  clearDragClasses();
  if (!root || !draggingId) return;
  const beforeId = getBeforeIdFromPointerX(clientX, draggingId);
  if (beforeId) {
    root.querySelector(`.document-tab[data-document-id="${CSS.escape(beforeId)}"]`)?.classList.add('drop-before');
  } else {
    root.querySelector('.document-tab-add')?.classList.add('drop-before');
  }
}

function closeTabContextMenu() {
  if (tabContextMenu) tabContextMenu.hidden = true;
}

function ensureTabContextMenu() {
  if (tabContextMenu) return tabContextMenu;
  tabContextMenu = document.createElement('div');
  tabContextMenu.id = 'documentTabContextMenu';
  tabContextMenu.className = 'context-menu document-tab-context-menu';
  tabContextMenu.hidden = true;
  document.body.appendChild(tabContextMenu);
  document.addEventListener('mousedown', event => {
    if (!tabContextMenu?.contains(event.target)) closeTabContextMenu();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeTabContextMenu();
  }, true);
  window.addEventListener('blur', closeTabContextMenu);
  return tabContextMenu;
}

function addContextButton(menu, label, command, disabled = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.disabled = !!disabled;
  btn.addEventListener('mousedown', event => event.preventDefault());
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    closeTabContextMenu();
    await command();
  });
  menu.appendChild(btn);
}

function addContextSeparator(menu) {
  const sep = document.createElement('div');
  sep.className = 'context-separator';
  menu.appendChild(sep);
}

function showTabContextMenu(event, doc) {
  const menu = ensureTabContextMenu();
  menu.innerHTML = '';
  addContextButton(menu, '새 문서', () => onNew?.());
  addContextButton(menu, '문서명 변경..', () => onRename?.(doc.id));
  addContextButton(menu, '문서 복제..', () => onDuplicate?.(doc.id));
  addContextSeparator(menu);
  addContextButton(menu, '닫기', () => onClose?.(doc.id));
  const width = 210;
  const height = 132;
  const left = Math.max(0, Math.min(event.clientX, window.innerWidth - width - 4));
  const top = Math.max(0, Math.min(event.clientY, window.innerHeight - height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.hidden = false;
}

export function initDocumentTabs({ rootElement, activateDocument, closeDocument, newDocument, reorderDocument, renameDocument, duplicateDocument } = {}) {
  root = rootElement || null;
  onActivate = activateDocument || null;
  onClose = closeDocument || null;
  onNew = newDocument || null;
  onReorder = reorderDocument || null;
  onRename = renameDocument || null;
  onDuplicate = duplicateDocument || null;
  if (!languageChangeListenerRegistered && typeof document !== 'undefined') {
    languageChangeListenerRegistered = true;
    document.addEventListener('tooltipeditor:language-changed', () => renderDocumentTabs());
  }
  renderDocumentTabs();
}

export function renderDocumentTabs() {
  if (!root) return;
  const activeId = getActiveDocumentId();
  const docs = listDocuments();
  root.innerHTML = '';
  closeTabContextMenu();
  for (const doc of docs) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'document-tab' + (doc.id === activeId ? ' active' : '') + (doc.dirty ? ' dirty' : '');
    tab.dataset.documentId = doc.id;
    tab.title = doc.currentFilePath || tabTitle(doc);
    tab.innerHTML = `<span class="document-tab-title">${escapeHtml(tabTitle(doc))}</span><span class="document-tab-close" aria-hidden="true">×</span>`;
    tab.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      showTabContextMenu(event, doc);
    });
    tab.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (event.target?.closest?.('.document-tab-close')) { event.preventDefault(); return; }
      closeTabContextMenu();
      pointerDrag = { id: doc.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
      try { tab.setPointerCapture(event.pointerId); } catch (_) {}
    });
    tab.addEventListener('pointermove', event => {
      if (!pointerDrag || pointerDrag.id !== doc.id || pointerDrag.pointerId !== event.pointerId) return;
      const dx = Math.abs(event.clientX - pointerDrag.startX);
      const dy = Math.abs(event.clientY - pointerDrag.startY);
      if (!pointerDrag.dragging && (dx > 5 || dy > 5)) {
        pointerDrag.dragging = true;
        tab.classList.add('dragging');
      }
      if (pointerDrag.dragging) {
        event.preventDefault();
        updatePointerDropHint(event.clientX, pointerDrag.id);
      }
    });
    function finishPointer(event) {
      if (!pointerDrag || pointerDrag.id !== doc.id || pointerDrag.pointerId !== event.pointerId) return;
      const drag = pointerDrag;
      pointerDrag = null;
      try { tab.releasePointerCapture(event.pointerId); } catch (_) {}
      clearDragClasses();
      if (drag.dragging) {
        event.preventDefault();
        event.stopPropagation();
        suppressClickDocumentId = doc.id;
        const beforeId = getBeforeIdFromPointerX(event.clientX, doc.id);
        onReorder?.(doc.id, beforeId);
        window.setTimeout(() => { if (suppressClickDocumentId === doc.id) suppressClickDocumentId = null; }, 0);
      }
    }
    tab.addEventListener('pointerup', finishPointer);
    tab.addEventListener('pointercancel', event => {
      if (!pointerDrag || pointerDrag.id !== doc.id) return;
      pointerDrag = null;
      try { tab.releasePointerCapture(event.pointerId); } catch (_) {}
      clearDragClasses();
    });
    tab.addEventListener('click', event => {
      if (suppressClickDocumentId === doc.id) { suppressClickDocumentId = null; event.preventDefault(); return; }
      const close = event.target?.closest?.('.document-tab-close');
      if (close) {
        onClose?.(doc.id);
        return;
      }
      onActivate?.(doc.id);
    });
    root.appendChild(tab);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'document-tab-add';
  add.title = translateRuntimeUiText('새 문서 탭 추가');
  add.textContent = '+';
  add.addEventListener('mousedown', event => event.preventDefault());
  add.addEventListener('click', () => onNew?.());
  root.appendChild(add);
}
