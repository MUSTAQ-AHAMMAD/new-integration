// Mock the queues module before NestJS decorators are evaluated
jest.mock('../queues/queues.module', () => ({
  QUEUE_NAMES: {
    ORDER_SYNC: 'order-sync',
    INVENTORY_SYNC: 'inventory-sync',
    RETRY: 'retry',
    NOTIFICATIONS: 'notifications',
  },
  QueuesModule: class QueuesModule {},
}));

import { Repository } from 'typeorm';
import { Decimal } from 'decimal.js';
import { AlertsService } from '../alerts/alerts.service';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { SyncStatus } from '../database/enums';
import { QueuesService } from '../queues/queues.service';
import { OdooOrderData, OrderSyncService } from './order-sync.service';
import { TimezoneService } from './timezone.service';

// Per-repo mocks. `create` echoes its input so assertions can inspect the entity
// that would be persisted; `save` resolves the entity (with a stable id) so the
// service can enqueue by `order.id`.
const mockOrderSyncQueueRepo = {
  findOne: jest.fn(),
  create: jest.fn((x) => x),
  save: jest.fn(),
  find: jest.fn(),
};

const mockRefundTrackingRepo = {
  findOne: jest.fn(),
  create: jest.fn((x) => x),
  save: jest.fn(),
};

const mockQueues = {
  enqueueOrderSync: jest.fn().mockResolvedValue({ id: 'job-1' }),
  enqueueOrderSyncBulk: jest.fn().mockResolvedValue([]),
};

const mockTimezone = {
  normalizeToUtc: jest
    .fn()
    .mockReturnValue(new Date('2024-01-15T06:00:00.000Z')),
};

const mockAlerts = {
  createAlert: jest.fn().mockResolvedValue({}),
};

function makeOrderData(overrides: Partial<OdooOrderData> = {}): OdooOrderData {
  return {
    odooOrderId: 'ORD-001',
    odooOrderNumber: 'S00001',
    branchCode: 'DXB',
    branchName: 'Dubai Store',
    orderDate: new Date('2024-01-15T10:00:00+04:00'),
    originalTimezone: 'Asia/Dubai',
    customerName: 'Test Customer',
    customerEmail: 'test@example.com',
    totalAmount: 150,
    currency: 'AED',
    isPaid: true,
    isCancelled: false,
    isRefund: false,
    ...overrides,
  };
}

function makeSavedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q-001',
    odooOrderId: 'ORD-001',
    branchCode: 'DXB',
    status: SyncStatus.PENDING,
    ...overrides,
  };
}

describe('OrderSyncService', () => {
  let service: OrderSyncService;

  beforeEach(() => {
    service = new OrderSyncService(
      mockOrderSyncQueueRepo as unknown as Repository<OrderSyncQueue>,
      mockRefundTrackingRepo as unknown as Repository<RefundTracking>,
      mockQueues as unknown as QueuesService,
      mockTimezone as unknown as TimezoneService,
      mockAlerts as unknown as AlertsService,
    );
    jest.clearAllMocks();
    mockOrderSyncQueueRepo.create.mockImplementation((x) => x);
    mockRefundTrackingRepo.create.mockImplementation((x) => x);
    mockOrderSyncQueueRepo.findOne.mockResolvedValue(null);
    mockRefundTrackingRepo.findOne.mockResolvedValue(null);
    mockQueues.enqueueOrderSync.mockResolvedValue({ id: 'job-1' });
    mockQueues.enqueueOrderSyncBulk.mockResolvedValue([]);
  });

  // ── ingestOrder ─────────────────────────────────────────────

  describe('ingestOrder', () => {
    it('saves the order into orderSyncQueue', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());

      await service.ingestOrder(makeOrderData());

      expect(mockOrderSyncQueueRepo.findOne).toHaveBeenCalledWith({
        where: { odooOrderId: 'ORD-001', branchCode: 'DXB' },
      });
      expect(mockOrderSyncQueueRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          odooOrderId: 'ORD-001',
          branchCode: 'DXB',
          isPaid: true,
        }),
      );
      expect(mockOrderSyncQueueRepo.save).toHaveBeenCalled();
    });

    it('sets status to PENDING for paid, non-cancelled orders', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());

      await service.ingestOrder(
        makeOrderData({ isPaid: true, isCancelled: false }),
      );

      const createData = mockOrderSyncQueueRepo.create.mock.calls[0][0] as {
        status: SyncStatus;
      };
      expect(createData.status).toBe(SyncStatus.PENDING);
    });

    it('sets status to SKIPPED for unpaid orders', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(
        makeSavedOrder({ status: SyncStatus.SKIPPED }),
      );

      await service.ingestOrder(makeOrderData({ isPaid: false }));

      const createData = mockOrderSyncQueueRepo.create.mock.calls[0][0] as {
        status: SyncStatus;
      };
      expect(createData.status).toBe(SyncStatus.SKIPPED);
    });

    it('sets status to SKIPPED for cancelled orders', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(
        makeSavedOrder({ status: SyncStatus.SKIPPED }),
      );

      await service.ingestOrder(
        makeOrderData({ isPaid: true, isCancelled: true }),
      );

      const createData = mockOrderSyncQueueRepo.create.mock.calls[0][0] as {
        status: SyncStatus;
      };
      expect(createData.status).toBe(SyncStatus.SKIPPED);
    });

    it('normalizes the order date to UTC using the timezone service', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());

      await service.ingestOrder(makeOrderData());

      expect(mockTimezone.normalizeToUtc).toHaveBeenCalledWith(
        expect.any(Date),
        'Asia/Dubai',
      );
      const createData = mockOrderSyncQueueRepo.create.mock.calls[0][0] as {
        orderDateUtc: Date;
      };
      expect(createData.orderDateUtc).toEqual(
        new Date('2024-01-15T06:00:00.000Z'),
      );
    });

    it('sets negativeInventoryFlag when negative inventory items are present', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());

      await service.ingestOrder(
        makeOrderData({
          negativeInventoryItems: [{ sku: 'SKU-001', quantity: -5 }],
        }),
      );

      const createData = mockOrderSyncQueueRepo.create.mock.calls[0][0] as {
        negativeInventoryFlag: boolean;
      };
      expect(createData.negativeInventoryFlag).toBe(true);
    });

    it('does NOT set negativeInventoryFlag when no negative inventory items', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());

      await service.ingestOrder(makeOrderData({ negativeInventoryItems: [] }));

      const createData = mockOrderSyncQueueRepo.create.mock.calls[0][0] as {
        negativeInventoryFlag: boolean;
      };
      expect(createData.negativeInventoryFlag).toBe(false);
    });

    it('enqueues order sync for paid, non-cancelled orders', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());

      await service.ingestOrder(
        makeOrderData({ isPaid: true, isCancelled: false }),
      );

      expect(mockQueues.enqueueOrderSync).toHaveBeenCalledWith(
        expect.objectContaining({
          orderSyncQueueId: 'q-001',
          odooOrderId: 'ORD-001',
          branchCode: 'DXB',
        }),
      );
    });

    it('does NOT enqueue unpaid orders', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(
        makeSavedOrder({ status: SyncStatus.SKIPPED }),
      );

      await service.ingestOrder(makeOrderData({ isPaid: false }));

      expect(mockQueues.enqueueOrderSync).not.toHaveBeenCalled();
    });

    it('does NOT enqueue cancelled orders', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(
        makeSavedOrder({ status: SyncStatus.SKIPPED }),
      );

      await service.ingestOrder(
        makeOrderData({ isPaid: true, isCancelled: true }),
      );

      expect(mockQueues.enqueueOrderSync).not.toHaveBeenCalled();
    });

    it('creates a refund tracking record for refund orders', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());
      mockRefundTrackingRepo.save.mockResolvedValue({});

      await service.ingestOrder(
        makeOrderData({
          odooOrderId: 'REF-001',
          totalAmount: -100,
          isRefund: true,
          refundReferenceId: 'ORD-ORIGINAL-001',
        }),
      );

      expect(mockRefundTrackingRepo.findOne).toHaveBeenCalledWith({
        where: { refundOrderId: 'REF-001' },
      });
      expect(mockRefundTrackingRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          originalOrderId: 'ORD-ORIGINAL-001',
          refundOrderId: 'REF-001',
          creditMemoStatus: SyncStatus.PENDING,
        }),
      );
      expect(mockRefundTrackingRepo.save).toHaveBeenCalled();
    });

    it('stores refund amount as absolute value', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());
      mockRefundTrackingRepo.save.mockResolvedValue({});

      await service.ingestOrder(
        makeOrderData({
          totalAmount: -75,
          isRefund: true,
          refundReferenceId: 'ORD-ORIG',
        }),
      );

      const createData = mockRefundTrackingRepo.create.mock.calls[0][0] as {
        refundAmount: Decimal;
      };
      expect(createData.refundAmount.toNumber()).toBe(75);
    });

    it('does NOT create refund record when isRefund is false', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());

      await service.ingestOrder(makeOrderData({ isRefund: false }));

      expect(mockRefundTrackingRepo.save).not.toHaveBeenCalled();
    });

    it('falls back to AED when no currency is provided', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());

      await service.ingestOrder(makeOrderData({ currency: undefined }));

      const createData = mockOrderSyncQueueRepo.create.mock.calls[0][0] as {
        currency: string;
      };
      expect(createData.currency).toBe('AED');
    });

    // ── Auto-refund detection ──────────────────────────────────

    it('auto-sets isRefund when totalAmount is negative and isRefund is not set', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());
      mockRefundTrackingRepo.save.mockResolvedValue({});

      await service.ingestOrder(
        makeOrderData({
          totalAmount: -50,
          isRefund: false,
          refundReferenceId: 'ORD-X',
        }),
      );

      const createData = mockOrderSyncQueueRepo.create.mock.calls[0][0] as {
        isRefund: boolean;
      };
      expect(createData.isRefund).toBe(true);
    });

    it('fires a REFUND_DETECTED alert when a negative-amount order is auto-classified', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());
      mockRefundTrackingRepo.save.mockResolvedValue({});

      await service.ingestOrder(
        makeOrderData({
          totalAmount: -50,
          isRefund: false,
          refundReferenceId: 'ORD-X',
        }),
      );

      expect(mockAlerts.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({ alertType: 'REFUND_DETECTED' }),
      );
    });

    it('does NOT fire a REFUND_DETECTED alert when totalAmount is positive', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());

      await service.ingestOrder(makeOrderData({ totalAmount: 100 }));

      const alertCalls = mockAlerts.createAlert.mock.calls;
      const refundAlert = alertCalls.find(
        (c: unknown[]) =>
          (c[0] as { alertType: string }).alertType === 'REFUND_DETECTED',
      );
      expect(refundAlert).toBeUndefined();
    });

    it('does NOT fire a REFUND_DETECTED alert when isRefund is already true', async () => {
      mockOrderSyncQueueRepo.save.mockResolvedValue(makeSavedOrder());
      mockRefundTrackingRepo.save.mockResolvedValue({});

      await service.ingestOrder(
        makeOrderData({
          totalAmount: -50,
          isRefund: true,
          refundReferenceId: 'ORD-X',
        }),
      );

      const alertCalls = mockAlerts.createAlert.mock.calls;
      const refundAlert = alertCalls.find(
        (c: unknown[]) =>
          (c[0] as { alertType: string }).alertType === 'REFUND_DETECTED',
      );
      expect(refundAlert).toBeUndefined();
    });
  });

  // ── retryFailedOrders ────────────────────────────────────────

  describe('retryFailedOrders', () => {
    it('re-enqueues all failed orders', async () => {
      const failedOrders = [
        { id: 'q-1', odooOrderId: 'ORD-F1', branchCode: 'DXB' },
        { id: 'q-2', odooOrderId: 'ORD-F2', branchCode: 'AUH' },
      ];
      mockOrderSyncQueueRepo.find.mockResolvedValue(failedOrders);

      const result = await service.retryFailedOrders();

      expect(mockQueues.enqueueOrderSyncBulk).toHaveBeenCalledTimes(1);
      expect(mockQueues.enqueueOrderSyncBulk).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ odooOrderId: 'ORD-F1' }),
          expect.objectContaining({ odooOrderId: 'ORD-F2' }),
        ]),
      );
      expect(result.enqueued).toBe(2);
    });

    it('marks retried orders with isRetry=true', async () => {
      mockOrderSyncQueueRepo.find.mockResolvedValue([
        { id: 'q-1', odooOrderId: 'ORD-F1', branchCode: 'DXB' },
      ]);

      await service.retryFailedOrders();

      expect(mockQueues.enqueueOrderSyncBulk).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ isRetry: true })]),
      );
    });

    it('filters by branchCode when provided', async () => {
      mockOrderSyncQueueRepo.find.mockResolvedValue([]);

      await service.retryFailedOrders('DXB');

      expect(mockOrderSyncQueueRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branchCode: 'DXB' }),
        }),
      );
    });

    it('queries without branchCode filter when not provided', async () => {
      mockOrderSyncQueueRepo.find.mockResolvedValue([]);

      await service.retryFailedOrders();

      const whereClause = mockOrderSyncQueueRepo.find.mock.calls[0][0]
        .where as Record<string, unknown>;
      expect(whereClause.branchCode).toBeUndefined();
    });

    it('returns enqueued count of 0 when no failed orders exist', async () => {
      mockOrderSyncQueueRepo.find.mockResolvedValue([]);

      const result = await service.retryFailedOrders();

      expect(result.enqueued).toBe(0);
      expect(mockQueues.enqueueOrderSyncBulk).not.toHaveBeenCalled();
    });

    it('only retries paid, non-cancelled, failed orders', async () => {
      mockOrderSyncQueueRepo.find.mockResolvedValue([]);

      await service.retryFailedOrders();

      expect(mockOrderSyncQueueRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: SyncStatus.FAILED,
            isPaid: true,
            isCancelled: false,
          }),
        }),
      );
    });
  });

  // ── retryNegativeInventoryOrders ─────────────────────────────

  describe('retryNegativeInventoryOrders', () => {
    it('re-enqueues all NEGATIVE_INVENTORY_HOLD orders', async () => {
      const heldOrders = [
        { id: 'q-1', odooOrderId: 'ORD-H1', branchCode: 'DXB' },
        { id: 'q-2', odooOrderId: 'ORD-H2', branchCode: 'DXB' },
      ];
      mockOrderSyncQueueRepo.find.mockResolvedValue(heldOrders);

      const result = await service.retryNegativeInventoryOrders();

      expect(mockQueues.enqueueOrderSyncBulk).toHaveBeenCalledTimes(1);
      expect(mockQueues.enqueueOrderSyncBulk).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ odooOrderId: 'ORD-H1' }),
          expect.objectContaining({ odooOrderId: 'ORD-H2' }),
        ]),
      );
      expect(result.enqueued).toBe(2);
    });

    it('queries by NEGATIVE_INVENTORY_HOLD status', async () => {
      mockOrderSyncQueueRepo.find.mockResolvedValue([]);

      await service.retryNegativeInventoryOrders();

      expect(mockOrderSyncQueueRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
          }),
        }),
      );
    });

    it('filters by branchCode when provided', async () => {
      mockOrderSyncQueueRepo.find.mockResolvedValue([]);

      await service.retryNegativeInventoryOrders('AUH');

      expect(mockOrderSyncQueueRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branchCode: 'AUH' }),
        }),
      );
    });

    it('marks re-enqueued orders with isRetry=true', async () => {
      mockOrderSyncQueueRepo.find.mockResolvedValue([
        { id: 'q-1', odooOrderId: 'ORD-H1', branchCode: 'DXB' },
      ]);

      await service.retryNegativeInventoryOrders();

      expect(mockQueues.enqueueOrderSyncBulk).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ isRetry: true })]),
      );
    });

    it('returns enqueued count of 0 when no held orders exist', async () => {
      mockOrderSyncQueueRepo.find.mockResolvedValue([]);

      const result = await service.retryNegativeInventoryOrders();

      expect(result.enqueued).toBe(0);
      expect(mockQueues.enqueueOrderSyncBulk).not.toHaveBeenCalled();
    });
  });
});
