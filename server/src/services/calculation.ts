import { addDays, cycleContains, datesBetween } from '@/utils/dates';
import type { DailyUsage } from '@/repositories/billing-store';
import type { BillingCycle, MeterPricing, ServiceSummary, UsageReport } from '@/types';

export const money = (value: number): number =>
  Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
/** Audit differences can be smaller than the six-decimal estimate itself. */
export const auditDifference = (value: number): number => Math.round(value * 1e12) / 1e12;
export interface Calculation {
  total: number;
  complete: boolean;
  missingDates: string[];
  services: ServiceSummary[];
  /** The exact observations used by a persisted comparison, for audit and later revisions. */
  sources: { date: string; observedAt: string; source: string; finalized: boolean }[];
}

export type DailyTotal = Pick<Calculation, 'total' | 'complete'>;

/** Usage overage only; fixed fees are applied separately, once per cycle. */
export function marginalUsageCharge(
  price: MeterPricing,
  quantity: number,
  previousQuantity: number,
): number {
  const charge = (value: number) => {
    const units = Math.max(0, value - price.includedQuantity) / price.unitSize;
    return (price.rounding === 'up' ? Math.ceil(units) : units) * price.unitPrice;
  };
  return price.allowancePeriod === 'day'
    ? charge(quantity)
    : charge(previousQuantity + quantity) - charge(previousQuantity);
}

/** Use yesterday's official bill plus today's marginal charge in every view. */
export function reconcileTotals(
  cycle: BillingCycle,
  today: string,
  local: DailyTotal,
  dailyTotals: ReadonlyMap<string, DailyTotal>,
  officialYesterday: number | null,
) {
  const firstDay = today === cycle.start;
  const previous = firstDay ? { total: 0, complete: true } : dailyTotals.get(addDays(today, -1));
  const todayLocal =
    cycleContains(cycle, today) && local.complete && previous?.complete
      ? money(local.total - previous.total)
      : null;
  const officialHistorical = firstDay ? 0 : officialYesterday;
  return {
    localTotal: local.complete ? local.total : null,
    todayLocal,
    officialHistorical,
    currentTotal:
      officialHistorical !== null && todayLocal !== null
        ? money(officialHistorical + todayLocal)
        : null,
  };
}

export function validateUsage(report: UsageReport, cycle: BillingCycle, expectedDate: string) {
  if (report.date !== expectedDate)
    throw new Error(`Usage date mismatch: expected ${expectedDate}, received ${report.date}`);
  if (!Number.isFinite(Date.parse(report.observedAt)))
    throw new Error('Usage observation timestamp is invalid');
  const keys = new Set<string>();
  for (const meter of report.meters) {
    if (keys.has(meter.key)) throw new Error(`Duplicate usage meter ${meter.key}`);
    keys.add(meter.key);
    if (!meter.key || !meter.service || !meter.name || !meter.unit)
      throw new Error('Usage meter identity is missing');
    if (meter.pricing.currency !== cycle.currency)
      throw new Error(`Currency mismatch for ${meter.key}`);
    for (const value of [
      meter.quantity,
      meter.pricing.unitPrice,
      meter.pricing.includedQuantity,
      meter.pricing.fixedFee ?? 0,
    ])
      if (!Number.isFinite(value) || value < 0)
        throw new Error(`Invalid usage or price for ${meter.key}`);
    if (!Number.isFinite(meter.pricing.unitSize) || meter.pricing.unitSize <= 0)
      throw new Error(`Invalid price unit for ${meter.key}`);
  }
}

/** Integrate daily cumulative readings once. Monthly allowances are shared across all days. */
export function calculate(
  cycle: BillingCycle,
  usage: Map<string, DailyUsage>,
  through: string,
  today = through,
  requireFinalized = false,
): Calculation {
  return calculateDaily(cycle, usage, through, today, requireFinalized).calculation;
}

/** One pass produces the final service breakdown and lightweight totals for every day. */
export function calculateDaily(
  cycle: BillingCycle,
  usage: Map<string, DailyUsage>,
  through: string,
  today = through,
  requireFinalized = false,
): { calculation: Calculation; dailyTotals: Map<string, DailyTotal> } {
  const rows = new Map<string, ServiceSummary>();
  const cumulative = new Map<string, number>();
  const missingDates: string[] = [];
  const fixedSeen = new Set<string>();
  const sources: Calculation['sources'] = [];
  const dailyTotals = new Map<string, DailyTotal>();
  let total = through >= cycle.start ? (cycle.baseFee ?? 0) : 0;
  let complete = true;
  for (const date of datesBetween(cycle.start, through)) {
    const daily = usage.get(date);
    if (!daily?.report.complete || (requireFinalized && !daily.finalized)) {
      missingDates.push(date);
      complete = false;
    }
    if (!daily) {
      dailyTotals.set(date, { total: money(total), complete });
      continue;
    }
    sources.push({
      date,
      observedAt: daily.report.observedAt,
      source: daily.report.source ?? 'unknown',
      finalized: daily.finalized,
    });
    for (const meter of daily.report.meters) {
      const price = meter.pricing;
      const previous = cumulative.get(meter.key) ?? 0;
      const current = previous + meter.quantity;
      const variable = marginalUsageCharge(price, meter.quantity, previous);
      const fixed = fixedSeen.has(meter.key) ? 0 : (price.fixedFee ?? 0);
      const amount = variable + fixed;
      fixedSeen.add(meter.key);
      cumulative.set(meter.key, current);
      total += amount;
      const row = rows.get(meter.key) ?? {
        ...meter,
        quantity: 0,
        todayQuantity: 0,
        cost: 0,
        todayCost: 0,
      };
      row.quantity = current;
      row.pricing = price;
      row.cost += amount;
      if (date === today) {
        row.todayQuantity = meter.quantity;
        row.todayCost = amount;
      }
      rows.set(meter.key, row);
    }
    dailyTotals.set(date, { total: money(total), complete });
  }
  if ((cycle.baseFee ?? 0) > 0 && through >= cycle.start)
    rows.set('__base_fee', {
      key: '__base_fee',
      service: '订阅',
      name: '固定订阅费',
      unit: '周期',
      quantity: 1,
      todayQuantity: today === cycle.start ? 1 : 0,
      cost: cycle.baseFee!,
      todayCost: today === cycle.start ? cycle.baseFee! : 0,
      pricing: {
        currency: cycle.currency,
        unitPrice: cycle.baseFee!,
        unitSize: 1,
        includedQuantity: 0,
      },
    });
  return {
    dailyTotals,
    calculation: {
      total: money(total),
      complete,
      missingDates,
      sources,
      services: [...rows.values()].map((row) => ({
        ...row,
        cost: money(row.cost),
        todayCost: money(row.todayCost),
      })),
    },
  };
}
