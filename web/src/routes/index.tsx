import { Navigate, Route, Routes } from 'react-router';
import { BILLING_PATHS } from '@/constants/billing-navigation';
import { BillingLayout } from '@/layouts/billing-layout';
import { OverviewPage } from '@/pages/billing/overview-page';
import { ServicesPage } from '@/pages/billing/services-page';
import { HistoryPage } from '@/pages/billing/history-page';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<BillingLayout />}>
        <Route path={BILLING_PATHS.overview} element={<OverviewPage />} />
        <Route path={BILLING_PATHS.services} element={<ServicesPage />} />
        <Route path={BILLING_PATHS.history} element={<HistoryPage />} />
        <Route path="*" element={<Navigate to={BILLING_PATHS.overview} replace />} />
      </Route>
    </Routes>
  );
}
