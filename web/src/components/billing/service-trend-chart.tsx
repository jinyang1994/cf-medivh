import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis, type DotItemDotProps } from 'recharts';
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
import type { ServiceTrend, ServiceTrendPoint } from '@/types/billing';
import { money } from '@/utils/format';

type Resolution = 'ten-minute' | 'daily';
type Metric = 'cost' | 'quantity';
type PlotPoint = ServiceTrendPoint & { time: number };
type SeriesKey = 'localCost' | 'officialCost' | 'quantity';

const costConfig = {
  localCost: { label: '本地累计费用', color: 'var(--chart-2)' },
  officialCost: { label: '官方累计费用', color: 'var(--chart-5)' },
} satisfies ChartConfig;
const quantityConfig = {
  quantity: { label: '累计用量', color: 'var(--chart-2)' },
} satisfies ChartConfig;

function preciseQuantity(value: number) {
  if (value !== 0 && Math.abs(value) < 1e-10) return value.toExponential(6);
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 12 }).format(value);
}

function utcLabel(time: number, resolution: Resolution, sameDay: boolean) {
  const iso = new Date(time).toISOString();
  const date = iso.slice(5, 10).replace('-', '/');
  if (resolution === 'daily') return date;
  return sameDay ? iso.slice(11, 16) : `${date} ${iso.slice(11, 16)}`;
}

export function ServiceTrendChart({ data }: { data: ServiceTrend }) {
  const [resolution, setResolution] = useState<Resolution>('ten-minute');
  const [metric, setMetric] = useState<Metric>(data.meterKey === null ? 'cost' : 'quantity');
  const chartConfig: ChartConfig = metric === 'quantity' ? quantityConfig : costConfig;
  const series: SeriesKey[] =
    metric === 'quantity'
      ? ['quantity']
      : resolution === 'daily'
        ? ['localCost', 'officialCost']
        : ['localCost'];
  const points = useMemo<PlotPoint[]>(() => {
    let source = resolution === 'daily' ? data.history : data.timeline;
    if (resolution === 'ten-minute') {
      const first = source.findIndex(
        (item) => item.observedAt !== null || item.localCost !== null || item.quantity !== null,
      );
      source = first < 0 ? [] : source.slice(first);
    }
    return source.map((item) => ({ ...item, time: Date.parse(item.timestamp) }));
  }, [data, resolution]);
  const values = points.flatMap((point) =>
    series.flatMap((key) => {
      const value = point[key];
      return value !== null && Number.isFinite(value) ? [value] : [];
    }),
  );
  const min = values.reduce((result, value) => Math.min(result, value), Infinity);
  const max = values.reduce((result, value) => Math.max(result, value), -Infinity);
  const spread = max - min;
  // Padding on both sides keeps zero-cost and constant-usage lines visible.
  const padding = Number.isFinite(min)
    ? (spread > 0 ? spread : Math.abs(max) || (metric === 'cost' ? 0.01 : 1)) * 0.12
    : 1;
  const domain: [number, number] = Number.isFinite(min) ? [min - padding, max + padding] : [0, 1];
  const step = (domain[1] - domain[0]) / 5;
  const decimals = Math.min(
    12,
    Math.max(metric === 'cost' ? 2 : 0, 1 - Math.floor(Math.log10(step))),
  );
  const axisFormat = new Intl.NumberFormat('zh-CN', {
    ...(metric === 'cost' ? { style: 'currency', currency: data.currency } : {}),
    maximumFractionDigits: decimals,
    minimumFractionDigits: metric === 'cost' ? decimals : 0,
  });
  const formatAxis = (value: number) =>
    value !== 0 && Math.abs(value) < 1e-10
      ? `${metric === 'cost' ? `${data.currency} ` : ''}${value.toExponential(2)}`
      : axisFormat.format(value);
  const first = points.at(0)?.time ?? 0;
  const last = points.at(-1)?.time ?? 0;
  const sameDay =
    new Date(first).toISOString().slice(0, 10) === new Date(last).toISOString().slice(0, 10);
  const timeDomain: [number, number] =
    first === last ? [first - 300_000, last + 300_000] : [first, last];
  const ticks =
    points.length <= 6
      ? points.map((item) => item.time)
      : Array.from(
          { length: 6 },
          (_, index) => points[Math.round((index * (points.length - 1)) / 5)].time,
        );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{metric === 'quantity' ? '周期累计用量' : '周期累计费用'}</CardTitle>
          <Badge variant="outline">{metric === 'quantity' ? data.unit : data.currency}</Badge>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="图表粒度" className="flex gap-1">
            {(['ten-minute', 'daily'] as const).map((item) => (
              <Button
                key={item}
                size="sm"
                variant={resolution === item ? 'secondary' : 'ghost'}
                aria-pressed={resolution === item}
                onClick={() => setResolution(item)}
              >
                {item === 'ten-minute' ? '10 分钟' : '每日'}
              </Button>
            ))}
          </div>
          {data.meterKey !== null && (
            <div role="group" aria-label="趋势指标" className="flex gap-1">
              {(['cost', 'quantity'] as const).map((item) => (
                <Button
                  key={item}
                  size="sm"
                  variant={metric === item ? 'secondary' : 'ghost'}
                  aria-pressed={metric === item}
                  onClick={() => setMetric(item)}
                >
                  {item === 'cost' ? '累计费用' : '累计用量'}
                </Button>
              ))}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {values.length > 0 ? (
          <ChartContainer config={chartConfig} className="h-80 w-full sm:h-96">
            <LineChart
              key={`${resolution}-${metric}`}
              accessibilityLayer
              data={points}
              margin={{ left: 4, right: 16, top: 12, bottom: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="time"
                type="number"
                scale="time"
                domain={timeDomain}
                ticks={ticks}
                axisLine={false}
                tickLine={false}
                tickMargin={12}
                minTickGap={32}
                tickFormatter={(value: number) => utcLabel(value, resolution, sameDay)}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tickMargin={8}
                width={metric === 'cost' ? 108 : 96}
                domain={domain}
                tickFormatter={formatAxis}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_label, payload) => {
                      const point = payload[0]?.payload as PlotPoint | undefined;
                      if (!point) return null;
                      return (
                        <>
                          <div>
                            {point.timestamp
                              .slice(0, resolution === 'daily' ? 10 : 16)
                              .replace('T', ' ')}{' '}
                            UTC
                          </div>
                          {resolution === 'ten-minute' && point.observedAt && (
                            <div className="mt-1 font-normal text-muted-foreground">
                              采集 {point.observedAt.slice(11, 19)} UTC
                            </div>
                          )}
                        </>
                      );
                    }}
                    formatter={(value, name) => (
                      <div className="flex min-w-44 justify-between gap-4">
                        <span className="text-muted-foreground">
                          {chartConfig[String(name)]?.label ?? String(name)}
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {metric === 'cost'
                            ? money(Number(value), data.currency, 'rate')
                            : `${preciseQuantity(Number(value))} ${data.unit}`}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {series.map((key) => (
                <Line
                  key={key}
                  dataKey={key}
                  type="linear"
                  stroke={`var(--color-${key})`}
                  strokeWidth={2}
                  strokeDasharray={
                    key === 'localCost' && resolution === 'daily' ? '5 4' : undefined
                  }
                  isAnimationActive={false}
                  connectNulls={false}
                  dot={({ cx, cy, index }: DotItemDotProps) =>
                    points[index]?.[key] != null &&
                    (points.length <= 288 ||
                      (points[index - 1]?.[key] == null && points[index + 1]?.[key] == null)) ? (
                      <circle key={index} cx={cx} cy={cy} r={2.5} fill={`var(--color-${key})`} />
                    ) : null
                  }
                  activeDot={{ r: 4 }}
                />
              ))}
            </LineChart>
          </ChartContainer>
        ) : (
          <div className="flex h-80 items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {resolution === 'ten-minute'
              ? '暂无完整的 10 分钟采集记录，可切换到每日查看历史数据。'
              : '暂无可用的每日趋势，等待用量采集或补全。'}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
