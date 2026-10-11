import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import type { Dashboard } from '@/types/billing';
import { money } from '@/utils/format';

type Resolution = 'ten-minute' | 'daily';
type PlotPoint = {
  time: number;
  observedAt?: string | null;
  source?: 'reconstructed' | 'collected';
  currentTotal?: number | null;
  officialTotal?: number | null;
  localTotal: number | null;
};

function utcLabel(value: number, resolution: Resolution, sameDay = false) {
  const iso = new Date(value).toISOString();
  if (resolution === 'daily') return iso.slice(5, 10).replace('-', '/');
  return sameDay ? iso.slice(11, 16) : `${iso.slice(5, 10).replace('-', '/')} ${iso.slice(11, 16)}`;
}

export function BillingChart({
  data,
  defaultResolution = 'ten-minute',
}: {
  data: Dashboard;
  defaultResolution?: Resolution;
}) {
  const { i18n, t } = useLingui();

  const dailyChartConfig = {
    officialTotal: {
      label: t`官方累计`,
      color: 'var(--chart-5)',
    },
    localTotal: { label: t`本地累计`, color: 'var(--chart-2)' },
  } satisfies ChartConfig;

  const tenMinuteChartConfig = {
    currentTotal: {
      label: t`官方账单 + 预测`,
      color: 'var(--chart-5)',
    },
    localTotal: {
      label: t`本地数据 + 预测`,
      color: 'var(--chart-2)',
    },
  } satisfies ChartConfig;

  const [resolution, setResolution] = useState<Resolution>(defaultResolution);
  const chartConfig: ChartConfig =
    resolution === 'ten-minute' ? tenMinuteChartConfig : dailyChartConfig;
  const points = useMemo<PlotPoint[]>(() => {
    if (resolution === 'daily') {
      return data.history.map((item) => ({
        time: Date.parse(`${item.date}T00:00:00Z`),
        officialTotal: item.officialTotal,
        localTotal: item.localTotal,
      }));
    }
    const timeline = data.timeline ?? [];
    // Earlier daily backfills are not real intraday observations. Keep every actual
    // slot and every internal missing slot; never resample or interpolate values.
    const firstObserved = timeline.findIndex(
      (item) => item.observedAt !== null || item.currentTotal !== null || item.localTotal !== null,
    );
    if (firstObserved < 0) return [];
    return timeline.slice(firstObserved).map((item) => ({
      time: Date.parse(item.timestamp),
      observedAt: item.observedAt,
      source: item.source,
      currentTotal: item.currentTotal,
      localTotal: item.localTotal,
    }));
  }, [data.history, data.timeline, resolution]);
  const currentKey = resolution === 'ten-minute' ? 'currentTotal' : 'officialTotal';
  const costRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const item of points) {
      for (const value of [item.localTotal, item[currentKey]]) {
        if (value != null && Number.isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }
    if (!Number.isFinite(min)) return { domain: [0, 1] as [number, number], decimals: 4 };
    const padding = Math.max((max - min) * 0.12, 0.00005);
    const decimals =
      max === min ? 4 : Math.max(4, Math.min(8, Math.ceil(-Math.log10(max - min)) + 1));
    return { domain: [min - padding, max + padding] as [number, number], decimals };
  }, [points, currentKey]);
  const axisMoney = useMemo(
    () =>
      new Intl.NumberFormat(i18n.locale, {
        style: 'currency',
        currency: data.currency,
        minimumFractionDigits: costRange.decimals,
        maximumFractionDigits: costRange.decimals,
      }),
    [data.currency, costRange.decimals, i18n.locale],
  );
  const ticks = useMemo(() => {
    if (resolution === 'daily') return undefined;
    if (points.length <= 6) return points.map((item) => item.time);
    return Array.from(
      { length: 6 },
      (_, index) => points[Math.round((index * (points.length - 1)) / 5)].time,
    );
  }, [points, resolution]);
  const hasValues = points.some((item) => item.localTotal !== null || item[currentKey] != null);
  const firstTime = points.at(0)?.time ?? 0;
  const lastTime = points.at(-1)?.time ?? 0;
  const sameDay =
    new Date(firstTime).toISOString().slice(0, 10) ===
    new Date(lastTime).toISOString().slice(0, 10);
  const timeDomain: [number, number] =
    firstTime === lastTime ? [firstTime - 300_000, lastTime + 300_000] : [firstTime, lastTime];
  // Large timelines retain every point in their paths and hover targets, without
  // creating thousands of additional SVG circles. Sparse series show all dots.
  const dots = points.length <= 288;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CardTitle>
              <Trans>周期累计费用</Trans>
            </CardTitle>
            <Badge variant="outline">{data.currency}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <div role="group" aria-label={t`图表粒度`} className="flex gap-1">
              <Button
                size="sm"
                variant={resolution === 'ten-minute' ? 'secondary' : 'ghost'}
                aria-pressed={resolution === 'ten-minute'}
                onClick={() => setResolution('ten-minute')}
              >
                <Trans>10 分钟</Trans>
              </Button>
              <Button
                size="sm"
                variant={resolution === 'daily' ? 'secondary' : 'ghost'}
                aria-pressed={resolution === 'daily'}
                onClick={() => setResolution('daily')}
              >
                <Trans>每日</Trans>
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {hasValues ? (
          <ChartContainer config={chartConfig} className="h-80 w-full">
            <LineChart
              key={resolution}
              accessibilityLayer
              data={points}
              margin={{ left: 8, right: 16, top: 12, bottom: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="time"
                type="number"
                scale="time"
                domain={timeDomain}
                axisLine={false}
                tickLine={false}
                tickMargin={12}
                minTickGap={32}
                ticks={ticks}
                tickCount={6}
                tickFormatter={(value: number) => utcLabel(value, resolution, sameDay)}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tickMargin={8}
                width={resolution === 'ten-minute' ? 96 : 76}
                domain={resolution === 'ten-minute' ? costRange.domain : [0, 'auto']}
                tickFormatter={(value: number) =>
                  resolution === 'ten-minute'
                    ? axisMoney.format(value)
                    : money(value, data.currency)
                }
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_label, payload) => {
                      const point = payload[0]?.payload as PlotPoint | undefined;
                      const time = Number(point?.time);
                      const observed = point?.observedAt ? Date.parse(point.observedAt) : NaN;
                      return (
                        <>
                          <div>
                            {Number.isFinite(time)
                              ? `${new Date(time)
                                  .toISOString()
                                  .slice(0, resolution === 'ten-minute' ? 16 : 10)
                                  .replace('T', ' ')
                                  .replaceAll('-', '/')} UTC`
                              : 'UTC'}
                          </div>
                          {resolution === 'ten-minute' && Number.isFinite(observed) && (
                            <div className="mt-1 font-normal text-muted-foreground">
                              <Trans>采集</Trans>
                              {new Date(observed).toISOString().slice(11, 19)} UTC
                              {point?.source === 'reconstructed' ? t` · 历史采集恢复` : ''}
                            </div>
                          )}
                        </>
                      );
                    }}
                    formatter={(value, name) => (
                      <div className="flex min-w-44 justify-between gap-4">
                        <span className="text-muted-foreground">
                          {chartConfig[name as keyof typeof chartConfig]?.label ?? String(name)}
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {money(Number(value), data.currency, 'rate')}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Line
                isAnimationActive={false}
                type="linear"
                dataKey="localTotal"
                stroke="var(--color-localTotal)"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={dots ? { r: 2 } : false}
                activeDot={{ r: 4 }}
                connectNulls={false}
              />
              <Line
                isAnimationActive={false}
                type="linear"
                dataKey={currentKey}
                stroke={`var(--color-${currentKey})`}
                strokeWidth={2}
                dot={dots ? { r: 3 } : false}
                activeDot={{ r: 4 }}
                connectNulls={false}
              />
            </LineChart>
          </ChartContainer>
        ) : (
          <div className="flex h-80 items-center justify-center text-sm text-muted-foreground">
            {resolution === 'ten-minute' ? t`暂无可用的 10 分钟费用数据` : t`等待本周期账单数据`}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
