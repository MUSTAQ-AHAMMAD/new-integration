import { ConfigService } from '@nestjs/config';
import { AlertSeverity, AlertType, SyncStatus } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { StalledOrdersService } from './stalled-orders.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makePrisma() {
  return {
    orderSyncQueue: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
}

function makeAlerts() {
  return {
    createAlert: jest.fn().mockResolvedValue({}),
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
  let prisma: ReturnType<typeof makePrisma>;
  let alerts: ReturnType<typeof makeAlerts>;

  beforeEach(() => {
    prisma = makePrisma();
    alerts = makeAlerts();
    service = new StalledOrdersService(
      prisma as unknown as PrismaService,
      alerts as unknown as AlertsService,
      makeConfig() as unknown as ConfigService,
    );
    jest.clearAllMocks();
  });

  describe('detectStalledOrders', () => {
    it('does nothing when there are no stalled orders', async () => {
      prisma.orderSyncQueue.findMany.mockResolvedValueOnce([]);
      await service.detectStalledOrders();
      expect(alerts.createAlert).not.toHaveBeenCalled();
    });

    it('fires one alert per branch for stalled orders', async () => {
      prisma.orderSyncQueue.findMany.mockResolvedValueOnce([
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
      prisma.orderSyncQueue.findMany.mockResolvedValueOnce([]);
      await service.detectStalledOrders();

      const [callArgs] = prisma.orderSyncQueue.findMany.mock.calls;
      expect(callArgs[0].where.status).toBe(SyncStatus.PENDING);
      // createdAt.lt should be in the past (a Date object)
      expect(callArgs[0].where.createdAt.lt).toBeInstanceOf(Date);
      expect((callArgs[0].where.createdAt.lt as Date).getTime()).toBeLessThan(
        Date.now(),
      );
    });

    it('truncates order list to 10 in alert message with overflow note', async () => {
      const manyOrders = Array.from({ length: 15 }, (_, i) =>
        makeStalledOrder({
          id: `order-${i}`,
          odooOrderNumber: `S000${i.toString().padStart(2, '0')}`,
          branchCode: 'BR001',
        }),
      );
      prisma.orderSyncQueue.findMany.mockResolvedValueOnce(manyOrders);
      await service.detectStalledOrders();

      const [callArg] = alerts.createAlert.mock.calls[0];
      expect(String(callArg.message)).toContain('and 5 more');
    });

    it('catches and does not re-throw errors from the inner implementation', async () => {
      prisma.orderSyncQueue.findMany.mockRejectedValueOnce(
        new Error('DB connection lost'),
      );
      // Should not throw
      await expect(service.detectStalledOrders()).resolves.toBeUndefined();
    });

    it('uses odooOrderId when odooOrderNumber is null in alert message', async () => {
      prisma.orderSyncQueue.findMany.mockResolvedValueOnce([
        makeStalledOrder({ odooOrderNumber: null, odooOrderId: 'RAW-001' }),
      ]);
      await service.detectStalledOrders();
      const [callArg] = alerts.createAlert.mock.calls[0];
      expect(String(callArg.message)).toContain('RAW-001');
    });
  });

  describe('getStalledCount', () => {
    it('returns count from the database', async () => {
      prisma.orderSyncQueue.count.mockResolvedValueOnce(7);
      const count = await service.getStalledCount();
      expect(count).toBe(7);
    });

    it('queries for PENDING orders older than the cutoff', async () => {
      prisma.orderSyncQueue.count.mockResolvedValueOnce(0);
      await service.getStalledCount();
      const [callArgs] = prisma.orderSyncQueue.count.mock.calls;
      expect(callArgs[0].where.status).toBe(SyncStatus.PENDING);
      expect(callArgs[0].where.createdAt.lt).toBeInstanceOf(Date);
    });
  });

  describe('constructor — threshold configuration', () => {
    it('uses the configured STALE_THRESHOLD_HOURS when valid', async () => {
      const svc = new StalledOrdersService(
        prisma as unknown as PrismaService,
        alerts as unknown as AlertsService,
        makeConfig(12) as unknown as ConfigService,
      );
      prisma.orderSyncQueue.count.mockResolvedValueOnce(0);
      await svc.getStalledCount();
      const [callArgs] = prisma.orderSyncQueue.count.mock.calls;
      // Threshold of 12 hours → cutoff ≈ 12 * 3600 * 1000 ms ago
      const nowMs = Date.now();
      const cutoffMs = (callArgs[0].where.createdAt.lt as Date).getTime();
      const diffHours = (nowMs - cutoffMs) / (3600 * 1000);
      expect(diffHours).toBeGreaterThan(11.9);
      expect(diffHours).toBeLessThan(12.1);
    });

    it('falls back to 6 hours when configured value is 0 or missing', async () => {
      const svc = new StalledOrdersService(
        prisma as unknown as PrismaService,
        alerts as unknown as AlertsService,
        makeConfig(0) as unknown as ConfigService,
      );
      prisma.orderSyncQueue.count.mockResolvedValueOnce(0);
      await svc.getStalledCount();
      const [callArgs] = prisma.orderSyncQueue.count.mock.calls;
      const nowMs = Date.now();
      const cutoffMs = (callArgs[0].where.createdAt.lt as Date).getTime();
      const diffHours = (nowMs - cutoffMs) / (3600 * 1000);
      expect(diffHours).toBeGreaterThan(5.9);
      expect(diffHours).toBeLessThan(6.1);
    });
  });
});
