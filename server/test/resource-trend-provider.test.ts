import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceTrendReader } from '@/resources/cloudflare/resource-trend';
import type { BillingCycle } from '@/types';

const cycle: BillingCycle = {
  id: '2026-10-09:2026-11-09',
  start: '2026-10-09',
  end: '2026-11-09',
  currency: 'USD',
  workersPaid: true,
};
const now = () => new Date('2026-10-10T00:20:00Z');
const apiJson = (result: unknown) => Response.json({ success: true, result });
const graphJson = (result: unknown) => Response.json({ data: { viewer: { accounts: [result] } } });
const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];

function reader(
  handler: (
    query: string,
    url: string,
    body?: Record<string, unknown>,
  ) => Response | Promise<Response>,
  retention = 90 * 86400,
  pageSize = 10000,
) {
  return createResourceTrendReader({
    accountId: 'a'.repeat(32),
    token: 'test-token',
    now,
    fetch: (async (input, options) => {
      const url = String(input);
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ url, body });
      const query = body?.query ?? '';
      if (query.includes('settings{')) {
        const names = [...query.matchAll(/(\w+)\{enabled notOlderThan maxPageSize\}/g)].map(
          (match) => match[1]!,
        );
        return graphJson({
          settings: Object.fromEntries(
            names.map((name) => [
              name,
              { enabled: true, notOlderThan: retention, maxPageSize: pageSize },
            ]),
          ),
        });
      }
      return handler(query, url, body);
    }) as typeof fetch,
  });
}

function currentDay(query: string) {
  return query.includes('datetime_geq:"2026-10-10');
}

test('DO resource duration groups native five-minute buckets by namespace and resolves script/class names', async () => {
  const read = reader((query, url) => {
    if (url.includes('/namespaces'))
      return apiJson([
        { id: 'a', script: 'editor', class: 'Container' },
        { id: 'b', name: 'reader_Room' },
      ]);
    assert.match(query, /dimensions\{namespaceId datetimeFiveMinutes\}/);
    return graphJson({
      durableObjectsPeriodicGroups: currentDay(query)
        ? [
            {
              dimensions: { namespaceId: 'a', datetimeFiveMinutes: '2026-10-10T00:00:00Z' },
              sum: { duration: 4 },
            },
            {
              dimensions: { namespaceId: 'a', datetimeFiveMinutes: '2026-10-10T00:05:00Z' },
              sum: { duration: 6 },
            },
            {
              dimensions: { namespaceId: 'b', datetimeFiveMinutes: '2026-10-10T00:15:00Z' },
              sum: { duration: 3 },
            },
          ]
        : [],
    });
  });
  const trend = await read(
    cycle,
    'Durable Objects',
    'worker_durable_objects_duration',
    'ten-minute',
  );
  assert.deepEqual(trend.resources, [
    { id: 'a', name: 'editor / Container', total: 10 },
    { id: 'b', name: 'reader_Room', total: 3 },
  ]);
  assert.deepEqual({ ...trend.points.at(-2)?.quantities }, { a: 10, b: 0 });
  assert.deepEqual({ ...trend.points.at(-1)?.quantities }, { a: 0, b: 3 });
  assert.equal(trend.unit, 'GB-seconds');
  assert.equal(trend.unavailableReason, null);
});

test('DO requests combine per-resource invocations and WebSocket messages without billing hibernations', async () => {
  const read = reader((query, url) => {
    if (url.includes('/namespaces')) return apiJson([]);
    if (query.includes('durableObjectsPeriodicGroups('))
      return graphJson({
        durableObjectsPeriodicGroups: currentDay(query)
          ? [
              {
                dimensions: { namespaceId: 'a', datetimeFiveMinutes: '2026-10-10T00:05:00Z' },
                sum: { inboundWebsocketMsgCount: 40 },
              },
              {
                dimensions: { namespaceId: 'b', datetimeFiveMinutes: '2026-10-10T00:00:00Z' },
                sum: { inboundWebsocketMsgCount: 20 },
              },
            ]
          : [],
      });
    return graphJson({
      durableObjectsInvocationsAdaptiveGroups: currentDay(query)
        ? [
            {
              dimensions: {
                namespaceId: 'a',
                datetimeFiveMinutes: '2026-10-10T00:00:00Z',
                type: 'http',
              },
              sum: { requests: 3 },
            },
            {
              dimensions: {
                namespaceId: 'a',
                datetimeFiveMinutes: '2026-10-10T00:00:00Z',
                type: 'hibernation',
              },
              sum: { requests: 100 },
            },
          ]
        : [],
    });
  });
  const trend = await read(
    cycle,
    'Durable Objects',
    'worker_durable_objects_requests',
    'ten-minute',
  );
  assert.deepEqual({ ...trend.points.at(-2)?.quantities }, { a: 5, b: 1 });
  assert.deepEqual(
    trend.resources.map((resource) => resource.total),
    [5, 1],
  );
});

test('Containers preserve memory units and region classification, falling back to application ID when directory is forbidden', async () => {
  const read = reader((query, url) => {
    if (url.includes('/containers/applications')) return new Response(null, { status: 403 });
    assert.match(query, /applicationId datetimeFiveMinutes region/);
    return graphJson({
      containersUsageAdaptiveGroups: currentDay(query)
        ? [
            {
              dimensions: {
                applicationId: 'app-a',
                datetimeFiveMinutes: '2026-10-10T00:00:00Z',
                region: 'WNAM',
              },
              sum: { allocatedMemory: 2 ** 30 * 30, txBytes: 2e9 },
            },
            {
              dimensions: {
                applicationId: 'app-a',
                datetimeFiveMinutes: '2026-10-10T00:05:00Z',
                region: 'OC',
              },
              sum: { allocatedMemory: 2 ** 30 * 20, txBytes: 3e9 },
            },
          ]
        : [],
    });
  });
  const memory = await read(cycle, 'Containers', 'cloudchamber_memory_usage', 'ten-minute');
  assert.deepEqual(memory.resources, [{ id: 'app-a', name: 'app-a', total: 50 }]);
  assert.match(memory.warnings.join(' '), /403/);
  const egress = await read(cycle, 'Containers', 'cloudchamber_egress_na_eu', 'ten-minute');
  assert.equal(egress.resources[0]?.total, 2);
});

test('hourly storage quantities account for the current partial hour and never invent ten-minute samples', async () => {
  const read = reader((query, url) => {
    if (url.includes('/namespaces')) return apiJson([]);
    assert.match(query, /dimensions\{namespaceId datetimeHour\}/);
    return graphJson({
      durableObjectsSqlStorageGroups: currentDay(query)
        ? [
            {
              dimensions: { namespaceId: 'a', datetimeHour: '2026-10-10T00:00:00Z' },
              max: { storedBytes: 720e9 },
            },
          ]
        : [],
    });
  });
  const trend = await read(
    cycle,
    'Durable Objects',
    'worker_durable_objects_srs_stored_data',
    'ten-minute',
  );
  assert.equal(trend.resolution, 'hourly');
  assert.equal(trend.resources[0]?.total, 1 / 3);
  assert.equal(trend.points.at(-1)?.timestamp, '2026-10-10T00:00:00.000Z');
});

test('R2 storage keeps each bucket daily peak instead of charging the peak again for every hour', async () => {
  const read = reader((query) =>
    graphJson({
      r2StorageAdaptiveGroups: currentDay(query)
        ? [
            {
              dimensions: {
                bucketName: 'media',
                datetimeHour: '2026-10-10T00:00:00Z',
                storageClass: 'Standard',
              },
              max: { payloadSize: 30e9 },
            },
          ]
        : [
            {
              dimensions: {
                bucketName: 'media',
                datetimeHour: '2026-10-09T00:00:00Z',
                storageClass: 'Standard',
              },
              max: { payloadSize: 60e9 },
            },
            {
              dimensions: {
                bucketName: 'media',
                datetimeHour: '2026-10-09T01:00:00Z',
                storageClass: 'Standard',
              },
              max: { payloadSize: 90e9 },
            },
          ],
    }),
  );
  const trend = await read(cycle, 'R2', 'r2_storage', 'ten-minute');
  assert.equal(trend.resolution, 'daily');
  assert.deepEqual(
    trend.points.map((point) => point.quantities.media),
    [3, 1],
  );
  assert.equal(trend.resources[0]?.total, 4);
});

test('partial API failures and capped results create gaps, not misleading zero usage', async () => {
  const read = reader(
    (query) => {
      assert.match(query, /status_neq:"internalError"/);
      return graphJson({
        workersInvocationsAdaptive: currentDay(query)
          ? [{ dimensions: { scriptName: 'editor', date: '2026-10-10' }, sum: { requests: 2 } }]
          : [
              { dimensions: { scriptName: 'editor', date: '2026-10-09' }, sum: { requests: 9 } },
              { dimensions: { scriptName: 'reader', date: '2026-10-09' }, sum: { requests: 4 } },
            ],
      });
    },
    90 * 86400,
    2,
  );
  const trend = await read(cycle, 'Workers', 'worker_standard_request', 'daily');
  assert.equal(trend.resources[0]?.total, 2);
  assert.deepEqual(
    trend.points.map((point) => point.quantities.editor),
    [null, 2],
  );
  assert.match(trend.warnings.join(' '), /查询上限/);
});

test('resource history respects the live retention boundary and unsupported meters do not make API calls', async () => {
  const before = calls.length;
  const read = reader((query) => graphJson({ workersInvocationsAdaptive: [] }), 86400);
  const build = await read(cycle, 'Workers Builds', 'worker_build_minutes', 'daily');
  assert.match(build.unavailableReason!, /没有提供按 Worker/);
  const subscription = await read(cycle, '订阅', '__base_fee', 'daily');
  assert.match(subscription.unavailableReason!, /固定订阅/);
  assert.equal(calls.length, before);
  const trend = await read(cycle, 'Workers', 'worker_standard_request', 'daily');
  assert.equal(trend.start, '2026-10-10T00:00:00.000Z');
  assert.match(trend.warnings.join(' '), /最近 1 天/);
  assert.equal(trend.points.length, 1);
  await assert.rejects(() => read(cycle, 'R2', 'worker_standard_request', 'daily'), /不匹配/);
});

test('Workers Logs use read-only grouped counts and verified millisecond granularity', async () => {
  const read = reader((_query, url, body) => {
    assert.match(url, /observability\/telemetry\/query/);
    assert.equal(body?.dry, true);
    assert.equal(body?.granularity, 600000);
    assert.deepEqual((body?.parameters as { groupBys: unknown }).groupBys, [
      { type: 'string', value: '$metadata.service' },
    ]);
    const today = (body?.timeframe as { from: number }).from === Date.parse('2026-10-10');
    return apiJson({
      run: { status: 'COMPLETED', granularity: 600000 },
      calculations: [
        {
          calculation: 'count',
          aggregates: today ? [{ value: 5 }] : [],
          series: today
            ? [
                {
                  time: '2026-10-10 00:10:00',
                  data: [{ groups: [{ key: '$metadata.service', value: 'editor' }], value: 5 }],
                },
              ]
            : [],
        },
      ],
    });
  });
  const trend = await read(cycle, 'Workers Logs', 'worker_observability_events', 'ten-minute');
  assert.deepEqual(trend.resources, [{ id: 'editor', name: 'editor', total: 5 }]);
  assert.deepEqual({ ...trend.points.at(-1)?.quantities }, { editor: 5 });
});

test('legacy DO storage cannot distribute a combined namespace sample arbitrarily', async () => {
  const read = reader(() =>
    graphJson({
      durableObjectsStorageGroups: [
        {
          dimensions: { namespaceIds: ['a', 'b'], datetimeHour: '2026-10-10T00:00:00Z' },
          max: { storedBytes: 720e9 },
        },
      ],
    }),
  );
  const trend = await read(
    cycle,
    'Durable Objects',
    'worker_durable_objects_stored_data',
    'ten-minute',
  );
  assert.equal(trend.resources.length, 0);
  assert.ok(trend.unavailableReason);
  assert.match(trend.warnings.join(' '), /无法可靠拆分/);
});

test('resource names remain data keys and invalid quantities remain missing', async () => {
  const read = reader((query) =>
    graphJson({
      workersInvocationsAdaptive: currentDay(query)
        ? [
            { dimensions: { scriptName: '__proto__', date: '2026-10-10' }, sum: { requests: 3 } },
            { dimensions: { scriptName: 'invalid', date: '2026-10-10' }, sum: { requests: -1 } },
          ]
        : [],
    }),
  );
  const trend = await read(cycle, 'Workers', 'worker_standard_request', 'daily');
  assert.equal(trend.points.at(-1)?.quantities.__proto__, 3);
  assert.equal(trend.points.at(-1)?.quantities.invalid, null);
  assert.match(trend.warnings.join(' '), /数值无效/);
  assert.equal(trend.resources.find((resource) => resource.id === '__proto__')?.total, 3);
});

test('incremental resource windows align full buckets and coalesce meters sharing a dataset', async () => {
  let analyticsCalls = 0;
  const read = reader((query, url) => {
    if (url.includes('/namespaces')) return apiJson([{ id: 'a', name: 'Room' }]);
    analyticsCalls++;
    assert.match(query, /datetime_geq:"2026-10-10T00:00:00.000Z"/);
    assert.match(query, /datetime_lt:"2026-10-10T00:20:00.000Z"/);
    return graphJson({
      durableObjectsPeriodicGroups: [
        {
          dimensions: { namespaceId: 'a', datetimeFiveMinutes: '2026-10-10T00:05:00Z' },
          sum: { duration: 4, rowsRead: 8 },
        },
      ],
    });
  });
  const bounds = { start: '2026-10-10T00:07:00Z', end: '2026-10-10T00:20:00Z' };
  const [duration, reads] = await Promise.all([
    read(cycle, 'Durable Objects', 'worker_durable_objects_duration', 'ten-minute', bounds),
    read(
      cycle,
      'Durable Objects',
      'worker_durable_objects_srs_storage_reads',
      'ten-minute',
      bounds,
    ),
  ]);
  assert.equal(analyticsCalls, 1);
  assert.equal(duration.start, '2026-10-10T00:00:00.000Z');
  assert.equal(duration.points.length, 2);
  assert.deepEqual(duration.coverage, [
    { start: duration.start, end: duration.end, complete: true },
  ]);
  assert.equal(reads.points.length, 2);
  await assert.rejects(
    read(cycle, 'Durable Objects', 'worker_durable_objects_duration', 'daily', {
      start: 'invalid',
      end: bounds.end,
    }),
    /时间范围无效/,
  );
});
