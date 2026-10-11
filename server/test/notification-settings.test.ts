import {
  maskSecret,
  notificationConfig,
  publicSettings,
  saveRuntimeSettings,
} from '@/services/runtime-settings';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@/repositories/billing-store';
import { notificationLanguage, setNotificationLanguage } from '@/services/notification-settings';

test('notification language survives closing and reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'medivh-language-'));
  const path = join(directory, 'billing.sqlite');
  try {
    const first = new Store(path);
    assert.equal(notificationLanguage(first), 'zh-CN');
    setNotificationLanguage(first, 'en');
    first.close();
    const reopened = new Store(path);
    try {
      assert.equal(notificationLanguage(reopened), 'en');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime settings inherit env, preserve secrets, redact reads, validate atomically and survive restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'medivh-settings-'));
  const path = join(directory, 'billing.sqlite');
  const defaults = {
    feishu: {
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/private-token',
      secret: 'private-secret',
    },
    budgetWebhook: undefined,
  };
  const store = new Store(path);
  try {
    assert.equal(notificationConfig(store, defaults).feishu?.secret, 'private-secret');
    const input = {
      language: 'en',
      feishu: { enabled: false, webhookUrl: '', signingSecret: '' },
      budget: {
        enabled: true,
        webhookUrl: 'https://example.com/budget/private-token',
        thresholdCents: 12345,
      },
    };
    const view = saveRuntimeSettings(store, defaults, input);
    assert.doesNotMatch(JSON.stringify(view), /private-secret/);
    assert.equal(view.feishu.webhookUrl, defaults.feishu.webhookUrl);
    assert.equal(view.budget.webhookUrl, input.budget.webhookUrl);
    assert.equal(view.feishu.maskedSecret, 'priv••••••••cret');
    assert.equal(notificationConfig(store, defaults).feishu, undefined);
    assert.equal(notificationConfig(store, defaults).budgetWebhook?.thresholdCents, 12345);
    assert.throws(() => saveRuntimeSettings(store, defaults, { ...input, language: 'fr' }));
    assert.throws(() =>
      saveRuntimeSettings(store, defaults, {
        ...input,
        feishu: { enabled: true, webhookUrl: 'http://invalid.test' },
      }),
    );
    assert.throws(() =>
      saveRuntimeSettings(store, defaults, {
        ...input,
        budget: { ...input.budget, thresholdCents: -1 },
      }),
    );
    assert.equal(notificationLanguage(store), 'en');
    saveRuntimeSettings(store, defaults, { ...input, feishu: { enabled: true } });
    assert.equal(notificationConfig(store, defaults).feishu?.secret, 'private-secret');
    saveRuntimeSettings(store, defaults, {
      ...input,
      feishu: { enabled: true, clearSigningSecret: true },
    });
    assert.equal(notificationConfig(store, defaults).feishu?.secret, undefined);
    assert.equal(publicSettings(store, defaults).feishu.webhookConfigured, true);
  } finally {
    store.close();
  }
  const reopened = new Store(path);
  try {
    assert.equal(
      notificationConfig(reopened, { feishu: undefined, budgetWebhook: undefined }).budgetWebhook
        ?.thresholdCents,
      12345,
    );
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('secret previews mask the middle and never reveal short secrets in full', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('12345678'), '••••••••');
  assert.equal(maskSecret('123'), '••••••••');
  assert.equal(maskSecret('1234-middle-5678'), '1234••••••••5678');
});
