import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '@/config';
import { createApp } from '@/app';
import { createCloudflareProvider } from '@/resources/cloudflare/provider';
import { Collector } from '@/services/collector';
import { Store } from '@/repositories/billing-store';
import { createFeishuSender } from '@/resources/feishu';

const { root, accountId, token, databasePath, host, port, feishu } = loadConfig();
mkdirSync(dirname(databasePath), { recursive: true });
const store = new Store(databasePath);
const collector = new Collector(
  store,
  createCloudflareProvider({ accountId, token }),
  undefined,
  feishu ? createFeishuSender(feishu) : undefined,
);
const app = createApp(store, collector, resolve(root, 'web/dist'));
app.on('error', (error: Error) => console.error('HTTP request failed:', error.message));
const server = app.listen(port, host, () =>
  console.log(`Cloudflare billing: http://${host}:${port}`),
);
void collector.start().catch((error: Error) => console.error('Collector failed:', error.message));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  collector.stop();
  server.close();
  while (collector.running) await delay(50);
  store.close();
}
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
