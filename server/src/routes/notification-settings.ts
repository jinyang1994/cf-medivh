import {
  publicSettings,
  runtimeSettings,
  saveRuntimeSettings,
  type NotificationDefaults,
} from '@/services/runtime-settings';
import type { Middleware } from 'koa';
import type { Store } from '@/repositories/billing-store';
import { notificationLanguage, setNotificationLanguage } from '@/services/notification-settings';
import type { McpConfig } from '@/config';

export function notificationSettingsRoute(
  store: Store,
  defaults: NotificationDefaults = { feishu: undefined, budgetWebhook: undefined },
  mcpConfig?: McpConfig,
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
    ctx.set('Cache-Control', 'no-store');
    if (ctx.method === 'GET') {
      ctx.body = fullSettings
        ? publicSettings(store, defaults, mcpConfig)
        : { language: notificationLanguage(store) };
      return;
    }
    if (ctx.method !== 'PUT') {
      ctx.status = 405;
      ctx.set('Allow', 'GET, PUT');
      return;
    }
    // This shared setting must not be changed by requests from another website.
    const origin = ctx.req.headers.origin;
    let foreignOrigin = false;
    if (origin !== undefined) {
      try {
        const url = new URL(origin);
        foreignOrigin =
          !['http:', 'https:'].includes(url.protocol) ||
          url.origin !== origin ||
          url.host !== ctx.host;
      } catch {
        foreignOrigin = true;
      }
    }
    const site = ctx.get('Sec-Fetch-Site');
    if (foreignOrigin || (site && site !== 'same-origin' && site !== 'none')) {
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
        ctx.body = saveRuntimeSettings(store, defaults, data, mcpConfig);
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (
          ![
            'invalid_settings',
            'invalid_language',
            'invalid_threshold',
            'invalid_feishu',
            'invalid_budget',
            'invalid_mcp',
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
