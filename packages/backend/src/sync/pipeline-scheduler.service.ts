import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobType, ScopeType, SyncStatus } from '@prisma/client';
import { PIPELINE_CREATOR_ID } from '../common/constants';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';
import { SyncControlService } from './sync-control.service';

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
    private readonly prisma: PrismaService,
    private readonly syncService: SyncService,
    private readonly syncControl: SyncControlService,
  ) {
    // Configuration from environment variables
    this.enabled = process.env.PIPELINE_ENABLED !== 'false';
    this.minBatchSize = parseInt(process.env.PIPELINE_MIN_BATCH_SIZE || '1', 10);

    if (!this.enabled) {
      this.logger.warn('🚫 Automatic pipeline is DISABLED (PIPELINE_ENABLED=false)');
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
    const controlEnabled = await this.syncControl.isEnabled('pipeline-scheduler');
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
      // Count how many orders are waiting to be processed
      const pendingCount = await this.prisma.orderSyncQueue.count({
        where: {
          status: SyncStatus.PENDING,
          isPaid: true,
          isCancelled: false,
        },
      });

      if (pendingCount === 0) {
        this.logger.debug('No pending orders to process');
        await this.syncControl.markStopped('pipeline-scheduler', 'success');
        return;
      }

      // Only create job if we have at least minBatchSize orders
      if (pendingCount < this.minBatchSize) {
        this.logger.debug(
          `Pending orders (${pendingCount}) below minimum batch size (${this.minBatchSize})`,
        );
        await this.syncControl.markStopped('pipeline-scheduler', 'success');
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
        `✅ Automatic sync job created: ${job.id} (${job.totalRecords} orders)`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Automatic pipeline failed: ${msg}`);
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
      const holdCount = await this.prisma.orderSyncQueue.count({
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
      await this.prisma.orderSyncQueue.updateMany({
        where: {
          status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
        },
        data: {
          status: SyncStatus.PENDING,
        },
      });

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
      const stats = await this.prisma.orderSyncQueue.groupBy({
        by: ['status'],
        _count: true,
      });

      const statusCounts = Object.fromEntries(
        stats.map((s) => [s.status, s._count]),
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
