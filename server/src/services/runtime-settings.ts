import { readBudgetWebhookConfig, readFeishuConfig, type loadConfig } from '@/config';
import type { Store } from '@/repositories/billing-store';
import { notificationLanguage, setNotificationLanguage } from '@/services/notification-settings';

export type NotificationDefaults = Pick<ReturnType<typeof loadConfig>, 'feishu' | 'budgetWebhook'>;
const key = 'runtimeNotificationSettings';
interface Settings {
  hideSocialIcons: boolean;
  feishu: { enabled: boolean; webhookUrl: string; secret: string };
  budget: { enabled: boolean; webhookUrl: string; thresholdCents: number };
}
export function runtimeSettings(store: Store, defaults: NotificationDefaults): Settings {
  const saved = store.get(key);
  if (saved) return { hideSocialIcons: false, ...JSON.parse(saved) } as Settings;
  return {
    hideSocialIcons: false,
    feishu: {
      enabled: !!defaults.feishu,
      webhookUrl: defaults.feishu?.webhookUrl ?? '',
      secret: defaults.feishu?.secret ?? '',
    },
    budget: {
      enabled: !!defaults.budgetWebhook,
      webhookUrl: defaults.budgetWebhook?.webhookUrl ?? '',
      thresholdCents: defaults.budgetWebhook?.thresholdCents ?? 30000,
    },
  };
}
export function maskSecret(secret: string): string {
  if (!secret) return '';
  const characters = Array.from(secret);
  return characters.length > 8
    ? `${characters.slice(0, 4).join('')}••••••••${characters.slice(-4).join('')}`
    : '••••••••';
}
export function publicSettings(store: Store, defaults: NotificationDefaults) {
  const settings = runtimeSettings(store, defaults);
  return {
    language: notificationLanguage(store),
    hideSocialIcons: settings.hideSocialIcons,
    feishu: {
      enabled: settings.feishu.enabled,
      webhookConfigured: !!settings.feishu.webhookUrl,
      webhookUrl: settings.feishu.webhookUrl,
      maskedSecret: maskSecret(settings.feishu.secret),
      secretConfigured: !!settings.feishu.secret,
    },
    budget: {
      enabled: settings.budget.enabled,
      webhookConfigured: !!settings.budget.webhookUrl,
      webhookUrl: settings.budget.webhookUrl,
      thresholdCents: settings.budget.thresholdCents,
    },
  };
}
export function notificationConfig(
  store: Store,
  defaults: NotificationDefaults,
): NotificationDefaults {
  const { feishu, budget } = runtimeSettings(store, defaults);
  return {
    feishu: feishu.enabled
      ? { webhookUrl: feishu.webhookUrl, ...(feishu.secret ? { secret: feishu.secret } : {}) }
      : undefined,
    budgetWebhook: budget.enabled
      ? { webhookUrl: budget.webhookUrl, thresholdCents: budget.thresholdCents }
      : undefined,
  };
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('invalid_settings');
  return value as Record<string, unknown>;
}
function replacement(value: unknown, previous: string): string {
  if (value === undefined || value === '') return previous;
  if (typeof value !== 'string' || value.length > 4096) throw new Error('invalid_settings');
  return value.trim() || previous;
}
export function saveRuntimeSettings(store: Store, defaults: NotificationDefaults, input: unknown) {
  const data = record(input, ['language', 'hideSocialIcons', 'feishu', 'budget']);
  if (data.language !== 'en' && data.language !== 'zh-CN') throw new Error('invalid_language');
  const feishu = record(data.feishu, [
    'enabled',
    'webhookUrl',
    'signingSecret',
    'clearSigningSecret',
  ]);
  const budget = record(data.budget, ['enabled', 'webhookUrl', 'thresholdCents']);
  if (
    (data.hideSocialIcons !== undefined && typeof data.hideSocialIcons !== 'boolean') ||
    typeof feishu.enabled !== 'boolean' ||
    typeof budget.enabled !== 'boolean' ||
    (feishu.clearSigningSecret !== undefined && typeof feishu.clearSigningSecret !== 'boolean')
  )
    throw new Error('invalid_settings');
  const previous = runtimeSettings(store, defaults);
  const settings: Settings = {
    hideSocialIcons: (data.hideSocialIcons as boolean | undefined) ?? previous.hideSocialIcons,
    feishu: {
      enabled: feishu.enabled,
      webhookUrl: replacement(feishu.webhookUrl, previous.feishu.webhookUrl),
      secret: feishu.clearSigningSecret
        ? ''
        : replacement(feishu.signingSecret, previous.feishu.secret),
    },
    budget: {
      enabled: budget.enabled,
      webhookUrl: replacement(budget.webhookUrl, previous.budget.webhookUrl),
      thresholdCents: budget.thresholdCents as number,
    },
  };
  if (!Number.isSafeInteger(settings.budget.thresholdCents) || settings.budget.thresholdCents <= 0)
    throw new Error('invalid_threshold');
  try {
    if (settings.feishu.enabled || settings.feishu.webhookUrl) {
      if (!settings.feishu.webhookUrl) throw new Error();
      readFeishuConfig({
        FEISHU_WEBHOOK_URL: settings.feishu.webhookUrl,
        FEISHU_SIGNING_SECRET: settings.feishu.secret,
      });
    }
  } catch {
    throw new Error('invalid_feishu');
  }
  try {
    if (settings.budget.enabled || settings.budget.webhookUrl) {
      if (!settings.budget.webhookUrl) throw new Error();
      readBudgetWebhookConfig({
        BUDGET_WEBHOOK_URL: settings.budget.webhookUrl,
        BUDGET_THRESHOLD_CENTS: String(settings.budget.thresholdCents),
      });
    }
  } catch {
    throw new Error('invalid_budget');
  }
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.set(key, JSON.stringify(settings));
    setNotificationLanguage(store, data.language);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return publicSettings(store, defaults);
}
