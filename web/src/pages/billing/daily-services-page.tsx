import { displayText } from '@/utils/display-text';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import type { DailyServices } from '@/types/billing';
import { date, money, quantity } from '@/utils/format';

export function DailyServicesPage() {
  const { i18n, t } = useLingui();

  const navigate = useNavigate();
  const { date: selected = '' } = useParams();
  const dashboard = useBillingDashboard();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; data?: DailyServices; error?: string }>();
  const key = `${dashboard.cycle?.id}:${selected}:${attempt}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/daily-services?${new URLSearchParams({ date: selected })}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 404 ? '该日期不在当前账期内或尚未到来' : '当日服务明细加载失败',
          );
        const data = (await response.json()) as DailyServices;
        if (data.date !== selected || data.cycle.id !== dashboard.cycle?.id)
          throw new Error('账期已变化，请刷新页面');
        if (!controller.signal.aborted) setState({ key, data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({ key, error: error instanceof Error ? error.message : '加载失败' });
      });
    return () => controller.abort();
  }, [selected, dashboard, key]);
  const current = state?.key === key ? state : undefined;
  const data = current?.data;
  const selectedTime = Date.parse(selected);
  const validDate =
    Number.isFinite(selectedTime) && new Date(selectedTime).toISOString().slice(0, 10) === selected;
  const adjacent = (offset: number) =>
    validDate ? new Date(selectedTime + offset * 86_400_000).toISOString().slice(0, 10) : '';
  const previous = adjacent(-1);
  const next = adjacent(1);
  const available = (day: string) =>
    !!dashboard.cycle &&
    !!day &&
    day >= dashboard.cycle.start &&
    day < dashboard.cycle.end &&
    day <= dashboard.today;
  return (
    <>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
        <Button
          className="justify-self-start"
          variant="ghost"
          size="sm"
          disabled={!available(previous)}
          onClick={() => void navigate(`/billing/history/${previous}`)}
        >
          <ChevronLeft />
          <Trans>前一天</Trans>
        </Button>
        <h2 className="text-center text-base font-semibold tracking-tight sm:text-2xl">
          {date(selected)} <Trans>· 服务明细</Trans>
        </h2>
        <Button
          className="justify-self-end"
          variant="ghost"
          size="sm"
          disabled={!available(next)}
          onClick={() => void navigate(`/billing/history/${next}`)}
        >
          <Trans>后一天</Trans>
          <ChevronRight />
        </Button>
      </div>
      <Card>
        <CardContent>
          {current?.error ? (
            <div role="alert" className="flex items-center gap-3 py-6">
              <span>{displayText(current.error)}</span>
              <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
                <Trans>重试</Trans>
              </Button>
            </div>
          ) : !data ? (
            <p role="status" className="py-10 text-center text-muted-foreground">
              <Trans>加载中…</Trans>
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Trans>服务 / 计费项</Trans>
                  </TableHead>
                  <TableHead className="text-right">
                    <Trans>当日用量核对</Trans>
                  </TableHead>
                  <TableHead className="text-right">
                    <Trans>单价</Trans>
                  </TableHead>
                  <TableHead className="text-right">
                    <Trans>额度使用比例</Trans>
                  </TableHead>
                  <TableHead className="text-right">
                    <Trans>当日超额用量</Trans>
                  </TableHead>
                  <TableHead className="text-right">
                    <Trans>当日费用核对</Trans>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.services.map((item) => {
                  const hasAllowance = item.pricing.includedQuantity > 0;
                  const daily = item.pricing.allowancePeriod === 'day';
                  return (
                    <TableRow
                      key={item.key}
                      className="cursor-pointer"
                      onClick={(event) => {
                        if (!(event.target as HTMLElement).closest('a, button'))
                          void navigate(
                            `/billing/history/${selected}/trend?${new URLSearchParams({ service: item.service, meter: item.key })}`,
                          );
                      }}
                    >
                      <TableCell>
                        <NavLink
                          to={`/billing/history/${selected}/trend?${new URLSearchParams({ service: item.service, meter: item.key })}`}
                          className="block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <div className="font-medium">{displayText(item.service)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {displayText(item.name)}
                          </div>
                        </NavLink>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div>{item.quantity === null ? t`待补全` : quantity(item.quantity)}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {displayText(item.unit)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div>{money(item.pricing.unitPrice, item.pricing.currency, 'rate')}</div>
                        <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                          / {quantity(item.pricing.unitSize)} {displayText(item.unit)}
                        </div>
                        {!!item.pricing.fixedFee && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            <Trans>固定费</Trans>{' '}
                            {money(item.pricing.fixedFee, item.pricing.currency)}{' '}
                            <Trans>/ 账期</Trans>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div className="flex items-center justify-end gap-2">
                          <Badge variant="outline">
                            {!hasAllowance ? t`无免费额度` : daily ? t`按日免费` : t`按月免费`}
                          </Badge>
                          {hasAllowance && (
                            <span>
                              {item.allowanceRatio === null
                                ? t`待补全`
                                : new Intl.NumberFormat(i18n.locale, {
                                    style: 'percent',
                                    maximumFractionDigits: 2,
                                  }).format(item.allowanceRatio)}
                            </span>
                          )}
                        </div>
                        {hasAllowance && item.allowanceUsed !== null && (
                          <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                            {quantity(item.allowanceUsed)} /{' '}
                            {quantity(item.pricing.includedQuantity)} {displayText(item.unit)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div>
                          {item.key === '__base_fee'
                            ? '—'
                            : item.overageQuantity === null
                              ? t`待补全`
                              : quantity(item.overageQuantity)}
                        </div>
                        {item.key !== '__base_fee' && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {displayText(item.unit)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {item.cost === null ? (
                          <Badge variant="outline">
                            <Trans>待补全</Trans>
                          </Badge>
                        ) : (
                          money(item.cost, data.currency, true)
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!data.services.length && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      <Trans>当日用量待采集</Trans>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
