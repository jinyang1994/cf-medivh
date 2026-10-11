import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ResourceUsageTrendContent } from '@/components/billing/resource-usage-trend';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ResourceUsageTrend, ResourceCostTrend } from '@/types/billing';
import { date } from '@/utils/format';

type Detail = { date: string; name: string; usage: ResourceUsageTrend; cost: ResourceCostTrend };
export function DailyMeterTrendPage() {
  const { date: selected = '' } = useParams();
  const [params] = useSearchParams();
  const service = params.get('service') ?? '';
  const meter = params.get('meter') ?? '';
  const key = JSON.stringify([selected, service, meter]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; data?: Detail; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(
      `/api/daily-meter-trend?${new URLSearchParams({ date: selected, service, meter })}`,
      {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        cache: 'no-store',
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('当日趋势加载失败');
        return (await response.json()) as Detail;
      })
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({ key, error: error instanceof Error ? error.message : '加载失败' });
      });
    return () => controller.abort();
  }, [selected, service, meter, key, attempt]);
  const current = state?.key === key ? state : undefined;
  const refresh = () => {
    setState(undefined);
    setAttempt((value) => value + 1);
  };
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">
        {date(selected)} · {service} · {current?.data?.name ?? '计费项趋势'}
      </h2>
      {(['usage', 'cost'] as const).map((metric) => (
        <Card key={metric}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>{metric === 'usage' ? '当日用量' : '当日累计费用'}</CardTitle>
              {current?.data && (
                <Badge variant="outline">
                  {metric === 'usage' ? current.data.usage.unit : current.data.cost.currency}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <ResourceUsageTrendContent
              data={current?.data?.[metric] ?? null}
              error={current?.error ?? null}
              loading={!current}
              refresh={refresh}
              resolution="ten-minute"
              metric={metric === 'cost' ? 'cost' : 'quantity'}
            />
          </CardContent>
        </Card>
      ))}
    </>
  );
}
