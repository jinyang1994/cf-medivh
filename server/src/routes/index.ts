import type { Middleware } from 'koa';
import { dashboard } from '@/services/dashboard';
import type { Store } from '@/repositories/billing-store';
import type { Collector } from '@/services/collector';

export function apiRoutes(store: Store, collector: Collector): Middleware {
  return async (ctx, next) => {
    if (ctx.path === '/api/health') {
      ctx.body = { ok: true, collecting: collector.running };
      return;
    }
    if (ctx.path === '/api/dashboard' && ctx.method === 'GET') {
      ctx.body = dashboard(store, collector);
      return;
    }
    if (ctx.path.startsWith('/api/')) {
      ctx.status = 404;
      ctx.body = { error: '未找到接口' };
      return;
    }
    await next();
  };
}
