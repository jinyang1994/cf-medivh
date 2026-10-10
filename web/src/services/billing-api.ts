import type { Dashboard, ServiceTrend } from '@/types/billing';

export async function fetchDashboard(signal: AbortSignal): Promise<Dashboard> {
  const response = await fetch('/api/dashboard', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`账单加载失败（${response.status}）`);
  const result = (await response.json()) as Dashboard;
  if (!result.totals || !result.collection || !Array.isArray(result.history)) {
    throw new Error('账单响应格式错误');
  }
  return result;
}

export async function fetchServiceTrend(
  service: string,
  meter: string | null,
  signal: AbortSignal,
): Promise<ServiceTrend> {
  const query = new URLSearchParams({ service });
  if (meter !== null) query.set('meter', meter);
  const response = await fetch(`/api/service-trend?${query}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`趋势加载失败（${response.status}）`);
  const result = (await response.json()) as ServiceTrend;
  if (
    !result.cycle ||
    result.service !== service ||
    result.meterKey !== meter ||
    !Array.isArray(result.history) ||
    !Array.isArray(result.timeline)
  ) {
    throw new Error('趋势响应格式错误');
  }
  return result;
}
