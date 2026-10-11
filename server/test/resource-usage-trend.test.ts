import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@/repositories/billing-store';
import { withMeterUsage } from '@/services/resource-usage-trend';
import { calculateDaily } from '@/services/calculation';
import type { BillingCycle, ResourceUsageTrend, UsageReport } from '@/types';

const cycle: BillingCycle = {
  id: 'unified',
  start: '2026-10-01',
  end: '2026-11-01',
  currency: 'USD',
};
const report = (
  date: string,
  observedAt: string,
  quantity: number,
  complete = true,
): UsageReport => ({
  date,
  observedAt,
  complete,
  meters: [
    {
      key: 'requests',
      service: 'Workers',
      name: '请求',
      unit: 'requests',
      quantity,
      pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 0 },
    },
  ],
});
const trend = (overrides: Partial<ResourceUsageTrend> = {}): ResourceUsageTrend => ({
  service: 'Workers',
  meterKey: 'requests',
  unit: 'requests',
  resolution: 'daily',
  start: '2026-10-01T00:00:00Z',
  end: '2026-10-03T00:00:00Z',
  fetchedAt: '',
  resources: [{ id: 'a', name: 'A', total: 999 }],
  points: [{ timestamp: '2026-10-01T00:00:00Z', quantities: { a: 999 } }],
  warnings: [],
  unavailableReason: null,
  ...overrides,
});

test('daily graph summary matches the service table even when resource detail disagrees or is absent', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  store.saveUsage(cycle, report('2026-10-01', '2026-10-02T00:00:00Z', 100), true);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T12:00:00Z', 20), false);
  const result = withMeterUsage(store, cycle, trend(), new Date('2026-10-03T00:00:00Z'));
  const table = calculateDaily(cycle, store.usage(cycle.id), '2026-10-02').calculation.services[0]!;
  assert.equal(result.total, table.quantity);
  assert.equal(result.total, 120);
  assert.deepEqual(
    result.points.map((p) => p.total),
    [100, 20],
  );
  assert.equal(result.points[0]!.quantities.a, 999);
  const absent = withMeterUsage(
    store,
    cycle,
    trend({ resources: [], points: [], unavailableReason: '无资源明细' }),
    new Date('2026-10-03T00:00:00Z'),
  );
  assert.equal(absent.total, 120);
  assert.equal(absent.unavailableReason, null);
});

test('missing daily records remain gaps, incomplete records remain partial, and corrections follow the table', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  store.saveUsage(cycle, report('2026-10-01', '2026-10-01T12:00:00Z', 7, false), false);
  let result = withMeterUsage(store, cycle, trend(), new Date('2026-10-03T00:00:00Z'));
  assert.equal(result.total, 7);
  assert.equal(result.totalComplete, false);
  assert.deepEqual(
    result.points.map((p) => p.total),
    [7, null],
  );
  store.saveUsage(cycle, report('2026-10-01', '2026-10-02T12:00:00Z', 9), true);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T12:00:00Z', 0), true);
  result = withMeterUsage(store, cycle, trend(), new Date('2026-10-03T00:00:00Z'));
  assert.equal(result.total, 9);
  assert.equal(result.totalComplete, true);
  assert.deepEqual(
    result.points.map((p) => p.total),
    [9, 0],
  );
});

test('fine intervals use adjacent same-day meter snapshots, preserve gaps and reject counter reductions', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  for (const [minute, value] of [
    [10, 10],
    [20, 30],
    [40, 40],
    [50, 35],
  ])
    store.saveUsage(cycle, report('2026-10-01', `2026-10-01T00:${minute}:03Z`, value!), false);
  // Backfill observations must not masquerade as real-time interval boundaries.
  store.saveUsage(
    cycle,
    { ...report('2026-10-01', '2026-10-01T00:30:03Z', 38), source: 'billing-backfill' },
    false,
  );
  const result = withMeterUsage(
    store,
    cycle,
    trend({ resolution: 'ten-minute', end: '2026-10-01T01:00:00Z' }),
    new Date('2026-10-01T01:00:00Z'),
  );
  assert.deepEqual(
    result.points.map((p) => p.total),
    [10, 20, null, null, null, null],
  );
  assert.equal(result.total, 30);
  assert.equal(result.totalComplete, false);
});

test('hourly boundaries use hourly differences and midnight uses the finalized previous day', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  store.saveUsage(cycle, report('2026-10-01', '2026-10-01T23:00:03Z', 70), false);
  store.saveUsage(cycle, report('2026-10-01', '2026-10-02T00:03:00Z', 100), true);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T01:00:03Z', 12), false);
  const result = withMeterUsage(
    store,
    cycle,
    trend({ resolution: 'hourly', start: '2026-10-01T23:00:00Z', end: '2026-10-02T01:00:00Z' }),
    new Date('2026-10-02T01:01:00Z'),
  );
  assert.deepEqual(
    result.points.map((p) => p.total),
    [30, 12],
  );
  assert.equal(result.total, 42);
});
