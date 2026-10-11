import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@/repositories/billing-store';
import { dailyMeterTrend } from '@/services/daily-meter-trend';
import type { BillingCycle } from '@/types';
const cycle: BillingCycle = {
  id: 'day-trend',
  start: '2026-10-01',
  end: '2026-11-01',
  currency: 'USD',
  baseFee: 5,
};
const price = { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 10 };
function save(store: Store, date: string, observedAt: string, quantity: number, finalized = false) {
  store.saveUsage(
    cycle,
    {
      date,
      observedAt,
      complete: true,
      meters: [
        {
          key: 'requests',
          service: 'Workers',
          name: '请求',
          unit: 'requests',
          quantity,
          pricing: price,
        },
      ],
    },
    finalized,
  );
}
test('daily graphs contain 144 ten-minute slots, marginal day costs, and honest gaps', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  save(store, '2026-10-01', '2026-10-02T00:00:00Z', 8, true);
  save(store, '2026-10-02', '2026-10-02T00:10:00Z', 3);
  save(store, '2026-10-02', '2026-10-02T00:20:00Z', 5);
  save(store, '2026-10-02', '2026-10-02T00:40:00Z', 9);
  save(store, '2026-10-03', '2026-10-03T00:10:00Z', 999);
  const result = dailyMeterTrend(
    store,
    '2026-10-02',
    'Workers',
    'requests',
    new Date('2026-10-04'),
  )!;
  assert.equal(result.usage.points.length, 144);
  assert.equal(result.usage.start, '2026-10-02T00:00:00.000Z');
  assert.equal(result.usage.end, '2026-10-03T00:00:00.000Z');
  assert.deepEqual(
    result.usage.points.slice(0, 4).map((p) => p.total),
    [3, 2, null, null],
  );
  assert.deepEqual(
    result.cost.points.slice(0, 5).map((p) => p.total),
    [0, 1, 3, null, 7],
  );
  assert.equal(result.usage.points.at(-1)!.timestamp, '2026-10-02T23:50:00.000Z');
  assert.equal(dailyMeterTrend(store, '2026-11-01', 'Workers', 'requests'), null);
  assert.equal(dailyMeterTrend(store, '2026-10-02', 'Workers', 'unknown'), null);
});
test('daily graphs do not invent samples from daily backfills and fixed fees stay on their day', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  save(store, '2026-10-01', '2026-10-03T00:00:00Z', 100, true);
  const result = dailyMeterTrend(
    store,
    '2026-10-01',
    'Workers',
    'requests',
    new Date('2026-10-04'),
  )!;
  assert.ok(result.usage.points.every((p) => p.total === null));
  assert.ok(result.cost.points.slice(1).every((p) => p.total === null));
  const fixed = dailyMeterTrend(store, '2026-10-01', '订阅', '__base_fee', new Date('2026-10-04'))!;
  assert.ok(fixed.cost.points.every((p) => p.total === 5));
  const later = dailyMeterTrend(store, '2026-10-02', '订阅', '__base_fee', new Date('2026-10-04'))!;
  assert.ok(later.cost.points.every((p) => p.total === 0));
});
