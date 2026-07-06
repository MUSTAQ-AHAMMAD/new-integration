import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { QUEUE_NAMES } from './queues.constants';
import { NotificationJobData } from './processors/notifications.processor';

export interface OrderSyncJobData {
  orderSyncQueueId: string;
  odooOrderId: string;
  branchCode: string;
  syncJobId?: string;
  isRetry?: boolean;
}

@Injectable()
export class QueuesService {
  constructor(
    @InjectQueue(QUEUE_NAMES.ORDER_SYNC) private readonly orderSyncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.INVENTORY_SYNC)
    private readonly inventorySyncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.RETRY) private readonly retryQueue: Queue,
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS)
    private readonly notificationsQueue: Queue,
  ) {}

  async enqueueOrderSync(data: OrderSyncJobData, delay = 0) {
    const jobId = `order-${data.odooOrderId}-${data.branchCode}`;
    await this.clearFinishedJob(jobId);
    return this.orderSyncQueue.add('sync', data, { delay, jobId });
  }

  async enqueueOrderSyncBulk(items: OrderSyncJobData[]) {
    if (items.length === 0) return [];
    await Promise.all(
      items.map((d) =>
        this.clearFinishedJob(`order-${d.odooOrderId}-${d.branchCode}`),
      ),
    );
    return this.orderSyncQueue.addBulk(
      items.map((data) => ({
        name: 'sync',
        data,
        opts: { jobId: `order-${data.odooOrderId}-${data.branchCode}` },
      })),
    );
  }

  /**
   * Bull de-duplicates by jobId: adding a job whose id still exists in the
   * queue (including retained completed/failed jobs — we keep up to
   * removeOnFail=2000) is silently dropped. That means a re-enqueue of a
   * previously-failed order never runs. Remove the retained *finished* job
   * first so retries actually re-process. A still-waiting/active job is left
   * alone so we never duplicate genuinely in-flight work.
   */
  private async clearFinishedJob(jobId: string): Promise<void> {
    try {
      const existing = await this.orderSyncQueue.getJob(jobId);
      if (!existing) return;
      const [completed, failed] = await Promise.all([
        existing.isCompleted(),
        existing.isFailed(),
      ]);
      if (completed || failed) {
        await existing.remove();
      }
    } catch {
      // best-effort: a missing job or a benign race must not block enqueue
    }
  }

  async enqueueRetry(data: OrderSyncJobData, delayMs: number) {
    return this.retryQueue.add('retry', data, { delay: delayMs });
  }

  async enqueueInventorySync(data: { trackerId: string }, delay = 0) {
    return this.inventorySyncQueue.add('sync', data, { delay });
  }

  async enqueueNotification(data: NotificationJobData, delay = 0) {
    return this.notificationsQueue.add('send', data, { delay });
  }

  async getQueueStats() {
    const [
      orderWaiting,
      orderActive,
      orderFailed,
      orderCompleted,
      inventoryWaiting,
      inventoryActive,
      inventoryFailed,
      inventoryCompleted,
      retryWaiting,
      retryActive,
      retryFailed,
      retryCompleted,
      notificationsWaiting,
      notificationsActive,
      notificationsFailed,
      notificationsCompleted,
    ] = await Promise.all([
      this.orderSyncQueue.getWaitingCount(),
      this.orderSyncQueue.getActiveCount(),
      this.orderSyncQueue.getFailedCount(),
      this.orderSyncQueue.getCompletedCount(),
      this.inventorySyncQueue.getWaitingCount(),
      this.inventorySyncQueue.getActiveCount(),
      this.inventorySyncQueue.getFailedCount(),
      this.inventorySyncQueue.getCompletedCount(),
      this.retryQueue.getWaitingCount(),
      this.retryQueue.getActiveCount(),
      this.retryQueue.getFailedCount(),
      this.retryQueue.getCompletedCount(),
      this.notificationsQueue.getWaitingCount(),
      this.notificationsQueue.getActiveCount(),
      this.notificationsQueue.getFailedCount(),
      this.notificationsQueue.getCompletedCount(),
    ]);

    return {
      orderSync: {
        waiting: orderWaiting,
        active: orderActive,
        failed: orderFailed,
        completed: orderCompleted,
      },
      inventorySync: {
        waiting: inventoryWaiting,
        active: inventoryActive,
        failed: inventoryFailed,
        completed: inventoryCompleted,
      },
      retry: {
        waiting: retryWaiting,
        active: retryActive,
        failed: retryFailed,
        completed: retryCompleted,
      },
      notifications: {
        waiting: notificationsWaiting,
        active: notificationsActive,
        failed: notificationsFailed,
        completed: notificationsCompleted,
      },
    };
  }
}
