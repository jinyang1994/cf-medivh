import { ArrowUpRight } from 'lucide-react';
import { NavLink } from 'react-router';
import { BillingChart } from '@/components/billing/billing-chart';
import { HistoryTable } from '@/components/billing/history-table';
import { MetricCard } from '@/components/billing/metric-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { BILLING_PATHS, serviceTrendPath } from '@/constants/billing-navigation';
import { useBillingDashboard } from '@/hooks/use-billing-dashboard';
import { cycleProgress, date, inclusiveEnd, money, shortDate } from '@/utils/format';
import { serviceTotals } from '@/utils/service-totals';

export function OverviewPage() {
  const data = useBillingDashboard();
  const { totals, currency } = data;
  const services = serviceTotals(data.services);
  const hasEstimatedServiceCost = services.some((item) => item.currentCost === null);
  const baseFee = data.cycle?.baseFee ?? 0;
  const progress = cycleProgress(data.cycle, data.today);
  const latestComparison = data.history
    .filter((item) => item.officialTotal !== null && item.localTotal !== null)
    .at(-1);
  return (
    <>
      <section aria-label="周期费用" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="账期天数"
          value={
            progress ? (
              <span aria-label={`当前账期第 ${progress.current} 天，共 ${progress.total} 天`}>
                {progress.current}
                <span className="ml-1 text-xl font-normal text-muted-foreground">
                  /{progress.total}
                </span>
              </span>
            ) : (
              '—'
            )
          }
          main
          detail={
            data.cycle
              ? `${date(data.cycle.start)} — ${inclusiveEnd(data.cycle.end)} UTC`
              : '等待账期信息'
          }
        />
        <MetricCard
          title="今日实时费用"
          value={money(totals.todayLocal, currency, true)}
          detail={`${date(data.today)} · 本地估算`}
        />
        <MetricCard
          title="历史官方累计"
          value={money(totals.officialHistorical, currency, true)}
          detail={
            totals.officialThrough
              ? `截至 ${date(totals.officialThrough)}${baseFee > 0 && totals.officialHistorical !== null ? ` · 用量 ${money(totals.officialHistorical - baseFee, currency, true)} + 订阅 ${money(baseFee, currency)}` : ''}`
              : '等待官方汇总'
          }
        />
        <MetricCard
          title="本地累计费用"
          value={money(totals.localCumulative, currency, true)}
          detail={`截至 ${date(data.today)} · ${totals.localCumulative !== null ? '本地估算' : '用量待补全'}`}
        />
      </section>
      <BillingChart data={data} />
      <section className="grid items-stretch gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>服务费用</CardTitle>
                {hasEstimatedServiceCost && <Badge variant="outline">本地预估</Badge>}
              </div>
              <Button variant="ghost" size="sm" asChild>
                <NavLink to={BILLING_PATHS.services}>
                  全部明细
                  <ArrowUpRight />
                </NavLink>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>服务</TableHead>
                  <TableHead className="text-right">今日</TableHead>
                  <TableHead className="text-right">周期累计</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {services.slice(0, 8).map((item) => (
                  <TableRow key={item.service}>
                    <TableCell className="font-medium">
                      <NavLink
                        to={serviceTrendPath(item.service)}
                        aria-label={`查看 ${item.service} 费用趋势`}
                        className="inline-flex rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {item.service}
                      </NavLink>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(item.todayCost, currency, true)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(item.currentCost ?? item.cost, currency, true)}
                    </TableCell>
                  </TableRow>
                ))}
                {data.services.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                      暂无服务用量
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>最近核对</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <NavLink to={BILLING_PATHS.history}>
                  每日明细
                  <ArrowUpRight />
                </NavLink>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">
                本地 − 官方{latestComparison ? ` · ${shortDate(latestComparison.date)}` : ''}
              </span>
              <span className="text-xl font-semibold tabular-nums">
                {money(totals.difference, currency, true)}
              </span>
            </div>
            <HistoryTable data={data} limit={7} />
          </CardContent>
        </Card>
      </section>
    </>
  );
}
