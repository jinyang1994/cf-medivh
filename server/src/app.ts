import type { NotificationDefaults } from '@/services/runtime-settings';
import { notificationSettingsRoute } from '@/routes/notification-settings';
import Koa from 'koa';
import serve from 'koa-static';
import { errorHandler } from '@/middleware/error-handler';
import { responseHeaders } from '@/middleware/response-headers';
import { spaFallback } from '@/middleware/spa-fallback';
import { apiRoutes } from '@/routes';
import type { Store } from '@/repositories/billing-store';
import type { Collector } from '@/services/collector';
import type { McpConfig } from '@/config';
import { mcpRoute } from '@/routes/mcp';
import { mcpSettingsRoute } from '@/routes/mcp-settings';

export function createApp(
  store: Store,
  collector: Collector,
  webRoot?: string,
  settingsDefaults?: NotificationDefaults,
  mcpConfig?: McpConfig,
) {
  const app = new Koa();
  app.use(errorHandler);
  app.use(responseHeaders);
  app.use(mcpRoute(store, collector, mcpConfig));
  app.use(mcpSettingsRoute(store, mcpConfig));
  app.use(notificationSettingsRoute(store, settingsDefaults, mcpConfig));
  app.use(apiRoutes(store, collector));
  if (webRoot) {
    app.use(serve(webRoot));
    app.use(spaFallback(webRoot));
  }
  return app;
}
