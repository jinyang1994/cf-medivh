import type { Store } from '@/repositories/billing-store';

export type NotificationLocale = 'en' | 'zh-CN';
// Keep the existing key so deployed notification preferences become the shared language.
const key = 'feishuNotificationLanguage';
export function notificationLanguage(store: Store): NotificationLocale {
  return store.get(key) === 'en' ? 'en' : 'zh-CN';
}
export function setNotificationLanguage(store: Store, language: NotificationLocale) {
  store.set(key, language);
}
