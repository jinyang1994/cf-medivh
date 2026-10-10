import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BILLING_NOTIFICATIONS_STORAGE_KEY,
  MAX_READ_BILLING_NOTIFICATIONS,
  buildBillingNotifications,
  countUnreadBillingNotifications,
  loadReadBillingNotificationIds,
  parseReadBillingNotificationIds,
  rememberReadBillingNotificationIds,
  saveReadBillingNotificationIds,
} from '../src/utils/billing-notifications.ts';

test('duplicate notices appear once, with errors taking precedence over warnings', () => {
  const notifications = buildBillingNotifications(
    'cycle-1',
    [' timeout ', 'timeout', ''],
    ['timeout', 'partial data', 'partial data', '  '],
  );
  assert.deepEqual(
    notifications.map(({ kind, message }) => [kind, message]),
    [
      ['error', 'timeout'],
      ['warning', 'partial data'],
    ],
  );
});

test('polling and reordered notices preserve identities and existing read state', () => {
  const original = buildBillingNotifications('cycle-1', ['timeout'], ['partial data', 'delayed']);
  const read = rememberReadBillingNotificationIds(
    [],
    original.map((notice) => notice.id),
  );
  const refreshed = buildBillingNotifications('cycle-1', ['timeout'], ['delayed', 'partial data']);
  assert.deepEqual(refreshed, original);
  assert.equal(countUnreadBillingNotifications(refreshed, read), 0);
  assert.equal(
    rememberReadBillingNotificationIds(
      read,
      refreshed.map((notice) => notice.id),
    ),
    read,
  );
});

test('only a new message, severity, or billing cycle becomes unread', () => {
  const original = buildBillingNotifications('cycle-1', [], ['partial data']);
  const read = rememberReadBillingNotificationIds(
    [],
    original.map((notice) => notice.id),
  );
  assert.equal(
    countUnreadBillingNotifications(
      buildBillingNotifications('cycle-1', [], ['partial data', 'delayed']),
      read,
    ),
    1,
  );
  assert.equal(
    countUnreadBillingNotifications(
      buildBillingNotifications('cycle-2', [], ['partial data']),
      read,
    ),
    1,
  );
  assert.equal(
    countUnreadBillingNotifications(
      buildBillingNotifications('cycle-1', ['partial data'], []),
      read,
    ),
    1,
  );
});

test('a notice that disappears and returns stays read; newly visible notices can be read together', () => {
  const original = buildBillingNotifications('cycle-1', [], ['partial data']);
  const read = rememberReadBillingNotificationIds(
    [],
    original.map((notice) => notice.id),
  );
  assert.equal(rememberReadBillingNotificationIds(read, []), read);
  assert.equal(countUnreadBillingNotifications(original, read), 0);
  const whileOpen = buildBillingNotifications('cycle-1', ['timeout'], ['partial data']);
  const afterViewing = rememberReadBillingNotificationIds(
    read,
    whileOpen.map((notice) => notice.id),
  );
  assert.equal(countUnreadBillingNotifications(whileOpen, afterViewing), 0);
  assert.equal(afterViewing.length, 2);
});

test('stored read notices survive a reload and merge reads from another tab', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const notices = buildBillingNotifications('cycle-1', ['timeout'], ['partial data']);
  saveReadBillingNotificationIds(storage, [notices[0].id]);
  assert.equal(
    countUnreadBillingNotifications(notices, loadReadBillingNotificationIds(storage)),
    1,
  );
  const merged = rememberReadBillingNotificationIds(
    [notices[1].id],
    loadReadBillingNotificationIds(storage),
  );
  saveReadBillingNotificationIds(storage, merged);
  assert.equal(
    countUnreadBillingNotifications(notices, loadReadBillingNotificationIds(storage)),
    0,
  );
  assert.ok(values.has(BILLING_NOTIFICATIONS_STORAGE_KEY));
});

test('corrupt or unavailable storage is harmless and does not prevent in-memory reads', () => {
  for (const value of [null, '{broken', '{}', 'null', '42']) {
    assert.deepEqual(parseReadBillingNotificationIds(value), []);
  }
  assert.deepEqual(parseReadBillingNotificationIds('["a",42,null,"a","","b"]'), ['a', 'b']);
  const blockedStorage = {
    getItem: () => {
      throw new Error('Storage unavailable');
    },
    setItem: () => {
      throw new Error('Quota exceeded');
    },
  };
  assert.deepEqual(loadReadBillingNotificationIds(blockedStorage), []);
  assert.deepEqual(loadReadBillingNotificationIds(null), []);
  const notices = buildBillingNotifications(null, ['timeout'], []);
  const memory = rememberReadBillingNotificationIds(
    [],
    notices.map((notice) => notice.id),
  );
  assert.doesNotThrow(() => saveReadBillingNotificationIds(blockedStorage, memory));
  assert.doesNotThrow(() => saveReadBillingNotificationIds(null, memory));
  assert.equal(countUnreadBillingNotifications(notices, memory), 0);
});

test('read history stays bounded while retaining the most recently added notices', () => {
  const ids = Array.from({ length: MAX_READ_BILLING_NOTIFICATIONS + 20 }, (_, i) => `notice-${i}`);
  assert.deepEqual(rememberReadBillingNotificationIds([], ids), ids.slice(20));
  assert.deepEqual(parseReadBillingNotificationIds(JSON.stringify(ids)), ids.slice(20));
  const next = rememberReadBillingNotificationIds(ids.slice(20), ['newest']);
  assert.equal(next.length, MAX_READ_BILLING_NOTIFICATIONS);
  assert.equal(next[0], 'notice-21');
  assert.equal(next.at(-1), 'newest');
});
