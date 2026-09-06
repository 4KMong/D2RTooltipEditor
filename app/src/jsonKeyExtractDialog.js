import { createFloatingWindow, focusFloatingWindow, closeFloatingWindow, hasFloatingWindow, pokeActiveFloatingWindow } from './floatingWindow.js';
import { showAlertModal, showConfirmModal } from './modal.js';
import { setStatusMessage } from './statusBar.js';
import { state } from './state.js';
import { applyDocumentTextAction } from './syncViews.js';
import { codeTextToDocument, documentToCodeText } from './textCodec.js';
import { getPreferences } from './preferences.js';
import { extractJsonKeyValues, jsonKeyExtractLanguageOptionsHtml, normalizeJsonKeyExtractLanguage } from './jsonKeyExtract.js';

let jsonKeyExtractWindow = null;

function createContent() {
  const prefs = getPreferences();
  const defaultLanguage = normalizeJsonKeyExtractLanguage(prefs.jsonKeyExtractLanguage);
  const root = document.createElement('div');
  root.className = 'json-key-extract-window-body';
  root.innerHTML = `
    <div class="json-key-extract-intro">현재 문서에서 지정한 언어 키의 문자열 값만 추출해 문서 전체를 교체합니다.</div>
    <div class="json-key-extract-form-row">
      <label for="jsonKeyExtractLanguageSelect">추출할 키의 언어를 고르세요</label>
      <select id="jsonKeyExtractLanguageSelect" class="json-key-extract-select">
        ${jsonKeyExtractLanguageOptionsHtml({ selected: defaultLanguage, defaultLanguage })}
      </select>
    </div>
    <div class="floating-footer json-key-extract-footer">
      <button id="jsonKeyExtractApplyBtn" type="button">키 추출</button>
      <button id="jsonKeyExtractCloseBtn" type="button">닫기</button>
    </div>
  `;
  return root;
}

function closeJsonKeyExtractWindow() {
  const win = jsonKeyExtractWindow;
  jsonKeyExtractWindow = null;
  closeFloatingWindow(win);
  setStatusMessage('JSON 키 추출 창 닫힘');
}

function buildExtractedDocumentText(language) {
  const codeSource = documentToCodeText(state.documentText);
  const values = extractJsonKeyValues(codeSource, language);
  if (!values.length) return { values, documentText: '' };
  const extractedDocumentText = values.map(value => codeTextToDocument(`ÿc0${value}`)).join('\n\n');
  return { values, documentText: extractedDocumentText };
}

export function openJsonKeyExtractDialog() {
  if (!jsonKeyExtractWindow && hasFloatingWindow()) { pokeActiveFloatingWindow(); return; }
  if (jsonKeyExtractWindow) { focusFloatingWindow(jsonKeyExtractWindow); return; }

  const content = createContent();
  jsonKeyExtractWindow = createFloatingWindow({
    title: 'JSON 키 추출',
    width: 560,
    height: null,
    content,
    onClose: () => { jsonKeyExtractWindow = null; },
  });
  if (!jsonKeyExtractWindow) return;
  jsonKeyExtractWindow.classList.add('json-key-extract-floating-window');

  const closeBtn = content.querySelector('#jsonKeyExtractCloseBtn');
  const applyBtn = content.querySelector('#jsonKeyExtractApplyBtn');
  const languageSelect = content.querySelector('#jsonKeyExtractLanguageSelect');
  closeBtn?.addEventListener('click', closeJsonKeyExtractWindow);
  applyBtn?.addEventListener('click', async () => {
    const language = normalizeJsonKeyExtractLanguage(languageSelect?.value || getPreferences().jsonKeyExtractLanguage);
    const ok = await showConfirmModal('키를 추출하시겠습니까?', { title: 'JSON 키 추출' });
    if (!ok) {
      await showAlertModal('추출이 취소되었습니다.', { title: 'JSON 키 추출' });
      return;
    }
    try {
      const result = buildExtractedDocumentText(language);
      if (!result.values.length) {
        await showAlertModal(`예기치 못한 오류로 인해 추출이 취소되었습니다.\n\n선택한 언어 키(${language})를 찾지 못했습니다.`, { title: 'JSON 키 추출' });
        setStatusMessage('JSON 키 추출 취소');
        return;
      }
      applyDocumentTextAction(result.documentText, { source: state.activeView, label: 'JSON 키 추출', actionType: 'json-key-extract' });
      await showAlertModal(`정상적으로 추출되었습니다.\n\n추출된 항목: ${result.values.length}개`, { title: 'JSON 키 추출' });
      closeJsonKeyExtractWindow();
    } catch (err) {
      console.warn('json key extract failed', err);
      await showAlertModal('예기치 못한 오류로 인해 추출이 취소되었습니다.', { title: 'JSON 키 추출' });
      setStatusMessage('JSON 키 추출 실패');
    }
  });

  setStatusMessage('JSON 키 추출 창 열림');
}
