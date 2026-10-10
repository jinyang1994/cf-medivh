import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceCostTrend, ResourceUsageTrend } from '../src/types/billing.ts';
import { resourceTrendSeries } from '../src/utils/resource-trend-series.ts';

const usage: ResourceUsageTrend = {
  service: 'Workers',
  meterKey: 'requests',
  unit: 'requests',
  resolution: 'ten-minute',
  start: '2026-10-10T00:00:00Z',
  end: '2026-10-10T00:20:00Z',
  fetchedAt: '2026-10-10T00:20:00Z',
  resources: [
    { id: 'worker.a', name: 'Worker A', total: 5 },
    { id: 'worker.b', name: 'Worker B', total: 7 },
  ],
  points: [
    { timestamp: '2026-10-10T00:00:00Z', quantities: { 'worker.a': 2, 'worker.b': 3 } },
    { timestamp: '2026-10-10T00:10:00Z', quantities: { 'worker.a': 3, 'worker.b': 4 } },
  ],
  warnings: [],
  unavailableReason: null,
};

test('usage totals include every resource independently of displayed curves and preserve missing buckets', () => {
  const result = resourceTrendSeries({
    ...usage,
    points: [
      ...usage.points,
      { timestamp: '2026-10-10T00:20:00Z', quantities: { 'worker.a': 0, 'worker.b': 0 } },
      { timestamp: '2026-10-10T00:30:00Z', quantities: { 'worker.a': 0, 'worker.b': null } },
      { timestamp: '2026-10-10T00:40:00Z', quantities: { 'worker.a': 1 } },
    ],
  });
  assert.deepEqual(
    result.points.map((point) => point.values.total),
    [5, 7, 0, null, null],
  );
  assert.equal(result.series[0].kind, 'total');
  assert.equal(result.series[0].total, 12);
  const visible = result.series.filter((series) => series.resourceId !== 'worker.b');
  assert.equal(visible.length, 2);
  assert.equal(result.points[0].values.total, 5);
});

test('resource IDs cannot collide with synthetic totals or Recharts paths', () => {
  const ids = ['total', '__total__', 'unattributed', 'official', 'has.dot', '__proto__'];
  const result = resourceTrendSeries({
    ...usage,
    resources: ids.map((id) => ({ id, name: id, total: 1 })),
    points: [{ timestamp: usage.start, quantities: Object.fromEntries(ids.map((id) => [id, 1])) }],
  });
  assert.equal(new Set(result.series.map((series) => series.key)).size, ids.length + 1);
  assert.equal(new Set(result.series.map((series) => series.toggleKey)).size, ids.length + 1);
  assert.equal(result.points[0].values.total, ids.length);
  for (const series of result.series.filter((series) => series.kind === 'resource')) {
    assert.equal(result.points[0].values[series.key], 1);
  }
});

const costs: ResourceCostTrend = {
  service: usage.service,
  meterKey: usage.meterKey,
  currency: 'USD',
  resolution: 'daily',
  start: usage.start,
  end: usage.end,
  fetchedAt: usage.fetchedAt,
  resources: [{ id: 'worker.a', name: 'Worker A', total: 0.00288 }],
  points: [
    {
      timestamp: '2026-10-09T00:00:00Z',
      total: 0.003,
      officialCost: 0,
      costs: { 'worker.a': 0.002 },
      unattributedCost: 0.001,
    },
    {
      timestamp: '2026-10-10T00:00:00Z',
      total: 0.005,
      officialCost: 0.0045,
      costs: { 'worker.a': 0.00288 },
      unattributedCost: 0.00212,
    },
  ],
  warnings: [],
  unavailableReason: null,
};

test('cost curves preserve exact cumulative values and keep official and unattributed amounts separate', () => {
  const result = resourceTrendSeries(costs);
  assert.deepEqual(
    result.series.map((series) => [series.kind, series.total]),
    [
      ['total', 0.005],
      ['resource', 0.00288],
      ['unattributed', 0.00212],
      ['official', 0.0045],
    ],
  );
  assert.equal(result.points[0].values.official, 0);
  assert.equal(result.points[1].values.resource0, 0.00288);
  assert.equal(result.points[1].values.total, 0.005);
  assert.equal(result.points[1].values.unattributed, 0.00212);
});

test('totals remain available without identified resources and optional curves only appear when applicable', () => {
  const result = resourceTrendSeries({
    ...costs,
    resolution: 'ten-minute',
    resources: [],
    points: costs.points.map((point) => ({ ...point, costs: {}, unattributedCost: point.total })),
  });
  assert.deepEqual(
    result.series.map((series) => series.kind),
    ['total', 'unattributed'],
  );
  assert.equal(result.points[1].values.total, 0.005);
  const attributed = resourceTrendSeries({
    ...costs,
    points: costs.points.map((point) => ({ ...point, unattributedCost: 0, officialCost: null })),
  });
  assert.deepEqual(
    attributed.series.map((series) => series.kind),
    ['total', 'resource'],
  );
});
