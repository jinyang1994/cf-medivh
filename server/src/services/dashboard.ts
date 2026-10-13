import uniq from 'lodash/uniq.js';
import { auditDifference, calculateDaily, money, reconcileTotals } from '@/services/calculation';
import { addDays, cycleContains, datesBetween, utcDate, utcDayStart } from '@/utils/dates';
import { Collector } from '@/services/collector';
import { Store } from '@/repositories/billing-store';
import type { Dashboard } from '@/types';
import { billingTimeline } from '@/services/timeline';

export function dashboard(store: Store, collector: Collector, now = new Date()): Dashboard {
  const today = utcDate(now);
  const cycle = store.activeCycle();
  const empty: Dashboard = {
    cycle: null,
    asOf: null,
    today,
    currency: 'USD',
    totals: {
      current: null,
      officialHistorical: null,
      officialThrough: null,
      todayLocal: null,
      localCumulative: null,
      difference: null,
      complete: false,
    },
    services: [],
    history: [],
    timeline: [],
    collection: {
      running: collector.running || store.collectionActive(),
      lastAttempt: store.get('lastAttempt'),
      lastSuccess: store.get('lastSuccess'),
      nextRun: collector.nextRun,
      errors: store.errors(),
      warnings: store.notificationErrors(),
      missingUsageDates: [],
      pendingOfficialDates: [],
    },
  };
  if (!cycle) return empty;
  const inCycle = cycleContains(cycle, today);
  const lastCycleDay = addDays(cycle.end, -1);
  const through = inCycle ? today : lastCycleDay;
  const yesterday = addDays(today, -1);
  const usage = store.usage(cycle.id);
  const bills = store.bills(cycle.id);
  const { calculation: local, dailyTotals } = calculateDaily(cycle, usage, through, today);
  const latest = [...bills.values()].findLast((row) => row.bill.through < today);
  const officialYesterday = bills.get(yesterday);
  const firstDay = today === cycle.start;
  const { todayLocal, currentTotal: current } = reconcileTotals(
    cycle,
    today,
    local,
    dailyTotals,
    officialYesterday?.bill.amount ?? null,
  );
  const officialHistorical = firstDay ? 0 : (latest?.bill.amount ?? null);
  const officialServiceCosts = officialYesterday?.bill.serviceCosts;
  const services = local.services.map((row) => {
    const officialCost = firstDay
      ? 0
      : officialServiceCosts === undefined
        ? null
        : (officialServiceCosts[row.key] ?? 0);
    return {
      ...row,
      officialCost,
      currentCost:
        officialCost !== null && current !== null ? money(officialCost + row.todayCost) : null,
    };
  });
  const persistentWarning = (warning: string) =>
    /retention|保留|留存|采样|覆盖|independent|独立核验/i.test(warning);
  const warnings = uniq(
    [...usage.entries()].flatMap(([date, value]) => {
      const warnings = value.report.warnings ?? [];
      return date === today || !value.report.complete
        ? warnings
        : warnings.filter(persistentWarning);
    }),
  );
  // Legacy snapshots created before the provider recorded its Logs retention warning still
  // contain enough observation provenance to identify unavailable startup history.
  if (
    [...usage.entries()].some(
      ([date, { report }]) =>
        report.source === 'analytics' &&
        Date.parse(report.observedAt) > utcDayStart(addDays(date, 8)) &&
        report.meters.some(
          (meter) => meter.key === 'worker_observability_events' && meter.quantity === 0,
        ),
    )
  ) {
    const warning =
      '启动前超过 7 天的 Workers Logs 已超出保留期；历史日志量不完整，费用仅从可用记录估算';
    if (!warnings.some((value) => value.includes('Workers Logs') && value.includes('保留期')))
      warnings.push(warning);
  }
  if ([...usage.values()].some((value) => value.report.source === 'billing-backfill'))
    warnings.push('部分历史用量来自官方账单回填，该部分差值不代表独立核验');
  if (!inCycle) warnings.push('当前账单周期尚未更新');
  const history = [...dailyTotals].map(([date, localAtDate]) => {
    const official = bills.get(date);
    const localTotal = official
      ? official.localTotal
      : localAtDate.complete
        ? localAtDate.total
        : null;
    const previous = bills.get(addDays(date, -1));
    const previousLocal = dailyTotals.get(addDays(date, -1));
    const officialDaily =
      date < today && official && (date === cycle.start || previous)
        ? auditDifference(official.bill.amount - (previous?.bill.amount ?? 0))
        : null;
    const estimatedDaily =
      localAtDate.complete && (date === cycle.start || previousLocal?.complete)
        ? money(localAtDate.total - (previousLocal?.total ?? 0))
        : null;
    const previousDifference =
      date === cycle.start
        ? 0
        : previous?.localComplete && previous.localTotal !== null
          ? previous.localTotal - previous.bill.amount
          : null;
    return {
      date,
      dailyCost: officialDaily ?? estimatedDaily,
      dailyCostSource:
        officialDaily !== null
          ? ('official' as const)
          : estimatedDaily !== null
            ? ('estimate' as const)
            : null,
      officialTotal: official?.bill.amount ?? null,
      localTotal,
      difference: official && localTotal !== null ? money(localTotal - official.bill.amount) : null,
      dailyDifference:
        official?.localComplete && localTotal !== null && previousDifference !== null
          ? auditDifference(localTotal - official.bill.amount - previousDifference)
          : null,
      localComplete: official?.localComplete ?? localAtDate.complete,
      fetchedAt: official?.fetchedAt ?? null,
    };
  });
  const lastComparison = history.findLast(
    (row) => row.officialTotal !== null && row.localTotal !== null,
  );
  return {
    ...empty,
    cycle,
    asOf: usage.get(today)?.report.observedAt ?? null,
    currency: cycle.currency,
    totals: {
      current,
      officialHistorical,
      officialThrough: firstDay ? null : (latest?.bill.through ?? null),
      todayLocal,
      localCumulative: local.complete ? local.total : null,
      difference: lastComparison?.difference ?? null,
      complete: current !== null,
    },
    services,
    history,
    timeline: billingTimeline(store, cycle, now),
    collection: {
      ...empty.collection,
      warnings: [...warnings, ...empty.collection.warnings],
      missingUsageDates: local.missingDates,
      pendingOfficialDates: datesBetween(
        cycle.start,
        yesterday < lastCycleDay ? yesterday : lastCycleDay,
      ).filter((date) => !bills.has(date)),
    },
  };
}
