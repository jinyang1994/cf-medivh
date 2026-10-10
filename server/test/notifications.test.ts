import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';
import { dashboard } from '@/services/dashboard';
import { readFeishuConfig } from '@/config';
import { createFeishuExtension } from '@/resources/notifications';
import type { BillingCycle, Notification, CloudflareProvider } from '@/types';

const cycle: BillingCycle = {
  id: 'notify-oct',
  start: '2026-10-01',
  end: '2026-11-01',
  currency: 'USD',
  baseFee: 5,
};
function fixture(clock: () => Date): CloudflareProvider {
  return {
    getBillingCycle: async () => cycle,
    getUsage: async (_cycle, date) => ({
      date,
      observedAt: clock().toISOString(),
      complete: true,
      source: 'analytics',
      meters: [],
    }),
    getOfficialBill: async (_cycle, through) => ({ through, amount: 5, currency: 'USD' }),
  };
}

test('each successful collection sends after saving, including unchanged amounts; restart does not resend a completed slot', async () => {
  const store = new Store(':memory:');
  let now = new Date('2026-10-01T12:00:00Z');
  const sent: Notification[] = [];
  const sender = async (notification: Notification) => {
    assert.equal(store.billingPoints(cycle.id).at(-1)?.observedAt, now.toISOString());
    assert.equal(store.get('lastSuccess'), now.toISOString());
    sent.push(notification);
  };
  try {
    const provider = fixture(() => now);
    await new Collector(store, provider, () => now, [createFeishuExtension(sender)]).tick();
    await new Collector(store, provider, () => now, [createFeishuExtension(sender)]).tick();
    assert.equal(sent.length, 1);
    now = new Date('2026-10-01T12:10:00Z');
    await new Collector(store, provider, () => now, [createFeishuExtension(sender)]).tick();
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0]!.id, sent[1]!.id);
    const [first, second] = sent;
    assert.ok(first && first.kind !== 'collection_failure');
    assert.ok(second && second.kind !== 'collection_failure');
    assert.equal(first.point.currentTotal, second.point.currentTotal);
    assert.deepEqual(store.pendingNotifications(now.toISOString()), []);
  } finally {
    store.close();
  }
});

test('delivery failure leaves billing successful and retries the original message even when a later collection fails', async () => {
  const store = new Store(':memory:');
  let now = new Date('2026-10-01T12:00:00Z');
  const provider = fixture(() => now);
  const attempted: Notification[] = [];
  const sender = async (notification: Notification) => {
    attempted.push(notification);
    if (attempted.length === 1) throw new Error('飞书 HTTP 503');
  };
  try {
    let collector = new Collector(store, provider, () => now, [createFeishuExtension(sender)]);
    await collector.tick();
    assert.deepEqual(store.errors(), []);
    assert.equal(store.get('lastSuccess'), now.toISOString());
    const view = dashboard(store, collector, now);
    assert.equal(view.totals.complete, true);
    assert.ok(view.collection.warnings.some((warning) => warning.includes('飞书')));
    now = new Date('2026-10-01T12:01:00Z');
    collector = new Collector(store, provider, () => now, [createFeishuExtension(sender)]);
    await collector.tick();
    assert.equal(attempted.length, 1);
    now = new Date('2026-10-01T12:10:00Z');
    provider.getUsage = async () => {
      throw new Error('本轮用量暂时不可用');
    };
    await collector.tick();
    assert.equal(attempted.length, 3);
    assert.deepEqual(attempted[1], attempted[0]);
    const retried = attempted[1]!;
    assert.ok(retried.kind !== 'collection_failure');
    assert.equal(retried.point.observedAt, '2026-10-01T12:00:00.000Z');
    const failed = attempted[2]!;
    assert.equal(failed.kind, 'collection_failure');
    if (failed.kind === 'collection_failure') {
      assert.equal(failed.lastSuccessfulAt, '2026-10-01T12:00:00.000Z');
      assert.match(failed.errors.join(' '), /本轮用量暂时不可用/);
    }
    assert.deepEqual(store.notificationErrors(), []);
    assert.equal(store.errors().length, 1);
  } finally {
    store.close();
  }
});

test('historical backfill is summarized once; incomplete realtime data emits failure and disabled notifications stay silent', async () => {
  const now = new Date('2026-10-02T12:00:00Z');
  for (const mode of ['enabled', 'disabled', 'incomplete']) {
    const store = new Store(':memory:');
    const provider = fixture(() => now);
    const readUsage = provider.getUsage;
    let queried = 0;
    provider.getUsage = async (period, date) => {
      queried++;
      const report = await readUsage(period, date);
      return { ...report, complete: !(mode === 'incomplete' && date === '2026-10-02') };
    };
    const sent: Notification[] = [];
    try {
      const send =
        mode === 'disabled'
          ? undefined
          : async (value: Notification) => {
              sent.push(value);
            };
      await new Collector(
        store,
        provider,
        () => now,
        send ? [createFeishuExtension(send)] : [],
      ).tick();
      assert.equal(queried, 2);
      assert.equal(sent.length, mode === 'disabled' ? 0 : 1);
      assert.deepEqual(store.pendingNotifications(now.toISOString()), []);
      if (mode === 'enabled') {
        const result = sent[0]!;
        assert.ok(result.kind !== 'collection_failure');
        assert.equal(result.point.observedAt, now.toISOString());
        assert.equal(result.point.currentTotal, 5);
      } else if (mode === 'incomplete') {
        const result = sent[0]!;
        assert.ok(result.kind === 'collection_failure');
        assert.equal(
          result.lastSuccessfulAt,
          null,
          'backfill must not become last realtime success',
        );
        assert.match(result.errors.join(' '), /服务用量尚未完整/);
      }
    } finally {
      store.close();
    }
  }
});

test('failed rounds notify once per UTC slot, retry their original failure, and notify again next slot', async () => {
  const store = new Store(':memory:');
  let now = new Date('2026-10-01T12:00:00Z');
  const provider = fixture(() => now);
  provider.getUsage = async () => {
    throw new Error('网络请求超时');
  };
  const sent: Notification[] = [];
  let deliver = false;
  const sender = async (notification: Notification) => {
    if (!deliver) throw new Error('飞书通知网络请求失败');
    sent.push(notification);
  };
  try {
    await new Collector(store, provider, () => now, [createFeishuExtension(sender)]).tick();
    assert.equal(store.get('lastSuccess'), null);
    const original = store.pendingNotifications('2026-10-01T12:10:00.000Z')[0]!.notification;
    assert.ok(original.kind === 'collection_failure');
    assert.equal(original.lastSuccessfulAt, null);
    await new Collector(store, provider, () => now, [createFeishuExtension(sender)]).tick();
    await new Collector(store, provider, () => now, [createFeishuExtension(sender)]).tick(true);
    assert.equal(store.pendingNotifications('2026-10-01T12:10:00.000Z').length, 1);
    now = new Date('2026-10-01T12:10:00Z');
    deliver = true;
    await new Collector(store, provider, () => now, [createFeishuExtension(sender)]).tick();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], original);
    assert.notEqual(sent[0]!.id, sent[1]!.id);
    assert.deepEqual(store.notificationErrors(), []);
    assert.equal(store.get('lastSuccess'), null);
  } finally {
    store.close();
  }
});

test('cycle failures notify without a cache or after expiry, but a valid cached cycle remains silent', async () => {
  const now = new Date('2026-10-01T12:00:00Z');
  for (const cached of [
    undefined,
    cycle,
    { ...cycle, id: 'expired', start: '2026-09-30', end: '2026-10-01' },
  ]) {
    const store = new Store(':memory:');
    const provider = fixture(() => now);
    provider.getBillingCycle = async () => {
      throw new Error('fetch failed');
    };
    const sent: Notification[] = [];
    try {
      if (cached) store.saveCycle(cached);
      await new Collector(store, provider, () => now, [
        createFeishuExtension(async (n) => {
          sent.push(n);
        }),
      ]).tick();
      assert.equal(sent.length, 1);
      const result = sent[0]!;
      if (cached === cycle) {
        assert.ok(result.kind !== 'collection_failure');
        assert.deepEqual(result.warnings, []);
      } else {
        assert.ok(result.kind === 'collection_failure');
        assert.equal(result.cycle, null);
        assert.deepEqual(result.errors, ['账单周期：fetch failed']);
      }
    } finally {
      store.close();
    }
  }
});

test('only current realtime errors enter failure alerts; prior warnings and notification errors do not cascade', async () => {
  const store = new Store(':memory:');
  const now = new Date('2026-10-01T12:00:00Z');
  const provider = fixture(() => now);
  provider.getUsage = async (_cycle, date) => ({
    date,
    observedAt: '2026-10-01T12:05:00.000Z',
    complete: true,
    meters: [],
  });
  const sent: Notification[] = [];
  try {
    store.fail('old-task', '旧历史数据错误', '2026-09-30T00:00:00.000Z');
    await new Collector(store, provider, () => now, [
      createFeishuExtension(async (n) => {
        sent.push(n);
      }),
    ]).tick();
    assert.equal(sent.length, 1);
    const result = sent[0]!;
    assert.ok(result.kind === 'collection_failure');
    assert.deepEqual(result.errors, ['2026-10-01 用量：本轮未取得当前日期的有效实时采样']);
    assert.equal(result.lastSuccessfulAt, null);
    assert.equal(store.get('lastSuccess'), null);
  } finally {
    store.close();
  }
});

test('Feishu configuration is opt-in and accepts only the official bot endpoint without URL credentials', () => {
  const webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-bot';
  assert.equal(readFeishuConfig({}), undefined);
  assert.equal(readFeishuConfig({ FEISHU_WEBHOOK_URL: '  ' }), undefined);
  assert.deepEqual(
    readFeishuConfig({ FEISHU_WEBHOOK_URL: webhookUrl, FEISHU_SIGNING_SECRET: 'test-secret' }),
    { webhookUrl, secret: 'test-secret' },
  );
  assert.throws(
    () => readFeishuConfig({ FEISHU_SIGNING_SECRET: 'test-secret' }),
    /FEISHU_WEBHOOK_URL/,
  );
  for (const url of [
    'not a url',
    'http://open.feishu.cn/open-apis/bot/v2/hook/test-bot',
    'https://example.com/open-apis/bot/v2/hook/test-bot',
    'https://user:password@open.feishu.cn/open-apis/bot/v2/hook/test-bot',
    `${webhookUrl}?token=private`,
  ])
    assert.throws(
      () => readFeishuConfig({ FEISHU_WEBHOOK_URL: url }),
      (error: Error) => {
        assert.ok(!error.message.includes(url));
        return /FEISHU_WEBHOOK_URL/.test(error.message);
      },
    );
});
