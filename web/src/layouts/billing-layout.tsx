import { useLayoutEffect, useRef, useState } from 'react';
import { RefreshCw, AlertCircle, Clock3 } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BillingLoading } from '@/components/billing/billing-loading';
import { BillingNotifications } from '@/components/billing/billing-notifications';
import { BILLING_NAVIGATION, BILLING_PATHS } from '@/constants/billing-navigation';
import { useDashboard } from '@/hooks/use-dashboard';
import type { BillingDashboardContext } from '@/types/billing';
import { timestamp } from '@/utils/format';

export function BillingLayout() {
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const updateHeight = () => setHeaderHeight(header.getBoundingClientRect().height);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const { data, error, loading, refresh } = useDashboard();
  const { pathname } = useLocation();
  const collection = data?.collection;
  const cycle = data?.cycle;
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header ref={headerRef} className="fixed inset-x-0 top-0 z-40 border-b bg-background">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <img
              src="/medivh.svg?v=2"
              alt="麦迪文"
              width={32}
              height={32}
              className="size-8 shrink-0"
            />
            <h1 className="text-xl font-semibold tracking-tight">Cloudflare Medivh</h1>
          </div>
          <nav
            aria-label="账单页面"
            className="order-last flex w-full gap-1 lg:order-none lg:w-auto"
          >
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
          <div className="ml-auto flex flex-wrap items-center gap-3">
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
      <div aria-hidden="true" className="shrink-0" style={{ height: headerHeight }} />
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
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
          <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground">
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
