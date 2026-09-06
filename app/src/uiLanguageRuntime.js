let currentLanguage = 'ko';
let currentTranslator = value => String(value ?? '');

export function setRuntimeUiLanguage(language = 'ko', translator = null) {
  currentLanguage = language === 'en' ? 'en' : 'ko';
  currentTranslator = typeof translator === 'function'
    ? translator
    : (value => String(value ?? ''));
}

export function getRuntimeUiLanguage() {
  return currentLanguage;
}

export function translateRuntimeUiText(value) {
  return currentTranslator(String(value ?? ''));
}
