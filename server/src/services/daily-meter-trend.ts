import type { Store } from '@/repositories/billing-store';
import type { ResourceUsageTrend, ResourceCostTrend } from '@/types';
import { calculateDaily, marginalUsageCharge, money } from '@/services/calculation';
import { addDays, cycleContains, TEN_MINUTES, utcDate } from '@/utils/dates';

export function dailyMeterTrend(
  store: Store,
  date: string,
  service: string,
  meter: string,
  now = new Date(),
) {
  const cycle = store.activeCycle();
  if (!cycle || !cycleContains(cycle, date) || date > utcDate(now)) return null;
  const start = Date.parse(date);
  const end = Math.min(start + 86400000, now.getTime());
  const reports = store.usageForCalculation(cycle.id, cycle.start, date, now.toISOString());
  const before = calculateDaily(cycle, reports, addDays(date, -1)).calculation;
  const selection = calculateDaily(cycle, reports, date).calculation.services.find(
    (row) => row.key === meter && row.service === service,
  );
  if (!selection) return null;
  const previous = before.services.find((row) => row.key === meter);
  const fixed = meter === '__base_fee';
  const price = selection.pricing;
  const costKnown =
    fixed || before.complete || (price.allowancePeriod === 'day' && !price.fixedFee);
  const observations = new Map<
    number,
    { quantity: number; cost: number | null; observed: number }
  >();
  for (const snapshot of store.usageSnapshotEvidence(cycle.id, {
    start: date,
    end: addDays(date, 1),
    observedThrough: now.toISOString(),
  })) {
    const report = snapshot.report;
    const observed = Date.parse(report.observedAt);
    if (
      !report.complete ||
      snapshot.corrected ||
      report.source === 'billing-backfill' ||
      utcDate(observed) !== date
    )
      continue;
    const row = report.meters.find((item) => item.key === meter && item.service === service);
    const quantity = row?.quantity ?? 0;
    const pricing = row?.pricing ?? price;
    const slot = Math.floor(observed / TEN_MINUTES) * TEN_MINUTES;
    if ((observations.get(slot)?.observed ?? -1) > observed) continue;
    observations.set(slot, {
      quantity,
      observed,
      cost: costKnown
        ? money(
            marginalUsageCharge(pricing, quantity, previous?.quantity ?? 0) +
              (!previous ? (pricing.fixedFee ?? 0) : 0),
          )
        : null,
    });
  }
  const raw = fixed
    ? null
    : store.resourceUsage.read(cycle, service, meter, 'ten-minute', new Date(end), {
        start: new Date(start).toISOString(),
      });
  // Hourly observations cannot be presented as real ten-minute samples.
  const resources = raw?.resolution === 'ten-minute' ? raw.resources : [];
  const resourcePoints = new Map(
    raw?.resolution === 'ten-minute'
      ? raw.points.map((point) => [point.timestamp, point.quantities])
      : [],
  );
  const usagePoints: ResourceUsageTrend['points'] = [];
  const costPoints: ResourceCostTrend['points'] = [];
  const daily = reports.get(date);
  let total = 0;
  let available = false;
  let complete = true;
  for (let time = start; time < end; time += TEN_MINUTES) {
    const timestamp = new Date(time).toISOString();
    const left = time === start ? 0 : observations.get(time)?.quantity;
    const next = time + TEN_MINUTES;
    const right =
      next === start + 86400000
        ? daily?.finalized && daily.report.complete
          ? (daily.report.meters.find((item) => item.key === meter)?.quantity ?? 0)
          : undefined
        : observations.get(next)?.quantity;
    const quantity = fixed
      ? null
      : next <= end && left != null && right != null && right >= left
        ? right - left
        : null;
    if (quantity === null) complete = false;
    else {
      total += quantity;
      available = true;
    }
    usagePoints.push({
      timestamp,
      total: quantity,
      quantities:
        resourcePoints.get(timestamp) ?? Object.fromEntries(resources.map((row) => [row.id, null])),
    });
    const cost = fixed
      ? date === cycle.start
        ? (cycle.baseFee ?? 0)
        : 0
      : time === start
        ? costKnown
          ? !previous
            ? (price.fixedFee ?? 0)
            : 0
          : null
        : (observations.get(time)?.cost ?? null);
    costPoints.push({
      timestamp,
      total: cost,
      officialCost: null,
      costs: {},
      unattributedCost: null,
    });
  }
  const bounds = {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    fetchedAt: now.toISOString(),
    service,
    meterKey: meter,
    resolution: 'ten-minute' as const,
  };
  return {
    date,
    name: selection.name,
    usage: {
      ...bounds,
      unit: selection.unit,
      resources,
      points: usagePoints,
      total: available ? total : null,
      totalComplete: complete,
      warnings:
        raw?.resolution === 'hourly'
          ? ['资源明细仅有小时采样；10 分钟汇总使用已保存的采集快照。']
          : [],
      unavailableReason: fixed ? '固定订阅费没有分时用量。' : null,
    } satisfies ResourceUsageTrend,
    cost: {
      ...bounds,
      currency: cycle.currency,
      resources: [],
      points: costPoints,
      warnings: [],
      unavailableReason: null,
    } satisfies ResourceCostTrend,
  };
}
