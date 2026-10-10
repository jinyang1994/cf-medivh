import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BILLING_NOTIFICATIONS_STORAGE_KEY,
  buildBillingNotifications,
  countUnreadBillingNotifications,
  loadReadBillingNotificationIds,
  parseReadBillingNotificationIds,
  rememberReadBillingNotificationIds,
  saveReadBillingNotificationIds,
} from '@/utils/billing-notifications';
import type { BillingNotice } from '@/utils/billing-notifications';

function notificationStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function useBillingNotifications(
  cycleId: string | null,
  errors: string[],
  warnings: string[],
  open: boolean,
) {
  // Keep effects stable when a background poll supplies equivalent arrays.
  const notificationKey = JSON.stringify(buildBillingNotifications(cycleId, errors, warnings));
  const notifications = useMemo(
    () => JSON.parse(notificationKey) as BillingNotice[],
    [notificationKey],
  );
  const [readIds, setReadIds] = useState<readonly string[]>(() =>
    loadReadBillingNotificationIds(notificationStorage()),
  );
  const readIdsRef = useRef(readIds);

  const markAllRead = useCallback(() => {
    const storage = notificationStorage();
    const fromOtherTabs = rememberReadBillingNotificationIds(
      readIdsRef.current,
      loadReadBillingNotificationIds(storage),
    );
    const next = rememberReadBillingNotificationIds(
      fromOtherTabs,
      notifications.map((notice) => notice.id),
    );
    if (next === readIdsRef.current) return;
    readIdsRef.current = next;
    setReadIds(next);
    saveReadBillingNotificationIds(storage, next);
  }, [notifications]);

  useEffect(() => {
    if (open) markAllRead();
  }, [open, markAllRead]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== BILLING_NOTIFICATIONS_STORAGE_KEY) return;
      const next = rememberReadBillingNotificationIds(
        readIdsRef.current,
        parseReadBillingNotificationIds(event.newValue),
      );
      if (next === readIdsRef.current) return;
      readIdsRef.current = next;
      setReadIds(next);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return {
    notifications,
    unreadCount: open ? 0 : countUnreadBillingNotifications(notifications, readIds),
    markAllRead,
  };
}
