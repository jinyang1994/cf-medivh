import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@/app';
import { readMcpConfig, type McpConfig } from '@/config';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';
import { generateMcpToken, mcpSettings, mcpTokenHash } from '@/services/mcp-settings';
import { saveRuntimeSettings } from '@/services/runtime-settings';

const envToken = 'mcp-environment-token-0123456789-abcdefghijklmnopqrstuvwxyz';
const settingsPath = '/api/settings/mcp';
const tokenPath = settingsPath + '/token';
const jsonHeaders = { 'Content-Type': 'application/json' };
const defaults = { feishu: undefined, budgetWebhook: undefined };
const settingsInput = {
  language: 'en',
  hideSocialIcons: true,
  feishu: { enabled: false },
  budget: { enabled: false, thresholdCents: 30000 },
};

async function fixture(t: TestContext, config?: McpConfig) {
  const store = new Store(':memory:');
  let providerCalls = 0;
  const unexpectedCollection = async (): Promise<never> => {
    providerCalls++;
    throw new Error('MCP settings cannot call the Cloudflare provider');
  };
  const collector = new Collector(store, {
    getBillingCycle: unexpectedCollection,
    getUsage: unexpectedCollection,
    getOfficialBill: unexpectedCollection,
  });
  const app = createApp(store, collector, undefined, undefined, config);
  app.silent = true;
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    collector.stop();
    store.close();
    assert.equal(providerCalls, 0);
  });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init?: RequestInit) => fetch(url + path, init);
  return {
    url,
    store,
    request,
    save: (mcp?: unknown, extra: Record<string, unknown> = {}, headers = {}) =>
      request('/api/settings', {
        method: 'PUT',
        headers: { ...jsonHeaders, ...headers },
        body: JSON.stringify({ ...settingsInput, ...extra, ...(mcp === undefined ? {} : { mcp }) }),
      }),
    mutate: (method = 'POST', body = '{}', extraHeaders?: Record<string, string>) =>
      request(tokenPath, { method, headers: { ...jsonHeaders, ...extraHeaders }, body }),
    rpc: (token: string, method = 'ping', extraHeaders?: Record<string, string>) =>
      request('/mcp', {
        method: 'POST',
        headers: {
          ...jsonHeaders,
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
          ...extraHeaders,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
      }),
  };
}

function state(store: Store) {
  return store.db.prepare('SELECT key,value FROM state ORDER BY key').all();
}

function assertPrivate(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
}

test('MCP origins can be configured without an environment token', () => {
  assert.deepEqual(readMcpConfig({ MCP_ALLOWED_ORIGINS: 'https://agent.example' }), {
    allowedOrigins: ['https://agent.example'],
  });
  assert.deepEqual(readMcpConfig({ MCP_TOKEN: '', MCP_ALLOWED_ORIGINS: 'https://agent.example' }), {
    allowedOrigins: ['https://agent.example'],
  });
  assert.throws(() => readMcpConfig({ MCP_ALLOWED_ORIGINS: '*' }), /MCP_ALLOWED_ORIGINS/);
});

test('draft generation never writes DB; unified save enables MCP and only stores its hash', async (t) => {
  const { store, request, mutate, save, rpc } = await fixture(t);
  const before = state(store);
  const initial = await request(settingsPath);
  assertPrivate(initial);
  const disabled = { enabled: false, maskedToken: '', updatedAt: null, endpoint: '/mcp' };
  assert.deepEqual(await initial.json(), disabled);
  const response = await mutate();
  assert.equal(response.status, 200);
  assertPrivate(response);
  const created = await response.json();
  assert.deepEqual(Object.keys(created), ['token']);
  assert.match(created.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(state(store), before, 'draft generation must not write any database state');
  assert.equal((await rpc(created.token)).status, 404);
  assert.deepEqual(await (await request(settingsPath)).json(), disabled);
  assert.deepEqual((await (await request('/api/settings')).json()).mcp, disabled);
  const savedResponse = await save({ action: 'rotate', token: created.token });
  assert.equal(savedResponse.status, 200);
  assertPrivate(savedResponse);
  const saved = await savedResponse.json();
  assert.equal(saved.mcp.enabled, true);
  assert.equal(saved.mcp.endpoint, '/mcp');
  assert.equal(
    saved.mcp.maskedToken,
    `${created.token.slice(0, 4)}••••••••${created.token.slice(-4)}`,
  );
  assert.equal(new Date(saved.mcp.updatedAt).toISOString(), saved.mcp.updatedAt);
  assert.deepEqual(await (await request(settingsPath)).json(), saved.mcp);
  assert.equal((await rpc(created.token)).status, 200);
  const stored = JSON.stringify(state(store));
  assert.equal(stored.includes(created.token), false, 'database must not contain plaintext token');
  assert.equal(stored.includes(createHash('sha256').update(created.token).digest('hex')), true);
  assert.equal(JSON.stringify(saved).includes(created.token), false);
  assert.equal(JSON.stringify(saved).includes('tokenHash'), false);
  const tools = (await (await rpc(created.token, 'tools/list')).json()).result.tools;
  assert.equal(tools.length, 8);
  assert.equal(
    tools.every(
      (tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint,
    ),
    true,
  );
  assert.equal(JSON.stringify(tools).includes(created.token), false);
});

test('old tokens stay active through discarded and repeated drafts until unified save', async (t) => {
  const { store, request, mutate, save, rpc } = await fixture(t, {
    token: envToken,
    allowedOrigins: [],
  });
  const inherited = {
    enabled: true,
    maskedToken: 'mcp-••••••••wxyz',
    updatedAt: null,
    endpoint: '/mcp',
  };
  assert.deepEqual(await (await request(settingsPath)).json(), inherited);
  assert.deepEqual((await (await request('/api/settings')).json()).mcp, inherited);
  const before = state(store);
  const discarded = await (await mutate()).json();
  const draft = await (await mutate()).json();
  assert.notEqual(discarded.token, draft.token);
  assert.deepEqual(state(store), before);
  assert.equal((await rpc(envToken)).status, 200);
  assert.equal((await rpc(discarded.token)).status, 401);
  assert.equal((await rpc(draft.token)).status, 401);
  assert.equal((await save({ action: 'rotate', token: draft.token })).status, 200);
  assert.equal((await rpc(envToken)).status, 401);
  assert.equal((await rpc(discarded.token)).status, 401);
  assert.equal((await rpc(draft.token)).status, 200);
  const active = store.get('runtimeMcpSettings');
  const nextDraft = await (await mutate()).json();
  assert.equal(store.get('runtimeMcpSettings'), active);
  assert.equal((await rpc(draft.token)).status, 200);
  assert.equal((await rpc(nextDraft.token)).status, 401);
  assert.equal((await save(undefined, { language: 'zh-CN' })).status, 200);
  assert.equal(store.get('runtimeMcpSettings'), active, 'omitting MCP preserves the saved token');
  assert.equal((await rpc(draft.token)).status, 200);
  assert.equal((await save({ action: 'rotate', token: nextDraft.token })).status, 200);
  assert.equal((await rpc(draft.token)).status, 401);
  assert.equal((await rpc(nextDraft.token)).status, 200);
});

test('unified save revokes MCP and regeneration only re-enables it after saving', async (t) => {
  const { store, mutate, save, rpc } = await fixture(t, { token: envToken, allowedOrigins: [] });
  assert.equal((await rpc(envToken)).status, 200);
  const before = state(store);
  assert.equal((await mutate('DELETE')).status, 405);
  assert.deepEqual(state(store), before, 'legacy DELETE cannot revoke a credential');
  assert.equal((await rpc(envToken)).status, 200);
  const revoked = await save({ action: 'revoke' });
  assertPrivate(revoked);
  assert.equal((await revoked.json()).mcp.enabled, false);
  assert.equal(mcpTokenHash(store, { token: envToken, allowedOrigins: [] }), null);
  assert.equal((await rpc(envToken)).status, 404);
  const disabled = state(store);
  const draft = await (await mutate()).json();
  assert.deepEqual(state(store), disabled);
  assert.equal((await rpc(draft.token)).status, 404);
  assert.equal((await save({ action: 'rotate', token: draft.token })).status, 200);
  assert.equal((await rpc(draft.token)).status, 200);
  assert.equal((await rpc(envToken)).status, 401);
});

test('saved credentials and revocations survive database reopen without env fallback', () => {
  const directory = mkdtempSync(join(tmpdir(), 'medivh-mcp-settings-'));
  const path = join(directory, 'billing.sqlite');
  const config = { token: envToken, allowedOrigins: [] };
  let store = new Store(path);
  try {
    const generated = generateMcpToken();
    const saved = saveRuntimeSettings(
      store,
      defaults,
      { ...settingsInput, mcp: { action: 'rotate', token: generated.token } },
      config,
    );
    store.close();
    store = new Store(path);
    assert.deepEqual(
      mcpTokenHash(store, config),
      createHash('sha256').update(generated.token).digest(),
    );
    assert.deepEqual(mcpSettings(store, config), saved.mcp);
    saveRuntimeSettings(store, defaults, { ...settingsInput, mcp: { action: 'revoke' } }, config);
    store.close();
    store = new Store(path);
    assert.equal(mcpTokenHash(store, config), null);
    assert.equal(mcpSettings(store, config).enabled, false);
    assert.equal(mcpSettings(store, config).maskedToken, '');
    const regenerated = generateMcpToken();
    saveRuntimeSettings(
      store,
      defaults,
      { ...settingsInput, mcp: { action: 'rotate', token: regenerated.token } },
      config,
    );
    store.close();
    store = new Store(path);
    assert.deepEqual(
      mcpTokenHash(store, config),
      createHash('sha256').update(regenerated.token).digest(),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid notification or MCP changes preserve every setting and the old credential', async (t) => {
  const { store, mutate, save, rpc } = await fixture(t, { token: envToken, allowedOrigins: [] });
  assert.equal((await save()).status, 200);
  const before = state(store);
  const draft = await (await mutate()).json();
  const rotation = { action: 'rotate', token: draft.token };
  for (const extra of [
    { language: 'fr' },
    { hideSocialIcons: 'true' },
    { feishu: { enabled: true, webhookUrl: 'http://invalid.test' } },
    { budget: { enabled: true, webhookUrl: 'ftp://invalid.test', thresholdCents: 1 } },
    { budget: { enabled: false, thresholdCents: -1 } },
  ]) {
    const response = await save(rotation, extra);
    assert.equal(response.status, 400);
    assertPrivate(response);
    assert.deepEqual(state(store), before);
  }
  for (const mcp of [
    null,
    [],
    {},
    { action: 'keep' },
    { action: 'rotate' },
    { action: 'rotate', token: 'short' },
    { action: 'rotate', token: 'g'.repeat(64) },
    { action: 'rotate', token: draft.token, extra: true },
    { action: 'revoke', token: draft.token },
  ]) {
    const response = await save(mcp, { language: 'zh-CN', hideSocialIcons: false });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_mcp' });
    assert.deepEqual(state(store), before);
  }
  assert.equal((await rpc(envToken)).status, 200);
  assert.equal((await rpc(draft.token)).status, 401);
});

test('a DB failure while saving MCP rolls back notification and basic settings too', async (t) => {
  const { store, save, rpc } = await fixture(t, { token: envToken, allowedOrigins: [] });
  assert.equal((await save()).status, 200);
  const before = state(store);
  const draft = generateMcpToken();
  store.db.exec(`CREATE TRIGGER fail_mcp_save BEFORE INSERT ON state
    WHEN NEW.key = 'runtimeMcpSettings' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  const response = await save(
    { action: 'rotate', token: draft.token },
    { language: 'zh-CN', hideSocialIcons: false },
  );
  assert.equal(response.status, 500);
  assertPrivate(response);
  assert.deepEqual(state(store), before);
  assert.equal((await rpc(envToken)).status, 200);
  assert.equal((await rpc(draft.token)).status, 401);
  assert.equal((await response.text()).includes(draft.token), false);
});

test('management rejects foreign origins and cross-site fetch metadata without changing state', async (t) => {
  const { store, request, mutate, save, url } = await fixture(t);
  await save();
  const before = state(store);
  for (const headers of [
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { Origin: '' },
    { Origin: url + '/' },
    { Origin: url.replace('://', '://user:password@') },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { Origin: url, 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    for (const method of ['POST', 'DELETE']) {
      const response = await mutate(method, '{}', headers);
      assert.equal(response.status, 403);
      assertPrivate(response);
    }
    const saved = await save({ action: 'revoke' }, {}, headers);
    assert.equal(saved.status, 403);
    assertPrivate(saved);
    const read = await request(settingsPath, { headers });
    assert.equal(read.status, 403);
    assertPrivate(read);
  }
  assert.deepEqual(state(store), before);
  const sameOrigin = await mutate('POST', '{}', { Origin: url, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(sameOrigin.status, 200);
});

test('management accepts the preserved dashboard Host used by the Vite proxy', async (t) => {
  const { url, store } = await fixture(t);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      url + tokenPath,
      {
        method: 'POST',
        headers: {
          ...jsonHeaders,
          Host: 'localhost:5173',
          Origin: 'http://localhost:5173',
          'Sec-Fetch-Site': 'same-origin',
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode!));
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(status, 200);
  assert.equal(mcpSettings(store).enabled, false);
});

test('invalid management requests cannot create, rotate or revoke credentials', async (t) => {
  const { store, request, mutate, url } = await fixture(t);
  await mutate();
  const before = state(store);
  for (const method of ['POST']) {
    for (const body of [
      '',
      '{',
      'null',
      '[]',
      '"token"',
      'true',
      '{"token":"replacement"}',
      '{"enabled":false}',
    ]) {
      const response = await mutate(method, body);
      assert.equal(response.status, 400);
      assertPrivate(response);
    }
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
      assert.equal((await mutate(method, '{}', { 'Content-Type': contentType })).status, 415);
    }
    assert.equal((await mutate(method, ' '.repeat(1025))).status, 413);
    assert.equal((await request(tokenPath, { method, body: '{}' })).status, 415);
  }
  for (const method of ['GET', 'PUT', 'PATCH', 'OPTIONS', 'DELETE']) {
    const response = await request(tokenPath, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  assert.equal(
    (await request(settingsPath, { method: 'POST', headers: jsonHeaders, body: '{}' })).status,
    405,
  );
  const chunkedStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      url + tokenPath,
      { method: 'POST', headers: jsonHeaders },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode!));
      },
    );
    request.on('error', reject);
    request.write('{"extra":"');
    request.end('测'.repeat(400) + '"}');
  });
  assert.equal(chunkedStatus, 413);
  assert.deepEqual(state(store), before);
});

test('MCP drafts preserve other settings and saved tokens enforce the origin allowlist', async (t) => {
  const { store, request, mutate, save, rpc, url } = await fixture(t, {
    allowedOrigins: ['https://agent.example'],
  });
  store.set('feishuNotificationLanguage', 'en');
  const previous = await (await request('/api/settings')).json();
  const generated = await (await mutate()).json();
  assert.deepEqual(await (await request('/api/settings')).json(), previous);
  await save({ action: 'rotate', token: generated.token });
  assert.equal(
    (await rpc(generated.token, 'ping', { Origin: 'https://agent.example' })).status,
    200,
  );
  assert.equal((await rpc(generated.token, 'ping', { Origin: url })).status, 403);
  assert.equal((await mutate('POST', '{}', { Origin: 'https://agent.example' })).status, 403);
  assert.equal(
    (await save({ action: 'revoke' }, {}, { Origin: 'https://agent.example' })).status,
    403,
  );
});

test('invalid stored settings fail closed and responses never disclose stored secrets', async (t) => {
  const { store, request, rpc } = await fixture(t, { token: envToken, allowedOrigins: [] });
  store.set('runtimeMcpSettings', JSON.stringify({ tokenHash: envToken, maskedToken: envToken }));
  for (const response of [
    await request(settingsPath),
    await request('/api/settings'),
    await rpc(envToken),
  ]) {
    assert.equal(response.status, 500);
    assertPrivate(response);
    const body = await response.text();
    assert.equal(body.includes(envToken), false);
    assert.equal(body.includes('tokenHash'), false);
  }
});
