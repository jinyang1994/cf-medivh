import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@/repositories/billing-store';
import { RESOURCE_USAGE_GAP_WARNING } from '@/repositories/resource-usage-store';
import { resourceCostTrend } from '@/services/resource-cost-trend';
import { serviceTrend } from '@/services/service-trend';
import type { BillingCycle, ResourceCostTrend, ResourceUsageTrend, UsageMeter } from '@/types';

const cycle: BillingCycle = {
  id: 'resource-cost',
  start: '2026-10-01',
  end: '2026-10-07',
  currency: 'USD',
};
const now = new Date('2026-10-02T23:59:00Z');
const meter = (quantity: number, overrides: Partial<UsageMeter> = {}): UsageMeter => ({
  key: 'requests',
  service: 'Workers',
  name: '请求',
  unit: 'requests',
  quantity,
  pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 0 },
  ...overrides,
});
const fixture = (t: TestContext) => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  t.after(() => store.close());
  return store;
};
function usage(
  store: Store,
  date: string,
  meters: UsageMeter[],
  observedAt = `${date}T23:51:00Z`,
  complete = true,
) {
  store.saveUsage(cycle, { date, observedAt, complete, meters }, date < '2026-10-02');
}
function resources(
  store: Store,
  points: [string, Record<string, number | null>][],
  overrides: Partial<ResourceUsageTrend> = {},
  requestedResolution: 'ten-minute' | 'daily' = 'daily',
) {
  const resolution = overrides.resolution ?? requestedResolution;
  const interval =
    resolution === 'daily' ? 86_400_000 : resolution === 'hourly' ? 3_600_000 : 600_000;
  const ids = new Set(points.flatMap(([, values]) => Object.keys(values)));
  store.resourceUsage.save(cycle, requestedResolution, {
    service: 'Workers',
    meterKey: 'requests',
    unit: 'requests',
    resolution,
    start: new Date(points[0]![0]).toISOString(),
    end: new Date(Date.parse(points.at(-1)![0]) + interval).toISOString(),
    fetchedAt: now.toISOString(),
    resources: [...ids].map((id) => ({ id, name: `Worker ${id}`, total: 0 })),
    points: points.map(([timestamp, quantities]) => ({ timestamp, quantities })),
    warnings: [],
    unavailableReason: null,
    ...overrides,
  });
}
const read = (
  store: Store,
  key: string | null = 'requests',
  resolution: 'ten-minute' | 'daily' = 'daily',
  at = now,
) => resourceCostTrend(store, 'Workers', key, resolution, at)!;
function exactTotals(trend: ResourceCostTrend) {
  for (const point of trend.points) {
    if (point.total === null) {
      assert.equal(point.unattributedCost, null);
      assert.ok(Object.values(point.costs).every((value) => value === null));
    } else {
      assert.equal(
        Object.values(point.costs).reduce<number>(
          (sum, value) => sum + Math.round((value ?? 0) * 1e6),
          0,
        ) + Math.round(point.unattributedCost! * 1e6),
        Math.round(point.total * 1e6),
      );
      assert.ok(point.unattributedCost! >= 0);
    }
  }
}

test('resource estimates split existing net charges once and resource totals are the final cumulative values', (t) => {
  const store = fixture(t);
  const pricing = { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 50 };
  usage(store, '2026-10-01', [meter(60, { pricing })]);
  usage(store, '2026-10-02', [meter(40, { pricing })]);
  resources(store, [
    ['2026-10-01T00:00:00Z', { a: 30, b: 30 }],
    ['2026-10-02T00:00:00Z', { a: 20, b: 20 }],
  ]);
  const trend = read(store);
  assert.deepEqual(
    trend.points.map((point) => ({ ...point.costs })),
    [
      { a: 5, b: 5 },
      { a: 25, b: 25 },
    ],
  );
  assert.deepEqual(
    trend.points.map((point) => point.total),
    [10, 50],
  );
  assert.deepEqual(
    trend.resources.map((resource) => resource.total),
    [25, 25],
  );
  assert.deepEqual(trend.warnings, []);
  exactTotals(trend);
});

test('daily-reset allowances, rounded units and fixed fees reuse the standard meter calculation', (t) => {
  const store = fixture(t);
  const pricing: UsageMeter['pricing'] = {
    currency: 'USD',
    unitPrice: 2,
    unitSize: 3,
    includedQuantity: 2,
    allowancePeriod: 'day',
    rounding: 'up',
    fixedFee: 7,
  };
  for (const date of ['2026-10-01', '2026-10-02']) usage(store, date, [meter(3, { pricing })]);
  resources(store, [
    ['2026-10-01T00:00:00Z', { a: 1, b: 2 }],
    ['2026-10-02T00:00:00Z', { a: 1, b: 2 }],
  ]);
  const trend = read(store);
  assert.deepEqual(
    trend.points.map((point) => point.total),
    [9, 11],
  );
  assert.deepEqual(
    trend.points.map((point) => point.total),
    serviceTrend(store, 'Workers', 'requests', now)!.history.map((point) => point.localCost),
  );
  assert.deepEqual({ ...trend.points[1]!.costs }, { a: 3.666667, b: 7.333333 });
  exactTotals(trend);
});

test('partial and missing resource observations remain unattributed instead of inflating known resources', (t) => {
  const store = fixture(t);
  usage(store, '2026-10-01', [meter(100)]);
  resources(store, [['2026-10-01T00:00:00Z', { a: 20, b: null }]]);
  const trend = read(store);
  assert.deepEqual({ ...trend.points[0]!.costs }, { a: 20, b: null });
  assert.equal(trend.points[0]!.unattributedCost, 80);
  assert.equal(trend.points[1]!.total, null);
  assert.match(trend.warnings.join(' '), /未归属/);
  exactTotals(trend);
});

test('quantities exceeding account observations are normalized and zero costs stay distinct from missing costs', (t) => {
  const store = fixture(t);
  usage(store, '2026-10-01', [meter(10)]);
  usage(store, '2026-10-02', [meter(0)]);
  resources(store, [
    ['2026-10-01T00:00:00Z', { a: 8, b: 8, zero: 0 }],
    ['2026-10-02T00:00:00Z', { a: 0, b: 0, zero: 0 }],
  ]);
  let trend = read(store);
  assert.deepEqual({ ...trend.points[0]!.costs }, { a: 5, b: 5, zero: 0 });
  assert.equal(trend.points[0]!.unattributedCost, 0);
  exactTotals(trend);
  usage(store, '2026-10-01', [meter(0)]);
  trend = read(store);
  assert.equal(trend.points[0]!.total, 0);
  assert.deepEqual(Object.values(trend.points[0]!.costs), [0, 0, 0]);
  exactTotals(trend);
});

test('intraday costs use prior daily baselines plus completed current-day buckets without double counting or future data', (t) => {
  const store = fixture(t);
  usage(store, '2026-10-01', [meter(100)]);
  usage(store, '2026-10-02', [meter(30)], '2026-10-02T00:15:00Z');
  usage(store, '2026-10-02', [meter(35)], '2026-10-02T00:25:00Z');
  resources(store, [
    ['2026-10-01T00:00:00Z', { a: 40, b: 60 }],
    ['2026-10-02T00:00:00Z', { a: 999, b: 999 }],
  ]);
  resources(
    store,
    [
      ['2026-10-01T23:50:00Z', { a: 999, b: 999 }],
      ['2026-10-02T00:00:00Z', { a: 10, b: 0 }],
      ['2026-10-02T00:10:00Z', { a: 0, b: 20 }],
      ['2026-10-02T00:20:00Z', { a: 500, b: 500 }],
    ],
    {},
    'ten-minute',
  );
  const trend = read(store, 'requests', 'ten-minute', new Date('2026-10-02T00:29:00Z'));
  const first = trend.points.find((point) => point.timestamp === '2026-10-02T00:10:00.000Z')!;
  const second = trend.points.find((point) => point.timestamp === '2026-10-02T00:20:00.000Z')!;
  assert.deepEqual({ ...first.costs }, { a: 50, b: 60 });
  assert.equal(first.unattributedCost, 20);
  assert.deepEqual({ ...second.costs }, { a: 50, b: 80 });
  assert.equal(second.unattributedCost, 5);
  exactTotals(trend);
});

test('daily gaps recover complete and partial fine evidence per resource without double counting valid daily values', (t) => {
  const store = fixture(t);
  usage(store, '2026-10-01', [meter(25)]);
  usage(store, '2026-10-02', [meter(20)]);
  usage(store, '2026-10-03', [meter(20)]);
  usage(store, '2026-10-04', [meter(7)], '2026-10-04T00:15:00Z');
  resources(store, [
    ['2026-10-01T00:00:00Z', { a: 10, b: null }],
    ['2026-10-02T00:00:00Z', { a: null, b: null }],
    ['2026-10-03T00:00:00Z', { a: 0, b: 20 }],
  ]);
  const fine: [string, Record<string, number | null>][] = [];
  for (let index = 0; index < 144; index++) {
    fine.push([
      new Date(Date.parse('2026-10-01T00:00:00Z') + index * 600_000).toISOString(),
      {
        a: index === 0 ? 999 : 0,
        b: index === 0 ? 15 : 0,
      },
    ]);
    fine.push([
      new Date(Date.parse('2026-10-02T00:00:00Z') + index * 600_000).toISOString(),
      {
        a: index === 0 ? 5 : 0,
        b: null,
      },
    ]);
  }
  fine.push(
    ['2026-10-03T00:00:00Z', { a: 999, b: 999 }],
    ['2026-10-04T00:00:00Z', { a: 2, b: 3 }],
    ['2026-10-04T00:10:00Z', { a: 999, b: 999 }],
  );
  resources(
    store,
    fine.sort(([a], [b]) => a.localeCompare(b)),
    {},
    'ten-minute',
  );
  const at = new Date('2026-10-04T00:19:00Z');
  const daily = read(store, 'requests', 'daily', at);
  assert.deepEqual(
    daily.points.map((point) => ({ ...point.costs })),
    [
      { a: 10, b: 15 },
      { a: 15, b: 15 },
      { a: 15, b: 35 },
      { a: 17, b: 38 },
    ],
  );
  assert.deepEqual(
    daily.points.map((point) => point.unattributedCost),
    [0, 15, 15, 17],
  );
  const intraday = read(store, 'requests', 'ten-minute', at);
  assert.deepEqual({ ...intraday.points.at(-1)!.costs }, { a: 17, b: 38 });
  assert.equal(intraday.points.at(-1)!.unattributedCost, 17);
  exactTotals(daily);
  exactTotals(intraday);
});

test('complete daily evidence suppresses irrelevant gaps from limited fine history while retaining other warnings', (t) => {
  const store = fixture(t);
  const at = new Date('2026-10-04T00:00:00Z');
  for (const date of ['2026-10-01', '2026-10-02', '2026-10-03']) usage(store, date, [meter(10)]);
  resources(store, [
    ['2026-10-01T00:00:00Z', { a: 10 }],
    ['2026-10-02T00:00:00Z', { a: 10 }],
    ['2026-10-03T00:00:00Z', { a: 10 }],
  ]);
  resources(
    store,
    [
      ['2026-10-02T00:00:00Z', { a: 1 }],
      ['2026-10-03T00:00:00Z', { a: 1 }],
    ],
    { warnings: ['目录读取失败，名称使用 ID'] },
    'ten-minute',
  );
  const stored = store.resourceUsage.read(cycle, 'Workers', 'requests', 'ten-minute', at, {
    start: cycle.start,
  })!;
  assert.ok(stored.warnings.includes(RESOURCE_USAGE_GAP_WARNING));
  const trend = read(store, 'requests', 'daily', at);
  assert.deepEqual(trend.warnings, ['目录读取失败，名称使用 ID']);
  assert.deepEqual(
    trend.points.map((point) => point.unattributedCost),
    [0, 0, 0],
  );
  exactTotals(trend);
});

test('native hourly and daily buckets do not leak unfinished storage usage into intraday costs', (t) => {
  const store = fixture(t);
  usage(store, '2026-10-01', [meter(100)], '2026-10-01T00:31:00Z');
  usage(store, '2026-10-01', [meter(150)], '2026-10-01T01:11:00Z');
  resources(
    store,
    [
      ['2026-10-01T00:00:00Z', { a: 40 }],
      ['2026-10-01T01:00:00Z', { a: 70 }],
    ],
    { resolution: 'hourly' },
    'ten-minute',
  );
  let trend = read(store, 'requests', 'ten-minute', new Date('2026-10-01T01:19:00Z'));
  assert.equal(trend.points[0]!.costs.a, null);
  assert.equal(trend.points[0]!.unattributedCost, 100);
  assert.equal(trend.points.at(-1)!.costs.a, 40);
  assert.equal(trend.points.at(-1)!.unattributedCost, 110);
  exactTotals(trend);
  resources(
    store,
    [['2026-10-01T00:00:00Z', { a: 100 }]],
    { resolution: 'daily', fetchedAt: '2026-10-03T00:00:00Z' },
    'ten-minute',
  );
  trend = read(store, 'requests', 'ten-minute', new Date('2026-10-01T01:19:00Z'));
  assert.equal(trend.points.at(-1)!.costs.a, null);
  assert.equal(trend.points.at(-1)!.unattributedCost, 150);
  exactTotals(trend);
});

test('whole-service costs allocate meters independently before merging resource IDs and preserve official totals only', (t) => {
  const store = fixture(t);
  usage(store, '2026-10-01', [meter(100), meter(10, { key: 'cpu', unit: 'CPU-ms' })]);
  resources(store, [['2026-10-01T00:00:00Z', { a: 90, b: 10 }]]);
  resources(store, [['2026-10-01T00:00:00Z', { a: 2, b: 8 }]], { meterKey: 'cpu', unit: 'CPU-ms' });
  store.saveBill(
    cycle,
    {
      through: '2026-10-01',
      amount: 999,
      currency: 'USD',
      serviceCosts: { requests: 105, cpu: 9, other: 885 },
    },
    '2026-10-02T01:00:00Z',
    110,
    true,
    {},
  );
  const trend = read(store, null);
  assert.equal(trend.resources.length, 2);
  assert.deepEqual({ ...trend.points[0]!.costs }, { a: 92, b: 18 });
  assert.equal(trend.points[0]!.total, 110);
  assert.equal(trend.points[0]!.officialCost, 114);
  exactTotals(trend);
});

test('six-decimal allocation remains exactly aligned for tiny charges and missing shares', (t) => {
  const store = fixture(t);
  usage(store, '2026-10-01', [
    meter(7, {
      pricing: { currency: 'USD', unitPrice: 0.0000003, unitSize: 1, includedQuantity: 0 },
    }),
  ]);
  resources(store, [['2026-10-01T00:00:00Z', { a: 1, b: 1, c: 1 }]]);
  const trend = read(store);
  assert.equal(trend.points[0]!.total, 0.000002);
  assert.equal(trend.points[0]!.unattributedCost, 0.000001);
  assert.deepEqual({ ...trend.points[0]!.costs }, { a: 0.000001, b: 0, c: 0 });
  exactTotals(trend);
});

test('independently rounded tiny meter fees add up to the whole-service total without negative unattributed costs', (t) => {
  const store = fixture(t);
  const keys = ['requests', 'cpu', 'storage', 'logs'];
  usage(
    store,
    '2026-10-01',
    keys.map((key) =>
      meter(3, {
        key,
        pricing: { currency: 'USD', unitPrice: 0.0000004, unitSize: 1, includedQuantity: 0 },
      }),
    ),
  );
  for (const key of keys)
    resources(store, [['2026-10-01T00:00:00Z', { a: 1, b: 1, c: 1 }]], { meterKey: key });
  const trend = read(store, null);
  assert.equal(trend.points[0]!.total, 0.000004);
  assert.deepEqual({ ...trend.points[0]!.costs }, { a: 0.000004, b: 0, c: 0 });
  assert.equal(trend.points[0]!.unattributedCost, 0);
  exactTotals(trend);
});

test('zero-quantity fixed fees, unsupported resources and absent selections remain honest and reads never write or fetch', async (t) => {
  const store = fixture(t);
  usage(store, '2026-10-01', [
    meter(0, {
      pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 0, fixedFee: 5 },
    }),
  ]);
  resources(store, [['2026-10-01T00:00:00Z', { a: 0 }]]);
  const changes = () => store.db.prepare('SELECT total_changes() AS n').get();
  const before = changes();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network access is forbidden');
  };
  try {
    const trend = read(store);
    assert.equal(trend.points[0]!.total, 5);
    assert.equal(trend.points[0]!.costs.a, 0);
    assert.equal(trend.points[0]!.unattributedCost, 5);
    assert.equal(resourceCostTrend(store, 'Unknown', null, 'daily', now), null);
    assert.equal(read(store, 'unknown'), null);
    exactTotals(trend);
    assert.deepEqual(changes(), before);
  } finally {
    globalThis.fetch = previousFetch;
  }
  store.saveCycle({ ...cycle, baseFee: 5 });
  const subscription = resourceCostTrend(store, '订阅', null, 'daily', now)!;
  assert.deepEqual(subscription.resources, []);
  assert.equal(subscription.points[0]!.unattributedCost, 5);
  exactTotals(subscription);
});

test('48-hour costs include stored current-day prefixes before the visible window and exclude older chart points', (t) => {
  const store = fixture(t);
  for (const date of ['2026-10-01', '2026-10-02', '2026-10-03']) usage(store, date, [meter(0)]);
  usage(store, '2026-10-04', [meter(50)], '2026-10-04T12:11:00Z');
  resources(store, [
    ['2026-10-01T00:00:00Z', { a: 0 }],
    ['2026-10-02T00:00:00Z', { a: 0 }],
    ['2026-10-03T00:00:00Z', { a: 0 }],
  ]);
  resources(
    store,
    [
      ['2026-10-04T00:00:00Z', { a: 40 }],
      ['2026-10-04T12:00:00Z', { a: 10 }],
    ],
    {},
    'ten-minute',
  );
  const trend = read(store, 'requests', 'ten-minute', new Date('2026-10-06T12:09:00Z'));
  assert.equal(trend.start, '2026-10-04T12:10:00.000Z');
  assert.equal(trend.points[0]!.timestamp, trend.start);
  assert.equal(trend.points[0]!.costs.a, 50);
  assert.equal(trend.points[0]!.unattributedCost, 0);
  assert.equal(trend.resources[0]!.total, 50);
  assert.match(trend.warnings.join(' '), /最后一次可用/);
  exactTotals(trend);
});
