import { i18n } from '@lingui/core';
import { messages as english } from './locales/en/messages';
import { messages as chinese } from './locales/zh-CN/messages';
import { resolveLocale, LANGUAGE_STORAGE_KEY, type Locale } from './utils/locale';

let saved: string | null = null;
try {
  saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
} catch {
  /* Storage may be blocked. */
}
i18n.load({ en: english, 'zh-CN': chinese });
export function activateLocale(locale: Locale) {
  i18n.activate(locale);
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    /* Switching still works. */
  }
}
activateLocale(resolveLocale(saved, navigator.language));
// The server owns the shared interface and notification language. Local storage
// only supplies a cached value while the initial request is in flight.
let languageRevision = 0;
export async function loadLanguage() {
  const revision = languageRevision;
  const response = await fetch('/api/settings/language', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('language_load_failed');
  const { language } = await response.json();
  if (language !== 'en' && language !== 'zh-CN') throw new Error('invalid_language');
  if (revision === languageRevision) activateLocale(language);
}
export function applySavedLanguage(language: Locale) {
  ++languageRevision;
  activateLocale(language);
}
export { i18n };
