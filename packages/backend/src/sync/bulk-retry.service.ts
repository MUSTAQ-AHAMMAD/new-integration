import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncStatus } from '../database/enums';
import { QueuesService } from '../queues/queues.service';

/**
 * Bulk retry service for processing thousands of failed transactions
 * with proper ordering, duplicate detection, and progress tracking
 */
@Injectable()
export class BulkRetryService {
  private readonly logger = new Logger(BulkRetryService.name);

  constructor(
    @InjectRepository(OrderSyncQueue)
    private readonly orderSyncQueueRepo: Repository<OrderSyncQueue>,
    private readonly queuesService: QueuesService,
  ) {}

  /**
   * Retry all failed transactions atomically
   * Handles 5000+ transactions with FIFO ordering and duplicate detection
   */
  async retryAllFailed(options?: {
    maxTransactions?: number;
    dryRun?: boolean;
    priorityBranches?: string[];
  }): Promise<{
    totalFailed: number;
    queued: number;
    skipped: number;
    errors: string[];
    dryRun: boolean;
  }> {
    const {
      maxTransactions = 10000,
      dryRun = false,
      priorityBranches = [],
    } = options || {};

    this.logger.log('=== BULK RETRY: All Failed Transactions ===');
    this.logger.log(`Mode: ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
    this.logger.log(`Max transactions: ${maxTransactions}`);

    const errors: string[] = [];
    let queued = 0;
    let skipped = 0;

    try {
      // === STEP 1: IDENTIFY FAILED TRANSACTIONS ===
      this.logger.log('Step 1/5: Identifying failed transactions...');

      const failedOrders = await this.orderSyncQueueRepo.find({
        where: {
          status: SyncStatus.FAILED,
        },
        order: {
          createdAt: 'ASC', // FIFO ordering
        },
        take: maxTransactions,
        select: {
          id: true,
          odooOrderId: true,
          branchCode: true,
          status: true,
          syncAttempts: true,
          createdAt: true,
        },
      });

      this.logger.log(`Found ${failedOrders.length} failed transactions`);

      if (failedOrders.length === 0) {
        return {
          totalFailed: 0,
          queued: 0,
          skipped: 0,
          errors: [],
          dryRun,
        };
      }

      // === STEP 2: PRIORITY SORTING ===
      this.logger.log('Step 2/5: Applying priority sorting...');

      const sortedOrders = [
        ...failedOrders.filter((o) => priorityBranches.includes(o.branchCode)),
        ...failedOrders.filter((o) => !priorityBranches.includes(o.branchCode)),
      ];

      this.logger.log(
        `Sorted ${sortedOrders.length} transactions (${priorityBranches.length} priority branches)`,
      );

      // === DRY-RUN MODE ===
      if (dryRun) {
        this.logger.log('DRY-RUN MODE: Showing what would be retried...');

        const preview = sortedOrders.slice(0, 10).map((order) => ({
          odooOrderId: order.odooOrderId,
          branchCode: order.branchCode,
          status: order.status,
          syncAttempts: order.syncAttempts,
        }));

        this.logger.log('Preview (first 10):');
        console.table(preview);

        return {
          totalFailed: sortedOrders.length,
          queued: sortedOrders.length,
          skipped: 0,
          errors: [],
          dryRun: true,
        };
      }

      // === STEP 3: DUPLICATE DETECTION ===
      this.logger.log('Step 3/5: Checking for duplicates...');

      const orderIds = sortedOrders.map((o) => o.odooOrderId);
      const alreadyQueued = await this.orderSyncQueueRepo.find({
        where: {
          odooOrderId: In(orderIds),
          status: SyncStatus.QUEUED_FOR_RETRY,
        },
        select: { odooOrderId: true },
      });

      const queuedOrderIds = new Set(alreadyQueued.map((o) => o.odooOrderId));
      const ordersToRetry = sortedOrders.filter(
        (o) => !queuedOrderIds.has(o.odooOrderId),
      );

      this.logger.log(
        `Filtered out ${queuedOrderIds.size} already queued orders`,
      );
      this.logger.log(`Will retry ${ordersToRetry.length} orders`);

      // === STEP 4: ATOMIC RETRY QUEUEING ===
      this.logger.log('Step 4/5: Queueing transactions for retry...');

      // Process in batches of 50 to avoid overwhelming the queue
      const BATCH_SIZE = 50;

      for (let i = 0; i < ordersToRetry.length; i += BATCH_SIZE) {
        const batch = ordersToRetry.slice(i, i + BATCH_SIZE);

        await this.orderSyncQueueRepo.manager.transaction(async (mgr) => {
          const txRepo = mgr.getRepository(OrderSyncQueue);
          for (const order of batch) {
            try {
              // Update status to QUEUED_FOR_RETRY and bump syncAttempts by 1.
              await txRepo
                .createQueryBuilder()
                .update(OrderSyncQueue)
                .set({
                  status: SyncStatus.QUEUED_FOR_RETRY,
                  syncAttempts: () => '"syncAttempts" + 1',
                  updatedAt: new Date(),
                })
                .where('id = :id', { id: order.id })
                .execute();

              // Add to BullMQ queue
              await this.queuesService.enqueueOrderSync({
                orderSyncQueueId: order.id,
                odooOrderId: order.odooOrderId,
                branchCode: order.branchCode,
              });

              queued++;

              if (queued % 100 === 0) {
                this.logger.log(
                  `Progress: ${queued}/${ordersToRetry.length} queued`,
                );
              }
            } catch (err) {
              const errorMsg = `Failed to queue order ${order.odooOrderId}: ${err instanceof Error ? err.message : String(err)}`;
              errors.push(errorMsg);
              this.logger.error(errorMsg);
              skipped++;
            }
          }
        });
      }

      // === STEP 5: VERIFY ===
      this.logger.log('Step 5/5: Verifying queue status...');

      const nowQueued = await this.orderSyncQueueRepo.count({
        where: {
          status: SyncStatus.QUEUED_FOR_RETRY,
        },
      });

      this.logger.log(
        `✅ Queue status: ${nowQueued} orders waiting for processing`,
      );
      this.logger.log(
        `✅ Bulk retry complete: ${queued} queued, ${skipped} skipped`,
      );

      return {
        totalFailed: sortedOrders.length,
        queued,
        skipped,
        errors,
        dryRun: false,
      };
    } catch (error) {
      this.logger.error('❌ Bulk retry failed:', error);
      errors.push(error instanceof Error ? error.message : String(error));

      return {
        totalFailed: 0,
        queued,
        skipped,
        errors,
        dryRun: false,
      };
    }
  }

  /**
   * Retry failed transactions for specific branches
   */
  async retryForBranches(branchCodes: string[], dryRun = false): Promise<any> {
    this.logger.log(
      `Retrying failed transactions for branches: ${branchCodes.join(', ')}`,
    );

    return this.retryAllFailed({
      priorityBranches: branchCodes,
      dryRun,
    });
  }

  /**
   * Get failed transaction statistics
   */
  async getFailedStats(): Promise<{
    totalFailed: number;
    byStatus: Record<string, number>;
    byBranch: Array<{ branchCode: string; count: number }>;
    oldestFailed: Date | null;
  }> {
    const [totalFailed, byStatus, byBranch, oldestOrder] = await Promise.all([
      this.orderSyncQueueRepo.count({
        where: {
          status: SyncStatus.FAILED,
        },
      }),
      this.orderSyncQueueRepo
        .createQueryBuilder('o')
        .select('o.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('o.status = :status', { status: SyncStatus.FAILED })
        .groupBy('o.status')
        .getRawMany<{ status: string; count: string | number }>(),
      this.orderSyncQueueRepo
        .createQueryBuilder('o')
        .select('o.branchCode', 'branchCode')
        .addSelect('COUNT(*)', 'count')
        .where('o.status = :status', { status: SyncStatus.FAILED })
        .groupBy('o.branchCode')
        .orderBy('count', 'DESC')
        .limit(10)
        .getRawMany<{ branchCode: string; count: string | number }>(),
      this.orderSyncQueueRepo.findOne({
        where: {
          status: SyncStatus.FAILED,
        },
        order: { createdAt: 'ASC' },
        select: { createdAt: true },
      }),
    ]);

    return {
      totalFailed,
      byStatus: Object.fromEntries(
        byStatus.map((s) => [s.status, Number(s.count)]),
      ),
      byBranch: byBranch.map((b) => ({
        branchCode: b.branchCode,
        count: Number(b.count),
      })),
      oldestFailed: oldestOrder?.createdAt || null,
    };
  }
}
