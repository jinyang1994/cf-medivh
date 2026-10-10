import type { DailyUsage, HistoricalUsageSnapshot } from '@/repositories/billing-store';
import { Store } from '@/repositories/billing-store';
import { calculateDaily, money } from '@/services/calculation';
import type { BillingCycle, ServiceTrend, ServiceTrendPoint, UsageReport } from '@/types';
import { addDays, datesBetween, slotKey, TEN_MINUTES, utcDate, utcDayStart } from '@/utils/dates';

interface TimedSnapshot extends HistoricalUsageSnapshot {
  observedTime: number;
}

/**
 * Activate snapshots in insertion order, then find the latest observation at or before a
 * candidate's time. A prefix-max index also handles corrections and out-of-order clocks
 * without rescanning all earlier snapshots for every point.
 */
class KnownUsage {
  private dates = new Map<string, { rows: TimedSnapshot[]; active: number[] }>();
  private positions = new Map<number, number>();

  constructor(snapshots: TimedSnapshot[]) {
    for (const snapshot of snapshots) {
      if (!snapshot.report.complete) continue;
      const date = snapshot.report.date;
      const group = this.dates.get(date) ?? { rows: [], active: [] };
      group.rows.push(snapshot);
      this.dates.set(date, group);
    }
    for (const group of this.dates.values()) {
      group.rows.sort((a, b) => a.observedTime - b.observedTime || a.id - b.id);
      group.active = new Array<number>(group.rows.length + 1).fill(0);
      group.rows.forEach((row, index) => this.positions.set(row.id, index + 1));
    }
  }

  add(snapshot: TimedSnapshot): void {
    const position = this.positions.get(snapshot.id);
    if (position === undefined) return;
    const group = this.dates.get(snapshot.report.date)!;
    for (let index = position; index < group.active.length; index += index & -index)
      group.active[index] = Math.max(group.active[index]!, position);
  }

  at(through: string, observedTime: number): Map<string, DailyUsage> {
    const usage = new Map<string, DailyUsage>();
    for (const [date, group] of this.dates) {
      if (date > through) continue;
      let low = 0;
      let high = group.rows.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (group.rows[middle]!.observedTime <= observedTime) low = middle + 1;
        else high = middle;
      }
      let position = 0;
      for (let index = low; index > 0; index -= index & -index)
        position = Math.max(position, group.active[index]!);
      if (position > 0)
        usage.set(date, {
          report: group.rows[position - 1]!.report,
          finalized: date < through,
        });
    }
    return usage;
  }
}

const emptyPoint = (timestamp: string): ServiceTrendPoint => ({
  timestamp,
  observedAt: null,
  localCost: null,
  officialCost: null,
  quantity: null,
});

/** Read stored evidence only. A graph request never fetches usage or writes recovered points. */
export function serviceTrend(
  store: Store,
  service: string,
  meterKey: string | null = null,
  now = new Date(),
): ServiceTrend | null {
  const cycle = store.activeCycle();
  if (!cycle) return null;
  const today = utcDate(now);
  const through = today < cycle.end ? today : addDays(cycle.end, -1);
  const usage = new Map(
    [...store.usage(cycle.id)].filter(
      ([date, value]) =>
        date >= cycle.start &&
        date <= through &&
        Date.parse(value.report.observedAt) <= now.getTime(),
    ),
  );
  const matches = (row: { service: string; key: string }) =>
    row.service === service && (meterKey === null || row.key === meterKey);
  const selection = calculateDaily(cycle, usage, through).calculation.services.filter(matches);
  if (!selection.length) return null;
  const selectedKeys = new Set(selection.map((row) => row.key));
  const selectedCycle: BillingCycle = {
    ...cycle,
    baseFee: selectedKeys.has('__base_fee') ? cycle.baseFee : 0,
  };
  const selectReport = (report: UsageReport): UsageReport => ({
    date: report.date,
    observedAt: report.observedAt,
    complete: report.complete,
    meters: report.meters.filter(matches),
  });
  const selectedUsage = new Map(
    [...usage].map(([date, daily]) => [date, { ...daily, report: selectReport(daily.report) }]),
  );
  const amounts = (known: Map<string, DailyUsage>, date: string) => {
    const { calculation } = calculateDaily(selectedCycle, known, date);
    // A fixed subscription is known independently of gaps in usage collection.
    const complete =
      calculation.complete || (selectedKeys.size === 1 && selectedKeys.has('__base_fee'));
    return {
      localCost: complete
        ? money(calculation.services.reduce((sum, row) => sum + row.cost, 0))
        : null,
      quantity:
        complete && meterKey !== null
          ? (calculation.services.find((row) => row.key === meterKey)?.quantity ?? 0)
          : null,
    };
  };
  const bills = store.bills(cycle.id);
  const history = datesBetween(cycle.start, through).map((date): ServiceTrendPoint => {
    const bill = bills.get(date);
    const costs =
      bill && Date.parse(bill.fetchedAt) <= now.getTime() ? bill.bill.serviceCosts : undefined;
    return {
      timestamp: new Date(utcDayStart(date)).toISOString(),
      observedAt: usage.get(date)?.report.observedAt ?? null,
      ...amounts(selectedUsage, date),
      officialCost:
        costs === undefined
          ? null
          : money([...selectedKeys].reduce((sum, key) => sum + (costs[key] ?? 0), 0)),
    };
  });

  const snapshots = store
    .usageSnapshotEvidence(cycle.id, {
      start: cycle.start,
      end: cycle.end,
      observedThrough: now.toISOString(),
    })
    .map((snapshot): TimedSnapshot => ({
      ...snapshot,
      report: selectReport(snapshot.report),
      observedTime: Date.parse(snapshot.report.observedAt),
    }));
  const known = new KnownUsage(snapshots);
  const bySlot = new Map<string, { point: ServiceTrendPoint; quality: number }>();
  for (const snapshot of snapshots) {
    known.add(snapshot);
    const { report } = snapshot;
    // Backfills and patched snapshots are baselines for later observations, never new points.
    if (snapshot.corrected || report.date !== utcDate(snapshot.observedTime)) continue;
    const timestamp = slotKey(new Date(snapshot.observedTime));
    const point = report.complete
      ? {
          ...emptyPoint(timestamp),
          ...amounts(known.at(report.date, snapshot.observedTime), report.date),
          observedAt: report.observedAt,
        }
      : emptyPoint(timestamp);
    const quality = report.complete ? (point.localCost !== null ? 2 : 1) : 0;
    const previous = bySlot.get(timestamp);
    if (
      !previous ||
      quality > previous.quality ||
      (quality === previous.quality &&
        snapshot.observedTime >= Date.parse(previous.point.observedAt ?? timestamp))
    )
      bySlot.set(timestamp, { point, quality });
  }
  const timeline: ServiceTrendPoint[] = [];
  const start = [...bySlot.keys()].sort()[0];
  const end = Math.min(Date.parse(slotKey(now)), utcDayStart(cycle.end) - TEN_MINUTES);
  if (start)
    for (let time = Date.parse(start); time <= end; time += TEN_MINUTES) {
      const timestamp = new Date(time).toISOString();
      timeline.push(bySlot.get(timestamp)?.point ?? emptyPoint(timestamp));
    }
  return {
    cycle,
    service,
    meterKey,
    name: meterKey === null ? service : selection[0]!.name,
    unit: meterKey === null ? null : selection[0]!.unit,
    currency: cycle.currency,
    history,
    timeline,
  };
}
