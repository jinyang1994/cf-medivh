export type Locale = 'en' | 'zh-CN';
export const LANGUAGE_STORAGE_KEY = 'medivh-language';
export function resolveLocale(saved: string | null, browserLanguage: string): Locale {
  if (saved === 'en' || saved === 'zh-CN') return saved;
  return /^zh(?:-|$)/i.test(browserLanguage) ? 'zh-CN' : 'en';
}
