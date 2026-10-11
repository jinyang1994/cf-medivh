import { useHideSocialIcons } from '@/hooks/use-appearance';
import { displayText } from '@/utils/display-text';
import { Trans, useLingui } from '@lingui/react/macro';
import { useLayoutEffect, useRef, useState } from 'react';
import { RefreshCw, AlertCircle, Clock3, Settings } from 'lucide-react';
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
  const { t } = useLingui();
  const hideSocialIcons = useHideSocialIcons();

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
  const { data, error, loading } = useDashboard();
  const { pathname } = useLocation();
  const collection = data?.collection;
  const cycle = data?.cycle;
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header ref={headerRef} className="fixed inset-x-0 top-0 z-40 border-b bg-background">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6 lg:px-8 xl:grid xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="flex items-center gap-3">
            <img
              src="/medivh.svg?v=2"
              alt={t`麦迪文`}
              width={32}
              height={32}
              className="size-8 shrink-0"
            />
            <h1 className="text-xl font-semibold tracking-tight">Cloudflare Medivh</h1>
          </div>
          <nav
            aria-label={t`账单页面`}
            className="order-last flex w-full flex-wrap justify-center gap-1 xl:order-none xl:w-auto"
          >
            {BILLING_NAVIGATION.map(([path, label]) => (
              <Button
                key={path}
                variant={
                  pathname === path ||
                  ((path === BILLING_PATHS.services || path === BILLING_PATHS.history) &&
                    pathname.startsWith(`${path}/`))
                    ? 'secondary'
                    : 'ghost'
                }
                size="sm"
                asChild
              >
                <NavLink to={path} end={path !== BILLING_PATHS.services}>
                  {displayText(label)}
                </NavLink>
              </Button>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {!hideSocialIcons && (
              <Button variant="ghost" size="icon-sm" asChild>
                <a
                  href="https://x.com/jinyang1994"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t`访问我的 X 主页`}
                  title={t`X 主页`}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932Zm-1.29 19.49h2.039L6.487 3.24H4.3Z" />
                  </svg>
                </a>
              </Button>
            )}
            <BillingNotifications
              cycleId={cycle?.id ?? null}
              errors={collection?.errors ?? []}
              warnings={collection?.warnings ?? []}
            />
            <Button variant="ghost" size="icon-sm" asChild>
              <NavLink to="/settings" aria-label={t`设置`} title={t`设置`}>
                <Settings aria-hidden="true" />
              </NavLink>
            </Button>
          </div>
        </div>
      </header>
      <div aria-hidden="true" className="shrink-0" style={{ height: headerHeight }} />
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>
              <Trans>无法加载账单</Trans>
            </AlertTitle>
            <AlertDescription>{displayText(error)}</AlertDescription>
          </Alert>
        )}
        {pathname === '/settings' ? (
          <Outlet />
        ) : data ? (
          <Outlet context={{ data } satisfies BillingDashboardContext} />
        ) : loading ? (
          <BillingLoading />
        ) : (
          <Card>
            <CardContent>
              <p className="py-10 text-center text-sm text-muted-foreground">
                <Trans>账单暂不可用</Trans>
              </p>
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
              {collection.running ? t`采集中` : t`每 10 分钟采集`}
              <span>
                {data?.asOf ? t`用量截至 ${{ value0: timestamp(data.asOf) }} UTC` : t`尚未采集用量`}
              </span>
            </span>
            <span>
              <Trans>下次采集</Trans> {timestamp(collection.nextRun)} UTC
            </span>
          </footer>
        )}
      </main>
    </div>
  );
}
