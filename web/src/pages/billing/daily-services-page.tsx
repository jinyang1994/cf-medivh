import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
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
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">{date(selected)} · 服务明细</h2>
      <Card>
        <CardContent>
          {current?.error ? (
            <div role="alert" className="flex items-center gap-3 py-6">
              <span>{current.error}</span>
              <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
                重试
              </Button>
            </div>
          ) : !data ? (
            <p role="status" className="py-10 text-center text-muted-foreground">
              加载中…
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>服务 / 计费项</TableHead>
                  <TableHead className="text-right">当日用量</TableHead>
                  <TableHead className="text-right">单价</TableHead>
                  <TableHead className="text-right">额度使用比例</TableHead>
                  <TableHead className="text-right">当日超额用量</TableHead>
                  <TableHead className="text-right">当日费用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.services.map((item) => {
                  const hasAllowance = item.pricing.includedQuantity > 0;
                  const daily = item.pricing.allowancePeriod === 'day';
                  return (
                    <TableRow key={item.key}>
                      <TableCell>
                        <div className="font-medium">{item.service}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{item.name}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div>{item.quantity === null ? '待补全' : quantity(item.quantity)}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{item.unit}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div>{money(item.pricing.unitPrice, item.pricing.currency, 'rate')}</div>
                        <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                          / {quantity(item.pricing.unitSize)} {item.unit}
                        </div>
                        {!!item.pricing.fixedFee && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            固定费 {money(item.pricing.fixedFee, item.pricing.currency)} / 账期
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div className="flex items-center justify-end gap-2">
                          <Badge variant="outline">
                            {!hasAllowance ? '无免费额度' : daily ? '按日免费' : '按月免费'}
                          </Badge>
                          {hasAllowance && (
                            <span>
                              {item.allowanceRatio === null
                                ? '待补全'
                                : new Intl.NumberFormat('zh-CN', {
                                    style: 'percent',
                                    maximumFractionDigits: 2,
                                  }).format(item.allowanceRatio)}
                            </span>
                          )}
                        </div>
                        {hasAllowance && item.allowanceUsed !== null && (
                          <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                            {quantity(item.allowanceUsed)} /{' '}
                            {quantity(item.pricing.includedQuantity)} {item.unit}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div>
                          {item.key === '__base_fee'
                            ? '—'
                            : item.overageQuantity === null
                              ? '待补全'
                              : quantity(item.overageQuantity)}
                        </div>
                        {item.key !== '__base_fee' && (
                          <div className="mt-1 text-xs text-muted-foreground">{item.unit}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {item.cost === null ? (
                          <Badge variant="outline">待补全</Badge>
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
                      当日用量待采集
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
