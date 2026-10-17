import { Trans, useLingui } from '@lingui/react/macro';
import { NavLink, useNavigate } from 'react-router';
import { BILLING_PATHS } from '@/constants/billing-navigation';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Dashboard } from '@/types/billing';
import { date, money } from '@/utils/format';

export function HistoryTable({ data, limit }: { data: Dashboard; limit?: number }) {
  const { t } = useLingui();

  const navigate = useNavigate();
  const rows = [...data.history]
    .filter((item) => item.date <= data.today)
    .reverse()
    .slice(0, limit);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <Trans>截至日期</Trans>
          </TableHead>
          <TableHead className="text-right">
            <Trans>每日费用</Trans>
          </TableHead>
          <TableHead className="text-right">
            <Trans>本地累计</Trans>
          </TableHead>
          <TableHead className="text-right">
            <Trans>官方累计</Trans>
          </TableHead>
          <TableHead className="text-right">
            <Trans>累计差值</Trans>
          </TableHead>
          <TableHead className="text-right">
            <Trans>当日新增差值</Trans>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((item) => (
          <TableRow
            key={item.date}
            className="cursor-pointer"
            onClick={(event) => {
              if (!(event.target as HTMLElement).closest('a, button'))
                void navigate(`${BILLING_PATHS.history}/${item.date}`);
            }}
          >
            <TableCell className="whitespace-nowrap">
              <NavLink
                to={`${BILLING_PATHS.history}/${item.date}`}
                className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t`查看 ${{ value0: date(item.date) }} 服务明细`}
              >
                {date(item.date)}
              </NavLink>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {money(item.dailyCost, data.currency, true)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {money(item.localTotal, data.currency, true)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {item.officialTotal === null ? (
                <Badge variant="outline">
                  <Trans>待同步</Trans>
                </Badge>
              ) : (
                money(item.officialTotal, data.currency, true)
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {money(item.difference, data.currency, true)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {money(item.dailyDifference, data.currency, true)}
            </TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
              <Trans>暂无历史账单</Trans>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
