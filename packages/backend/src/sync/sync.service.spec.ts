// Mock the queues module before any NestJS decorators are evaluated
jest.mock('../queues/queues.module', () => ({
  QUEUE_NAMES: {
    ORDER_SYNC: 'order-sync',
    INVENTORY_SYNC: 'inventory-sync',
    RETRY: 'retry',
    NOTIFICATIONS: 'notifications',
  },
  QueuesModule: class QueuesModule {},
}));

import { SyncService } from './sync.service';
import { JobStatus, JobType, ScopeType } from '../database/enums';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { QueuesService } from '../queues/queues.service';
import { TimezoneService } from './timezone.service';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

const mockSyncJobRepo = {
  create: jest.fn((x) => x),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  increment: jest.fn().mockResolvedValue({ affected: 1 }),
};

const mockOrderSyncQueueRepo = {
  find: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
};

const mockFailedTransactionRepo = {
  find: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
};

const mockQueues = {
  enqueueOrderSync: jest.fn(),
  getQueueStats: jest.fn(),
};

const mockTimezone = {
  getDateRangeUtc: jest.fn().mockReturnValue({
    start: new Date('2024-01-01'),
    end: new Date('2024-01-31'),
  }),
};

describe('SyncService', () => {
  let service: SyncService;

  beforeEach(() => {
    service = new SyncService(
      mockSyncJobRepo as unknown as Repository<SyncJob>,
      mockOrderSyncQueueRepo as unknown as Repository<OrderSyncQueue>,
      mockFailedTransactionRepo as unknown as Repository<FailedTransaction>,
      mockQueues as unknown as QueuesService,
      mockTimezone as unknown as TimezoneService,
    );
    jest.clearAllMocks();
    // clearAllMocks resets default implementations; re-apply the ones tests rely on
    mockSyncJobRepo.create.mockImplementation((x) => x);
    mockSyncJobRepo.update.mockResolvedValue({ affected: 1 });
    mockSyncJobRepo.increment.mockResolvedValue({ affected: 1 });
    mockOrderSyncQueueRepo.update.mockResolvedValue({ affected: 1 });
    mockFailedTransactionRepo.update.mockResolvedValue({ affected: 1 });
  });

  describe('listSyncJobs', () => {
    it('returns all jobs with no status filter', async () => {
      mockSyncJobRepo.find.mockResolvedValueOnce([{ id: 'job-1' }]);

      const result = await service.listSyncJobs();

      expect(result).toHaveLength(1);
      expect(mockSyncJobRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: undefined,
          take: 50,
        }),
      );
    });

    it('filters by status when provided', async () => {
      mockSyncJobRepo.find.mockResolvedValueOnce([]);

      await service.listSyncJobs('FAILED');

      expect(mockSyncJobRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'FAILED' },
        }),
      );
    });
  });

  describe('getSyncJob', () => {
    it('returns the job when found', async () => {
      mockSyncJobRepo.findOne.mockResolvedValueOnce({ id: 'job-1' });

      const result = await service.getSyncJob('job-1');

      expect(result.id).toBe('job-1');
    });

    it('throws NotFoundException when job is not found', async () => {
      mockSyncJobRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getSyncJob('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancelSyncJob', () => {
    it('cancels a PENDING job', async () => {
      mockSyncJobRepo.findOne.mockResolvedValueOnce({
        id: 'job-1',
        status: JobStatus.PENDING,
      });
      mockSyncJobRepo.findOne.mockResolvedValueOnce({
        id: 'job-1',
        status: JobStatus.CANCELLED,
      });

      const result = await service.cancelSyncJob('job-1');

      expect(result?.status).toBe(JobStatus.CANCELLED);
      expect(mockSyncJobRepo.update).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: JobStatus.CANCELLED }),
      );
    });

    it('throws when trying to cancel a COMPLETED job', async () => {
      mockSyncJobRepo.findOne.mockResolvedValueOnce({
        id: 'job-1',
        status: JobStatus.COMPLETED,
      });

      await expect(service.cancelSyncJob('job-1')).rejects.toThrow();
    });
  });

  describe('resolveFailedTransaction', () => {
    it('marks transaction as resolved with note', async () => {
      mockFailedTransactionRepo.findOne.mockResolvedValueOnce({
        id: 'tx-1',
        isResolved: true,
      });

      const result = await service.resolveFailedTransaction(
        'tx-1',
        'admin',
        'Fixed manually',
      );

      expect(result?.isResolved).toBe(true);
      expect(mockFailedTransactionRepo.update).toHaveBeenCalledWith(
        'tx-1',
        expect.objectContaining({
          isResolved: true,
          resolvedBy: 'admin',
          resolutionNote: 'Fixed manually',
          resolvedAt: expect.any(Date),
        }),
      );
    });
  });

  describe('createSyncJob — DATE_RANGE timezone', () => {
    it('passes the caller-supplied timezone to getDateRangeUtc', async () => {
      mockSyncJobRepo.save.mockResolvedValueOnce({ id: 'job-tz' });
      mockOrderSyncQueueRepo.find.mockResolvedValueOnce([]);
      mockSyncJobRepo.findOne.mockResolvedValueOnce({
        id: 'job-tz',
        status: 'PENDING',
      });

      await service.createSyncJob({
        jobType: JobType.ORDER_SYNC,
        scopeType: ScopeType.DATE_RANGE,
        startDate: '2024-04-01',
        endDate: '2024-04-30',
        timezone: 'Asia/Dubai',
      });

      expect(mockTimezone.getDateRangeUtc).toHaveBeenCalledWith(
        '2024-04-01',
        '2024-04-30',
        'Asia/Dubai',
      );
    });

    it('defaults to UTC when no timezone is supplied', async () => {
      mockSyncJobRepo.save.mockResolvedValueOnce({ id: 'job-utc' });
      mockOrderSyncQueueRepo.find.mockResolvedValueOnce([]);
      mockSyncJobRepo.findOne.mockResolvedValueOnce({
        id: 'job-utc',
        status: 'PENDING',
      });

      await service.createSyncJob({
        jobType: JobType.ORDER_SYNC,
        scopeType: ScopeType.DATE_RANGE,
        startDate: '2024-04-01',
        endDate: '2024-04-30',
      });

      expect(mockTimezone.getDateRangeUtc).toHaveBeenCalledWith(
        '2024-04-01',
        '2024-04-30',
        'UTC',
      );
    });
  });

  describe('createSyncJob — BRANCH_DATE_RANGE', () => {
    it('filters by both branchCode and date range', async () => {
      mockSyncJobRepo.save.mockResolvedValueOnce({ id: 'job-bdr' });
      mockOrderSyncQueueRepo.find.mockResolvedValueOnce([]);
      mockSyncJobRepo.findOne.mockResolvedValueOnce({
        id: 'job-bdr',
        status: 'PENDING',
      });

      await service.createSyncJob({
        jobType: JobType.ORDER_SYNC,
        scopeType: ScopeType.BRANCH_DATE_RANGE,
        branchCode: 'DXB',
        startDate: '2024-04-01',
        endDate: '2024-04-30',
        timezone: 'Asia/Dubai',
      });

      expect(mockOrderSyncQueueRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            branchCode: 'DXB',
          }),
        }),
      );
      expect(mockTimezone.getDateRangeUtc).toHaveBeenCalledWith(
        '2024-04-01',
        '2024-04-30',
        'Asia/Dubai',
      );
    });
  });

  describe('getQueueStats', () => {
    it('delegates to queues service', async () => {
      const stats = { orderSync: { waiting: 5, active: 2 } };
      mockQueues.getQueueStats.mockResolvedValueOnce(stats);

      const result = await service.getQueueStats();

      expect(result).toEqual(stats);
      expect(mockQueues.getQueueStats).toHaveBeenCalledTimes(1);
    });
  });

  describe('createSyncJob — counter correctness', () => {
    it('sets status to COMPLETED and completedAt when no orders match the scope', async () => {
      mockSyncJobRepo.save.mockResolvedValueOnce({ id: 'job-empty' });
      // find returns empty → no orders in scope
      mockOrderSyncQueueRepo.find.mockResolvedValueOnce([]);
      mockSyncJobRepo.findOne.mockResolvedValueOnce({
        id: 'job-empty',
        status: JobStatus.COMPLETED,
      });

      await service.createSyncJob({
        jobType: JobType.ORDER_SYNC,
        scopeType: ScopeType.ALL,
      });

      expect(mockSyncJobRepo.update).toHaveBeenCalledWith(
        'job-empty',
        expect.objectContaining({
          totalRecords: 0,
          processedRecords: 0,
          successCount: 0,
          skippedCount: 0,
          status: JobStatus.COMPLETED,
          completedAt: expect.any(Date),
        }),
      );
    });

    it('sets processedRecords=skippedCount and successCount=0 when orders are enqueued', async () => {
      mockSyncJobRepo.save.mockResolvedValueOnce({ id: 'job-enqueue' });
      const mockQueuesService = mockQueues as unknown as {
        enqueueOrderSyncBulk?: jest.Mock;
      };
      mockQueuesService.enqueueOrderSyncBulk = jest.fn().mockResolvedValue([]);

      // Two paid orders (to be enqueued), one unpaid (to be skipped)
      mockOrderSyncQueueRepo.find.mockResolvedValueOnce([
        {
          id: 'o1',
          odooOrderId: 'ORD-1',
          branchCode: 'DXB',
          isPaid: true,
          isCancelled: false,
        },
        {
          id: 'o2',
          odooOrderId: 'ORD-2',
          branchCode: 'DXB',
          isPaid: true,
          isCancelled: false,
        },
        {
          id: 'o3',
          odooOrderId: 'ORD-3',
          branchCode: 'DXB',
          isPaid: false,
          isCancelled: false,
        },
      ]);
      // Second call returns empty → pagination loop ends
      mockOrderSyncQueueRepo.find.mockResolvedValueOnce([]);
      mockOrderSyncQueueRepo.update.mockResolvedValue({ affected: 1 });
      mockSyncJobRepo.findOne.mockResolvedValueOnce({
        id: 'job-enqueue',
        status: JobStatus.PENDING,
      });

      await service.createSyncJob({
        jobType: JobType.ORDER_SYNC,
        scopeType: ScopeType.ALL,
      });

      expect(mockSyncJobRepo.update).toHaveBeenCalledWith(
        'job-enqueue',
        expect.objectContaining({
          totalRecords: 3, // 2 enqueued + 1 skipped
          processedRecords: 1, // only the 1 skipped order is immediately "done"
          successCount: 0, // no Oracle syncs have run yet
          skippedCount: 1,
          status: JobStatus.PENDING,
        }),
      );
    });
  });
});
