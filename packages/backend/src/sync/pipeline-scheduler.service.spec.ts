import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator, Repository } from 'typeorm';
import { JobStatus, JobType, ScopeType, SyncStatus } from '../database/enums';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { PipelineSchedulerService } from './pipeline-scheduler.service';
import { SyncService } from './sync.service';
import { SyncControlService } from './sync-control.service';
import { CircuitBreakerService } from '../clients/circuit-breaker.service';

describe('PipelineSchedulerService', () => {
  let service: PipelineSchedulerService;
  let orderSyncQueueRepo: jest.Mocked<
    Pick<Repository<OrderSyncQueue>, 'count' | 'update' | 'createQueryBuilder'>
  >;
  let syncJobRepo: jest.Mocked<Pick<Repository<SyncJob>, 'count'>>;
  let syncService: SyncService;
  let circuitBreaker: CircuitBreakerService;
  let qb: {
    select: jest.Mock;
    addSelect: jest.Mock;
    groupBy: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(async () => {
    qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PipelineSchedulerService,
        {
          provide: getRepositoryToken(OrderSyncQueue),
          useValue: {
            count: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(qb),
          },
        },
        {
          provide: getRepositoryToken(SyncJob),
          useValue: {
            count: jest.fn().mockResolvedValue(0),
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
    orderSyncQueueRepo = module.get(getRepositoryToken(OrderSyncQueue));
    syncJobRepo = module.get(getRepositoryToken(SyncJob));
    syncService = module.get<SyncService>(SyncService);
    circuitBreaker = module.get<CircuitBreakerService>(CircuitBreakerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('runAutomaticPipeline', () => {
    it('should skip if no pending orders', async () => {
      orderSyncQueueRepo.count.mockResolvedValue(0);
      await service.runAutomaticPipeline();
      expect(syncService.createSyncJob).not.toHaveBeenCalled();
    });

    it('should create sync job for pending orders', async () => {
      orderSyncQueueRepo.count.mockResolvedValue(100);
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
      orderSyncQueueRepo.count.mockResolvedValue(100);
      (service as any).isRunning = true;
      await service.runAutomaticPipeline();
      expect(syncService.createSyncJob).not.toHaveBeenCalled();
    });

    it('should skip creating a job when the Oracle circuit breaker is open', async () => {
      jest.spyOn(circuitBreaker, 'isAnyOpen').mockResolvedValue(true);
      orderSyncQueueRepo.count.mockResolvedValue(100);

      await service.runAutomaticPipeline();

      expect(circuitBreaker.isAnyOpen).toHaveBeenCalledWith('oracle:');
      expect(syncService.createSyncJob).not.toHaveBeenCalled();
    });

    it('should skip when an ORDER_SYNC job is already in flight', async () => {
      syncJobRepo.count.mockResolvedValue(1);
      orderSyncQueueRepo.count.mockResolvedValue(100);

      await service.runAutomaticPipeline();

      expect(syncJobRepo.count).toHaveBeenCalledTimes(1);
      const [countArg] = syncJobRepo.count.mock.calls[0];
      const where = countArg!.where as unknown as {
        jobType: JobType;
        status: FindOperator<JobStatus[]>;
      };
      expect(where.jobType).toBe(JobType.ORDER_SYNC);
      const statusOp = where.status;
      expect(statusOp).toBeInstanceOf(FindOperator);
      expect(statusOp.value).toEqual([
        JobStatus.PENDING,
        JobStatus.PROCESSING,
      ]);
      expect(syncService.createSyncJob).not.toHaveBeenCalled();
    });
  });

  describe('retryNegativeInventoryOrders', () => {
    it('should skip if no orders on hold', async () => {
      orderSyncQueueRepo.count.mockResolvedValue(0);
      await service.retryNegativeInventoryOrders();
      expect(orderSyncQueueRepo.update).not.toHaveBeenCalled();
    });

    it('should reset negative inventory orders to PENDING', async () => {
      orderSyncQueueRepo.count.mockResolvedValue(50);
      orderSyncQueueRepo.update.mockResolvedValue({ affected: 50 } as any);

      await service.retryNegativeInventoryOrders();

      expect(orderSyncQueueRepo.update).toHaveBeenCalledWith(
        { status: SyncStatus.NEGATIVE_INVENTORY_HOLD },
        { status: SyncStatus.PENDING },
      );
    });
  });

  describe('monitorPipelineHealth', () => {
    it('should check pipeline health', async () => {
      qb.getRawMany.mockResolvedValue([
        { status: SyncStatus.PENDING, count: 500 },
        { status: SyncStatus.PROCESSING, count: 10 },
        { status: SyncStatus.FAILED, count: 50 },
      ]);

      await service.monitorPipelineHealth();

      expect(orderSyncQueueRepo.createQueryBuilder).toHaveBeenCalled();
      expect(qb.groupBy).toHaveBeenCalledWith('q.status');
      expect(qb.getRawMany).toHaveBeenCalled();
    });
  });
});
