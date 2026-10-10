import type { BillingCycle, ResourceUsageTrend } from '@/types';
import type { CloudflareConfig } from '@/resources/cloudflare/provider';
import {
  datasets,
  quantitiesFromAnalytics,
  type AnalyticsData,
  type AnalyticsRow,
} from '@/resources/cloudflare/analytics';
import { meterDefinition } from '@/services/pricing';

const API = 'https://api.cloudflare.com/client/v4';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const TEN_MINUTES = 600_000;
const PAGE_LIMIT = 10_000;
const LOG_GROUP_LIMIT = 2_000;
type Resolution = 'ten-minute' | 'daily';

interface Dataset {
  name: string;
  resourceField: string;
  dimensions?: string[];
  storage?: boolean;
  dailyPeak?: boolean;
}

const WORKERS: Dataset = { name: 'workersInvocationsAdaptive', resourceField: 'scriptName' };
const CONTAINERS: Dataset = {
  name: 'containersUsageAdaptiveGroups',
  resourceField: 'applicationId',
  dimensions: ['region'],
};
const PERIODIC: Dataset = {
  name: 'durableObjectsPeriodicGroups',
  resourceField: 'namespaceId',
};
const INVOCATIONS: Dataset = {
  name: 'durableObjectsInvocationsAdaptiveGroups',
  resourceField: 'namespaceId',
  dimensions: ['type'],
};
const R2_OPERATIONS: Dataset = {
  name: 'r2OperationsAdaptiveGroups',
  resourceField: 'bucketName',
  dimensions: ['actionType', 'storageClass', 'actionStatus'],
};
const R2_STORAGE: Dataset = {
  name: 'r2StorageAdaptiveGroups',
  resourceField: 'bucketName',
  dimensions: ['storageClass'],
  storage: true,
  dailyPeak: true,
};

function sourcesFor(key: string): Dataset[] {
  if (key === 'worker_standard_request' || key === 'worker_standard_cpu_ms') return [WORKERS];
  if (key.startsWith('cloudchamber_')) return [CONTAINERS];
  if (key === 'worker_durable_objects_requests') return [PERIODIC, INVOCATIONS];
  if (key === 'worker_durable_objects_srs_stored_data')
    return [
      { name: 'durableObjectsSqlStorageGroups', resourceField: 'namespaceId', storage: true },
    ];
  if (key === 'worker_durable_objects_stored_data')
    return [{ name: 'durableObjectsStorageGroups', resourceField: 'namespaceIds', storage: true }];
  if (key.startsWith('worker_durable_objects_')) return [PERIODIC];
  if (key === 'r2_storage' || key === 'r2_storage_infrequent_access') return [R2_STORAGE];
  if (key.startsWith('r2_')) return [R2_OPERATIONS];
  if (key === 'queues_standard_operations')
    return [{ name: 'queueMessageOperationsAdaptiveGroups', resourceField: 'queueId' }];
  if (key === 'd1_storage')
    return [{ name: 'd1StorageAdaptiveGroups', resourceField: 'databaseId', storage: true }];
  if (key.startsWith('d1_'))
    return [{ name: 'd1AnalyticsAdaptiveGroups', resourceField: 'databaseId' }];
  if (key === 'worker_kv_storage')
    return [{ name: 'kvStorageAdaptiveGroups', resourceField: 'namespaceId', storage: true }];
  if (key.startsWith('worker_kv_'))
    return [
      {
        name: 'kvOperationsAdaptiveGroups',
        resourceField: 'namespaceId',
        dimensions: ['actionType'],
      },
    ];
  return [];
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function timestamp(value: string): number {
  // Telemetry returns UTC timestamps without an explicit suffix.
  return Date.parse(/^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(' ', 'T') + 'Z' : value);
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapLimit<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]!);
      }
    }),
  );
  return results;
}

interface Envelope<T> {
  success?: boolean;
  result: T;
  errors?: { message: string }[];
  result_info?: { total_pages?: number; next_page_token?: string };
}

interface DatasetSettings {
  enabled: boolean;
  notOlderThan: number;
  maxPageSize: number;
}

interface DirectoryConfig {
  path: string;
  id: string;
  name: string;
}

const directories: Record<string, DirectoryConfig> = {
  'Durable Objects': { path: '/workers/durable_objects/namespaces', id: 'id', name: 'name' },
  Containers: { path: '/containers/applications', id: 'id', name: 'name' },
  Queues: { path: '/queues', id: 'queue_id', name: 'queue_name' },
  D1: { path: '/d1/database', id: 'uuid', name: 'name' },
  'Workers KV': { path: '/storage/kv/namespaces', id: 'id', name: 'title' },
};

interface LogAggregate {
  value: number;
  groups?: { key: string; value: string }[];
}

interface LogResult {
  run: { status: string; granularity?: number };
  calculations: {
    calculation: string;
    aggregates: LogAggregate[];
    series?: { time: string; data: LogAggregate[] }[];
  }[];
}

/** Read-only historical resource metrics. This never collects billing or sends notifications. */
export function createResourceTrendReader(config: CloudflareConfig) {
  const fetcher = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const headers = {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  };
  const namesCache = new Map<
    string,
    { at: number; names: Map<string, string>; warning?: string }
  >();
  // One collection requests several meters backed by the same analytics dataset.
  // Coalesce identical reads briefly without caching failures or stale next-slot data.
  const queryCache = new Map<string, { at: number; data: Promise<unknown> }>();

  async function request<T>(path: string, body?: unknown): Promise<Envelope<T>> {
    const response = await fetcher(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}`);
    const json = (await response.json()) as Envelope<T>;
    if (json.success === false || json.errors?.length)
      throw new Error(
        json.errors?.map((error) => error.message).join('；') || 'Cloudflare 查询失败',
      );
    return json;
  }

  async function graphql<T>(query: string): Promise<T> {
    const cached = queryCache.get(query);
    if (cached && Date.now() - cached.at < 60_000) return cached.data as Promise<T>;
    const data = (async () => {
      const response = await request<never>('/graphql', { query });
      const result = (response as unknown as { data?: { viewer?: { accounts?: T[] } } }).data;
      const account = result?.viewer?.accounts?.[0];
      if (!account) throw new Error('Cloudflare 未返回账户资源用量');
      return account;
    })();
    queryCache.set(query, { at: Date.now(), data });
    if (queryCache.size > 512) queryCache.delete(queryCache.keys().next().value!);
    try {
      return await data;
    } catch (error) {
      if (queryCache.get(query)?.data === data) queryCache.delete(query);
      throw error;
    }
  }

  const account = (selection: string) =>
    `{viewer{accounts(filter:{accountTag:${JSON.stringify(config.accountId)}}){${selection}}}}`;

  async function resourceNames(service: string) {
    const directory = directories[service];
    if (!directory) return { names: new Map<string, string>(), warning: undefined };
    const cached = namesCache.get(service);
    if (cached && now().getTime() - cached.at < HOUR) return cached;
    const names = new Map<string, string>();
    let warning: string | undefined;
    try {
      let page = 1;
      let cursor: string | undefined;
      do {
        const query = cursor
          ? `page_token=${encodeURIComponent(cursor)}&per_page=100`
          : `page=${page}&per_page=100`;
        const response = await request<Record<string, unknown>[]>(
          `/accounts/${config.accountId}${directory.path}?${query}`,
        );
        if (!Array.isArray(response.result)) throw new Error('资源目录格式无效');
        for (const item of response.result) {
          const id = item[directory.id];
          const name =
            service === 'Durable Objects' && item.script && item.class
              ? `${String(item.script)} / ${String(item.class)}`
              : item[directory.name];
          if (typeof id === 'string' && typeof name === 'string') names.set(id, name);
        }
        cursor = response.result_info?.next_page_token;
        if (!cursor && page >= (response.result_info?.total_pages ?? 1)) break;
        if (++page > 100) throw new Error('资源目录分页超过限制');
      } while (true);
    } catch (error) {
      warning = `未能读取 ${service} 资源名称，未识别的资源显示 ID（${failure(error)}）`;
    }
    const result = { at: now().getTime(), names, warning };
    namesCache.set(service, result);
    return result;
  }

  return async function readResourceTrend(
    cycle: BillingCycle,
    service: string,
    meterKey: string,
    requestedResolution: Resolution,
    window?: { start: string; end: string },
  ): Promise<ResourceUsageTrend> {
    const definition =
      meterKey === '__base_fee' && service === '订阅'
        ? { service: '订阅', unit: '周期' }
        : meterDefinition(meterKey, cycle.workersPaid ?? true);
    if (!definition || definition.service !== service) throw new Error('服务与计量项目不匹配');
    const fetchedAt = now().getTime();
    if (
      window &&
      (!Number.isFinite(Date.parse(window.start)) ||
        !Number.isFinite(Date.parse(window.end)) ||
        Date.parse(window.start) >= Date.parse(window.end))
    )
      throw new Error('资源采集时间范围无效');
    const end = Math.min(
      fetchedAt,
      Date.parse(cycle.end),
      window ? Date.parse(window.end) : Infinity,
    );
    const cycleStart = Date.parse(cycle.start);
    const sources = sourcesFor(meterKey);
    const logs = meterKey === 'worker_observability_events';
    let resolution: ResourceUsageTrend['resolution'] = requestedResolution;
    const warnings: string[] = [];
    if (requestedResolution === 'ten-minute' && sources.some((source) => source.storage)) {
      resolution = sources.some((source) => source.dailyPeak) ? 'daily' : 'hourly';
      warnings.push(
        resolution === 'daily'
          ? 'R2 存储按每天峰值折算 GB-months，资源图按日展示。'
          : '存储用量按小时折算 GB-months，资源图按小时展示。',
      );
    }
    const interval = resolution === 'daily' ? DAY : resolution === 'hourly' ? HOUR : TEN_MINUTES;
    let start = window
      ? Math.max(cycleStart, Math.floor(Date.parse(window.start) / interval) * interval)
      : requestedResolution === 'daily'
        ? cycleStart
        : Math.max(cycleStart, Math.ceil((end - 2 * DAY) / interval) * interval);
    const result: ResourceUsageTrend = {
      service,
      meterKey,
      unit: definition.unit,
      resolution,
      start: iso(start),
      end: iso(end),
      fetchedAt: iso(fetchedAt),
      resources: [],
      points: [],
      warnings,
      unavailableReason: null,
    };
    if (!sources.length && !logs) {
      result.unavailableReason =
        meterKey === '__base_fee'
          ? '固定订阅费用没有具体资源用量。'
          : meterKey === 'worker_build_minutes'
            ? 'Cloudflare 的构建用量统计没有提供按 Worker 拆分的维度，暂时只能查看服务汇总。'
            : 'Cloudflare 的此项用量统计没有提供具体资源维度，暂时只能查看服务汇总。';
      return result;
    }
    let retention = logs ? (cycle.workersPaid === false ? 3 : 7) * DAY : Infinity;
    const limits = new Map<string, number>();
    if (!logs) {
      try {
        const response = await graphql<{ settings: Record<string, DatasetSettings> }>(
          account(
            `settings{${sources.map((source) => `${source.name}{enabled notOlderThan maxPageSize}`).join(' ')}}`,
          ),
        );
        for (const source of sources) {
          const settings = response.settings?.[source.name];
          if (!settings?.enabled) throw new Error(`${source.name} 未获当前 API Token 授权`);
          if (!(settings.notOlderThan > 0) || !(settings.maxPageSize > 0))
            throw new Error(`${source.name} 未返回有效的查询范围`);
          retention = Math.min(retention, settings.notOlderThan * 1000);
          limits.set(source.name, Math.min(PAGE_LIMIT, settings.maxPageSize));
        }
      } catch (error) {
        result.unavailableReason = `无法读取资源用量：${failure(error)}`;
        return result;
      }
    }
    const availableStart = Math.ceil((fetchedAt - retention) / interval) * interval;
    if (start < availableStart) {
      start = availableStart;
      result.start = iso(start);
      warnings.push(
        `Cloudflare 此项资源明细仅保留最近 ${Math.round(retention / DAY)} 天，图表从 ${iso(start).slice(0, 10)} 起展示可查询的数据。`,
      );
    }
    if (start >= end) {
      result.unavailableReason = '所选账期已超出 Cloudflare 资源明细的可查询范围。';
      return result;
    }
    const windows: { start: number; end: number }[] = [];
    for (let from = start; from < end;) {
      const until = Math.min(end, (Math.floor(from / DAY) + 1) * DAY);
      windows.push({ start: from, end: until });
      from = until;
    }
    const grouped = new Map<number, Map<string, AnalyticsData>>();
    const logQuantities = new Map<number, Map<string, number>>();
    const resourceIds = new Set<string>();
    const failedWindows: { start: number; end: number }[] = [];
    const completed = await mapLimit(windows, async (window) => {
      try {
        if (logs) {
          const response = await request<LogResult>(
            `/accounts/${config.accountId}/workers/observability/telemetry/query`,
            {
              queryId: 'medivh-resource-usage-trend',
              timeframe: { from: window.start, to: window.end },
              view: 'calculations',
              dry: true,
              ignoreSeries: resolution === 'daily',
              chartType: resolution === 'daily' ? 'aggregate' : 'timeseries_and_aggregate',
              // The live API takes milliseconds here (verified with 600000 => ten minutes).
              granularity: interval,
              parameters: {
                datasets: ['cloudflare-workers'],
                calculations: [{ operator: 'count' }],
                groupBys: [{ type: 'string', value: '$metadata.service' }],
                limit: LOG_GROUP_LIMIT,
              },
            },
          );
          if (response.result.run?.status !== 'COMPLETED') throw new Error('日志用量查询尚未完成');
          const count = response.result.calculations?.find((item) => item.calculation === 'count');
          if (!count || !Array.isArray(count.aggregates)) throw new Error('日志用量未返回资源汇总');
          if (count.aggregates.length >= LOG_GROUP_LIMIT) throw new Error('日志资源数超过查询上限');
          if (resolution !== 'daily' && response.result.run.granularity !== interval)
            throw new Error('日志 API 返回的时间粒度与请求不符');
          const periods =
            resolution === 'daily'
              ? [{ time: iso(window.start), data: count.aggregates }]
              : count.series;
          if (!periods) throw new Error('日志用量未返回时间序列');
          const values: { time: number; id: string; quantity: number }[] = [];
          for (const period of periods) {
            const time = timestamp(period.time);
            if (!Number.isFinite(time) || time < window.start || time >= window.end) continue;
            for (const item of period.data) {
              const id = item.groups?.find((group) => group.key === '$metadata.service')?.value;
              if (!id || !Number.isFinite(item.value) || item.value < 0)
                throw new Error('日志资源用量格式无效');
              values.push({
                time: Math.floor(time / interval) * interval,
                id,
                quantity: item.value,
              });
            }
          }
          // A truncated series must not silently turn into zeros. Aggregate and series counts
          // can differ with adaptive sampling, so only reject entirely missing nonzero series.
          if (
            resolution !== 'daily' &&
            !values.length &&
            count.aggregates.some((item) => item.value > 0)
          )
            throw new Error('日志资源时间序列缺失');
          for (const value of values) {
            resourceIds.add(value.id);
            const bucket = logQuantities.get(value.time) ?? new Map<string, number>();
            bucket.set(value.id, (bucket.get(value.id) ?? 0) + value.quantity);
            logQuantities.set(value.time, bucket);
          }
        } else {
          // Keep the full window atomic: DO requests need both invocations and WebSocket data.
          const rowsBySource: { source: Dataset; rows: AnalyticsRow[]; timeField: string }[] = [];
          for (const source of sources) {
            const timeField = source.storage
              ? 'datetimeHour'
              : resolution === 'daily'
                ? 'date'
                : 'datetimeFiveMinutes';
            const selection = datasets[source.name]!.replace(/\s*dimensions\s*\{[^}]*\}/, '');
            const fields = [
              ...new Set([source.resourceField, timeField, ...(source.dimensions ?? [])]),
            ];
            const filter = `datetime_geq:${JSON.stringify(iso(window.start))},datetime_lt:${JSON.stringify(iso(window.end))}${source === WORKERS ? ',status_neq:"internalError"' : ''}`;
            const limit = limits.get(source.name)!;
            const data = await graphql<Record<string, AnalyticsRow[]>>(
              account(
                `${source.name}(limit:${limit},filter:{${filter}}){${selection} dimensions{${fields.join(' ')}}}`,
              ),
            );
            const rows = data[source.name];
            if (!Array.isArray(rows)) throw new Error(`${source.name} 未返回资源用量`);
            if (rows.length >= limit)
              throw new Error(`${source.name} 达到查询上限，未展示可能被截断的数据`);
            // Validate the entire response before adding any values from this window.
            for (const row of rows) {
              const dimensions = row.dimensions as Record<string, unknown> | undefined;
              const resource = dimensions?.[source.resourceField];
              if (
                source.resourceField === 'namespaceIds' &&
                (!Array.isArray(resource) || resource.length !== 1)
              )
                throw new Error(
                  'Cloudflare 将多个 Durable Object 命名空间合并返回，无法可靠拆分此项存储',
                );
              const id = Array.isArray(resource) ? resource[0] : resource;
              if (typeof id !== 'string' || !id) throw new Error(`${source.name} 缺少资源标识`);
              const value = dimensions?.[timeField];
              const time = typeof value === 'string' ? timestamp(value) : NaN;
              if (!Number.isFinite(time) || time < window.start || time >= window.end)
                throw new Error(`${source.name} 返回无效的时间桶`);
            }
            rowsBySource.push({ source, rows, timeField });
          }
          for (const { source, rows, timeField } of rowsBySource) {
            for (const row of rows) {
              const dimensions = row.dimensions as Record<string, unknown>;
              const resource = dimensions[source.resourceField];
              const id = (Array.isArray(resource) ? resource[0] : resource) as string;
              const time =
                Math.floor(timestamp(dimensions[timeField] as string) / interval) * interval;
              resourceIds.add(id);
              const bucket = grouped.get(time) ?? new Map<string, AnalyticsData>();
              const data =
                bucket.get(id) ?? Object.fromEntries(sources.map((item) => [item.name, []]));
              (data[source.name] ??= []).push(row);
              bucket.set(id, data);
              grouped.set(time, bucket);
            }
          }
        }
        return true;
      } catch (error) {
        failedWindows.push(window);
        warnings.push(`${iso(window.start).slice(0, 10)} 资源用量未取得：${failure(error)}`);
        return false;
      }
    });
    result.coverage = windows.map((window, index) => ({
      start: iso(window.start),
      end: iso(window.end),
      complete: completed[index]!,
    }));
    if (!completed.some(Boolean)) {
      result.unavailableReason = '未能取得所选时间范围的资源用量，请查看下方数据说明或稍后重试。';
      return result;
    }
    const totals = new Map([...resourceIds].map((id) => [id, 0]));
    for (let time = start; time < end; time += interval) {
      const missing = failedWindows.some((window) => time >= window.start && time < window.end);
      const quantities: Record<string, number | null> = Object.create(null);
      for (const id of resourceIds) {
        let quantity: number | null = null;
        if (!missing) {
          if (logs) quantity = logQuantities.get(time)?.get(id) ?? 0;
          else {
            const data =
              grouped.get(time)?.get(id) ??
              Object.fromEntries(sources.map((source) => [source.name, []]));
            const converted = quantitiesFromAnalytics(data, Math.min(time + interval, end));
            warnings.push(...converted.warnings);
            quantity = converted.quantities[meterKey] ?? null;
          }
        }
        if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) {
          quantity = null;
          warnings.push('部分资源用量数值无效，图中保留空缺。');
        }
        quantities[id] = quantity;
        if (quantity !== null) totals.set(id, totals.get(id)! + quantity);
      }
      result.points.push({ timestamp: iso(time), quantities });
    }
    if (resourceIds.size) {
      const directory = await resourceNames(service);
      if (directory.warning) warnings.push(directory.warning);
      result.resources = [...resourceIds]
        .map((id) => ({ id, name: directory.names.get(id) ?? id, total: totals.get(id)! }))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    }
    if (failedWindows.length)
      warnings.push('部分时间段查询失败，图中保留空缺；窗口合计仅包含已取得的数据。');
    result.warnings = [...new Set(warnings)];
    return result;
  };
}
