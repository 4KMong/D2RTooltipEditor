let activeProgress = null;

function createProgressElement({ title = '처리 중', message = '잠시만 기다려 주세요.' } = {}) {
  const layer = document.createElement('div');
  layer.className = 'operation-progress-layer';
  layer.setAttribute('role', 'alertdialog');
  layer.setAttribute('aria-modal', 'true');
  layer.tabIndex = -1;

  const win = document.createElement('div');
  win.className = 'operation-progress-window';

  const titleEl = document.createElement('div');
  titleEl.className = 'operation-progress-title';
  titleEl.textContent = title;

  const messageEl = document.createElement('div');
  messageEl.className = 'operation-progress-message';
  messageEl.textContent = message;

  const barOuter = document.createElement('div');
  barOuter.className = 'operation-progress-bar';
  const barInner = document.createElement('div');
  barInner.className = 'operation-progress-bar-inner';
  barOuter.appendChild(barInner);

  const detailEl = document.createElement('div');
  detailEl.className = 'operation-progress-detail';
  detailEl.textContent = '준비 중...';

  win.append(titleEl, messageEl, barOuter, detailEl);
  layer.appendChild(win);
  return { layer, messageEl, barInner, detailEl };
}

export function showProgressOverlay(options = {}) {
  if (typeof document === 'undefined') {
    return { setProgress() {}, close() {} };
  }
  if (activeProgress) activeProgress.close();
  const previousFocus = document.activeElement;
  const parts = createProgressElement(options);
  document.body.appendChild(parts.layer);
  document.body.classList.add('operation-progress-active');
  try { parts.layer.focus({ preventScroll: true }); } catch (_) {}

  let closed = false;
  const controller = {
    setProgress({ done = 0, total = 1, message = '', detail = '' } = {}) {
      if (closed) return;
      const safeTotal = Math.max(1, Number(total) || 1);
      const safeDone = Math.max(0, Math.min(safeTotal, Number(done) || 0));
      const pct = Math.max(0, Math.min(100, Math.round((safeDone / safeTotal) * 100)));
      parts.barInner.style.width = `${pct}%`;
      if (message) parts.messageEl.textContent = message;
      parts.detailEl.textContent = detail || `${safeDone} / ${safeTotal} (${pct}%)`;
    },
    close() {
      if (closed) return;
      closed = true;
      parts.layer.remove();
      document.body.classList.remove('operation-progress-active');
      if (activeProgress === controller) activeProgress = null;
      try { previousFocus?.focus?.({ preventScroll: true }); } catch (_) {}
    },
  };
  activeProgress = controller;
  controller.setProgress({ done: 0, total: 1 });
  return controller;
}
