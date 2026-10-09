import type { ServiceSummary } from '@/types/billing';

export function serviceTotals(services: ServiceSummary[]) {
  const groups = new Map<
    string,
    { service: string; currentCost: number | null; todayCost: number }
  >();
  for (const item of services) {
    const current = groups.get(item.service) ?? {
      service: item.service,
      currentCost: 0,
      todayCost: 0,
    };
    current.currentCost =
      current.currentCost === null || item.currentCost == null
        ? null
        : current.currentCost + item.currentCost;
    current.todayCost += item.todayCost;
    groups.set(item.service, current);
  }
  return [...groups.values()].sort((a, b) => (b.currentCost ?? -1) - (a.currentCost ?? -1));
}
