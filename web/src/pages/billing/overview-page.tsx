import { displayText } from '@/utils/display-text';
import { Trans, useLingui } from '@lingui/react/macro';
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
  const { t } = useLingui();

  const data = useBillingDashboard();
  const { totals, currency } = data;
  const services = serviceTotals(data.services);
  const hasEstimatedServiceCost = services.some((item) => item.currentCost === null);
  const progress = cycleProgress(data.cycle, data.today);
  const latestComparison = data.history
    .filter((item) => item.officialTotal !== null && item.localTotal !== null)
    .at(-1);
  return (
    <>
      <section aria-label={t`周期费用`} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title={t`账期天数`}
          value={
            progress ? (
              <span
                aria-label={t`当前账期第 ${{ value0: progress.current }} 天，共 ${{ value1: progress.total }} 天`}
              >
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
              : t`等待账期信息`
          }
        />
        <MetricCard
          title={t`今日实时费用`}
          value={money(totals.todayLocal, currency, true)}
          detail={t`${{ value0: date(data.today) }} · 本地估算`}
        />
        <MetricCard
          title={t`历史官方累计`}
          value={money(totals.officialHistorical, currency, true)}
          detail={
            totals.officialThrough
              ? t`截至 ${{ value0: date(totals.officialThrough) }}`
              : t`等待官方汇总`
          }
        />
        <MetricCard
          title={t`本地累计费用`}
          value={money(totals.localCumulative, currency, true)}
          detail={t`截至 ${{ value0: date(data.today) }} · ${{
            value1: totals.localCumulative !== null ? t`本地估算` : t`用量待补全`,
          }}`}
        />
      </section>
      <BillingChart data={data} />
      <section className="grid items-stretch gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>
                  <Trans>服务费用</Trans>
                </CardTitle>
                {hasEstimatedServiceCost && (
                  <Badge variant="outline">
                    <Trans>本地预估</Trans>
                  </Badge>
                )}
              </div>
              <Button variant="ghost" size="sm" asChild>
                <NavLink to={BILLING_PATHS.services}>
                  <Trans>全部明细</Trans>
                  <ArrowUpRight />
                </NavLink>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Trans>服务</Trans>
                  </TableHead>
                  <TableHead className="text-right">
                    <Trans>今日</Trans>
                  </TableHead>
                  <TableHead className="text-right">
                    <Trans>周期累计</Trans>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {services.slice(0, 8).map((item) => (
                  <TableRow key={displayText(item.service)}>
                    <TableCell className="font-medium">
                      <NavLink
                        to={serviceTrendPath(item.service)}
                        aria-label={t`查看 ${{ value0: displayText(item.service) }} 费用趋势`}
                        className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {displayText(item.service)}
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
                      <Trans>暂无服务用量</Trans>
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
              <CardTitle>
                <Trans>最近核对</Trans>
              </CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <NavLink to={BILLING_PATHS.history}>
                  <Trans>每日明细</Trans>
                  <ArrowUpRight />
                </NavLink>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">
                <Trans>本地 − 官方</Trans>
                {latestComparison ? ` · ${shortDate(latestComparison.date)}` : ''}
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
