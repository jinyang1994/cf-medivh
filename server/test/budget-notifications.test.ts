import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';
import { createBudgetExtension, createFeishuExtension } from '@/resources/notifications';
import type {
  BillingCycle,
  BillingNotification,
  BudgetAlertNotification,
  CloudflareProvider,
  Notification,
} from '@/types';

const cycle: BillingCycle = {
  id: 'budget-oct',
  start: '2026-10-01',
  end: '2026-11-01',
  currency: 'USD',
  baseFee: 0,
};

function fixture(
  clock: () => Date,
  amount: () => number = () => 350,
  period: () => BillingCycle = () => cycle,
): CloudflareProvider {
  return {
    getBillingCycle: async () => period(),
    getUsage: async (billingCycle, date) => ({
      date,
      observedAt: clock().toISOString(),
      complete: true,
      source: 'analytics',
      meters: [
        {
          key: 'requests',
          service: 'Workers',
          name: '请求',
          unit: '次',
          quantity: date === clock().toISOString().slice(0, 10) ? amount() : 0,
          pricing: {
            currency: billingCycle.currency,
            unitPrice: 1,
            unitSize: 1,
            includedQuantity: 0,
          },
        },
      ],
    }),
    getOfficialBill: async (billingCycle, through) => ({
      through,
      amount: 0,
      currency: billingCycle.currency,
    }),
  };
}

function billing(amount: number | null): BillingNotification {
  return {
    id: 'usage:1',
    cycle,
    warnings: [],
    point: {
      timestamp: '2026-10-01T12:00:00.000Z',
      observedAt: '2026-10-01T12:00:03.000Z',
      currentTotal: amount,
      localTotal: 999,
      officialHistorical: 250,
      todayLocal: 50,
      source: 'collected',
    },
  };
}

test('budget extension compares current USD dollars strictly against integer cents without rounding away sub-cent excess', () => {
  const extension = createBudgetExtension(30000, async () => {});
  for (const amount of [null, 0, 299.999999, 300, Number.NaN, Number.POSITIVE_INFINITY])
    assert.equal(extension.prepare(billing(amount)), null);
  const alert = extension.prepare(billing(300.000001));
  assert.ok(alert && alert.kind === 'budget_exceeded');
  assert.deepEqual(alert, {
    kind: 'budget_exceeded',
    id: alert.id,
    cycle,
    observedAt: '2026-10-01T12:00:03.000Z',
    metric: 'currentTotal',
    thresholdCents: 30000,
    amountUsd: 300.000001,
  });
  assert.equal(createBudgetExtension(7, async () => {}).prepare(billing(0.07)), null);
  assert.ok(createBudgetExtension(7, async () => {}).prepare(billing(0.070001)));
  assert.equal(extension.prepare({ ...billing(500), cycle: { ...cycle, currency: 'EUR' } }), null);
  assert.equal(
    extension.prepare({
      kind: 'collection_failure',
      id: 'failure:1',
      attemptedAt: '2026-10-01T12:00:03.000Z',
      slot: '2026-10-01T12:00:00.000Z',
      cycle,
      errors: ['采集失败'],
      lastSuccessfulAt: null,
    }),
    null,
  );
  const changedThreshold = createBudgetExtension(10000, async () => {}).prepare({
    ...billing(700),
    id: 'usage:another-snapshot',
  });
  assert.equal(changedThreshold?.id, alert.id, 'the billing cycle owns the event identity');
});

test('budget comparison preserves integer-cent boundaries near the safe-integer limit and scientific notation', () => {
  const extension = createBudgetExtension(9007199254740987, async () => {});
  assert.ok(extension.prepare(billing(90071992547409.88)));
  assert.equal(extension.prepare(billing(90071992547409.86)), null);
  assert.equal(createBudgetExtension(1, async () => {}).prepare(billing(1e-7)), null);
  assert.ok(extension.prepare(billing(1e21)));
});

test('budget collection uses official bill plus today prediction and creates no delivery for disabled or ineligible data', async () => {
  for (const mode of ['enabled', 'disabled', 'unknown-total', 'non-usd', 'failed']) {
    const store = new Store(':memory:');
    const now = new Date('2026-10-02T12:00:00Z');
    const provider = fixture(
      () => now,
      () => 2,
      () => ({ ...cycle, currency: mode === 'non-usd' ? 'EUR' : 'USD' }),
    );
    provider.getOfficialBill = async (period, through) =>
      mode === 'unknown-total' ? null : { through, amount: 310, currency: period.currency };
    if (mode === 'failed')
      provider.getUsage = async () => {
        throw new Error('用量不可用');
      };
    const sent: BudgetAlertNotification[] = [];
    const extension = createBudgetExtension(30000, async (item) => {
      sent.push(item);
    });
    try {
      await new Collector(
        store,
        provider,
        () => now,
        mode === 'disabled' ? [] : [extension],
      ).tick();
      assert.equal(sent.length, mode === 'enabled' ? 1 : 0, mode);
      if (mode === 'enabled') {
        assert.equal(sent[0]!.amountUsd, 312);
        assert.equal(store.billingPoints(cycle.id).at(-1)?.localTotal, 2);
      } else {
        assert.equal(
          (
            store.db.prepare('SELECT COUNT(*) AS count FROM notification_outbox').get() as {
              count: number;
            }
          ).count,
          0,
          mode,
        );
      }
    } finally {
      store.close();
    }
  }
});

test('successful budget delivery happens once per cycle across restart, force, recrossing, and threshold changes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-budget-once-'));
  const path = join(directory, 'billing.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  let now = new Date('2026-10-01T12:00:00Z');
  let amount = 350;
  let period = cycle;
  const provider = fixture(
    () => now,
    () => amount,
    () => period,
  );
  const sent: BudgetAlertNotification[] = [];
  const sender = async (item: BudgetAlertNotification) => {
    sent.push(item);
  };
  const collect = (threshold = 30000) =>
    new Collector(store, provider, () => now, [createBudgetExtension(threshold, sender)]);
  await collect().tick();
  assert.equal(sent.length, 1);
  store.close();
  store = new Store(path);
  assert.equal(await collect().tick(), false);
  await collect().tick(true);
  now = new Date('2026-10-01T12:10:00Z');
  await collect().tick();
  amount = 100;
  now = new Date('2026-10-01T12:20:00Z');
  await collect().tick();
  amount = 400;
  now = new Date('2026-10-01T12:30:00Z');
  await collect(20000).tick();
  assert.equal(sent.length, 1);
  assert.equal(
    store.usageSnapshotEvidence(cycle.id).length,
    5,
    'forced collection really sampled again',
  );
  period = { ...cycle, id: 'budget-nov', start: '2026-11-01', end: '2026-12-01' };
  now = new Date('2026-11-01T12:00:00Z');
  await collect().tick();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0]!.id, sent[1]!.id);
  assert.equal(sent[1]!.cycle.id, period.id);
});

test('failed Feishu delivery does not prevent the budget webhook from succeeding', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const now = new Date('2026-10-01T12:00:00Z');
  const sent: BudgetAlertNotification[] = [];
  await new Collector(
    store,
    fixture(() => now),
    () => now,
    [
      createFeishuExtension(async () => {
        throw new Error('飞书不可用');
      }),
      createBudgetExtension(30000, async (item) => {
        sent.push(item);
      }),
    ],
  ).tick();
  assert.equal(sent.length, 1);
  assert.equal(store.pendingNotifications('2026-10-01T12:10:00.000Z').length, 1);
  assert.deepEqual(
    store.pendingNotifications('2026-10-01T12:10:00.000Z', 10, 'budget-webhook'),
    [],
  );
  assert.deepEqual(store.errors(), []);
  assert.equal(store.get('lastSuccess'), now.toISOString());
});

test('budget failures retry in the same collection until success and leave successful Feishu delivery alone', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const now = new Date('2026-10-01T12:00:00Z');
  const attempted: BudgetAlertNotification[] = [];
  const feishu: Notification[] = [];
  const collector = new Collector(
    store,
    fixture(() => now),
    () => now,
    [
      createFeishuExtension(async (item) => {
        feishu.push(item);
      }),
      createBudgetExtension(30000, async (item) => {
        attempted.push(item);
        assert.deepEqual(store.errors(), []);
        assert.equal(store.get('lastSuccess'), now.toISOString());
        if (attempted.length < 3) throw new Error('接收方暂时不可用');
      }),
    ],
  );
  await collector.tick();
  assert.equal(attempted.length, 3, 'failed delivery is retried before the tick completes');
  assert.deepEqual(attempted[1], attempted[0]);
  assert.deepEqual(attempted[2], attempted[0]);
  assert.equal(feishu.length, 1);
  assert.deepEqual(store.notificationErrors(), []);
  assert.deepEqual(
    store.pendingNotifications('2026-10-02T00:00:00.000Z', 10, 'budget-webhook'),
    [],
  );
  await collector.tick(true);
  assert.equal(attempted.length, 3, 'successful cycle remains completed');
  assert.equal(feishu.length, 2, 'later real collections still notify Feishu');
});

test('stopping failed budget delivery preserves its original snapshot for restart despite changed settings and amounts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-budget-retry-'));
  const path = join(directory, 'billing.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  let now = new Date('2026-10-01T12:00:00Z');
  let amount = 350;
  const provider = fixture(
    () => now,
    () => amount,
  );
  const attempted: BudgetAlertNotification[] = [];
  const feishu: Notification[] = [];
  let collector: Collector;
  collector = new Collector(store, provider, () => now, [
    createFeishuExtension(async (item) => {
      feishu.push(item);
    }),
    createBudgetExtension(30000, async (item) => {
      attempted.push(item);
      collector.stop();
      throw new Error('接收方暂时不可用');
    }),
  ]);
  await collector.tick();
  assert.equal(attempted.length, 1);
  assert.equal(feishu.length, 1);
  assert.deepEqual(store.errors(), []);
  assert.equal(store.get('lastSuccess'), now.toISOString());
  const pending = store.pendingNotifications('2026-10-02T00:00:00.000Z', 10, 'budget-webhook');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.attempts, 1);
  assert.equal(attempted[0]!.thresholdCents, 30000);
  assert.equal(attempted[0]!.amountUsd, 350);
  assert.equal(attempted[0]!.observedAt, '2026-10-01T12:00:00.000Z');
  store.close();
  store = new Store(path);
  amount = 100;
  now = new Date('2026-10-01T12:10:00Z');
  collector = new Collector(store, provider, () => now, [
    createFeishuExtension(async (item) => {
      feishu.push(item);
    }),
    createBudgetExtension(20000, async (item) => {
      attempted.push(item);
    }),
  ]);
  await collector.tick();
  assert.equal(attempted.length, 2);
  assert.deepEqual(attempted[1], attempted[0]);
  assert.equal(feishu.length, 2);
  assert.notEqual(feishu[0]!.id, feishu[1]!.id, 'successful Feishu delivery was not retried');
  assert.deepEqual(store.notificationErrors(), []);
  assert.deepEqual(
    store.pendingNotifications('2026-10-02T00:00:00.000Z', 10, 'budget-webhook'),
    [],
  );
  amount = 500;
  now = new Date('2026-10-01T12:20:00Z');
  await collector.tick();
  assert.equal(attempted.length, 2, 'successful cycle remains completed');
});

test('the same collector can start again after stopping a failed budget delivery', async (t) => {
  const store = new Store(':memory:');
  const now = new Date('2026-10-01T12:00:00Z');
  const attempted: BudgetAlertNotification[] = [];
  const collector = new Collector(
    store,
    fixture(() => now),
    () => now,
    [
      createBudgetExtension(30000, async (item) => {
        attempted.push(item);
        if (attempted.length === 1) {
          collector.stop();
          throw new Error('接收方暂时不可用');
        }
      }),
    ],
  );
  t.after(() => {
    collector.stop();
    store.close();
  });
  await collector.start();
  assert.equal(attempted.length, 1);
  assert.equal(collector.nextRun, null);
  assert.equal(store.pendingNotifications(now.toISOString(), 10, 'budget-webhook').length, 1);

  await collector.start();
  assert.equal(attempted.length, 2);
  assert.deepEqual(attempted[1], attempted[0]);
  assert.deepEqual(store.pendingNotifications(now.toISOString(), 10, 'budget-webhook'), []);
  assert.deepEqual(store.notificationErrors(), []);
  assert.equal(
    store.usageSnapshotEvidence(cycle.id).length,
    1,
    'same-slot restart only resumes delivery',
  );
  assert.equal(collector.nextRun, '2026-10-01T12:10:00.000Z');
  collector.stop();
  assert.equal(collector.nextRun, null);
});
