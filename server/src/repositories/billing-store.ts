import { DatabaseSync } from 'node:sqlite';
import type {
  BillingCycle,
  BillingPoint,
  DeliveryNotification,
  Notification,
  OfficialBill,
  UsageReport,
} from '@/types';

const notificationTable = `CREATE TABLE IF NOT EXISTS notification_outbox (
  target_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  PRIMARY KEY(target_id,id)
)`;

export interface DailyUsage {
  report: UsageReport;
  finalized: boolean;
}
export interface StoredBill {
  bill: OfficialBill;
  fetchedAt: string;
  localTotal: number | null;
  localComplete: boolean;
  localSnapshot: unknown;
}
export interface HistoricalUsageSnapshot {
  id: number;
  report: UsageReport;
  corrected: boolean;
}
export interface OfficialAmountEvidence {
  through: string;
  amount: number;
  fetchedAt: string;
  version: number;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS cycles (id TEXT PRIMARY KEY, start TEXT NOT NULL, end TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_snapshots (id INTEGER PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES cycles(id), date TEXT NOT NULL, observed_at TEXT NOT NULL, complete INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshot_dates ON usage_snapshots(cycle_id,date,observed_at);
      CREATE TABLE IF NOT EXISTS daily_usage (cycle_id TEXT NOT NULL REFERENCES cycles(id), date TEXT NOT NULL, finalized INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(cycle_id,date));
      CREATE TABLE IF NOT EXISTS reconciliations (cycle_id TEXT NOT NULL REFERENCES cycles(id), through_date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, fetched_at TEXT NOT NULL, local_total REAL, local_complete INTEGER NOT NULL, local_snapshot TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(cycle_id,through_date));
      CREATE TABLE IF NOT EXISTS reconciliation_versions (id INTEGER PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES cycles(id), through_date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, fetched_at TEXT NOT NULL, local_total REAL, local_complete INTEGER NOT NULL, local_snapshot TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reconciliation_version_dates ON reconciliation_versions(cycle_id,through_date,id);
      CREATE TABLE IF NOT EXISTS job_errors (task TEXT PRIMARY KEY, message TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, attempted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collector_lease (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_points (cycle_id TEXT NOT NULL REFERENCES cycles(id), slot TEXT NOT NULL, observed_at TEXT NOT NULL, quality INTEGER NOT NULL, origin TEXT NOT NULL, recorded_at TEXT NOT NULL, payload TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(cycle_id,slot));
    `);
    if (
      !(this.db.prepare('PRAGMA table_info(billing_points)').all() as { name: string }[]).some(
        (column) => column.name === 'evidence',
      )
    )
      this.db.exec("ALTER TABLE billing_points ADD COLUMN evidence TEXT NOT NULL DEFAULT '{}'");
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(notification_outbox)').all() as {
        name: string;
      }[];
      if (columns.length && !columns.some((column) => column.name === 'target_id')) {
        this.db.exec(`
          ALTER TABLE notification_outbox RENAME TO legacy_notification_outbox;
          ${notificationTable};
          INSERT INTO notification_outbox(target_id,target_label,id,payload,attempts,next_attempt_at,created_at,sent_at,last_error)
            SELECT 'feishu','飞书通知',id,payload,attempts,next_attempt_at,created_at,sent_at,last_error FROM legacy_notification_outbox;
          DROP TABLE legacy_notification_outbox;
        `);
      } else {
        this.db.exec(notificationTable);
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS pending_notifications ON notification_outbox(target_id,next_attempt_at,created_at,id) WHERE sent_at IS NULL;
        COMMIT;
      `);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  acquireLease(owner: string, now = Date.now(), ttl = 300_000): boolean {
    return (
      this.db
        .prepare(
          "INSERT INTO collector_lease VALUES ('collector',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE collector_lease.expires_at<=? OR collector_lease.owner=excluded.owner",
        )
        .run(owner, now + ttl, now).changes === 1
    );
  }
  renewLease(owner: string) {
    this.db
      .prepare("UPDATE collector_lease SET expires_at=? WHERE name='collector' AND owner=?")
      .run(Date.now() + 300_000, owner);
  }
  releaseLease(owner: string) {
    this.db.prepare("DELETE FROM collector_lease WHERE name='collector' AND owner=?").run(owner);
  }
  collectionActive(): boolean {
    return !!this.db
      .prepare("SELECT name FROM collector_lease WHERE name='collector' AND expires_at>?")
      .get(Date.now());
  }
  set(key: string, value: string) {
    this.db
      .prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }
  get(key: string): string | null {
    return (
      (
        this.db.prepare('SELECT value FROM state WHERE key=?').get(key) as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  saveCycle(cycle: BillingCycle) {
    this.db
      .prepare(
        'INSERT INTO cycles VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET start=excluded.start,end=excluded.end,payload=excluded.payload',
      )
      .run(cycle.id, cycle.start, cycle.end, JSON.stringify(cycle));
    this.set('activeCycle', cycle.id);
  }
  cycles(): BillingCycle[] {
    return (
      this.db.prepare('SELECT payload FROM cycles ORDER BY start').all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload));
  }
  activeCycle(): BillingCycle | null {
    const row = this.db
      .prepare('SELECT payload FROM cycles WHERE id=?')
      .get(this.get('activeCycle') ?? '') as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  saveUsage(cycle: BillingCycle, report: UsageReport, finalized: boolean) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const payload = JSON.stringify(report);
      const inserted = this.db
        .prepare(
          'INSERT INTO usage_snapshots(cycle_id,date,observed_at,complete,payload) VALUES (?,?,?,?,?)',
        )
        .run(cycle.id, report.date, report.observedAt, report.complete ? 1 : 0, payload);
      // Never replace a complete daily record with a transient incomplete collection.
      const previous = this.usage(cycle.id).get(report.date);
      if (!previous?.report.complete || report.complete)
        this.db
          .prepare(
            'INSERT INTO daily_usage VALUES (?,?,?,?) ON CONFLICT(cycle_id,date) DO UPDATE SET finalized=excluded.finalized,payload=excluded.payload',
          )
          .run(cycle.id, report.date, finalized && report.complete ? 1 : 0, payload);
      this.db.exec('COMMIT');
      return Number(inserted.lastInsertRowid);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  usage(cycleId: string): Map<string, DailyUsage> {
    return new Map(
      (
        this.db
          .prepare('SELECT date,payload,finalized FROM daily_usage WHERE cycle_id=? ORDER BY date')
          .all(cycleId) as { date: string; payload: string; finalized: number }[]
      ).map((r) => [r.date, { report: JSON.parse(r.payload), finalized: !!r.finalized }]),
    );
  }
  /** Read only the evidence needed by the one-time timeline recovery, excluding large raw analytics. */
  usageSnapshotEvidence(
    cycleId: string,
    bounds?: { start: string; end: string; observedThrough: string },
  ): HistoricalUsageSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT id,date,observed_at,complete,json_extract(payload,'$.meters') AS meters,json_extract(payload,'$.source') AS source,json_extract(payload,'$.raw.corrections') AS corrections FROM usage_snapshots WHERE cycle_id=?${bounds ? ' AND date>=? AND date<? AND julianday(observed_at)<=julianday(?)' : ''} ORDER BY id`,
      )
      .all(cycleId, ...(bounds ? [bounds.start, bounds.end, bounds.observedThrough] : [])) as {
      id: number;
      date: string;
      observed_at: string;
      complete: number;
      meters: string;
      source: string | null;
      corrections: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      corrected: row.corrections !== null,
      report: {
        date: row.date,
        observedAt: row.observed_at,
        complete: !!row.complete,
        meters: JSON.parse(row.meters),
        ...(row.source ? { source: row.source } : {}),
      },
    }));
  }
  officialAmountEvidence(cycleId: string): OfficialAmountEvidence[] {
    const rows = this.db
      .prepare(
        'SELECT through_date,amount,fetched_at,id AS version FROM reconciliation_versions WHERE cycle_id=? UNION ALL SELECT through_date,amount,fetched_at,0 AS version FROM reconciliations WHERE cycle_id=? ORDER BY fetched_at,version',
      )
      .all(cycleId, cycleId) as {
      through_date: string;
      amount: number;
      fetched_at: string;
      version: number;
    }[];
    return rows.map((row) => ({
      through: row.through_date,
      amount: row.amount,
      fetchedAt: row.fetched_at,
      version: row.version,
    }));
  }
  currentUsageEvidence(cycleId: string, through: string): Record<string, number> {
    const rows = this.db
      .prepare(
        'SELECT date,MAX(id) AS id FROM usage_snapshots WHERE cycle_id=? AND date<=? AND complete=1 GROUP BY date',
      )
      .all(cycleId, through) as { date: string; id: number }[];
    return Object.fromEntries(rows.map((row) => [row.date, row.id]));
  }
  latestOfficialVersion(cycleId: string, through: string): number | null {
    return (
      this.db
        .prepare(
          'SELECT MAX(id) AS id FROM reconciliation_versions WHERE cycle_id=? AND through_date=?',
        )
        .get(cycleId, through) as { id: number | null }
    ).id;
  }
  saveBillingPoint(
    cycleId: string,
    point: BillingPoint,
    origin: 'collection' | 'recovery',
    recordedAt: string,
    evidence: unknown = {},
  ) {
    if (point.observedAt === null) return;
    const quality = (point.currentTotal !== null ? 2 : 0) + (point.localTotal !== null ? 1 : 0);
    this.db
      .prepare(
        `INSERT INTO billing_points(cycle_id,slot,observed_at,quality,origin,recorded_at,payload,evidence) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(cycle_id,slot) DO UPDATE SET observed_at=excluded.observed_at,quality=excluded.quality,origin=excluded.origin,recorded_at=excluded.recorded_at,payload=excluded.payload,evidence=excluded.evidence
      WHERE (billing_points.origin!='collection' OR excluded.origin='collection') AND
        (excluded.quality>billing_points.quality OR (excluded.quality=billing_points.quality AND excluded.observed_at>=billing_points.observed_at))`,
      )
      .run(
        cycleId,
        point.timestamp,
        point.observedAt,
        quality,
        origin,
        recordedAt,
        JSON.stringify(point),
        JSON.stringify(evidence),
      );
  }
  billingPoints(cycleId: string): BillingPoint[] {
    return (
      this.db
        .prepare('SELECT payload FROM billing_points WHERE cycle_id=? ORDER BY slot')
        .all(cycleId) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload));
  }
  lastCollectedAt(): string | null {
    return (
      this.db
        .prepare(
          "SELECT MAX(observed_at) AS observed_at FROM billing_points WHERE origin='collection'",
        )
        .get() as { observed_at: string | null }
    ).observed_at;
  }
  /** Keep the first snapshot immutable even when a slot is collected again. */
  enqueueNotification(
    notification: DeliveryNotification,
    targetId = 'feishu',
    targetLabel = '飞书通知',
  ): void {
    const createdAt =
      notification.kind === 'collection_failure'
        ? notification.attemptedAt
        : notification.kind === 'budget_exceeded'
          ? notification.observedAt
          : (notification.point.observedAt ?? notification.point.timestamp);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO notification_outbox(target_id,target_label,id,payload,next_attempt_at,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        targetId,
        targetLabel,
        notification.id,
        JSON.stringify(notification),
        createdAt,
        createdAt,
      );
  }
  pendingNotifications(
    nowIso: string,
    limit?: number,
  ): { notification: Notification; attempts: number }[];
  pendingNotifications(
    nowIso: string,
    limit: number,
    targetId: string,
  ): { notification: DeliveryNotification; attempts: number }[];
  pendingNotifications(
    nowIso: string,
    limit = 10,
    targetId = 'feishu',
  ): { notification: DeliveryNotification; attempts: number }[] {
    return (
      this.db
        .prepare(
          'SELECT payload,attempts FROM notification_outbox WHERE target_id=? AND sent_at IS NULL AND next_attempt_at<=? ORDER BY created_at,id LIMIT ?',
        )
        .all(targetId, nowIso, limit) as { payload: string; attempts: number }[]
    ).map((row) => ({ notification: JSON.parse(row.payload), attempts: row.attempts }));
  }
  markNotificationSent(id: string, sentAtIso: string, targetId = 'feishu'): void {
    this.db
      .prepare(
        'UPDATE notification_outbox SET sent_at=?,last_error=NULL WHERE target_id=? AND id=? AND sent_at IS NULL',
      )
      .run(sentAtIso, targetId, id);
  }
  retryNotification(
    id: string,
    nextAttemptAtIso: string,
    error: string,
    targetId = 'feishu',
  ): void {
    this.db
      .prepare(
        'UPDATE notification_outbox SET attempts=attempts+1,next_attempt_at=?,last_error=? WHERE target_id=? AND id=? AND sent_at IS NULL',
      )
      .run(nextAttemptAtIso, error, targetId, id);
  }
  notificationErrors(): string[] {
    return (
      this.db
        .prepare(
          'SELECT target_label,created_at,attempts,last_error FROM notification_outbox WHERE sent_at IS NULL AND attempts>0 AND last_error IS NOT NULL ORDER BY created_at,target_id,id',
        )
        .all() as {
        target_label: string;
        created_at: string;
        attempts: number;
        last_error: string;
      }[]
    ).map(
      (row) =>
        `${row.target_label}（${row.created_at}，已失败 ${row.attempts} 次，等待重试）：${row.last_error}`,
    );
  }
  saveBill(
    cycle: BillingCycle,
    bill: OfficialBill,
    fetchedAt: string,
    localTotal: number | null,
    localComplete: boolean,
    localSnapshot: unknown,
  ) {
    const previous = this.bills(cycle.id).get(bill.through);
    const snapshot = JSON.stringify(localSnapshot),
      payload = JSON.stringify(bill);
    if (
      previous &&
      JSON.stringify(previous.bill) === payload &&
      previous.localTotal === localTotal &&
      previous.localComplete === localComplete &&
      JSON.stringify(previous.localSnapshot) === snapshot
    )
      return;
    const insertVersion = this.db.prepare(
      'INSERT INTO reconciliation_versions(cycle_id,through_date,amount,currency,fetched_at,local_total,local_complete,local_snapshot,payload) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Preserve records from databases created before immutable versions were introduced.
      if (
        previous &&
        !this.db
          .prepare(
            'SELECT id FROM reconciliation_versions WHERE cycle_id=? AND through_date=? LIMIT 1',
          )
          .get(cycle.id, bill.through)
      )
        insertVersion.run(
          cycle.id,
          bill.through,
          previous.bill.amount,
          previous.bill.currency,
          previous.fetchedAt,
          previous.localTotal,
          previous.localComplete ? 1 : 0,
          JSON.stringify(previous.localSnapshot),
          JSON.stringify(previous.bill),
        );
      insertVersion.run(
        cycle.id,
        bill.through,
        bill.amount,
        bill.currency,
        fetchedAt,
        localTotal,
        localComplete ? 1 : 0,
        snapshot,
        payload,
      );
      this.db
        .prepare(
          'INSERT INTO reconciliations VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(cycle_id,through_date) DO UPDATE SET amount=excluded.amount,currency=excluded.currency,fetched_at=excluded.fetched_at,local_total=excluded.local_total,local_complete=excluded.local_complete,local_snapshot=excluded.local_snapshot,payload=excluded.payload',
        )
        .run(
          cycle.id,
          bill.through,
          bill.amount,
          bill.currency,
          fetchedAt,
          localTotal,
          localComplete ? 1 : 0,
          snapshot,
          payload,
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  bills(cycleId: string): Map<string, StoredBill> {
    return new Map(
      (
        this.db
          .prepare(
            'SELECT through_date,payload,fetched_at,local_total,local_complete,local_snapshot FROM reconciliations WHERE cycle_id=? ORDER BY through_date',
          )
          .all(cycleId) as {
          through_date: string;
          payload: string;
          fetched_at: string;
          local_total: number | null;
          local_complete: number;
          local_snapshot: string;
        }[]
      ).map((r) => [
        r.through_date,
        {
          bill: JSON.parse(r.payload),
          fetchedAt: r.fetched_at,
          localTotal: r.local_total,
          localComplete: !!r.local_complete,
          localSnapshot: JSON.parse(r.local_snapshot),
        },
      ]),
    );
  }
  fail(task: string, message: string, now: string) {
    this.db
      .prepare(
        'INSERT INTO job_errors(task,message,attempted_at) VALUES (?,?,?) ON CONFLICT(task) DO UPDATE SET message=excluded.message,attempts=attempts+1,attempted_at=excluded.attempted_at',
      )
      .run(task, message, now);
  }
  succeed(task: string) {
    this.db.prepare('DELETE FROM job_errors WHERE task=?').run(task);
  }
  errors(): string[] {
    return (
      this.db.prepare('SELECT message FROM job_errors ORDER BY task').all() as { message: string }[]
    ).map((r) => r.message);
  }
}
