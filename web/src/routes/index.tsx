import { SettingsPage } from '@/pages/settings/settings-page';
import { DailyMeterTrendPage } from '@/pages/billing/daily-meter-trend-page';
import { DailyServicesPage } from '@/pages/billing/daily-services-page';
import { Navigate, Route, Routes } from 'react-router';
import { BILLING_PATHS } from '@/constants/billing-navigation';
import { BillingLayout } from '@/layouts/billing-layout';
import { OverviewPage } from '@/pages/billing/overview-page';
import { ServicesPage } from '@/pages/billing/services-page';
import { ServiceTrendPage } from '@/pages/billing/service-trend-page';
import { HistoryPage } from '@/pages/billing/history-page';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<BillingLayout />}>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path={BILLING_PATHS.overview} element={<OverviewPage />} />
        <Route path={BILLING_PATHS.services} element={<ServicesPage />} />
        <Route path={BILLING_PATHS.serviceTrend} element={<ServiceTrendPage />} />
        <Route path={BILLING_PATHS.history} element={<HistoryPage />} />
        <Route path="/billing/history/:date/trend" element={<DailyMeterTrendPage />} />
        <Route path={BILLING_PATHS.dailyServices} element={<DailyServicesPage />} />
        <Route path="*" element={<Navigate to={BILLING_PATHS.overview} replace />} />
      </Route>
    </Routes>
  );
}
