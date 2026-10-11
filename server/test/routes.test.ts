import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '@/app';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';
import type { ResourceUsageTrend } from '@/types';

async function fixture(t: TestContext, webRoot?: string, clock?: () => Date) {
  const store = new Store(':memory:');
  let providerCalls = 0;
  const unexpectedCollection = async (): Promise<never> => {
    providerCalls += 1;
    throw new Error('An HTTP request must not trigger provider collection');
  };
  const provider: ConstructorParameters<typeof Collector>[1] = {
    getBillingCycle: unexpectedCollection,
    getUsage: unexpectedCollection,
    getOfficialBill: unexpectedCollection,
  };
  const collector = new Collector(store, provider, clock);
  const app = createApp(store, collector, webRoot);
  app.silent = true;
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
    collector.stop();
    store.close();
    assert.equal(providerCalls, 0, 'HTTP endpoints must use stored data without collecting');
  });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  return {
    app,
    store,
    collector,
    request: (path: string, init?: RequestInit) => fetch(url + path, init),
  };
}

const indexHtml = '<!doctype html><title>Billing test</title><div id="root">SPA</div>';

async function staticRoot(t: TestContext, withIndex = true) {
  const root = await mkdtemp(join(tmpdir(), 'cf-medivh-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (withIndex) await writeFile(join(root, 'index.html'), indexHtml);
  return root;
}

function assertHeaders(response: Response, api: boolean) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  if (api) assert.equal(response.headers.get('cache-control'), 'no-store');
  else assert.notEqual(response.headers.get('cache-control'), 'no-store');
}

test('health remains available for all HTTP methods and reports in-process collection state', async (t) => {
  const { collector, request } = await fixture(t);
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
    collector.running = method !== 'GET';
    const response = await request('/api/health?probe=1', { method });
    assert.equal(response.status, 200, method);
    assertHeaders(response, true);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    if (method === 'HEAD') assert.equal(await response.text(), '');
    else assert.deepEqual(await response.json(), { ok: true, collecting: method !== 'GET' });
  }
});

test('GET dashboard reads the local snapshot without starting collection', async (t) => {
  const { store, collector, request } = await fixture(t);
  store.set('lastAttempt', '2026-10-08T12:00:00.000Z');
  collector.nextRun = '2026-10-08T12:10:00.000Z';
  const response = await request('/api/dashboard?view=current', {
    headers: { Accept: 'text/html' },
  });
  assert.equal(response.status, 200);
  assertHeaders(response, true);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  const body = await response.json();
  assert.equal(body.cycle, null);
  assert.equal(body.totals.current, null);
  assert.deepEqual(body.services, []);
  assert.deepEqual(body.history, []);
  assert.deepEqual(body.timeline, []);
  assert.equal(body.collection.running, false);
  assert.equal(body.collection.lastAttempt, '2026-10-08T12:00:00.000Z');
  assert.equal(body.collection.nextRun, '2026-10-08T12:10:00.000Z');
});

test('GET service trend is read-only and validates service and optional meter selection', async (t) => {
  const { store, request } = await fixture(t);
  assert.equal((await request('/api/service-trend?service=Containers')).status, 404);
  const cycle = {
    id: 'trend-route',
    start: '2026-10-01',
    end: '2026-10-04',
    currency: 'USD',
    baseFee: 5,
  };
  store.saveCycle(cycle);
  store.saveUsage(
    cycle,
    {
      date: '2026-10-01',
      observedAt: '2026-10-01T00:01:00Z',
      complete: true,
      meters: [
        {
          key: 'memory',
          service: 'Containers',
          name: '内存',
          unit: 'GiB-seconds',
          quantity: 12,
          pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 10 },
        },
      ],
    },
    true,
  );
  const before = store.db.prepare('SELECT total_changes() AS count').get();
  for (const suffix of ['', '&meter=memory']) {
    const response = await request('/api/service-trend?service=Containers' + suffix);
    assert.equal(response.status, 200);
    assertHeaders(response, true);
    const body = await response.json();
    assert.equal(body.service, 'Containers');
    assert.equal(body.meterKey, suffix ? 'memory' : null);
    assert.equal(body.history[0].localCost, 2);
    assert.equal(body.history[0].quantity, suffix ? 12 : null);
  }
  for (const query of [
    '',
    '?meter=memory',
    '?service=',
    '?service=Containers&meter=',
    '?service=Containers&service=Workers',
    '?service=Containers&meter=memory&meter=memory',
    '?service=Containers&unknown=1',
    '?service=%20',
  ])
    assert.equal((await request('/api/service-trend' + query)).status, 400, query);
  for (const query of [
    '?service=Missing',
    '?service=Workers&meter=memory',
    '?service=Containers&meter=missing',
  ])
    assert.equal((await request('/api/service-trend' + query)).status, 404, query);
  assert.equal(
    (await request('/api/service-trend?service=Containers', { method: 'POST' })).status,
    404,
  );
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), before);
});

test('resource trends read SQLite only and validate selections without upstream calls or writes', async (t) => {
  const { store, collector, request } = await fixture(
    t,
    undefined,
    () => new Date('2026-10-01T12:00:00Z'),
  );
  const cycle = { id: 'resources', start: '2026-10-01', end: '2026-10-04', currency: 'USD' };
  store.saveCycle(cycle);
  store.saveUsage(
    cycle,
    {
      date: cycle.start,
      observedAt: '2026-10-01T12:00:00Z',
      complete: true,
      meters: [
        {
          key: 'duration',
          service: 'Durable Objects',
          name: '计算时长',
          unit: 'GB-seconds',
          quantity: 24,
          pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 0 },
        },
      ],
    },
    true,
  );
  const path = '/api/resource-trend?service=Durable+Objects&meter=duration';
  assert.equal((await request(path)).status, 200);
  assert.match((await (await request(path)).json()).unavailableReason, /后台采集/);
  let calls = 0;
  const result: ResourceUsageTrend = {
    service: 'Durable Objects',
    meterKey: 'duration',
    unit: 'GB-seconds',
    resolution: 'ten-minute',
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-01T12:00:00Z',
    fetchedAt: '2026-10-01T12:00:00Z',
    resources: [{ id: 'namespace-1', name: 'worker · Room', total: 12 }],
    points: [{ timestamp: '2026-10-01T11:50:00Z', quantities: { 'namespace-1': 12 } }],
    warnings: [],
    unavailableReason: null,
  };
  collector.provider.getResourceTrend = async () => {
    calls++;
    throw new Error('HTTP must not reach Cloudflare');
  };
  store.resourceUsage.save(cycle, 'ten-minute', result);
  store.resourceUsage.save(cycle, 'daily', {
    ...result,
    resolution: 'daily',
    points: [{ timestamp: '2026-10-01T00:00:00Z', quantities: { 'namespace-1': 12 } }],
  });
  const before = store.db.prepare('SELECT total_changes() AS count').get();
  for (let i = 0; i < 2; i++) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assertHeaders(response, true);
    const actual = await response.json();
    assert.equal(actual.resources[0].name, 'worker · Room');
    assert.equal(actual.resources[0].total, 12);
    assert.equal(actual.points.at(-1).quantities['namespace-1'], 12);
  }
  assert.equal(calls, 0);
  const daily = await (await request(path + '&resolution=daily')).json();
  assert.equal(daily.resources[0].total, 12);
  assert.equal(daily.total, 24);
  assert.equal(daily.points[0].total, 24);
  assert.equal(calls, 0);
  for (const query of [
    '',
    '?service=Durable+Objects',
    '?meter=duration',
    '?service=Durable+Objects&meter=',
    '?service=Durable+Objects&meter=duration&resolution=year',
    '?service=Durable+Objects&meter=duration&meter=duration',
    '?service=Durable+Objects&service=Workers&meter=duration',
    '?service=Durable+Objects&meter=duration&resolution=daily&resolution=daily',
    '?service=Durable+Objects&meter=duration&token=private',
  ])
    assert.equal((await request('/api/resource-trend' + query)).status, 400, query);
  assert.equal((await request('/api/resource-trend?service=Workers&meter=duration')).status, 404);
  assert.equal((await request(path, { method: 'POST' })).status, 404);
  assert.equal(calls, 0);
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), before);
});

test('resource cost trends allocate stored usage and never call the provider or write the database', async (t) => {
  const { store, collector, request } = await fixture(
    t,
    undefined,
    () => new Date('2026-10-01T12:00:00Z'),
  );
  const cycle = { id: 'cost-resources', start: '2026-10-01', end: '2026-10-04', currency: 'USD' };
  store.saveCycle(cycle);
  store.saveUsage(
    cycle,
    {
      date: cycle.start,
      observedAt: '2026-10-01T12:00:00Z',
      complete: true,
      meters: [
        {
          key: 'memory',
          service: 'Containers',
          name: '内存',
          unit: 'GiB-seconds',
          quantity: 100,
          pricing: { currency: 'USD', unitPrice: 1, unitSize: 1, includedQuantity: 20 },
        },
      ],
    },
    false,
  );
  store.resourceUsage.save(cycle, 'daily', {
    service: 'Containers',
    meterKey: 'memory',
    unit: 'GiB-seconds',
    resolution: 'daily',
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-01T12:00:00Z',
    fetchedAt: '2026-10-01T12:00:00Z',
    resources: [
      { id: 'a', name: 'application A', total: 75 },
      { id: 'b', name: 'application B', total: 25 },
    ],
    points: [{ timestamp: '2026-10-01T00:00:00Z', quantities: { a: 75, b: 25 } }],
    warnings: [],
    unavailableReason: null,
  });
  let calls = 0;
  collector.provider.getResourceTrend = async () => {
    calls++;
    throw new Error('must remain offline');
  };
  const before = store.db.prepare('SELECT total_changes() AS count').get();
  for (const meterQuery of ['', '&meter=memory']) {
    const response = await request(
      '/api/resource-cost-trend?service=Containers&resolution=daily' + meterQuery,
    );
    assert.equal(response.status, 200);
    assertHeaders(response, true);
    const result = await response.json();
    assert.equal(result.currency, 'USD');
    assert.equal(result.points[0].total, 80);
    assert.equal(result.points[0].costs.a, 60);
    assert.equal(result.points[0].costs.b, 20);
    assert.equal(result.points[0].unattributedCost, 0);
  }
  for (const query of [
    '',
    '?service=',
    '?service=Containers&meter=',
    '?service=Containers&service=Containers',
    '?service=Containers&resolution=year',
    '?service=Containers&resolution=daily&resolution=daily',
    '?service=Containers&other=1',
  ]) {
    assert.equal((await request('/api/resource-cost-trend' + query)).status, 400, query);
  }
  assert.equal((await request('/api/resource-cost-trend?service=Missing')).status, 404);
  assert.equal(
    (await request('/api/resource-cost-trend?service=Containers&meter=Missing')).status,
    404,
  );
  assert.equal(
    (await request('/api/resource-cost-trend?service=Containers', { method: 'POST' })).status,
    404,
  );
  assert.equal(calls, 0);
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), before);
});

test('uncollected resource queries stay local even when an upstream method exists', async (t) => {
  const { store, collector, request } = await fixture(t);
  const cycle = {
    id: 'resources',
    start: '2026-10-01',
    end: '2026-10-04',
    currency: 'USD',
    baseFee: 5,
  };
  store.saveCycle(cycle);
  let calls = 0;
  collector.provider.getResourceTrend = async () => {
    calls++;
    throw new Error('private token and upstream details');
  };
  for (let i = 0; i < 2; i++) {
    const response = await request(
      '/api/resource-trend?service=' + encodeURIComponent('订阅') + '&meter=__base_fee',
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).unavailableReason, '固定订阅费用没有具体资源用量。');
  }
  assert.equal(calls, 0);
});

test('dashboard accepts only GET, and unmatched API paths preserve JSON 404 responses', async (t) => {
  const { request } = await fixture(t);
  const cases = [
    ['/api/dashboard', 'POST'],
    ['/api/dashboard', 'PUT'],
    ['/api/dashboard', 'DELETE'],
    ['/api/dashboard', 'OPTIONS'],
    ['/api/dashboard', 'HEAD'],
    ['/api/health/', 'GET'],
    ['/api/missing', 'GET'],
    ['/api/missing', 'POST'],
  ] as const;
  for (const [path, method] of cases) {
    const response = await request(path, { method });
    assert.equal(response.status, 404, `${method} ${path}`);
    assertHeaders(response, true);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    if (method === 'HEAD') assert.equal(await response.text(), '');
    else assert.deepEqual(await response.json(), { error: '未找到接口' });
  }
});

test('without a web root non-API paths remain Koa 404 responses', async (t) => {
  const { request } = await fixture(t);
  for (const path of ['/', '/billing/history', '/api']) {
    const response = await request(path, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404, path);
    assertHeaders(response, false);
    assert.equal(await response.text(), 'Not Found');
  }
});

test('static assets and HEAD requests are served before SPA fallback', async (t) => {
  const root = await staticRoot(t);
  const script = 'window.billingTest = true;';
  await writeFile(join(root, 'asset.js'), script);
  const { request } = await fixture(t, root);
  const asset = await request('/asset.js?version=1');
  assert.equal(asset.status, 200);
  assertHeaders(asset, false);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await asset.text(), script);

  const head = await request('/asset.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assertHeaders(head, false);
  assert.match(head.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await head.text(), '');

  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /^text\/html/);
  assert.equal(await index.text(), indexHtml);
});

test('API routes and API 404s take precedence over static files and SPA fallback', async (t) => {
  const root = await staticRoot(t);
  await mkdir(join(root, 'api'));
  await writeFile(join(root, 'api', 'health'), 'must not be served');
  await writeFile(join(root, 'api', 'unknown.txt'), 'must not be served');
  const { request } = await fixture(t, root);
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, collecting: false });

  for (const path of ['/api/unknown.txt', '/api/unknown-route']) {
    const response = await request(path, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404, path);
    assertHeaders(response, true);
    assert.deepEqual(await response.json(), { error: '未找到接口' });
  }
});

test('SPA fallback serves only GET requests accepting HTML, including the bare /api path', async (t) => {
  const root = await staticRoot(t);
  const { request } = await fixture(t, root);
  for (const path of ['/billing', '/billing/history', '/api']) {
    const response = await request(path, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 200, path);
    assertHeaders(response, false);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(await response.text(), indexHtml);
  }
  for (const [method, accept] of [
    ['GET', 'application/json'],
    ['POST', 'text/html'],
    ['HEAD', 'text/html'],
  ] as const) {
    const response = await request('/billing/history', { method, headers: { Accept: accept } });
    assert.equal(response.status, 404, `${method} ${accept}`);
    assertHeaders(response, false);
    assert.equal(await response.text(), method === 'HEAD' ? '' : 'Not Found');
  }
});

test('a missing SPA entry point remains a 404 without leaking filesystem errors', async (t) => {
  const root = await staticRoot(t, false);
  const { request } = await fixture(t, root);
  const response = await request('/billing', { headers: { Accept: 'text/html' } });
  assert.equal(response.status, 404);
  assertHeaders(response, false);
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await response.text(), 'Not Found');
});

test('downstream failures emit the Koa error event and return a sanitized JSON 500', async (t) => {
  const { app, store, request } = await fixture(t);
  const failure = new Error('private database details');
  const events: { error: unknown; path: string }[] = [];
  app.on('error', (error, context) => events.push({ error, path: context.path }));
  t.mock.method(store, 'activeCycle', () => {
    throw failure;
  });
  const response = await request('/api/dashboard');
  assert.equal(response.status, 500);
  assertHeaders(response, true);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.deepEqual(await response.json(), { error: '服务暂时不可用' });
  assert.deepEqual(events, [{ error: failure, path: '/api/dashboard' }]);
});
