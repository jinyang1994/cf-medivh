import { ArrowLeft } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { ServiceTrendPanel } from '@/components/billing/service-trend-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
              查看具体资源用量与当前账期累计变化 · 时间均为 UTC
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
          <ServiceTrendPanel
            key={JSON.stringify([dashboard.cycle?.id, dashboard.today, service, meter])}
            service={service}
            meter={meter}
            summary={selected ?? null}
            data={data}
            error={error}
            loading={loading}
            refresh={refresh}
          />
        </>
      )}
    </>
  );
}
