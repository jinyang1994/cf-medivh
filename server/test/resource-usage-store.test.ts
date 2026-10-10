import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@/repositories/billing-store';
import type { BillingCycle, ResourceUsageTrend } from '@/types';

const cycle: BillingCycle = {
  id: '2026-10-10:2026-11-10',
  start: '2026-10-10',
  end: '2026-11-10',
  currency: 'USD',
};
const service = 'Workers';
const meter = 'worker_standard_request';
const at = (minute: number) => `2026-10-10T00:${String(minute).padStart(2, '0')}:00.000Z`;
const range = (
  values: Array<Record<string, number | null>>,
  overrides: Partial<ResourceUsageTrend> = {},
): ResourceUsageTrend => ({
  service,
  meterKey: meter,
  unit: 'requests',
  resolution: 'ten-minute',
  start: at(0),
  end: at(values.length * 10),
  fetchedAt: at(values.length * 10),
  resources: [{ id: 'editor', name: 'Editor Worker', total: 9999 }],
  points: values.map((quantities, index) => ({ timestamp: at(index * 10), quantities })),
  warnings: [],
  unavailableReason: null,
  ...overrides,
});
const read = (store: Store, end = at(20)) =>
  store.resourceUsage.read(cycle, service, meter, 'ten-minute', new Date(end))!;

test('resource observations are idempotent replacements and totals are recomputed from saved buckets', () => {
  const store = new Store(':memory:');
  try {
    const trend = range([{ editor: 2 }, { editor: 3 }]);
    store.resourceUsage.save(cycle, 'ten-minute', trend);
    store.resourceUsage.save(cycle, 'ten-minute', trend);
    assert.equal(read(store).resources[0]?.total, 5);
    const corrected = range([{ editor: 7 }, { editor: 4 }], { fetchedAt: at(25) });
    store.resourceUsage.save(cycle, 'ten-minute', corrected);
    store.resourceUsage.save(cycle, 'ten-minute', trend);
    assert.equal(read(store).resources[0]?.total, 11);
    assert.equal(store.resourceUsage.lastCollected(cycle.id, service, meter, 'ten-minute'), at(25));
    assert.equal(
      (store.db.prepare('SELECT count(*) AS n FROM resource_usage_values').get() as { n: number })
        .n,
      2,
    );
  } finally {
    store.close();
  }
});

test('short recollections merge with history and fully observed removals replace previous resource values with zero', () => {
  const store = new Store(':memory:');
  try {
    store.resourceUsage.save(
      cycle,
      'ten-minute',
      range(
        [
          { editor: 5, reader: 4 },
          { editor: 6, reader: 7 },
        ],
        {
          resources: [
            { id: 'editor', name: 'Editor Worker', total: 11 },
            { id: 'reader', name: 'Reader Worker', total: 11 },
          ],
        },
      ),
    );
    store.resourceUsage.save(
      cycle,
      'ten-minute',
      range([{ editor: 8 }], {
        start: at(10),
        end: at(20),
        fetchedAt: at(25),
        points: [{ timestamp: at(10), quantities: { editor: 8 } }],
      }),
    );
    const result = read(store);
    assert.equal(result.resources.find((resource) => resource.id === 'editor')?.total, 13);
    assert.equal(result.resources.find((resource) => resource.id === 'reader')?.total, 4);
    assert.deepEqual({ ...result.points[0]?.quantities }, { editor: 5, reader: 4 });
    assert.deepEqual({ ...result.points[1]?.quantities }, { editor: 8, reader: 0 });
  } finally {
    store.close();
  }
});

test('failed attempts and null buckets never erase observed quantities or resolved names', () => {
  const store = new Store(':memory:');
  try {
    store.resourceUsage.save(cycle, 'ten-minute', range([{ editor: 5 }, { editor: 7 }]));
    store.resourceUsage.save(
      cycle,
      'ten-minute',
      range([{ editor: null }, { editor: null }], {
        fetchedAt: at(25),
        resources: [{ id: 'editor', name: 'editor', total: 0 }],
        warnings: ['Cloudflare HTTP 503'],
        unavailableReason: '采集失败',
      }),
    );
    const result = read(store);
    assert.deepEqual(result.resources, [{ id: 'editor', name: 'Editor Worker', total: 12 }]);
    assert.equal(result.unavailableReason, null);
    assert.match(result.warnings.join(' '), /保留已保存的用量/);
    assert.equal(store.resourceUsage.lastCollected(cycle.id, service, meter, 'ten-minute'), at(25));
    assert.equal(
      store.resourceUsage.coverage(cycle.id, service, meter, 'ten-minute')[0]?.complete,
      false,
    );
  } finally {
    store.close();
  }
});

test('missing collection slots remain null while successfully empty slots are zero for known resources', () => {
  const store = new Store(':memory:');
  try {
    store.resourceUsage.save(
      cycle,
      'ten-minute',
      range([{ editor: 5 }], { end: at(20), fetchedAt: at(20) }),
    );
    let result = read(store, at(30));
    assert.equal(result.points[0]?.quantities.editor, 5);
    assert.equal(result.points[1]?.quantities.editor, null);
    assert.equal(result.points[2]?.quantities.editor, null);
    assert.match(result.warnings.join(' '), /尚未采集或采集失败/);
    store.resourceUsage.save(
      cycle,
      'ten-minute',
      range([], {
        start: at(10),
        end: at(20),
        fetchedAt: at(25),
        resources: [],
        points: [{ timestamp: at(10), quantities: {} }],
      }),
    );
    result = read(store);
    assert.equal(result.points[1]?.quantities.editor, 0);
    assert.equal(result.resources[0]?.total, 5);
  } finally {
    store.close();
  }
});

test('daily windows persist complete and failed empty-resource coverage independently', () => {
  const store = new Store(':memory:');
  try {
    store.resourceUsage.save(
      cycle,
      'daily',
      range([], {
        resolution: 'daily',
        start: '2026-10-10T00:00:00.000Z',
        end: '2026-10-12T00:00:00.000Z',
        fetchedAt: '2026-10-12T00:00:00.000Z',
        resources: [],
        points: [
          { timestamp: '2026-10-10T00:00:00.000Z', quantities: {} },
          { timestamp: '2026-10-11T00:00:00.000Z', quantities: {} },
        ],
        warnings: ['目录读取失败，名称使用 ID'],
        coverage: [
          { start: '2026-10-10T00:00:00.000Z', end: '2026-10-11T00:00:00.000Z', complete: true },
          { start: '2026-10-11T00:00:00.000Z', end: '2026-10-12T00:00:00.000Z', complete: false },
        ],
      }),
    );
    assert.deepEqual(
      store.resourceUsage.coverage(cycle.id, service, meter, 'daily').map((item) => item.complete),
      [true, false],
    );
    const result = store.resourceUsage.read(
      cycle,
      service,
      meter,
      'daily',
      new Date('2026-10-12T00:00:00Z'),
    )!;
    assert.equal(result.unavailableReason, null);
    assert.match(result.warnings.join(' '), /尚未采集或采集失败/);
    assert.equal(
      store.resourceUsage.read(cycle, service, meter, 'ten-minute', new Date(at(20))),
      null,
    );
  } finally {
    store.close();
  }
});

test('stored time series survives reopening and keeps cycles, meters, requested and actual resolutions separate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'medivh-resource-store-'));
  const file = join(directory, 'billing.sqlite');
  let store = new Store(file);
  try {
    store.resourceUsage.save(cycle, 'ten-minute', range([{ editor: 4 }, { editor: 5 }]));
    store.resourceUsage.save(
      cycle,
      'daily',
      range([], {
        resolution: 'daily',
        resources: [{ id: 'editor', name: 'Editor Worker', total: 20 }],
        points: [{ timestamp: at(0), quantities: { editor: 20 } }],
        end: at(20),
        fetchedAt: at(20),
      }),
    );
    const otherCycle = { ...cycle, id: 'other-cycle' };
    store.resourceUsage.save(otherCycle, 'ten-minute', range([{ editor: 99 }]));
    store.close();
    store = new Store(file);
    assert.equal(read(store).resources[0]?.total, 9);
    const daily = store.resourceUsage.read(cycle, service, meter, 'daily', new Date(at(20)))!;
    assert.equal(daily.resources[0]?.total, 20);
    assert.equal(daily.resolution, 'daily');
    assert.equal(
      store.resourceUsage.read(otherCycle, service, meter, 'ten-minute', new Date(at(10)))
        ?.resources[0]?.total,
      99,
    );
    assert.equal(
      store.resourceUsage.read(cycle, service, 'uncollected-meter', 'daily', new Date(at(20))),
      null,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('48-hour reads retain old history on disk and preserve native hourly storage buckets', () => {
  const store = new Store(':memory:');
  try {
    store.resourceUsage.save(
      cycle,
      'ten-minute',
      range([], {
        resolution: 'hourly',
        unit: 'GB-months',
        start: '2026-10-10T00:00:00.000Z',
        end: '2026-10-13T00:00:00.000Z',
        fetchedAt: '2026-10-13T00:00:00.000Z',
        points: [
          { timestamp: '2026-10-10T00:00:00.000Z', quantities: { editor: 500 } },
          { timestamp: '2026-10-11T00:00:00.000Z', quantities: { editor: 3 } },
        ],
      }),
    );
    const result = read(store, '2026-10-13T00:00:00.000Z');
    assert.equal(result.resolution, 'hourly');
    assert.equal(result.start, '2026-10-11T00:00:00.000Z');
    assert.equal(result.points.length, 48);
    assert.equal(result.resources[0]?.total, 3);
    const withPrefix = store.resourceUsage.read(
      cycle,
      service,
      meter,
      'ten-minute',
      new Date('2026-10-13T00:00:00.000Z'),
      { start: '2026-10-09T00:00:00.000Z' },
    )!;
    assert.equal(
      withPrefix.start,
      '2026-10-10T00:00:00.000Z',
      'explicit ranges cannot precede the cycle',
    );
    assert.equal(withPrefix.points.length, 72);
    assert.equal(
      withPrefix.resources[0]?.total,
      503,
      'stored earlier intraday usage is available for cost baselines',
    );
    const empty = store.resourceUsage.read(
      cycle,
      service,
      meter,
      'ten-minute',
      new Date('2026-10-13T00:00:00.000Z'),
      { start: '2026-10-14T00:00:00.000Z' },
    )!;
    assert.equal(empty.start, empty.end, 'explicit starts are capped at the read end');
    assert.deepEqual(empty.points, []);
    assert.equal(
      (
        store.db
          .prepare(
            "SELECT quantity FROM resource_usage_values WHERE timestamp='2026-10-10T00:00:00.000Z'",
          )
          .get() as { quantity: number }
      ).quantity,
      500,
    );
  } finally {
    store.close();
  }
});

test('failed collections cannot replace native granularity or units and hide persisted data', () => {
  const store = new Store(':memory:');
  try {
    store.resourceUsage.save(
      cycle,
      'ten-minute',
      range([{ editor: 5 }], {
        resolution: 'hourly',
        unit: 'GB-months',
        end: at(20),
        fetchedAt: at(20),
      }),
    );
    store.resourceUsage.save(
      cycle,
      'ten-minute',
      range([], {
        resources: [],
        resolution: 'ten-minute',
        unit: 'unavailable',
        end: at(20),
        fetchedAt: at(25),
        unavailableReason: 'API 请求失败',
      }),
    );
    const result = read(store);
    assert.equal(result.resolution, 'hourly');
    assert.equal(result.unit, 'GB-months');
    assert.equal(result.points.length, 1);
    assert.equal(result.resources[0]?.total, 5);
    assert.equal(result.unavailableReason, null);
    assert.match(result.warnings.join(' '), /API 请求失败/);
  } finally {
    store.close();
  }
});

test('unavailable first collections remain unavailable and named resources cannot poison object prototypes', () => {
  const store = new Store(':memory:');
  try {
    store.resourceUsage.save(
      cycle,
      'ten-minute',
      range([], {
        end: at(20),
        fetchedAt: at(20),
        unavailableReason: '此指标不支持具体资源',
        resources: [],
      }),
    );
    assert.equal(read(store).unavailableReason, '此指标不支持具体资源');
    store.resourceUsage.save(
      cycle,
      'ten-minute',
      range([{ ['__proto__']: 3 }, { ['__proto__']: Number.NaN }], {
        fetchedAt: at(25),
        resources: [{ id: '__proto__', name: 'Prototype Worker', total: 0 }],
      }),
    );
    const result = read(store);
    assert.equal(result.points[0]?.quantities['__proto__'], 3);
    assert.equal(result.points[1]?.quantities['__proto__'], null);
    assert.equal(result.resources[0]?.total, 3);
    assert.equal(
      store.resourceUsage.coverage(cycle.id, service, meter, 'ten-minute')[0]?.complete,
      false,
    );
  } finally {
    store.close();
  }
});
