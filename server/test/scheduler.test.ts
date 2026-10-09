import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';
import { dashboard } from '@/services/dashboard';
import { nextSlot } from '@/utils/dates';
import type { BillingCycle, CloudflareProvider, UsageReport } from '@/types';

const cycle: BillingCycle = {
  id: 'oct',
  start: '2026-10-01',
  end: '2026-11-01',
  currency: 'USD',
  baseFee: 5,
};
const usage = (date: string, quantity = 10): UsageReport => ({
  date,
  observedAt: `${date}T23:59:59Z`,
  complete: true,
  meters: [
    {
      key: 'requests',
      service: 'Workers',
      name: 'Requests',
      unit: 'request',
      quantity,
      pricing: { currency: 'USD', unitPrice: 1, unitSize: 10, includedQuantity: 0 },
    },
  ],
});

test('retains snapshots while replacing cumulative day quantities instead of adding them', () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  store.saveUsage(cycle, usage('2026-10-01', 10), false);
  store.saveUsage(cycle, usage('2026-10-01', 20), false);
  const provider = {} as CloudflareProvider;
  const view = dashboard(store, new Collector(store, provider), new Date('2026-10-01T23:00:00Z'));
  assert.equal(view.totals.current, 7);
  assert.equal(view.services[0]!.quantity, 20);
  assert.equal(
    (store.db.prepare('SELECT count(*) as n FROM usage_snapshots').get() as { n: number }).n,
    2,
  );
  store.close();
});

test('official failures retry on the next UTC slot, persist over restart, and correct the live total', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-billing-test-'));
  const path = join(directory, 'billing.sqlite');
  let now = new Date('2026-10-03T00:00:01Z');
  let fail = true;
  let officialCalls = 0;
  const provider: CloudflareProvider = {
    getBillingCycle: async () => cycle,
    getUsage: async (_cycle, date) => usage(date),
    getOfficialBill: async (_cycle, date) => {
      officialCalls++;
      if (fail) return null;
      return { through: date, amount: date === '2026-10-01' ? 6.1 : 7.2, currency: 'USD' };
    },
  };
  let store = new Store(path);
  let collector = new Collector(store, provider, () => now);
  await collector.tick();
  assert.equal(officialCalls, 2);
  assert.equal(dashboard(store, collector, now).totals.current, null);
  assert.equal(store.usage(cycle.id).get('2026-10-02')!.finalized, true);
  store.close();
  store = new Store(path);
  collector = new Collector(store, provider, () => now);
  await collector.tick();
  assert.equal(officialCalls, 2, 'same persisted slot must not duplicate attempts');
  now = new Date('2026-10-03T00:10:00Z');
  fail = false;
  await collector.tick();
  const view = dashboard(store, collector, now);
  assert.equal(officialCalls, 4);
  assert.equal(view.totals.current, 8.2);
  assert.equal(view.totals.localCumulative, 8);
  assert.equal(view.history.find((r) => r.date === '2026-10-02')!.difference, -0.2);
  assert.equal(store.bills(cycle.id).get('2026-10-02')!.localTotal, 7);
  now = new Date('2026-10-03T00:20:00Z');
  await collector.tick();
  assert.equal(
    officialCalls,
    6,
    'recent successful totals are rechecked for delayed provider revisions',
  );
  assert.deepEqual(view.collection.pendingOfficialDates, []);
  store.close();
  rmSync(directory, { recursive: true });
});

test('midnight finalizes yesterday and recovers the old cycle after rollover', async () => {
  const old = { ...cycle, id: 'sep', start: '2026-09-30', end: '2026-10-01' };
  const store = new Store(':memory:');
  store.saveCycle(old);
  store.saveUsage(old, usage('2026-09-30', 1), false);
  const requests: string[] = [];
  const provider: CloudflareProvider = {
    getBillingCycle: async () => cycle,
    getUsage: async (c, date) => {
      requests.push(`${c.id}:${date}`);
      return usage(date, 10);
    },
    getOfficialBill: async (_c, date) => ({ through: date, amount: 6, currency: 'USD' }),
  };
  const now = new Date('2026-10-01T00:00:00Z');
  const collector = new Collector(store, provider, () => now);
  await collector.tick();
  assert.deepEqual(requests, ['oct:2026-10-01', 'sep:2026-09-30']);
  assert.equal(store.bills('sep').get('2026-09-30')!.localTotal, 6);
  assert.equal(dashboard(store, collector, now).cycle!.id, 'oct');
  store.close();
});

test('partial service collection remains visible, incomplete and retryable', async () => {
  const store = new Store(':memory:');
  let complete = false;
  let now = new Date('2026-10-02T00:00:00Z');
  const provider: CloudflareProvider = {
    getBillingCycle: async () => cycle,
    getUsage: async (_c, date) => ({
      ...usage(date),
      observedAt:
        date === now.toISOString().slice(0, 10) ? now.toISOString() : usage(date).observedAt,
      complete,
      warnings: complete ? [] : ['R2 请求失败'],
    }),
    getOfficialBill: async (_c, date) => ({ through: date, amount: 6, currency: 'USD' }),
  };
  const collector = new Collector(store, provider, () => now);
  await collector.tick();
  const first = dashboard(store, collector, now);
  assert.equal(first.totals.current, null);
  assert.equal(first.history[0]!.officialTotal, 6);
  assert.equal(first.history[0]!.localTotal, null);
  complete = true;
  now = new Date('2026-10-02T00:10:00Z');
  await collector.tick();
  assert.equal(store.bills(cycle.id).get('2026-10-01')!.localComplete, true);
  assert.equal(dashboard(store, collector, now).totals.current, 7);
  assert.deepEqual(store.errors(), []);
  store.close();
});
test('ten minute schedule aligns to UTC boundaries', () => {
  assert.equal(
    nextSlot(new Date('2026-10-03T23:58:13Z')).toISOString(),
    '2026-10-04T00:00:00.000Z',
  );
});

test('late official revisions update the comparison while preserving the original paired record', async () => {
  const store = new Store(':memory:');
  let now = new Date('2026-10-02T00:00:00Z');
  let amount = 6;
  const provider: CloudflareProvider = {
    getBillingCycle: async () => cycle,
    getUsage: async (_c, date) => usage(date),
    getOfficialBill: async (_c, date) => ({ through: date, amount, currency: 'USD' }),
  };
  const collector = new Collector(store, provider, () => now);
  await collector.tick();
  amount = 6.2;
  now = new Date('2026-10-02T00:10:00Z');
  await collector.tick();
  assert.equal(store.bills(cycle.id).get('2026-10-01')!.bill.amount, 6.2);
  assert.equal(dashboard(store, collector, now).history[0]!.difference, -0.2);
  const versions = store.db
    .prepare(
      'SELECT amount,local_total FROM reconciliation_versions WHERE local_complete=1 ORDER BY id',
    )
    .all() as { amount: number; local_total: number }[];
  assert.deepEqual(
    versions.map((row) => ({ ...row })),
    [
      { amount: 6, local_total: 6 },
      { amount: 6.2, local_total: 6 },
    ],
  );
  store.close();
});

test('a revised bill waits for a successful analytics refresh before claiming its local comparison is complete', async () => {
  const store = new Store(':memory:');
  let now = new Date('2026-10-02T00:00:00Z');
  let amount = 6;
  let failing = false;
  const provider: CloudflareProvider = {
    getBillingCycle: async () => cycle,
    getUsage: async (_c, date) => {
      if (failing && date === '2026-10-01') throw new Error('temporary analytics outage');
      return usage(date);
    },
    getOfficialBill: async (_c, date) => ({ through: date, amount, currency: 'USD' }),
  };
  const collector = new Collector(store, provider, () => now);
  await collector.tick();
  amount = 6.2;
  failing = true;
  now = new Date('2026-10-02T00:10:00Z');
  await collector.tick();
  const pending = store.bills(cycle.id).get('2026-10-01')!;
  assert.equal(pending.bill.amount, 6.2);
  assert.equal(pending.localComplete, false);
  assert.equal(pending.localTotal, null);
  failing = false;
  now = new Date('2026-10-02T00:20:00Z');
  await collector.tick();
  assert.equal(store.bills(cycle.id).get('2026-10-01')!.localComplete, true);
  store.close();
});

test('separate collectors cannot overlap and an abandoned lease can expire', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-billing-lock-'));
  const path = join(directory, 'billing.sqlite');
  const first = new Store(path),
    second = new Store(path);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: CloudflareProvider = {
    getBillingCycle: async () => {
      await blocked;
      return cycle;
    },
    getUsage: async (_c, date) => usage(date),
    getOfficialBill: async () => null,
  };
  const now = () => new Date('2026-10-01T01:00:00Z');
  const running = new Collector(first, provider, now).tick(true);
  assert.equal(await new Collector(second, provider, now).tick(true), false);
  release();
  assert.equal(await running, true);
  assert.equal(first.collectionActive(), false);
  assert.equal(first.acquireLease('a', 1000, 50), true);
  assert.equal(second.acquireLease('b', 1049, 50), false);
  assert.equal(second.acquireLease('b', 1050, 50), true);
  first.releaseLease('a');
  assert.equal(first.acquireLease('c', 1051, 50), false);
  first.close();
  second.close();
  rmSync(directory, { recursive: true });
});

test('resolved historical warnings disappear while retained-history coverage warnings persist', () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  store.saveUsage(
    cycle,
    {
      ...usage('2026-10-01'),
      warnings: ['R2 旧操作映射警告', 'Workers Logs retention: limited history'],
    },
    true,
  );
  store.saveUsage(cycle, usage('2026-10-02'), false);
  const result = dashboard(
    store,
    new Collector(store, {} as CloudflareProvider),
    new Date('2026-10-02T01:00:00Z'),
  );
  assert.deepEqual(result.collection.warnings, ['Workers Logs retention: limited history']);
  store.close();
});

test('legacy startup snapshots expose unavailable Logs history without warning on continuously captured history', () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  const old = usage('2026-10-01', 0);
  old.source = 'analytics';
  old.meters[0]!.key = 'worker_observability_events';
  store.saveUsage(cycle, old, true);
  const collector = new Collector(store, {} as CloudflareProvider);
  assert.equal(
    dashboard(store, collector, new Date('2026-10-10T12:00:00Z')).collection.warnings.length,
    0,
  );
  old.observedAt = '2026-10-10T12:00:00Z';
  store.saveUsage(cycle, old, true);
  assert.match(
    dashboard(store, collector, new Date('2026-10-10T12:00:00Z')).collection.warnings[0]!,
    /Workers Logs.*保留期/,
  );
  store.close();
});

test('a failed cycle refresh silently reuses a current cached cycle and clears its previous error', async () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  store.fail('cycle', '账单周期：earlier failure', '2026-10-01T00:00:00Z');
  const now = new Date('2026-10-01T12:00:00Z');
  const provider: CloudflareProvider = {
    getBillingCycle: async () => {
      throw new Error('fetch failed');
    },
    getUsage: async (_c, date) => ({ ...usage(date), observedAt: now.toISOString() }),
    getOfficialBill: async () => null,
  };
  const collector = new Collector(store, provider, () => now);
  await collector.tick();
  assert.deepEqual(store.errors(), []);
  assert.equal(store.activeCycle()!.id, cycle.id);
  assert.equal(store.usage(cycle.id).has('2026-10-01'), true);
  assert.equal(store.get('lastSuccess'), now.toISOString());
  assert.equal(dashboard(store, collector, now).totals.current, 6);
  store.close();
});

test('same-cycle metadata fallback does not hide usage or official-bill failures', async () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  const now = new Date('2026-10-02T00:10:00Z');
  const provider: CloudflareProvider = {
    getBillingCycle: async () => {
      throw new Error('fetch failed');
    },
    getUsage: async (_c, date) => {
      if (date === '2026-10-02') throw new Error('今日用量获取失败');
      return usage(date);
    },
    getOfficialBill: async () => {
      throw new Error('官方账单请求失败');
    },
  };
  const collector = new Collector(store, provider, () => now);
  await collector.tick();
  assert.equal(store.errors().length, 2);
  assert.equal(
    store.errors().some((error) => error.startsWith('账单周期：')),
    false,
  );
  assert.equal(
    store.errors().some((error) => error.includes('今日用量获取失败')),
    true,
  );
  assert.equal(
    store.errors().some((error) => error.includes('官方账单请求失败')),
    true,
  );
  store.close();
});

test('a cached cycle expires exactly at its exclusive UTC end and cannot collect today under the old cycle', async () => {
  const expired = { ...cycle, id: 'expired', start: '2026-10-31', end: '2026-11-01' };
  const store = new Store(':memory:');
  store.saveCycle(expired);
  const now = new Date('2026-11-01T00:00:00Z');
  const requestedDates: string[] = [];
  const provider: CloudflareProvider = {
    getBillingCycle: async () => {
      throw new Error('fetch failed');
    },
    getUsage: async (_c, date) => {
      requestedDates.push(date);
      return usage(date);
    },
    getOfficialBill: async (_c, date) => ({ through: date, amount: 6, currency: 'USD' }),
  };
  const collector = new Collector(store, provider, () => now);
  await collector.tick();
  assert.deepEqual(store.errors(), ['账单周期：fetch failed']);
  assert.equal(requestedDates.includes('2026-11-01'), false);
  assert.equal(store.usage(expired.id).has('2026-11-01'), false);
  assert.equal(dashboard(store, collector, now).totals.current, null);
  store.close();
});

test('a failed cycle refresh without any cache stays visible and cannot collect or produce a current bill', async () => {
  const store = new Store(':memory:');
  let usageCalls = 0;
  let officialCalls = 0;
  const now = new Date('2026-10-01T12:00:00Z');
  const provider: CloudflareProvider = {
    getBillingCycle: async () => {
      throw new Error('fetch failed');
    },
    getUsage: async (_c, date) => {
      usageCalls++;
      return usage(date);
    },
    getOfficialBill: async () => {
      officialCalls++;
      return null;
    },
  };
  const collector = new Collector(store, provider, () => now);
  await collector.tick();
  assert.deepEqual(store.errors(), ['账单周期：fetch failed']);
  assert.equal(usageCalls, 0);
  assert.equal(officialCalls, 0);
  assert.equal(dashboard(store, collector, now).totals.current, null);
  store.close();
});
