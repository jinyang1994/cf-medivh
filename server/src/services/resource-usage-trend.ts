import type { Store } from '@/repositories/billing-store';
import type { BillingCycle, ResourceUsageTrend, UsageReport } from '@/types';
import { TEN_MINUTES, utcDate, utcDayStart } from '@/utils/dates';

/** Use the same saved meter reports as the service table, never resource sums. */
export function withMeterUsage(
  store: Store,
  cycle: BillingCycle,
  trend: ResourceUsageTrend,
  now: Date,
): ResourceUsageTrend {
  if (trend.meterKey === '__base_fee') return trend;
  const interval =
    trend.resolution === 'daily'
      ? 86_400_000
      : trend.resolution === 'hourly'
        ? 3_600_000
        : TEN_MINUTES;
  const start = Date.parse(trend.start);
  const end = Date.parse(trend.end);
  const usage = store.usage(cycle.id);
  const quantity = (report: UsageReport): number | null => {
    const meters = report.meters.filter(
      (item) => item.key === trend.meterKey && item.service === trend.service,
    );
    if (!meters.length) return report.complete ? 0 : null;
    const total = meters.reduce((sum, item) => sum + item.quantity, 0);
    return Number.isFinite(total) && total >= 0 ? total : null;
  };
  const observations = new Map<number, { quantity: number; observed: number }>();
  if (trend.resolution !== 'daily') {
    for (const snapshot of store.usageSnapshotEvidence(cycle.id, {
      start: utcDate(start),
      end: cycle.end,
      observedThrough: now.toISOString(),
    })) {
      const { report } = snapshot;
      const observed = Date.parse(report.observedAt);
      if (
        !report.complete ||
        snapshot.corrected ||
        report.source === 'billing-backfill' ||
        report.date !== utcDate(observed)
      )
        continue;
      const value = quantity(report);
      if (value === null) continue;
      // Only observations in the boundary's collection slot can bound an interval.
      const slot = Math.floor(observed / TEN_MINUTES) * TEN_MINUTES;
      if (slot % interval !== 0) continue;
      const previous = observations.get(slot);
      if (!previous || observed >= previous.observed)
        observations.set(slot, { quantity: value, observed });
    }
  }
  const resources = new Map(trend.points.map((point) => [Date.parse(point.timestamp), point]));
  const points: ResourceUsageTrend['points'] = [];
  let total = 0;
  let available = false;
  let complete = true;
  for (let time = Math.ceil(start / interval) * interval; time < end; time += interval) {
    const day = utcDate(time);
    const daily = usage.get(day);
    let value: number | null = null;
    if (trend.resolution === 'daily') {
      if (daily && Date.parse(daily.report.observedAt) <= now.getTime()) {
        value = quantity(daily.report);
        if (!daily.report.complete) complete = false;
      }
    } else {
      const before = time === utcDayStart(day) ? 0 : observations.get(time)?.quantity;
      const next = time + interval;
      const after =
        utcDate(next) !== day
          ? daily?.finalized && Date.parse(daily.report.observedAt) <= now.getTime()
            ? quantity(daily.report)
            : null
          : observations.get(next)?.quantity;
      if (next <= end && before != null && after != null && after >= before) value = after - before;
    }
    if (value === null) complete = false;
    else {
      available = true;
      total += value;
    }
    points.push({
      timestamp: new Date(time).toISOString(),
      quantities:
        resources.get(time)?.quantities ??
        Object.fromEntries(trend.resources.map((r) => [r.id, null])),
      total: value,
    });
  }
  const warnings = [...trend.warnings];
  if (!complete) warnings.push('服务汇总有缺失或未完成时段，合计仅包含已有计费项记录。');
  if (trend.unavailableReason && available) warnings.push(trend.unavailableReason);
  return {
    ...trend,
    points,
    total: available ? total : null,
    totalComplete: complete,
    warnings: [...new Set(warnings)],
    unavailableReason: available ? null : trend.unavailableReason,
  };
}
