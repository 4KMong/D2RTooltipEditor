let mirror = null;
let marker = null;

function ensureMirror() {
  if (mirror && marker) return { mirror, marker };
  mirror = document.createElement('div');
  marker = document.createElement('span');
  marker.textContent = '\u200b';
  marker.style.display = 'inline-block';
  marker.style.width = '0';
  marker.style.minWidth = '0';
  marker.style.height = '1em';
  marker.style.overflow = 'hidden';
  mirror.setAttribute('aria-hidden', 'true');
  mirror.style.position = 'absolute';
  mirror.style.left = '-100000px';
  mirror.style.top = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.zIndex = '-1';
  mirror.style.overflow = 'hidden';
  document.body.appendChild(mirror);
  return { mirror, marker };
}

function copyTextareaMetrics(textarea, target, wrapDisabled) {
  const cs = getComputedStyle(textarea);
  target.style.boxSizing = 'border-box';
  target.style.width = `${Math.max(1, textarea.clientWidth)}px`;
  target.style.minHeight = '0';
  target.style.height = 'auto';
  target.style.border = '0';
  target.style.margin = '0';
  target.style.paddingTop = cs.paddingTop;
  target.style.paddingRight = cs.paddingRight;
  target.style.paddingBottom = cs.paddingBottom;
  target.style.paddingLeft = cs.paddingLeft;
  target.style.font = cs.font;
  target.style.fontFamily = cs.fontFamily;
  target.style.fontSize = cs.fontSize;
  target.style.fontStyle = cs.fontStyle;
  target.style.fontWeight = cs.fontWeight;
  target.style.lineHeight = cs.lineHeight;
  target.style.letterSpacing = cs.letterSpacing;
  target.style.textTransform = cs.textTransform;
  target.style.tabSize = cs.tabSize;
  target.style.whiteSpace = wrapDisabled ? 'pre' : 'pre-wrap';
  target.style.overflowWrap = wrapDisabled ? 'normal' : (cs.overflowWrap || 'break-word');
  target.style.wordBreak = wrapDisabled ? 'normal' : (cs.wordBreak || 'normal');
}

export function measureTextareaOffsetTop(textarea, offset = 0) {
  if (!textarea || typeof document === 'undefined' || !document.body) return null;
  const value = String(textarea.value || '');
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, value.length));
  const wrapDisabled = textarea.classList.contains('wrap-disabled') || textarea.wrap === 'off';
  const nodes = ensureMirror();
  copyTextareaMetrics(textarea, nodes.mirror, wrapDisabled);
  nodes.mirror.textContent = '';
  nodes.mirror.appendChild(document.createTextNode(value.slice(0, safeOffset)));
  nodes.mirror.appendChild(nodes.marker);
  return nodes.marker.offsetTop;
}
