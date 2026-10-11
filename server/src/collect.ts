import { notificationConfig } from '@/services/runtime-settings';
import { notificationLanguage } from '@/services/notification-settings';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '@/config';
import { createCloudflareProvider } from '@/resources/cloudflare/provider';
import { Store } from '@/repositories/billing-store';
import { Collector } from '@/services/collector';
import { dashboard } from '@/services/dashboard';
import { createNotificationExtensions } from '@/resources/notifications';

const config = loadConfig();
const { accountId, token, databasePath } = config;
mkdirSync(dirname(databasePath), { recursive: true });
const store = new Store(databasePath);
const collector = new Collector(
  store,
  createCloudflareProvider({ accountId, token }),
  undefined,
  () =>
    createNotificationExtensions(notificationConfig(store, config), () =>
      notificationLanguage(store),
    ),
);
try {
  const collected = await collector.tick(true);
  if (!collected) throw new Error('已有采集任务运行，请在完成后重试');
  const data = dashboard(store, collector);
  console.log(
    JSON.stringify(
      {
        cycle: data.cycle,
        asOf: data.asOf,
        totals: data.totals,
        errors: data.collection.errors,
        warnings: data.collection.warnings,
      },
      null,
      2,
    ),
  );
  if (data.collection.errors.length || !data.totals.complete) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  store.close();
}
