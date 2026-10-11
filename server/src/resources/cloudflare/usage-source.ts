import type { AnalyticsData, AnalyticsRow } from '@/resources/cloudflare/analytics';
import type { UsageMeter } from '@/types';

export type QuantitySource = NonNullable<UsageMeter['quantitySource']>;

/** Metrics that have an additive account-wide aggregate in the same units/window. */
export const aggregateMeters: Record<string, [key: string, field: string, divisor: number][]> = {
  workersInvocationsAdaptive: [
    ['worker_standard_request', 'requests', 1],
    ['worker_standard_cpu_ms', 'cpuTimeUs', 1000],
  ],
  containersUsageAdaptiveGroups: [
    ['cloudchamber_memory_usage', 'allocatedMemory', 2 ** 30],
    ['cloudchamber_disk_usage', 'allocatedDisk', 1e9],
    ['cloudchamber_cpu_usage', 'cpuTimeSec', 1],
  ],
  durableObjectsPeriodicGroups: [
    ['worker_durable_objects_duration', 'duration', 1],
    ['worker_durable_objects_srs_storage_reads', 'rowsRead', 1],
    ['worker_durable_objects_srs_storage_writes', 'rowsWritten', 1],
    ['worker_durable_objects_storage_reads', 'storageReadUnits', 1],
    ['worker_durable_objects_storage_writes', 'storageWriteUnits', 1],
    ['worker_durable_objects_storage_deletes', 'storageDeletes', 1],
  ],
  queueMessageOperationsAdaptiveGroups: [['queues_standard_operations', 'billableOperations', 1]],
  workersBuildsBuildMinutesAdaptiveGroups: [['worker_build_minutes', 'buildMinutes', 1]],
  d1AnalyticsAdaptiveGroups: [
    ['d1_rows_read', 'rowsRead', 1],
    ['d1_rows_written', 'rowsWritten', 1],
  ],
};

export const resourceFields: Record<string, string> = {
  workersInvocationsAdaptive: 'scriptName',
  containersUsageAdaptiveGroups: 'applicationId',
  durableObjectsPeriodicGroups: 'namespaceId',
  durableObjectsInvocationsAdaptiveGroups: 'namespaceId',
  r2OperationsAdaptiveGroups: 'bucketName',
  queueMessageOperationsAdaptiveGroups: 'queueId',
  d1AnalyticsAdaptiveGroups: 'databaseId',
  kvOperationsAdaptiveGroups: 'namespaceId',
};

export function aggregateQuantity(rows: AnalyticsRow[] | undefined, field: string): number | null {
  // A successful empty aggregate query is an observed zero, not missing data.
  if (rows?.length === 0) return 0;
  if (rows?.length !== 1) return null;
  const value = rows[0]?.sum?.[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Select by availability, never truthiness: an official zero beats nonzero resource sums. */
export function preferOfficialAggregates(
  quantities: Record<string, number>,
  summaries: AnalyticsData,
): Record<string, QuantitySource> {
  const sources: Record<string, QuantitySource> = Object.fromEntries(
    Object.keys(quantities).map((key) => [key, 'resource-sum']),
  );
  for (const [dataset, meters] of Object.entries(aggregateMeters)) {
    for (const [key, field, divisor] of meters) {
      const official = aggregateQuantity(summaries[dataset], field);
      if (official !== null) {
        quantities[key] = official / divisor;
        sources[key] = 'official-aggregate';
      }
    }
  }
  const dynamic = summaries.workersInvocationsByOwnerAndScriptGroups;
  const value =
    dynamic?.length === 0
      ? 0
      : dynamic?.length === 1
        ? dynamic[0]?.uniq?.distinctDynamicWorkerCount
        : undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    quantities.dynamic_workers_daily = value;
    sources.dynamic_workers_daily = 'official-aggregate';
  }
  return sources;
}
