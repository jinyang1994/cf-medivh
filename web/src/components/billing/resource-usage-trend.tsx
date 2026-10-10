import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis, type DotItemDotProps } from 'recharts';
import { Button } from '@/components/ui/button';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import type { ResourceCostTrend, ResourceUsageTrend } from '@/types/billing';
import { money, quantity } from '@/utils/format';
import { resourceTrendSeries } from '@/utils/resource-trend-series';

const COLORS = [
  '#2563eb',
  '#059669',
  '#d97706',
  '#9333ea',
  '#db2777',
  '#0891b2',
  '#dc2626',
  '#4f46e5',
];

function formatTime(value: string, daily = false) {
  return value.slice(0, daily ? 10 : 16).replace('T', ' ');
}

function formatUsage(value: number) {
  return value !== 0 && Math.abs(value) < 1e-10 ? value.toExponential(6) : quantity(value);
}

function ResourceUsagePlot({
  data,
  active = true,
}: {
  data: ResourceUsageTrend | ResourceCostTrend;
  active?: boolean;
}) {
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const cost = 'currency' in data;
  const { series, points } = useMemo(() => resourceTrendSeries(data), [data]);
  if (!active) return null;

  const resources = series.map((item) => ({
    ...item,
    color:
      item.kind === 'total'
        ? 'var(--foreground)'
        : item.kind === 'official'
          ? 'var(--muted-foreground)'
          : item.kind === 'unattributed'
            ? '#a16207'
            : COLORS[(item.colorIndex ?? 0) % COLORS.length],
  }));
  const selected = resources.filter((item) => !hiddenIds.includes(item.toggleKey));
  const formattedValue = (value: number | null) =>
    cost
      ? money(value, data.currency, 'rate')
      : value == null
        ? '—'
        : `${formatUsage(value)} ${data.unit}`;
  const plottedPoints = points.map((point) => ({
    timestamp: point.timestamp,
    time: point.time,
    ...point.values,
  }));
  const values = points.flatMap((point) =>
    selected.flatMap((item) => {
      const value = point.values[item.key];
      return value != null && Number.isFinite(value) ? [value] : [];
    }),
  );
  const config: ChartConfig = Object.fromEntries(
    selected.map((item) => [item.key, { label: item.name, color: item.color }]),
  );
  const max = values.reduce((result, value) => Math.max(result, value), 0);
  const start = Date.parse(data.start);
  const end = Date.parse(data.end);
  const daily = data.resolution === 'daily';
  const domain: [number, number] = start === end ? [start - 300_000, end + 300_000] : [start, end];
  const ticks =
    points.length <= 5
      ? points.map((point) => point.time)
      : Array.from(
          { length: 5 },
          (_, index) => points[Math.round((index * (points.length - 1)) / 4)].time,
        );

  return (
    <div className="space-y-5">
      {values.length > 0 ? (
        <ChartContainer config={config} className="h-80 w-full sm:h-96">
          <LineChart
            accessibilityLayer
            data={plottedPoints}
            margin={{ left: 4, right: 16, top: 12, bottom: 8 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              scale="time"
              domain={domain}
              ticks={ticks}
              axisLine={false}
              tickLine={false}
              tickMargin={12}
              minTickGap={32}
              tickFormatter={(value: number) => {
                const iso = new Date(value).toISOString();
                return daily ? iso.slice(5, 10) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
              }}
            />
            <YAxis
              domain={[0, max > 0 ? max * 1.1 : 1]}
              width={cost ? 104 : 80}
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              tickFormatter={(value: number) =>
                cost
                  ? money(value, data.currency, true)
                  : value !== 0 && Math.abs(value) < 1e-10
                    ? value.toExponential(2)
                    : quantity(value)
              }
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  className="max-w-[min(28rem,calc(100vw-3rem))]"
                  labelFormatter={(_label, payload) => {
                    const point = payload[0]?.payload as { timestamp?: string } | undefined;
                    return point?.timestamp ? `${formatTime(point.timestamp, daily)} UTC` : null;
                  }}
                  formatter={(value, name) => {
                    const resource = selected.find((item) => item.key === name);
                    return (
                      <div className="flex min-w-0 flex-1 items-start gap-2">
                        <span
                          aria-hidden="true"
                          className="mt-1 size-2 shrink-0 rounded-sm"
                          style={{ backgroundColor: resource?.color }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="break-all font-medium">{resource?.name ?? name}</p>
                          {resource?.resourceId && resource.resourceId !== resource.name && (
                            <p className="mt-0.5 break-all text-muted-foreground">
                              {resource.resourceId}
                            </p>
                          )}
                          <p className="mt-1 font-mono tabular-nums">
                            {formattedValue(Number(value))}
                          </p>
                        </div>
                      </div>
                    );
                  }}
                />
              }
            />
            {selected.map((item) => (
              <Line
                key={item.key}
                dataKey={item.key}
                type="linear"
                stroke={item.color}
                strokeWidth={item.kind === 'total' ? 3 : 2}
                strokeDasharray={
                  item.kind === 'official'
                    ? '6 4'
                    : item.kind === 'unattributed'
                      ? '3 3'
                      : undefined
                }
                isAnimationActive={false}
                connectNulls={false}
                dot={({ cx, cy, index }: DotItemDotProps) =>
                  points[index]?.values[item.key] != null &&
                  (points.length <= 32 ||
                    (points[index - 1]?.values[item.key] == null &&
                      points[index + 1]?.values[item.key] == null)) ? (
                    <circle key={index} cx={cx} cy={cy} r={2.5} fill={item.color} />
                  ) : null
                }
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        </ChartContainer>
      ) : (
        <p className="flex h-80 items-center justify-center text-center text-sm text-muted-foreground sm:h-96">
          {selected.length === 0
            ? `点击下方图例显示${cost ? '费用' : '用量'}曲线。`
            : `所选曲线在此时段暂无可用${cost ? '费用' : '用量'}。`}
        </p>
      )}
      <ul aria-label="曲线图例" className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs">
        {resources.map((item) => {
          const visible = !hiddenIds.includes(item.toggleKey);
          return (
            <li key={item.key} className="min-w-0 max-w-full">
              <button
                type="button"
                aria-label={item.resourceId ? `${item.name}（${item.resourceId}）` : item.name}
                aria-pressed={visible}
                title={`${item.name}${item.resourceId ? ` · ${item.resourceId}` : ''} · ${cost ? (item.kind === 'resource' ? '分摊估算 · 最近累计' : '最近累计') : '区间合计'} ${formattedValue(item.total)}`}
                onClick={() =>
                  setHiddenIds((previous) =>
                    previous.includes(item.toggleKey)
                      ? previous.filter((id) => id !== item.toggleKey)
                      : [...previous, item.toggleKey],
                  )
                }
                className={`flex max-w-full cursor-pointer items-start gap-2 rounded-sm px-1 py-1 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${visible ? '' : 'text-muted-foreground opacity-50'}`}
              >
                <span
                  aria-hidden="true"
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: visible ? item.color : 'var(--muted-foreground)' }}
                />
                <span className="min-w-0 break-words">{item.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ResourceUsageTrendContent({
  data,
  error,
  loading,
  refresh,
  resolution,
  metric = 'quantity',
  active = true,
}: {
  data: ResourceUsageTrend | ResourceCostTrend | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
  resolution: 'ten-minute' | 'daily';
  metric?: 'quantity' | 'cost';
  active?: boolean;
}) {
  const cost = data ? 'currency' in data : metric === 'cost';
  return (
    <div className="space-y-4">
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
        <div role="status" aria-label={`正在加载资源${cost ? '费用' : '用量'}`}>
          <Skeleton className="h-80 w-full" />
          <p className="mt-3 text-sm text-muted-foreground">
            正在读取已采集的资源{cost ? '费用' : '用量'}…
          </p>
        </div>
      )}
      {data?.unavailableReason ? (
        <p className="rounded-md bg-muted/50 px-4 py-6 text-sm leading-relaxed text-muted-foreground">
          {data.unavailableReason}
        </p>
      ) : data && !cost && data.resources.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">此时段暂无资源用量记录。</p>
      ) : data ? (
        <ResourceUsagePlot
          key={`${resolution}-${cost ? 'cost' : 'quantity'}`}
          data={data}
          active={active}
        />
      ) : null}
      {data && data.warnings.length > 0 && (
        <div className="rounded-md bg-muted/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium">数据说明</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {data.warnings.map((warning) => (
              <li key={warning} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
