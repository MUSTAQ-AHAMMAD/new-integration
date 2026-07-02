import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PipelineSchedulerService } from './pipeline-scheduler.service';
import { OrderSyncService } from './order-sync.service';
import { SyncControlService } from '../settings/settings.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Pipeline Scheduler Integration Tests
 * 
 * Tests automatic pipeline triggers for PENDING orders:
 * - Pipeline respects SyncControl enable/disable
 * - Min batch size threshold validation
 * - Concurrent execution prevention
 * - Per-region pipeline scheduling
 */
describe('PipelineSchedulerService Integration', () => {
  let scheduler: PipelineSchedulerService;
  let orderSync: OrderSyncService;
  let syncControl: SyncControlService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PipelineSchedulerService,
        {
          provide: OrderSyncService,
          useValue: {
            processOrdersInQueue: jest.fn().mockResolvedValue({
              processed: 10,
              succeeded: 8,
              failed: 2,
            }),
          },
        },
        {
          provide: SyncControlService,
          useValue: {
            isSyncEnabled: jest.fn().mockResolvedValue(true),
            getMinBatchSize: jest.fn().mockResolvedValue(5),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            orderSyncQueue: {
              count: jest.fn().mockResolvedValue(10),
              findMany: jest.fn().mockResolvedValue([]),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, any> = {
                REGIONS: 'AE,SA,OM,KW',
                MIN_BATCH_SIZE: 5,
                PIPELINE_INTERVAL_MINUTES: 5,
              };
              return config[key];
            }),
          },
        },
      ],
    }).compile();

    scheduler = module.get<PipelineSchedulerService>(PipelineSchedulerService);
    orderSync = module.get<OrderSyncService>(OrderSyncService);
    syncControl = module.get<SyncControlService>(SyncControlService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Automatic Pipeline Triggers', () => {
    it('should trigger pipeline when PENDING orders exceed min batch size', async () => {
      // Arrange: Mock 10 pending orders (exceeds min batch size of 5)
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(10);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      // Act: Run pipeline scheduler
      await scheduler.handlePipelineSchedule();

      // Assert: Verify pipeline was triggered for all regions
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledTimes(4); // AE, SA, OM, KW
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('AE');
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('SA');
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('OM');
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('KW');
    });

    it('should NOT trigger pipeline when PENDING orders below min batch size', async () => {
      // Arrange: Mock 3 pending orders (below min batch size of 5)
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(3);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      // Act: Run pipeline scheduler
      await scheduler.handlePipelineSchedule();

      // Assert: Verify pipeline was NOT triggered
      expect(orderSync.processOrdersInQueue).not.toHaveBeenCalled();
    });

    it('should NOT trigger pipeline when sync is disabled', async () => {
      // Arrange: Mock 10 pending orders but sync disabled
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(10);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(false);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      // Act: Run pipeline scheduler
      await scheduler.handlePipelineSchedule();

      // Assert: Verify pipeline was NOT triggered
      expect(orderSync.processOrdersInQueue).not.toHaveBeenCalled();
    });

    it('should trigger pipeline immediately when min batch size is 0', async () => {
      // Arrange: Mock 1 pending order with min batch size 0
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(1);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(0);

      // Act: Run pipeline scheduler
      await scheduler.handlePipelineSchedule();

      // Assert: Verify pipeline was triggered
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledTimes(4);
    });
  });

  describe('SyncControl Integration', () => {
    it('should respect sync enable/disable toggle', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(10);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      // Test: Sync enabled
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      await scheduler.handlePipelineSchedule();
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledTimes(4);

      jest.clearAllMocks();

      // Test: Sync disabled
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(false);
      await scheduler.handlePipelineSchedule();
      expect(orderSync.processOrdersInQueue).not.toHaveBeenCalled();
    });

    it('should use dynamic min batch size from SyncControl', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(7);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);

      // Test: Min batch size 10 (7 orders below threshold)
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(10);
      await scheduler.handlePipelineSchedule();
      expect(orderSync.processOrdersInQueue).not.toHaveBeenCalled();

      jest.clearAllMocks();

      // Test: Min batch size 5 (7 orders above threshold)
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);
      await scheduler.handlePipelineSchedule();
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledTimes(4);
    });

    it('should handle SyncControl errors gracefully', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(10);
      jest
        .spyOn(syncControl, 'isSyncEnabled')
        .mockRejectedValue(new Error('Database connection failed'));

      // Act: Run pipeline scheduler
      await expect(scheduler.handlePipelineSchedule()).rejects.toThrow(
        'Database connection failed',
      );

      // Assert: Verify pipeline was NOT triggered
      expect(orderSync.processOrdersInQueue).not.toHaveBeenCalled();
    });
  });

  describe('Concurrent Execution Prevention', () => {
    it('should prevent concurrent pipeline execution for same region', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(10);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      // Mock slow processing (5 seconds)
      jest
        .spyOn(orderSync, 'processOrdersInQueue')
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 5000)));

      // Act: Trigger two pipelines concurrently
      const promise1 = scheduler.handlePipelineSchedule();
      const promise2 = scheduler.handlePipelineSchedule();

      await Promise.all([promise1, promise2]);

      // Assert: Verify pipeline was only triggered once per region
      // (second call should be skipped due to lock)
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledTimes(4);
    });

    it('should allow concurrent execution for different regions', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(10);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      // Mock slow processing
      jest
        .spyOn(orderSync, 'processOrdersInQueue')
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 1000)));

      // Act: Trigger pipeline (will process AE, SA, OM, KW in parallel)
      await scheduler.handlePipelineSchedule();

      // Assert: Verify all regions were processed
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('AE');
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('SA');
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('OM');
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('KW');
    });
  });

  describe('Per-Region Pipeline Scheduling', () => {
    it('should process each region independently', async () => {
      // Arrange: Mock different pending counts per region
      jest
        .spyOn(prisma.orderSyncQueue, 'count')
        .mockImplementation((args: any) => {
          const region = args?.where?.region;
          const counts: Record<string, number> = {
            AE: 10, // Above threshold
            SA: 3, // Below threshold
            OM: 7, // Above threshold
            KW: 2, // Below threshold
          };
          return Promise.resolve(counts[region] || 0);
        });

      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      // Act: Run pipeline scheduler
      await scheduler.handlePipelineSchedule();

      // Assert: Verify only AE and OM were processed (above threshold)
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('AE');
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('OM');
      expect(orderSync.processOrdersInQueue).not.toHaveBeenCalledWith('SA');
      expect(orderSync.processOrdersInQueue).not.toHaveBeenCalledWith('KW');
    });

    it('should continue processing other regions if one fails', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(10);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      // Mock: AE region fails, others succeed
      jest
        .spyOn(orderSync, 'processOrdersInQueue')
        .mockImplementation((region: string) => {
          if (region === 'AE') {
            return Promise.reject(new Error('AE region database error'));
          }
          return Promise.resolve({
            processed: 10,
            succeeded: 10,
            failed: 0,
          });
        });

      // Act: Run pipeline scheduler
      await scheduler.handlePipelineSchedule();

      // Assert: Verify all regions were attempted
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('AE');
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('SA');
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('OM');
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledWith('KW');
    });

    it('should log region processing results', async () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(10);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      jest.spyOn(orderSync, 'processOrdersInQueue').mockResolvedValue({
        processed: 10,
        succeeded: 8,
        failed: 2,
      } as any);

      // Act: Run pipeline scheduler
      await scheduler.handlePipelineSchedule();

      // Assert: Verify logging
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Pipeline completed for region'),
      );

      consoleLogSpy.mockRestore();
    });
  });

  describe('Error Handling', () => {
    it('should handle database connection errors', async () => {
      jest
        .spyOn(prisma.orderSyncQueue, 'count')
        .mockRejectedValue(new Error('Database connection timeout'));
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);

      // Act & Assert: Should throw error
      await expect(scheduler.handlePipelineSchedule()).rejects.toThrow(
        'Database connection timeout',
      );
    });

    it('should handle pipeline processing errors', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(10);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      jest
        .spyOn(orderSync, 'processOrdersInQueue')
        .mockRejectedValue(new Error('Oracle SOAP service unavailable'));

      // Act: Run pipeline scheduler
      await scheduler.handlePipelineSchedule();

      // Assert: Error should be logged but not thrown
      expect(orderSync.processOrdersInQueue).toHaveBeenCalled();
    });

    it('should handle invalid region configuration', async () => {
      const moduleWithInvalidRegions: TestingModule =
        await Test.createTestingModule({
          providers: [
            PipelineSchedulerService,
            {
              provide: OrderSyncService,
              useValue: {
                processOrdersInQueue: jest.fn(),
              },
            },
            {
              provide: SyncControlService,
              useValue: {
                isSyncEnabled: jest.fn().mockResolvedValue(true),
                getMinBatchSize: jest.fn().mockResolvedValue(5),
              },
            },
            {
              provide: PrismaService,
              useValue: {
                orderSyncQueue: {
                  count: jest.fn().mockResolvedValue(10),
                },
              },
            },
            {
              provide: ConfigService,
              useValue: {
                get: jest.fn((key: string) => {
                  if (key === 'REGIONS') {
                    return ''; // Empty regions
                  }
                  return undefined;
                }),
              },
            },
          ],
        }).compile();

      const schedulerWithInvalidConfig =
        moduleWithInvalidRegions.get<PipelineSchedulerService>(
          PipelineSchedulerService,
        );

      // Act: Run pipeline scheduler with no regions
      await schedulerWithInvalidConfig.handlePipelineSchedule();

      // Assert: No processing should occur
      const orderSyncService =
        moduleWithInvalidRegions.get<OrderSyncService>(OrderSyncService);
      expect(orderSyncService.processOrdersInQueue).not.toHaveBeenCalled();
    });
  });

  describe('Performance and Timing', () => {
    it('should complete within acceptable time for all regions', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(10);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      jest.spyOn(orderSync, 'processOrdersInQueue').mockResolvedValue({
        processed: 10,
        succeeded: 10,
        failed: 0,
      } as any);

      const startTime = Date.now();

      // Act: Run pipeline scheduler
      await scheduler.handlePipelineSchedule();

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Assert: Should complete within 5 seconds (parallel processing)
      expect(duration).toBeLessThan(5000);
    });

    it('should handle large batch sizes efficiently', async () => {
      jest.spyOn(prisma.orderSyncQueue, 'count').mockResolvedValue(1000);
      jest.spyOn(syncControl, 'isSyncEnabled').mockResolvedValue(true);
      jest.spyOn(syncControl, 'getMinBatchSize').mockResolvedValue(5);

      jest.spyOn(orderSync, 'processOrdersInQueue').mockResolvedValue({
        processed: 1000,
        succeeded: 995,
        failed: 5,
      } as any);

      // Act: Run pipeline scheduler
      await scheduler.handlePipelineSchedule();

      // Assert: Verify all regions processed
      expect(orderSync.processOrdersInQueue).toHaveBeenCalledTimes(4);
    });
  });
});
