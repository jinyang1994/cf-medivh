import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dashboard } from '@/types/billing';
import { fetchDashboard } from '@/services/billing-api';

export function useDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    try {
      const result = await fetchDashboard(request.signal);
      if (request.signal.aborted) return;
      setData(result);
      setError(null);
    } catch (failure) {
      if (!request.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.name === 'TimeoutError'
              ? '账单请求超时，请重试'
              : failure.message
            : '账单加载失败',
        );
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Synchronize external API data; state updates happen after the awaited network response.
    // eslint-disable-next-line react/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 30_000);
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      controller.current?.abort();
    };
  }, [refresh]);

  const manualRefresh = useCallback(async () => {
    setLoading(true);
    await refresh();
  }, [refresh]);

  return { data, error, loading, refresh: manualRefresh };
}
