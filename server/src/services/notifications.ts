import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '@/repositories/billing-store';
import { nextSlot } from '@/utils/dates';
import type { Notification, NotificationExtension } from '@/types';

export class NotificationDispatcher {
  private shutdown = new AbortController();

  constructor(
    private readonly store: Store,
    private readonly extensionSource: NotificationExtension[] | (() => NotificationExtension[]),
    private readonly clock: () => Date,
  ) {}

  private get extensions(): NotificationExtension[] {
    return typeof this.extensionSource === 'function'
      ? this.extensionSource()
      : this.extensionSource;
  }

  start(): void {
    if (this.shutdown.signal.aborted) this.shutdown = new AbortController();
  }

  stop(): void {
    this.shutdown.abort();
  }

  enqueue(notification: Notification): void {
    for (const extension of this.extensions) {
      const delivery = extension.prepare(notification);
      if (delivery) this.store.enqueueNotification(delivery, extension.id, extension.label);
    }
  }

  /** Called under the collection lease. A failed target never blocks another target's queue. */
  async deliver(): Promise<void> {
    const signal = this.shutdown.signal;
    await Promise.all(this.extensions.map((extension) => this.deliverTarget(extension, signal)));
  }

  private async pause(signal: AbortSignal): Promise<void> {
    try {
      await delay(1000, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  private async deliverTarget(
    extension: NotificationExtension,
    signal: AbortSignal,
  ): Promise<void> {
    const pending = this.store.pendingNotifications(this.clock().toISOString(), 10, extension.id);
    for (const [index, { notification }] of pending.entries()) {
      if (index > 0) await this.pause(signal);
      while (!signal.aborted) {
        // Re-read settings between attempts so disabling a target stops pending retries.
        const active = this.extensions.find((target) => target.id === extension.id);
        if (!active) return;
        extension = active;
        try {
          const previousBilling =
            notification.kind === undefined || notification.kind === 'billing'
              ? this.store.lastSentBillingNotification(extension.id)
              : null;
          await extension.send(notification, previousBilling);
        } catch (error) {
          this.store.retryNotification(
            notification.id,
            extension.retry === 'until_success'
              ? this.clock().toISOString()
              : nextSlot(this.clock()).toISOString(),
            error instanceof Error ? error.message : String(error),
            extension.id,
          );
          if (extension.retry !== 'until_success') return;
          // Retry here, without waiting for another collection or changing the first snapshot.
          await this.pause(signal);
          continue;
        }
        this.store.markNotificationSent(notification.id, this.clock().toISOString(), extension.id);
        break;
      }
      if (signal.aborted) return;
    }
  }
}
