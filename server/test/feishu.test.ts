import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuSender } from '@/resources/feishu';
import type { BillingNotification, CollectionFailureNotification } from '@/types';

const webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-private-webhook';
const secret = 'fixture-private-signing-secret';
const notification: BillingNotification = {
  id: 'fixture-notification',
  cycle: {
    id: '2026-09-16:2026-10-16',
    start: '2026-09-16',
    end: '2026-10-16',
    currency: 'USD',
  },
  point: {
    timestamp: '2026-10-08T12:10:00.000Z',
    observedAt: '2026-10-08T12:10:07.000Z',
    currentTotal: 5.658488,
    localTotal: 5.659403,
    todayLocal: 0.032874,
    officialHistorical: 5.625614,
    source: 'collected',
  },
  warnings: ['历史日志已超出保留期'],
};

const failureNotification: CollectionFailureNotification = {
  kind: 'collection_failure',
  id: 'fixture-failed-notification',
  attemptedAt: '2026-10-08T12:20:03.000Z',
  slot: '2026-10-08T12:20:00.000Z',
  cycle: notification.cycle,
  errors: ['Workers 用量查询超时', 'R2 用量数据不完整'],
  lastSuccessfulAt: notification.point.observedAt,
};

test('Feishu sends only a text summary with Beijing collection time, UTC cycle, and six-place amounts', async () => {
  let calls = 0;
  await createFeishuSender(
    { webhookUrl },
    {
      fetch: async (input, init) => {
        calls++;
        assert.equal(String(input), webhookUrl);
        assert.equal(init?.method, 'POST');
        assert.equal(init?.redirect, 'error');
        assert.match(new Headers(init?.headers).get('Content-Type')!, /^application\/json/);
        assert.ok(init?.signal instanceof AbortSignal);
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.msg_type, 'text');
        assert.equal('timestamp' in payload, false);
        assert.equal('sign' in payload, false);
        assert.equal(
          payload.content.text,
          [
            'Cloudflare 用量账单',
            '采集时间（北京时间）：2026-10-08 20:10:07',
            '账期（UTC）：2026-09-16 至 2026-10-16（结束日不含）',
            '官方账单 + 预测：USD 5.658488',
            '本地数据 + 预测：USD 5.659403',
            '本次增量：本账期首次汇报，暂无对比',
            '当日增量（UTC）：USD 0.032874',
            '昨日官方累计：USD 5.625614',
            '提示：历史日志已超出保留期',
          ].join('\n'),
        );
        assert.doesNotMatch(
          String(init?.body),
          /fixture-notification|fixture-private|Authorization/,
        );
        return Response.json({ code: 0, StatusCode: 0, msg: 'success' });
      },
    },
  )(notification);
  assert.equal(calls, 1);
});

test('Feishu reports local sub-cent growth, reductions, and unchanged totals against the previous summary', async () => {
  const cases = [
    { current: 5.658488, previous: 5.655608, expected: 'USD 0.002880' },
    { current: 5.655608, previous: 5.658488, expected: 'USD -0.002880' },
    { current: 5.658488, previous: 5.658488, expected: 'USD 0.000000' },
    { current: 0.000001, previous: 0, expected: 'USD 0.000001' },
    { current: 0, previous: 0, expected: 'USD 0.000000' },
    { current: 0.3, previous: 0.1 + 0.2, expected: 'USD 0.000000' },
    { current: null, previous: 5.655608, expected: '待校正' },
    { current: 5.658488, previous: null, expected: '待校正' },
    { current: Number.NaN, previous: 5, expected: '待校正' },
    { current: 5, previous: Number.POSITIVE_INFINITY, expected: '待校正' },
  ];
  for (const { current, previous, expected } of cases) {
    await createFeishuSender(
      { webhookUrl },
      {
        fetch: async (_input, init) => {
          const text = JSON.parse(String(init?.body)).content.text as string;
          assert.ok(text.includes(`本次增量：${expected}`));
          assert.doesNotMatch(text, /-0\.000000|NaN|Infinity/);
          return Response.json({ code: 0 });
        },
      },
    )(
      {
        ...notification,
        point: { ...notification.point, localTotal: current, todayLocal: 0.001 },
      },
      {
        ...notification,
        id: 'previous-day-summary',
        point: {
          ...notification.point,
          timestamp: '2026-10-07T23:50:00.000Z',
          observedAt: '2026-10-07T23:50:05.000Z',
          currentTotal: 99,
          todayLocal: 0.1,
          localTotal: previous,
        },
      },
    );
  }
});

test('Feishu calculates local increments regardless of missing or corrected official bills', async () => {
  const officialTotals: [number | null, number | null][] = [
    [null, null],
    [5, null],
    [null, 100],
    [100, 5],
  ];
  for (const [before, current] of officialTotals) {
    await createFeishuSender(
      { webhookUrl },
      {
        fetch: async (_input, init) => {
          const text = JSON.parse(String(init?.body)).content.text as string;
          assert.match(text, /本次增量：USD 0\.002880/);
          return Response.json({ code: 0 });
        },
      },
    )(
      {
        ...notification,
        point: { ...notification.point, currentTotal: current, localTotal: 5.658488 },
      },
      {
        ...notification,
        point: { ...notification.point, currentTotal: before, localTotal: 5.655608 },
      },
    );
  }
});

test('Feishu does not compare totals across billing cycles or currencies', async () => {
  const cases = [
    {
      cycle: { ...notification.cycle, id: 'previous-cycle' },
      expected: '本账期首次汇报，暂无对比',
    },
    { cycle: { ...notification.cycle, start: '2026-09-01' }, expected: '本账期首次汇报，暂无对比' },
    { cycle: { ...notification.cycle, end: '2026-10-01' }, expected: '本账期首次汇报，暂无对比' },
    { cycle: { ...notification.cycle, currency: 'EUR' }, expected: '币种变化，暂无对比' },
  ];
  for (const { cycle, expected } of cases) {
    await createFeishuSender(
      { webhookUrl },
      {
        fetch: async (_input, init) => {
          const text = JSON.parse(String(init?.body)).content.text as string;
          assert.ok(text.includes(`本次增量：${expected}`));
          return Response.json({ code: 0 });
        },
      },
    )(notification, { ...notification, cycle });
  }
});

test('Feishu keeps pending amounts distinct from measured zero and does not invent a collection time', async () => {
  await createFeishuSender(
    { webhookUrl },
    {
      fetch: async (_input, init) => {
        const text = JSON.parse(String(init?.body)).content.text as string;
        assert.match(text, /采集时间（北京时间）：待校正/);
        assert.match(text, /官方账单 \+ 预测：待校正/);
        assert.match(text, /本地数据 \+ 预测：USD 0\.000000/);
        assert.match(text, /当日增量（UTC）：待校正/);
        assert.match(text, /昨日官方累计：USD 0\.000000/);
        return Response.json({ code: 0 });
      },
    },
  )({
    ...notification,
    point: {
      ...notification.point,
      observedAt: null,
      currentTotal: null,
      localTotal: 0,
      todayLocal: null,
      officialHistorical: 0,
    },
  });
});

test('Feishu signature matches the official timestamp/demo vector and uses send time rather than sample time', async () => {
  await createFeishuSender(
    { webhookUrl, secret: 'demo' },
    {
      now: () => new Date(1599360473_999),
      fetch: async (_input, init) => {
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.timestamp, '1599360473');
        // Independently computed with the official Python hmac example.
        assert.equal(payload.sign, 'l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=');
        assert.match(payload.content.text, /2026-10-08 20:10:07/);
        return Response.json({ code: 0 });
      },
    },
  )(notification);
});

test('Feishu accepts legacy success but never lets it hide a modern business error', async () => {
  await createFeishuSender(
    { webhookUrl },
    {
      fetch: async () => Response.json({ StatusCode: 0, StatusMessage: 'success' }),
    },
  )(notification);
  for (const result of [
    { code: 19024, StatusCode: 0, msg: `${webhookUrl} ${secret}` },
    { StatusCode: 19021, StatusMessage: `${webhookUrl} ${secret}` },
  ]) {
    await assert.rejects(
      createFeishuSender(
        { webhookUrl, secret },
        {
          fetch: async () => Response.json(result),
        },
      )(notification),
      (error: Error) => {
        assert.match(error.message, /^飞书业务错误（code 1902[14]）$/);
        assert.doesNotMatch(error.message, /fixture-private|https:|success/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test('Feishu sanitizes HTTP, network, and malformed response failures', async () => {
  const cases: { fetch: typeof fetch; expected: RegExp }[] = [
    {
      fetch: async () => new Response(`${webhookUrl} ${secret}`, { status: 429 }),
      expected: /^飞书 HTTP 429$/,
    },
    {
      fetch: async () => {
        throw new Error(`${webhookUrl} ${secret}`);
      },
      expected: /^飞书通知网络请求失败$/,
    },
    {
      fetch: async () => new Response(`${webhookUrl} ${secret}`),
      expected: /^飞书通知响应格式无效$/,
    },
    { fetch: async () => Response.json(null), expected: /^飞书通知响应格式无效$/ },
    {
      fetch: async () => Response.json({ code: secret, StatusCode: 0 }),
      expected: /^飞书通知响应缺少有效业务状态码$/,
    },
    {
      fetch: async () => Response.json({ msg: `${webhookUrl} ${secret}` }),
      expected: /^飞书通知响应缺少有效业务状态码$/,
    },
  ];
  for (const example of cases) {
    await assert.rejects(
      createFeishuSender({ webhookUrl, secret }, { fetch: example.fetch })(notification),
      (error: Error) => {
        assert.match(error.message, example.expected);
        assert.doesNotMatch(error.message, /fixture-private|https:/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test('Feishu applies a ten-second deadline and sanitizes timeout details', async (context) => {
  const controller = new AbortController();
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 10_000);
    return controller.signal;
  });
  await assert.rejects(
    createFeishuSender(
      { webhookUrl, secret },
      {
        fetch: async (_input, init) => {
          assert.equal(init?.signal, controller.signal);
          controller.abort(new Error(`${webhookUrl} ${secret}`));
          throw controller.signal.reason;
        },
      },
    )(notification),
    /^Error: 飞书通知请求超时$/,
  );
});

test('Feishu bounds warning text and keeps untrusted mention markup as literal text', async () => {
  await createFeishuSender(
    { webhookUrl },
    {
      fetch: async (_input, init) => {
        const body = String(init?.body);
        const text = JSON.parse(body).content.text as string;
        assert.ok(Buffer.byteLength(body, 'utf8') < 20 * 1024);
        assert.doesNotMatch(text, /<at/);
        assert.match(text, /＜at user_id="all"＞/);
        assert.match(text, /另有 3 条提示/);
        assert.match(text, /…/);
        return Response.json({ code: 0 });
      },
    },
  )({
    ...notification,
    warnings: Array.from({ length: 8 }, () => '<at user_id="all">' + '长提示'.repeat(1000)),
  });
});

test('Feishu reports collection failure with the attempt time and last success without repeating old amounts', async () => {
  await createFeishuSender(
    { webhookUrl },
    {
      fetch: async (_input, init) => {
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.msg_type, 'text');
        assert.equal(
          payload.content.text,
          [
            'Cloudflare 数据获取失败',
            '本轮采集时间（北京时间）：2026-10-08 20:20:03',
            '账期（UTC）：2026-09-16 至 2026-10-16（结束日不含）',
            '失败原因：Workers 用量查询超时',
            '失败原因：R2 用量数据不完整',
            '上次成功采集时间（北京时间）：2026-10-08 20:10:07',
            '本轮未生成新的费用结果，保留上次成功数据；下轮自动重试。',
          ].join('\n'),
        );
        assert.doesNotMatch(
          payload.content.text,
          /USD|官方账单|本地数据|当日增量|昨日官方累计|5\.658488|fixture-/,
        );
        return Response.json({ code: 0 });
      },
    },
  )(failureNotification);
});

test('Feishu reports an initial collection failure without inventing a cycle or successful history', async () => {
  await createFeishuSender(
    { webhookUrl },
    {
      fetch: async (_input, init) => {
        const text = JSON.parse(String(init?.body)).content.text as string;
        assert.match(text, /本轮采集时间（北京时间）：2026-10-08 20:20:03/);
        assert.match(text, /上次成功采集时间（北京时间）：尚无成功数据/);
        assert.match(text, /失败原因：采集未完成/);
        assert.match(text, /本轮未生成费用结果；下轮自动重试。/);
        assert.doesNotMatch(text, /账期|保留上次成功数据|USD|0\.000000|待校正/);
        return Response.json({ code: 0 });
      },
    },
  )({ ...failureNotification, cycle: null, lastSuccessfulAt: null, errors: [] });
});

test('Feishu bounds failure reasons and escapes mention markup using the same limits as warnings', async () => {
  await createFeishuSender(
    { webhookUrl },
    {
      fetch: async (_input, init) => {
        const body = String(init?.body);
        const text = JSON.parse(body).content.text as string;
        assert.ok(Buffer.byteLength(body, 'utf8') < 20 * 1024);
        assert.equal(text.split('\n').filter((line) => line.startsWith('失败原因：')).length, 5);
        assert.doesNotMatch(text, /<at|<\/at>/);
        assert.match(text, /＜at user_id="all"＞所有人＜\/at＞/);
        assert.match(text, /另有 3 条失败原因，请查看面板。/);
        assert.match(text, /…/);
        return Response.json({ code: 0 });
      },
    },
  )({
    ...failureNotification,
    errors: Array.from(
      { length: 8 },
      () => '<at user_id="all">所有人</at>' + '长错误说明'.repeat(1000),
    ),
  });
});
