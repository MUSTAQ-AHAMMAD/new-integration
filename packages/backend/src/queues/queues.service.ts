import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { QUEUE_NAMES } from './queues.module';
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
    return this.orderSyncQueue.add('sync', data, {
      delay,
      jobId: `order-${data.odooOrderId}-${data.branchCode}`,
    });
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
