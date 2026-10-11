import {
  publicSettings,
  runtimeSettings,
  saveRuntimeSettings,
  type NotificationDefaults,
} from '@/services/runtime-settings';
import type { Middleware } from 'koa';
import type { Store } from '@/repositories/billing-store';
import { notificationLanguage, setNotificationLanguage } from '@/services/notification-settings';

export function notificationSettingsRoute(
  store: Store,
  defaults: NotificationDefaults = { feishu: undefined, budgetWebhook: undefined },
): Middleware {
  return async (ctx, next) => {
    if (ctx.path === '/api/settings/appearance') {
      if (ctx.method !== 'GET') {
        ctx.status = 405;
        ctx.set('Allow', 'GET');
        return;
      }
      ctx.body = { hideSocialIcons: runtimeSettings(store, defaults).hideSocialIcons };
      return;
    }
    const fullSettings = ctx.path === '/api/settings';
    if (
      !fullSettings &&
      ctx.path !== '/api/settings/notifications' &&
      ctx.path !== '/api/settings/language'
    )
      return next();
    if (ctx.method === 'GET') {
      ctx.body = fullSettings
        ? publicSettings(store, defaults)
        : { language: notificationLanguage(store) };
      return;
    }
    if (ctx.method !== 'PUT') {
      ctx.status = 405;
      ctx.set('Allow', 'GET, PUT');
      return;
    }
    // This shared setting must not be changed by requests from another website.
    const origin = ctx.get('Origin');
    let foreignOrigin = false;
    if (origin) {
      try {
        foreignOrigin = new URL(origin).host !== ctx.host;
      } catch {
        foreignOrigin = true;
      }
    }
    if (foreignOrigin || ctx.get('Sec-Fetch-Site') === 'cross-site') {
      ctx.status = 403;
      ctx.body = { error: 'Cross-origin request rejected' };
      return;
    }
    if (!ctx.is('application/json')) {
      ctx.status = 415;
      ctx.body = { error: 'Expected application/json' };
      return;
    }
    let body = '';
    for await (const chunk of ctx.req) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > (fullSettings ? 16384 : 1024)) {
        ctx.status = 413;
        ctx.body = { error: 'Request body too large' };
        return;
      }
    }
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      data = null;
    }
    if (fullSettings) {
      try {
        ctx.body = saveRuntimeSettings(store, defaults, data);
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (
          ![
            'invalid_settings',
            'invalid_language',
            'invalid_threshold',
            'invalid_feishu',
            'invalid_budget',
          ].includes(code)
        )
          throw error;
        ctx.status = 400;
        ctx.body = { error: code };
      }
      return;
    }
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).length !== 1 ||
      !('language' in data) ||
      (data.language !== 'en' && data.language !== 'zh-CN')
    ) {
      ctx.status = 400;
      ctx.body = { error: 'Expected language en or zh-CN' };
      return;
    }
    setNotificationLanguage(store, data.language);
    ctx.body = { language: notificationLanguage(store) };
  };
}
