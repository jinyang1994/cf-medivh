import { ArrowLeft, AlertCircle } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { ServiceTrendChart } from '@/components/billing/service-trend-chart';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { BILLING_PATHS } from '@/constants/billing-navigation';
import { useBillingDashboard } from '@/hooks/use-billing-dashboard';
import { useServiceTrend } from '@/hooks/use-service-trend';

export function ServiceTrendPage() {
  const dashboard = useBillingDashboard();
  const [params, setParams] = useSearchParams();
  const service = params.get('service') ?? '';
  const meter = params.get('meter');
  const meters = dashboard.services.filter((item) => item.service === service);
  const selected = meter === null ? null : meters.find((item) => item.key === meter);
  const valid = meters.length > 0 && (meter === null || !!selected);
  const { data, error, loading, refresh } = useServiceTrend(service, meter, dashboard, valid);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {valid ? `${service} · ${selected?.name ?? '服务费用'}` : '服务趋势'}
          </h2>
          {valid && (
            <p className="mt-2 text-sm text-muted-foreground">
              查看当前账期的累计变化 · 时间均为 UTC
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to={BILLING_PATHS.services}>
            <ArrowLeft aria-hidden="true" />
            返回服务明细
          </Link>
        </Button>
      </div>
      {!valid ? (
        <Card>
          <CardContent>
            <p role="alert" className="py-10 text-center text-sm text-muted-foreground">
              {service
                ? '当前账期没有这个服务或计费项，请从服务明细重新选择。'
                : '请从服务明细选择要查看的服务。'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="trend-meter" className="text-sm font-medium">
              计费项
            </label>
            <select
              id="trend-meter"
              value={meter ?? ''}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                if (event.target.value) next.set('meter', event.target.value);
                else next.delete('meter');
                setParams(next);
              }}
              className="h-9 max-w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="">全部计费项</option>
              {meters.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name} · {item.unit}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>{data ? '趋势刷新失败，显示上次数据' : '无法加载趋势'}</AlertTitle>
              <AlertDescription>
                <div className="flex flex-wrap items-center gap-3">
                  <span>{error}</span>
                  <Button size="sm" variant="outline" onClick={refresh}>
                    重试
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {loading && (
            <div role="status" aria-label="正在加载服务趋势">
              <Skeleton className="h-96 w-full" />
              <p className="mt-3 text-sm text-muted-foreground">正在加载服务趋势…</p>
            </div>
          )}
          {data && <ServiceTrendChart key={JSON.stringify([service, meter])} data={data} />}
          <p className="text-xs leading-relaxed text-muted-foreground">
            本地费用按已采集用量、单价和免费额度计算。每日图按现有用量重算；10
            分钟图使用当时已知的采集记录，历史补采不会生成过去的采样点。缺失或不完整的数据保留断线；免费额度内费用为
            0，可切换到具体计费项查看用量变化。
          </p>
        </>
      )}
    </>
  );
}
