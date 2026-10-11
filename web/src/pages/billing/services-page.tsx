import { displayText } from '@/utils/display-text';
import { Trans, useLingui } from '@lingui/react/macro';
import { NavLink, useNavigate } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useBillingDashboard } from '@/hooks/use-billing-dashboard';
import { serviceTrendPath } from '@/constants/billing-navigation';
import { date, money, quantity } from '@/utils/format';

export function ServicesPage() {
  const { t } = useLingui();

  const data = useBillingDashboard();
  const navigate = useNavigate();
  const services = [...data.services].sort(
    (a, b) => a.service.localeCompare(b.service) || b.cost - a.cost,
  );
  const hasEstimatedServiceCost = services.some((item) => item.currentCost == null);
  const estimateLabel = data.totals.localCumulative === null ? t`部分用量估算` : t`本地估算`;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">
          <Trans>服务明细</Trans>
        </h2>
        <span className="text-sm text-muted-foreground">
          <Trans>截至 {{ value0: date(data.today) }}</Trans> ·{' '}
          {data.totals.localCumulative === null ? t`部分用量` : t`用量估算`}
          <Trans> · 点击计费项查看趋势</Trans>
        </span>
      </div>
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Trans>服务 / 计费项</Trans>
                </TableHead>
                <TableHead className="text-right">
                  <Trans>周期用量</Trans>
                </TableHead>
                <TableHead className="text-right">
                  <Trans>今日用量</Trans>
                </TableHead>
                <TableHead className="text-right">
                  <Trans>单价</Trans>
                </TableHead>
                <TableHead className="text-right">
                  <Trans>免费额度</Trans>
                </TableHead>
                <TableHead className="text-right">
                  <Trans>本地累计</Trans>
                </TableHead>
                <TableHead className="text-right">
                  <Trans>当前费用</Trans>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((item) => (
                <TableRow
                  key={item.key}
                  className="group cursor-pointer"
                  onClick={(event) => {
                    if (!(event.target as HTMLElement).closest('a, button'))
                      void navigate(serviceTrendPath(item.service, item.key));
                  }}
                >
                  <TableCell>
                    <NavLink
                      to={serviceTrendPath(item.service, item.key)}
                      aria-label={t`查看 ${{ value0: displayText(item.service) }} · ${{ value1: displayText(item.name) }} 趋势`}
                      className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span>
                        <span className="block font-medium">{displayText(item.service)}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {displayText(item.name)}
                        </span>
                      </span>
                    </NavLink>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <div>{quantity(item.quantity)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {displayText(item.unit)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {quantity(item.todayQuantity)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <div>{money(item.pricing.unitPrice, item.pricing.currency, 'rate')}</div>
                    <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                      / {quantity(item.pricing.unitSize)} {displayText(item.unit)}
                    </div>
                    {!!item.pricing.fixedFee && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        <Trans>固定</Trans> {money(item.pricing.fixedFee, item.pricing.currency)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <div>{quantity(item.pricing.includedQuantity)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      / {item.pricing.allowancePeriod === 'day' ? t`日` : t`周期`}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(item.cost, data.currency, true)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {money(item.currentCost ?? item.cost, data.currency, true)}
                    {item.currentCost == null && (
                      <div className="mt-1 text-xs font-normal text-muted-foreground">
                        {estimateLabel}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {services.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                    <Trans>暂无服务用量</Trans>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {hasEstimatedServiceCost && (
            <p className="mt-4 text-xs text-muted-foreground">
              <Trans>
                标注估算的金额按已有用量计算；用量不全可能低估，服务合计可能与官方校正总额不同。
              </Trans>
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
