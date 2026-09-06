export function sanitizeDigits(value, maxLength = null) {
  let out = String(value ?? '').replace(/\D+/g, '');
  if (maxLength != null) out = out.slice(0, Math.max(0, Number(maxLength) || 0));
  return out;
}

export function sanitizeHex4(value) {
  let v = String(value ?? '').trim();
  v = v.replace(/^\\?u/i, '').replace(/^u\+/i, '');
  v = v.replace(/[^0-9a-fA-F]+/g, '').toUpperCase().slice(0, 4);
  return v;
}

function hintText(input) { return input?.dataset?.inputHint || ''; }

function setDefaultHint(input, text) {
  if (input && !input.dataset.inputHint) input.dataset.inputHint = text;
}

function hintAnchor(input) {
  return input.closest?.('.input-with-unit, .input-unit-row, .fr-combo, .goto-line-combo') || input;
}

function hintPlacement(input) {
  const anchor = hintAnchor(input);
  if (anchor !== input && anchor.classList?.contains('input-with-unit')) return 'inside-unit';
  return 'after-anchor';
}

function getExistingHint(input) {
  const anchor = hintAnchor(input);
  if (!anchor) return null;
  if (hintPlacement(input) === 'inside-unit') return anchor.querySelector(':scope > .input-inline-hint');
  const hint = anchor.nextElementSibling;
  return hint?.classList?.contains('input-inline-hint') ? hint : null;
}

function ensureInlineHint(input) {
  const text = hintText(input);
  if (!text) return null;
  const anchor = hintAnchor(input);
  let hint = getExistingHint(input);
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'input-inline-hint';
    if (hintPlacement(input) === 'inside-unit') anchor.appendChild(hint);
    else anchor.insertAdjacentElement('afterend', hint);
  }
  hint.textContent = `⚠ ${text}`;
  hint.setAttribute('aria-live', 'polite');
  return hint;
}

export function showInputHint(input) {
  const hint = ensureInlineHint(input);
  if (hint) hint.classList.add('visible');
}

export function hideInputHint(input) {
  const hint = getExistingHint(input);
  if (hint) hint.classList.remove('visible');
}

function isEditNavigationKey(event) {
  return event.ctrlKey || event.metaKey || event.altKey
    || ['Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Tab','Enter','Escape'].includes(event.key);
}

function showHintForInvalidAttempt(input) { showInputHint(input); }
function hideHintForValidAttempt(input) { hideInputHint(input); }

export function attachFilteredInputHint(input, { validKeyPattern = null, validInputPattern = null, sanitize = null } = {}) {
  if (!input) return;
  ensureInlineHint(input);
  input.addEventListener('keydown', (event) => {
    if (isEditNavigationKey(event)) return;
    if (!event.key || event.key.length !== 1) return;
    if (validKeyPattern && !validKeyPattern.test(event.key)) {
      event.preventDefault();
      showHintForInvalidAttempt(input);
      return;
    }
    hideHintForValidAttempt(input);
  });
  input.addEventListener('beforeinput', (event) => {
    if (!event.data) return;
    if (event.inputType && event.inputType.startsWith('insertFrom')) return;
    if (validInputPattern && !validInputPattern.test(event.data)) {
      event.preventDefault();
      showHintForInvalidAttempt(input);
      return;
    }
    hideHintForValidAttempt(input);
  });
  input.addEventListener('input', () => {
    if (typeof sanitize === 'function') {
      const before = input.value;
      sanitize();
      if (before !== input.value) showHintForInvalidAttempt(input);
      else hideHintForValidAttempt(input);
      return;
    }
    hideHintForValidAttempt(input);
  });
  input.addEventListener('blur', () => hideInputHint(input));
}

export function attachDigitInput(input, { maxLength = null, allowEmpty = true, hint = '숫자만 입력할 수 있습니다.' } = {}) {
  if (!input) return;
  input.removeAttribute('title');
  input.setAttribute('autocomplete', 'off');
  input.type = 'text';
  setDefaultHint(input, hint);
  input.inputMode = 'numeric';
  if (maxLength != null) input.maxLength = Number(maxLength);
  ensureInlineHint(input);
  const clean = () => {
    const before = input.value;
    const start = input.selectionStart ?? before.length;
    const beforeLeft = before.slice(0, start);
    const after = sanitizeDigits(before, maxLength);
    if (before !== after) {
      const leftClean = sanitizeDigits(beforeLeft, maxLength);
      input.value = after;
      const pos = Math.min(leftClean.length, after.length);
      try { input.setSelectionRange(pos, pos); } catch (_) {}
    }
    if (!allowEmpty && input.value === '') input.value = '0';
  };
  attachFilteredInputHint(input, { validKeyPattern: /^\d$/, validInputPattern: /^\d+$/, sanitize: clean });
  input.addEventListener('paste', () => setTimeout(() => { const before = input.value; clean(); if (before !== input.value) showInputHint(input); }, 0));
  input.addEventListener('drop', () => setTimeout(() => { const before = input.value; clean(); if (before !== input.value) showInputHint(input); }, 0));
  clean();
}

export function attachHex4Input(input) {
  if (!input) return;
  input.removeAttribute('title');
  input.setAttribute('autocomplete', 'off');
  input.type = 'text';
  input.inputMode = 'text';
  input.maxLength = 4;
  setDefaultHint(input, '4자리 16진수(0-9, A-F)만 입력할 수 있습니다.');
  ensureInlineHint(input);
  const clean = () => {
    const before = input.value;
    const after = sanitizeHex4(before);
    if (before !== after) input.value = after;
  };
  attachFilteredInputHint(input, { validKeyPattern: /^[0-9a-fA-F]$/, validInputPattern: /^[0-9a-fA-F]+$/, sanitize: clean });
  input.addEventListener('paste', () => setTimeout(() => { const before = input.value; clean(); if (before !== input.value) showInputHint(input); }, 0));
  input.addEventListener('drop', () => setTimeout(() => { const before = input.value; clean(); if (before !== input.value) showInputHint(input); }, 0));
  input.addEventListener('blur', clean);
  clean();
}

export function readPositiveInteger(input, fallback = 1) {
  const n = Number.parseInt(sanitizeDigits(input?.value), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
