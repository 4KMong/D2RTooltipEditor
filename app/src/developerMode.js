import { APP_VERSION_LABEL } from './version.js';
import { setStatusMessage } from './statusBar.js';

let developerModeEnabled = false;
let versionBadgeElement = null;

export function isDeveloperModeEnabled() {
  return developerModeEnabled === true;
}

function applyDeveloperModeStateToDocument() {
  document.documentElement.dataset.developerMode = developerModeEnabled ? 'true' : 'false';
  document.body?.classList.toggle('developer-mode-active', developerModeEnabled);
}

function updateVersionBadgeLabel() {
  if (!versionBadgeElement) return;
  versionBadgeElement.textContent = developerModeEnabled ? `${APP_VERSION_LABEL} [개발자모드]` : APP_VERSION_LABEL;
  versionBadgeElement.classList.toggle('developer-mode-badge', developerModeEnabled);
  versionBadgeElement.setAttribute('aria-label', developerModeEnabled ? '버전 정보, 개발자모드 켜짐' : '버전 정보');
  versionBadgeElement.title = developerModeEnabled ? '버전 정보 (개발자모드 켜짐)' : '버전 정보';
}

export function updateDeveloperModeIndicator() {
  applyDeveloperModeStateToDocument();
  updateVersionBadgeLabel();
}

export function setDeveloperModeEnabled(enabled, { showStatus = true } = {}) {
  const next = enabled === true;
  if (developerModeEnabled === next) {
    updateDeveloperModeIndicator();
    return developerModeEnabled;
  }
  developerModeEnabled = next;
  updateDeveloperModeIndicator();
  window.dispatchEvent(new CustomEvent('ttedit-developer-mode-changed', { detail: { enabled: developerModeEnabled } }));
  if (showStatus) setStatusMessage(developerModeEnabled ? '개발자모드 켜짐' : '개발자모드 꺼짐');
  return developerModeEnabled;
}

export function initDeveloperMode({ versionBadge } = {}) {
  versionBadgeElement = versionBadge || document.getElementById('versionBadge');
  developerModeEnabled = false;
  updateDeveloperModeIndicator();
}
