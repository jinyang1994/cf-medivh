import { useCallback, useEffect, useState } from 'react';
import { fetchResourceCostTrend } from '@/services/billing-api';
import type { ResourceCostTrend } from '@/types/billing';

type ResourceCostTrendState = {
  selectionKey: string;
  requestKey: string;
  data: ResourceCostTrend | null;
  error: string | null;
};

export function useResourceCostTrend(
  service: string,
  meter: string | null,
  resolution: 'ten-minute' | 'daily',
  enabled = true,
) {
  const [state, setState] = useState<ResourceCostTrendState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const selectionKey = JSON.stringify([service, meter, resolution]);
  const requestKey = JSON.stringify([selectionKey, attempt]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setAttempt((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, [enabled, selectionKey]);

  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController();
    void fetchResourceCostTrend(service, meter, resolution, request.signal)
      .then((data) => {
        if (!request.signal.aborted) {
          setState({ selectionKey, requestKey, data, error: null });
        }
      })
      .catch((failure: unknown) => {
        if (request.signal.aborted) return;
        const error =
          failure instanceof Error
            ? failure.name === 'TimeoutError'
              ? '资源费用请求超时，请重试'
              : failure.message
            : '资源费用加载失败';
        setState((previous) => ({
          selectionKey,
          requestKey,
          data: previous?.selectionKey === selectionKey ? previous.data : null,
          error,
        }));
      });
    return () => request.abort();
  }, [service, meter, resolution, selectionKey, requestKey, enabled]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  const current = enabled && state?.selectionKey === selectionKey ? state : null;
  return {
    data: current?.data ?? null,
    error: current?.requestKey === requestKey ? current.error : null,
    loading: enabled && current?.requestKey !== requestKey,
    refresh,
  };
}
