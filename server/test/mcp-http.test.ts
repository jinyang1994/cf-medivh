import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { createApp } from '@/app';
import { readMcpConfig, type McpConfig } from '@/config';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';

const token = 'mcp-test-token-0123456789-abcdefghijklmnopqrstuvwxyz';
const config: McpConfig = { token, allowedOrigins: [] };
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
};

async function fixture(
  t: TestContext,
  options: { config?: McpConfig; webRoot?: string } = { config },
) {
  const store = new Store(':memory:');
  const before = store.db.prepare('SELECT total_changes() AS count').get();
  let providerCalls = 0;
  const unexpectedCollection = async (): Promise<never> => {
    providerCalls++;
    throw new Error('MCP must never collect upstream data');
  };
  const collector = new Collector(store, {
    getBillingCycle: unexpectedCollection,
    getUsage: unexpectedCollection,
    getOfficialBill: unexpectedCollection,
  });
  const app = createApp(store, collector, options.webRoot, undefined, options.config);
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
    assert.equal(providerCalls, 0, 'MCP cannot call the Cloudflare provider');
    assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), before);
    store.close();
  });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    server,
    request: (path: string, init?: RequestInit) => fetch(url + path, init),
    rpc: (body: unknown, extraHeaders?: Record<string, string>) =>
      fetch(url + '/mcp', {
        method: 'POST',
        headers: { ...headers, ...extraHeaders },
        body: JSON.stringify(body),
      }),
  };
}

function assertPrivate(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('mcp-session-id'), null);
}

test('MCP config is opt-in and rejects weak tokens or non-origin allowlist entries', () => {
  assert.equal(readMcpConfig({}), undefined);
  assert.equal(readMcpConfig({ MCP_TOKEN: '' }), undefined);
  assert.deepEqual(readMcpConfig({ MCP_TOKEN: token }), config);
  assert.deepEqual(
    readMcpConfig({
      MCP_TOKEN: token,
      MCP_ALLOWED_ORIGINS: 'https://agent.example, http://localhost:3000,https://agent.example',
    }),
    { token, allowedOrigins: ['https://agent.example', 'http://localhost:3000'] },
  );
  for (const invalid of ['short', 'x'.repeat(31), ' '.repeat(32), token + '\n', '测试'.repeat(32)])
    assert.throws(() => readMcpConfig({ MCP_TOKEN: invalid }), /MCP_TOKEN/);
  for (const origin of [
    '*',
    'null',
    'file://example',
    'https://agent.example/',
    'https://agent.example/path',
    'https://agent.example?query=1',
    'https://agent.example#fragment',
    'https://user:password@agent.example',
    'https://*.example',
    'https://agent.example,',
  ])
    assert.throws(
      () => readMcpConfig({ MCP_TOKEN: token, MCP_ALLOWED_ORIGINS: origin }),
      /MCP_ALLOWED_ORIGINS/,
      origin,
    );
});

test('disabled MCP endpoints return 404 without falling through to the SPA', async (t) => {
  const webRoot = await mkdtemp(join(tmpdir(), 'cf-medivh-mcp-'));
  t.after(() => rm(webRoot, { recursive: true, force: true }));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>SPA fallback</title>');
  const { request } = await fixture(t, { webRoot });
  for (const path of ['/mcp', '/mcp/', '/mcp/unknown']) {
    for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
      const response = await request(path, { method, headers: { Accept: 'text/html' } });
      assert.equal(response.status, 404);
      assertPrivate(response);
      assert.deepEqual(await response.json(), { error: 'Not found' });
    }
  }
  assert.equal((await request('/api/health')).status, 200);
});

test('all MCP methods authenticate first and never accept a token from a URL', async (t) => {
  const { request } = await fixture(t);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const response = await request('/mcp', { method, headers: { Origin: 'https://evil.example' } });
    assert.equal(response.status, 401, method);
    assertPrivate(response);
    assert.match(response.headers.get('www-authenticate') ?? '', /^Bearer /);
    if (method !== 'HEAD') assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  }
  for (const authorization of [
    `Bearer ${'a'.repeat(32)}`,
    `Basic ${token}`,
    `Bearer ${token} extra`,
  ]) {
    const response = await request('/mcp', {
      method: 'POST',
      headers: { Authorization: authorization },
    });
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes(token), false);
  }
  assert.equal((await request('/mcp?token=' + token, { method: 'POST' })).status, 401);
});

test('duplicate authorization headers are rejected even when the first token is valid', async (t) => {
  const { url } = await fixture(t);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      url + '/mcp',
      {
        method: 'POST',
        headers: [
          'Host',
          new URL(url).host,
          'Authorization',
          `Bearer ${token}`,
          'Authorization',
          'Bearer other',
        ],
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode!));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 401);
});

test('Origin is rejected by default and explicit origins match exactly', async (t) => {
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const defaults = await fixture(t);
  for (const origin of ['https://agent.example', 'null', ''])
    assert.equal((await defaults.rpc(ping, { Origin: origin })).status, 403);
  const { rpc } = await fixture(t, {
    config: { token, allowedOrigins: ['https://agent.example'] },
  });
  for (const origin of [
    'https://agent.example.evil',
    'http://agent.example',
    'https://agent.example/',
    'null',
  ])
    assert.equal((await rpc(ping, { Origin: origin })).status, 403, origin);
  const allowed = await rpc(ping, { Origin: 'https://agent.example' });
  assert.equal(allowed.status, 200);
  assertPrivate(allowed);
  assert.deepEqual((await allowed.json()).result, {});
  assert.equal((await rpc(ping)).status, 200);
});

test('authenticated MCP only allows POST and does not allocate sessions', async (t) => {
  const { request } = await fixture(t);
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD']) {
    const response = await request('/mcp', { method, headers });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'POST');
    assertPrivate(response);
  }
  assert.equal((await request('/mcp/', { headers })).status, 404);
});

test('legacy MCP initialize, notification, list and ping use stateless JSON responses', async (t) => {
  const { rpc } = await fixture(t);
  for (const version of ['2025-03-26', '2025-11-25']) {
    const response = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'legacy-test', version: '1.0.0' },
      },
    });
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    const body = await response.json();
    assert.equal(body.result.protocolVersion, version);
    assert.equal(body.result.serverInfo.name, 'cf-medivh');
  }
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(tools.status, 200);
  const toolList = (await tools.json()).result.tools;
  assert.equal(toolList.length, 8);
  assert.equal(
    toolList.every(
      (tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint,
    ),
    true,
  );
  const ping = await rpc({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(await ping.json(), { jsonrpc: '2.0', id: 3, result: {} });
});

test('official MCP clients connect, list and query in both legacy and modern protocol modes', async (t) => {
  const { url } = await fixture(t);
  const instances: McpServer[] = [];
  const connect = McpServer.prototype.connect;
  t.mock.method(
    McpServer.prototype,
    'connect',
    function (this: McpServer, ...args: Parameters<typeof connect>) {
      instances.push(this);
      return connect.apply(this, args);
    },
  );
  for (const mode of ['legacy', 'auto'] as const) {
    const client = new Client(
      { name: 'billing-http-test', version: '1.0.0' },
      {
        versionNegotiation: { mode },
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 8);
      const result = await client.callTool({ name: 'get_billing_summary', arguments: {} });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent?.cycle, null);
      assert.equal(result.structuredContent?.timezone, 'UTC');
    } finally {
      await client.close();
    }
  }
  assert.ok(instances.length >= 6, 'each exchange creates an independent protocol instance');
  assert.equal(
    instances.every((instance) => instance.server.transport === undefined),
    true,
    'all completed requests release their protocol transport',
  );
});

test('a disconnected client with an incomplete request does not block subsequent MCP queries', async (t) => {
  const { url, server, rpc } = await fixture(t);
  const received = once(server, 'request');
  const request = httpRequest(url + '/mcp', {
    method: 'POST',
    headers: { ...headers, 'Content-Length': '512' },
  });
  request.on('error', () => {});
  const closed = new Promise<void>((resolve) => request.once('close', resolve));
  request.write('{"jsonrpc":"2.0"');
  await received;
  request.destroy();
  await closed;
  const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(response.status, 200);
  assertPrivate(response);
});

test('concurrent requests can reuse IDs without sharing transport state or changing stored data', async (t) => {
  const { rpc } = await fixture(t);
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: index % 2 ? 'get_billing_summary' : 'list_billing_services',
          arguments: {},
        },
      }),
    ),
  );
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 200);
    assertPrivate(response);
    const body = await response.json();
    assert.equal(body.id, 1);
    assert.equal(body.error, undefined);
    assert.equal(body.result.isError, undefined);
    if (index % 2) assert.equal(body.result.structuredContent.timezone, 'UTC');
    else assert.deepEqual(body.result.structuredContent.services, []);
  }
});

test('invalid JSON-RPC, unsupported methods and oversized requests fail without exposing secrets', async (t) => {
  const { request, rpc } = await fixture(t);
  const malformed = await request('/mcp', { method: 'POST', headers, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  const unknown = await rpc({ jsonrpc: '2.0', id: 1, method: 'collect' });
  assert.equal((await unknown.json()).error.code, -32601);
  const invalid = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
  assert.equal((await invalid.json()).error.code, -32602);
  const tooLarge = await request('/mcp', { method: 'POST', headers, body: ' '.repeat(65537) });
  assert.equal(tooLarge.status, 413);
  assertPrivate(tooLarge);
  const wrongContentType = await request('/mcp', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(wrongContentType.status, 415);
  for (const response of [tooLarge, wrongContentType]) {
    const body = await response.text();
    assert.equal(body.includes(token), false);
    assert.equal(body.includes('CLOUDFLARE_API_TOKEN'), false);
  }
  const valid = await rpc({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.equal(valid.status, 200, 'invalid requests must not poison subsequent requests');
});
