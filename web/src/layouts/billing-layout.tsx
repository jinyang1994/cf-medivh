import { Cloud, RefreshCw, AlertCircle, Clock3 } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BillingLoading } from '@/components/billing/billing-loading';
import { BillingNotifications } from '@/components/billing/billing-notifications';
import { BILLING_NAVIGATION, BILLING_PATHS } from '@/constants/billing-navigation';
import { useDashboard } from '@/hooks/use-dashboard';
import type { BillingDashboardContext } from '@/types/billing';
import { date, inclusiveEnd, timestamp } from '@/utils/format';

export function BillingLayout() {
  const { data, error, loading, refresh } = useDashboard();
  const { pathname } = useLocation();
  const collection = data?.collection;
  const cycle = data?.cycle;
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Cloud className="size-6" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight">Cloudflare 账单</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">UTC</span>
            <BillingNotifications
              cycleId={cycle?.id ?? null}
              errors={collection?.errors ?? []}
              warnings={collection?.warnings ?? []}
            />
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden="true" />
              刷新
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <nav aria-label="账单页面" className="flex gap-1">
            {BILLING_NAVIGATION.map(([path, label]) => (
              <Button
                key={path}
                variant={
                  pathname === path ||
                  (path === BILLING_PATHS.services && pathname.startsWith(`${path}/`))
                    ? 'secondary'
                    : 'ghost'
                }
                size="sm"
                asChild
              >
                <NavLink to={path} end={path !== BILLING_PATHS.services}>
                  {label}
                </NavLink>
              </Button>
            ))}
          </nav>
          <div className="text-sm text-muted-foreground">
            {cycle ? `${date(cycle.start)} — ${inclusiveEnd(cycle.end)}` : '账单周期待同步'}
          </div>
        </div>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>无法加载账单</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {data ? (
          <Outlet context={{ data } satisfies BillingDashboardContext} />
        ) : loading ? (
          <BillingLoading />
        ) : (
          <Card>
            <CardContent>
              <p className="py-10 text-center text-sm text-muted-foreground">账单暂不可用</p>
            </CardContent>
          </Card>
        )}
        {collection && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              {collection.running ? (
                <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Clock3 className="size-3.5" aria-hidden="true" />
              )}
              {collection.running ? '采集中' : '每 10 分钟采集'}
              <span>{data?.asOf ? `用量截至 ${timestamp(data.asOf)} UTC` : '尚未采集用量'}</span>
            </span>
            <span>下次采集 {timestamp(collection.nextRun)} UTC</span>
          </footer>
        )}
      </main>
    </div>
  );
}
