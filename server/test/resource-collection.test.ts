import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';
import { collectResourceUsage } from '@/services/resource-collection';
import { createFeishuExtension } from '@/resources/notifications';
import type {
  BillingCycle,
  CloudflareProvider,
  Notification,
  ResourceUsageTrend,
  UsageReport,
} from '@/types';

const cycle: BillingCycle = {
  id: 'resource-oct',
  start: '2026-10-01',
  end: '2026-11-01',
  currency: 'USD',
};
const meter = (key = 'requests', quantity = 0) => ({
  key,
  service: 'Workers',
  name: key,
  unit: 'requests',
  quantity,
  pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 0 },
});
const usage = (now: Date): UsageReport => ({
  date: now.toISOString().slice(0, 10),
  observedAt: now.toISOString(),
  complete: true,
  source: 'analytics',
  meters: [meter()],
});
const forbidden = async (): Promise<never> => {
  throw new Error('Resource-only collection must not query billing');
};
const providerWith = (
  getResourceTrend: NonNullable<CloudflareProvider['getResourceTrend']>,
): CloudflareProvider => ({
  getBillingCycle: forbidden,
  getUsage: forbidden,
  getOfficialBill: forbidden,
  getResourceTrend,
});
function success(
  service: string,
  meterKey: string,
  resolution: 'ten-minute' | 'daily',
  window: { start: string; end: string },
  fetchedAt = window.end,
): ResourceUsageTrend {
  const interval = resolution === 'daily' ? 86_400_000 : 600_000;
  const points: ResourceUsageTrend['points'] = [];
  for (
    let time = Math.ceil(Date.parse(window.start) / interval) * interval;
    time < Date.parse(window.end);
    time += interval
  ) {
    points.push({ timestamp: new Date(time).toISOString(), quantities: { 'worker-a': 7 } });
  }
  return {
    service,
    meterKey,
    unit: 'requests',
    resolution,
    ...window,
    fetchedAt,
    resources: [{ id: 'worker-a', name: 'Worker A', total: 7 * points.length }],
    points,
    warnings: [],
    coverage: [{ ...window, complete: true }],
    unavailableReason: null,
  };
}
function seed(store: Store, now: Date) {
  store.saveCycle(cycle);
  store.saveUsage(cycle, usage(now), false);
}
const count = (store: Store, table: string) =>
  (store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;

test('resource-only initialization persists zero-usage meters and bounds concurrency without billing or notifications', async () => {
  const store = new Store(':memory:');
  const now = new Date('2026-10-10T12:00:00Z');
  seed(store, now);
  store.saveUsage(
    cycle,
    {
      ...usage(now),
      meters: [
        meter(),
        meter('cpu'),
        { ...meter('__base_fee'), pricing: { ...meter().pricing, fixedFee: 5 } },
      ],
    },
    false,
  );
  let concurrent = 0;
  let maximum = 0;
  const calls: { key: string; resolution: string; start: string; end: string }[] = [];
  const provider = providerWith(async (_cycle, service, key, resolution, window) => {
    assert.ok(window);
    maximum = Math.max(maximum, ++concurrent);
    await new Promise((resolve) => setImmediate(resolve));
    concurrent--;
    calls.push({ key, resolution, ...window });
    return success(service, key, resolution, window);
  });
  try {
    const first = collectResourceUsage(store, provider, cycle, now);
    assert.equal(
      collectResourceUsage(store, provider, cycle, now),
      first,
      'coalesces concurrent local invocations',
    );
    assert.deepEqual(await first, { attempted: 4, succeeded: 4, failed: 0, skipped: 0 });
    assert.equal(maximum, 2);
    assert.equal(calls.filter((call) => call.key === 'requests').length, 2);
    assert.ok(calls.every((call) => call.end === now.toISOString()));
    assert.ok(
      calls
        .filter((call) => call.resolution === 'ten-minute')
        .every((call) => call.start === '2026-10-08T12:00:00.000Z'),
    );
    assert.ok(
      calls
        .filter((call) => call.resolution === 'daily')
        .every((call) => call.start === '2026-10-01T00:00:00.000Z'),
    );
    assert.equal(
      store.resourceUsage.lastCollected(cycle.id, 'Workers', 'requests', 'daily'),
      now.toISOString(),
    );
    assert.equal(count(store, 'usage_snapshots'), 2);
    assert.equal(count(store, 'billing_points'), 0);
    assert.equal(count(store, 'notification_outbox'), 0);
    assert.deepEqual(store.errors(), []);
  } finally {
    store.close();
  }
});

test('successful windows skip the same slot and overlap recent data while recovering missed runs', async () => {
  const store = new Store(':memory:');
  let now = new Date('2026-10-10T12:00:00Z');
  seed(store, now);
  const calls: { resolution: string; start: string; end: string }[] = [];
  const provider = providerWith(async (_cycle, service, key, resolution, window) => {
    assert.ok(window);
    calls.push({ resolution, ...window });
    return success(service, key, resolution, window);
  });
  try {
    await collectResourceUsage(store, provider, cycle, now);
    assert.deepEqual(await collectResourceUsage(store, provider, cycle, now), {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 2,
    });
    now = new Date('2026-10-10T12:10:00Z');
    await collectResourceUsage(store, provider, cycle, now);
    assert.equal(calls[2]!.start, '2026-10-10T10:00:00.000Z');
    assert.equal(calls[3]!.start, '2026-10-08T00:00:00.000Z');
    now = new Date('2026-10-12T12:00:00Z');
    await collectResourceUsage(store, provider, cycle, now);
    assert.equal(
      calls[4]!.start,
      '2026-10-10T10:10:00.000Z',
      'missed intervals remain part of the next request',
    );
    assert.equal(calls[5]!.start, '2026-10-10T00:00:00.000Z');
  } finally {
    store.close();
  }
});

test('an early partial-history failure is retried beyond the recent window without requerying expired history', async () => {
  const store = new Store(':memory:');
  let now = new Date('2026-10-10T12:00:00Z');
  seed(store, now);
  const dailyStarts: string[] = [];
  const provider = providerWith(async (_cycle, service, key, resolution, window) => {
    assert.ok(window);
    if (resolution !== 'daily') return success(service, key, resolution, window);
    dailyStarts.push(window.start);
    if (dailyStarts.length > 1) return success(service, key, resolution, window);
    const start = '2026-10-02T00:00:00.000Z';
    return {
      ...success(service, key, resolution, { start, end: window.end }),
      coverage: [
        { start, end: '2026-10-03T00:00:00.000Z', complete: true },
        { start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z', complete: false },
        { start: '2026-10-04T00:00:00.000Z', end: window.end, complete: true },
      ],
      warnings: ['Older data is no longer retained; one window failed.'],
    };
  });
  try {
    assert.equal((await collectResourceUsage(store, provider, cycle, now)).failed, 1);
    now = new Date('2026-10-10T12:10:00Z');
    await collectResourceUsage(store, provider, cycle, now);
    assert.equal(dailyStarts[1], '2026-10-03T00:00:00.000Z');
    now = new Date('2026-10-10T12:20:00Z');
    await collectResourceUsage(store, provider, cycle, now);
    assert.equal(dailyStarts[2], '2026-10-08T00:00:00.000Z');
  } finally {
    store.close();
  }
});

test('failed refreshes preserve stored resource values and retry the next slot without advancing successful coverage', async () => {
  const store = new Store(':memory:');
  let now = new Date('2026-10-10T12:00:00Z');
  let failing = false;
  seed(store, now);
  const calls: { resolution: string; start: string }[] = [];
  const provider = providerWith(async (_cycle, service, key, resolution, window) => {
    assert.ok(window);
    calls.push({ resolution, start: window.start });
    if (failing) throw new Error('temporary upstream failure');
    return success(service, key, resolution, window);
  });
  try {
    await collectResourceUsage(store, provider, cycle, now);
    now = new Date('2026-10-10T12:10:00Z');
    failing = true;
    assert.equal((await collectResourceUsage(store, provider, cycle, now)).failed, 2);
    const persisted = store.resourceUsage.read(cycle, 'Workers', 'requests', 'daily', now);
    assert.ok(persisted);
    assert.ok(persisted.points.some((point) => point.quantities['worker-a'] === 7));
    assert.equal((await collectResourceUsage(store, provider, cycle, now)).attempted, 0);
    assert.deepEqual(store.errors(), []);
    assert.equal(count(store, 'notification_outbox'), 0);
    failing = false;
    now = new Date('2026-10-10T12:20:00Z');
    assert.equal((await collectResourceUsage(store, provider, cycle, now)).succeeded, 2);
    assert.equal(calls[4]!.start, '2026-10-10T10:00:00.000Z');
  } finally {
    store.close();
  }
});

test('a same-slot process restart initializes resource history without repeating billing or sent notifications', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-resource-collector-'));
  const path = join(directory, 'billing.sqlite');
  const now = new Date('2026-10-01T12:00:00Z');
  let store = new Store(path);
  let usageCalls = 0;
  let resourceCalls = 0;
  const sent: Notification[] = [];
  const provider: CloudflareProvider = {
    getBillingCycle: async () => cycle,
    getUsage: async () => {
      usageCalls++;
      return usage(now);
    },
    getOfficialBill: forbidden,
  };
  try {
    await new Collector(store, provider, () => now, [
      createFeishuExtension(async (value) => {
        sent.push(value);
      }),
    ]).tick();
    assert.equal(sent.length, 1);
    store.close();
    store = new Store(path);
    provider.getResourceTrend = async (_cycle, service, key, resolution, window) => {
      assert.ok(window);
      resourceCalls++;
      return success(service, key, resolution, window);
    };
    const collector = new Collector(store, provider, () => now, [
      createFeishuExtension(async (value) => {
        sent.push(value);
      }),
    ]);
    assert.equal(await collector.tick(), false);
    assert.equal(resourceCalls, 2);
    assert.equal(usageCalls, 1);
    assert.equal(sent.length, 1);
    store.close();
    store = new Store(path);
    assert.equal(await new Collector(store, provider, () => now).tick(), false);
    assert.equal(resourceCalls, 2, 'completed resource slots also survive restart');
    assert.equal(count(store, 'notification_outbox'), 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test('resource API failures happen after the normal billing notification and do not mark billing failed', async () => {
  const store = new Store(':memory:');
  const now = new Date('2026-10-01T12:00:00Z');
  const sent: Notification[] = [];
  const provider: CloudflareProvider = {
    getBillingCycle: async () => cycle,
    getUsage: async () => usage(now),
    getOfficialBill: forbidden,
    getResourceTrend: async () => {
      assert.equal(
        sent.length,
        1,
        'billing notifications are not delayed until resource backfill completes',
      );
      throw new Error('resource permission denied');
    },
  };
  try {
    assert.equal(
      await new Collector(store, provider, () => now, [
        createFeishuExtension(async (value) => {
          sent.push(value);
        }),
      ]).tick(),
      true,
    );
    assert.equal(store.get('lastSuccess'), now.toISOString());
    assert.deepEqual(store.errors(), []);
    assert.equal(sent.length, 1);
    assert.notEqual(sent[0]!.kind, 'collection_failure');
    assert.equal(count(store, 'billing_points'), 1);
  } finally {
    store.close();
  }
});

test('providers without resource analytics retain their existing collector behavior', async () => {
  const store = new Store(':memory:');
  try {
    seed(store, new Date('2026-10-10T12:00:00Z'));
    assert.deepEqual(
      await collectResourceUsage(
        store,
        { getBillingCycle: forbidden, getUsage: forbidden, getOfficialBill: forbidden },
        cycle,
      ),
      { attempted: 0, succeeded: 0, failed: 0, skipped: 0 },
    );
  } finally {
    store.close();
  }
});

test('native daily storage also refreshes the preceding two UTC days in its short-window stream', async () => {
  const store = new Store(':memory:');
  let now = new Date('2026-10-10T12:00:00Z');
  seed(store, now);
  const shortStarts: string[] = [];
  const provider = providerWith(async (_cycle, service, key, resolution, window) => {
    assert.ok(window);
    if (resolution === 'ten-minute') shortStarts.push(window.start);
    // The provider exposes R2 storage only as complete UTC-day samples.
    return success(service, key, 'daily', {
      start: `${window.start.slice(0, 10)}T00:00:00.000Z`,
      end: window.end,
    });
  });
  try {
    await collectResourceUsage(store, provider, cycle, now);
    now = new Date('2026-10-10T12:10:00Z');
    await collectResourceUsage(store, provider, cycle, now);
    assert.equal(shortStarts[1], '2026-10-08T00:00:00.000Z');
    now = new Date('2026-10-11T12:00:00Z');
    await collectResourceUsage(store, provider, cycle, now);
    assert.equal(shortStarts[2], '2026-10-09T00:00:00.000Z');
  } finally {
    store.close();
  }
});
