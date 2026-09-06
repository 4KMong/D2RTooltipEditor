import { showModal } from './modal.js';
import { APP_ABOUT_TITLE } from './version.js';
import { openExternalUrl } from './fileApi.js';
import { isDeveloperModeEnabled, setDeveloperModeEnabled } from './developerMode.js';
import { getLocalizedHelpText, getUiLanguage } from './language.js';


// 버전 정보 창의 배포 링크는 여기서 수정합니다.
const ABOUT_RELEASE = Object.freeze({
  invenUrl: 'https://www.inven.co.kr/board/diablo2/5842/7628',
  invenTitle: '툴팁에디터 v1.0.0 (exe 버전)',
  nexusUrl: 'https://www.nexusmods.com/games/diablo2resurrected/mods/1202',
  nexusTitle: 'D2R TooltipEditor',
  githubUrl: 'https://github.com/4KMong/D2RTooltipEditor',
  githubTitle: 'D2RTooltipEditor',
});

async function openExternalLink(event) {
  event.preventDefault();
  event.stopPropagation();
  const url = event.currentTarget?.href || event.currentTarget?.dataset?.externalUrl || ABOUT_RELEASE.invenUrl;
  try {
    await openExternalUrl(url);
  } catch (_) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}



function attachExternalLinks(root) {
  root.querySelectorAll?.('a[data-external-url], a.external-browser-link').forEach(link => {
    link.addEventListener('click', openExternalLink);
  });
}

export async function showVersionDialog() {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="about-box">
      <div class="about-title">${APP_ABOUT_TITLE}</div>
      <div class="about-author">제작자: JimSSng with ChatGPT (Nexus : 4KMong)</div>
      <div class="about-release-section">
        <div class="about-release-heading">배포 :</div>
        <div class="about-release-list">
          <div>1. 인벤 모드자료실 : <a href="${ABOUT_RELEASE.invenUrl}" id="releaseLink" class="external-browser-link" data-external-url="${ABOUT_RELEASE.invenUrl}">${ABOUT_RELEASE.invenTitle}</a></div>
          <div>2. Nexus Mod : <a href="${ABOUT_RELEASE.nexusUrl}" id="nexusReleaseLink" class="external-browser-link" data-external-url="${ABOUT_RELEASE.nexusUrl}">${ABOUT_RELEASE.nexusTitle}</a></div>
          <div>3. GitHub : <a href="${ABOUT_RELEASE.githubUrl}" id="githubReleaseLink" class="external-browser-link" data-external-url="${ABOUT_RELEASE.githubUrl}">${ABOUT_RELEASE.githubTitle}</a></div>
        </div>
      </div>
      <label class="about-dev-mode-toggle"><input id="developerModeToggle" type="checkbox"> <span>개발자 모드</span></label>
      <div class="about-notice" aria-label="이용 및 배포 안내">
        <p>본 프로그램은 무료 비공식 팬 제작 도구이며, Blizzard Entertainment와 제휴 관계가 없고 Blizzard Entertainment가 승인하거나 후원한 공식 프로그램이 아닙니다. 상업적 이용은 금합니다.</p>
        <p>더 나은 버전을 위해 자유롭게 수정 및 재배포할 수 있습니다. 다만 사용자 혼선을 막기 위해 배포물에 출처, 원저자, 그리고 수정의 기준이 된 원본 버전을 명확히 기재해 주시기 바랍니다.</p>
        <p>원본을 수정하지 않고 공유하는 경우에는 파일을 별도로 재배포하기보다 위의 원 배포 링크를 안내해 주세요.</p>
        <p>치명적인 오류나 의도된 기능이 정상적으로 작동하지 않는 부분의 보완을 제외하면, 추가 기능 또는 개선을 위한 업데이트 계획은 없습니다.</p>
      </div>
    </div>
  `;
  attachExternalLinks(body);
  const devToggle = body.querySelector('#developerModeToggle');
  if (devToggle) {
    devToggle.checked = isDeveloperModeEnabled();
    devToggle.addEventListener('change', () => setDeveloperModeEnabled(devToggle.checked));
  }
  await showModal({ title: '버전 정보', body, buttons: [{ text: '확인', value: 'ok', default: true }] });
}

export const showAboutDialog = showVersionDialog;

const HELP_FALLBACK_TEXT = Object.freeze({
  ko: `# 도움말

- 도움말을 불러오지 못했습니다.
- 프로그램을 다시 실행하거나 Korean.lng 포함 여부를 확인하세요.`,
  en: `# Help

- Help could not be loaded.
- Restart the program or verify that English.lng is included in the build.`,
});

async function loadHelpText() {
  const localized = getLocalizedHelpText();
  if (localized.trim()) return localized;
  return HELP_FALLBACK_TEXT[getUiLanguage()] || HELP_FALLBACK_TEXT.ko;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isKeyboardToken(value) {
  return /^(?:Ctrl|Alt|Shift|Enter|Esc|Tab|Space|PageUp|PageDown|Home|End|Delete|Backspace|[A-Z0-9]|F(?:[1-9]|1[0-2]))$/i.test(String(value || '').trim());
}

function renderHelpInline(value) {
  const codeTokens = [];
  let text = escapeHtml(value);
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `@@HELP_CODE_${codeTokens.length}@@`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/\[([^\]\n]{1,24})\]/g, (match, key) => {
    const trimmed = String(key || '').trim();
    return isKeyboardToken(trimmed) ? `<kbd>${escapeHtml(trimmed)}</kbd>` : match;
  });
  codeTokens.forEach((html, index) => { text = text.replace(`@@HELP_CODE_${index}@@`, html); });
  return text;
}

function stripHelpComments(rawText) {
  const lines = String(rawText || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const kept = [];
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes('-->')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//')) continue;
    kept.push(line);
  }
  return kept;
}

function renderHelpText(rawText) {
  const html = [];
  let sectionOpen = false;
  let listOpen = false;
  let paragraph = [];

  const openSection = () => {
    if (!sectionOpen) {
      html.push('<section class="help-section">');
      sectionOpen = true;
    }
  };
  const closeList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    openSection();
    html.push(`<p>${renderHelpInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeSection = () => {
    flushParagraph();
    closeList();
    if (sectionOpen) {
      html.push('</section>');
      sectionOpen = false;
    }
  };

  for (const line of stripHelpComments(rawText)) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    if (trimmed.startsWith('# ')) {
      closeSection();
      html.push('<section class="help-section">');
      sectionOpen = true;
      html.push(`<h3>${renderHelpInline(trimmed.slice(2).trim())}</h3>`);
      continue;
    }
    if (trimmed.startsWith('- ')) {
      flushParagraph();
      openSection();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${renderHelpInline(trimmed.slice(2).trim())}</li>`);
      continue;
    }
    paragraph.push(trimmed);
  }
  closeSection();
  return html.join('\n') || '<section class="help-section"><h3>도움말</h3><p>도움말 내용이 없습니다.</p></section>';
}

export async function showHelpDialog() {
  const body = document.createElement('div');
  body.className = 'help-dialog-body';
  const renderLocalizedHelp = async () => {
    body.innerHTML = renderHelpText(await loadHelpText());
    attachExternalLinks(body);
  };
  await renderLocalizedHelp();
  const handleLanguageChanged = () => { void renderLocalizedHelp(); };
  document.addEventListener('tooltipeditor:language-changed', handleLanguageChanged);
  try {
    await showModal({ title: '도움말', body, buttons: [{ text: '닫기', value: 'ok', default: true }], windowClass: 'help-modal-window' });
  } finally {
    document.removeEventListener('tooltipeditor:language-changed', handleLanguageChanged);
  }
}
