import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboard } from '@/services/dashboard';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';
import { money } from '@/services/calculation';
import type { BillingCycle, CloudflareProvider, UsageReport } from '@/types';

const cycle: BillingCycle = {
  id: 'current-service-costs',
  start: '2026-10-01',
  end: '2026-11-01',
  currency: 'USD',
  baseFee: 5,
};
const usage = (date: string, requests: number): UsageReport => ({
  date,
  observedAt: `${date}T12:00:00Z`,
  complete: true,
  meters: [
    {
      key: 'requests',
      service: 'Workers',
      name: '请求',
      unit: 'requests',
      quantity: requests,
      pricing: {
        currency: 'USD',
        unitPrice: 0.3,
        unitSize: 1_000_000,
        includedQuantity: 10_000_000,
      },
    },
  ],
});

test('service current charges sum to the official-corrected headline while local costs stay independent', () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  store.saveUsage(cycle, usage('2026-10-01', 12_000_000), true);
  store.saveUsage(cycle, usage('2026-10-02', 1_000_000), false);
  store.saveBill(
    cycle,
    {
      through: '2026-10-01',
      amount: 5.7,
      currency: 'USD',
      serviceCosts: { __base_fee: 5, requests: 0.7 },
    },
    '2026-10-02T00:00:00Z',
    5.6,
    true,
    {},
  );
  const result = dashboard(
    store,
    new Collector(store, {} as CloudflareProvider),
    new Date('2026-10-02T12:00:00Z'),
  );
  assert.equal(result.totals.current, 6);
  assert.equal(result.totals.localCumulative, 5.9);
  assert.equal(result.services.find((row) => row.key === 'requests')!.currentCost, 1);
  assert.equal(result.services.find((row) => row.key === 'requests')!.cost, 0.9);
  assert.equal(result.services.find((row) => row.key === '__base_fee')!.officialCost, 5);
  assert.equal(
    money(result.services.reduce((sum, row) => sum + row.currentCost!, 0)),
    result.totals.current,
  );
  store.close();
});

test('cycle first-day service charges use only today and include the subscription once', () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  store.saveUsage(cycle, usage('2026-10-01', 12_000_000), false);
  const result = dashboard(
    store,
    new Collector(store, {} as CloudflareProvider),
    new Date('2026-10-01T12:00:00Z'),
  );
  assert.equal(result.totals.current, 5.6);
  assert.equal(
    result.services.every((row) => row.officialCost === 0),
    true,
  );
  assert.equal(result.services.find((row) => row.key === '__base_fee')!.currentCost, 5);
  assert.equal(
    money(result.services.reduce((sum, row) => sum + row.currentCost!, 0)),
    result.totals.current,
  );
  store.close();
});

test('legacy official records without a service breakdown remain unknown instead of becoming zero', () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  store.saveUsage(cycle, usage('2026-10-01', 12_000_000), true);
  store.saveUsage(cycle, usage('2026-10-02', 1_000_000), false);
  store.saveBill(
    cycle,
    { through: '2026-10-01', amount: 5.7, currency: 'USD' },
    '2026-10-02T00:00:00Z',
    5.6,
    true,
    {},
  );
  const result = dashboard(
    store,
    new Collector(store, {} as CloudflareProvider),
    new Date('2026-10-02T12:00:00Z'),
  );
  assert.equal(result.totals.current, 6);
  assert.equal(
    result.services.every((row) => row.officialCost === null && row.currentCost === null),
    true,
  );
  store.close();
});

test('history keeps the saved local comparison even when current daily totals differ', () => {
  const store = new Store(':memory:');
  try {
    store.saveCycle(cycle);
    store.saveUsage(cycle, usage('2026-10-01', 12_000_000), true);
    store.saveUsage(cycle, usage('2026-10-02', 1_000_000), false);
    store.saveBill(
      cycle,
      { through: '2026-10-01', amount: 5.7, currency: 'USD' },
      '2026-10-02T00:00:00Z',
      5.2,
      true,
      {},
    );
    const result = dashboard(
      store,
      new Collector(store, {} as CloudflareProvider),
      new Date('2026-10-02T12:00:00Z'),
    );
    assert.equal(result.history[0]!.localTotal, 5.2);
    assert.equal(result.history[0]!.difference, -0.5);
    assert.equal(result.history[1]!.localTotal, 5.9);
    assert.equal(result.totals.current, 6);
  } finally {
    store.close();
  }
});
