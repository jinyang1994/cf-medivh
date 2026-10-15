import type { Store } from '@/repositories/billing-store';
import type { Collector } from '@/services/collector';
import { dashboard } from '@/services/dashboard';
import { withMeterUsage } from '@/services/resource-usage-trend';
import type { ResourceUsageTrend } from '@/types';

/** Read saved resource samples and account-level meter usage without collecting. */
export function resourceTrend(
  store: Store,
  collector: Collector,
  service: string,
  meter: string,
  resolution: 'ten-minute' | 'daily',
  now = collector.clock(),
): ResourceUsageTrend | null {
  const view = dashboard(store, collector, now);
  const summary = view.services.find((item) => item.service === service && item.key === meter);
  if (!view.cycle || !summary) return null;
  const cycle = view.cycle;
  const end = new Date(Math.min(now.getTime(), Date.parse(cycle.end))).toISOString();
  const start =
    resolution === 'daily'
      ? cycle.start + 'T00:00:00.000Z'
      : new Date(
          Math.max(Date.parse(cycle.start), Date.parse(end) - 48 * 60 * 60 * 1000),
        ).toISOString();
  return withMeterUsage(
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
}
