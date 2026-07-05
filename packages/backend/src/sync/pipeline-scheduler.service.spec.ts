import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus, JobType, ScopeType, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineSchedulerService } from './pipeline-scheduler.service';
import { SyncService } from './sync.service';
import { SyncControlService } from './sync-control.service';
import { CircuitBreakerService } from '../clients/circuit-breaker.service';

describe('PipelineSchedulerService', () => {
  let service: PipelineSchedulerService;
  let prisma: PrismaService;
  let syncService: SyncService;
  let circuitBreaker: CircuitBreakerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PipelineSchedulerService,
        {
          provide: PrismaService,
          useValue: {
            orderSyncQueue: {
              count: jest.fn(),
              updateMany: jest.fn(),
              groupBy: jest.fn(),
            },
            syncJob: {
              count: jest.fn().mockResolvedValue(0),
            },
          },
        },
        {
          provide: SyncService,
          useValue: {
            createSyncJob: jest.fn(),
          },
        },
        {
          provide: SyncControlService,
          useValue: {
            isEnabled: jest.fn().mockResolvedValue(true),
            markRunning: jest.fn().mockResolvedValue(undefined),
            markStopped: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CircuitBreakerService,
          useValue: {
            isAnyOpen: jest.fn().mockResolvedValue(false),
          },
        },
      ],
    }).compile();

    service = module.get<PipelineSchedulerService>(PipelineSchedulerService);
    prisma = module.get<PrismaService>(PrismaService);
    syncService = module.get<SyncService>(SyncService);
    circuitBreaker = module.get<CircuitBreakerService>(CircuitBreakerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('runAutomaticPipeline', () => {
    it('should skip if no pending orders', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(0);
      await service.runAutomaticPipeline();
      expect(syncService.createSyncJob).not.toHaveBeenCalled();
    });

    it('should create sync job for pending orders', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(100);
      jest.spyOn(syncService, 'createSyncJob').mockResolvedValue({
        id: 'test-job-id',
        totalRecords: 100,
      } as any);

      await service.runAutomaticPipeline();

      expect(syncService.createSyncJob).toHaveBeenCalledWith({
        jobType: JobType.ORDER_SYNC,
        scopeType: ScopeType.ALL,
        createdBy: 'DASHBOARD_PIPELINE',
      });
    });

    it('should not run if already running', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(100);
      (service as any).isRunning = true;
      await service.runAutomaticPipeline();
      expect(syncService.createSyncJob).not.toHaveBeenCalled();
    });

    it('should skip creating a job when the Oracle circuit breaker is open', async () => {
      jest.spyOn(circuitBreaker, 'isAnyOpen').mockResolvedValue(true);
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(100);

      await service.runAutomaticPipeline();

      expect(circuitBreaker.isAnyOpen).toHaveBeenCalledWith('oracle:');
      expect(syncService.createSyncJob).not.toHaveBeenCalled();
    });

    it('should skip when an ORDER_SYNC job is already in flight', async () => {
      jest.spyOn(prisma.syncJob, 'count').mockResolvedValue(1);
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(100);

      await service.runAutomaticPipeline();

      expect(prisma.syncJob.count).toHaveBeenCalledWith({
        where: {
          jobType: JobType.ORDER_SYNC,
          status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
        },
      });
      expect(syncService.createSyncJob).not.toHaveBeenCalled();
    });
  });

  describe('retryNegativeInventoryOrders', () => {
    it('should skip if no orders on hold', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(0);
      await service.retryNegativeInventoryOrders();
      expect(prisma.orderSyncQueue.updateMany).not.toHaveBeenCalled();
    });

    it('should reset negative inventory orders to PENDING', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(50);
      jest.spyOn(prisma.orderSyncQueue, 'updateMany').mockResolvedValue({
        count: 50,
      });

      await service.retryNegativeInventoryOrders();

      expect(prisma.orderSyncQueue.updateMany).toHaveBeenCalledWith({
        where: {
          status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
        },
        data: {
          status: SyncStatus.PENDING,
        },
      });
    });
  });

  describe('monitorPipelineHealth', () => {
    it('should check pipeline health', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'groupBy').mockResolvedValue([
        { status: SyncStatus.PENDING, _count: 500 },
        { status: SyncStatus.PROCESSING, _count: 10 },
        { status: SyncStatus.FAILED, _count: 50 },
      ] as any);

      await service.monitorPipelineHealth();

      expect(prisma.orderSyncQueue.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        _count: true,
      });
    });
  });
});
