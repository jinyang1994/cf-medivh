import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createBillingMcpServer } from '@/mcp/server';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';
import { dashboard } from '@/services/dashboard';
import { dailyServices } from '@/services/daily-services';
import { dailyMeterTrend } from '@/services/daily-meter-trend';
import { serviceTrend } from '@/services/service-trend';
import { resourceTrend } from '@/services/resource-trend';
import { resourceCostTrend } from '@/services/resource-cost-trend';
import type { BillingCycle, UsageMeter } from '@/types';

const now = new Date('2026-10-03T00:21:00Z');
const cycle: BillingCycle = {
  id: 'mcp-tools',
  start: '2026-10-01',
  end: '2026-11-01',
  currency: 'USD',
  baseFee: 5,
};
const selected = { service: 'Workers', meter: 'worker_standard_request' };
const qualityWarning = '历史日志超出保留期，费用仅从可用记录估算';
const toolArguments: Record<string, Record<string, unknown>> = {
  get_billing_summary: {},
  list_billing_services: {},
  get_billing_history: {},
  get_daily_costs: { date: cycle.start },
  get_service_cost_trend: selected,
  get_resource_usage: selected,
  get_resource_cost_trend: selected,
  get_daily_meter_trend: { ...selected, date: cycle.start },
};

function meters(requests: number, cpu: number, objects: number): UsageMeter[] {
  return [
    {
      key: selected.meter,
      service: selected.service,
      name: '请求',
      unit: 'requests',
      quantity: requests,
      pricing: { currency: 'USD', unitPrice: 2, unitSize: 1, includedQuantity: 10 },
    },
    {
      key: 'worker_standard_cpu_ms',
      service: 'Workers',
      name: 'CPU 时间',
      unit: 'CPU-ms',
      quantity: cpu,
      pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 0 },
    },
    {
      key: 'objects',
      service: 'R2',
      name: '对象',
      unit: 'objects',
      quantity: objects,
      pricing: { currency: 'USD', unitPrice: 0.5, unitSize: 1, includedQuantity: 0 },
    },
  ];
}

function populate(store: Store) {
  store.saveCycle(cycle);
  for (const [date, observedAt, quantities, finalized] of [
    ['2026-10-01', '2026-10-01T00:01:00Z', [3, 1, 1], false],
    ['2026-10-01', '2026-10-01T00:11:00Z', [8, 4, 3], false],
    ['2026-10-01', '2026-10-01T23:51:00Z', [8, 4, 3], true],
    ['2026-10-02', '2026-10-02T23:51:00Z', [5, 6, 2], true],
    ['2026-10-03', '2026-10-03T00:11:00Z', [4, 1, 1], false],
  ] as const)
    store.saveUsage(
      cycle,
      {
        date,
        observedAt,
        meters: meters(...quantities),
        complete: true,
        warnings: [qualityWarning],
      },
      finalized,
    );
  for (const [date, amount, requests, cpu, objects] of [
    ['2026-10-01', 10.5, 0, 4, 1.5],
    ['2026-10-02', 23.5, 6, 10, 2.5],
  ] as const)
    store.saveBill(
      cycle,
      {
        through: date,
        currency: 'USD',
        amount,
        serviceCosts: {
          __base_fee: 5,
          [selected.meter]: requests,
          worker_standard_cpu_ms: cpu,
          objects,
        },
      },
      '2026-10-03T00:00:00Z',
      amount,
      true,
      {},
    );
  store.resourceUsage.save(cycle, 'daily', {
    service: selected.service,
    meterKey: selected.meter,
    unit: 'requests',
    resolution: 'daily',
    start: '2026-10-01T00:00:00.000Z',
    end: '2026-10-03T00:00:00.000Z',
    fetchedAt: '2026-10-03T00:00:00.000Z',
    resources: [{ id: 'worker-a', name: 'Worker A', total: 5 }],
    points: [
      { timestamp: '2026-10-01T00:00:00.000Z', quantities: { 'worker-a': 3 } },
      { timestamp: '2026-10-02T00:00:00.000Z', quantities: { 'worker-a': 2 } },
    ],
    warnings: [],
    unavailableReason: null,
  });
  store.fail('usage', 'private provider diagnostic', now.toISOString());
  store.enqueueNotification({
    kind: 'collection_failure',
    id: 'private-notification',
    attemptedAt: now.toISOString(),
    slot: now.toISOString(),
    cycle,
    errors: ['private provider diagnostic'],
    lastSuccessfulAt: null,
  });
  store.retryNotification(
    'private-notification',
    now.toISOString(),
    'notification secret https://example.test/private-webhook',
  );
}

// The in-memory SDK transport preserves null-prototype maps; JSON transports do not.
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value));

async function fixture(t: TestContext, state: 'populated' | 'empty' | 'incomplete' = 'populated') {
  const store = new Store(':memory:');
  if (state === 'populated') populate(store);
  if (state === 'incomplete') {
    store.saveCycle(cycle);
    store.saveUsage(
      cycle,
      {
        date: '2026-10-03',
        observedAt: now.toISOString(),
        complete: false,
        meters: meters(4, 1, 1),
      },
      false,
    );
  }
  let providerCalls = 0;
  const unexpectedCollection = async (): Promise<never> => {
    providerCalls++;
    throw new Error('MCP queries must never call the provider');
  };
  const collector = new Collector(
    store,
    {
      getBillingCycle: unexpectedCollection,
      getUsage: unexpectedCollection,
      getOfficialBill: unexpectedCollection,
      getResourceTrend: unexpectedCollection,
    },
    () => now,
  );
  const before = store.db.prepare('SELECT total_changes() AS n').get();
  const server = createBillingMcpServer(store, collector);
  const client = new Client({ name: 'billing-tools-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
    collector.stop();
    assert.equal(providerCalls, 0);
    assert.deepEqual(store.db.prepare('SELECT total_changes() AS n').get(), before);
    store.close();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.equal(response.content.length, 1);
    const content = response.content[0]!;
    assert.equal(content.type, 'text');
    assert.ok('text' in content && typeof content.text === 'string');
    const body = JSON.parse(content.text);
    assert.deepEqual(
      body,
      asJson(response.structuredContent),
      'text and structured results must agree',
    );
    return body;
  };
  return { store, collector, client, call };
}

test('MCP discovery advertises exactly eight read-only tools and explains billing semantics', async (t) => {
  const { client } = await fixture(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(toolArguments).sort());
  for (const tool of tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.match(client.getInstructions() ?? '', /Dates are UTC/);
  assert.match(client.getInstructions() ?? '', /null means unavailable, never zero/);
  assert.match(client.getInstructions() ?? '', /Resource costs are estimated allocations/);
});

test('MCP tools reject extra fields, invalid identifiers, dates, ranges, and pagination', async (t) => {
  const { client } = await fixture(t);
  const invalid: [string, Record<string, unknown>][] = [
    ...Object.entries(toolArguments).map(([name, args]): [string, Record<string, unknown>] => [
      name,
      { ...args, extra: true },
    ]),
    ['list_billing_services', { service: '' }],
    ['list_billing_services', { service: '   ' }],
    ['list_billing_services', { service: 'x'.repeat(201) }],
    ['list_billing_services', { limit: 0 }],
    ['list_billing_services', { limit: 501 }],
    ['list_billing_services', { limit: 1.5 }],
    ['list_billing_services', { limit: '2' }],
    ['list_billing_services', { offset: -1 }],
    ['list_billing_services', { offset: Number.MAX_SAFE_INTEGER + 1 }],
    ['get_daily_costs', {}],
    ['get_daily_costs', { date: '2026-02-30' }],
    ['get_daily_costs', { date: '2026-10-1' }],
    ['get_daily_costs', { date: '2026-10-01T00:00:00Z' }],
    ['get_billing_history', { startDate: '2026-02-30' }],
    ['get_billing_history', { startDate: '2026-10-03', endDate: '2026-10-01' }],
    ['get_service_cost_trend', { ...selected, meter: ' ' }],
    ['get_service_cost_trend', { ...selected, resolution: 'hourly' }],
    ['get_resource_usage', { service: 'Workers' }],
    ['get_resource_usage', { ...selected, meter: 'x'.repeat(201) }],
    ['get_resource_cost_trend', { ...selected, offset: 0.5 }],
    ['get_daily_meter_trend', { ...selected, date: '2026-02-30' }],
  ];
  for (const [name, args] of invalid) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
  }
});

test('empty databases preserve null amounts and return explicit unavailable tool results', async (t) => {
  const { client, call } = await fixture(t, 'empty');
  const summary = await call('get_billing_summary');
  assert.equal(summary.cycle, null);
  assert.equal(summary.asOf, null);
  assert.equal(summary.totals.current, null);
  assert.equal(summary.totals.localCumulative, null);
  assert.equal(summary.totals.complete, false);
  assert.deepEqual((await call('list_billing_services')).services, []);
  assert.deepEqual((await call('get_billing_history')).history, []);
  for (const [name, args] of Object.entries(toolArguments).slice(3))
    assert.equal((await client.callTool({ name, arguments: args })).isError, true, name);
});

test('future and outside-cycle days are unavailable while missing historical costs remain null', async (t) => {
  const { client, call } = await fixture(t, 'incomplete');
  for (const date of ['2026-09-30', cycle.end, '2026-10-04']) {
    for (const name of ['get_daily_costs', 'get_daily_meter_trend']) {
      const args = name === 'get_daily_costs' ? { date } : { ...selected, date };
      assert.equal((await client.callTool({ name, arguments: args })).isError, true, date);
    }
  }
  const detail = await call('get_daily_costs', { date: '2026-10-03', service: 'Workers' });
  const requests = detail.services.find((row: UsageMeter) => row.key === selected.meter);
  assert.equal(detail.complete, false);
  assert.equal(requests.quantity, 4);
  assert.equal(requests.cost, null);
  assert.equal(requests.officialCost, null);
  assert.equal(requests.allowanceUsed, null);
  const futureHistory = await call('get_billing_history', { startDate: '2026-10-04' });
  assert.deepEqual(futureHistory.history, []);
});

test('summary, service discovery, daily details, and history reuse business calculations and filter before paging', async (t) => {
  const { store, collector, call } = await fixture(t);
  const view = dashboard(store, collector, now);
  const summary = await call('get_billing_summary');
  assert.deepEqual(summary.totals, view.totals);
  assert.equal(summary.queriedAt, now.toISOString());
  assert.equal(summary.timezone, 'UTC');
  assert.equal(summary.today, '2026-10-03');
  assert.equal(summary.collection.errorCount, 1);
  assert.equal(summary.collection.warningCount, view.collection.warnings.length);
  assert.equal('errors' in summary.collection, false);
  assert.equal('warnings' in summary.collection, false);
  assert.deepEqual(summary.warnings, [qualityWarning]);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /private provider diagnostic|notification secret|private-webhook/,
  );

  const workers = view.services.filter((row) => row.service === 'Workers');
  const first = await call('list_billing_services', { service: 'Workers', limit: 1 });
  assert.deepEqual(first.services, workers.slice(0, 1));
  assert.deepEqual(first.pagination, { offset: 0, limit: 1, total: 2, nextOffset: 1 });
  const second = await call('list_billing_services', { service: 'Workers', offset: 1, limit: 1 });
  assert.deepEqual(second.services, workers.slice(1));
  assert.equal(second.pagination.nextOffset, null);
  assert.deepEqual((await call('list_billing_services', { service: 'workers' })).services, []);
  const pastEnd = await call('list_billing_services', { offset: 100 });
  assert.deepEqual(pastEnd.services, []);
  assert.equal(pastEnd.pagination.nextOffset, null);

  const detail = dailyServices(store, '2026-10-02', now)!;
  const daily = await call('get_daily_costs', {
    date: '2026-10-02',
    service: 'Workers',
    offset: 1,
    limit: 1,
  });
  assert.deepEqual(
    daily.services,
    detail.services.filter((row) => row.service === 'Workers').slice(1),
  );
  assert.equal(daily.pagination.total, 2);
  const requests = detail.services.find((row) => row.key === selected.meter)!;
  assert.equal(requests.cost, 6, 'cycle allowance is applied before daily marginal charges');

  const history = await call('get_billing_history', {
    startDate: '2026-10-02',
    endDate: '2026-10-03',
    limit: 1,
  });
  assert.deepEqual(history.history, view.history.slice(1, 2));
  assert.deepEqual(history.pagination, { offset: 0, limit: 1, total: 2, nextOffset: 1 });
  assert.equal(history.history[0].dailyCostSource, 'official');
  const last = await call('get_billing_history', { startDate: '2026-10-02', offset: 1, limit: 1 });
  assert.deepEqual(last.history, view.history.slice(2));
  assert.equal(last.pagination.nextOffset, null);
});

test('service trends preserve daily and sampled cumulative charges for a meter or whole service', async (t) => {
  const { store, call } = await fixture(t);
  for (const meter of [selected.meter, undefined]) {
    const trend = serviceTrend(store, selected.service, meter ?? null, now)!;
    for (const resolution of ['daily', 'ten-minute'] as const) {
      const response = await call('get_service_cost_trend', {
        service: selected.service,
        ...(meter ? { meter } : {}),
        resolution,
        offset: 1,
        limit: 2,
      });
      const points = resolution === 'daily' ? trend.history : trend.timeline;
      assert.deepEqual(response.points, points.slice(1, 3));
      assert.equal(response.pagination.total, points.length);
      assert.equal(response.meterKey, meter ?? null);
      assert.equal(response.resolution, resolution);
    }
  }
  assert.equal((await call('get_service_cost_trend', selected)).resolution, 'daily');
});

test('resource tools preserve usage, estimated allocation labels, unallocated costs, and full-window totals', async (t) => {
  const { store, collector, call } = await fixture(t);
  const usage = resourceTrend(store, collector, selected.service, selected.meter, 'daily', now)!;
  const actualUsage = await call('get_resource_usage', { ...selected, limit: 1 });
  assert.deepEqual(actualUsage.points, asJson(usage.points.slice(0, 1)));
  assert.deepEqual(actualUsage.resources, usage.resources);
  assert.equal(actualUsage.total, usage.total);
  assert.equal(actualUsage.totalComplete, usage.totalComplete);
  assert.equal(actualUsage.pagination.total, usage.points.length);

  const costs = resourceCostTrend(store, selected.service, selected.meter, 'daily', now)!;
  const actualCost = await call('get_resource_cost_trend', { ...selected, offset: 1, limit: 1 });
  assert.equal(actualCost.costBasis, 'estimated-resource-allocation');
  assert.deepEqual(actualCost.points, asJson(costs.points.slice(1, 2)));
  assert.deepEqual(actualCost.resources, costs.resources);
  assert.deepEqual(actualCost.warnings, costs.warnings);
  assert.ok(actualCost.points[0].unattributedCost > 0);
  const attributed = Object.values(actualCost.points[0].costs).reduce<number>(
    (sum, cost) => sum + Number(cost ?? 0),
    0,
  );
  assert.equal(attributed + actualCost.points[0].unattributedCost, actualCost.points[0].total);

  const fixed = await call('get_resource_usage', { service: '订阅', meter: '__base_fee' });
  assert.equal(fixed.unavailableReason, '固定订阅费用没有具体资源用量。');
  assert.deepEqual(fixed.resources, []);
});

test('daily meter pagination keeps usage and cost timestamps aligned and preserves missing intervals', async (t) => {
  const { store, call } = await fixture(t);
  const trend = dailyMeterTrend(store, cycle.start, selected.service, selected.meter, now)!;
  const first = await call('get_daily_meter_trend', { ...selected, date: cycle.start, limit: 2 });
  assert.deepEqual(first.usage.points, trend.usage.points.slice(0, 2));
  assert.deepEqual(first.cost.points, trend.cost.points.slice(0, 2));
  assert.equal(first.usage.points[0].total, 8);
  assert.equal(first.usage.points[1].total, null);
  assert.equal(first.cost.points[1].total, 0);
  assert.deepEqual(first.pagination, { offset: 0, limit: 2, total: 144, nextOffset: 2 });
  const next = await call('get_daily_meter_trend', {
    ...selected,
    date: cycle.start,
    offset: first.pagination.nextOffset,
    limit: 2,
  });
  assert.deepEqual(next.usage.points, trend.usage.points.slice(2, 4));
  assert.deepEqual(next.cost.points, trend.cost.points.slice(2, 4));
  assert.deepEqual(
    next.usage.points.map((point: { timestamp: string }) => point.timestamp),
    next.cost.points.map((point: { timestamp: string }) => point.timestamp),
  );
  assert.equal(next.usage.total, trend.usage.total);
});

test('all tool failures hide internal database details', async (t) => {
  const { store, client } = await fixture(t);
  t.mock.method(store, 'activeCycle', () => {
    throw new Error('private database path /secret/billing.sqlite SELECT users');
  });
  for (const [name, args] of Object.entries(toolArguments)) {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, true, name);
    assert.doesNotMatch(JSON.stringify(response), /private database|\/secret|SELECT users/);
  }
});
