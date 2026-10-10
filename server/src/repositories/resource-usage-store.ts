import type { DatabaseSync } from 'node:sqlite';
import type { BillingCycle, ResourceUsageTrend } from '@/types';

type RequestedResolution = 'ten-minute' | 'daily';
type Resolution = ResourceUsageTrend['resolution'];
const DAY = 86_400_000;
const intervalFor = (resolution: Resolution) =>
  resolution === 'daily' ? DAY : resolution === 'hourly' ? 3_600_000 : 600_000;
const iso = (time: number) => new Date(time).toISOString();
const validQuantity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const RESOURCE_USAGE_GAP_WARNING =
  '部分时段尚未采集或采集失败，图中保留断线；合计仅包含已采集的用量。';

interface StreamRow {
  unit: string;
  resolution: Resolution;
  fetched_at: string;
  warnings: string;
  unavailable_reason: string | null;
}

export interface ResourceUsageCoverage {
  start: string;
  end: string;
  fetchedAt: string;
  complete: boolean;
}

/** Durable interval observations. Reads never contact Cloudflare or trigger collection. */
export class ResourceUsageStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS resource_usage_streams (
        cycle_id TEXT NOT NULL REFERENCES cycles(id), service TEXT NOT NULL, meter_key TEXT NOT NULL,
        requested_resolution TEXT NOT NULL, resolution TEXT NOT NULL, unit TEXT NOT NULL,
        fetched_at TEXT NOT NULL, warnings TEXT NOT NULL, unavailable_reason TEXT,
        PRIMARY KEY(cycle_id,service,meter_key,requested_resolution)
      );
      CREATE TABLE IF NOT EXISTS resource_usage_resources (
        cycle_id TEXT NOT NULL REFERENCES cycles(id), service TEXT NOT NULL, meter_key TEXT NOT NULL,
        resource_id TEXT NOT NULL, name TEXT NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY(cycle_id,service,meter_key,resource_id)
      );
      CREATE TABLE IF NOT EXISTS resource_usage_buckets (
        cycle_id TEXT NOT NULL REFERENCES cycles(id), service TEXT NOT NULL, meter_key TEXT NOT NULL,
        requested_resolution TEXT NOT NULL, resolution TEXT NOT NULL, timestamp TEXT NOT NULL,
        complete INTEGER NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY(cycle_id,service,meter_key,requested_resolution,resolution,timestamp)
      );
      CREATE TABLE IF NOT EXISTS resource_usage_values (
        cycle_id TEXT NOT NULL REFERENCES cycles(id), service TEXT NOT NULL, meter_key TEXT NOT NULL,
        requested_resolution TEXT NOT NULL, resolution TEXT NOT NULL, timestamp TEXT NOT NULL,
        resource_id TEXT NOT NULL, quantity REAL, fetched_at TEXT NOT NULL,
        PRIMARY KEY(cycle_id,service,meter_key,requested_resolution,resolution,timestamp,resource_id)
      );
      CREATE TABLE IF NOT EXISTS resource_usage_coverage (
        cycle_id TEXT NOT NULL REFERENCES cycles(id), service TEXT NOT NULL, meter_key TEXT NOT NULL,
        requested_resolution TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
        fetched_at TEXT NOT NULL, complete INTEGER NOT NULL,
        PRIMARY KEY(cycle_id,service,meter_key,requested_resolution,start,end)
      );
    `);
  }

  save(cycle: BillingCycle, requestedResolution: RequestedResolution, trend: ResourceUsageTrend) {
    const stream = [cycle.id, trend.service, trend.meterKey, requestedResolution];
    const resourceKey = [cycle.id, trend.service, trend.meterKey];
    const start = Date.parse(trend.start);
    const end = Date.parse(trend.end);
    const interval = intervalFor(trend.resolution);
    const fetchedAt = iso(Date.parse(trend.fetchedAt));
    const points = new Map(
      trend.points
        .filter((point) => {
          const time = Date.parse(point.timestamp);
          return Number.isFinite(time) && time >= start && time < end && time % interval === 0;
        })
        .map((point) => [iso(Date.parse(point.timestamp)), point]),
    );
    const windows = trend.coverage?.length
      ? trend.coverage
      : [{ start: trend.start, end: trend.end, complete: !trend.unavailableReason }];
    const hasObservation = [...points.values()].some((point) => {
      const values = Object.values(point.quantities);
      if (values.some(validQuantity)) return true;
      const time = Date.parse(point.timestamp);
      return (
        !values.length &&
        windows.some(
          (window) =>
            window.complete && time >= Date.parse(window.start) && time < Date.parse(window.end),
        )
      );
    });
    const keepExistingFormat = trend.unavailableReason || !hasObservation ? 1 : 0;
    const incomingIds = new Set(trend.resources.map((resource) => resource.id));
    for (const point of points.values()) {
      for (const id of Object.keys(point.quantities)) incomingIds.add(id);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO cycles(id,start,end,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
        )
        .run(cycle.id, cycle.start, cycle.end, JSON.stringify(cycle));
      this.db
        .prepare(
          `INSERT INTO resource_usage_streams VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(cycle_id,service,meter_key,requested_resolution) DO UPDATE SET
          resolution=CASE WHEN ?=1 THEN resource_usage_streams.resolution ELSE excluded.resolution END,
          unit=CASE WHEN ?=1 THEN resource_usage_streams.unit ELSE excluded.unit END,fetched_at=excluded.fetched_at,
          warnings=excluded.warnings,unavailable_reason=excluded.unavailable_reason
          WHERE excluded.fetched_at>=resource_usage_streams.fetched_at`,
        )
        .run(
          ...stream,
          trend.resolution,
          trend.unit,
          fetchedAt,
          JSON.stringify(trend.warnings),
          trend.unavailableReason,
          keepExistingFormat,
          keepExistingFormat,
        );
      const names = new Map(trend.resources.map((resource) => [resource.id, resource.name]));
      const saveResource = this.db
        .prepare(`INSERT INTO resource_usage_resources VALUES (?,?,?,?,?,?)
        ON CONFLICT(cycle_id,service,meter_key,resource_id) DO UPDATE SET
        name=CASE WHEN excluded.name=excluded.resource_id THEN resource_usage_resources.name ELSE excluded.name END,
        fetched_at=excluded.fetched_at WHERE excluded.fetched_at>=resource_usage_resources.fetched_at`);
      for (const id of incomingIds)
        saveResource.run(...resourceKey, id, names.get(id) || id, fetchedAt);
      const knownIds = (
        this.db
          .prepare(
            'SELECT resource_id FROM resource_usage_resources WHERE cycle_id=? AND service=? AND meter_key=?',
          )
          .all(...resourceKey) as { resource_id: string }[]
      ).map((row) => row.resource_id);
      const saveBucket = this.db
        .prepare(`INSERT INTO resource_usage_buckets VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(cycle_id,service,meter_key,requested_resolution,resolution,timestamp) DO UPDATE SET
        complete=excluded.complete,fetched_at=excluded.fetched_at
        WHERE excluded.fetched_at>=resource_usage_buckets.fetched_at
          AND (excluded.complete=1 OR resource_usage_buckets.complete=0)`);
      const saveValue = this.db
        .prepare(`INSERT INTO resource_usage_values VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(cycle_id,service,meter_key,requested_resolution,resolution,timestamp,resource_id) DO UPDATE SET
        quantity=excluded.quantity,fetched_at=excluded.fetched_at
        WHERE excluded.fetched_at>=resource_usage_values.fetched_at
          AND (excluded.quantity IS NOT NULL OR resource_usage_values.quantity IS NULL)`);
      const completeness = new Map<string, boolean>();
      for (let time = Math.ceil(start / interval) * interval; time < end; time += interval) {
        const timestamp = iso(time);
        const point = points.get(timestamp);
        const bucketComplete =
          !!point &&
          !trend.unavailableReason &&
          windows.some(
            (window) =>
              window.complete && time >= Date.parse(window.start) && time < Date.parse(window.end),
          ) &&
          [...incomingIds].every((id) => validQuantity(point.quantities[id]));
        completeness.set(timestamp, bucketComplete);
        // Explicit nulls preserve failed windows across restarts and make future reads honest.
        saveBucket.run(...stream, trend.resolution, timestamp, bucketComplete ? 1 : 0, fetchedAt);
        for (const id of knownIds) {
          const value = point?.quantities[id];
          const quantity = validQuantity(value)
            ? value
            : bucketComplete && !incomingIds.has(id)
              ? 0
              : null;
          saveValue.run(...stream, trend.resolution, timestamp, id, quantity, fetchedAt);
        }
      }
      const saveCoverage = this.db
        .prepare(`INSERT INTO resource_usage_coverage VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(cycle_id,service,meter_key,requested_resolution,start,end) DO UPDATE SET
        fetched_at=excluded.fetched_at,complete=excluded.complete
        WHERE excluded.fetched_at>=resource_usage_coverage.fetched_at`);
      for (const window of windows) {
        const windowStart = Date.parse(window.start);
        const windowEnd = Date.parse(window.end);
        let complete = window.complete && !trend.unavailableReason && windowStart < windowEnd;
        for (
          let time = Math.ceil(windowStart / interval) * interval;
          time < windowEnd;
          time += interval
        ) {
          complete &&= completeness.get(iso(time)) ?? false;
        }
        saveCoverage.run(...stream, iso(windowStart), iso(windowEnd), fetchedAt, complete ? 1 : 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  lastCollected(
    cycleId: string,
    service: string,
    meter: string,
    resolution: RequestedResolution,
  ): string | null {
    return (
      (
        this.db
          .prepare(
            `SELECT fetched_at FROM resource_usage_streams
      WHERE cycle_id=? AND service=? AND meter_key=? AND requested_resolution=?`,
          )
          .get(cycleId, service, meter, resolution) as { fetched_at: string } | undefined
      )?.fetched_at ?? null
    );
  }

  coverage(
    cycleId: string,
    service: string,
    meter: string,
    resolution: RequestedResolution,
  ): ResourceUsageCoverage[] {
    return (
      this.db
        .prepare(
          `SELECT start,end,fetched_at,complete FROM resource_usage_coverage
      WHERE cycle_id=? AND service=? AND meter_key=? AND requested_resolution=? ORDER BY start,end`,
        )
        .all(cycleId, service, meter, resolution) as {
        start: string;
        end: string;
        fetched_at: string;
        complete: number;
      }[]
    ).map((row) => ({
      start: row.start,
      end: row.end,
      fetchedAt: row.fetched_at,
      complete: !!row.complete,
    }));
  }

  read(
    cycle: BillingCycle,
    service: string,
    meter: string,
    requestedResolution: RequestedResolution,
    now: Date,
    bounds?: { start?: string },
  ): ResourceUsageTrend | null {
    const stream = [cycle.id, service, meter, requestedResolution];
    const metadata = this.db
      .prepare(
        `SELECT unit,resolution,fetched_at,warnings,unavailable_reason
      FROM resource_usage_streams WHERE cycle_id=? AND service=? AND meter_key=? AND requested_resolution=?`,
      )
      .get(...stream) as StreamRow | undefined;
    if (!metadata) return null;
    const interval = intervalFor(metadata.resolution);
    const end = Math.min(now.getTime(), Date.parse(cycle.end));
    const requestedStart = bounds?.start === undefined ? Number.NaN : Date.parse(bounds.start);
    const start = Math.min(
      end,
      Math.max(
        Date.parse(cycle.start),
        Number.isFinite(requestedStart)
          ? requestedStart
          : requestedResolution === 'daily'
            ? Date.parse(cycle.start)
            : Math.ceil((end - 2 * DAY) / interval) * interval,
      ),
    );
    const queryBounds = [...stream, metadata.resolution, iso(start), iso(end)];
    const buckets = new Map(
      (
        this.db
          .prepare(
            `SELECT timestamp,complete FROM resource_usage_buckets
      WHERE cycle_id=? AND service=? AND meter_key=? AND requested_resolution=? AND resolution=? AND timestamp>=? AND timestamp<?`,
          )
          .all(...queryBounds) as { timestamp: string; complete: number }[]
      ).map((row) => [row.timestamp, !!row.complete]),
    );
    const values = new Map<string, Map<string, number | null>>();
    for (const row of this.db
      .prepare(
        `SELECT timestamp,resource_id,quantity FROM resource_usage_values
      WHERE cycle_id=? AND service=? AND meter_key=? AND requested_resolution=? AND resolution=? AND timestamp>=? AND timestamp<?`,
      )
      .all(...queryBounds) as {
      timestamp: string;
      resource_id: string;
      quantity: number | null;
    }[]) {
      const bucket = values.get(row.timestamp) ?? new Map<string, number | null>();
      bucket.set(row.resource_id, row.quantity);
      values.set(row.timestamp, bucket);
    }
    const resources = (
      this.db
        .prepare(
          'SELECT resource_id,name FROM resource_usage_resources WHERE cycle_id=? AND service=? AND meter_key=? ORDER BY resource_id',
        )
        .all(cycle.id, service, meter) as { resource_id: string; name: string }[]
    ).map((row) => ({ id: row.resource_id, name: row.name, total: 0 }));
    const points: ResourceUsageTrend['points'] = [];
    let missing = false;
    let available = false;
    for (let time = Math.ceil(start / interval) * interval; time < end; time += interval) {
      const timestamp = iso(time);
      const complete = buckets.get(timestamp) ?? false;
      const quantities: Record<string, number | null> = Object.create(null);
      if (complete) available = true;
      else missing = true;
      for (const resource of resources) {
        const value = values.get(timestamp)?.get(resource.id);
        const quantity = value === undefined ? (complete ? 0 : null) : value;
        quantities[resource.id] = quantity;
        if (quantity !== null) {
          resource.total += quantity;
          available = true;
        } else missing = true;
      }
      points.push({ timestamp, quantities });
    }
    const warnings: string[] = JSON.parse(metadata.warnings);
    if (metadata.unavailable_reason && available) {
      warnings.push(`最近一次资源采集未完成，保留已保存的用量：${metadata.unavailable_reason}`);
    }
    if (missing && available) warnings.push(RESOURCE_USAGE_GAP_WARNING);
    return {
      service,
      meterKey: meter,
      unit: metadata.unit,
      resolution: metadata.resolution,
      start: iso(start),
      end: iso(end),
      fetchedAt: metadata.fetched_at,
      resources: resources.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
      points,
      warnings: [...new Set(warnings)],
      unavailableReason: available
        ? null
        : (metadata.unavailable_reason ?? '资源用量尚未采集，请等待后台采集完成。'),
    };
  }
}
