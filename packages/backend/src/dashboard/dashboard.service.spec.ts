import { DashboardService } from './dashboard.service';
import { SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const mockPrisma = {
  orderSyncQueue: {
    count: jest.fn(),
    groupBy: jest.fn(),
    findMany: jest.fn(),
  },
  syncJob: {
    count: jest.fn(),
  },
  alertLog: {
    count: jest.fn(),
  },
  storeConfiguration: {
    count: jest.fn(),
  },
  failedTransaction: {
    findMany: jest.fn(),
  },
  auditLog: {
    findMany: jest.fn(),
  },
  integrationHealthCheck: {
    findMany: jest.fn(),
  },
  inventorySyncTracker: {
    findMany: jest.fn(),
  },
  webhookEvent: {
    findMany: jest.fn(),
  },
};

// Cache miss by default so every test exercises the real Prisma path
const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  setex: jest.fn().mockResolvedValue('OK'),
};

describe('DashboardService', () => {
  let service: DashboardService;

  beforeEach(() => {
    service = new DashboardService(
      mockPrisma as unknown as PrismaService,
      mockRedis as unknown as RedisService,
    );
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue('OK');
  });

  describe('getOverview', () => {
    beforeEach(() => {
      mockPrisma.orderSyncQueue.count
        .mockResolvedValueOnce(100) // totalOrders
        .mockResolvedValueOnce(80) // synced
        .mockResolvedValueOnce(10) // failed
        .mockResolvedValueOnce(8) // pending
        .mockResolvedValueOnce(2); // processing
      mockPrisma.alertLog.count.mockResolvedValueOnce(3);
      mockPrisma.syncJob.count.mockResolvedValueOnce(2);
      mockPrisma.storeConfiguration.count.mockResolvedValueOnce(5);
    });

    it('returns correct overview with sync rate', async () => {
      const result = await service.getOverview();

      expect(result.totalOrders).toBe(100);
      expect(result.syncedOrders).toBe(80);
      expect(result.failedOrders).toBe(10);
      expect(result.syncRate).toBe(80);
      expect(result.unresolvedAlerts).toBe(3);
      expect(result.storeCount).toBe(5);
    });

    it('returns 0 syncRate when totalOrders is 0', async () => {
      jest.resetAllMocks();
      // Re-mock all count calls for the zero-total scenario
      mockPrisma.orderSyncQueue.count
        .mockResolvedValueOnce(0) // totalOrders
        .mockResolvedValueOnce(0) // synced
        .mockResolvedValueOnce(0) // failed
        .mockResolvedValueOnce(0) // pending
        .mockResolvedValueOnce(0); // processing
      mockPrisma.alertLog.count.mockResolvedValueOnce(0);
      mockPrisma.syncJob.count.mockResolvedValueOnce(0);
      mockPrisma.storeConfiguration.count.mockResolvedValueOnce(0);

      const result = await service.getOverview();

      expect(result.syncRate).toBe(0);
    });
  });

  describe('getFailedTransactions', () => {
    it('returns failed transactions with order info', async () => {
      const mockTransactions = [
        {
          id: 'tx-1',
          errorType: 'ORACLE',
          isResolved: false,
          orderSyncQueue: { odooOrderNumber: 'ODO-001', branchCode: 'BR001' },
        },
      ];
      mockPrisma.failedTransaction.findMany.mockResolvedValueOnce(
        mockTransactions,
      );

      const result = await service.getFailedTransactions();

      expect(result).toHaveLength(1);
      expect(result[0].orderSyncQueue?.odooOrderNumber).toBe('ODO-001');
    });
  });

  describe('getOrdersByBranch', () => {
    it('groups orders by branch code and status', async () => {
      const mockData = [
        { branchCode: 'BR001', status: SyncStatus.SYNCED, _count: { id: 45 } },
        { branchCode: 'BR001', status: SyncStatus.FAILED, _count: { id: 5 } },
      ];
      mockPrisma.orderSyncQueue.groupBy.mockResolvedValueOnce(mockData);

      const result = await service.getOrdersByBranch();

      expect(result).toHaveLength(2);
      expect(mockPrisma.orderSyncQueue.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['branchCode', 'status'] }),
      );
    });
  });

  describe('getSyncTrend', () => {
    it('groups by status for the last 7 days by default', async () => {
      mockPrisma.orderSyncQueue.groupBy.mockResolvedValueOnce([]);

      await service.getSyncTrend();

      expect(mockPrisma.orderSyncQueue.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['status'],
          where: expect.objectContaining({
            createdAt: expect.objectContaining({ gte: expect.any(Date) }),
          }),
        }),
      );
    });

    it('accepts a custom number of days', async () => {
      mockPrisma.orderSyncQueue.groupBy.mockResolvedValueOnce([]);

      await service.getSyncTrend(30);

      const call = mockPrisma.orderSyncQueue.groupBy.mock.calls[0][0] as {
        where: { createdAt: { gte: Date } };
      };
      const daysBack =
        (Date.now() - call.where.createdAt.gte.getTime()) / 86_400_000;
      expect(daysBack).toBeCloseTo(30, 0);
    });
  });

  describe('getNegativeInventory', () => {
    it('returns unresolved negative inventory items', async () => {
      mockPrisma.inventorySyncTracker.findMany.mockResolvedValueOnce([
        { id: 'inv-1', productSku: 'SKU-001', isNegativeInventory: true },
      ]);

      const result = await service.getNegativeInventory();

      expect(result).toHaveLength(1);
      expect(mockPrisma.inventorySyncTracker.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isNegativeInventory: true,
            negativeInventoryAlertSent: false,
          }),
        }),
      );
    });
  });
});
