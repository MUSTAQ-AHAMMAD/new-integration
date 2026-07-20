import { Repository } from 'typeorm';
import { AlertsService } from './alerts.service';
import { AlertSeverity, AlertType } from '../database/enums';
import { AlertLog } from '../database/entities/alert-log.entity';
import { GatewayService } from '../gateway/gateway.service';

const mockRepo = {
  create: jest.fn(),
  save: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  update: jest.fn(),
};

const mockGateway = {
  emitAlert: jest.fn(),
};

describe('AlertsService', () => {
  let service: AlertsService;

  beforeEach(() => {
    service = new AlertsService(
      mockRepo as unknown as Repository<AlertLog>,
      mockGateway as unknown as GatewayService,
    );
    jest.clearAllMocks();
    mockRepo.create.mockImplementation((x) => x as AlertLog);
    mockRepo.save.mockImplementation((x) => Promise.resolve(x as AlertLog));
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
      mockRepo.findOne.mockResolvedValueOnce(null); // no dedup match
      mockRepo.save.mockResolvedValueOnce(alertData);

      const result = await service.createAlert({
        alertType: AlertType.SYNC_FAILURE,
        severity: AlertSeverity.CRITICAL,
        title: 'Sync failed',
        message: 'Order ODO-001 failed',
      });

      expect(mockRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          alertType: AlertType.SYNC_FAILURE,
          severity: AlertSeverity.CRITICAL,
        }),
      );
      expect(mockGateway.emitAlert).toHaveBeenCalledWith(
        expect.objectContaining({ severity: AlertSeverity.CRITICAL }),
      );
      expect(result.id).toBe('alert-1');
    });

    it('deduplicates an identical unresolved alert without creating a new one', async () => {
      mockRepo.findOne.mockResolvedValueOnce({ id: 'existing-1' });

      const result = await service.createAlert({
        alertType: AlertType.SYNC_FAILURE,
        severity: AlertSeverity.CRITICAL,
        title: 'Sync failed',
        message: 'Order ODO-001 failed',
      });

      expect(mockRepo.save).not.toHaveBeenCalled();
      expect(mockGateway.emitAlert).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'existing-1' });
    });
  });

  describe('listAlerts', () => {
    it('returns all alerts with no filter', async () => {
      mockRepo.find.mockResolvedValueOnce([{ id: 'alert-1' }, { id: 'alert-2' }]);

      const result = await service.listAlerts();

      expect(result).toHaveLength(2);
      expect(mockRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('filters by severity', async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      await service.listAlerts({ severity: AlertSeverity.CRITICAL });

      expect(mockRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ severity: AlertSeverity.CRITICAL }),
        }),
      );
    });

    it('filters by resolved status', async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      await service.listAlerts({ isResolved: false });

      expect(mockRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isResolved: false }),
        }),
      );
    });
  });

  describe('resolveAlert', () => {
    it('marks alert as resolved with resolvedBy and resolvedAt', async () => {
      mockRepo.update.mockResolvedValueOnce({ affected: 1 });
      mockRepo.findOne.mockResolvedValueOnce({
        id: 'alert-1',
        isResolved: true,
        resolvedBy: 'user@example.com',
        resolvedAt: new Date(),
      });

      const result = await service.resolveAlert('alert-1', 'user@example.com');

      expect(mockRepo.update).toHaveBeenCalledWith(
        'alert-1',
        expect.objectContaining({
          isResolved: true,
          resolvedBy: 'user@example.com',
          resolvedAt: expect.any(Date),
        }),
      );
      expect(result!.isResolved).toBe(true);
    });
  });
});
