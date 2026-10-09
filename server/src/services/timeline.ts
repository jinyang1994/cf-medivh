import { calculateDaily, reconcileTotals } from '@/services/calculation';
import { addDays, cycleContains, slotKey, TEN_MINUTES, utcDate, utcDayStart } from '@/utils/dates';
import type { DailyUsage } from '@/repositories/billing-store';
import { Store } from '@/repositories/billing-store';
import type { BillingCycle, BillingPoint, UsageReport } from '@/types';

const RECOVERY_KEY = 'billingTimelineRecovery:v1';

export function isRealtimeObservation(report: UsageReport): boolean {
  return (
    report.complete &&
    Number.isFinite(Date.parse(report.observedAt)) &&
    report.date === utcDate(new Date(report.observedAt))
  );
}

/** Capture this collection's values; this function never substitutes an earlier today's reading. */
export function financialPoint(
  cycle: BillingCycle,
  usage: Map<string, DailyUsage>,
  officialYesterday: number | null,
  observation: UsageReport,
): BillingPoint {
  const today = observation.date;
  const { calculation, dailyTotals } = calculateDaily(cycle, usage, today, today);
  return {
    timestamp: slotKey(new Date(observation.observedAt)),
    observedAt: observation.observedAt,
    source: 'collected',
    ...reconcileTotals(cycle, today, calculation, dailyTotals, officialYesterday),
  };
}

/** Recover legacy observations once. Never use a later correction or a later local reconciliation. */
export function recoverBillingTimeline(store: Store, now = new Date()): void {
  if (store.get(RECOVERY_KEY)) return;
  for (const cycle of store.cycles()) {
    const snapshots = store.usageSnapshotEvidence(cycle.id).map((snapshot) => ({
      ...snapshot,
      observedTime: Date.parse(snapshot.report.observedAt),
    }));
    const officialEvidence = store.officialAmountEvidence(cycle.id).map((row) => ({
      row,
      fetchedTime: Date.parse(row.fetchedAt),
    }));
    for (const candidate of snapshots) {
      const observation = candidate.report;
      if (
        candidate.corrected ||
        !isRealtimeObservation(observation) ||
        !cycleContains(cycle, observation.date)
      )
        continue;
      const observedTime = candidate.observedTime;
      if (observedTime > now.getTime()) continue;
      const knownUsage = new Map<string, DailyUsage>();
      const knownIds: Record<string, number> = {};
      for (const snapshot of snapshots) {
        if (snapshot.id > candidate.id) break;
        const report = snapshot.report;
        if (
          !report.complete ||
          report.date < cycle.start ||
          report.date > observation.date ||
          snapshot.observedTime > observedTime
        )
          continue;
        const previous = knownUsage.get(report.date);
        if (!previous || Date.parse(previous.report.observedAt) <= snapshot.observedTime) {
          knownUsage.set(report.date, { report, finalized: report.date < observation.date });
          knownIds[report.date] = snapshot.id;
        }
      }
      const yesterday = addDays(observation.date, -1);
      const official = officialEvidence.findLast(
        ({ row, fetchedTime }) => row.through === yesterday && fetchedTime <= observedTime,
      )?.row;
      const point = {
        ...financialPoint(cycle, knownUsage, official?.amount ?? null, observation),
        source: 'reconstructed' as const,
      };
      store.saveBillingPoint(cycle.id, point, 'recovery', now.toISOString(), {
        usageSnapshotIds: knownIds,
        observationSnapshotId: candidate.id,
        official: official ?? null,
      });
    }
  }
  store.set(RECOVERY_KEY, now.toISOString());
}

/** The API reads only small persisted financial points, filling missed slots with explicit nulls. */
export function billingTimeline(store: Store, cycle: BillingCycle, now: Date): BillingPoint[] {
  const end = Math.min(Date.parse(slotKey(now)), utcDayStart(cycle.end) - TEN_MINUTES);
  const start = utcDayStart(cycle.start);
  const points = store.billingPoints(cycle.id).filter((point) => {
    const timestamp = Date.parse(point.timestamp);
    return timestamp >= start && timestamp <= end;
  });
  if (points.length === 0) return [];
  const bySlot = new Map(points.map((point) => [point.timestamp, point]));
  const result: BillingPoint[] = [];
  for (let time = Date.parse(points[0]!.timestamp); time <= end; time += TEN_MINUTES) {
    const timestamp = new Date(time).toISOString();
    result.push(
      bySlot.get(timestamp) ?? {
        timestamp,
        observedAt: null,
        currentTotal: null,
        localTotal: null,
        officialHistorical: null,
        todayLocal: null,
      },
    );
  }
  return result;
}
