import { displayText } from '@/utils/display-text';
import { Trans, useLingui } from '@lingui/react/macro';
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
  const { t } = useLingui();

  return (
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CardTitle>{title}</CardTitle>
          {unit && <Badge variant="outline">{displayText(unit)}</Badge>}
        </div>
        <div role="group" aria-label={t`${{ value0: title }}时间范围`} className="flex gap-1">
          {(['ten-minute', 'daily'] as const).map((item) => (
            <Button
              key={item}
              size="sm"
              variant={resolution === item ? 'secondary' : 'ghost'}
              aria-pressed={resolution === item}
              onClick={() => onResolutionChange(item)}
            >
              {item === 'ten-minute' ? t`近 48 小时` : t`本账期 · 每日`}
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
  const { t } = useLingui();

  const [usageResolution, setUsageResolution] = useState<Resolution>('ten-minute');
  const [costResolution, setCostResolution] = useState<Resolution>('ten-minute');
  const resource = useResourceTrend(service, meter ?? '', usageResolution, meter !== null);
  const cost = useResourceCostTrend(service, meter, costResolution);
  const fallback =
    resource.data?.unavailableReason ?? (resource.error && !resource.data ? resource.error : null);
  return (
    <>
      {meter !== null && (
        <Card role="region" aria-label={t`用量图表`}>
          <TrendChartHeader
            title={t`用量`}
            unit={resource.data?.unit ?? summary?.unit ?? data?.unit}
            resolution={usageResolution}
            onResolutionChange={setUsageResolution}
          />
          <CardContent className="space-y-4">
            {fallback ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {displayText(fallback)} <Trans>以下显示已采集的周期累计用量。</Trans>
                </p>
                {error && (
                  <div
                    role="alert"
                    className="rounded-md border border-destructive/30 px-4 py-3 text-sm text-destructive"
                  >
                    {data
                      ? t`刷新失败，显示上次数据：${{ value0: displayText(error) }}`
                      : displayText(error)}
                    <Button size="sm" variant="outline" onClick={refresh} className="ml-3">
                      <Trans>重试</Trans>
                    </Button>
                  </div>
                )}
                {loading && !data && (
                  <div role="status" aria-label={t`正在加载服务趋势`}>
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
      <Card role="region" aria-label={t`费用图表`}>
        <TrendChartHeader
          title={t`费用`}
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
