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

import { Prisma, SyncStatus } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { OdooOrderData, OrderSyncService } from './order-sync.service';
import { TimezoneService } from './timezone.service';

const mockPrisma = {
  orderSyncQueue: {
    upsert: jest.fn(),
    findMany: jest.fn(),
  },
  refundTracking: {
    upsert: jest.fn(),
  },
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

function makeUpsertedOrder(overrides: Record<string, unknown> = {}) {
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
      mockPrisma as unknown as PrismaService,
      mockQueues as unknown as QueuesService,
      mockTimezone as unknown as TimezoneService,
      mockAlerts as unknown as AlertsService,
    );
    jest.clearAllMocks();
    mockQueues.enqueueOrderSync.mockResolvedValue({ id: 'job-1' });
    mockQueues.enqueueOrderSyncBulk.mockResolvedValue([]);
  });

  // ── ingestOrder ─────────────────────────────────────────────

  describe('ingestOrder', () => {
    it('upserts the order into orderSyncQueue', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());

      await service.ingestOrder(makeOrderData());

      expect(mockPrisma.orderSyncQueue.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            odooOrderId_branchCode: {
              odooOrderId: 'ORD-001',
              branchCode: 'DXB',
            },
          },
          create: expect.objectContaining({
            odooOrderId: 'ORD-001',
            branchCode: 'DXB',
            isPaid: true,
          }),
        }),
      );
    });

    it('sets status to PENDING for paid, non-cancelled orders', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());

      await service.ingestOrder(
        makeOrderData({ isPaid: true, isCancelled: false }),
      );

      const createData = mockPrisma.orderSyncQueue.upsert.mock.calls[0][0]
        .create as { status: SyncStatus };
      expect(createData.status).toBe(SyncStatus.PENDING);
    });

    it('sets status to SKIPPED for unpaid orders', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(
        makeUpsertedOrder({ status: SyncStatus.SKIPPED }),
      );

      await service.ingestOrder(makeOrderData({ isPaid: false }));

      const createData = mockPrisma.orderSyncQueue.upsert.mock.calls[0][0]
        .create as { status: SyncStatus };
      expect(createData.status).toBe(SyncStatus.SKIPPED);
    });

    it('sets status to SKIPPED for cancelled orders', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(
        makeUpsertedOrder({ status: SyncStatus.SKIPPED }),
      );

      await service.ingestOrder(
        makeOrderData({ isPaid: true, isCancelled: true }),
      );

      const createData = mockPrisma.orderSyncQueue.upsert.mock.calls[0][0]
        .create as { status: SyncStatus };
      expect(createData.status).toBe(SyncStatus.SKIPPED);
    });

    it('normalizes the order date to UTC using the timezone service', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());

      await service.ingestOrder(makeOrderData());

      expect(mockTimezone.normalizeToUtc).toHaveBeenCalledWith(
        expect.any(Date),
        'Asia/Dubai',
      );
      const createData = mockPrisma.orderSyncQueue.upsert.mock.calls[0][0]
        .create as { orderDateUtc: Date };
      expect(createData.orderDateUtc).toEqual(
        new Date('2024-01-15T06:00:00.000Z'),
      );
    });

    it('sets negativeInventoryFlag when negative inventory items are present', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());

      await service.ingestOrder(
        makeOrderData({
          negativeInventoryItems: [{ sku: 'SKU-001', quantity: -5 }],
        }),
      );

      const createData = mockPrisma.orderSyncQueue.upsert.mock.calls[0][0]
        .create as { negativeInventoryFlag: boolean };
      expect(createData.negativeInventoryFlag).toBe(true);
    });

    it('does NOT set negativeInventoryFlag when no negative inventory items', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());

      await service.ingestOrder(makeOrderData({ negativeInventoryItems: [] }));

      const createData = mockPrisma.orderSyncQueue.upsert.mock.calls[0][0]
        .create as { negativeInventoryFlag: boolean };
      expect(createData.negativeInventoryFlag).toBe(false);
    });

    it('enqueues order sync for paid, non-cancelled orders', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());

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
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(
        makeUpsertedOrder({ status: SyncStatus.SKIPPED }),
      );

      await service.ingestOrder(makeOrderData({ isPaid: false }));

      expect(mockQueues.enqueueOrderSync).not.toHaveBeenCalled();
    });

    it('does NOT enqueue cancelled orders', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(
        makeUpsertedOrder({ status: SyncStatus.SKIPPED }),
      );

      await service.ingestOrder(
        makeOrderData({ isPaid: true, isCancelled: true }),
      );

      expect(mockQueues.enqueueOrderSync).not.toHaveBeenCalled();
    });

    it('creates a refund tracking record for refund orders', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());
      mockPrisma.refundTracking.upsert = jest.fn().mockResolvedValue({});

      await service.ingestOrder(
        makeOrderData({
          odooOrderId: 'REF-001',
          totalAmount: -100,
          isRefund: true,
          refundReferenceId: 'ORD-ORIGINAL-001',
        }),
      );

      expect(mockPrisma.refundTracking.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { refundOrderId: 'REF-001' },
          create: expect.objectContaining({
            originalOrderId: 'ORD-ORIGINAL-001',
            refundOrderId: 'REF-001',
            creditMemoStatus: SyncStatus.PENDING,
          }),
        }),
      );
    });

    it('stores refund amount as absolute value', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());
      mockPrisma.refundTracking.upsert = jest.fn().mockResolvedValue({});

      await service.ingestOrder(
        makeOrderData({
          totalAmount: -75,
          isRefund: true,
          refundReferenceId: 'ORD-ORIG',
        }),
      );

      const createData = mockPrisma.refundTracking.upsert.mock.calls[0][0]
        .create as { refundAmount: Prisma.Decimal };
      expect(createData.refundAmount.toNumber()).toBe(75);
    });

    it('does NOT create refund record when isRefund is false', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());
      mockPrisma.refundTracking.upsert = jest.fn();

      await service.ingestOrder(makeOrderData({ isRefund: false }));

      expect(mockPrisma.refundTracking.upsert).not.toHaveBeenCalled();
    });

    it('falls back to AED when no currency is provided', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());

      await service.ingestOrder(makeOrderData({ currency: undefined }));

      const createData = mockPrisma.orderSyncQueue.upsert.mock.calls[0][0]
        .create as { currency: string };
      expect(createData.currency).toBe('AED');
    });

    // ── Auto-refund detection ──────────────────────────────────

    it('auto-sets isRefund when totalAmount is negative and isRefund is not set', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());
      mockPrisma.refundTracking.upsert = jest.fn().mockResolvedValue({});

      await service.ingestOrder(
        makeOrderData({
          totalAmount: -50,
          isRefund: false,
          refundReferenceId: 'ORD-X',
        }),
      );

      const createData = mockPrisma.orderSyncQueue.upsert.mock.calls[0][0]
        .create as { isRefund: boolean };
      expect(createData.isRefund).toBe(true);
    });

    it('fires a REFUND_DETECTED alert when a negative-amount order is auto-classified', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());
      mockPrisma.refundTracking.upsert = jest.fn().mockResolvedValue({});

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
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());

      await service.ingestOrder(makeOrderData({ totalAmount: 100 }));

      const alertCalls = mockAlerts.createAlert.mock.calls;
      const refundAlert = alertCalls.find(
        (c: unknown[]) =>
          (c[0] as { alertType: string }).alertType === 'REFUND_DETECTED',
      );
      expect(refundAlert).toBeUndefined();
    });

    it('does NOT fire a REFUND_DETECTED alert when isRefund is already true', async () => {
      mockPrisma.orderSyncQueue.upsert.mockResolvedValue(makeUpsertedOrder());
      mockPrisma.refundTracking.upsert = jest.fn().mockResolvedValue({});

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
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue(failedOrders);

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
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue([
        { id: 'q-1', odooOrderId: 'ORD-F1', branchCode: 'DXB' },
      ]);

      await service.retryFailedOrders();

      expect(mockQueues.enqueueOrderSyncBulk).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ isRetry: true })]),
      );
    });

    it('filters by branchCode when provided', async () => {
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue([]);

      await service.retryFailedOrders('DXB');

      expect(mockPrisma.orderSyncQueue.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branchCode: 'DXB' }),
        }),
      );
    });

    it('queries without branchCode filter when not provided', async () => {
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue([]);

      await service.retryFailedOrders();

      const whereClause = mockPrisma.orderSyncQueue.findMany.mock.calls[0][0]
        .where as Record<string, unknown>;
      expect(whereClause.branchCode).toBeUndefined();
    });

    it('returns enqueued count of 0 when no failed orders exist', async () => {
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue([]);

      const result = await service.retryFailedOrders();

      expect(result.enqueued).toBe(0);
      expect(mockQueues.enqueueOrderSyncBulk).not.toHaveBeenCalled();
    });

    it('only retries paid, non-cancelled, failed orders', async () => {
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue([]);

      await service.retryFailedOrders();

      expect(mockPrisma.orderSyncQueue.findMany).toHaveBeenCalledWith(
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
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue(heldOrders);

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
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue([]);

      await service.retryNegativeInventoryOrders();

      expect(mockPrisma.orderSyncQueue.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
          }),
        }),
      );
    });

    it('filters by branchCode when provided', async () => {
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue([]);

      await service.retryNegativeInventoryOrders('AUH');

      expect(mockPrisma.orderSyncQueue.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branchCode: 'AUH' }),
        }),
      );
    });

    it('marks re-enqueued orders with isRetry=true', async () => {
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue([
        { id: 'q-1', odooOrderId: 'ORD-H1', branchCode: 'DXB' },
      ]);

      await service.retryNegativeInventoryOrders();

      expect(mockQueues.enqueueOrderSyncBulk).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ isRetry: true })]),
      );
    });

    it('returns enqueued count of 0 when no held orders exist', async () => {
      mockPrisma.orderSyncQueue.findMany.mockResolvedValue([]);

      const result = await service.retryNegativeInventoryOrders();

      expect(result.enqueued).toBe(0);
      expect(mockQueues.enqueueOrderSyncBulk).not.toHaveBeenCalled();
    });
  });
});
