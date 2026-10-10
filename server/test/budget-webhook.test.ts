import test from 'node:test';
import assert from 'node:assert/strict';
import { readBudgetWebhookConfig } from '@/config';
import { createBudgetWebhookSender } from '@/resources/budget-webhook';
import type { BudgetAlertNotification } from '@/types';

const webhookUrl = 'https://billing.example.test/hooks/budget?token=fixture-private-token';
const notification: BudgetAlertNotification = {
  kind: 'budget_exceeded',
  id: 'budget:6dde7bd4e0e91f0890b9978406cc0b7d06a20f62f7f80a3bbd85e080bb9b9dc5',
  cycle: {
    id: '2026-09-16:2026-10-16',
    start: '2026-09-16',
    end: '2026-10-16',
    currency: 'USD',
  },
  observedAt: '2026-10-08T12:10:07.000Z',
  metric: 'currentTotal',
  thresholdCents: 30000,
  amountUsd: 300.000001,
};

test('budget webhook is opt-in and independent of Feishu configuration', () => {
  assert.equal(readBudgetWebhookConfig({}), undefined);
  assert.equal(
    readBudgetWebhookConfig({ BUDGET_WEBHOOK_URL: ' ', BUDGET_THRESHOLD_CENTS: '\t' }),
    undefined,
  );
  assert.deepEqual(
    readBudgetWebhookConfig({
      BUDGET_WEBHOOK_URL: ` ${webhookUrl} `,
      BUDGET_THRESHOLD_CENTS: ' 30000 ',
    }),
    { webhookUrl, thresholdCents: 30000 },
  );
  for (const env of [
    { BUDGET_WEBHOOK_URL: webhookUrl },
    { BUDGET_THRESHOLD_CENTS: '30000' },
    { BUDGET_WEBHOOK_URL: webhookUrl, BUDGET_THRESHOLD_CENTS: ' ' },
    { BUDGET_WEBHOOK_URL: ' ', BUDGET_THRESHOLD_CENTS: '30000' },
  ]) {
    assert.throws(() => readBudgetWebhookConfig(env), /必须同时配置/);
  }
});

test('budget threshold accepts only positive safe integers expressed as decimal digits', () => {
  for (const value of ['1', '30000', '0030000', String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(
      readBudgetWebhookConfig({ BUDGET_WEBHOOK_URL: webhookUrl, BUDGET_THRESHOLD_CENTS: value })
        ?.thresholdCents,
      Number(value),
    );
  }
  for (const value of [
    '0',
    '000',
    '-1',
    '+30000',
    '300.00',
    '30000.0',
    '3e4',
    '0x7530',
    '30_000',
    '30,000',
    '30 000',
    'NaN',
    'Infinity',
    '３００００',
    String(Number.MAX_SAFE_INTEGER + 1),
    '9'.repeat(400),
  ]) {
    assert.throws(
      () =>
        readBudgetWebhookConfig({ BUDGET_WEBHOOK_URL: webhookUrl, BUDGET_THRESHOLD_CENTS: value }),
      /BUDGET_THRESHOLD_CENTS 必须是正的安全整数/,
    );
  }
});

test('budget webhook permits HTTP(S) endpoints and query tokens but rejects credentials and fragments', () => {
  for (const value of [
    webhookUrl,
    'http://localhost:9000/budget',
    'https://example.test/path%23part',
  ]) {
    assert.equal(
      readBudgetWebhookConfig({ BUDGET_WEBHOOK_URL: value, BUDGET_THRESHOLD_CENTS: '30000' })
        ?.webhookUrl,
      value,
    );
  }
  for (const value of [
    'fixture-private-token',
    'file:///fixture-private-token',
    'ftp://example.test/fixture-private-token',
    'https://fixture-private-token@example.test',
    'https://:fixture-private-token@example.test',
    'https://example.test/#fixture-private-token',
    'https://example.test/#',
  ]) {
    assert.throws(
      () => readBudgetWebhookConfig({ BUDGET_WEBHOOK_URL: value, BUDGET_THRESHOLD_CENTS: '30000' }),
      (error: Error) => {
        assert.match(error.message, /^BUDGET_WEBHOOK_URL /);
        assert.doesNotMatch(error.message, /fixture-private-token|example\.test|file:|https:/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test('budget webhook posts the full event with its idempotency key and accepts empty 204 responses', async () => {
  let calls = 0;
  await createBudgetWebhookSender(
    { webhookUrl },
    {
      fetch: async (input, init) => {
        calls++;
        assert.equal(String(input), webhookUrl);
        assert.equal(init?.method, 'POST');
        assert.equal(init?.redirect, 'error');
        assert.ok(init?.signal instanceof AbortSignal);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('Content-Type'), 'application/json; charset=utf-8');
        assert.equal(headers.get('Idempotency-Key'), notification.id);
        assert.deepEqual(JSON.parse(String(init?.body)), notification);
        assert.doesNotMatch(String(init?.body), /fixture-private-token/);
        return new Response(null, { status: 204 });
      },
    },
  )(notification);
  assert.equal(calls, 1);
});

test('budget webhook uses HTTP success without interpreting the response body', async () => {
  for (const status of [200, 201, 202, 299]) {
    await createBudgetWebhookSender(
      { webhookUrl },
      { fetch: async () => new Response('not-json', { status }) },
    )(notification);
  }
});

test('budget webhook sanitizes HTTP, redirect, and network failures', async () => {
  const cases: { fetch: typeof fetch; expected: RegExp }[] = [
    {
      fetch: async () => new Response(webhookUrl, { status: 429 }),
      expected: /^预算 Webhook HTTP 429$/,
    },
    {
      fetch: async () => new Response(webhookUrl, { status: 500 }),
      expected: /^预算 Webhook HTTP 500$/,
    },
    {
      fetch: async () =>
        new Response(webhookUrl, { status: 302, headers: { Location: webhookUrl } }),
      expected: /^预算 Webhook HTTP 302$/,
    },
    {
      fetch: async (_input, init) => {
        assert.equal(init?.redirect, 'error');
        throw new TypeError(`redirect encountered for ${webhookUrl}`);
      },
      expected: /^预算 Webhook 网络请求失败$/,
    },
    {
      fetch: async () => {
        throw new Error(`connection failure: ${webhookUrl}`);
      },
      expected: /^预算 Webhook 网络请求失败$/,
    },
  ];
  for (const example of cases) {
    await assert.rejects(
      createBudgetWebhookSender({ webhookUrl }, { fetch: example.fetch })(notification),
      (error: Error) => {
        assert.match(error.message, example.expected);
        assert.doesNotMatch(error.message, /fixture-private-token|https:|billing\.example/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test('budget webhook enforces a ten-second deadline and sanitizes timeout details', async (context) => {
  const controller = new AbortController();
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 10_000);
    return controller.signal;
  });
  await assert.rejects(
    createBudgetWebhookSender(
      { webhookUrl },
      {
        fetch: async (_input, init) => {
          assert.equal(init?.signal, controller.signal);
          controller.abort(new Error(`timed out: ${webhookUrl}`));
          throw controller.signal.reason;
        },
      },
    )(notification),
    (error: Error) => {
      assert.equal(error.message, '预算 Webhook 请求超时');
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});
