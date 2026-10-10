import { useState } from 'react';
import { ResourceUsageTrendContent } from '@/components/billing/resource-usage-trend';
import { ServiceTrendPlot } from '@/components/billing/service-trend-chart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useResourceTrend } from '@/hooks/use-resource-trend';
import { useResourceCostTrend } from '@/hooks/use-resource-cost-trend';
import type { ServiceSummary, ServiceTrend } from '@/types/billing';

type Resolution = 'ten-minute' | 'daily';

function TrendChartHeader({
  title,
  unit,
  resolution,
  onResolutionChange,
}: {
  title: string;
  unit: string | null | undefined;
  resolution: Resolution;
  onResolutionChange: (resolution: Resolution) => void;
}) {
  return (
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CardTitle>{title}</CardTitle>
          {unit && <Badge variant="outline">{unit}</Badge>}
        </div>
        <div role="group" aria-label={`${title}时间范围`} className="flex gap-1">
          {(['ten-minute', 'daily'] as const).map((item) => (
            <Button
              key={item}
              size="sm"
              variant={resolution === item ? 'secondary' : 'ghost'}
              aria-pressed={resolution === item}
              onClick={() => onResolutionChange(item)}
            >
              {item === 'ten-minute' ? '近 48 小时' : '本账期 · 每日'}
            </Button>
          ))}
        </div>
      </div>
    </CardHeader>
  );
}

export function ServiceTrendPanel({
  service,
  meter,
  summary,
  data,
  error,
  loading,
  refresh,
}: {
  service: string;
  meter: string | null;
  summary: ServiceSummary | null;
  data: ServiceTrend | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}) {
  const [usageResolution, setUsageResolution] = useState<Resolution>('ten-minute');
  const [costResolution, setCostResolution] = useState<Resolution>('ten-minute');
  const resource = useResourceTrend(service, meter ?? '', usageResolution, meter !== null);
  const cost = useResourceCostTrend(service, meter, costResolution);
  const fallback =
    resource.data?.unavailableReason ?? (resource.error && !resource.data ? resource.error : null);
  return (
    <>
      {meter !== null && (
        <Card role="region" aria-label="用量图表">
          <TrendChartHeader
            title="用量"
            unit={resource.data?.unit ?? summary?.unit ?? data?.unit}
            resolution={usageResolution}
            onResolutionChange={setUsageResolution}
          />
          <CardContent className="space-y-4">
            {fallback ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {fallback} 以下显示已采集的周期累计用量。
                </p>
                {error && (
                  <div
                    role="alert"
                    className="rounded-md border border-destructive/30 px-4 py-3 text-sm text-destructive"
                  >
                    {data ? `刷新失败，显示上次数据：${error}` : error}
                    <Button size="sm" variant="outline" onClick={refresh} className="ml-3">
                      重试
                    </Button>
                  </div>
                )}
                {loading && !data && (
                  <div role="status" aria-label="正在加载服务趋势">
                    <Skeleton className="h-80 w-full sm:h-96" />
                  </div>
                )}
                {data && (
                  <ServiceTrendPlot data={data} resolution={usageResolution} metric="quantity" />
                )}
              </>
            ) : (
              <ResourceUsageTrendContent {...resource} resolution={usageResolution} />
            )}
          </CardContent>
        </Card>
      )}
      <Card role="region" aria-label="费用图表">
        <TrendChartHeader
          title="费用"
          unit={cost.data?.currency ?? data?.currency}
          resolution={costResolution}
          onResolutionChange={setCostResolution}
        />
        <CardContent>
          <ResourceUsageTrendContent {...cost} metric="cost" resolution={costResolution} />
        </CardContent>
      </Card>
    </>
  );
}
