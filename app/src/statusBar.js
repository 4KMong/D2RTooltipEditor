import { rawCodeContainsZeroWidth2060 } from './rawCodeModel.js';
import { translateRuntimeUiText } from './uiLanguageRuntime.js';
const slots = new Map();
let statusEl = null;
let messageEl = null;
let slotsEl = null;
let codeSlotsEl = null;
let editorInfoEl = null;
const slotTimers = new Map();
let stickyAlert = false;
let cursorLocation = '편집창';
let lastEditorInfoKey = '';
let lastEditorInfoData = null;
let languageChangeListenerRegistered = false;

let lastMessageText = '';
let lastMessageAt = 0;
const LOW_VALUE_STATUS_MESSAGES = new Set([
  '수정',
  'Tab 이동은 비활성화됨',
  '창 비율 조절 중',
]);

function normalizeCursorLocation(value) {
  const text = String(value || '').trim();
  if (text === 'code' || text === '코드창' || text === '코드창 수정') return '코드창';
  if (text === 'editor' || text === '편집창' || text === '편집창 수정') return '편집창';
  if (text === 'menu' || text === '메뉴바') return '메뉴바';
  return text || '편집창';
}

function isCursorStatusMessage(message) {
  const text = String(message || '').trim();
  return ['코드창', '편집창', '메뉴바', '코드창 수정', '편집창 수정'].includes(text);
}

function statusChannelForType(type = 'info') {
  if (type === 'error' || type === 'warning') return 'alert';
  return 'message';
}

function statusLabelForType(type = 'info') {
  if (type === 'error') return '오류';
  if (type === 'warning') return '주의';
  if (type === 'success') return '완료';
  return '작업';
}

function clearSlotTimer(id) {
  const timer = slotTimers.get(id);
  if (timer) window.clearTimeout(timer);
  slotTimers.delete(id);
}

function clearTimedSlot(id) {
  clearSlotTimer(id);
  if (id === 'alert' && stickyAlert) return;
  setStatusSlot(id, '', { visible: false });
}

function shouldSuppressStatus(message, options = {}) {
  if (options.force) return false;
  const type = options.type || 'info';
  if (type === 'error' || type === 'warning' || options.sticky) return false;
  const text = String(message || '').trim();
  if (!text) return false;
  if (LOW_VALUE_STATUS_MESSAGES.has(text)) return true;
  if (/^창 비율 조절 중/.test(text)) return true;
  const now = Date.now();
  if (text === lastMessageText && now - lastMessageAt < 700) return true;
  lastMessageText = text;
  lastMessageAt = now;
  return false;
}

function escapeText(text) { return String(text ?? ''); }

function setRootDatasetValue(key, value) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (document.documentElement.dataset.developerMode !== 'true') return;
  const next = String(value ?? '');
  if (document.documentElement.dataset[key] !== next) document.documentElement.dataset[key] = next;
}

function targetContainerForSlot(id) {
  if (id === 'codeMessage' && codeSlotsEl) return codeSlotsEl;
  return slotsEl;
}

function createSlotElement(id, slot) {
  const item = document.createElement('span');
  item.className = 'status-slot';
  item.dataset.slot = id;
  if (slot.type) item.dataset.type = slot.type;
  if (slot.tone) item.dataset.tone = slot.tone;
  if (slot.className) item.classList.add(...String(slot.className).split(/\s+/).filter(Boolean));
  if (slot.label) {
    const label = document.createElement('span');
    label.className = 'status-slot-label';
    label.textContent = `${translateRuntimeUiText(slot.label)}:`;
    item.appendChild(label);
  }
  const value = document.createElement('span');
  value.className = 'status-slot-value';
  value.textContent = translateRuntimeUiText(String(slot.value));
  item.appendChild(value);
  if (slot.detail) {
    const separator = document.createElement('span');
    separator.className = 'status-slot-separator';
    separator.setAttribute('aria-hidden', 'true');
    item.appendChild(separator);
    const detail = document.createElement('span');
    detail.className = 'status-slot-detail';
    detail.textContent = translateRuntimeUiText(String(slot.detail));
    item.appendChild(detail);
  }
  return item;
}

function renderSlots() {
  if (!slotsEl) return;
  const ordered = [...slots.entries()]
    .filter(([, slot]) => slot.visible !== false && slot.value !== null && slot.value !== undefined && slot.value !== '')
    .sort((a, b) => (a[1].order ?? 100) - (b[1].order ?? 100));
  slotsEl.innerHTML = '';
  if (codeSlotsEl) codeSlotsEl.innerHTML = '';
  for (const [id, slot] of ordered) {
    const target = targetContainerForSlot(id);
    if (!target) continue;
    target.appendChild(createSlotElement(id, slot));
  }
}

function renderEditorInfo(data) {
  if (!editorInfoEl) return;
  const { fileName, hasPath, dirty, saved, hasZeroWidth, hasTab } = data;
  lastEditorInfoData = { ...data };
  const languageKey = typeof document !== 'undefined' ? (document.documentElement?.dataset?.uiLanguage || 'ko') : 'ko';
  const key = [languageKey, fileName, hasPath ? '1' : '0', dirty ? '1' : '0', saved ? '1' : '0', hasZeroWidth ? '1' : '0', hasTab ? '1' : '0'].join('|');
  if (key === lastEditorInfoKey) return;
  lastEditorInfoKey = key;
  const fileText = hasPath ? escapeText(fileName) : translateRuntimeUiText('저장되지 않음');
  const fileSpan = document.createElement('span');
  fileSpan.className = hasPath ? 'editor-file-name' : 'editor-file-unsaved';
  fileSpan.textContent = fileText + (dirty ? '*' : '');

  const stateText = saved ? translateRuntimeUiText('저장됨') : '';
  const zero = document.createElement('span');
  zero.className = hasZeroWidth ? 'zero-width-state has-zero-width' : 'zero-width-state';
  zero.textContent = translateRuntimeUiText(hasZeroWidth ? 'U+2060 삽입되어 있음' : 'U+2060 삽입되어있지 않음');
  const tab = document.createElement('span');
  tab.className = hasTab ? 'tab-state has-tab' : 'tab-state';
  tab.textContent = translateRuntimeUiText(hasTab ? '탭 삽입되어 있음' : '탭 삽입되어있지 않음');

  editorInfoEl.innerHTML = '';
  editorInfoEl.append('(');
  editorInfoEl.appendChild(fileSpan);
  if (stateText) editorInfoEl.append(`, ${stateText} / `);
  else editorInfoEl.append(' / ');
  editorInfoEl.appendChild(zero);
  editorInfoEl.append(' / ');
  editorInfoEl.appendChild(tab);
  editorInfoEl.append(')');
}

export function initStatusBar({ root, message, slots: slotContainer, codeSlots: codeSlotContainer = null, editorInfo = null }) {
  statusEl = root;
  messageEl = message;
  slotsEl = slotContainer;
  codeSlotsEl = codeSlotContainer;
  editorInfoEl = editorInfo || document.getElementById('editorFileStatus');
  statusEl?.classList.add('status-bar-slotted');
  if (!languageChangeListenerRegistered && typeof document !== 'undefined') {
    languageChangeListenerRegistered = true;
    document.addEventListener('tooltipeditor:language-changed', () => {
      lastEditorInfoKey = '';
      renderSlots();
      if (lastEditorInfoData) renderEditorInfo(lastEditorInfoData);
    });
  }
  if (messageEl) {
    messageEl.textContent = '';
    messageEl.hidden = true;
    messageEl.setAttribute('aria-hidden', 'true');
  }
  registerStatusSlot('mode', { label: '모드', value: '', order: 10, visible: false, type: 'mode' });
  registerStatusSlot('length', { label: '문서', value: '0자 / 1행', order: 20, type: 'document' });
  registerStatusSlot('cursor', { label: '커서', value: cursorLocation, order: 30, type: 'cursor' });
  registerStatusSlot('message', { label: '편집창', value: '준비됨', order: 40, type: 'info' });
  registerStatusSlot('codeMessage', { label: '코드창', value: '준비됨', order: 45, type: 'info' });
  registerStatusSlot('alert', { label: '주의', value: '', order: 50, visible: false, type: 'warning' });
}



export function setCursorLocation(location, options = {}) {
  cursorLocation = normalizeCursorLocation(location);
  setStatusSlot('cursor', cursorLocation, { label: '커서', order: 30, visible: true, type: 'cursor' });
}

export function clearStickyStatus() {
  stickyAlert = false;
  clearTimedSlot('alert');
}

export function beginUserAction() {
  if (stickyAlert) clearStickyStatus();
}

export function setStatusMessage(message, options = {}) {
  const text = String(message || '').trim();
  if (!text || text === '준비됨') {
    setStatusSlot('message', '준비됨', { label: '편집창', order: 40, visible: true, type: 'info' });
    return;
  }
  if (isCursorStatusMessage(text)) { setCursorLocation(text, { force: true }); return; }
  if (shouldSuppressStatus(text, options)) return;
  const type = options.type || 'info';
  const channel = statusChannelForType(type);
  const keep = !!options.sticky || type === 'error';
  const label = options.label || statusLabelForType(type);
  if (channel === 'alert') stickyAlert = keep;
  clearSlotTimer(channel);
  setStatusSlot(channel, text, { label, order: channel === 'alert' ? 50 : 40, visible: true, type });
  const timeout = options.timeout === undefined ? 1500 : Number(options.timeout);
  if (!keep && timeout > 0) {
    slotTimers.set(channel, window.setTimeout(() => {
      slotTimers.delete(channel);
      if (channel === 'message') setStatusSlot('message', '준비됨', { label: '편집창', order: 40, visible: true, type: 'info' });
      else setStatusSlot(channel, '', { visible: false });
    }, timeout));
  }
}


export function setCodeStatusMessage(message = '준비됨', options = {}) {
  const text = String(message || '').trim() || '준비됨';
  const type = options.type || 'info';
  setStatusSlot('codeMessage', text, {
    label: '코드창',
    order: 45,
    visible: true,
    type,
    tone: options.tone || (type === 'warning' ? 'warning' : undefined),
    detail: options.detail ? String(options.detail) : '',
  });
}

export function setErrorMessage(message) {
  setStatusMessage(message, { type: 'error', sticky: true });
}

export function registerStatusSlot(id, config = {}) {
  slots.set(id, { label: '', value: '', order: 100, visible: true, type: 'info', ...config });
  renderSlots();
}

function sameSlotValue(a = {}, b = {}) {
  const keys = ['label', 'value', 'order', 'visible', 'type', 'tone', 'detail', 'className'];
  return keys.every(key => String(a[key] ?? '') === String(b[key] ?? ''));
}

export function setStatusSlot(id, value, config = {}) {
  const prev = slots.get(id) || { label: '', order: 100, visible: true, type: 'info' };
  const next = { ...prev, ...config, value };
  if (slots.has(id) && sameSlotValue(prev, next)) return;
  slots.set(id, next);
  renderSlots();
}

export function removeStatusSlot(id) {
  clearSlotTimer(id);
  slots.delete(id);
  renderSlots();
}

export function setDocumentStatus({
  fileName = '저장되지 않음',
  hasPath = false,
  dirty = false,
  length = 0,
  text = '',
  lineCount: lineCountHint = null,
  hasZeroWidth: hasZeroWidthHint = null,
  hasTab: hasTabHint = null,
  fastLarge = false,
} = {}) {
  const source = fastLarge ? '' : String(text || '');
  const lineCount = fastLarge
    ? Math.max(1, Number(lineCountHint) || 1)
    : (source.split('\n').length || 1);
  setStatusSlot('length', `${Number(length || 0).toLocaleString('ko-KR')}자 / ${Number(lineCount).toLocaleString('ko-KR')}행`, { label: '문서', order: 20, visible: true, type: 'document' });
  const saved = !!hasPath && !dirty;
  const hasZeroWidth = fastLarge ? hasZeroWidthHint === true : rawCodeContainsZeroWidth2060(source);
  const hasTab = fastLarge ? hasTabHint === true : source.includes('\t');
  if (typeof document !== 'undefined' && document.documentElement) {
    setRootDatasetValue('statusDocumentMode', fastLarge ? 'large-fast' : 'exact');
  }
  renderEditorInfo({ fileName, hasPath, dirty, saved, hasZeroWidth, hasTab });
}
