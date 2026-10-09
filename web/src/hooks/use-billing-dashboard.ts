import { useOutletContext } from 'react-router';
import type { BillingDashboardContext } from '@/types/billing';

export function useBillingDashboard() {
  return useOutletContext<BillingDashboardContext>().data;
}
