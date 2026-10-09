import Koa from 'koa';
import serve from 'koa-static';
import { errorHandler } from '@/middleware/error-handler';
import { responseHeaders } from '@/middleware/response-headers';
import { spaFallback } from '@/middleware/spa-fallback';
import { apiRoutes } from '@/routes';
import type { Store } from '@/repositories/billing-store';
import type { Collector } from '@/services/collector';

export function createApp(store: Store, collector: Collector, webRoot?: string) {
  const app = new Koa();
  app.use(errorHandler);
  app.use(responseHeaders);
  app.use(apiRoutes(store, collector));
  if (webRoot) {
    app.use(serve(webRoot));
    app.use(spaFallback(webRoot));
  }
  return app;
}
