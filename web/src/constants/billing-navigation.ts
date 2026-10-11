export const BILLING_PATHS = {
  overview: '/billing',
  services: '/billing/services',
  serviceTrend: '/billing/services/trend',
  history: '/billing/history',
  dailyServices: '/billing/history/:date',
} as const;

export function serviceTrendPath(service: string, meter?: string) {
  const query = new URLSearchParams({ service });
  if (meter) query.set('meter', meter);
  return `${BILLING_PATHS.serviceTrend}?${query}`;
}

export const BILLING_NAVIGATION = [
  [BILLING_PATHS.overview, '当前账单'],
  [BILLING_PATHS.services, '服务明细'],
  [BILLING_PATHS.history, '每日核对'],
] as const;
