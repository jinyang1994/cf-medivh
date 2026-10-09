import { Skeleton } from '@/components/ui/skeleton';

export function BillingLoading() {
  return (
    <div role="status" aria-label="正在加载账单" className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((id) => (
          <Skeleton key={id} className="h-36" />
        ))}
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  );
}
