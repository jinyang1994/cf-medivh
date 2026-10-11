import { CheckCircle2, Clock3 } from 'lucide-react';
import { HistoryTable } from '@/components/billing/history-table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
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
      <Card>
        <CardContent>
          <HistoryTable data={data} />
        </CardContent>
      </Card>
    </>
  );
}
