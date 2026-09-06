const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
}

export function focusableElements(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(el => {
    if (el.matches?.('[data-tab-skip="true"]')) return false;
    return isVisibleElement(el);
  });
}

export function trapTabInside(root, event, { fallbackFocus = null } = {}) {
  if (!root || event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return false;
  const items = focusableElements(root);
  if (!items.length) {
    event.preventDefault();
    (fallbackFocus || root).focus?.({ preventScroll: true });
    return true;
  }
  const current = document.activeElement;
  const index = items.indexOf(current);
  const nextIndex = event.shiftKey
    ? (index <= 0 ? items.length - 1 : index - 1)
    : (index < 0 || index >= items.length - 1 ? 0 : index + 1);
  event.preventDefault();
  items[nextIndex].focus({ preventScroll: true });
  return true;
}
