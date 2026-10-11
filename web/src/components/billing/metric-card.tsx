import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function MetricCard({
  title,
  value,
  detail,
  main = false,
}: {
  title: string;
  value: ReactNode;
  detail: string;
  main?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="text-sm font-medium text-muted-foreground">{title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p
          className={`${main ? 'text-4xl' : 'text-3xl'} font-semibold tracking-tight tabular-nums`}
        >
          {value}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}
