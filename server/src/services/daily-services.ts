import type { Store } from '@/repositories/billing-store';
import { calculateDaily, auditDifference } from '@/services/calculation';
import { priceForServiceName } from '@/services/pricing';
import type { DailyServices } from '@/types';
import { cycleContains, utcDate, validDate, utcDayRange } from '@/utils/dates';

/** Read stored daily usage and its historical prices; never collect on navigation. */
export function dailyServices(store: Store, date: string, now = new Date()): DailyServices | null {
  const cycle = store.activeCycle();
  if (!cycle || !validDate(date) || !cycleContains(cycle, date) || date > utcDate(now)) return null;
  const usage = store.usageForCalculation(cycle.id, cycle.start, date, now.toISOString());
  const daily = usage.get(date)?.report;
  const meters = new Map(daily?.meters.map((item) => [item.key, item]));
  const { calculation } = calculateDaily(cycle, usage, date);
  // Compare independently collected usage with daily billing rows, never cumulative
  // pricing quantities or the bill's cumulative service costs. Missing is not zero.
  const official = new Map<string, { quantity: number; cost: number }>();
  const bill = date < utcDate(now) ? store.billAt(cycle.id, date) : null;
  const records = (bill?.raw as { records?: unknown } | undefined)?.records;
  const window = utcDayRange(date);
  if (bill?.currency === cycle.currency && Array.isArray(records)) {
    const invalid = new Set<string>();
    for (const record of records) {
      if (!record || typeof record.ServiceName !== 'string') continue;
      const key = priceForServiceName(record.ServiceName)?.key;
      if (
        !key ||
        Date.parse(record.ChargePeriodStart) !== window.start ||
        Date.parse(record.ChargePeriodEnd) !== window.end ||
        Date.parse(record.BillingPeriodStart) !== Date.parse(cycle.start)
      )
        continue;
      if (
        record.BillingCurrency !== cycle.currency ||
        !Number.isFinite(record.ConsumedQuantity) ||
        record.ConsumedQuantity < 0 ||
        !Number.isFinite(record.ContractedCost)
      ) {
        invalid.add(key);
        continue;
      }
      const previous = official.get(key) ?? { quantity: 0, cost: 0 };
      official.set(key, {
        quantity: previous.quantity + record.ConsumedQuantity,
        cost: previous.cost + record.ContractedCost,
      });
    }
    for (const key of invalid) official.delete(key);
  }
  return {
    date,
    cycle,
    currency: cycle.currency,
    complete: calculation.complete,
    services: calculation.services.map((row) => {
      const fixed = row.key === '__base_fee';
      const meter = meters.get(row.key);
      const dailyComplete = daily?.complete === true;
      const period = row.pricing.allowancePeriod ?? 'cycle';
      const allowanceKnown = period === 'day' ? dailyComplete : calculation.complete;
      const included = row.pricing.includedQuantity;
      const used = period === 'day' ? row.todayQuantity : row.quantity;
      const costKnown =
        fixed ||
        calculation.complete ||
        (period === 'day' && dailyComplete && !row.pricing.fixedFee);
      const quantity = fixed || dailyComplete || meter ? row.todayQuantity : null;
      const cost = costKnown ? row.todayCost : null;
      const billed = official.get(row.key);
      const officialQuantity = billed?.quantity ?? null;
      const officialCost =
        fixed && bill?.serviceCosts?.__base_fee !== undefined
          ? date === cycle.start
            ? bill.serviceCosts.__base_fee
            : 0
          : (billed?.cost ?? null);
      return {
        key: row.key,
        service: row.service,
        name: row.name,
        unit: row.unit,
        pricing: row.pricing,
        quantity,
        cost,
        officialQuantity,
        officialCost,
        quantityDifference:
          quantity !== null && officialQuantity !== null ? quantity - officialQuantity : null,
        costDifference:
          cost !== null && officialCost !== null ? auditDifference(cost - officialCost) : null,
        overageQuantity: fixed
          ? 0
          : allowanceKnown
            ? Math.max(
                0,
                row.todayQuantity -
                  Math.max(0, included - (period === 'day' ? 0 : row.quantity - row.todayQuantity)),
              )
            : null,
        allowanceUsed: included > 0 && allowanceKnown ? used : null,
        allowanceRatio: included > 0 && allowanceKnown ? used / included : null,
      };
    }),
  };
}
