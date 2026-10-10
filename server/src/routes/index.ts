import type { Middleware } from 'koa';
import { dashboard } from '@/services/dashboard';
import { serviceTrend } from '@/services/service-trend';
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
    if (ctx.path === '/api/service-trend' && ctx.method === 'GET') {
      const query = new URLSearchParams(ctx.querystring);
      const service = query.get('service');
      const meter = query.get('meter');
      if (
        [...query.keys()].some((key) => key !== 'service' && key !== 'meter') ||
        query.getAll('service').length !== 1 ||
        query.getAll('meter').length > 1 ||
        !service?.trim() ||
        service.length > 200 ||
        (meter !== null && (!meter.trim() || meter.length > 200))
      ) {
        ctx.status = 400;
        ctx.body = { error: '请提供有效且不重复的服务和计费项参数' };
        return;
      }
      const trend = serviceTrend(store, service, meter);
      if (!trend) {
        ctx.status = 404;
        ctx.body = { error: '未找到该服务的账期数据' };
        return;
      }
      ctx.body = trend;
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
