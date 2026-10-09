import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@/repositories/billing-store';
import { billingTimeline, financialPoint, recoverBillingTimeline } from '@/services/timeline';
import { Collector } from '@/services/collector';
import type { BillingCycle, CloudflareProvider, UsageReport } from '@/types';

const cycle: BillingCycle = {
  id: 'timeline',
  start: '2026-10-01',
  end: '2026-10-04',
  currency: 'USD',
  baseFee: 5,
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
  source: 'analytics',
  meters: [
    {
      key: 'requests',
      service: 'Workers',
      name: 'Requests',
      unit: 'requests',
      quantity,
      pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 10 },
    },
  ],
});

test('recovery uses only evidence present at each observation, excluding later appended corrections and later official revisions', () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  const historical = report('2026-10-01', '2026-10-02T00:01:00Z', 8);
  store.saveUsage(cycle, historical, true);
  store.saveBill(
    cycle,
    { through: '2026-10-01', amount: 5.2, currency: 'USD' },
    '2026-10-02T00:02:00Z',
    999,
    true,
    { sources: [{ observedAt: '2026-10-03T00:00:00Z' }] },
  );
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T00:11:00Z', 5), false);
  // This appended correction retains the original observation time, so an id cutoff is essential.
  store.saveUsage(
    cycle,
    {
      ...historical,
      meters: [{ ...historical.meters[0]!, quantity: 20 }],
      raw: { corrections: [{ at: '2026-10-02T00:25:00Z' }] },
    },
    true,
  );
  store.saveBill(
    cycle,
    { through: '2026-10-01', amount: 15, currency: 'USD' },
    '2026-10-02T00:22:00Z',
    999,
    true,
    {},
  );
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T00:31:00Z', 7), false);
  // A patched same-day snapshot is evidence for later observations, never a new old-slot observation.
  store.saveUsage(
    cycle,
    {
      ...report('2026-10-02', '2026-10-02T00:11:00Z', 50),
      raw: { corrections: [{ at: '2026-10-02T00:40:00Z' }] },
    },
    false,
  );
  recoverBillingTimeline(store, new Date('2026-10-02T00:43:00Z'));
  const points = store.billingPoints(cycle.id);
  assert.equal(points.length, 2);
  assert.equal(points[0]!.timestamp, '2026-10-02T00:10:00.000Z');
  assert.equal(points[0]!.localTotal, 8);
  assert.equal(points[0]!.currentTotal, 8.2);
  assert.equal(points[0]!.source, 'reconstructed');
  assert.equal(points[1]!.localTotal, 22);
  assert.equal(points[1]!.currentTotal, 22);
  const timeline = billingTimeline(store, cycle, new Date('2026-10-02T00:43:00Z'));
  assert.deepEqual(
    timeline.map((point) => point.currentTotal),
    [8.2, null, 22, null],
  );
  assert.equal(timeline[1]!.observedAt, null);
  // Re-running recovery is a no-op and cannot reread large raw history or change old points.
  store.usageSnapshotEvidence = () => {
    throw new Error('history should not be scanned twice');
  };
  recoverBillingTimeline(store, new Date('2026-10-03T00:00:00Z'));
  assert.deepEqual(store.billingPoints(cycle.id), points);
  store.close();
});

test('initial observations without a historical baseline stay unknown; failed observations cannot repeat stale values', () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T12:01:00Z', 5), false);
  store.saveUsage(cycle, report('2026-10-01', '2026-10-02T12:02:00Z', 8), true);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T12:11:00Z', 5), false);
  store.saveUsage(cycle, report('2026-10-02', '2026-10-02T12:21:00Z', 999, false), false);
  recoverBillingTimeline(store, new Date('2026-10-02T12:29:00Z'));
  const timeline = billingTimeline(store, cycle, new Date('2026-10-02T12:29:00Z'));
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0]!.localTotal, null);
  assert.equal(timeline[1]!.localTotal, 8);
  assert.equal(
    timeline[1]!.currentTotal,
    null,
    'missing historical official amount is not treated as zero',
  );
  assert.equal(timeline[2]!.localTotal, null);
  assert.equal(timeline[2]!.observedAt, null);
  store.close();
});

test('one slot keeps the latest successful observation and does not downgrade it to a later partial or recovered point', () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  const first = report('2026-10-01', '2026-10-01T12:01:00Z', 12);
  store.saveUsage(cycle, first, false);
  store.saveBillingPoint(
    cycle.id,
    financialPoint(cycle, store.usage(cycle.id), null, first),
    'collection',
    first.observedAt,
  );
  const second = report('2026-10-01', '2026-10-01T12:05:00Z', 13);
  store.saveUsage(cycle, second, false);
  const successful = financialPoint(cycle, store.usage(cycle.id), null, second);
  store.saveBillingPoint(cycle.id, successful, 'collection', second.observedAt);
  store.saveBillingPoint(
    cycle.id,
    { ...successful, observedAt: '2026-10-01T12:09:00Z', currentTotal: null },
    'collection',
    '2026-10-01T12:09:00Z',
  );
  store.saveBillingPoint(
    cycle.id,
    {
      ...successful,
      observedAt: '2026-10-01T12:09:00Z',
      currentTotal: 999,
      source: 'reconstructed',
    },
    'recovery',
    '2026-10-02T12:00:00Z',
  );
  assert.deepEqual(store.billingPoints(cycle.id), [successful]);
  store.close();
});

test('UTC midnight uses yesterday official plus only the new day marginal charge, with no duplicate subscription', () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  const last = report('2026-10-01', '2026-10-01T23:59:00Z', 12);
  store.saveUsage(cycle, last, true);
  const before = financialPoint(cycle, store.usage(cycle.id), null, last);
  assert.equal(before.timestamp, '2026-10-01T23:50:00.000Z');
  assert.equal(before.currentTotal, 7);
  const next = report('2026-10-02', '2026-10-02T00:01:00Z', 2);
  store.saveUsage(cycle, next, false);
  const after = financialPoint(cycle, store.usage(cycle.id), 7.2, next);
  assert.equal(after.timestamp, '2026-10-02T00:00:00.000Z');
  assert.equal(after.todayLocal, 2);
  assert.equal(after.currentTotal, 9.2);
  assert.equal(after.localTotal, 9);
  store.close();
});

test('collector persists each real successful observation, keeps past amounts immutable, and leaves failures as gaps', async () => {
  const store = new Store(':memory:');
  let now = new Date('2026-10-02T00:01:00Z');
  let quantity = 5;
  let officialAmount = 5.2;
  let fail = false;
  const provider: CloudflareProvider = {
    getBillingCycle: async () => cycle,
    getUsage: async (_cycle, date) => {
      if (date === '2026-10-02' && fail) throw new Error('temporary failure');
      return report(date, now.toISOString(), date === '2026-10-01' ? 8 : quantity);
    },
    getOfficialBill: async (_cycle, date) => ({
      through: date,
      amount: officialAmount,
      currency: 'USD',
    }),
  };
  const collector = new Collector(store, provider, () => now);
  await collector.tick();
  assert.equal(store.billingPoints(cycle.id)[0]!.currentTotal, 8.2);
  now = new Date('2026-10-02T00:05:00Z');
  quantity = 6;
  await collector.tick(true);
  assert.equal(store.billingPoints(cycle.id).length, 1);
  assert.equal(store.billingPoints(cycle.id)[0]!.currentTotal, 9.2);
  now = new Date('2026-10-02T00:11:00Z');
  fail = true;
  officialAmount = 5.4;
  await collector.tick();
  assert.equal(
    store.billingPoints(cycle.id).length,
    1,
    'an old complete daily record must not become a new point after failure',
  );
  assert.equal(
    store.billingPoints(cycle.id)[0]!.currentTotal,
    9.2,
    'a later official correction must not rewrite a past point',
  );
  now = new Date('2026-10-02T00:21:00Z');
  fail = false;
  quantity = 7;
  await collector.tick();
  const points = billingTimeline(store, cycle, now);
  assert.deepEqual(
    points.map((point) => point.currentTotal),
    [9.2, null, 10.4],
  );
  assert.equal(points[2]!.source, 'collected');
  const evidence = JSON.parse(
    (
      store.db.prepare('SELECT evidence FROM billing_points ORDER BY slot DESC LIMIT 1').get() as {
        evidence: string;
      }
    ).evidence,
  );
  assert.ok(evidence.observationSnapshotId > 0);
  assert.ok(evidence.usageSnapshotIds['2026-10-01'] > 0);
  assert.ok(evidence.official.versionId > 0);
  store.close();
});

test('startup recovers legacy history even if the current scheduler slot has already completed', async () => {
  const store = new Store(':memory:');
  store.saveCycle(cycle);
  store.saveUsage(cycle, report('2026-10-01', '2026-10-01T12:01:00Z', 12), false);
  store.set('lastSlot', '2026-10-01T12:00:00.000Z');
  const provider: CloudflareProvider = {
    getBillingCycle: async () => {
      throw new Error('must not call the provider twice in this slot');
    },
    getUsage: async () => {
      throw new Error('not called');
    },
    getOfficialBill: async () => null,
  };
  assert.equal(
    await new Collector(store, provider, () => new Date('2026-10-01T12:05:00Z')).tick(),
    false,
  );
  assert.equal(store.billingPoints(cycle.id)[0]!.currentTotal, 7);
  assert.equal(store.billingPoints(cycle.id)[0]!.source, 'reconstructed');
  store.close();
});
