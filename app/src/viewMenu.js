import { state } from "./state.js";
import { setStatusMessage } from "./statusBar.js";
import { updateLineNumbers } from "./lineNumbers.js";
import { initLargeTextMode, applyLargeTextWrapPolicy, isLargeTextModeActive } from "./largeTextMode.js";

export function initWrapToggles({ editorToggle, codeToggle, editorText, codeText }) {
  initLargeTextMode({ editorElement: editorText, codeElement: codeText, editorToggle, codeToggle });
  const onChange = () => {
    applyLargeTextWrapPolicy({ showStatus: true });
    updateLineNumbers();
    setStatusMessage(isLargeTextModeActive() ? "대용량 모드: 자동 줄바꿈 변경은 임시 보류됨" : "자동 줄바꿈 설정 변경");
  };
  editorToggle.addEventListener("change", onChange);
  codeToggle.addEventListener("change", onChange);
  onChange();
}

export function initToolOptions({ scrollSyncToggle }) {
  state.scrollSyncEnabled = !!scrollSyncToggle.checked;
  scrollSyncToggle.addEventListener("change", () => {
    state.scrollSyncEnabled = !!scrollSyncToggle.checked;
    setStatusMessage(state.scrollSyncEnabled ? "스크롤 동기화 ON" : "스크롤 동기화 OFF");
  });
}
