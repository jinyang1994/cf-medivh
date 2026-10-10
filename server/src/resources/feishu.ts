import { createHmac } from 'node:crypto';
import { utcDay } from '@/utils/dates';
import type {
  BillingNotification,
  CollectionFailureNotification,
  Notification,
  NotificationSender,
} from '@/types';

interface FeishuConfig {
  webhookUrl: string;
  secret?: string;
}

interface SenderOptions {
  fetch?: typeof fetch;
  now?: () => Date;
}

function beijingTime(value: string | null, fallback = '待校正'): string {
  const date = value ? utcDay(value) : null;
  return date?.isValid() ? date.utcOffset(8).format('YYYY-MM-DD HH:mm:ss') : fallback;
}

function summaryNotes(messages: string[], label: string): string[] {
  // Keep the summary comfortably within Feishu's 20 KB request limit.
  const notes = messages.slice(0, 5).map((message) => {
    const text = message.replace(/</g, '＜').replace(/>/g, '＞');
    return `${label}：${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
  });
  if (messages.length > notes.length)
    notes.push(`另有 ${messages.length - notes.length} 条${label}，请查看面板。`);
  return notes;
}

function billingChange(
  { cycle, point }: BillingNotification,
  previous: BillingNotification | null | undefined,
): string {
  if (
    !previous ||
    previous.cycle.id !== cycle.id ||
    previous.cycle.start !== cycle.start ||
    previous.cycle.end !== cycle.end
  )
    return '本账期首次汇报，暂无对比';
  if (previous.cycle.currency !== cycle.currency) return '币种变化，暂无对比';
  const before = previous.point.currentTotal;
  const current = point.currentTotal;
  if (before === null || current === null || !Number.isFinite(before) || !Number.isFinite(current))
    return '待校正';
  const delta = Number((current - before).toFixed(6));
  return `${cycle.currency} ${delta.toFixed(6)}`;
}

function billingText(
  notification: BillingNotification,
  previousBilling?: BillingNotification | null,
): string {
  const { cycle, point, warnings } = notification;
  const amount = (value: number | null): string =>
    value !== null && Number.isFinite(value) ? `${cycle.currency} ${value.toFixed(6)}` : '待校正';
  return [
    'Cloudflare 用量账单',
    `采集时间（北京时间）：${beijingTime(point.observedAt)}`,
    `账期（UTC）：${cycle.start} 至 ${cycle.end}（结束日不含）`,
    `官方账单 + 预测：${amount(point.currentTotal)}`,
    `本地数据 + 预测：${amount(point.localTotal)}`,
    `本次增量：${billingChange(notification, previousBilling)}`,
    `当日增量（UTC）：${amount(point.todayLocal)}`,
    `昨日官方累计：${amount(point.officialHistorical)}`,
    ...summaryNotes(warnings, '提示'),
  ].join('\n');
}

function failureText(notification: CollectionFailureNotification): string {
  const { attemptedAt, cycle, errors, lastSuccessfulAt } = notification;
  return [
    'Cloudflare 数据获取失败',
    `本轮采集时间（北京时间）：${beijingTime(attemptedAt)}`,
    ...(cycle ? [`账期（UTC）：${cycle.start} 至 ${cycle.end}（结束日不含）`] : []),
    ...summaryNotes(errors.length ? errors : ['采集未完成'], '失败原因'),
    `上次成功采集时间（北京时间）：${beijingTime(lastSuccessfulAt, '尚无成功数据')}`,
    lastSuccessfulAt
      ? '本轮未生成新的费用结果，保留上次成功数据；下轮自动重试。'
      : '本轮未生成费用结果；下轮自动重试。',
  ].join('\n');
}

function isCollectionFailure(
  notification: Notification,
): notification is CollectionFailureNotification {
  return 'kind' in notification && notification.kind === 'collection_failure';
}

/** Custom bot protocol: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot */
export function createFeishuSender(
  config: FeishuConfig,
  options: SenderOptions = {},
): NotificationSender {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  return async (notification, previousBilling) => {
    const payload: {
      msg_type: 'text';
      content: { text: string };
      timestamp?: string;
      sign?: string;
    } = {
      msg_type: 'text',
      content: {
        text: isCollectionFailure(notification)
          ? failureText(notification)
          : billingText(notification, previousBilling),
      },
    };
    if (config.secret) {
      const seconds = Math.floor(now().getTime() / 1000);
      if (!Number.isFinite(seconds)) throw new Error('飞书通知签名时间无效');
      payload.timestamp = String(seconds);
      // Feishu uses timestamp + newline + secret as the HMAC key, with an empty message.
      payload.sign = createHmac('sha256', `${payload.timestamp}\n${config.secret}`)
        .update('')
        .digest('base64');
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > 20 * 1024) throw new Error('飞书通知内容超过 20 KB');
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await fetcher(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
        redirect: 'error',
        signal,
      });
    } catch {
      // Fetch errors may contain the webhook URL. Never persist them or their cause.
      throw new Error(signal.aborted ? '飞书通知请求超时' : '飞书通知网络请求失败');
    }
    if (!response.ok) throw new Error(`飞书 HTTP ${response.status}`);
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error(signal.aborted ? '飞书通知请求超时' : '飞书通知响应格式无效');
    }
    if (result === null || typeof result !== 'object' || Array.isArray(result))
      throw new Error('飞书通知响应格式无效');
    const data = result as Record<string, unknown>;
    // code is authoritative; StatusCode is only the documented legacy compatibility field.
    const code = Object.hasOwn(data, 'code') ? data.code : data.StatusCode;
    if (typeof code !== 'number' || !Number.isSafeInteger(code))
      throw new Error('飞书通知响应缺少有效业务状态码');
    if (code !== 0) throw new Error(`飞书业务错误（code ${code}）`);
  };
}
