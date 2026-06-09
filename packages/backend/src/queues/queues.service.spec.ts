// Mock the queues module before NestJS decorators are evaluated
jest.mock('./queues.module', () => ({
  QUEUE_NAMES: {
    ORDER_SYNC: 'order-sync',
    INVENTORY_SYNC: 'inventory-sync',
    RETRY: 'retry',
    NOTIFICATIONS: 'notifications',
  },
  QueuesModule: class QueuesModule {},
}));

import { Queue } from 'bull';
import { QueuesService } from './queues.service';

function makeQueue(): jest.Mocked<Queue> {
  return {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getWaitingCount: jest.fn().mockResolvedValue(0),
    getActiveCount: jest.fn().mockResolvedValue(0),
    getFailedCount: jest.fn().mockResolvedValue(0),
    getCompletedCount: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<Queue>;
}

describe('QueuesService', () => {
  let service: QueuesService;
  let orderSyncQueue: jest.Mocked<Queue>;
  let inventorySyncQueue: jest.Mocked<Queue>;
  let retryQueue: jest.Mocked<Queue>;
  let notificationsQueue: jest.Mocked<Queue>;

  beforeEach(() => {
    orderSyncQueue = makeQueue();
    inventorySyncQueue = makeQueue();
    retryQueue = makeQueue();
    notificationsQueue = makeQueue();

    service = new QueuesService(
      orderSyncQueue,
      inventorySyncQueue,
      retryQueue,
      notificationsQueue,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── enqueueOrderSync ────────────────────────────────────────

  describe('enqueueOrderSync', () => {
    it('adds a sync job to the order-sync queue', async () => {
      const data = {
        orderSyncQueueId: 'q-1',
        odooOrderId: 'ORD-001',
        branchCode: 'DXB',
      };

      await service.enqueueOrderSync(data);

      expect(orderSyncQueue.add).toHaveBeenCalledWith(
        'sync',
        data,
        expect.objectContaining({ jobId: 'order-ORD-001-DXB' }),
      );
    });

    it('forwards the delay option', async () => {
      const data = {
        orderSyncQueueId: 'q-1',
        odooOrderId: 'ORD-002',
        branchCode: 'AUH',
      };

      await service.enqueueOrderSync(data, 5000);

      expect(orderSyncQueue.add).toHaveBeenCalledWith(
        'sync',
        data,
        expect.objectContaining({ delay: 5000 }),
      );
    });

    it('uses zero delay by default', async () => {
      await service.enqueueOrderSync({
        orderSyncQueueId: 'q-1',
        odooOrderId: 'ORD-003',
        branchCode: 'SHJ',
      });

      const callOptions = (orderSyncQueue.add as jest.Mock).mock.calls[0][2] as {
        delay: number;
      };
      expect(callOptions.delay).toBe(0);
    });
  });

  // ── enqueueRetry ────────────────────────────────────────────

  describe('enqueueRetry', () => {
    it('adds a retry job to the retry queue with delay', async () => {
      const data = {
        orderSyncQueueId: 'q-1',
        odooOrderId: 'ORD-001',
        branchCode: 'DXB',
        isRetry: true,
      };

      await service.enqueueRetry(data, 30_000);

      expect(retryQueue.add).toHaveBeenCalledWith('retry', data, {
        delay: 30_000,
      });
    });

    it('does NOT use the order-sync queue for retries', async () => {
      await service.enqueueRetry(
        { orderSyncQueueId: 'q-1', odooOrderId: 'ORD-X', branchCode: 'DXB' },
        1000,
      );

      expect(orderSyncQueue.add).not.toHaveBeenCalled();
    });
  });

  // ── enqueueInventorySync ────────────────────────────────────

  describe('enqueueInventorySync', () => {
    it('adds an inventory sync job', async () => {
      await service.enqueueInventorySync({ trackerId: 'tracker-1' });

      expect(inventorySyncQueue.add).toHaveBeenCalledWith(
        'sync',
        { trackerId: 'tracker-1' },
        expect.objectContaining({ delay: 0 }),
      );
    });
  });

  // ── enqueueNotification ─────────────────────────────────────

  describe('enqueueNotification', () => {
    it('adds a notification job to the notifications queue', async () => {
      const data = {
        type: 'ERROR_ALERT' as const,
        recipients: ['admin@example.com'],
        subject: 'Sync failed',
        body: 'Order sync failed',
      };

      await service.enqueueNotification(data);

      expect(notificationsQueue.add).toHaveBeenCalledWith(
        'send',
        data,
        expect.objectContaining({ delay: 0 }),
      );
    });
  });

  // ── getQueueStats ───────────────────────────────────────────

  describe('getQueueStats', () => {
    beforeEach(() => {
      orderSyncQueue.getWaitingCount.mockResolvedValue(5);
      orderSyncQueue.getActiveCount.mockResolvedValue(2);
      orderSyncQueue.getFailedCount.mockResolvedValue(3);
      orderSyncQueue.getCompletedCount.mockResolvedValue(100);
      inventorySyncQueue.getWaitingCount.mockResolvedValue(1);
      retryQueue.getWaitingCount.mockResolvedValue(4);
      notificationsQueue.getWaitingCount.mockResolvedValue(0);
    });

    it('returns queue stats for all four queues', async () => {
      const stats = await service.getQueueStats();

      expect(stats.orderSync.waiting).toBe(5);
      expect(stats.orderSync.active).toBe(2);
      expect(stats.orderSync.failed).toBe(3);
      expect(stats.orderSync.completed).toBe(100);
      expect(stats.inventorySync.waiting).toBe(1);
      expect(stats.retry.waiting).toBe(4);
      expect(stats.notifications.waiting).toBe(0);
    });

    it('queries all queues in parallel (all count methods called once)', async () => {
      await service.getQueueStats();

      expect(orderSyncQueue.getWaitingCount).toHaveBeenCalledTimes(1);
      expect(orderSyncQueue.getActiveCount).toHaveBeenCalledTimes(1);
      expect(orderSyncQueue.getFailedCount).toHaveBeenCalledTimes(1);
      expect(orderSyncQueue.getCompletedCount).toHaveBeenCalledTimes(1);
      expect(inventorySyncQueue.getWaitingCount).toHaveBeenCalledTimes(1);
      expect(retryQueue.getWaitingCount).toHaveBeenCalledTimes(1);
      expect(notificationsQueue.getWaitingCount).toHaveBeenCalledTimes(1);
    });
  });
});
