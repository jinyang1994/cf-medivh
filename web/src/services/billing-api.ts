import type {
  Dashboard,
  ResourceCostTrend,
  ResourceUsageTrend,
  ServiceTrend,
} from '@/types/billing';

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

export async function fetchResourceTrend(
  service: string,
  meter: string,
  resolution: 'ten-minute' | 'daily',
  signal: AbortSignal,
): Promise<ResourceUsageTrend> {
  const query = new URLSearchParams({ service, meter, resolution });
  const response = await fetch(`/api/resource-trend?${query}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`资源用量加载失败（${response.status}）`);
  const result = (await response.json()) as ResourceUsageTrend;
  if (
    result.service !== service ||
    result.meterKey !== meter ||
    !['ten-minute', 'hourly', 'daily'].includes(result.resolution) ||
    !Array.isArray(result.resources) ||
    !Array.isArray(result.points) ||
    !Array.isArray(result.warnings)
  ) {
    throw new Error('资源用量响应格式错误');
  }
  return result;
}

export async function fetchResourceCostTrend(
  service: string,
  meter: string | null,
  resolution: 'ten-minute' | 'daily',
  signal: AbortSignal,
): Promise<ResourceCostTrend> {
  const query = new URLSearchParams({ service, resolution });
  if (meter !== null) query.set('meter', meter);
  const response = await fetch(`/api/resource-cost-trend?${query}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`资源费用加载失败（${response.status}）`);
  const result = (await response.json()) as ResourceCostTrend;
  if (
    result.service !== service ||
    result.meterKey !== meter ||
    result.resolution !== resolution ||
    !result.currency ||
    !Array.isArray(result.resources) ||
    !Array.isArray(result.points) ||
    !Array.isArray(result.warnings)
  )
    throw new Error('资源费用响应格式错误');
  return result;
}
