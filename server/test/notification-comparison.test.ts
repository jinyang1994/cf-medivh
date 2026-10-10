import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@/repositories/billing-store';
import { createFeishuExtension } from '@/resources/notifications';
import { NotificationDispatcher } from '@/services/notifications';
import type {
  BillingNotification,
  BudgetAlertNotification,
  CollectionFailureNotification,
  NotificationExtension,
} from '@/types';

function billing(id: string, observedAt: string, total = 5): BillingNotification {
  return {
    kind: 'billing',
    id,
    cycle: {
      id: 'oct',
      start: '2026-10-01',
      end: '2026-11-01',
      currency: 'USD',
      baseFee: 5,
    },
    point: {
      timestamp: observedAt,
      observedAt,
      currentTotal: total,
      localTotal: total - 0.1,
      officialHistorical: 5,
      todayLocal: total - 5,
      source: 'collected',
    },
    warnings: [],
  };
}

const failure: CollectionFailureNotification = {
  kind: 'collection_failure',
  id: 'failure',
  attemptedAt: '2026-10-08T12:20:00.000Z',
  slot: '2026-10-08T12:20:00.000Z',
  cycle: null,
  errors: ['采集暂时失败'],
  lastSuccessfulAt: '2026-10-08T12:10:00.000Z',
};

const budget: BudgetAlertNotification = {
  kind: 'budget_exceeded',
  id: 'budget',
  cycle: billing('unused', '2026-10-08T12:00:00.000Z').cycle,
  observedAt: '2026-10-08T12:30:00.000Z',
  metric: 'currentTotal',
  thresholdCents: 500,
  amountUsd: 6,
};

test('the previous report survives restart and accepts legacy billing payloads without a kind', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-previous-report-'));
  const path = join(directory, 'billing.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  assert.equal(store.lastSentBillingNotification(), null);
  const original = billing('legacy', '2026-10-08T12:00:00.000Z', 5.1);
  delete original.kind;
  store.enqueueNotification(original);
  assert.equal(store.lastSentBillingNotification(), null, 'queued is not delivered');
  store.markNotificationSent(original.id, '2026-10-08T12:00:01.000Z');
  store.close();
  store = new Store(path);

  const revised = { ...original, point: { ...original.point, currentTotal: 99 } };
  store.enqueueNotification(revised);
  const pending = billing('pending', '2026-10-08T12:10:00.000Z', 5.2);
  store.enqueueNotification(pending);
  store.retryNotification(pending.id, '2026-10-08T12:20:00.000Z', '发送失败');
  assert.deepEqual(store.lastSentBillingNotification(), original);
  assert.equal(store.lastSentBillingNotification('other-target'), null);
});

test('the comparison baseline follows delivery order and ignores successfully sent failure and budget events', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const newerObservation = billing('newer-observation', '2026-10-08T12:10:00.000Z', 5.2);
  const laterDelivery = billing('later-delivery', '2026-10-08T12:00:00.000Z', 5.1);
  store.enqueueNotification(newerObservation);
  store.markNotificationSent(newerObservation.id, '2026-10-08T12:11:00.000Z');
  store.enqueueNotification(laterDelivery);
  store.markNotificationSent(laterDelivery.id, '2026-10-08T12:12:00.000Z');
  store.enqueueNotification(failure);
  store.markNotificationSent(failure.id, '2026-10-08T12:20:01.000Z');
  store.enqueueNotification(budget);
  store.markNotificationSent(budget.id, '2026-10-08T12:30:01.000Z');

  assert.deepEqual(store.lastSentBillingNotification(), laterDelivery);
  store.enqueueNotification(newerObservation, 'another-target');
  store.markNotificationSent(newerObservation.id, '2026-10-08T12:40:00.000Z', 'another-target');
  assert.deepEqual(store.lastSentBillingNotification('another-target'), newerObservation);
  assert.deepEqual(store.lastSentBillingNotification(), laterDelivery);
});

test('Feishu retries retain the last successful report and advance the baseline only after delivery succeeds', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let now = new Date('2026-10-08T12:00:00.000Z');
  let failNext = false;
  const attempts: { id: string; previous: BillingNotification | null | undefined }[] = [];
  const dispatcher = new NotificationDispatcher(
    store,
    [
      createFeishuExtension(async (notification, previous) => {
        attempts.push({ id: notification.id, previous });
        assert.deepEqual(store.lastSentBillingNotification(), previous);
        if (failNext) {
          failNext = false;
          throw new Error('飞书 HTTP 503');
        }
      }),
    ],
    () => now,
  );
  const first = billing('first', now.toISOString(), 5.1);
  dispatcher.enqueue(first);
  await dispatcher.deliver();
  assert.deepEqual(store.lastSentBillingNotification(), first);

  now = new Date('2026-10-08T12:10:00.000Z');
  const second = billing('second', now.toISOString(), 5.2);
  failNext = true;
  dispatcher.enqueue(second);
  await dispatcher.deliver();
  assert.deepEqual(store.lastSentBillingNotification(), first);
  assert.equal(store.pendingNotifications('2026-10-08T12:20:00.000Z')[0]!.attempts, 1);

  now = new Date('2026-10-08T12:20:00.000Z');
  await dispatcher.deliver();
  assert.deepEqual(store.lastSentBillingNotification(), second);

  now = new Date('2026-10-08T12:30:00.000Z');
  const third = billing('third', now.toISOString(), 5.3);
  dispatcher.enqueue(third);
  await dispatcher.deliver();
  assert.deepEqual(attempts, [
    { id: first.id, previous: null },
    { id: second.id, previous: first },
    { id: second.id, previous: first },
    { id: third.id, previous: second },
  ]);
});

test('a restarted dispatcher compares with the persisted report and passes no baseline to non-billing events', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-report-dispatch-'));
  const path = join(directory, 'billing.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  const previous = billing('previous', '2026-10-08T12:10:00.000Z', 5.1);
  delete previous.kind;
  store.enqueueNotification(previous);
  store.markNotificationSent(previous.id, '2026-10-08T12:10:01.000Z');
  store.close();
  store = new Store(path);

  let now = new Date('2026-10-08T12:20:00.000Z');
  const attempts: { id: string; previous: BillingNotification | null | undefined }[] = [];
  const extension: NotificationExtension = {
    id: 'feishu',
    label: '测试通知',
    prepare: (notification) => notification,
    async send(notification, prior) {
      attempts.push({ id: notification.id, previous: prior });
    },
  };
  const dispatcher = new NotificationDispatcher(store, [extension], () => now);
  dispatcher.enqueue(failure);
  await dispatcher.deliver();
  now = new Date(budget.observedAt);
  store.enqueueNotification(budget);
  await dispatcher.deliver();
  assert.deepEqual(store.lastSentBillingNotification(), previous);

  now = new Date('2026-10-08T12:40:00.000Z');
  const current = billing('current', now.toISOString(), 5.3);
  dispatcher.enqueue(current);
  await dispatcher.deliver();
  assert.deepEqual(attempts, [
    { id: failure.id, previous: null },
    { id: budget.id, previous: null },
    { id: current.id, previous },
  ]);
  assert.deepEqual(store.lastSentBillingNotification(), current);
});

test('each notification target receives only its own successful comparison baseline', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const feishuPrevious = billing('feishu-previous', '2026-10-08T12:00:00.000Z', 5.1);
  const otherPrevious = billing('other-previous', '2026-10-08T12:10:00.000Z', 5.2);
  store.enqueueNotification(feishuPrevious);
  store.markNotificationSent(feishuPrevious.id, '2026-10-08T12:00:01.000Z');
  store.enqueueNotification(otherPrevious, 'another-target');
  store.markNotificationSent(otherPrevious.id, '2026-10-08T12:10:01.000Z', 'another-target');
  const attempts = new Map<string, BillingNotification | null | undefined>();
  const extensions: NotificationExtension[] = ['feishu', 'another-target', 'new-target'].map(
    (id) => ({
      id,
      label: id,
      prepare: (notification) => notification,
      async send(_notification, previous) {
        attempts.set(id, previous);
      },
    }),
  );
  const now = new Date('2026-10-08T12:20:00.000Z');
  const dispatcher = new NotificationDispatcher(store, extensions, () => now);
  const current = billing('current', now.toISOString(), 5.3);
  dispatcher.enqueue(current);
  await dispatcher.deliver();

  assert.deepEqual(attempts.get('feishu'), feishuPrevious);
  assert.deepEqual(attempts.get('another-target'), otherPrevious);
  assert.equal(attempts.get('new-target'), null);
  for (const extension of extensions)
    assert.deepEqual(store.lastSentBillingNotification(extension.id), current);
});
