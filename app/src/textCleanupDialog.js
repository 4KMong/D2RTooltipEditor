import { createFloatingWindow, focusFloatingWindow, closeFloatingWindow, hasFloatingWindow, pokeActiveFloatingWindow } from './floatingWindow.js';
import { showAlertModal, showConfirmModal } from './modal.js';
import { setStatusMessage } from './statusBar.js';

let cleanupWindow = null;
const SYSTEM_DEFAULT_OPTIONS = Object.freeze({
  trimLineStart: true,
  trimLineEnd: true,
  removeSpaces: false,
  collapseSpaces: false,
  removeEol: false,
  removeDuplicateEol: false,
  removeZeroWidth: false,
  cleanupUnsafe: true,
  removeTabs: false,
  replaceTabs: false,
  tabReplacement: '',
});
let rememberedOptions = { ...SYSTEM_DEFAULT_OPTIONS };
let unsafeTooltipEl = null;
const UNSAFE_TOOLTIP_TEXT = '웹페이지나 외부 문서에서 붙여넣을 때 섞일 수 있는 보이지 않는 제어문자, 방향 제어 문자, BOM, soft hyphen, 일부 0폭 문자, 줄/문단 separator, 특수 공백을 정리합니다. 의도된 \\n, \\uXXXX 리터럴, ÿc 색상코드, 일반 특수문자는 보존합니다. 일부 특수 케이스는 남아 있을 수 있습니다.';

function hideUnsafeTooltip() {
  if (unsafeTooltipEl) {
    unsafeTooltipEl.remove();
    unsafeTooltipEl = null;
  }
}

function showUnsafeTooltip(anchor) {
  hideUnsafeTooltip();
  unsafeTooltipEl = document.createElement('div');
  unsafeTooltipEl.className = 'input-hint-tooltip';
  unsafeTooltipEl.textContent = UNSAFE_TOOLTIP_TEXT;
  document.body.appendChild(unsafeTooltipEl);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - unsafeTooltipEl.offsetWidth - 8);
  if (top + unsafeTooltipEl.offsetHeight > window.innerHeight - 8) { hideUnsafeTooltip(); return; }
  unsafeTooltipEl.style.left = `${left}px`;
  unsafeTooltipEl.style.top = `${top}px`;
}

function checked(value) { return value ? 'checked' : ''; }
function escapeHtml(text) { return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

function createContent() {
  const opts = rememberedOptions || SYSTEM_DEFAULT_OPTIONS;
  const root = document.createElement('div');
  root.className = 'text-cleanup-window-body';
  root.innerHTML = `
    <div class="text-cleanup-intro">체크한 항목만 현재 문서에 적용합니다. 설정값은 프로그램 종료 시까지만 마지막 작업값을 기억하고, 재시작하면 시스템 초기값으로 돌아갑니다.</div>
    <fieldset class="text-cleanup-group">
      <legend>공백</legend>
      <label><input type="checkbox" data-cleanup-option="trimLineStart" ${checked(opts.trimLineStart)}> 행 시작</label>
      <label><input type="checkbox" data-cleanup-option="trimLineEnd" ${checked(opts.trimLineEnd)}> 행 꼬리</label>
      <label><input type="checkbox" data-cleanup-option="removeSpaces" ${checked(opts.removeSpaces)}> 모든 공백</label>
      <label><input type="checkbox" data-cleanup-option="collapseSpaces" ${checked(opts.collapseSpaces)}> 다중 공백 → 단일 공백</label>
    </fieldset>
    <fieldset class="text-cleanup-group text-cleanup-group-etc">
      <legend>기타 문자</legend>
      <label><input type="checkbox" data-cleanup-option="removeEol" ${checked(opts.removeEol)}> 줄바꿈(EOL)</label>
      <label><input type="checkbox" data-cleanup-option="removeDuplicateEol" ${checked(opts.removeDuplicateEol)}> 중복 줄바꿈</label>
      <label><input type="checkbox" data-cleanup-option="cleanupUnsafe" ${checked(opts.cleanupUnsafe)}> <span class="text-cleanup-help-link" tabindex="0">불필요한 문자열</span></label>
      <label><input type="checkbox" data-cleanup-option="removeTabs" ${checked(opts.removeTabs)}> 탭 문자</label>
      <div class="text-cleanup-tab-replace-row">
        <label class="text-cleanup-tab-replace-label" title="탭 문자를 아래 문자열로 교체합니다.">
          <input type="checkbox" data-cleanup-option="replaceTabs" ${checked(opts.replaceTabs)}>
          <span>탭 문자 교체</span>
        </label>
        <input id="textCleanupTabReplacement" type="text" value="${escapeHtml(opts.tabReplacement)}" placeholder="탭 대신 넣을 문자열" autocomplete="off" spellcheck="false">
        <div class="text-cleanup-warning" hidden>⚠ 탭 문자 교체에 체크하고 문자열을 비워두면 탭 문자가 삭제됩니다.</div>
      </div>
      <label><input type="checkbox" data-cleanup-option="removeZeroWidth" ${checked(opts.removeZeroWidth)}> 0 너비 문자(U+2060)</label>
    </fieldset>
    <div class="floating-footer">
      <button id="textCleanupApplyBtn" type="button">정리</button>
      <button id="textCleanupCloseBtn" type="button">닫기</button>
    </div>
  `;
  return root;
}

function readOptions(content) {
  const get = (name) => !!content.querySelector(`[data-cleanup-option="${name}"]`)?.checked;
  return {
    trimLineStart: get('trimLineStart'),
    trimLineEnd: get('trimLineEnd'),
    removeSpaces: get('removeSpaces'),
    collapseSpaces: get('collapseSpaces'),
    removeEol: get('removeEol'),
    removeDuplicateEol: get('removeDuplicateEol'),
    removeZeroWidth: get('removeZeroWidth'),
    cleanupUnsafe: get('cleanupUnsafe'),
    removeTabs: get('removeTabs'),
    replaceTabs: get('replaceTabs'),
    tabReplacement: content.querySelector('#textCleanupTabReplacement')?.value ?? '',
  };
}

function hasSelectedOption(opts) {
  return !!(opts.trimLineStart || opts.trimLineEnd || opts.removeSpaces || opts.collapseSpaces || opts.removeEol || opts.removeDuplicateEol || opts.removeZeroWidth || opts.cleanupUnsafe || opts.removeTabs || opts.replaceTabs);
}

export function openTextCleanupDialog() {
  if (!cleanupWindow && hasFloatingWindow()) { pokeActiveFloatingWindow(); return; }
  if (cleanupWindow) { focusFloatingWindow(cleanupWindow); return; }
  const content = createContent();
  cleanupWindow = createFloatingWindow({
    title: '텍스트 정리',
    width: 560,
    height: null,
    content,
    onClose: () => { hideUnsafeTooltip(); cleanupWindow = null; },
  });
  if (!cleanupWindow) return;
  cleanupWindow.classList.add('text-cleanup-floating-window');

  const close = () => {
    const win = cleanupWindow;
    cleanupWindow = null;
    closeFloatingWindow(win);
    hideUnsafeTooltip();
    setStatusMessage('텍스트 정리 창 닫힘');
  };

  content.querySelector('#textCleanupCloseBtn')?.addEventListener('click', close);
  const unsafeHelp = content.querySelector('.text-cleanup-help-link');
  unsafeHelp?.addEventListener('mouseenter', () => showUnsafeTooltip(unsafeHelp));
  unsafeHelp?.addEventListener('mouseleave', hideUnsafeTooltip);
  unsafeHelp?.addEventListener('focus', () => showUnsafeTooltip(unsafeHelp));
  unsafeHelp?.addEventListener('blur', hideUnsafeTooltip);
  content.querySelector('#textCleanupApplyBtn')?.addEventListener('click', async () => {
    const opts = readOptions(content);
    if (!hasSelectedOption(opts)) {
      await showAlertModal('정리할 항목을 하나 이상 선택하세요.', { title: '텍스트 정리' });
      return;
    }
    const ok = await showConfirmModal('체크한 항목에 따라 설정된 문자열들을 제거하거나 변환하시겠습니까?', { title: '텍스트 정리' });
    if (!ok) {
      await showAlertModal('텍스트 정리가 취소되었습니다.', { title: '텍스트 정리' });
      return;
    }
    const mod = await import('./editMenu.js');
    const result = mod.applyTextCleanupOptions(opts, { label: '텍스트 정리' });
    rememberedOptions = { ...opts };
    if (!result.changed) {
      await showAlertModal(`반영된 변경 사항이 없습니다.\n\n${mod.textCleanupSummary(result.stats)}`, { title: '텍스트 정리 결과' });
      return;
    }
    await showAlertModal(`텍스트 정리가 반영되었습니다.\n\n${mod.textCleanupSummary(result.stats)}`, { title: '텍스트 정리 결과' });
    close();
  });

  const removeSpaces = content.querySelector('[data-cleanup-option="removeSpaces"]');
  const collapseSpaces = content.querySelector('[data-cleanup-option="collapseSpaces"]');
  const removeTabs = content.querySelector('[data-cleanup-option="removeTabs"]');
  const replaceTabs = content.querySelector('[data-cleanup-option="replaceTabs"]');
  const tabReplacementInput = content.querySelector('#textCleanupTabReplacement');
  const tabReplaceWarning = content.querySelector('.text-cleanup-warning');
  const updateTabReplaceWarning = () => {
    if (!tabReplaceWarning) return;
    const shouldShow = !!(replaceTabs?.checked && String(tabReplacementInput?.value ?? '') === '');
    tabReplaceWarning.hidden = !shouldShow;
  };
  removeSpaces?.addEventListener('change', () => { if (removeSpaces.checked && collapseSpaces) collapseSpaces.checked = false; });
  collapseSpaces?.addEventListener('change', () => { if (collapseSpaces.checked && removeSpaces) removeSpaces.checked = false; });
  removeTabs?.addEventListener('change', () => {
    if (removeTabs.checked && replaceTabs) replaceTabs.checked = false;
    updateTabReplaceWarning();
  });
  replaceTabs?.addEventListener('change', () => {
    if (replaceTabs.checked && removeTabs) removeTabs.checked = false;
    updateTabReplaceWarning();
  });
  tabReplacementInput?.addEventListener('input', updateTabReplaceWarning);
  updateTabReplaceWarning();

  setStatusMessage('텍스트 정리 창 열림');
}
