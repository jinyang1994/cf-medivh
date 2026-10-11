import { dailyServices } from '@/services/daily-services';
import { validDate } from '@/utils/dates';
import type { Middleware } from 'koa';
import { dashboard } from '@/services/dashboard';
import { serviceTrend } from '@/services/service-trend';
import { withMeterUsage } from '@/services/resource-usage-trend';
import { resourceCostTrend } from '@/services/resource-cost-trend';
import type { Store } from '@/repositories/billing-store';
import type { Collector } from '@/services/collector';

export function apiRoutes(store: Store, collector: Collector): Middleware {
  return async (ctx, next) => {
    if (ctx.path === '/api/health') {
      ctx.body = { ok: true, collecting: collector.running };
      return;
    }
    if (ctx.path === '/api/daily-services' && ctx.method === 'GET') {
      const query = new URLSearchParams(ctx.querystring);
      const date = query.get('date');
      if (
        !date ||
        !validDate(date) ||
        query.getAll('date').length !== 1 ||
        [...query.keys()].some((key) => key !== 'date')
      ) {
        ctx.status = 400;
        ctx.body = { error: '请选择有效的日期' };
        return;
      }
      const detail = dailyServices(store, date, collector.clock());
      ctx.status = detail ? 200 : 404;
      ctx.body = detail ?? { error: '该日期不在当前账期内或尚未到来' };
      return;
    }
    if (ctx.path === '/api/dashboard' && ctx.method === 'GET') {
      ctx.body = dashboard(store, collector);
      return;
    }
    if (ctx.path === '/api/resource-cost-trend' && ctx.method === 'GET') {
      const query = new URLSearchParams(ctx.querystring);
      const service = query.get('service');
      const meter = query.get('meter');
      const resolution = query.get('resolution') ?? 'ten-minute';
      if (
        [...query.keys()].some((key) => !['service', 'meter', 'resolution'].includes(key)) ||
        query.getAll('service').length !== 1 ||
        query.getAll('meter').length > 1 ||
        query.getAll('resolution').length > 1 ||
        !service?.trim() ||
        service.length > 200 ||
        (meter !== null && (!meter.trim() || meter.length > 200)) ||
        (resolution !== 'ten-minute' && resolution !== 'daily')
      ) {
        ctx.status = 400;
        ctx.body = { error: '请选择有效的服务、计费项和费用图表粒度' };
        return;
      }
      const trend = resourceCostTrend(store, service, meter, resolution, collector.clock());
      if (!trend) {
        ctx.status = 404;
        ctx.body = { error: '未找到该服务的费用数据' };
        return;
      }
      ctx.body = trend;
      return;
    }
    if (ctx.path === '/api/resource-trend' && ctx.method === 'GET') {
      const query = new URLSearchParams(ctx.querystring);
      const service = query.get('service');
      const meter = query.get('meter');
      const resolution = query.get('resolution') ?? 'ten-minute';
      if (
        [...query.keys()].some((key) => !['service', 'meter', 'resolution'].includes(key)) ||
        query.getAll('service').length !== 1 ||
        query.getAll('meter').length !== 1 ||
        query.getAll('resolution').length > 1 ||
        !service?.trim() ||
        service.length > 200 ||
        !meter?.trim() ||
        meter.length > 200 ||
        (resolution !== 'ten-minute' && resolution !== 'daily')
      ) {
        ctx.status = 400;
        ctx.body = { error: '请选择有效的服务、计费项和资源图表粒度' };
        return;
      }
      const view = dashboard(store, collector);
      if (
        !view.cycle ||
        !view.services.some((item) => item.service === service && item.key === meter)
      ) {
        ctx.status = 404;
        ctx.body = { error: '未找到该服务的计费项' };
        return;
      }
      const cycle = view.cycle;
      const summary = view.services.find((item) => item.service === service && item.key === meter)!;
      const now = collector.clock();
      const end = new Date(Math.min(now.getTime(), Date.parse(cycle.end))).toISOString();
      const start =
        resolution === 'daily'
          ? cycle.start + 'T00:00:00.000Z'
          : new Date(
              Math.max(Date.parse(cycle.start), Date.parse(end) - 48 * 60 * 60 * 1000),
            ).toISOString();
      ctx.body = withMeterUsage(
        store,
        cycle,
        store.resourceUsage.read(cycle, service, meter, resolution, now) ?? {
          service,
          meterKey: meter,
          unit: summary.unit,
          resolution,
          start,
          end,
          fetchedAt: '',
          resources: [],
          points: [],
          warnings: [],
          unavailableReason:
            meter === '__base_fee'
              ? '固定订阅费用没有具体资源用量。'
              : '资源明细等待后台采集，页面仅读取已保存的数据。',
        },
        now,
      );
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
