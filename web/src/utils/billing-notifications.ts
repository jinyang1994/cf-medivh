export type BillingNotice = {
  id: string;
  kind: 'error' | 'warning';
  message: string;
};

export const BILLING_NOTIFICATIONS_STORAGE_KEY = 'cf-medivh:billing-notifications:read:v1';
export const MAX_READ_BILLING_NOTIFICATIONS = 750;

export function buildBillingNotifications(
  cycleId: string | null,
  errors: readonly string[],
  warnings: readonly string[],
): BillingNotice[] {
  const messages = new Map<string, BillingNotice['kind']>();
  for (const kind of ['error', 'warning'] as const) {
    for (const value of kind === 'error' ? errors : warnings) {
      const message = value.trim();
      if (message && !messages.has(message)) messages.set(message, kind);
    }
  }
  return [...messages]
    .map(([message, kind]) => ({
      id: JSON.stringify([cycleId, kind, message]),
      kind,
      message,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message));
}

export function parseReadBillingNotificationIds(value: string | null): string[] {
  try {
    const parsed: unknown = value === null ? [] : JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && !!id))].slice(
      -MAX_READ_BILLING_NOTIFICATIONS,
    );
  } catch {
    return [];
  }
}

export function rememberReadBillingNotificationIds(
  previous: readonly string[],
  ids: readonly string[],
): readonly string[] {
  const known = new Set(previous);
  const additions: string[] = [];
  for (const id of ids) {
    if (!known.has(id)) {
      known.add(id);
      additions.push(id);
    }
  }
  // Polls and temporarily absent notices must not reset read state or cause renders.
  if (!additions.length) return previous;
  return [...previous, ...additions].slice(-MAX_READ_BILLING_NOTIFICATIONS);
}

export function countUnreadBillingNotifications(
  notifications: readonly BillingNotice[],
  readIds: readonly string[],
): number {
  const read = new Set(readIds);
  return notifications.filter((notice) => !read.has(notice.id)).length;
}

export function loadReadBillingNotificationIds(storage: Pick<Storage, 'getItem'> | null): string[] {
  try {
    return parseReadBillingNotificationIds(
      storage?.getItem(BILLING_NOTIFICATIONS_STORAGE_KEY) ?? null,
    );
  } catch {
    return [];
  }
}

export function saveReadBillingNotificationIds(
  storage: Pick<Storage, 'setItem'> | null,
  ids: readonly string[],
): void {
  try {
    storage?.setItem(BILLING_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Reading a notice still succeeds in memory when storage is disabled or full.
  }
}
