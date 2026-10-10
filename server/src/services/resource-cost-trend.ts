import type { Store } from '@/repositories/billing-store';
import { RESOURCE_USAGE_GAP_WARNING } from '@/repositories/resource-usage-store';
import { serviceTrend } from '@/services/service-trend';
import type { ResourceCostTrend, ResourceUsageTrend, ServiceTrendPoint } from '@/types';
import { TEN_MINUTES, utcDayStart } from '@/utils/dates';

type Resolution = ResourceCostTrend['resolution'];
type Quantities = Map<string, number>;
const DAY = 86_400_000;
const MICRO = 1_000_000;
const intervalFor = (resolution: ResourceUsageTrend['resolution']) =>
  resolution === 'daily' ? DAY : resolution === 'hourly' ? 3_600_000 : TEN_MINUTES;
const valid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function addQuantities(target: Quantities, quantities: Record<string, number | null>) {
  for (const [id, value] of Object.entries(quantities))
    if (valid(value)) target.set(id, (target.get(id) ?? 0) + value);
}

/** Prefer a valid daily value per resource; otherwise recover saved, completed fine buckets. */
class CumulativeResources {
  private daily = new Map<number, Quantities>();
  private baselines: { day: number; values: Quantities }[] = [];
  private fine = new Map<number, { through: number; values: Quantities }[]>();

  constructor(daily: ResourceUsageTrend | null, fine: ResourceUsageTrend | null) {
    for (const point of daily?.points ?? []) {
      const values: Quantities = new Map();
      addQuantities(values, point.quantities);
      this.daily.set(utcDayStart(point.timestamp), values);
    }
    if (fine) {
      const interval = intervalFor(fine.resolution);
      for (const point of fine.points) {
        const time = Date.parse(point.timestamp);
        const day = utcDayStart(time);
        const frames = this.fine.get(day) ?? [];
        const values = new Map(frames.at(-1)?.values);
        addQuantities(values, point.quantities);
        frames.push({ through: time + interval, values });
        this.fine.set(day, frames);
      }
    }
    const cumulative: Quantities = new Map();
    const days = new Set([...this.daily.keys(), ...this.fine.keys()]);
    for (const day of [...days].sort((a, b) => a - b)) {
      const values = new Map(this.fine.get(day)?.at(-1)?.values);
      for (const [id, value] of this.daily.get(day) ?? []) values.set(id, value);
      for (const [id, value] of values) cumulative.set(id, (cumulative.get(id) ?? 0) + value);
      this.baselines.push({ day, values: new Map(cumulative) });
    }
  }

  at(point: ServiceTrendPoint, resolution: Resolution): Quantities {
    const day = utcDayStart(point.timestamp);
    const baseline = this.baselines.findLast((frame) => frame.day < day);
    const values = new Map(baseline?.values);
    const time = Math.min(day + DAY, Date.parse(point.observedAt ?? point.timestamp));
    const current = new Map(this.fine.get(day)?.findLast((frame) => frame.through <= time)?.values);
    if (resolution === 'daily')
      for (const [id, value] of this.daily.get(day) ?? []) current.set(id, value);
    for (const [id, value] of current) values.set(id, (values.get(id) ?? 0) + value);
    return values;
  }
}

/** Allocate integer millionths once, including the missing-data share, without rounding drift. */
function allocate(amount: number, quantity: number | null, quantities: Quantities) {
  const total = Math.round(amount * MICRO);
  const known = [...quantities.values()].reduce((sum, value) => sum + value, 0);
  const denominator = Math.max(quantity ?? 0, known);
  const result = new Map([...quantities.keys()].map((id) => [id, 0]));
  if (denominator <= 0) return { costs: result, unattributed: total };
  const shares: { id: string | null; exact: number; value: number }[] = [];
  for (const [id, weight] of quantities)
    if (weight > 0) {
      const exact = (weight / denominator) * total;
      shares.push({ id, exact, value: Math.floor(exact) });
    }
  const missing = Math.max(0, denominator - known);
  if (missing > 0) {
    const exact = (missing / denominator) * total;
    shares.push({ id: null, exact, value: Math.floor(exact) });
  }
  shares.sort(
    (a, b) => b.exact - b.value - (a.exact - a.value) || (a.id ?? '').localeCompare(b.id ?? ''),
  );
  let remainder = total - shares.reduce((sum, share) => sum + share.value, 0);
  for (const share of shares) {
    if (remainder > 0) {
      share.value++;
      remainder--;
    }
    if (share.id !== null) result.set(share.id, share.value);
  }
  return {
    costs: result,
    unattributed: (shares.find((share) => share.id === null)?.value ?? 0) + remainder,
  };
}

/** Read SQLite only: account allowances/pricing are applied by serviceTrend before allocation. */
export function resourceCostTrend(
  store: Store,
  service: string,
  meterKey: string | null,
  resolution: Resolution,
  now = new Date(),
): ResourceCostTrend | null {
  const aggregate = serviceTrend(store, service, meterKey, now);
  if (!aggregate) return null;
  const { cycle } = aggregate;
  const end = Math.min(now.getTime(), Date.parse(cycle.end));
  const start = Math.max(
    Date.parse(cycle.start),
    resolution === 'daily'
      ? Date.parse(cycle.start)
      : Math.ceil((end - 2 * DAY) / TEN_MINUTES) * TEN_MINUTES,
  );
  const selected = (resolution === 'daily' ? aggregate.history : aggregate.timeline).filter(
    (point) => Date.parse(point.timestamp) >= start && Date.parse(point.timestamp) < end,
  );
  const meters = new Set<string>();
  if (meterKey !== null) meters.add(meterKey);
  else
    for (const { report } of store.usage(cycle.id).values())
      if (Date.parse(report.observedAt) <= now.getTime())
        for (const meter of report.meters) if (meter.service === service) meters.add(meter.key);
  if (service === '订阅' && (cycle.baseFee ?? 0) > 0) meters.add('__base_fee');
  const names = new Map<string, string>();
  const warnings = new Set<string>();
  const fetched = selected.flatMap((point) => (point.observedAt ? [point.observedAt] : []));
  const streams = [...meters].flatMap((key) => {
    const trend = key === meterKey ? aggregate : serviceTrend(store, service, key, now);
    if (!trend) return [];
    const daily = store.resourceUsage.read(cycle, service, key, 'daily', now);
    // Older saved fine buckets are still needed if any daily resource value is absent.
    const fine = store.resourceUsage.read(cycle, service, key, 'ten-minute', now, {
      start: cycle.start,
    });
    for (const data of [daily, fine]) {
      if (!data) continue;
      fetched.push(data.fetchedAt);
      // A gap in one source may be completely covered by the other source. The allocation
      // below reports actual unattributed costs after daily/fine evidence is reconciled.
      for (const warning of data.warnings)
        if (warning !== RESOURCE_USAGE_GAP_WARNING) warnings.add(warning);
      if (data.unavailableReason) warnings.add(`${trend.name}：${data.unavailableReason}`);
      for (const resource of data.resources)
        if (!names.has(resource.id) || resource.name !== resource.id)
          names.set(resource.id, resource.name);
    }
    if (!daily && !fine) warnings.add(`${trend.name}尚无资源用量记录，相应费用保留为未归属。`);
    if (fine && fine.resolution !== 'ten-minute')
      warnings.add(
        `${trend.name}资源用量按${fine.resolution === 'hourly' ? '小时' : '日'}采集，仅使用费用观察时已结束的时段。`,
      );
    return [
      {
        points: new Map(
          (resolution === 'daily' ? trend.history : trend.timeline).map((point) => [
            point.timestamp,
            point,
          ]),
        ),
        resources: new CumulativeResources(daily, fine),
      },
    ];
  });
  let missing = false;
  const points: ResourceCostTrend['points'] = selected.map((point) => {
    const costs: Record<string, number | null> = Object.create(null);
    for (const id of names.keys()) costs[id] = null;
    if (point.localCost === null)
      return {
        timestamp: point.timestamp,
        total: null,
        officialCost: point.officialCost,
        costs,
        unattributedCost: null,
      };
    for (const stream of streams) {
      const target = stream.points.get(point.timestamp);
      if (!target || target.localCost === null) continue;
      const allocated = allocate(
        target.localCost,
        target.quantity,
        stream.resources.at(target, resolution),
      );
      for (const [id, value] of allocated.costs) costs[id] = (costs[id] ?? 0) + value;
    }
    // Reconcile in integer currency units to the existing service total, including absent meters.
    let assigned = Object.values(costs).reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const target = Math.round(point.localCost * MICRO);
    if (assigned > target) {
      // Defensive cross-meter rounding reconciliation must never create a negative remainder.
      for (const [id, value] of Object.entries(costs).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
        if (value === null) continue;
        const reduction = Math.min(value, assigned - target);
        costs[id] = value - reduction;
        assigned -= reduction;
        if (assigned <= target) break;
      }
    }
    const unattributed = target - assigned;
    if (unattributed > 0) missing = true;
    for (const id of Object.keys(costs)) if (costs[id] !== null) costs[id] = costs[id]! / MICRO;
    return {
      timestamp: point.timestamp,
      total: point.localCost,
      officialCost: point.officialCost,
      costs,
      unattributedCost: unattributed / MICRO,
    };
  });
  if (missing)
    warnings.add(
      '部分费用缺少对应的资源用量或时段尚未结束，显示为未归属；不会按已有资源比例放大补齐。',
    );
  const latest = points.findLast((point) => point.total !== null);
  if (latest && latest !== points.at(-1))
    warnings.add('最近时段的费用尚不可用，资源合计保留最后一次可用的累计估算。');
  const resources = [...names]
    .map(([id, name]) => ({ id, name, total: latest?.costs[id] ?? 0 }))
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  return {
    service,
    meterKey,
    currency: aggregate.currency,
    resolution,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    fetchedAt:
      fetched
        .filter((at) => Date.parse(at) <= now.getTime())
        .sort()
        .at(-1) ?? now.toISOString(),
    resources,
    points,
    warnings: [...warnings],
    unavailableReason: latest ? null : '尚无可用的本地费用记录，请等待后台采集完成。',
  };
}
