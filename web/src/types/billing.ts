import type { Dashboard } from '@server/types';

export type {
  Dashboard,
  Reconciliation,
  ServiceSummary,
  ServiceTrend,
  ServiceTrendPoint,
} from '@server/types';

export type BillingDashboardContext = { data: Dashboard };
