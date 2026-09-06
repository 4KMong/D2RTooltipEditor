import { playDong } from './sound.js';

let overlay = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'native-dialog-guard';
  overlay.hidden = true;
  overlay.innerHTML = '<div class="native-dialog-guard-message">탐색기 창을 먼저 닫아주세요.</div>';
  overlay.addEventListener('mousedown', (event) => { event.preventDefault(); playDong(); });
  overlay.addEventListener('contextmenu', (event) => event.preventDefault());
  document.body.appendChild(overlay);
  return overlay;
}

export async function withNativeDialogGuard(task) {
  const guard = ensureOverlay();
  guard.hidden = false;
  try { return await task(); }
  finally { guard.hidden = true; }
}
