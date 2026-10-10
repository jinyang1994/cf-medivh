import type { Store } from '@/repositories/billing-store';
import type { BillingCycle, CloudflareProvider, ResourceUsageTrend, UsageMeter } from '@/types';
import { slotKey, utcDayStart } from '@/utils/dates';

type Resolution = 'ten-minute' | 'daily';
type Coverage = { start: string; end: string; complete: boolean };
type CollectionState = {
  slot?: string;
  floor?: string;
  resolution?: ResourceUsageTrend['resolution'];
};
export type ResourceCollectionResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
};
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const inflight = new WeakMap<Store, Promise<ResourceCollectionResult>>();

function stateFor(store: Store, key: string): CollectionState {
  try {
    const state: unknown = JSON.parse(store.get(key) ?? '{}');
    return state && typeof state === 'object' ? (state as CollectionState) : {};
  } catch {
    return {};
  }
}

/** Find the first hole without treating later successful windows as recovery of earlier ones. */
function firstGap(coverage: Coverage[], start: number, end: number): number {
  let cursor = start;
  for (const window of coverage
    .filter((item) => item.complete)
    .map((item) => ({ start: Date.parse(item.start), end: Date.parse(item.end) }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end))
    .sort((a, b) => a.start - b.start)) {
    if (window.start > cursor) break;
    cursor = Math.max(cursor, window.end);
    if (cursor >= end) return end;
  }
  return Math.min(cursor, end);
}

function collectionWindow(
  store: Store,
  cycle: BillingCycle,
  meter: UsageMeter,
  resolution: Resolution,
  state: CollectionState,
  now: Date,
) {
  const cycleStart = utcDayStart(cycle.start);
  const end = Math.min(now.getTime(), utcDayStart(cycle.end));
  const savedFloor = typeof state.floor === 'string' ? Date.parse(state.floor) : Number.NaN;
  const floor = Math.max(
    cycleStart,
    Number.isFinite(savedFloor)
      ? savedFloor
      : resolution === 'daily'
        ? cycleStart
        : end - 48 * HOUR,
  );
  const coverage = store.resourceUsage.coverage(cycle.id, meter.service, meter.key, resolution);
  const gap = firstGap(coverage, floor, end);
  const successfulEnds = coverage
    .filter((window) => window.complete)
    .map((window) => Date.parse(window.end))
    .filter((value) => Number.isFinite(value) && value <= end);
  const lastEnd = successfulEnds.length ? Math.max(...successfulEnds) : floor;
  const recent =
    resolution === 'daily' || state.resolution === 'daily'
      ? utcDayStart(now) - 2 * DAY
      : lastEnd - 2 * HOUR;
  const start = Math.max(floor, Math.min(gap, recent));
  return {
    floor,
    start: state.resolution === 'daily' ? Math.max(cycleStart, utcDayStart(start)) : start,
    end,
  };
}

async function run(
  store: Store,
  provider: CloudflareProvider,
  cycle: BillingCycle,
  now: Date,
): Promise<ResourceCollectionResult> {
  const result = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  const read = provider.getResourceTrend?.bind(provider);
  if (!read) return result;
  const meters = new Map<string, UsageMeter>();
  for (const { report } of store.usage(cycle.id).values()) {
    for (const meter of report.meters) {
      if (meter.key === '__base_fee' || meter.pricing.fixedFee !== undefined) continue;
      meters.set(JSON.stringify([meter.service, meter.key]), meter);
    }
  }
  const pending = [...meters.values()];
  const slot = slotKey(now);
  const worker = async () => {
    for (let meter = pending.shift(); meter; meter = pending.shift()) {
      for (const resolution of ['ten-minute', 'daily'] as const) {
        const key = `resource-collection:${JSON.stringify([cycle.id, meter.service, meter.key, resolution])}`;
        const state = stateFor(store, key);
        if (state.slot === slot) {
          result.skipped++;
          continue;
        }
        const window = collectionWindow(store, cycle, meter, resolution, state, now);
        if (window.start >= window.end) continue;
        const start = new Date(window.start).toISOString();
        const end = new Date(window.end).toISOString();
        result.attempted++;
        let trend: ResourceUsageTrend;
        try {
          trend = await read(cycle, meter.service, meter.key, resolution, { start, end });
        } catch {
          const previous = store.resourceUsage.read(
            cycle,
            meter.service,
            meter.key,
            resolution,
            now,
          );
          trend = {
            service: meter.service,
            meterKey: meter.key,
            unit: previous?.unit ?? meter.unit,
            resolution: previous?.resolution ?? resolution,
            start,
            end,
            fetchedAt: now.toISOString(),
            resources: [],
            points: [],
            coverage: [{ start, end, complete: false }],
            warnings: ['资源用量采集失败，将在下一轮自动重试。'],
            unavailableReason: '暂时未能取得资源用量。',
          };
        }
        try {
          store.resourceUsage.save(cycle, resolution, trend);
          // Only a query at the oldest required boundary may advance that boundary for
          // API retention. A successful recent query must never discard an older gap.
          const returnedStart = Date.parse(trend.start);
          const floor =
            window.start <= window.floor &&
            Number.isFinite(returnedStart) &&
            returnedStart < window.end
              ? Math.max(window.floor, returnedStart)
              : window.floor;
          store.set(
            key,
            JSON.stringify({
              slot,
              floor: new Date(floor).toISOString(),
              resolution: trend.resolution,
            }),
          );
          if (
            trend.unavailableReason ||
            trend.coverage?.some((part) => !part.complete) ||
            trend.points.some((point) =>
              Object.values(point.quantities).some((value) => value === null),
            )
          ) {
            result.failed++;
          } else {
            result.succeeded++;
          }
        } catch {
          // Do not mark an unfinished write as collected: a same-slot restart can recover it.
          result.failed++;
          console.error(`Resource usage persistence failed: ${meter.service} / ${meter.key}`);
        }
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return result;
}

/** Persist analytics independently of billing snapshots and notification delivery. */
export function collectResourceUsage(
  store: Store,
  provider: CloudflareProvider,
  cycle: BillingCycle,
  now: Date = new Date(),
): Promise<ResourceCollectionResult> {
  const pending = inflight.get(store);
  if (pending) return pending;
  const promise = run(store, provider, cycle, now).finally(() => inflight.delete(store));
  inflight.set(store, promise);
  return promise;
}
