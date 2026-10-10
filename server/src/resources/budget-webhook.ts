import type { BudgetAlertNotification } from '@/types';

interface BudgetWebhookConfig {
  webhookUrl: string;
}

interface SenderOptions {
  fetch?: typeof fetch;
}

export function createBudgetWebhookSender(
  config: BudgetWebhookConfig,
  options: SenderOptions = {},
): (notification: BudgetAlertNotification) => Promise<void> {
  const fetcher = options.fetch ?? fetch;
  return async (notification) => {
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await fetcher(config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Idempotency-Key': notification.id,
        },
        body: JSON.stringify(notification),
        redirect: 'error',
        signal,
      });
    } catch {
      // URLs and original errors can contain webhook credentials; never retain either.
      throw new Error(signal.aborted ? '预算 Webhook 请求超时' : '预算 Webhook 网络请求失败');
    }
    // The status is the acknowledgement; release unread bodies before another retry.
    void response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`预算 Webhook HTTP ${response.status}`);
  };
}
