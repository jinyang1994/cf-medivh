export const BILLING_PATHS = {
  overview: '/billing',
  services: '/billing/services',
  history: '/billing/history',
} as const;

export const BILLING_NAVIGATION = [
  [BILLING_PATHS.overview, '当前账单'],
  [BILLING_PATHS.services, '服务明细'],
  [BILLING_PATHS.history, '每日核对'],
] as const;
