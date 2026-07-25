import { DashboardService } from './dashboard.service';
import { SyncStatus } from '../database/enums';
import { RedisService } from '../redis/redis.service';

function makeQb() {
  return {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
}

function makeRepo() {
  return {
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
  };
}

describe('DashboardService', () => {
  let service: DashboardService;
  let orders: ReturnType<typeof makeRepo>;
  let alerts: ReturnType<typeof makeRepo>;
  let jobs: ReturnType<typeof makeRepo>;
  let stores: ReturnType<typeof makeRepo>;
  let vendhqSales: ReturnType<typeof makeRepo>;
  let failedTransactions: ReturnType<typeof makeRepo>;
  let audit: ReturnType<typeof makeRepo>;
  let health: ReturnType<typeof makeRepo>;
  let inventory: ReturnType<typeof makeRepo>;
  let webhooks: ReturnType<typeof makeRepo>;
  let backupOdoo: ReturnType<typeof makeRepo>;
  let invoiceHeaders: ReturnType<typeof makeRepo>;
  let odooCredentials: ReturnType<typeof makeRepo>;
  let refunds: ReturnType<typeof makeRepo>;
  let ordersQb: ReturnType<typeof makeQb>;

  const mockRedis = {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
  };

  beforeEach(() => {
    orders = makeRepo();
    alerts = makeRepo();
    jobs = makeRepo();
    stores = makeRepo();
    vendhqSales = makeRepo();
    failedTransactions = makeRepo();
    audit = makeRepo();
    health = makeRepo();
    inventory = makeRepo();
    webhooks = makeRepo();
    backupOdoo = makeRepo();
    invoiceHeaders = makeRepo();
    odooCredentials = makeRepo();
    refunds = makeRepo();
    ordersQb = makeQb();
    orders.createQueryBuilder.mockReturnValue(ordersQb);

    service = new DashboardService(
      orders as never,
      alerts as never,
      jobs as never,
      stores as never,
      vendhqSales as never,
      failedTransactions as never,
      audit as never,
      health as never,
      inventory as never,
      webhooks as never,
      backupOdoo as never,
      invoiceHeaders as never,
      odooCredentials as never,
      refunds as never,
      mockRedis as unknown as RedisService,
    );
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue('OK');
  });

  describe('getOverview', () => {
    beforeEach(() => {
      orders.count
        .mockResolvedValueOnce(100) // totalOrders
        .mockResolvedValueOnce(80) // synced
        .mockResolvedValueOnce(10) // failed
        .mockResolvedValueOnce(8) // pending
        .mockResolvedValueOnce(2); // processing
      alerts.count.mockResolvedValueOnce(3);
      jobs.count.mockResolvedValueOnce(2);
      stores.count.mockResolvedValueOnce(5);
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
      orders.count.mockReset();
      orders.count.mockResolvedValue(0);
      alerts.count.mockResolvedValue(0);
      jobs.count.mockResolvedValue(0);
      stores.count.mockResolvedValue(0);

      const result = await service.getOverview();

      expect(result.syncRate).toBe(0);
    });
  });

  describe('getFailedTransactions', () => {
    it('returns failed transactions with order info', async () => {
      failedTransactions.find.mockResolvedValueOnce([
        {
          id: 'tx-1',
          errorType: 'ORACLE',
          isResolved: false,
          orderSyncQueue: { odooOrderNumber: 'ODO-001', branchCode: 'BR001' },
        },
      ]);

      const result = await service.getFailedTransactions();

      expect(result).toHaveLength(1);
      expect(result[0].orderSyncQueue?.odooOrderNumber).toBe('ODO-001');
      expect(failedTransactions.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isResolved: false },
          relations: { orderSyncQueue: true },
        }),
      );
    });
  });

  describe('getOrdersByBranch', () => {
    it('groups orders by branch code and status', async () => {
      ordersQb.getRawMany.mockResolvedValueOnce([
        { branchCode: 'BR001', status: SyncStatus.SYNCED, count: 45 },
        { branchCode: 'BR001', status: SyncStatus.FAILED, count: 5 },
      ]);

      const result = await service.getOrdersByBranch();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        branchCode: 'BR001',
        status: SyncStatus.SYNCED,
        count: 45,
      });
      expect(ordersQb.groupBy).toHaveBeenCalledWith('o.branchCode');
      expect(ordersQb.addGroupBy).toHaveBeenCalledWith('o.status');
    });
  });

  describe('getSyncTrend', () => {
    it('groups by status for the last 7 days by default', async () => {
      ordersQb.getRawMany.mockResolvedValueOnce([]);

      await service.getSyncTrend();

      expect(ordersQb.groupBy).toHaveBeenCalledWith('o.status');
      expect(ordersQb.where).toHaveBeenCalledWith(
        'o.createdAt >= :startDate',
        expect.objectContaining({ startDate: expect.any(Date) }),
      );
    });

    it('accepts a custom number of days', async () => {
      ordersQb.getRawMany.mockResolvedValueOnce([]);

      await service.getSyncTrend(30);

      const call = ordersQb.where.mock.calls[0][1] as { startDate: Date };
      const daysBack = (Date.now() - call.startDate.getTime()) / 86_400_000;
      expect(daysBack).toBeCloseTo(30, 0);
    });
  });

  describe('getNegativeInventory', () => {
    it('returns unresolved negative inventory items', async () => {
      inventory.find.mockResolvedValueOnce([
        { id: 'inv-1', productSku: 'SKU-001', isNegativeInventory: true },
      ]);

      const result = await service.getNegativeInventory();

      expect(result).toHaveLength(1);
      expect(inventory.find).toHaveBeenCalledWith(
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
