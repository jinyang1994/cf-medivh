import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBillingDashboard } from '@/hooks/use-billing-dashboard';
import { useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { ResourceUsageTrendContent } from '@/components/billing/resource-usage-trend';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ResourceUsageTrend, ResourceCostTrend } from '@/types/billing';
import { date } from '@/utils/format';

type Detail = { date: string; name: string; usage: ResourceUsageTrend; cost: ResourceCostTrend };
export function DailyMeterTrendPage() {
  const navigate = useNavigate();
  const dashboard = useBillingDashboard();
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
  const selectedTime = Date.parse(selected);
  const validDate =
    Number.isFinite(selectedTime) && new Date(selectedTime).toISOString().slice(0, 10) === selected;
  const adjacent = (offset: number) =>
    validDate ? new Date(selectedTime + offset * 86_400_000).toISOString().slice(0, 10) : '';
  const previous = adjacent(-1);
  const next = adjacent(1);
  const available = (day: string) =>
    !!dashboard.cycle &&
    !!day &&
    day >= dashboard.cycle.start &&
    day < dashboard.cycle.end &&
    day <= dashboard.today;
  const navigateDay = (day: string) =>
    void navigate(`/billing/history/${day}/trend?${new URLSearchParams({ service, meter })}`);
  return (
    <>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[1fr_minmax(0,auto)_1fr] sm:gap-4">
        <Button
          className="justify-self-start"
          variant="ghost"
          size="sm"
          disabled={!available(previous)}
          onClick={() => navigateDay(previous)}
        >
          <ChevronLeft />
          前一天
        </Button>
        <h2 className="text-center text-base font-semibold tracking-tight sm:text-2xl">
          <NavLink
            to={`/billing/history/${selected}`}
            className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`返回 ${date(selected)} 服务明细`}
          >
            {date(selected)}
          </NavLink>
          {' · '}
          {service} · {current?.data?.name ?? '计费项趋势'}
        </h2>
        <Button
          className="justify-self-end"
          variant="ghost"
          size="sm"
          disabled={!available(next)}
          onClick={() => navigateDay(next)}
        >
          后一天
          <ChevronRight />
        </Button>
      </div>
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
