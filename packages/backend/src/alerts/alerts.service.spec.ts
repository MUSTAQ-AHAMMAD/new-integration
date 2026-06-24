import { AlertsService } from './alerts.service';
import { AlertSeverity, AlertType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GatewayService } from '../gateway/gateway.service';

const mockPrisma = {
  alertLog: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
};

const mockGateway = {
  emitAlert: jest.fn(),
};

describe('AlertsService', () => {
  let service: AlertsService;

  beforeEach(() => {
    service = new AlertsService(
      mockPrisma as unknown as PrismaService,
      mockGateway as unknown as GatewayService,
    );
    jest.clearAllMocks();
  });

  describe('createAlert', () => {
    it('creates alert and emits via gateway', async () => {
      const alertData = {
        id: 'alert-1',
        alertType: AlertType.SYNC_FAILURE,
        severity: AlertSeverity.CRITICAL,
        title: 'Sync failed',
        message: 'Order ODO-001 failed',
        isResolved: false,
        createdAt: new Date(),
      };
      mockPrisma.alertLog.create.mockResolvedValueOnce(alertData);

      const result = await service.createAlert({
        alertType: AlertType.SYNC_FAILURE,
        severity: AlertSeverity.CRITICAL,
        title: 'Sync failed',
        message: 'Order ODO-001 failed',
      });

      expect(mockPrisma.alertLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          alertType: AlertType.SYNC_FAILURE,
          severity: AlertSeverity.CRITICAL,
        }),
      });
      expect(mockGateway.emitAlert).toHaveBeenCalledWith(
        expect.objectContaining({ severity: AlertSeverity.CRITICAL }),
      );
      expect(result.id).toBe('alert-1');
    });
  });

  describe('listAlerts', () => {
    it('returns all alerts with no filter', async () => {
      mockPrisma.alertLog.findMany.mockResolvedValueOnce([
        { id: 'alert-1' },
        { id: 'alert-2' },
      ]);

      const result = await service.listAlerts();

      expect(result).toHaveLength(2);
      expect(mockPrisma.alertLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('filters by severity', async () => {
      mockPrisma.alertLog.findMany.mockResolvedValueOnce([]);

      await service.listAlerts({ severity: AlertSeverity.CRITICAL });

      expect(mockPrisma.alertLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ severity: AlertSeverity.CRITICAL }),
        }),
      );
    });

    it('filters by resolved status', async () => {
      mockPrisma.alertLog.findMany.mockResolvedValueOnce([]);

      await service.listAlerts({ isResolved: false });

      expect(mockPrisma.alertLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isResolved: false }),
        }),
      );
    });
  });

  describe('resolveAlert', () => {
    it('marks alert as resolved with resolvedBy and resolvedAt', async () => {
      mockPrisma.alertLog.update.mockResolvedValueOnce({
        id: 'alert-1',
        isResolved: true,
        resolvedBy: 'user@example.com',
        resolvedAt: new Date(),
      });

      const result = await service.resolveAlert('alert-1', 'user@example.com');

      expect(mockPrisma.alertLog.update).toHaveBeenCalledWith({
        where: { id: 'alert-1' },
        data: expect.objectContaining({
          isResolved: true,
          resolvedBy: 'user@example.com',
          resolvedAt: expect.any(Date),
        }),
      });
      expect(result.isResolved).toBe(true);
    });
  });
});
