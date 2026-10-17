import { displayText } from '@/utils/display-text';
import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis, type DotItemDotProps } from 'recharts';
import {
  ChartContainer,
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

function preciseQuantity(value: number) {
  if (value !== 0 && Math.abs(value) < 1e-10) return value.toExponential(6);
  return new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 12 }).format(value);
}

function utcLabel(time: number, resolution: Resolution, sameDay: boolean) {
  const iso = new Date(time).toISOString();
  const date = iso.slice(5, 10).replace('-', '/');
  if (resolution === 'daily') return date;
  return sameDay ? iso.slice(11, 16) : `${date} ${iso.slice(11, 16)}`;
}

export function ServiceTrendPlot({
  data,
  resolution,
  metric = 'cost',
}: {
  data: ServiceTrend;
  resolution: Resolution;
  metric?: Metric;
}) {
  const { i18n, t } = useLingui();

  const costConfig = {
    localCost: {
      label: t`本地累计费用`,
      color: 'var(--chart-2)',
    },
    officialCost: {
      label: t`官方累计费用`,
      color: 'var(--chart-5)',
    },
  } satisfies ChartConfig;
  const quantityConfig = {
    quantity: { label: t`累计用量`, color: 'var(--chart-2)' },
  } satisfies ChartConfig;

  const [hiddenSeries, setHiddenSeries] = useState<SeriesKey[]>([]);
  const chartConfig: ChartConfig = metric === 'quantity' ? quantityConfig : costConfig;
  const series: SeriesKey[] =
    metric === 'quantity'
      ? ['quantity']
      : resolution === 'daily'
        ? ['localCost', 'officialCost']
        : ['localCost'];
  const visibleSeries = series.filter((key) => !hiddenSeries.includes(key));
  const points = useMemo<PlotPoint[]>(() => {
    let source = resolution === 'daily' ? data.history : data.timeline;
    if (resolution === 'ten-minute') {
      const last = Date.parse(source.at(-1)?.timestamp ?? '');
      source = source.filter((item) => Date.parse(item.timestamp) >= last - 48 * 60 * 60 * 1000);
      const first = source.findIndex(
        (item) => item.observedAt !== null || item.localCost !== null || item.quantity !== null,
      );
      source = first < 0 ? [] : source.slice(first);
    }
    return source.map((item) => ({ ...item, time: Date.parse(item.timestamp) }));
  }, [data, resolution]);
  const values = points.flatMap((point) =>
    visibleSeries.flatMap((key) => {
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
  const axisFormat = new Intl.NumberFormat(i18n.locale, {
    ...(metric === 'cost'
      ? {
          style: 'currency',
          currency: data.currency,
          currencyDisplay: data.currency === 'USD' ? 'narrowSymbol' : 'symbol',
        }
      : {}),
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
    <div className="space-y-5">
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
                            .replace('T', ' ')
                            .replaceAll('-', '/')}{' '}
                          UTC
                        </div>
                        {resolution === 'ten-minute' && point.observedAt && (
                          <div className="mt-1 font-normal text-muted-foreground">
                            <Trans>采集</Trans>
                            {point.observedAt.slice(11, 19)} UTC
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
                          : `${preciseQuantity(Number(value))} ${displayText(data.unit)}`}
                      </span>
                    </div>
                  )}
                />
              }
            />
            {visibleSeries.map((key) => (
              <Line
                key={key}
                dataKey={key}
                type="linear"
                stroke={`var(--color-${key})`}
                strokeWidth={2}
                strokeDasharray={key === 'localCost' && resolution === 'daily' ? '5 4' : undefined}
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
        <div className="flex h-80 items-center justify-center px-4 text-center text-sm text-muted-foreground sm:h-96">
          {visibleSeries.length === 0
            ? t`点击下方图例显示曲线。`
            : resolution === 'ten-minute'
              ? t`暂无完整的 10 分钟采集记录，可切换到每日查看历史数据。`
              : t`暂无可用的每日趋势，等待用量采集或补全。`}
        </div>
      )}
      <ul
        aria-label={t`曲线图例`}
        className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs"
      >
        {series.map((key) => {
          const visible = !hiddenSeries.includes(key);
          return (
            <li key={key} className="min-w-0 max-w-full">
              <button
                type="button"
                aria-pressed={visible}
                onClick={() =>
                  setHiddenSeries((previous) =>
                    previous.includes(key)
                      ? previous.filter((item) => item !== key)
                      : [...previous, key],
                  )
                }
                className={`flex max-w-full cursor-pointer items-start gap-2 rounded-sm px-1 py-1 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${visible ? '' : 'text-muted-foreground opacity-50'}`}
              >
                <span
                  aria-hidden="true"
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor: visible ? chartConfig[key].color : 'var(--muted-foreground)',
                  }}
                />
                <span className="min-w-0 break-words">{chartConfig[key].label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
