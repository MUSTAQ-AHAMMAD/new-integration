import { ConfigService } from '@nestjs/config';
import { FindOperator, Repository } from 'typeorm';
import { AlertSeverity, AlertType, SyncStatus } from '../database/enums';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { AlertsService } from '../alerts/alerts.service';
import { StalledOrdersService } from './stalled-orders.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeOrderSyncQueueRepo() {
  return {
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function makeFailedTransactionRepo() {
  return {
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({}),
  };
}

function makeAlerts() {
  return {
    createAlert: jest.fn().mockResolvedValue({}),
  };
}

function makeSyncControl() {
  return {
    isEnabled: jest.fn().mockResolvedValue(true),
    markRunning: jest.fn().mockResolvedValue(undefined),
    markStopped: jest.fn().mockResolvedValue(undefined),
  };
}

function makeConfig(thresholdHours?: number) {
  return {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'STALE_THRESHOLD_HOURS') return thresholdHours;
      return undefined;
    }),
  };
}

function makeStalledOrder(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'order-001',
    odooOrderId: 'ODO-001',
    odooOrderNumber: 'S00001',
    branchCode: 'BR001',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StalledOrdersService', () => {
  let service: StalledOrdersService;
  let orderSyncQueueRepo: ReturnType<typeof makeOrderSyncQueueRepo>;
  let failedTransactionRepo: ReturnType<typeof makeFailedTransactionRepo>;
  let alerts: ReturnType<typeof makeAlerts>;

  function build(config = makeConfig(), syncControl = makeSyncControl()) {
    return new StalledOrdersService(
      orderSyncQueueRepo as unknown as Repository<OrderSyncQueue>,
      failedTransactionRepo as unknown as Repository<FailedTransaction>,
      alerts as unknown as AlertsService,
      syncControl as never,
      config as unknown as ConfigService,
    );
  }

  beforeEach(() => {
    orderSyncQueueRepo = makeOrderSyncQueueRepo();
    failedTransactionRepo = makeFailedTransactionRepo();
    alerts = makeAlerts();
    service = build();
    jest.clearAllMocks();
  });

  describe('detectStalledOrders', () => {
    it('does nothing when there are no stalled orders', async () => {
      orderSyncQueueRepo.find.mockResolvedValueOnce([]);
      await service.detectStalledOrders();
      expect(alerts.createAlert).not.toHaveBeenCalled();
    });

    it('fires one alert per branch for stalled orders', async () => {
      orderSyncQueueRepo.find.mockResolvedValueOnce([
        makeStalledOrder({ branchCode: 'BR001' }),
        makeStalledOrder({
          id: 'order-002',
          branchCode: 'BR001',
          odooOrderNumber: 'S00002',
        }),
        makeStalledOrder({
          id: 'order-003',
          branchCode: 'BR002',
          odooOrderNumber: 'S00003',
        }),
      ]);
      await service.detectStalledOrders();

      expect(alerts.createAlert).toHaveBeenCalledTimes(2);

      const calls = alerts.createAlert.mock.calls.map(
        (c: [Record<string, unknown>]) => c[0],
      );
      const br001Call = calls.find(
        (c: Record<string, unknown>) => c['relatedEntityId'] === 'BR001',
      )!;
      const br002Call = calls.find(
        (c: Record<string, unknown>) => c['relatedEntityId'] === 'BR002',
      )!;

      expect(br001Call).toBeDefined();
      expect(br001Call['alertType']).toBe(AlertType.SYNC_STALLED);
      expect(br001Call['severity']).toBe(AlertSeverity.WARNING);
      expect(String(br001Call['message'])).toContain('2 order(s)');

      expect(br002Call).toBeDefined();
      expect(String(br002Call['message'])).toContain('1 order(s)');
    });

    it('queries for PENDING orders older than the threshold cutoff', async () => {
      orderSyncQueueRepo.find.mockResolvedValueOnce([]);
      await service.detectStalledOrders();

      const [callArgs] = orderSyncQueueRepo.find.mock.calls;
      expect(callArgs[0].where.status).toBe(SyncStatus.PENDING);
      // createdAt should be a LessThan(Date) FindOperator in the past
      const createdAt = callArgs[0].where.createdAt as FindOperator<Date>;
      expect(createdAt).toBeInstanceOf(FindOperator);
      expect(createdAt.value).toBeInstanceOf(Date);
      expect((createdAt.value as Date).getTime()).toBeLessThan(Date.now());
    });

    it('truncates order list to 10 in alert message with overflow note', async () => {
      const manyOrders = Array.from({ length: 15 }, (_, i) =>
        makeStalledOrder({
          id: `order-${i}`,
          odooOrderNumber: `S000${i.toString().padStart(2, '0')}`,
          branchCode: 'BR001',
        }),
      );
      orderSyncQueueRepo.find.mockResolvedValueOnce(manyOrders);
      await service.detectStalledOrders();

      const [callArg] = alerts.createAlert.mock.calls[0];
      expect(String(callArg.message)).toContain('and 5 more');
    });

    it('catches and does not re-throw errors from the inner implementation', async () => {
      orderSyncQueueRepo.find.mockRejectedValueOnce(
        new Error('DB connection lost'),
      );
      // Should not throw
      await expect(service.detectStalledOrders()).resolves.toBeUndefined();
    });

    it('uses odooOrderId when odooOrderNumber is null in alert message', async () => {
      orderSyncQueueRepo.find.mockResolvedValueOnce([
        makeStalledOrder({ odooOrderNumber: null, odooOrderId: 'RAW-001' }),
      ]);
      await service.detectStalledOrders();
      const [callArg] = alerts.createAlert.mock.calls[0];
      expect(String(callArg.message)).toContain('RAW-001');
    });
  });

  describe('cleanupStalePendingOrders', () => {
    it('skips when the service is disabled', async () => {
      const syncControl = makeSyncControl();
      syncControl.isEnabled.mockResolvedValueOnce(false);
      const svc = build(makeConfig(), syncControl);
      await svc.cleanupStalePendingOrders();
      expect(orderSyncQueueRepo.find).not.toHaveBeenCalled();
    });

    it('cancels stale requests older than the cancel threshold', async () => {
      // First find call → stale-by-age; second call → exhausted retries.
      orderSyncQueueRepo.find
        .mockResolvedValueOnce([
          makeStalledOrder({
            status: SyncStatus.PENDING,
            syncAttempts: 1,
            createdAt: new Date('2024-01-01T00:00:00Z'),
          }),
        ])
        .mockResolvedValueOnce([]);

      await service.cleanupStalePendingOrders();

      expect(orderSyncQueueRepo.update).toHaveBeenCalledWith(
        'order-001',
        expect.objectContaining({ status: SyncStatus.FAILED }),
      );
      // Audit row recorded
      expect(failedTransactionRepo.save).toHaveBeenCalledTimes(1);
      // Summary alert raised for cancelled requests
      expect(alerts.createAlert).toHaveBeenCalledTimes(1);
    });

    it('permanently fails orders that exceed the retry limit', async () => {
      orderSyncQueueRepo.find
        .mockResolvedValueOnce([]) // none stale by age
        .mockResolvedValueOnce([
          makeStalledOrder({
            id: 'order-retry',
            status: SyncStatus.QUEUED_FOR_RETRY,
            syncAttempts: 5,
          }),
        ]);

      await service.cleanupStalePendingOrders();

      expect(orderSyncQueueRepo.update).toHaveBeenCalledWith(
        'order-retry',
        expect.objectContaining({ status: SyncStatus.FAILED }),
      );
      expect(failedTransactionRepo.save).toHaveBeenCalledTimes(1);
      // A summary alert is raised for permanently-failed orders.
      expect(alerts.createAlert).toHaveBeenCalledTimes(1);
      const [alertArg] = alerts.createAlert.mock.calls[0];
      expect(String(alertArg.title)).toContain('permanently failed');
    });

    it('does nothing when there are no eligible orders', async () => {
      orderSyncQueueRepo.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      await service.cleanupStalePendingOrders();
      expect(orderSyncQueueRepo.update).not.toHaveBeenCalled();
      expect(failedTransactionRepo.save).not.toHaveBeenCalled();
    });

    it('queries eligible statuses older than the cancel cutoff', async () => {
      orderSyncQueueRepo.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      await service.cleanupStalePendingOrders();

      const [cancelCall] = orderSyncQueueRepo.find.mock.calls[0];
      const statusOp = cancelCall.where.status as FindOperator<SyncStatus[]>;
      expect(statusOp).toBeInstanceOf(FindOperator);
      expect(statusOp.value).toEqual([
        SyncStatus.PENDING,
        SyncStatus.QUEUED_FOR_RETRY,
      ]);
      const createdAt = cancelCall.where.createdAt as FindOperator<Date>;
      expect(createdAt).toBeInstanceOf(FindOperator);
      expect(createdAt.value).toBeInstanceOf(Date);

      const [retryCall] = orderSyncQueueRepo.find.mock.calls[1];
      const syncAttempts = retryCall.where.syncAttempts as FindOperator<number>;
      expect(syncAttempts).toBeInstanceOf(FindOperator);
      expect(syncAttempts.value).toBe(5);
    });

    it('does not re-throw when cleanup fails', async () => {
      orderSyncQueueRepo.find.mockRejectedValueOnce(new Error('DB down'));
      await expect(
        service.cleanupStalePendingOrders(),
      ).resolves.toBeUndefined();
    });
  });

  describe('getStalledCount', () => {
    it('returns count from the database', async () => {
      orderSyncQueueRepo.count.mockResolvedValueOnce(7);
      const count = await service.getStalledCount();
      expect(count).toBe(7);
    });

    it('queries for PENDING orders older than the cutoff', async () => {
      orderSyncQueueRepo.count.mockResolvedValueOnce(0);
      await service.getStalledCount();
      const [callArgs] = orderSyncQueueRepo.count.mock.calls;
      expect(callArgs[0].where.status).toBe(SyncStatus.PENDING);
      const createdAt = callArgs[0].where.createdAt as FindOperator<Date>;
      expect(createdAt).toBeInstanceOf(FindOperator);
      expect(createdAt.value).toBeInstanceOf(Date);
    });
  });

  describe('constructor — threshold configuration', () => {
    it('uses the configured STALE_THRESHOLD_HOURS when valid', async () => {
      const svc = build(makeConfig(12));
      orderSyncQueueRepo.count.mockResolvedValueOnce(0);
      await svc.getStalledCount();
      const [callArgs] = orderSyncQueueRepo.count.mock.calls;
      // Threshold of 12 hours → cutoff ≈ 12 * 3600 * 1000 ms ago
      const nowMs = Date.now();
      const createdAt = callArgs[0].where.createdAt as FindOperator<Date>;
      const cutoffMs = (createdAt.value as Date).getTime();
      const diffHours = (nowMs - cutoffMs) / (3600 * 1000);
      expect(diffHours).toBeGreaterThan(11.9);
      expect(diffHours).toBeLessThan(12.1);
    });

    it('falls back to 6 hours when configured value is 0 or missing', async () => {
      const svc = build(makeConfig(0));
      orderSyncQueueRepo.count.mockResolvedValueOnce(0);
      await svc.getStalledCount();
      const [callArgs] = orderSyncQueueRepo.count.mock.calls;
      const nowMs = Date.now();
      const createdAt = callArgs[0].where.createdAt as FindOperator<Date>;
      const cutoffMs = (createdAt.value as Date).getTime();
      const diffHours = (nowMs - cutoffMs) / (3600 * 1000);
      expect(diffHours).toBeGreaterThan(5.9);
      expect(diffHours).toBeLessThan(6.1);
    });
  });
});
