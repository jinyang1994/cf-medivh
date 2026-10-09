import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, calculateDaily, validateUsage } from '@/services/calculation';
import type { BillingCycle, UsageReport } from '@/types';
import type { DailyUsage } from '@/repositories/billing-store';

const cycle: BillingCycle = {
  id: 'test',
  start: '2026-10-01',
  end: '2026-11-01',
  currency: 'USD',
  baseFee: 5,
};
const report = (date: string, quantity: number, rounding?: 'up'): UsageReport => ({
  date,
  observedAt: `${date}T12:00:00Z`,
  complete: true,
  meters: [
    {
      key: 'requests',
      service: 'Workers',
      name: '请求',
      unit: '次',
      quantity,
      pricing: {
        currency: 'USD',
        unitPrice: 0.3,
        unitSize: 1_000_000,
        includedQuantity: 10_000_000,
        rounding,
      },
    },
  ],
});
const readings = (...reports: UsageReport[]): Map<string, DailyUsage> =>
  new Map(reports.map((r) => [r.date, { report: r, finalized: true }]));

test('shares the monthly allowance and charges the fixed subscription once', () => {
  const usage = readings(report('2026-10-01', 8_000_000), report('2026-10-02', 4_000_000));
  const yesterday = calculate(cycle, usage, '2026-10-01');
  const today = calculate(cycle, usage, '2026-10-02');
  assert.equal(yesterday.total, 5);
  assert.equal(today.total, 5.6);
  assert.equal(today.services.find((s) => s.key === 'requests')!.todayCost, 0.6);
  assert.equal(today.services.find((s) => s.key === '__base_fee')!.todayCost, 0);
});
test('rounds billable blocks across the cycle, never once per day', () => {
  const usage = readings(
    report('2026-10-01', 10_000_001, 'up'),
    report('2026-10-02', 999_999, 'up'),
    report('2026-10-03', 1, 'up'),
  );
  assert.equal(calculate(cycle, usage, '2026-10-01').total, 5.3);
  assert.equal(calculate(cycle, usage, '2026-10-02').total, 5.3);
  assert.equal(calculate(cycle, usage, '2026-10-03').total, 5.6);
});
test('daily allowance resets, missing dates are explicit, and unknown costs do not become complete', () => {
  const first = report('2026-10-01', 12_000_000);
  first.meters[0]!.pricing.allowancePeriod = 'day';
  const third = report('2026-10-03', 12_000_000);
  third.meters[0]!.pricing.allowancePeriod = 'day';
  const result = calculate(cycle, readings(first, third), '2026-10-03');
  assert.equal(result.total, 6.2);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingDates, ['2026-10-02']);
});
test('rejects mismatched dates, duplicate meters, negative quantity, and invalid price divisors', () => {
  const value = report('2026-10-01', 1);
  assert.throws(() => validateUsage(value, cycle, '2026-10-02'), /date mismatch/);
  value.meters[0]!.quantity = -1;
  assert.throws(() => validateUsage(value, cycle, value.date), /Invalid usage/);
  value.meters[0]!.quantity = 1;
  value.meters[0]!.pricing.unitSize = 0;
  assert.throws(() => validateUsage(value, cycle, value.date), /price unit/);
});

test('one-pass daily totals retain earlier completeness and carry missing days forward', () => {
  const usage = readings(report('2026-10-01', 12_000_000), report('2026-10-03', 1_000_000));
  const result = calculateDaily(cycle, usage, '2026-10-03');
  assert.deepEqual(
    [...result.dailyTotals],
    [
      ['2026-10-01', { total: 5.6, complete: true }],
      ['2026-10-02', { total: 5.6, complete: false }],
      ['2026-10-03', { total: 5.9, complete: false }],
    ],
  );
  assert.deepEqual(result.calculation.missingDates, ['2026-10-02']);
  usage.get('2026-10-01')!.finalized = false;
  assert.equal(
    calculateDaily(cycle, usage, '2026-10-01', '2026-10-01', true).calculation.complete,
    false,
  );
});

test('daily summaries do not round the running balance or reuse the latest price for earlier days', () => {
  const reports = ['2026-10-01', '2026-10-02', '2026-10-03'].map((date, index) => {
    const value = report(date, 1);
    Object.assign(value.meters[0]!.pricing, {
      unitPrice: index === 2 ? 0.0000008 : 0.0000004,
      unitSize: 1,
      includedQuantity: 0,
    });
    return value;
  });
  const result = calculateDaily({ ...cycle, baseFee: 0 }, readings(...reports), '2026-10-03');
  assert.deepEqual(
    [...result.dailyTotals.values()],
    [
      { total: 0, complete: true },
      { total: 0.000001, complete: true },
      { total: 0.000002, complete: true },
    ],
  );
  assert.equal(result.calculation.total, 0.000002);
});
