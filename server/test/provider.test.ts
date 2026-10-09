import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleFromAnchor,
  officialThrough,
  createCloudflareProvider,
  type BillableRow,
} from '@/resources/cloudflare/provider';
import {
  analyticsQuery,
  quantitiesFromAnalytics,
  datasets,
} from '@/resources/cloudflare/analytics';
import { meterDefinition, priceForServiceName } from '@/services/pricing';
import { PRICE_CATALOG_VERSION } from '@/constants/pricing';
import type { BillingCycle } from '@/types';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';

const cycle: BillingCycle = {
  id: '2026-09-16:2026-10-16',
  start: '2026-09-16',
  end: '2026-10-16',
  currency: 'USD',
  baseFee: 5,
  workersPaid: true,
};
function bill(date: string, amount: number, overrides: Partial<BillableRow> = {}): BillableRow {
  return {
    ServiceName: 'Workers Standard Requests (first 10M are included)',
    ServiceFamilyName: 'Workers',
    BillingPeriodStart: `${cycle.start}T00:00:00Z`,
    ChargePeriodStart: `${date}T00:00:00Z`,
    ChargePeriodEnd: new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString(),
    BillingCurrency: 'USD',
    ConsumedQuantity: 100,
    ContractedCost: amount,
    SubscriptionId: 'fixture',
    ...overrides,
  };
}

test('billing anchors preserve UTC boundaries and clamp short months without drifting', () => {
  assert.deepEqual(
    cycleFromAnchor(
      '2024-01-31T00:00:00Z',
      '2024-01-31T00:00:00Z',
      new Date('2026-02-28T00:00:00Z'),
    ),
    { start: '2026-02-28', end: '2026-03-31' },
  );
  assert.deepEqual(
    cycleFromAnchor(
      '2024-01-31T00:00:00Z',
      '2024-01-31T00:00:00Z',
      new Date('2026-02-27T23:59:59Z'),
    ),
    { start: '2026-01-31', end: '2026-02-28' },
  );
  assert.deepEqual(
    cycleFromAnchor(
      '2024-01-31T00:00:00Z',
      '2024-01-31T00:00:00Z',
      new Date('2024-02-29T00:00:00Z'),
    ),
    { start: '2024-02-29', end: '2024-03-31' },
  );
  assert.throws(() => cycleFromAnchor('not-a-date', '2026-01-01', new Date()), /周期日期/);
});

test('billing anchors retain the subscription start floor and roll over exactly at the UTC boundary', () => {
  assert.deepEqual(
    cycleFromAnchor(
      '2026-01-31T00:00:00Z',
      '2026-02-05T12:00:00Z',
      new Date('2026-02-12T00:00:00Z'),
    ),
    { start: '2026-02-05', end: '2026-02-28' },
  );
  assert.deepEqual(
    cycleFromAnchor(
      '2024-01-30T16:00:00-08:00',
      '2024-01-31T00:00:00Z',
      new Date('2026-03-30T23:59:59.999Z'),
    ),
    { start: '2026-02-28', end: '2026-03-31' },
  );
  assert.deepEqual(
    cycleFromAnchor(
      '2024-01-31T00:00:00Z',
      '2024-01-31T00:00:00Z',
      new Date('2026-03-31T00:00:00Z'),
    ),
    { start: '2026-03-31', end: '2026-04-30' },
  );
});

test('official cumulative amount uses daily charges, includes the target day and base fee once', () => {
  const first = { ...bill('2026-09-16', 1), CumulatedContractedCost: 1 };
  const second = { ...bill('2026-09-17', 2), CumulatedContractedCost: 3 };
  const later = { ...bill('2026-09-18', 8), CumulatedContractedCost: 11 };
  const previousCycle = bill('2026-09-16', 999, { BillingPeriodStart: '2026-08-16T00:00:00Z' });
  assert.equal(
    officialThrough([first, second, later, previousCycle], cycle, '2026-09-17')?.amount,
    8,
  );
  assert.equal(officialThrough([first, second], cycle, '2026-09-16')?.amount, 6);
  assert.equal(officialThrough([bill('2026-09-16', 0)], cycle, '2026-09-16')?.amount, 5);
});

test('empty, wrong-period and delayed official data remain pending instead of becoming a zero bill', () => {
  assert.equal(officialThrough([], cycle, '2026-09-17'), null);
  assert.equal(officialThrough([bill('2026-09-16', 0)], cycle, '2026-09-17'), null);
  assert.equal(
    officialThrough(
      [bill('2026-09-17', 0, { BillingPeriodStart: '2026-08-16T00:00:00Z' })],
      cycle,
      '2026-09-17',
    ),
    null,
  );
  assert.throws(
    () => officialThrough([bill('2026-09-17', NaN)], cycle, '2026-09-17'),
    /金额或币种/,
  );
  assert.throws(
    () => officialThrough([bill('2026-09-17', 1, { BillingCurrency: 'EUR' })], cycle, '2026-09-17'),
    /金额或币种/,
  );
});

test('analytics preserve CPU and container billing units and account-wide egress regions', () => {
  const result = quantitiesFromAnalytics(
    {
      workersInvocationsAdaptive: [{ sum: { requests: 4, cpuTimeUs: 12_345 } }],
      containersUsageAdaptiveGroups: [
        {
          dimensions: { region: 'WEUR' },
          sum: {
            allocatedMemory: 2 ** 30 * 30,
            allocatedDisk: 1e9 * 40,
            cpuTimeSec: 0.42,
            txBytes: 1e9,
          },
        },
        { dimensions: { region: 'OC' }, sum: { txBytes: 2e9 } },
        { dimensions: { region: 'APAC' }, sum: { txBytes: 3e9 } },
      ],
    },
    Date.parse('2026-10-08T12:00:00Z'),
  ).quantities;
  assert.equal(result.worker_standard_cpu_ms, 12.345);
  assert.equal(result.cloudchamber_memory_usage, 30);
  assert.equal(result.cloudchamber_disk_usage, 40);
  assert.equal(result.cloudchamber_cpu_usage, 0.42);
  assert.equal(result.cloudchamber_egress_na_eu, 1);
  assert.equal(result.cloudchamber_egress_oceania, 2);
  assert.equal(result.cloudchamber_egress_other, 3);
});

test('analytics aggregation retains zero defaults, partial hours, and implicit Standard R2 storage', () => {
  const { quantities } = quantitiesFromAnalytics(
    {
      workersInvocationsAdaptive: [{}, { sum: { requests: 2 } }, { sum: { cpuTimeUs: 500 } }],
      workersInvocationsByOwnerAndScriptGroups: [{}, { uniq: { distinctDynamicWorkerCount: 3 } }],
      queueMessageOperationsAdaptiveGroups: [],
      d1StorageAdaptiveGroups: [
        { dimensions: { datetimeHour: '2026-10-08T03:00:00Z' }, max: { databaseSizeBytes: 720e9 } },
        { dimensions: { datetimeHour: '2026-10-08T02:00:00Z' } },
      ],
      r2StorageAdaptiveGroups: [
        { dimensions: { bucketName: 'implicit-standard' }, max: { payloadSize: 30e9 } },
      ],
    },
    Date.parse('2026-10-08T03:30:00Z'),
  );
  assert.equal(quantities.worker_standard_request, 2);
  assert.equal(quantities.worker_standard_cpu_ms, 0.5);
  assert.equal(quantities.dynamic_workers_daily, 3);
  assert.equal(quantities.queues_standard_operations, 0);
  assert.equal(quantities.d1_storage, 0.5);
  assert.equal(quantities.r2_storage, 1);
  assert.equal(quantities.r2_storage_infrequent_access, 0);
  assert.throws(
    () =>
      quantitiesFromAnalytics({ d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 1 } }] }, 0),
    /hourly timestamp/,
  );
});

test('Durable Objects charge HTTP/RPC/alarms and incoming WebSockets at 20:1 without charging hibernation', () => {
  const { quantities } = quantitiesFromAnalytics(
    {
      durableObjectsInvocationsAdaptiveGroups: [
        { dimensions: { type: 'fetch' }, sum: { requests: 10 } },
        { dimensions: { type: 'alarm' }, sum: { requests: 2 } },
        { dimensions: { type: 'hibernation' }, sum: { requests: 40 } },
      ],
      durableObjectsPeriodicGroups: [{ sum: { inboundWebsocketMsgCount: 100, duration: 128 } }],
    },
    Date.parse('2026-10-08T12:00:00Z'),
  );
  assert.equal(quantities.worker_durable_objects_requests, 17);
  assert.equal(quantities.worker_durable_objects_duration, 128);
});

test('GraphQL dates are exclusive at midnight and Dynamic Workers use the documented date filter', () => {
  const ordinary = analyticsQuery(
    'account',
    'containersUsageAdaptiveGroups',
    '2026-10-07',
    '2026-10-08T00:00:00Z',
  );
  assert.match(ordinary, /datetime_geq:"2026-10-07T00:00:00Z"/);
  assert.match(ordinary, /datetime_lt:"2026-10-08T00:00:00Z"/);
  const dynamic = analyticsQuery(
    'account',
    'workersInvocationsByOwnerAndScriptGroups',
    '2026-10-07',
    '2026-10-08T00:00:00Z',
  );
  assert.match(dynamic, /date_geq:"2026-10-07",date_leq:"2026-10-07"/);
  assert.match(
    analyticsQuery('account', 'workersInvocationsAdaptive', '2026-10-07', '2026-10-08T00:00:00Z'),
    /status_neq:"internalError"/,
  );
});

test('R2 storage uses each bucket daily peak, without multiplying by the number of polls or hours', () => {
  const { quantities } = quantitiesFromAnalytics(
    {
      r2StorageAdaptiveGroups: [
        {
          dimensions: {
            bucketName: 'one',
            datetimeHour: '2026-10-08T00:00:00Z',
            storageClass: 'Standard',
          },
          max: { payloadSize: 10e9, metadataSize: 0 },
        },
        {
          dimensions: {
            bucketName: 'one',
            datetimeHour: '2026-10-08T01:00:00Z',
            storageClass: 'Standard',
          },
          max: { payloadSize: 29e9, metadataSize: 1e9 },
        },
        {
          dimensions: {
            bucketName: 'two',
            datetimeHour: '2026-10-08T00:00:00Z',
            storageClass: 'Standard',
          },
          max: { payloadSize: 60e9 },
        },
        {
          dimensions: {
            bucketName: 'one',
            datetimeHour: '2026-10-08T00:00:00Z',
            storageClass: 'InfrequentAccess',
          },
          max: { payloadSize: 120e9 },
        },
      ],
    },
    Date.parse('2026-10-08T01:30:00Z'),
  );
  assert.equal(quantities.r2_storage, 3);
  assert.equal(quantities.r2_storage_infrequent_access, 4);
});

test('R2 operation classes include lifecycle transitions and usage summaries, and exclude free deletions', () => {
  const op = (actionType: string, requests: number) => ({
    dimensions: { actionType, actionStatus: 'success', storageClass: 'Standard' },
    sum: { requests },
  });
  const { quantities, warnings } = quantitiesFromAnalytics(
    {
      r2OperationsAdaptiveGroups: [
        op('LifecycleStorageTierTransition', 3),
        op('UsageSummary', 4),
        op('DeleteObject', 9),
        op('UnknownFutureOperation', 1),
      ],
    },
    Date.parse('2026-10-08T12:00:00Z'),
  );
  assert.equal(quantities.r2_class_a_operations, 3);
  assert.equal(quantities.r2_class_b_operations, 4);
  assert.match(warnings.join(' '), /UnknownFutureOperation/);
});

test('R2 user-error reads are metered, matching the verified official daily bill', () => {
  const { quantities } = quantitiesFromAnalytics(
    {
      r2OperationsAdaptiveGroups: [
        {
          dimensions: {
            actionType: 'HeadObject',
            actionStatus: 'userError',
            storageClass: 'Standard',
          },
          sum: { requests: 4 },
        },
        {
          dimensions: {
            actionType: 'GetObject',
            actionStatus: 'userError',
            storageClass: 'Standard',
          },
          sum: { requests: 13 },
        },
        {
          dimensions: {
            actionType: 'GetObject',
            actionStatus: 'internalError',
            storageClass: 'Standard',
          },
          sum: { requests: 2 },
        },
      ],
    },
    Date.parse('2026-09-26T00:00:00Z'),
  );
  assert.equal(quantities.r2_class_b_operations, 17);
});

test('the versioned code catalogue keeps exact prices, billing units, and free-plan allowances', () => {
  const resolved = (key: string) => meterDefinition(key)!.pricing;
  assert.equal(PRICE_CATALOG_VERSION, '2026-10-08');
  assert.equal(resolved('worker_standard_request').unitPrice, 0.3);
  assert.equal(resolved('worker_standard_request').unitSize, 1_000_000);
  assert.equal(resolved('cloudchamber_memory_usage').unitPrice, 0.0000025);
  assert.equal(resolved('cloudchamber_cpu_usage').unitPrice, 0.00002);
  assert.equal(resolved('cloudchamber_disk_usage').unitPrice, 0.00000007);
  assert.equal(resolved('worker_durable_objects_duration').unitPrice, 12.5);
  assert.equal(resolved('d1_rows_written').unitPrice, 1);
  assert.equal(resolved('r2_class_a_operations').unitSize, 1e6);
  assert.equal(resolved('r2_class_a_operations').unitPrice, 4.5);
  assert.equal(resolved('r2_storage').includedQuantity, 10);
  assert.equal(meterDefinition('d1_rows_read', false)?.pricing.allowancePeriod, 'day');
  assert.equal(priceForServiceName('unknown future service'), null);
});

function providerFixture(
  options: {
    unknown?: boolean;
    graphFailure?: string;
    billingFailure?: boolean;
    metadataFailure?: boolean;
    workersPaid?: boolean;
    rows?: BillableRow[];
    period?: BillingCycle;
    requests?: string[];
    now?: Date;
  } = {},
) {
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    options.requests?.push(url);
    const period = options.period ?? cycle;
    if (url.includes('/billable-usage/info')) {
      if (options.metadataFailure) throw new TypeError('fetch failed');
      return Response.json({
        success: true,
        result: {
          covered: true,
          subscriptions: [
            {
              id: 'fixture',
              start_timestamp: `${period.start}T00:00:00Z`,
              billing_cycle_anchor_timestamp: `${period.end}T00:00:00Z`,
            },
          ],
        },
      });
    }
    if (url.includes('/subscriptions?')) {
      if (options.metadataFailure) throw new TypeError('fetch failed');
      const paid = options.workersPaid ?? true;
      return Response.json({
        success: true,
        result: [
          {
            id: 'fixture',
            state: paid ? 'Paid' : 'Free',
            price: paid ? (period.baseFee ?? 5) : 0,
            currency: period.currency,
            current_period_start: `${period.start}T00:00:00Z`,
            current_period_end: `${period.end}T00:00:00Z`,
            rate_plan: { id: paid ? 'workers_paid' : 'workers_free', scope: 'account' },
          },
        ],
      });
    }
    if (url.endsWith('/graphql')) {
      const query = JSON.parse(String(init?.body)).query as string;
      const dataset = Object.keys(datasets).find((name) => query.includes(`${name}(`))!;
      if (dataset === options.graphFailure)
        return Response.json({ errors: [{ message: 'dataset unavailable' }] });
      return Response.json({ data: { viewer: { accounts: [{ [dataset]: [] }] } } });
    }
    if (url.includes('/telemetry/query'))
      return Response.json({
        success: true,
        result: {
          run: { status: 'COMPLETED' },
          calculations: [{ calculation: 'count', aggregates: [{ value: 0 }] }],
        },
      });
    if (url.includes('/billable-usage?')) {
      if (options.billingFailure) return Response.json({}, { status: 503 });
      return Response.json({
        success: true,
        result: options.rows ?? [
          bill(
            '2026-10-07',
            0,
            options.unknown ? { ServiceName: 'Unsupported new billed service' } : {},
          ),
        ],
      });
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  return createCloudflareProvider({
    accountId: '1'.repeat(32),
    token: 'fixture-token',
    now: () => options.now ?? new Date('2026-10-08T12:00:00Z'),
    fetch: fetcher as typeof fetch,
  });
}

test('partial GraphQL errors and unknown billed products cannot become complete usage reports', async () => {
  const denied = await providerFixture({ graphFailure: 'containersUsageAdaptiveGroups' }).getUsage(
    cycle,
    '2026-10-08',
  );
  assert.equal(denied.complete, false);
  assert.match(denied.warnings!.join(' '), /containersUsageAdaptiveGroups/);
  const unknown = await providerFixture({ unknown: true }).getUsage(cycle, '2026-10-08');
  assert.equal(unknown.complete, false);
  assert.match(unknown.warnings!.join(' '), /Unsupported new billed service/);
  const billingUnavailable = await providerFixture({ billingFailure: true }).getUsage(
    cycle,
    '2026-10-08',
  );
  assert.equal(billingUnavailable.complete, false);
  assert.match(billingUnavailable.warnings!.join(' '), /服务核对/);
});

test('normal cycle and usage collection use the static catalogue without any price-document or rate-plan requests', async () => {
  const requests: string[] = [];
  const provider = providerFixture({ requests });
  const period = await provider.getBillingCycle(new Date('2026-10-08T12:00:00Z'));
  assert.equal(requests.length, 2, 'cycle discovery only needs billing info and subscriptions');
  assert.equal(period.baseFee, 5);
  assert.equal(period.workersPaid, true);
  const usage = await provider.getUsage(period, '2026-10-08');
  assert.equal(usage.complete, true);
  assert.deepEqual(usage.warnings, []);
  for (const meter of usage.meters)
    assert.deepEqual(meter.pricing, meterDefinition(meter.key, true)!.pricing);
  const raw = usage.raw as Record<string, unknown>;
  assert.equal(raw.priceCatalogVersion, PRICE_CATALOG_VERSION);
  assert.equal(raw.pricingSource, 'server/src/constants/pricing.ts');
  assert.ok(raw.analytics);
  assert.equal('pricingFetchedAt' in raw, false);
  assert.equal('publicPricing' in raw, false);
  assert.equal('pricePlans' in raw, false);
  assert.equal(
    requests.some((url) =>
      /developers\.cloudflare\.com|\.md(?:$|\?)|\/billing\/rate_plans/.test(url),
    ),
    false,
  );
});

test('a fresh provider can collect against a cached free cycle when metadata refresh fails, without a pricing-fetch prerequisite', async () => {
  const period: BillingCycle = {
    id: '2026-10-08:2026-11-08',
    start: '2026-10-08',
    end: '2026-11-08',
    currency: 'USD',
    baseFee: 0,
    workersPaid: false,
  };
  const requests: string[] = [];
  const now = new Date('2026-10-08T12:00:00Z');
  const store = new Store(':memory:');
  try {
    const confirmed = await providerFixture({
      period,
      workersPaid: false,
      rows: [],
      now,
    }).getBillingCycle(now);
    assert.equal(confirmed.workersPaid, false);
    assert.equal(confirmed.baseFee, 0);
    store.saveCycle(confirmed);
    const provider = providerFixture({ metadataFailure: true, requests, period, rows: [], now });
    await new Collector(store, provider, () => now).tick();
    assert.deepEqual(store.errors(), []);
    const saved = store.usage(period.id).get('2026-10-08')!.report;
    assert.equal(saved.complete, true);
    const requestsMeter = saved.meters.find((meter) => meter.key === 'worker_standard_request')!;
    assert.equal(requestsMeter.pricing.unitPrice, 0);
    assert.equal(requestsMeter.pricing.includedQuantity, 100_000);
    assert.equal(requestsMeter.pricing.allowancePeriod, 'day');
    assert.equal((saved.raw as Record<string, unknown>).priceCatalogVersion, PRICE_CATALOG_VERSION);
    assert.equal(
      requests.some((url) => /developers\.cloudflare\.com|\/billing\/rate_plans/.test(url)),
      false,
    );
  } finally {
    store.close();
  }
});

test('legacy cached cycles with unknown Workers plan cannot silently become complete, while official billing remains available', async () => {
  const legacy: BillingCycle = { ...cycle, workersPaid: undefined };
  const provider = providerFixture({ metadataFailure: true });
  await assert.rejects(provider.getBillingCycle(new Date('2026-10-08T12:00:00Z')), /fetch failed/);
  await assert.rejects(provider.getUsage(legacy, '2026-10-08'), /尚未确认 Workers 套餐/);
  const official = await provider.getOfficialBill(legacy, '2026-10-07');
  assert.equal(official?.amount, 5);
});

test('one product arriving cannot finalize a different product with missing billable usage', async () => {
  const rows = [
    bill('2026-09-16', 0.3),
    bill('2026-09-17', 0, {
      ServiceName: 'R2 Storage Class B Operations (First 10M included)',
      ServiceFamilyName: 'R2',
    }),
  ];
  const report = (date: string, quantity: number) => ({
    date,
    observedAt: '2026-09-18T01:00:00Z',
    complete: true,
    meters: [{ ...meterDefinition('worker_standard_request')!, quantity }],
  });
  const provider = providerFixture({ rows });
  assert.equal(
    await provider.getOfficialBill(cycle, '2026-09-17', [
      report('2026-09-16', 11e6),
      report('2026-09-17', 1e6),
    ]),
    null,
  );
  // Sparse zero-charge product days need no invented official row.
  assert.equal(
    (
      await provider.getOfficialBill(cycle, '2026-09-17', [
        report('2026-09-16', 2e6),
        report('2026-09-17', 1e6),
      ])
    )?.amount,
    5.3,
  );
});

test('official readiness groups metric aliases without hiding a lagging product when local history is incomplete', async () => {
  const rows = [
    bill('2026-09-16', 1),
    bill('2026-09-17', 2, { ServiceName: 'Workers Standard Pricing Requests' }),
    bill('2026-09-16', 0, {
      ServiceName: 'R2 Storage Class B Operations',
      ServiceFamilyName: 'R2',
    }),
  ];
  assert.equal(await providerFixture({ rows }).getOfficialBill(cycle, '2026-09-17'), null);
  const completeRows = [
    ...rows,
    bill('2026-09-17', 4, {
      ServiceName: 'R2 Storage Class B Operations (First 10M included)',
      ServiceFamilyName: 'R2',
    }),
  ];
  const official = await providerFixture({ rows: completeRows }).getOfficialBill(
    cycle,
    '2026-09-17',
  );
  assert.equal(official?.amount, 12);
  assert.equal(official?.serviceCosts?.worker_standard_request, 3);
  assert.equal(official?.serviceCosts?.r2_class_b_operations, 4);
  assert.deepEqual((official?.raw as { records: BillableRow[] }).records, completeRows);
});
