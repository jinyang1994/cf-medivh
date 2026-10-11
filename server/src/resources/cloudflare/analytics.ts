import partition from 'lodash/partition.js';
import sumBy from 'lodash/sumBy.js';
import { utcDay } from '@/utils/dates';

/** Queries verified against Cloudflare's live GraphQL schema. All windows are UTC, end exclusive. */
export interface AnalyticsRow {
  sum?: Record<string, number>;
  max?: Record<string, number>;
  uniq?: Record<string, number>;
  dimensions?: Record<string, string>;
}
export type AnalyticsData = Record<string, AnalyticsRow[]>;
export const datasets: Record<string, string> = {
  workersInvocationsAdaptive: 'sum { requests cpuTimeUs }',
  workersInvocationsByOwnerAndScriptGroups: 'uniq { distinctDynamicWorkerCount }',
  containersUsageAdaptiveGroups:
    'sum { allocatedDisk allocatedMemory cpuTimeSec txBytes } dimensions { region }',
  durableObjectsPeriodicGroups:
    'sum { duration rowsRead rowsWritten inboundWebsocketMsgCount storageReadUnits storageWriteUnits storageDeletes }',
  durableObjectsInvocationsAdaptiveGroups: 'sum { requests } dimensions { type }',
  durableObjectsSqlStorageGroups: 'max { storedBytes } dimensions { namespaceId datetimeHour }',
  durableObjectsStorageGroups: 'max { storedBytes } dimensions { namespaceIds datetimeHour }',
  r2OperationsAdaptiveGroups:
    'sum { requests responseObjectSize } dimensions { actionType storageClass actionStatus }',
  r2StorageAdaptiveGroups:
    'max { payloadSize metadataSize } dimensions { bucketName datetimeHour storageClass }',
  queueMessageOperationsAdaptiveGroups: 'sum { billableOperations }',
  workersBuildsBuildMinutesAdaptiveGroups: 'sum { buildMinutes }',
  d1AnalyticsAdaptiveGroups: 'sum { rowsRead rowsWritten }',
  d1StorageAdaptiveGroups: 'max { databaseSizeBytes } dimensions { databaseId datetimeHour }',
  kvOperationsAdaptiveGroups: 'sum { requests } dimensions { actionType }',
  kvStorageAdaptiveGroups: 'max { byteCount } dimensions { namespaceId datetimeHour }',
};

export function analyticsQuery(
  accountId: string,
  dataset: string,
  date: string,
  end: string,
  selection = datasets[dataset],
): string {
  const filter =
    dataset === 'workersInvocationsByOwnerAndScriptGroups'
      ? `date_geq:${JSON.stringify(date)},date_leq:${JSON.stringify(date)}`
      : `datetime_geq:${JSON.stringify(date + 'T00:00:00Z')},datetime_lt:${JSON.stringify(end)}${dataset === 'workersInvocationsAdaptive' ? ',status_neq:"internalError"' : ''}`;
  return `{viewer{accounts(filter:{accountTag:${JSON.stringify(accountId)}}){${dataset}(limit:10000,filter:{${filter}}){${selection}}}}}`;
}

const CLASS_A = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'ListObjectsV2',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
  'PutBucketEncryption',
  'LifecycleStorageTierTransition',
]);
const CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
  'GetBucketLocation',
  'GetBucketEncryption',
  'UsageSummary',
]);
const FREE_R2 = new Set([
  'DeleteObject',
  'DeleteObjects',
  'DeleteBucket',
  'AbortMultipartUpload',
  'GetBucketSippyConfiguration',
  'PutBucketSippyConfiguration',
  'DeleteBucketSippyConfiguration',
]);
const sum = (rows: AnalyticsRow[] | undefined, key: string) =>
  sumBy(rows ?? [], (row) => row.sum?.[key] ?? 0);

/** Hourly maxima approximate byte-hours, including only the elapsed part of the current hour. */
function storage(rows: AnalyticsRow[] | undefined, keys: string[], until: number): number {
  return sumBy(rows ?? [], (row) => {
    const hour = utcDay(row.dimensions?.datetimeHour ?? '').valueOf();
    if (!Number.isFinite(hour)) throw new Error('Storage sample lacks an hourly timestamp');
    const hours = Math.max(0, Math.min(1, (until - hour) / 3_600_000));
    return (sumBy(keys, (key) => row.max?.[key] ?? 0) * hours) / 720 / 1e9;
  });
}

/** R2 uses the daily peak of each bucket's bytes, averaged over a 30-day month. */
function r2Storage(rows: AnalyticsRow[]): number {
  const peaks = new Map<string, number>();
  for (const row of rows) {
    const key = row.dimensions?.bucketName ?? '';
    peaks.set(
      key,
      Math.max(peaks.get(key) ?? 0, (row.max?.payloadSize ?? 0) + (row.max?.metadataSize ?? 0)),
    );
  }
  return [...peaks.values()].reduce((n, v) => n + v, 0) / 1e9 / 30;
}

export function quantitiesFromAnalytics(
  data: AnalyticsData,
  until: number,
): { quantities: Record<string, number>; warnings: string[] } {
  const q: Record<string, number> = {};
  const warnings: string[] = [];
  if (data.workersInvocationsAdaptive) {
    q.worker_standard_request = sum(data.workersInvocationsAdaptive, 'requests');
    q.worker_standard_cpu_ms = sum(data.workersInvocationsAdaptive, 'cpuTimeUs') / 1000;
  }
  if (data.workersInvocationsByOwnerAndScriptGroups)
    q.dynamic_workers_daily = sumBy(
      data.workersInvocationsByOwnerAndScriptGroups,
      (row) => row.uniq?.distinctDynamicWorkerCount ?? 0,
    );
  if (data.containersUsageAdaptiveGroups) {
    q.cloudchamber_memory_usage =
      sum(data.containersUsageAdaptiveGroups, 'allocatedMemory') / 2 ** 30;
    q.cloudchamber_disk_usage = sum(data.containersUsageAdaptiveGroups, 'allocatedDisk') / 1e9;
    q.cloudchamber_cpu_usage = sum(data.containersUsageAdaptiveGroups, 'cpuTimeSec');
    q.cloudchamber_egress_na_eu = 0;
    q.cloudchamber_egress_oceania = 0;
    q.cloudchamber_egress_other = 0;
    for (const r of data.containersUsageAdaptiveGroups) {
      const region = r.dimensions?.region ?? '';
      const key = ['WNAM', 'ENAM', 'WEUR', 'EEUR'].includes(region)
        ? 'cloudchamber_egress_na_eu'
        : ['OC', 'OCEANIA', 'TW', 'KR'].includes(region)
          ? 'cloudchamber_egress_oceania'
          : 'cloudchamber_egress_other';
      q[key]! += (r.sum?.txBytes ?? 0) / 1e9;
    }
  }
  if (data.durableObjectsPeriodicGroups) {
    q.worker_durable_objects_duration = sum(data.durableObjectsPeriodicGroups, 'duration');
    q.worker_durable_objects_srs_storage_reads = sum(data.durableObjectsPeriodicGroups, 'rowsRead');
    q.worker_durable_objects_srs_storage_writes = sum(
      data.durableObjectsPeriodicGroups,
      'rowsWritten',
    );
    q.worker_durable_objects_storage_reads = sum(
      data.durableObjectsPeriodicGroups,
      'storageReadUnits',
    );
    q.worker_durable_objects_storage_writes = sum(
      data.durableObjectsPeriodicGroups,
      'storageWriteUnits',
    );
    q.worker_durable_objects_storage_deletes = sum(
      data.durableObjectsPeriodicGroups,
      'storageDeletes',
    );
  }
  if (data.durableObjectsInvocationsAdaptiveGroups && data.durableObjectsPeriodicGroups) {
    // Alarms are billed requests; WebSocket messages use the documented 20:1 ratio.
    q.worker_durable_objects_requests =
      sumBy(data.durableObjectsInvocationsAdaptiveGroups, (row) =>
        row.dimensions?.type === 'hibernation' ? 0 : (row.sum?.requests ?? 0),
      ) +
      sum(data.durableObjectsPeriodicGroups, 'inboundWebsocketMsgCount') / 20;
  }
  if (data.durableObjectsSqlStorageGroups)
    q.worker_durable_objects_srs_stored_data = storage(
      data.durableObjectsSqlStorageGroups,
      ['storedBytes'],
      until,
    );
  if (data.durableObjectsStorageGroups)
    q.worker_durable_objects_stored_data = storage(
      data.durableObjectsStorageGroups,
      ['storedBytes'],
      until,
    );
  if (data.r2OperationsAdaptiveGroups) {
    q.r2_class_a_operations = 0;
    q.r2_class_b_operations = 0;
    q.r2_class_a_operations_infrequent_access = 0;
    q.r2_class_b_operations_infrequent_access = 0;
    q.r2_retrieval_infrequent_access = 0;
    for (const r of data.r2OperationsAdaptiveGroups) {
      const action = r.dimensions?.actionType ?? '';
      // Cloudflare bills user errors such as a missing object. Verified against the
      // account's daily billable-usage records; filtering to successes loses these reads.
      if (r.dimensions?.actionStatus === 'internalError') continue;
      const ia = r.dimensions?.storageClass === 'InfrequentAccess';
      const aKey = ia ? 'r2_class_a_operations_infrequent_access' : 'r2_class_a_operations';
      const bKey = ia ? 'r2_class_b_operations_infrequent_access' : 'r2_class_b_operations';
      if (CLASS_A.has(action)) q[aKey]! += r.sum?.requests ?? 0;
      else if (CLASS_B.has(action)) q[bKey]! += r.sum?.requests ?? 0;
      else if (!FREE_R2.has(action)) warnings.push(`R2 操作尚未映射计价类别：${action}`);
      if (ia && action === 'GetObject')
        q.r2_retrieval_infrequent_access += (r.sum?.responseObjectSize ?? 0) / 1e9;
    }
  }
  if (data.r2StorageAdaptiveGroups) {
    const [infrequent, standard] = partition(
      data.r2StorageAdaptiveGroups,
      (row) => row.dimensions?.storageClass === 'InfrequentAccess',
    );
    q.r2_storage = r2Storage(standard);
    q.r2_storage_infrequent_access = r2Storage(infrequent);
  }
  if (data.queueMessageOperationsAdaptiveGroups)
    q.queues_standard_operations = sum(
      data.queueMessageOperationsAdaptiveGroups,
      'billableOperations',
    );
  if (data.workersBuildsBuildMinutesAdaptiveGroups)
    q.worker_build_minutes = sum(data.workersBuildsBuildMinutesAdaptiveGroups, 'buildMinutes');
  if (data.d1AnalyticsAdaptiveGroups) {
    q.d1_rows_read = sum(data.d1AnalyticsAdaptiveGroups, 'rowsRead');
    q.d1_rows_written = sum(data.d1AnalyticsAdaptiveGroups, 'rowsWritten');
  }
  if (data.d1StorageAdaptiveGroups)
    q.d1_storage = storage(data.d1StorageAdaptiveGroups, ['databaseSizeBytes'], until);
  if (data.kvOperationsAdaptiveGroups) {
    q.worker_kv_reads = 0;
    q.worker_kv_writes = 0;
    q.worker_kv_lists = 0;
    q.worker_kv_deletes = 0;
    for (const r of data.kvOperationsAdaptiveGroups) {
      const action = (r.dimensions?.actionType ?? '').toLowerCase();
      const key = action.includes('read')
        ? 'reads'
        : action.includes('write')
          ? 'writes'
          : action.includes('list')
            ? 'lists'
            : action.includes('delete')
              ? 'deletes'
              : null;
      if (key) q[`worker_kv_${key}`]! += r.sum?.requests ?? 0;
      else if ((r.sum?.requests ?? 0) > 0) warnings.push(`KV 操作尚未映射：${action}`);
    }
  }
  if (data.kvStorageAdaptiveGroups)
    q.worker_kv_storage = storage(data.kvStorageAdaptiveGroups, ['byteCount'], until);
  return { quantities: q, warnings };
}
