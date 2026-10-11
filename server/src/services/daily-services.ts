import type { Store } from '@/repositories/billing-store';
import { calculateDaily } from '@/services/calculation';
import type { DailyServices } from '@/types';
import { cycleContains, utcDate, validDate } from '@/utils/dates';

/** Read stored daily usage and its historical prices; never collect on navigation. */
export function dailyServices(store: Store, date: string, now = new Date()): DailyServices | null {
  const cycle = store.activeCycle();
  if (!cycle || !validDate(date) || !cycleContains(cycle, date) || date > utcDate(now)) return null;
  const usage = store.usageForCalculation(cycle.id, cycle.start, date, now.toISOString());
  const daily = usage.get(date)?.report;
  const meters = new Map(daily?.meters.map((item) => [item.key, item]));
  const { calculation } = calculateDaily(cycle, usage, date);
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
      return {
        key: row.key,
        service: row.service,
        name: row.name,
        unit: row.unit,
        pricing: row.pricing,
        quantity: fixed || dailyComplete || meter ? row.todayQuantity : null,
        cost: costKnown ? row.todayCost : null,
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
