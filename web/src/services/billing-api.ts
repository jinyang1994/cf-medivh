import type { Dashboard } from '@/types/billing';

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
