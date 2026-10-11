import { useSearchParams } from 'react-router';
import { ServiceTrendPanel } from '@/components/billing/service-trend-panel';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
        {valid && (
          <div className="flex max-w-full items-center gap-3">
            <label htmlFor="trend-meter" className="shrink-0 text-sm font-medium">
              计费项
            </label>
            <Select
              value={meter ?? '__all_meters__'}
              onValueChange={(value) => {
                const next = new URLSearchParams(params);
                if (value === '__all_meters__') next.delete('meter');
                else next.set('meter', value);
                setParams(next);
              }}
            >
              <SelectTrigger id="trend-meter" className="min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="__all_meters__">全部计费项</SelectItem>
                  {meters.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {item.name} · {item.unit}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        )}
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
      )}
    </>
  );
}
