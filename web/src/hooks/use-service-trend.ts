import { useCallback, useEffect, useState } from 'react';
import { fetchServiceTrend } from '@/services/billing-api';
import type { Dashboard, ServiceTrend } from '@/types/billing';

type TrendState = {
  key: string;
  data: ServiceTrend | null;
  error: string | null;
};

export function useServiceTrend(
  service: string,
  meter: string | null,
  dashboard: Dashboard,
  enabled: boolean,
) {
  const [state, setState] = useState<TrendState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([dashboard.cycle?.id, service, meter]);

  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController();
    void fetchServiceTrend(service, meter, request.signal)
      .then((data) => {
        if (!request.signal.aborted) setState({ key, data, error: null });
      })
      .catch((failure: unknown) => {
        if (request.signal.aborted) return;
        const error =
          failure instanceof Error
            ? failure.name === 'TimeoutError'
              ? '趋势请求超时，请重试'
              : failure.message
            : '趋势加载失败';
        setState((previous) => ({
          key,
          data: previous?.key === key ? previous.data : null,
          error,
        }));
      });
    return () => request.abort();
  }, [service, meter, dashboard, enabled, key, attempt]);

  const refresh = useCallback(() => {
    setState((previous) => (previous?.key === key ? { ...previous, error: null } : null));
    setAttempt((value) => value + 1);
  }, [key]);
  // A render for a new selection happens before effect cleanup. Never expose the
  // previous selection's values, even for that first render or a failed request.
  const current = enabled && state?.key === key ? state : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: enabled && !current?.data && !current?.error,
    refresh,
  };
}
