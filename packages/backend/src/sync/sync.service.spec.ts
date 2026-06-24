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
import { JobStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { TimezoneService } from './timezone.service';
import { NotFoundException } from '@nestjs/common';

const mockPrisma = {
  syncJob: {
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  orderSyncQueue: {
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  failedTransaction: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
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
      mockPrisma as unknown as PrismaService,
      mockQueues as unknown as QueuesService,
      mockTimezone as unknown as TimezoneService,
    );
    jest.clearAllMocks();
  });

  describe('listSyncJobs', () => {
    it('returns all jobs with no status filter', async () => {
      mockPrisma.syncJob.findMany.mockResolvedValueOnce([{ id: 'job-1' }]);

      const result = await service.listSyncJobs();

      expect(result).toHaveLength(1);
      expect(mockPrisma.syncJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: undefined,
          take: 50,
        }),
      );
    });

    it('filters by status when provided', async () => {
      mockPrisma.syncJob.findMany.mockResolvedValueOnce([]);

      await service.listSyncJobs('FAILED');

      expect(mockPrisma.syncJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'FAILED' },
        }),
      );
    });
  });

  describe('getSyncJob', () => {
    it('returns the job when found', async () => {
      mockPrisma.syncJob.findUnique.mockResolvedValueOnce({ id: 'job-1' });

      const result = await service.getSyncJob('job-1');

      expect(result.id).toBe('job-1');
    });

    it('throws NotFoundException when job is not found', async () => {
      mockPrisma.syncJob.findUnique.mockResolvedValueOnce(null);

      await expect(service.getSyncJob('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancelSyncJob', () => {
    it('cancels a PENDING job', async () => {
      mockPrisma.syncJob.findUnique.mockResolvedValueOnce({
        id: 'job-1',
        status: JobStatus.PENDING,
      });
      mockPrisma.syncJob.update.mockResolvedValueOnce({
        id: 'job-1',
        status: JobStatus.CANCELLED,
      });

      const result = await service.cancelSyncJob('job-1');

      expect(result.status).toBe(JobStatus.CANCELLED);
      expect(mockPrisma.syncJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: JobStatus.CANCELLED }),
        }),
      );
    });

    it('throws when trying to cancel a COMPLETED job', async () => {
      mockPrisma.syncJob.findUnique.mockResolvedValueOnce({
        id: 'job-1',
        status: JobStatus.COMPLETED,
      });

      await expect(service.cancelSyncJob('job-1')).rejects.toThrow();
    });
  });

  describe('resolveFailedTransaction', () => {
    it('marks transaction as resolved with note', async () => {
      mockPrisma.failedTransaction.update.mockResolvedValueOnce({
        id: 'tx-1',
        isResolved: true,
      });

      const result = await service.resolveFailedTransaction(
        'tx-1',
        'admin',
        'Fixed manually',
      );

      expect(result.isResolved).toBe(true);
      expect(mockPrisma.failedTransaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-1' },
        data: expect.objectContaining({
          isResolved: true,
          resolvedBy: 'admin',
          resolutionNote: 'Fixed manually',
          resolvedAt: expect.any(Date),
        }),
      });
    });
  });

  describe('createSyncJob — DATE_RANGE timezone', () => {
    it('passes the caller-supplied timezone to getDateRangeUtc', async () => {
      mockPrisma.syncJob.create.mockResolvedValueOnce({ id: 'job-tz' });
      mockPrisma.orderSyncQueue.findMany.mockResolvedValueOnce([]);
      mockPrisma.syncJob.update.mockResolvedValueOnce({
        id: 'job-tz',
        status: 'PENDING',
      });

      await service.createSyncJob({
        jobType: 'ORDER_SYNC',
        scopeType: 'DATE_RANGE',
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
      mockPrisma.syncJob.create.mockResolvedValueOnce({ id: 'job-utc' });
      mockPrisma.orderSyncQueue.findMany.mockResolvedValueOnce([]);
      mockPrisma.syncJob.update.mockResolvedValueOnce({
        id: 'job-utc',
        status: 'PENDING',
      });

      await service.createSyncJob({
        jobType: 'ORDER_SYNC',
        scopeType: 'DATE_RANGE',
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
      mockPrisma.syncJob.create.mockResolvedValueOnce({ id: 'job-bdr' });
      mockPrisma.orderSyncQueue.findMany.mockResolvedValueOnce([]);
      mockPrisma.syncJob.update.mockResolvedValueOnce({
        id: 'job-bdr',
        status: 'PENDING',
      });

      await service.createSyncJob({
        jobType: 'ORDER_SYNC',
        scopeType: 'BRANCH_DATE_RANGE',
        branchCode: 'DXB',
        startDate: '2024-04-01',
        endDate: '2024-04-30',
        timezone: 'Asia/Dubai',
      });

      expect(mockPrisma.orderSyncQueue.findMany).toHaveBeenCalledWith(
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
      mockPrisma.syncJob.create.mockResolvedValueOnce({ id: 'job-empty' });
      // findMany returns empty → no orders in scope
      mockPrisma.orderSyncQueue.findMany.mockResolvedValueOnce([]);
      mockPrisma.syncJob.update.mockResolvedValueOnce({
        id: 'job-empty',
        status: JobStatus.COMPLETED,
      });

      await service.createSyncJob({
        jobType: 'ORDER_SYNC',
        scopeType: 'ALL',
      });

      expect(mockPrisma.syncJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalRecords: 0,
            processedRecords: 0,
            successCount: 0,
            skippedCount: 0,
            status: JobStatus.COMPLETED,
            completedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('sets processedRecords=skippedCount and successCount=0 when orders are enqueued', async () => {
      mockPrisma.syncJob.create.mockResolvedValueOnce({ id: 'job-enqueue' });
      const mockQueuesService = mockQueues as unknown as {
        enqueueOrderSyncBulk?: jest.Mock;
      };
      mockQueuesService.enqueueOrderSyncBulk = jest.fn().mockResolvedValue([]);

      // Two paid orders (to be enqueued), one unpaid (to be skipped)
      mockPrisma.orderSyncQueue.findMany.mockResolvedValueOnce([
        { id: 'o1', odooOrderId: 'ORD-1', branchCode: 'DXB', isPaid: true, isCancelled: false },
        { id: 'o2', odooOrderId: 'ORD-2', branchCode: 'DXB', isPaid: true, isCancelled: false },
        { id: 'o3', odooOrderId: 'ORD-3', branchCode: 'DXB', isPaid: false, isCancelled: false },
      ]);
      // Second call returns empty → pagination loop ends
      mockPrisma.orderSyncQueue.findMany.mockResolvedValueOnce([]);
      mockPrisma.orderSyncQueue.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.syncJob.update.mockResolvedValueOnce({
        id: 'job-enqueue',
        status: JobStatus.PENDING,
      });

      await service.createSyncJob({
        jobType: 'ORDER_SYNC',
        scopeType: 'ALL',
      });

      expect(mockPrisma.syncJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalRecords: 3,      // 2 enqueued + 1 skipped
            processedRecords: 1,  // only the 1 skipped order is immediately "done"
            successCount: 0,      // no Oracle syncs have run yet
            skippedCount: 1,
            status: JobStatus.PENDING,
          }),
        }),
      );
    });
  });
});
