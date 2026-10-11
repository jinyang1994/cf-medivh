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
  const rows = [...data.history]
    .filter((item) => item.date < data.today)
    .reverse()
    .slice(0, limit);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>截至日期</TableHead>
          <TableHead className="text-right">本地累计</TableHead>
          <TableHead className="text-right">官方累计</TableHead>
          <TableHead className="text-right">差值</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((item) => (
          <TableRow key={item.date}>
            <TableCell className="whitespace-nowrap">{date(item.date)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {money(item.localTotal, data.currency, true)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {item.officialTotal === null ? (
                <Badge variant="outline">待同步</Badge>
              ) : (
                money(item.officialTotal, data.currency, true)
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {money(item.difference, data.currency, true)}
            </TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
              暂无历史账单
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
