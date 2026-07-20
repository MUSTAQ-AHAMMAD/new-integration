import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { JobStatus, JobType, ScopeType, SyncStatus } from '../database/enums';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { PIPELINE_CREATOR_ID } from '../common/constants';
import { SyncService } from './sync.service';
import { SyncControlService } from './sync-control.service';
import { CircuitBreakerService } from '../clients/circuit-breaker.service';

/**
 * PipelineSchedulerService - Automatic pipeline that mimics the Java Quartz scheduler
 *
 * Similar to VendHQIntegrationScheduler in the Java implementation, this service
 * runs scheduled jobs to automatically process orders that have been ingested
 * into the OrderSyncQueue but not yet synced to Oracle.
 *
 * Runs every 5 minutes to:
 * 1. Find all PENDING orders in OrderSyncQueue
 * 2. Create a sync job to process them
 * 3. Let the BullMQ processor handle the actual Oracle integration
 *
 * This creates an automatic pipeline: Odoo → Backup → Queue → Oracle
 * instead of requiring manual sync job creation.
 *
 * Configuration via environment variables:
 * - PIPELINE_ENABLED: Set to "false" to disable (default: "true")
 * - PIPELINE_MIN_BATCH_SIZE: Minimum orders before creating job (default: 1)
 */
@Injectable()
export class PipelineSchedulerService {
  private readonly logger = new Logger(PipelineSchedulerService.name);
  private isRunning = false;
  private readonly enabled: boolean;
  private readonly minBatchSize: number;

  constructor(
    @InjectRepository(OrderSyncQueue)
    private readonly orderSyncQueueRepo: Repository<OrderSyncQueue>,
    @InjectRepository(SyncJob)
    private readonly syncJobRepo: Repository<SyncJob>,
    private readonly syncService: SyncService,
    private readonly syncControl: SyncControlService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    // Configuration from environment variables
    this.enabled = process.env.PIPELINE_ENABLED !== 'false';
    this.minBatchSize = parseInt(
      process.env.PIPELINE_MIN_BATCH_SIZE || '1',
      10,
    );

    if (!this.enabled) {
      this.logger.warn(
        '🚫 Automatic pipeline is DISABLED (PIPELINE_ENABLED=false)',
      );
    } else {
      this.logger.log(
        `✅ Automatic pipeline is ENABLED (min batch size: ${this.minBatchSize})`,
      );
    }
  }

  /**
   * Automatic pipeline cron job - runs every 5 minutes
   * Processes all PENDING orders that have been ingested but not yet synced
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async runAutomaticPipeline(): Promise<void> {
    // Check if sync control allows this service to run
    const controlEnabled =
      await this.syncControl.isEnabled('pipeline-scheduler');
    if (!controlEnabled) {
      this.logger.debug('Pipeline scheduler is disabled, skipping cron run');
      return;
    }

    if (!this.enabled) {
      return; // Pipeline disabled via env var
    }

    if (this.isRunning) {
      this.logger.debug('Pipeline already running, skipping this cycle');
      return;
    }

    this.isRunning = true;
    await this.syncControl.markRunning('pipeline-scheduler');
    try {
      // ── Circuit-breaker fail-fast ───────────────────────────────
      // When the downstream Oracle service is unhealthy its circuit breaker is
      // OPEN. Creating new sync jobs in that state would only push more work at
      // an unavailable service and create a retry storm. Fail fast instead and
      // wait for the circuit to recover.
      if (await this.circuitBreaker.isAnyOpen('oracle:')) {
        this.logger.warn(
          '⛔ Oracle circuit breaker is OPEN — skipping automatic pipeline ' +
            'run to avoid a retry storm. Pending orders will be processed once ' +
            'the circuit recovers.',
        );
        await this.syncControl.markStopped('pipeline-scheduler', 'success');
        return;
      }

      // ── Concurrency control ─────────────────────────────────────
      // Ensure only one ORDER_SYNC job runs at a time. If a previously created
      // job is still working through the queue, skip this cycle rather than
      // stacking a second job on top of it.
      const inFlightJobs = await this.syncJobRepo.count({
        where: {
          jobType: JobType.ORDER_SYNC,
          status: In([JobStatus.PENDING, JobStatus.PROCESSING]),
        },
      });
      if (inFlightJobs > 0) {
        this.logger.debug(
          `An ORDER_SYNC job is already in progress (${inFlightJobs} active), ` +
            'skipping this cycle',
        );
        await this.syncControl.markStopped('pipeline-scheduler', 'success');
        return;
      }

      // Count how many orders are waiting to be processed
      const pendingCount = await this.orderSyncQueueRepo.count({
        where: {
          status: SyncStatus.PENDING,
          isPaid: true,
          isCancelled: false,
        },
      });

      if (pendingCount === 0) {
        this.logger.debug('No pending orders to process');
        return;
      }

      // Only create job if we have at least minBatchSize orders
      if (pendingCount < this.minBatchSize) {
        this.logger.debug(
          `Pending orders (${pendingCount}) below minimum batch size (${this.minBatchSize})`,
        );
        return;
      }

      this.logger.log(
        `🔄 Automatic pipeline triggered: ${pendingCount} pending orders found`,
      );

      // Create an automatic sync job for all pending orders
      const job = await this.syncService.createSyncJob({
        jobType: JobType.ORDER_SYNC,
        scopeType: ScopeType.ALL,
        createdBy: PIPELINE_CREATOR_ID,
      });

      this.logger.log(
        `✅ Automatic sync job created: ${job?.id} (${job?.totalRecords} orders)`,
      );
      await this.syncControl.markStopped('pipeline-scheduler', 'success');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Automatic pipeline failed: ${msg}`);
      await this.syncControl.markStopped('pipeline-scheduler', 'error');
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Process orders that failed or were skipped due to negative inventory
   * Runs at :00 and :30 of each hour (every 30 minutes)
   */
  @Cron('0 */30 * * * *')
  async retryNegativeInventoryOrders(): Promise<void> {
    try {
      const holdCount = await this.orderSyncQueueRepo.count({
        where: {
          status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
        },
      });

      if (holdCount === 0) {
        return;
      }

      this.logger.log(
        `🔄 Retrying ${holdCount} orders on negative inventory hold`,
      );

      // Reset status to PENDING so they'll be picked up by the next pipeline run
      await this.orderSyncQueueRepo.update(
        {
          status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
        },
        {
          status: SyncStatus.PENDING,
        },
      );

      this.logger.log(
        `✅ Reset ${holdCount} orders from NEGATIVE_INVENTORY_HOLD to PENDING`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Negative inventory retry failed: ${msg}`);
    }
  }

  /**
   * Health check - runs every minute to monitor pipeline health
   * Alerts if there are too many pending orders (backlog)
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async monitorPipelineHealth(): Promise<void> {
    try {
      const stats = await this.orderSyncQueueRepo
        .createQueryBuilder('q')
        .select('q.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('q.status')
        .getRawMany<{ status: SyncStatus; count: string | number }>();

      const statusCounts = Object.fromEntries(
        stats.map((s) => [s.status, Number(s.count)]),
      );

      const pending = statusCounts[SyncStatus.PENDING] || 0;
      const processing = statusCounts[SyncStatus.PROCESSING] || 0;
      const failed = statusCounts[SyncStatus.FAILED] || 0;

      // Alert if backlog is too large (more than 1000 pending orders)
      if (pending > 1000) {
        this.logger.warn(
          `⚠️ Large backlog detected: ${pending} pending orders. ` +
            `Processing: ${processing}, Failed: ${failed}`,
        );
      }

      // Alert if too many failures (more than 100 failed orders)
      if (failed > 100) {
        this.logger.warn(
          `⚠️ High failure rate: ${failed} failed orders. ` +
            `Consider investigating FailedTransaction records`,
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Pipeline health check failed: ${msg}`);
    }
  }
}
