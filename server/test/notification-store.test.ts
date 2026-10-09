import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@/repositories/billing-store';
import type { BillingNotification, CollectionFailureNotification } from '@/types';

const notification = (
  id = 'oct:2026-10-08T12:00:00.000Z',
  observedAt: string | null = '2026-10-08T12:00:05.000Z',
): BillingNotification => ({
  id,
  cycle: {
    id: 'oct',
    start: '2026-10-01',
    end: '2026-11-01',
    currency: 'USD',
    baseFee: 5,
  },
  point: {
    timestamp: '2026-10-08T12:00:00.000Z',
    observedAt,
    currentTotal: 5.7,
    localTotal: 5.6,
    officialHistorical: 5.5,
    todayLocal: 0.2,
    source: 'collected',
  },
  warnings: ['历史日志量不完整'],
});

test('pending notifications and their original snapshots survive restart and duplicate enqueue', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-notification-store-'));
  const path = join(directory, 'billing.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  const original = notification();
  store.enqueueNotification(original);
  store.retryNotification(original.id, '2026-10-08T12:01:00.000Z', '请求超时');
  store.close();
  store = new Store(path);

  const revised = notification();
  revised.point.currentTotal = 99;
  revised.warnings = [];
  store.enqueueNotification(revised);
  assert.deepEqual(store.pendingNotifications('2026-10-08T12:00:59.999Z'), []);
  assert.deepEqual(store.pendingNotifications('2026-10-08T12:01:00.000Z'), [
    { notification: original, attempts: 1 },
  ]);
  assert.match(store.notificationErrors()[0]!, /已失败 1 次.*请求超时/);
});

test('sent notifications remain recorded and are never requeued across restarts or stale failures', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-notification-sent-'));
  const path = join(directory, 'billing.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  const item = notification();
  store.enqueueNotification(item);
  store.retryNotification(item.id, '2026-10-08T12:01:00.000Z', '请求超时');
  store.markNotificationSent(item.id, '2026-10-08T12:01:01.000Z');
  store.close();
  store = new Store(path);
  store.enqueueNotification(item);
  store.retryNotification(item.id, '2026-10-08T12:02:00.000Z', '过时失败');
  store.markNotificationSent(item.id, '2026-10-08T12:02:01.000Z');

  assert.deepEqual(store.pendingNotifications('2027-01-01T00:00:00.000Z'), []);
  assert.deepEqual(store.notificationErrors(), []);
  const retained = store.db
    .prepare('SELECT sent_at,attempts,last_error FROM notification_outbox WHERE id=?')
    .get(item.id) as { sent_at: string; attempts: number; last_error: string | null };
  assert.equal(retained.sent_at, '2026-10-08T12:01:01.000Z');
  assert.equal(retained.attempts, 1);
  assert.equal(retained.last_error, null);
});

test('retry timing and notification errors are independent from collection errors and success state', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const item = notification();
  store.set('lastSuccess', '2026-10-08T12:00:00.000Z');
  store.fail('usage:oct:2026-10-08', '用量请求失败', '2026-10-08T12:00:00.000Z');
  store.enqueueNotification(item);
  assert.deepEqual(store.notificationErrors(), []);
  store.retryNotification(item.id, '2026-10-08T12:01:00.000Z', '请求超时');
  assert.equal(store.pendingNotifications('2026-10-08T12:01:00.000Z')[0]!.attempts, 1);
  store.retryNotification(item.id, '2026-10-08T12:03:00.000Z', '飞书服务暂时不可用');
  assert.deepEqual(store.pendingNotifications('2026-10-08T12:02:59.999Z'), []);
  assert.equal(store.pendingNotifications('2026-10-08T12:03:00.000Z')[0]!.attempts, 2);
  assert.match(store.notificationErrors()[0]!, /飞书通知.*已失败 2 次.*飞书服务暂时不可用/);
  assert.deepEqual(store.errors(), ['用量请求失败']);
  assert.equal(store.get('lastSuccess'), '2026-10-08T12:00:00.000Z');
  store.markNotificationSent(item.id, '2026-10-08T12:03:01.000Z');
  assert.deepEqual(store.notificationErrors(), []);
  assert.deepEqual(store.errors(), ['用量请求失败']);
});

test('due notifications are ordered by observation then id, bounded, and fall back to slot time', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let index = 11; index >= 1; index--)
    store.enqueueNotification(notification(`same-time-${String(index).padStart(2, '0')}`));
  store.enqueueNotification(notification('earliest', null));
  store.enqueueNotification(notification('future', '2026-10-08T12:10:00.000Z'));
  const now = '2026-10-08T12:00:05.000Z';
  assert.equal(store.pendingNotifications(now).length, 10);
  assert.deepEqual(
    store.pendingNotifications(now, 2).map(({ notification }) => notification.id),
    ['earliest', 'same-time-01'],
  );
  assert.equal(store.pendingNotifications(now, 100).length, 12);
  assert.equal(store.pendingNotifications('2026-10-08T12:10:00.000Z', 100).length, 13);
});

test('collection failure snapshots survive restart, deduplicate by slot id, and share delivery retries', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-notification-failure-'));
  const path = join(directory, 'billing.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  const failure: CollectionFailureNotification = {
    kind: 'collection_failure',
    id: 'collection_failure:2026-10-08T12:00:00.000Z',
    attemptedAt: '2026-10-08T12:00:05.000Z',
    slot: '2026-10-08T12:00:00.000Z',
    cycle: null,
    errors: ['账单周期请求失败'],
    lastSuccessfulAt: '2026-10-08T11:50:00.000Z',
  };
  store.enqueueNotification(failure);
  assert.deepEqual(store.pendingNotifications('2026-10-08T12:00:04.999Z'), []);
  assert.deepEqual(store.pendingNotifications(failure.attemptedAt), [
    { notification: failure, attempts: 0 },
  ]);
  store.retryNotification(failure.id, '2026-10-08T12:10:00.000Z', '飞书 HTTP 503');
  store.close();
  store = new Store(path);
  store.enqueueNotification({
    ...failure,
    attemptedAt: '2026-10-08T12:00:06.000Z',
    errors: ['同一采集槽的后续错误'],
  });
  assert.deepEqual(store.pendingNotifications('2026-10-08T12:09:59.999Z'), []);
  assert.deepEqual(store.pendingNotifications('2026-10-08T12:10:00.000Z'), [
    { notification: failure, attempts: 1 },
  ]);
  assert.match(store.notificationErrors()[0]!, /已失败 1 次.*飞书 HTTP 503/);
  assert.deepEqual(store.errors(), []);
  store.markNotificationSent(failure.id, '2026-10-08T12:10:01.000Z');
  store.enqueueNotification(failure);
  assert.deepEqual(store.pendingNotifications('2026-10-08T12:20:00.000Z'), []);
  assert.deepEqual(store.notificationErrors(), []);
});

test('last collected time excludes restored history and finds the newest realtime observation across cycles', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const current = notification();
  const previous = {
    ...current.cycle,
    id: 'sep',
    start: '2026-09-01',
    end: '2026-10-01',
  };
  store.saveCycle(previous);
  store.saveCycle(current.cycle);
  assert.equal(store.lastCollectedAt(), null);
  store.saveBillingPoint(
    current.cycle.id,
    { ...current.point, source: 'reconstructed' },
    'recovery',
    '2026-10-08T12:05:00.000Z',
  );
  store.set('lastUsageSuccess', '2026-10-08T12:05:00.000Z');
  assert.equal(store.lastCollectedAt(), null, 'backfill and reconstruction are not live sampling');
  store.saveBillingPoint(
    previous.id,
    {
      ...current.point,
      timestamp: '2026-09-30T23:50:00.000Z',
      observedAt: '2026-09-30T23:50:03.000Z',
    },
    'collection',
    '2026-09-30T23:50:05.000Z',
  );
  assert.equal(store.lastCollectedAt(), '2026-09-30T23:50:03.000Z');
  store.saveBillingPoint(
    current.cycle.id,
    {
      ...current.point,
      timestamp: '2026-10-08T11:50:00.000Z',
      observedAt: '2026-10-08T11:50:04.000Z',
    },
    'collection',
    '2026-10-08T11:50:08.000Z',
  );
  assert.equal(store.lastCollectedAt(), '2026-10-08T11:50:04.000Z');
});
