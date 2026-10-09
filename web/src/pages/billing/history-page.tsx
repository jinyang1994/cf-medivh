import { CheckCircle2, Clock3 } from 'lucide-react';
import { BillingChart } from '@/components/billing/billing-chart';
import { HistoryTable } from '@/components/billing/history-table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useBillingDashboard } from '@/hooks/use-billing-dashboard';

export function HistoryPage() {
  const data = useBillingDashboard();
  const pending = data.collection.pendingOfficialDates.length;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">每日核对</h2>
        {pending > 0 ? (
          <Badge variant="outline">
            <Clock3 />
            {pending} 天待同步
          </Badge>
        ) : (
          <Badge variant="secondary">
            <CheckCircle2 />
            官方已同步
          </Badge>
        )}
      </div>
      <BillingChart data={data} defaultResolution="daily" />
      <Card>
        <CardHeader>
          <CardTitle>每日累计费用</CardTitle>
        </CardHeader>
        <CardContent>
          <HistoryTable data={data} />
        </CardContent>
      </Card>
    </>
  );
}
