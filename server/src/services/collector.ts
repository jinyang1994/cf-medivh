import {
  addDays,
  cycleContains,
  datesBetween,
  nextSlot,
  slotKey,
  utcDate,
  validDate,
} from '@/utils/dates';
import { calculate, validateUsage } from '@/services/calculation';
import { Store } from '@/repositories/billing-store';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BillingCycle, CloudflareProvider, NotificationSender, UsageReport } from '@/types';
import { financialPoint, isRealtimeObservation, recoverBillingTimeline } from '@/services/timeline';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export class Collector {
  running = false;
  nextRun: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly leaseOwner = randomUUID();
  constructor(
    readonly store: Store,
    readonly provider: CloudflareProvider,
    readonly clock: () => Date = () => new Date(),
    private readonly sendNotification?: NotificationSender,
  ) {}
  async start() {
    this.stopped = false;
    try {
      await this.tick();
    } finally {
      this.schedule();
    }
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRun = null;
  }
  private schedule() {
    if (this.stopped) return;
    const now = this.clock();
    const next = nextSlot(now);
    this.nextRun = next.toISOString();
    this.timer = setTimeout(
      () => {
        void this.tick()
          .catch((error) => {
            console.error('Collector tick failed:', message(error));
          })
          .finally(() => this.schedule());
      },
      Math.max(1, next.getTime() - now.getTime()),
    );
    this.timer.unref();
  }
  /** A persisted UTC slot prevents repeated collections after a same-slot process restart. */
  async tick(force = false): Promise<boolean> {
    const now = this.clock();
    const today = utcDate(now);
    const slot = slotKey(now);
    if (this.running) return false;
    if (!this.store.acquireLease(this.leaseOwner)) return false;
    const heartbeat = setInterval(() => {
      try {
        this.store.renewLease(this.leaseOwner);
      } catch (error) {
        console.error('Collector lease renewal failed:', message(error));
      }
    }, 30_000);
    heartbeat.unref();
    this.running = true;
    try {
      recoverBillingTimeline(this.store, now);
      if (!force && this.store.get('lastSlot') === slot) {
        await this.deliverNotifications();
        return false;
      }
      this.store.set('lastAttempt', now.toISOString());
      const realtimeFailures: string[] = [];
      let cycle: BillingCycle | null = null;
      try {
        cycle = await this.provider.getBillingCycle(now);
        if (
          !validDate(cycle.start) ||
          !validDate(cycle.end) ||
          cycle.end <= cycle.start ||
          !cycle.id ||
          !cycle.currency
        )
          throw new Error('Invalid billing cycle from provider');
        if (!cycleContains(cycle, today))
          throw new Error(
            'Provider returned a billing cycle that does not contain the current date',
          );
        if (cycle.baseFee !== undefined && (!Number.isFinite(cycle.baseFee) || cycle.baseFee < 0))
          throw new Error('Invalid cycle base fee');
        this.store.saveCycle(cycle);
        this.store.succeed('cycle');
      } catch (error) {
        const cached = this.store.activeCycle();
        if (cached && cycleContains(cached, today)) {
          cycle = cached;
          this.store.succeed('cycle');
        } else {
          cycle = null;
          const reason = `账单周期：${message(error)}`;
          realtimeFailures.push(reason);
          this.store.fail('cycle', reason, now.toISOString());
        }
      }
      const realtime =
        cycle && cycleContains(cycle, today)
          ? await this.fetchUsage(cycle, today, false, now, (reason) => {
              realtimeFailures.push(reason);
            })
          : null;
      // Stored prior cycles remain eligible until their outstanding daily tasks succeed.
      for (const storedCycle of this.store.cycles().reverse()) await this.recover(storedCycle, now);
      if (
        cycle &&
        realtime &&
        isRealtimeObservation(realtime.report) &&
        Date.parse(realtime.report.observedAt) <= this.clock().getTime()
      ) {
        const yesterday = addDays(realtime.report.date, -1);
        const official = this.store.bills(cycle.id).get(yesterday);
        const point = financialPoint(
          cycle,
          this.store.usage(cycle.id),
          official?.bill.amount ?? null,
          realtime.report,
        );
        this.store.saveBillingPoint(cycle.id, point, 'collection', this.clock().toISOString(), {
          cycle,
          observationSnapshotId: realtime.snapshotId,
          usageSnapshotIds: this.store.currentUsageEvidence(cycle.id, realtime.report.date),
          official: official
            ? {
                through: yesterday,
                amount: official.bill.amount,
                fetchedAt: official.fetchedAt,
                versionId: this.store.latestOfficialVersion(cycle.id, yesterday),
              }
            : null,
        });
        if (this.sendNotification)
          this.store.enqueueNotification({
            id: `usage:${realtime.snapshotId}`,
            cycle,
            point,
            warnings: [...new Set([...(realtime.report.warnings ?? []), ...this.store.errors()])],
          });
      } else {
        if (cycle && realtime) {
          const reason = `${today} 用量：本轮未取得当前日期的有效实时采样`;
          realtimeFailures.push(reason);
          this.store.fail(`usage:${cycle.id}:${today}`, reason, now.toISOString());
        }
        if (this.sendNotification)
          this.store.enqueueNotification({
            kind: 'collection_failure',
            id: `collection-failure:${slot}`,
            attemptedAt: now.toISOString(),
            slot,
            cycle,
            errors: realtimeFailures.length ? realtimeFailures : ['本轮未取得完整的当天用量'],
            lastSuccessfulAt: this.store.lastCollectedAt(),
          });
      }
      this.store.set('lastSlot', slot);
      if (this.store.errors().length === 0) this.store.set('lastSuccess', now.toISOString());
      await this.deliverNotifications();
      return true;
    } finally {
      clearInterval(heartbeat);
      this.store.releaseLease(this.leaseOwner);
      this.running = false;
    }
  }
  /** Delivery is serialized under the collection lease; failures never alter billing job state. */
  private async deliverNotifications() {
    if (!this.sendNotification) return;
    const pending = this.store.pendingNotifications(this.clock().toISOString());
    for (const [index, { notification }] of pending.entries()) {
      // Backlogs are drained conservatively, at most one request per second.
      if (index > 0) await delay(1000);
      try {
        await this.sendNotification(notification);
      } catch (error) {
        this.store.retryNotification(
          notification.id,
          nextSlot(this.clock()).toISOString(),
          message(error),
        );
        break;
      }
      this.store.markNotificationSent(notification.id, this.clock().toISOString());
    }
  }
  private async fetchUsage(
    cycle: BillingCycle,
    date: string,
    finalized: boolean,
    now: Date,
    onFailure?: (reason: string) => void,
  ): Promise<{ report: UsageReport; snapshotId: number } | null> {
    const task = `usage:${cycle.id}:${date}`;
    try {
      const report = await this.provider.getUsage(cycle, date);
      validateUsage(report, cycle, date);
      const snapshotId = this.store.saveUsage(cycle, report, finalized);
      if (!report.complete) throw new Error(report.warnings?.join('；') || '服务用量尚未完整');
      this.store.succeed(task);
      this.store.set('lastUsageSuccess', now.toISOString());
      return { report, snapshotId };
    } catch (error) {
      const reason = `${date} 用量：${message(error)}`;
      this.store.fail(task, reason, now.toISOString());
      onFailure?.(reason);
      return null;
    }
  }
  private async recover(cycle: BillingCycle, now: Date) {
    const today = utcDate(now);
    const yesterday = addDays(today, -1);
    const cycleLastDay = addDays(cycle.end, -1);
    const through = yesterday < cycleLastDay ? yesterday : cycleLastDay;
    const dates = datesBetween(cycle.start, through);
    const usage = this.store.usage(cycle.id);
    const bills = this.store.bills(cycle.id);
    const recentCutoff = addDays(today, -3);
    const refreshed = new Set<string>();
    // Persist the newest official total first, independently of analytics backfill failures.
    for (const date of [...dates].reverse()) {
      const task = `official:${cycle.id}:${date}`;
      const previous = bills.get(date);
      if (previous && date < recentCutoff) continue;
      try {
        const bill = await this.provider.getOfficialBill(
          cycle,
          date,
          [...usage.values()].map((day) => day.report),
        );
        if (!bill) throw new Error('官方汇总尚未就绪，将在下次采集重试');
        if (
          bill.through !== date ||
          bill.currency !== cycle.currency ||
          !Number.isFinite(bill.amount) ||
          bill.amount < 0
        )
          throw new Error('官方汇总的日期、金额或币种无效');
        // The successful official response is saved immediately. The local snapshot is paired
        // after the final analytics refresh below, or on a later successful retry.
        const unchanged =
          previous?.bill.amount === bill.amount && previous.bill.currency === bill.currency;
        this.store.saveBill(
          cycle,
          bill,
          now.toISOString(),
          unchanged ? previous.localTotal : null,
          unchanged ? previous.localComplete : false,
          unchanged ? previous.localSnapshot : { pending: true },
        );
        refreshed.add(date);
        this.store.succeed(task);
      } catch (error) {
        this.store.fail(task, `${date} 官方账单：${message(error)}`, now.toISOString());
      }
    }
    // Re-read yesterday while official aggregation is pending: analytics may still ingest
    // events around UTC midnight. Freeze only once both sides have succeeded.
    const failedRefreshes: string[] = [];
    for (const date of dates)
      if (!usage.get(date)?.finalized || !bills.get(date)?.localComplete || refreshed.has(date)) {
        if (!(await this.fetchUsage(cycle, date, true, now))) failedRefreshes.push(date);
      }
    const freshUsage = this.store.usage(cycle.id);
    for (const [date, official] of this.store.bills(cycle.id)) {
      if (official.localComplete && !refreshed.has(date)) continue;
      if (failedRefreshes.some((failedDate) => failedDate <= date)) continue;
      const local = calculate(cycle, freshUsage, date, date, true);
      if (local.complete)
        this.store.saveBill(cycle, official.bill, official.fetchedAt, local.total, true, local);
    }
  }
}
