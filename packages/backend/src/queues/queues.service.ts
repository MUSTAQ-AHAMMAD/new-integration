import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { QUEUE_NAMES } from './queues.module';

export interface OrderSyncJobData {
  orderSyncQueueId: string;
  odooOrderId: string;
  branchCode: string;
  isRetry?: boolean;
}

@Injectable()
export class QueuesService {
  constructor(
    @InjectQueue(QUEUE_NAMES.ORDER_SYNC) private readonly orderSyncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.INVENTORY_SYNC)
    private readonly inventorySyncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.RETRY) private readonly retryQueue: Queue,
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

  async getQueueStats() {
    const [
      orderWaiting,
      orderActive,
      orderFailed,
      orderCompleted,
      inventoryWaiting,
      retryWaiting,
    ] = await Promise.all([
      this.orderSyncQueue.getWaitingCount(),
      this.orderSyncQueue.getActiveCount(),
      this.orderSyncQueue.getFailedCount(),
      this.orderSyncQueue.getCompletedCount(),
      this.inventorySyncQueue.getWaitingCount(),
      this.retryQueue.getWaitingCount(),
    ]);

    return {
      orderSync: {
        waiting: orderWaiting,
        active: orderActive,
        failed: orderFailed,
        completed: orderCompleted,
      },
      inventorySync: { waiting: inventoryWaiting },
      retry: { waiting: retryWaiting },
    };
  }
}
