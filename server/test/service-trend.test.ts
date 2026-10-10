import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@/repositories/billing-store';
import { serviceTrend } from '@/services/service-trend';
import type { BillingCycle, UsageMeter, UsageReport } from '@/types';

const cycle: BillingCycle = {
  id: 'service-trend',
  start: '2026-10-01',
  end: '2026-10-04',
  currency: 'USD',
  baseFee: 5,
};
const meter = (quantity: number, overrides: Partial<UsageMeter> = {}): UsageMeter => ({
  key: 'memory',
  service: 'Containers',
  name: '内存',
  unit: 'GiB-seconds',
  quantity,
  pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 10 },
  ...overrides,
});
const report = (
  date: string,
  observedAt: string,
  quantity: number,
  overrides: Partial<UsageReport> = {},
): UsageReport => ({
  date,
  observedAt,
  complete: true,
  meters: [meter(quantity)],
  ...overrides,
});
const fixture = (t: TestContext) => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  t.after(() => store.close());
  return store;
};

test('daily and sampled usage share cycle allowances, preserve zero costs and isolate the selected service', (t) => {
  const store = fixture(t);
  store.saveUsage(
    cycle,
    report('2026-10-01', '2026-10-01T23:51:00Z', 8, {
      meters: [meter(8), meter(100, { key: 'requests', service: 'Workers' })],
    }),
    true,
  );
  store.saveUsage(
    cycle,
    report('2026-10-02', '2026-10-02T00:01:00Z', 5, {
      meters: [meter(5), meter(100, { key: 'requests', service: 'Workers' })],
    }),
    false,
  );
  const selected = serviceTrend(store, 'Containers', 'memory', new Date('2026-10-02T00:09:00Z'))!;
  assert.equal(selected.name, '内存');
  assert.equal(selected.unit, 'GiB-seconds');
  assert.deepEqual(
    selected.history.map((point) => [point.localCost, point.quantity]),
    [
      [0, 8],
      [3, 13],
    ],
  );
  assert.deepEqual(
    selected.timeline.map((point) => [point.localCost, point.quantity]),
    [
      [0, 8],
      [3, 13],
    ],
  );
  assert.ok(selected.timeline.every((point) => point.officialCost === null));
  const service = serviceTrend(store, 'Containers', null, new Date('2026-10-02T00:09:00Z'))!;
  assert.equal(service.unit, null);
  assert.equal(service.name, 'Containers');
  assert.deepEqual(
    service.history.map((point) => point.localCost),
    [0, 3],
  );
  assert.ok(service.history.every((point) => point.quantity === null));
  assert.equal(serviceTrend(store, 'Workers', 'memory'), null);
});

test('daily history uses saved official meter breakdowns, never substitutes total bills or local estimates', (t) => {
  const store = fixture(t);
  for (const [date, quantity] of [
    ['2026-10-01', 12],
    ['2026-10-02', 2],
    ['2026-10-03', 1],
  ] as const)
    store.saveUsage(
      cycle,
      report(date, `${date}T00:01:00Z`, quantity, {
        meters: [meter(quantity), meter(2, { key: 'disk' })],
      }),
      true,
    );
  store.saveBill(
    cycle,
    {
      through: '2026-10-01',
      amount: 100,
      currency: 'USD',
      serviceCosts: { memory: 2.5, disk: 0.25, requests: 90 },
    },
    '2026-10-02T01:00:00Z',
    999,
    true,
    {},
  );
  store.saveBill(
    cycle,
    { through: '2026-10-02', amount: 200, currency: 'USD' },
    '2026-10-03T01:00:00Z',
    999,
    true,
    {},
  );
  store.saveBill(
    cycle,
    { through: '2026-10-03', amount: 0, currency: 'USD', serviceCosts: {} },
    '2026-10-03T02:00:00Z',
    999,
    true,
    {},
  );
  const now = new Date('2026-10-03T02:01:00Z');
  const whole = serviceTrend(store, 'Containers', null, now)!;
  assert.deepEqual(
    whole.history.map((point) => point.officialCost),
    [2.75, null, 0],
  );
  assert.deepEqual(
    whole.history.map((point) => point.localCost),
    [2, 4, 5],
  );
  assert.equal(serviceTrend(store, 'Containers', 'memory', now)!.history[0]!.officialCost, 2.5);
});

test('missing days and incomplete observations remain gaps, and duplicate slots prefer the latest complete reading', (t) => {
  const store = fixture(t);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T12:01:00Z', 5), false);
  store.saveUsage(cycle, report('2026-10-01', '2026-10-02T12:02:00Z', 8), true);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T12:11:00Z', 5), false);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T12:15:00Z', 6), false);
  store.saveUsage(
    cycle,
    report('2026-10-02', '2026-10-02T12:19:00Z', 999, { complete: false }),
    false,
  );
  store.saveUsage(
    cycle,
    report('2026-10-02', '2026-10-02T12:21:00Z', 999, { complete: false }),
    false,
  );
  const trend = serviceTrend(store, 'Containers', 'memory', new Date('2026-10-02T12:49:00Z'))!;
  assert.equal(trend.timeline.length, 5);
  assert.deepEqual(
    trend.timeline.map((point) => point.localCost),
    [null, 4, null, null, null],
  );
  assert.deepEqual(
    trend.timeline.map((point) => point.quantity),
    [null, 14, null, null, null],
  );
  assert.equal(trend.timeline[1]!.observedAt, '2026-10-02T12:15:00Z');
  assert.equal(trend.timeline[2]!.observedAt, null);
  assert.deepEqual(
    trend.history.map((point) => point.localCost),
    [0, 4],
  );
});

test('backfills do not create realtime points or repair earlier points; appended old-time corrections only affect later evidence', (t) => {
  const store = fixture(t);
  const historical = report('2026-10-01', '2026-10-02T00:01:00Z', 8);
  store.saveUsage(cycle, historical, true);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T00:11:00Z', 5), false);
  store.saveUsage(
    cycle,
    {
      ...historical,
      meters: [meter(20)],
      raw: { corrections: [{ at: '2026-10-02T00:25:00Z' }] },
    },
    true,
  );
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T00:31:00Z', 7), false);
  store.saveUsage(
    cycle,
    report('2026-10-02', '2026-10-02T00:11:00Z', 50, {
      raw: { corrections: [{ at: '2026-10-02T00:40:00Z' }] },
    }),
    false,
  );
  const trend = serviceTrend(store, 'Containers', 'memory', new Date('2026-10-02T00:43:00Z'))!;
  assert.equal(trend.timeline[0]!.timestamp, '2026-10-02T00:10:00.000Z');
  assert.deepEqual(
    trend.timeline.map((point) => point.localCost),
    [3, null, 17, null],
  );
  assert.equal(
    trend.history[1]!.localCost,
    60,
    'daily history can use the latest saved correction',
  );
});

test('observation time also bounds previously inserted future evidence and handles out-of-order observations', (t) => {
  const store = fixture(t);
  store.saveUsage(cycle, report('2026-10-01', '2026-10-02T00:30:00Z', 100), true);
  store.saveUsage(cycle, report('2026-10-01', '2026-10-02T00:01:00Z', 8), true);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T00:11:00Z', 5), false);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T00:41:00Z', 7), false);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T00:21:00Z', 6), false);
  const trend = serviceTrend(store, 'Containers', 'memory', new Date('2026-10-02T00:49:00Z'))!;
  assert.deepEqual(
    trend.timeline.map((point) => point.localCost),
    [3, 4, null, 97],
  );
});

test('daily-reset allowance, rounded units and a meter fixed fee use the standard calculator', (t) => {
  const store = fixture(t);
  for (const date of ['2026-10-01', '2026-10-02'])
    store.saveUsage(
      cycle,
      report(date, `${date}T00:01:00Z`, 0, {
        meters: [
          meter(3, {
            pricing: {
              currency: 'USD',
              unitPrice: 2,
              unitSize: 3,
              includedQuantity: 2,
              allowancePeriod: 'day',
              rounding: 'up',
              fixedFee: 7,
            },
          }),
        ],
      }),
      true,
    );
  const trend = serviceTrend(store, 'Containers', 'memory', new Date('2026-10-02T00:09:00Z'))!;
  assert.deepEqual(
    trend.history.map((point) => point.localCost),
    [9, 11],
  );
  const subscription = serviceTrend(store, '订阅', '__base_fee', new Date('2026-10-02T00:09:00Z'))!;
  assert.deepEqual(
    subscription.history.map((point) => [point.localCost, point.quantity]),
    [
      [5, 1],
      [5, 1],
    ],
  );
  assert.ok(
    subscription.timeline
      .filter((point) => point.observedAt)
      .every((point) => point.localCost === 5),
  );
});

test('missing initial daily records are not treated as zero and an ended cycle stops at its last slot', (t) => {
  const store = fixture(t);
  store.saveUsage(cycle, report('2026-10-03', '2026-10-03T23:51:00Z', 12), true);
  const trend = serviceTrend(store, 'Containers', 'memory', new Date('2026-10-10T00:00:00Z'))!;
  assert.deepEqual(
    trend.history.map((point) => point.localCost),
    [null, null, null],
  );
  assert.equal(trend.timeline.length, 1);
  assert.equal(trend.timeline[0]!.timestamp, '2026-10-03T23:50:00.000Z');
  assert.equal(trend.timeline[0]!.localCost, null);
});

test('a backfill-only cycle has daily history but no fabricated intraday observations, and reads do not mutate storage', (t) => {
  const store = fixture(t);
  store.saveUsage(cycle, report('2026-10-01', '2026-10-02T00:01:00Z', 12), true);
  const changes = () => store.db.prepare('SELECT total_changes() AS count').get();
  const before = changes();
  const trend = serviceTrend(store, 'Containers', 'memory', new Date('2026-10-02T00:09:00Z'))!;
  assert.deepEqual(trend.timeline, []);
  assert.deepEqual(
    trend.history.map((point) => point.localCost),
    [2, null],
  );
  assert.deepEqual(changes(), before);
  assert.equal(serviceTrend(store, 'Unknown'), null);
});
