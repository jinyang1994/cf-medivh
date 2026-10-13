import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@/repositories/billing-store';
import { dailyServices } from '@/services/daily-services';
import { meterDefinition } from '@/services/pricing';
import type { BillingCycle, UsageMeter } from '@/types';

const cycle: BillingCycle = {
  id: 'daily',
  start: '2026-10-01',
  end: '2026-11-01',
  currency: 'USD',
  baseFee: 5,
};
const now = new Date('2026-10-05T00:00:00Z');
const meter = (quantity: number, daily = false): UsageMeter => ({
  key: daily ? 'daily' : 'monthly',
  service: 'Example',
  name: 'Requests',
  unit: 'requests',
  quantity,
  pricing: {
    currency: 'USD',
    unitPrice: 2,
    unitSize: 1,
    includedQuantity: 10,
    allowancePeriod: daily ? 'day' : 'cycle',
  },
});

test('compares raw daily billable quantities without replacing local analytics or treating missing rows as zero', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  const localMemory = 2079.992964041;
  store.saveUsage(
    cycle,
    {
      date: cycle.start,
      observedAt: '2026-10-02T00:00:00Z',
      complete: true,
      meters: [
        { ...meterDefinition('cloudchamber_memory_usage')!, quantity: localMemory },
        { ...meterDefinition('cloudchamber_disk_usage')!, quantity: 8319.971856164 },
      ],
    },
    true,
  );
  const row = {
    ServiceName: 'Container Memory, per GiB-Second (First 25 GiB-hours included)',
    BillingPeriodStart: `${cycle.start}T00:00:00Z`,
    ChargePeriodStart: `${cycle.start}T00:00:00Z`,
    ChargePeriodEnd: '2026-10-02T00:00:00Z',
    BillingCurrency: 'USD',
    ConsumedQuantity: 2077,
    ContractedCost: 0,
    CumulatedPricingQuantity: 999999,
  };
  store.saveBill(
    cycle,
    {
      through: cycle.start,
      amount: 5,
      currency: 'USD',
      serviceCosts: { __base_fee: 5 },
      raw: {
        records: [
          row,
          { ...row, ChargePeriodStart: '2026-09-30T00:00:00Z', ConsumedQuantity: 999 },
          { ...row, BillingPeriodStart: '2026-09-01T00:00:00Z', ConsumedQuantity: 999 },
        ],
      },
    },
    now.toISOString(),
    5,
    true,
    {},
  );
  const before = store.db.prepare('SELECT total_changes() AS n').get();
  const result = dailyServices(store, cycle.start, now)!;
  const memory = result.services.find((s) => s.key === 'cloudchamber_memory_usage')!;
  assert.equal(memory.quantity, localMemory);
  assert.equal(memory.officialQuantity, 2077);
  assert.equal(memory.quantityDifference, localMemory - 2077);
  assert.equal(memory.officialCost, 0);
  assert.equal(memory.costDifference, 0);
  assert.equal(
    result.services.find((s) => s.key === 'cloudchamber_disk_usage')!.officialQuantity,
    null,
  );
  assert.equal(result.services.find((s) => s.key === '__base_fee')!.officialCost, 5);
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS n').get(), before);
  assert.equal(
    dailyServices(store, cycle.start, new Date('2026-10-01T23:59:00Z'))!.services.find(
      (s) => s.key === '__base_fee',
    )!.officialCost,
    null,
  );
});
function save(store: Store, date: string, amount: number, complete = true) {
  store.saveUsage(
    cycle,
    {
      date,
      observedAt: `${date}T23:59:00Z`,
      complete,
      meters: [meter(amount), meter(amount, true)],
      raw: { providerPayload: 'unused raw analytics' },
    },
    true,
  );
}

test('daily detail uses marginal monthly charges, daily resets, and historical pricing', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  save(store, '2026-10-01', 8);
  save(store, '2026-10-02', 5);
  save(store, '2026-10-03', 100);
  const result = dailyServices(store, '2026-10-02', now)!;
  const month = result.services.find((row) => row.key === 'monthly')!;
  const day = result.services.find((row) => row.key === 'daily')!;
  assert.equal(month.quantity, 5);
  assert.equal(month.cost, 6);
  assert.equal(month.allowanceRatio, 1.3);
  assert.equal(month.overageQuantity, 3);
  assert.equal(month.allowanceUsed, 13);
  assert.equal(day.cost, 0);
  assert.equal(day.allowanceRatio, 0.5);
  assert.equal(day.allowanceUsed, 5);
  assert.equal(result.services.find((row) => row.key === '__base_fee')!.cost, 0);
  assert.equal(
    dailyServices(store, cycle.start, now)!.services.find((row) => row.key === '__base_fee')!.cost,
    5,
  );
});

test('missing history leaves monthly allowance and cost unknown while daily allowance remains usable', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  save(store, '2026-10-02', 12);
  const result = dailyServices(store, '2026-10-02', now)!;
  const month = result.services.find((row) => row.key === 'monthly')!;
  const day = result.services.find((row) => row.key === 'daily')!;
  assert.equal(result.complete, false);
  assert.equal(month.quantity, 12);
  assert.equal(month.cost, null);
  assert.equal(month.overageQuantity, null);
  assert.equal(month.allowanceRatio, null);
  assert.equal(day.cost, 4);
  assert.equal(day.allowanceRatio, 1.2);
  assert.equal(day.overageQuantity, 2);
  const missing = dailyServices(store, '2026-10-03', now)!.services.find(
    (row) => row.key === 'daily',
  )!;
  assert.equal(missing.quantity, null);
  assert.equal(missing.cost, null);
});

test('zero use is known, partial usage is not treated as complete, and invalid dates are rejected', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  save(store, '2026-10-01', 0);
  const zero = dailyServices(store, '2026-10-01', now)!.services.find(
    (row) => row.key === 'monthly',
  )!;
  assert.equal(zero.quantity, 0);
  assert.equal(zero.cost, 0);
  assert.equal(zero.allowanceRatio, 0);
  save(store, '2026-10-02', 4, false);
  const partial = dailyServices(store, '2026-10-02', now)!.services.find(
    (row) => row.key === 'monthly',
  )!;
  assert.equal(partial.quantity, 4);
  assert.equal(partial.cost, null);
  for (const date of ['2026-02-30', '2026-09-30', '2026-11-01', '2026-10-06', 'bad'])
    assert.equal(dailyServices(store, date, now), null);
});

test('bounded calculation query excludes future and unrelated days and omits raw responses', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveCycle(cycle);
  save(store, '2026-10-01', 12);
  save(store, '2026-10-02', 7);
  save(store, '2026-10-03', 100);
  const rows = store.usageForCalculation(cycle.id, '2026-10-01', '2026-10-02', now.toISOString());
  assert.deepEqual([...rows.keys()], ['2026-10-01', '2026-10-02']);
  assert.equal(rows.get('2026-10-01')!.report.complete, true);
  assert.equal(rows.get('2026-10-01')!.report.raw, undefined);
  assert.deepEqual(rows.get('2026-10-01')!.report.meters, [meter(12), meter(12, true)]);
  assert.deepEqual(
    [
      ...store
        .usageForCalculation(cycle.id, '2026-10-02', '2026-10-03', '2026-10-03T00:00:00Z')
        .keys(),
    ],
    ['2026-10-02'],
  );
  const result = dailyServices(store, '2026-10-02', now)!;
  assert.equal(result.services.find((row) => row.key === 'monthly')!.overageQuantity, 7);
  assert.equal(result.services.find((row) => row.key === 'daily')!.overageQuantity, 0);
});
