import { setStatusMessage } from "./statusBar.js";
import { getPreferences, setPreferences } from "./preferences.js";
import { updateLineNumbers } from "./lineNumbers.js";

const LAYOUT_MODES = new Set(["split", "right-editor", "bottom-code", "vertical", "editor-only", "code-only"]);
const DEFAULT_LAYOUT_MODE = "right-editor";
const MIN_SIDE_CODE_PERCENT = 15;
const MAX_SIDE_CODE_PERCENT = 80;
const DEFAULT_SIDE_CODE_PERCENT = 30;
const MIN_VERTICAL_CODE_PERCENT = 10;
const MAX_VERTICAL_CODE_PERCENT = 75;
const DEFAULT_VERTICAL_CODE_PERCENT = 20;
const MIN_BOTTOM_CODE_PERCENT = 10;
const MAX_BOTTOM_CODE_PERCENT = 75;
const DEFAULT_BOTTOM_CODE_PERCENT = 20;
const DRAG_THRESHOLD_PX = 2;
const SIDE_CODE_MIN_PX = 140;
const SIDE_EDITOR_MIN_PX = 220;
const SPLITTER_SIZE_PX = 7;

let currentMode = DEFAULT_LAYOUT_MODE;
let layoutEl = null;
let splitterEl = null;
let modeSelectEl = null;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function readPercent(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}
function setCssPercent(name, value, min, max) {
  document.documentElement.style.setProperty(name, `${clamp(value, min, max).toFixed(1)}%`);
}
function dynamicSideCodePercentBounds() {
  if (!layoutEl || typeof layoutEl.getBoundingClientRect !== 'function') return { min: MIN_SIDE_CODE_PERCENT, max: MAX_SIDE_CODE_PERCENT };
  const width = Math.max(1, layoutEl.getBoundingClientRect().width);
  const minByPx = ((SIDE_CODE_MIN_PX + SPLITTER_SIZE_PX) / width) * 100;
  const maxByPeerPx = 100 - (((SIDE_EDITOR_MIN_PX + SPLITTER_SIZE_PX) / width) * 100);
  return {
    min: clamp(Math.max(MIN_SIDE_CODE_PERCENT, minByPx), MIN_SIDE_CODE_PERCENT, MAX_SIDE_CODE_PERCENT),
    max: clamp(Math.min(MAX_SIDE_CODE_PERCENT, maxByPeerPx), MIN_SIDE_CODE_PERCENT, MAX_SIDE_CODE_PERCENT),
  };
}
function clampSideCodePercent(percent) {
  const bounds = dynamicSideCodePercentBounds();
  return clamp(percent, bounds.min, Math.max(bounds.min, bounds.max));
}
function normalizeMode(mode) { return LAYOUT_MODES.has(mode) ? mode : DEFAULT_LAYOUT_MODE; }
function isHorizontalMode(mode = currentMode) { return mode === "split" || mode === "right-editor"; }
function isSinglePaneMode(mode = currentMode) { return mode === "editor-only" || mode === "code-only"; }

function modeLabel(mode) {
  switch (mode) {
    case "right-editor": return "좌측 편집창";
    case "split": return "우측 편집창";
    case "bottom-code": return "상단 편집창";
    case "vertical": return "하단 편집창";
    case "editor-only": return "편집창만";
    case "code-only": return "코드창만";
    default: return "좌측 편집창";
  }
}

function modeViewLabel(mode) {
  switch (mode) {
    case "editor-only": return "편집창만 보기";
    case "code-only": return "코드창만 보기";
    default: return `${modeLabel(mode)}으로 보기`;
  }
}

function refreshPaneTitles() {
  const codeTitle = document.querySelector('.code-pane .pane-title > span');
  const editorTitle = document.querySelector('.editor-pane .editor-title-main');
  if (codeTitle && codeTitle.textContent !== '코드창') codeTitle.textContent = '코드창';
  if (editorTitle && editorTitle.textContent !== '편집창') editorTitle.textContent = '편집창';
}

function refreshLayoutMenuCommands() {
  const defaultMode = defaultLayoutMode();
  document.querySelectorAll('.layout-menu-command[data-layout-mode]').forEach((button) => {
    const mode = normalizeMode(button.dataset.layoutMode);
    const label = modeViewLabel(mode) + (mode === defaultMode ? ' (현재 기본값)' : '');
    let textSpan = button.querySelector(':scope > span');
    if (!textSpan) {
      textSpan = document.createElement('span');
      button.textContent = '';
      button.appendChild(textSpan);
    }
    textSpan.textContent = label;
    let mark = button.querySelector('kbd.layout-check-mark');
    if (!mark) {
      mark = document.createElement('kbd');
      mark.className = 'layout-check-mark';
      button.appendChild(mark);
    }
    mark.textContent = '';
    mark.setAttribute('aria-hidden', 'true');
    button.classList.toggle('current-layout-mode', mode === currentMode);
  });
  refreshPaneTitles();
}

function setSideCodePercent(percent, persist = false) {
  const value = clampSideCodePercent(percent);
  setCssPercent("--left-pane-width", value, MIN_SIDE_CODE_PERCENT, MAX_SIDE_CODE_PERCENT);
  document.documentElement.dataset.layoutSideCodePercent = value.toFixed(1);
  if (persist) setPreferences({ leftPanePercent: value });
}
function setVerticalCodePercent(percent, persist = false) {
  const value = clamp(percent, MIN_VERTICAL_CODE_PERCENT, MAX_VERTICAL_CODE_PERCENT);
  setCssPercent("--vertical-code-height", value, MIN_VERTICAL_CODE_PERCENT, MAX_VERTICAL_CODE_PERCENT);
  if (persist) setPreferences({ verticalCodePercent: value });
}
function setBottomCodePercent(percent, persist = false) {
  const value = clamp(percent, MIN_BOTTOM_CODE_PERCENT, MAX_BOTTOM_CODE_PERCENT);
  setCssPercent("--bottom-code-height", value, MIN_BOTTOM_CODE_PERCENT, MAX_BOTTOM_CODE_PERCENT);
  if (persist) setPreferences({ bottomCodePercent: value });
}

export function getLayoutMode() { return currentMode; }
export function getLayoutModeLabels() {
  return [
    ["right-editor", modeLabel("right-editor")],
    ["split", modeLabel("split")],
    ["bottom-code", modeLabel("bottom-code")],
    ["vertical", modeLabel("vertical")],
    ["editor-only", modeLabel("editor-only")],
    ["code-only", modeLabel("code-only")],
  ];
}

function defaultLayoutMode() { return normalizeMode(getPreferences().defaultLayoutMode || DEFAULT_LAYOUT_MODE); }

function refreshModeSelectOptions() {
  const defaultMode = defaultLayoutMode();
  if (modeSelectEl) {
    const selected = normalizeMode(modeSelectEl.value || currentMode);
    modeSelectEl.innerHTML = getLayoutModeLabels().map(([value, label]) => {
      const mark = value === defaultMode ? ' (기본값)' : '';
      return `<option value="${value}">${label}${mark}</option>`;
    }).join('');
    modeSelectEl.value = selected;
  }
  refreshLayoutMenuCommands();
}

export function refreshLayoutModeUi() { refreshModeSelectOptions(); }

export function applyDefaultLayoutMode() {
  const mode = defaultLayoutMode();
  applyLayoutMode(mode, { persist: false, announce: true });
  setStatusMessage(`기본값 레이아웃으로 전환: ${modeLabel(mode)}`);
}

function mirrorLayoutModeClasses(target) {
  if (!target) return;
  target.classList.toggle("layout-right-editor", currentMode === "right-editor");
  target.classList.toggle("layout-vertical", currentMode === "vertical");
  target.classList.toggle("layout-bottom-code", currentMode === "bottom-code");
  target.classList.toggle("layout-editor-only", currentMode === "editor-only");
  target.classList.toggle("layout-code-only", currentMode === "code-only");
  target.dataset.layoutMode = currentMode;
}

export function applyLayoutMode(mode, { persist = false, announce = true } = {}) {
  currentMode = normalizeMode(mode);
  if (!layoutEl) return;
  mirrorLayoutModeClasses(layoutEl);
  mirrorLayoutModeClasses(document.getElementById('statusBar'));
  refreshPaneTitles();

  if (splitterEl) {
    splitterEl.setAttribute("aria-orientation", isHorizontalMode(currentMode) ? "vertical" : "horizontal");
    splitterEl.title = isSinglePaneMode(currentMode) ? "현재 레이아웃에서는 분할선이 비활성화됩니다." : "드래그해서 코드창/편집창 비율 조절";
  }
  refreshModeSelectOptions();
  if (modeSelectEl && modeSelectEl.value !== currentMode) modeSelectEl.value = currentMode;
  if (persist) setPreferences({ defaultLayoutMode: currentMode });
  requestAnimationFrame(updateLineNumbers);
  if (announce) setStatusMessage(`레이아웃: ${modeLabel(currentMode)}`);
}

function loadLayoutPrefs() {
  const prefs = getPreferences();
  setSideCodePercent(Number(prefs.leftPanePercent ?? DEFAULT_SIDE_CODE_PERCENT), false);
  setVerticalCodePercent(Number(prefs.verticalCodePercent ?? DEFAULT_VERTICAL_CODE_PERCENT), false);
  setBottomCodePercent(Number(prefs.bottomCodePercent ?? DEFAULT_BOTTOM_CODE_PERCENT), false);
  return normalizeMode(prefs.defaultLayoutMode || prefs.layoutMode || DEFAULT_LAYOUT_MODE);
}

export function initLayout({ layoutElement, splitterElement, modeSelect = null }) {
  layoutEl = layoutElement;
  splitterEl = splitterElement;
  modeSelectEl = modeSelect;

  let pointerDown = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startPercent = DEFAULT_SIDE_CODE_PERCENT;
  let layoutSize = 1;
  let dragMode = DEFAULT_LAYOUT_MODE;

  function currentPercentForMode(mode = currentMode) {
    if (mode === "vertical") return readPercent("--vertical-code-height", DEFAULT_VERTICAL_CODE_PERCENT);
    if (mode === "bottom-code") return readPercent("--bottom-code-height", DEFAULT_BOTTOM_CODE_PERCENT);
    return readPercent("--left-pane-width", DEFAULT_SIDE_CODE_PERCENT);
  }

  function setPercentForMode(mode, percent, persist = false) {
    if (mode === "vertical") setVerticalCodePercent(percent, persist);
    else if (mode === "bottom-code") setBottomCodePercent(percent, persist);
    else setSideCodePercent(percent, persist);
  }

  function resetCurrentModeRatio() {
    if (currentMode === "vertical") {
      setVerticalCodePercent(DEFAULT_VERTICAL_CODE_PERCENT, true);
      setStatusMessage("하단/상단 창 비율 기본값으로 초기화");
    } else if (currentMode === "bottom-code") {
      setBottomCodePercent(DEFAULT_BOTTOM_CODE_PERCENT, true);
      setStatusMessage("상단/하단 창 비율 기본값으로 초기화");
    } else if (currentMode === "split" || currentMode === "right-editor") {
      setSideCodePercent(DEFAULT_SIDE_CODE_PERCENT, true);
      setStatusMessage("좌우 창 비율 기본값으로 초기화");
    }
    requestAnimationFrame(updateLineNumbers);
  }

  splitterElement.tabIndex = -1;
  applyLayoutMode(loadLayoutPrefs(), { persist: false, announce: false });

  refreshModeSelectOptions();
  modeSelect?.addEventListener("change", () => applyLayoutMode(modeSelect.value, { persist: false, announce: true }));
  document.getElementById("layoutDefaultButton")?.addEventListener("click", () => applyDefaultLayoutMode());
  document.addEventListener("tooltipeditor:preferences-changed", () => refreshModeSelectOptions());
  window.addEventListener("resize", () => {
    if (!isHorizontalMode()) return;
    setSideCodePercent(currentPercentForMode(currentMode), false);
    requestAnimationFrame(updateLineNumbers);
  });

  splitterElement.addEventListener("dblclick", () => {
    if (isSinglePaneMode()) return;
    resetCurrentModeRatio();
  });

  splitterElement.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || isSinglePaneMode()) return;
    pointerDown = true;
    dragging = false;
    dragMode = currentMode;
    startX = event.clientX;
    startY = event.clientY;
    startPercent = currentPercentForMode(dragMode);
    const rect = layoutElement.getBoundingClientRect();
    if (isHorizontalMode(dragMode)) {
      layoutSize = Math.max(1, rect.width);
    } else {
      const tabsRect = layoutElement.querySelector('.document-tabs')?.getBoundingClientRect();
      layoutSize = Math.max(1, rect.height - (tabsRect?.height || 0));
    }
    splitterElement.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  splitterElement.addEventListener("pointermove", (event) => {
    if (!pointerDown) return;
    const delta = isHorizontalMode(dragMode) ? event.clientX - startX : event.clientY - startY;
    if (!dragging) {
      if (Math.abs(delta) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      document.body.classList.add(isHorizontalMode(dragMode) ? "dragging-splitter" : "dragging-splitter-y");
      setStatusMessage("창 비율 조절 중", { timeout: 0 });
    }
    let next = startPercent;
    if (dragMode === "bottom-code" || dragMode === "right-editor") next = startPercent - (delta / layoutSize) * 100;
    else next = startPercent + (delta / layoutSize) * 100;
    setPercentForMode(dragMode, next, false);
    requestAnimationFrame(updateLineNumbers);
  });

  function finish(event, cancelled = false) {
    if (!pointerDown) return;
    const moved = dragging;
    pointerDown = false;
    dragging = false;
    document.body.classList.remove("dragging-splitter", "dragging-splitter-y");
    try { splitterElement.releasePointerCapture(event.pointerId); } catch (_) {}
    if (moved && !cancelled) setPercentForMode(dragMode, currentPercentForMode(dragMode), true);
    if (moved) setStatusMessage(cancelled ? "창 비율 조절 취소" : "창 비율 조절 완료");
  }

  splitterElement.addEventListener("pointerup", (event) => finish(event, false));
  splitterElement.addEventListener("pointercancel", (event) => finish(event, true));
}
