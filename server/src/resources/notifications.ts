import type { NotificationLocale } from '@/services/notification-settings';
import { createHash } from 'node:crypto';
import type { loadConfig } from '@/config';
import { createFeishuSender } from '@/resources/feishu';
import { createBudgetWebhookSender } from '@/resources/budget-webhook';
import type { BudgetAlertNotification, NotificationExtension, NotificationSender } from '@/types';

/** Compare decimal dollars to integer cents without rounding sub-cent values or large thresholds. */
function exceedsThreshold(amountUsd: number, thresholdCents: number): boolean {
  const [coefficient, exponent = '0'] = amountUsd.toString().split('e');
  const [whole, fraction = ''] = coefficient!.split('.');
  const amount = BigInt(`${whole}${fraction}`);
  const scale = Number(exponent) - fraction.length + 2;
  const threshold = BigInt(thresholdCents);
  return scale >= 0
    ? amount * 10n ** BigInt(scale) > threshold
    : amount > threshold * 10n ** BigInt(-scale);
}

export function createFeishuExtension(send: NotificationSender): NotificationExtension {
  return {
    id: 'feishu',
    label: '飞书通知',
    prepare: (notification) => notification,
    async send(notification, previousBilling) {
      if (notification.kind === 'budget_exceeded') throw new Error('飞书通知事件类型无效');
      await send(notification, previousBilling);
    },
  };
}

export function createBudgetExtension(
  thresholdCents: number,
  send: (notification: BudgetAlertNotification) => Promise<void>,
): NotificationExtension {
  return {
    id: 'budget-webhook',
    label: '账单超限 Webhook',
    retry: 'until_success',
    prepare(notification) {
      if (notification.kind === 'collection_failure') return null;
      const { cycle, point } = notification;
      if (
        cycle.currency !== 'USD' ||
        point.observedAt === null ||
        point.currentTotal === null ||
        !Number.isFinite(point.currentTotal) ||
        !exceedsThreshold(point.currentTotal, thresholdCents)
      )
        return null;
      return {
        kind: 'budget_exceeded',
        id: `budget:${createHash('sha256').update(cycle.id).digest('hex')}`,
        cycle,
        observedAt: point.observedAt,
        metric: 'currentTotal',
        thresholdCents,
        amountUsd: point.currentTotal,
      };
    },
    async send(notification) {
      if (notification.kind !== 'budget_exceeded') throw new Error('账单超限通知事件类型无效');
      await send(notification);
    },
  };
}

/** Optional integrations are assembled here; collection and delivery only know the interface. */
export function createNotificationExtensions(
  config: Pick<ReturnType<typeof loadConfig>, 'feishu' | 'budgetWebhook'>,
  language: () => NotificationLocale = () => 'zh-CN',
): NotificationExtension[] {
  return [
    ...(config.feishu
      ? [createFeishuExtension(createFeishuSender(config.feishu, { language }))]
      : []),
    ...(config.budgetWebhook
      ? [
          createBudgetExtension(
            config.budgetWebhook.thresholdCents,
            createBudgetWebhookSender(config.budgetWebhook),
          ),
        ]
      : []),
  ];
}
