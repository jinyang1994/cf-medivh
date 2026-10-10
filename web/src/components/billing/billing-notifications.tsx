import { useState } from 'react';
import { AlertCircle, Bell, Info, X } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { useBillingNotifications } from '@/hooks/use-billing-notifications';

export function BillingNotifications({
  cycleId,
  errors,
  warnings,
}: {
  cycleId: string | null;
  errors: string[];
  warnings: string[];
}) {
  const [open, setOpen] = useState(false);
  const { notifications, unreadCount, markAllRead } = useBillingNotifications(
    cycleId,
    errors,
    warnings,
    open,
  );

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) markAllRead();
      }}
    >
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={unreadCount > 0 ? `通知，${unreadCount} 条未读` : '通知'}
          title="通知"
        >
          <Bell className="size-4" aria-hidden="true" />
          {unreadCount > 0 && (
            <span
              data-testid="notification-unread-dot"
              aria-hidden="true"
              className="absolute right-1 top-1 size-2 rounded-full bg-destructive ring-2 ring-background"
            />
          )}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="z-50 w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-popover text-popover-foreground shadow-md outline-none"
        >
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <Popover.Title className="text-sm font-semibold">
              通知
              {notifications.length > 0 && (
                <span className="ml-2 font-normal text-muted-foreground">
                  {notifications.length} 条
                </span>
              )}
            </Popover.Title>
            <Popover.Description className="sr-only">
              账单数据同步和用量提示，打开即标记为已读。
            </Popover.Description>
            <Popover.Close asChild>
              <Button variant="ghost" size="icon-xs" aria-label="关闭通知">
                <X aria-hidden="true" />
              </Button>
            </Popover.Close>
          </div>
          {notifications.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">暂无通知</p>
          ) : (
            <ul
              tabIndex={0}
              aria-label="通知列表"
              className="max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain p-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {notifications.map((notice) => (
                <li key={notice.id} className="flex gap-3 border-b p-3 last:border-b-0">
                  {notice.kind === 'error' ? (
                    <AlertCircle
                      className="mt-0.5 size-4 shrink-0 text-destructive"
                      aria-hidden="true"
                    />
                  ) : (
                    <Info
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {notice.kind === 'error' ? '数据同步失败' : '数据提示'}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                      {notice.message}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
