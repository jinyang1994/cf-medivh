import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export function readFeishuConfig(env: NodeJS.ProcessEnv = process.env) {
  const webhookUrl = env.FEISHU_WEBHOOK_URL?.trim();
  const secret = env.FEISHU_SIGNING_SECRET?.trim();
  if (!webhookUrl) {
    if (secret) throw new Error('配置 FEISHU_SIGNING_SECRET 时也需要 FEISHU_WEBHOOK_URL');
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error('FEISHU_WEBHOOK_URL 不是有效的飞书群机器人地址');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'open.feishu.cn' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9_-]+$/.test(url.pathname)
  )
    throw new Error('FEISHU_WEBHOOK_URL 必须使用飞书群自定义机器人的 HTTPS Webhook 地址');
  return { webhookUrl, ...(secret ? { secret } : {}) };
}

export function readBudgetWebhookConfig(env: NodeJS.ProcessEnv = process.env) {
  const webhookUrl = env.BUDGET_WEBHOOK_URL?.trim();
  const threshold = env.BUDGET_THRESHOLD_CENTS?.trim();
  if (!webhookUrl && !threshold) return undefined;
  if (!webhookUrl || !threshold)
    throw new Error('BUDGET_WEBHOOK_URL 和 BUDGET_THRESHOLD_CENTS 必须同时配置');

  const thresholdCents = Number(threshold);
  if (!/^\d+$/.test(threshold) || !Number.isSafeInteger(thresholdCents) || thresholdCents <= 0)
    throw new Error('BUDGET_THRESHOLD_CENTS 必须是正的安全整数（美元分，如 30000 表示 300 美元）');

  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error('BUDGET_WEBHOOK_URL 不是有效的 Webhook 地址');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    webhookUrl.includes('#')
  )
    throw new Error('BUDGET_WEBHOOK_URL 必须使用 HTTP 或 HTTPS，且不能包含用户名、密码或片段');
  return { webhookUrl, thresholdCents };
}

export function loadConfig() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  dotenv.config({ path: resolve(root, '.env'), quiet: true });
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token)
    throw new Error('请在 .env 配置 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN');
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer from 1 to 65535');
  return {
    root,
    accountId,
    token,
    host,
    port,
    feishu: readFeishuConfig(),
    budgetWebhook: readBudgetWebhookConfig(),
    databasePath: resolve(root, process.env.DATABASE_PATH ?? 'data/billing.sqlite'),
  };
}
