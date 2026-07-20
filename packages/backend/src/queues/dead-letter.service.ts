import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { Queue } from 'bull';
import { AlertSeverity, AlertType, ErrorType, SyncStatus } from '../database/enums';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { AlertsService } from '../alerts/alerts.service';
import { GatewayService } from '../gateway/gateway.service';
import { QUEUE_NAMES } from './queues.constants';

export interface DeadLetterEntry {
  orderId: string;
  branchCode: string;
  errorType: ErrorType;
  errorMessage: string;
  errorStack?: string;
  attempts: number;
  originalPayload: any;
  firstFailedAt: Date;
  lastFailedAt: Date;
}

@Injectable()
export class DeadLetterQueueService {
  private readonly logger = new Logger(DeadLetterQueueService.name);
  private readonly MAX_RETRY_ATTEMPTS = 5;
  private readonly BACKOFF_BASE_MS = 5000; // 5 seconds

  constructor(
    @InjectRepository(OrderSyncQueue)
    private readonly orders: Repository<OrderSyncQueue>,
    @InjectRepository(FailedTransaction)
    private readonly failedTransactions: Repository<FailedTransaction>,
    private readonly alertsService: AlertsService,
    private readonly gateway: GatewayService,
    @InjectQueue(QUEUE_NAMES.ORDER_SYNC) private readonly orderSyncQueue: Queue,
  ) {}

  /**
   * Move a failed order to dead-letter queue after max retries exceeded
   */
  async moveToDeadLetter(
    odooOrderId: string,
    branchCode: string,
    error: {
      type: ErrorType;
      message: string;
      stack?: string;
      code?: string;
    },
    attempts: number,
    originalPayload: any,
  ): Promise<void> {
    this.logger.error(
      `Moving order ${odooOrderId} to dead-letter queue after ${attempts} attempts. Error: ${error.message}`,
    );

    try {
      // Update order status to FAILED with detailed error info
      await this.orders.update(
        { odooOrderId, branchCode },
        {
          status: SyncStatus.FAILED,
          validationErrors: {
            errorType: error.type,
            errorMessage: error.message,
            errorCode: error.code,
            attempts,
            deadLetterAt: new Date().toISOString(),
          },
        },
      );

      // Create failed transaction record
      await this.failedTransactions.save(
        this.failedTransactions.create({
          orderSyncQueueId: originalPayload.id,
          originalPayload,
          errorType: error.type,
          errorMessage: error.message,
          errorStack: error.stack ?? null,
          errorCode: error.code ?? null,
          retryCount: attempts,
          maxRetries: this.MAX_RETRY_ATTEMPTS,
          isResolved: false,
        }),
      );

      // Create alert for critical failure
      await this.alertsService.createAlert({
        alertType: AlertType.SYNC_FAILURE,
        severity: AlertSeverity.CRITICAL,
        title: `Order ${odooOrderId} moved to dead-letter queue`,
        message: `Order failed after ${attempts} retry attempts. Error: ${error.message}. Manual intervention required.`,
        relatedEntityId: odooOrderId,
        relatedEntityType: 'ORDER_SYNC_QUEUE',
      });

      // Emit real-time update
      this.gateway.emitOrderStatus({
        orderId: odooOrderId,
        status: SyncStatus.FAILED,
      });

      this.logger.log(
        `Order ${odooOrderId} successfully moved to dead-letter queue`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to move order ${odooOrderId} to dead-letter queue: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  calculateBackoffDelay(attempt: number): number {
    // Exponential backoff: 5s, 10s, 20s, 40s, 80s
    const exponentialDelay = this.BACKOFF_BASE_MS * Math.pow(2, attempt);
    // Add jitter (±20%) to prevent thundering herd
    const jitter = exponentialDelay * 0.2 * (Math.random() - 0.5);
    const finalDelay = exponentialDelay + jitter;

    // Cap at 5 minutes
    return Math.min(finalDelay, 300000);
  }

  /**
   * Check if order should be moved to dead-letter queue
   */
  shouldMoveToDeadLetter(attempts: number): boolean {
    return attempts >= this.MAX_RETRY_ATTEMPTS;
  }

  /**
   * Retrieve all dead-letter orders with pagination
   */
  async getDeadLetterOrders(options: {
    page?: number;
    pageSize?: number;
    errorType?: ErrorType;
    branchCode?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const page = options.page || 1;
    const pageSize = options.pageSize || 50;
    const skip = (page - 1) * pageSize;

    const where: Record<string, unknown> = {
      status: SyncStatus.FAILED,
      syncAttempts: MoreThanOrEqual(this.MAX_RETRY_ATTEMPTS),
    };

    if (options.branchCode) {
      where.branchCode = options.branchCode;
    }

    if (options.startDate && options.endDate) {
      where.createdAt = Between(options.startDate, options.endDate);
    } else if (options.startDate) {
      where.createdAt = MoreThanOrEqual(options.startDate);
    } else if (options.endDate) {
      where.createdAt = LessThanOrEqual(options.endDate);
    }

    const [orders, total] = await this.orders.findAndCount({
      where,
      skip,
      take: pageSize,
      order: { createdAt: 'DESC' },
      relations: { failedTransactions: true },
    });

    // Match Prisma's `failedTransactions: { orderBy desc, take 1 }` — keep only
    // the most recent failed transaction per order.
    const data = orders.map((order) => ({
      ...order,
      failedTransactions: [...(order.failedTransactions ?? [])]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 1),
    }));

    return {
      data,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  /**
   * Manually retry a dead-letter order
   */
  async retryDeadLetterOrder(
    orderId: string,
    branchCode: string,
  ): Promise<void> {
    this.logger.log(`Manual retry requested for dead-letter order: ${orderId}`);

    const order = await this.orders.findOne({
      where: { odooOrderId: orderId, branchCode },
    });

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (order.status !== SyncStatus.FAILED) {
      throw new Error(`Order ${orderId} is not in FAILED status`);
    }

    // Reset order status and retry count
    await this.orders.update(order.id, {
      status: SyncStatus.PENDING,
      syncAttempts: 0,
      validationErrors: null as never,
    });

    // Enqueue for retry
    await this.orderSyncQueue.add('sync', {
      orderSyncQueueId: order.id,
      odooOrderId: order.odooOrderId,
      branchCode: order.branchCode,
      isRetry: true,
    });

    this.logger.log(`Order ${orderId} re-queued for retry`);
  }

  /**
   * Bulk retry dead-letter orders
   */
  async retryDeadLetterOrdersBulk(options: {
    errorType?: ErrorType;
    branchCode?: string;
    orderIds?: string[];
    limit?: number;
  }): Promise<{ queued: number; failed: number }> {
    this.logger.log('Bulk retry of dead-letter orders requested', options);

    const qb = this.orders
      .createQueryBuilder('o')
      .where('o.status = :status', { status: SyncStatus.FAILED })
      .andWhere('o.syncAttempts >= :maxAttempts', {
        maxAttempts: this.MAX_RETRY_ATTEMPTS,
      });

    // Only orders that have a failed transaction of the requested error type.
    if (options.errorType) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM "FailedTransaction" ft ` +
          `WHERE ft."orderSyncQueueId" = o.id AND ft."errorType" = :errorType)`,
        { errorType: options.errorType },
      );
    }

    if (options.branchCode) {
      qb.andWhere('o.branchCode = :branchCode', {
        branchCode: options.branchCode,
      });
    }

    if (options.orderIds && options.orderIds.length > 0) {
      qb.andWhere('o.odooOrderId IN (:...orderIds)', {
        orderIds: options.orderIds,
      });
    }

    const orders = await qb
      .orderBy('o.createdAt', 'ASC')
      .take(options.limit || 100)
      .getMany();

    let queued = 0;
    let failed = 0;

    for (const order of orders) {
      try {
        await this.retryDeadLetterOrder(order.odooOrderId, order.branchCode);
        queued++;
      } catch (err) {
        this.logger.error(
          `Failed to retry order ${order.odooOrderId}: ${(err as Error).message}`,
        );
        failed++;
      }
    }

    this.logger.log(`Bulk retry complete: ${queued} queued, ${failed} failed`);

    return { queued, failed };
  }

  /**
   * Classify error as transient or permanent
   */
  isTransientError(errorType: ErrorType): boolean {
    const transientErrors: ErrorType[] = [
      ErrorType.NETWORK_ERROR,
      ErrorType.TIMEOUT,
      ErrorType.RATE_LIMIT_ERROR,
    ];

    return transientErrors.includes(errorType);
  }

  /**
   * Get dead-letter queue statistics
   */
  async getStatistics(): Promise<{
    totalDeadLetters: number;
    byErrorType: Record<ErrorType, number>;
    byBranch: Array<{ branchCode: string; count: number }>;
    oldestEntry: Date | null;
    newestEntry: Date | null;
  }> {
    const deadLetters = await this.orders.find({
      where: {
        status: SyncStatus.FAILED,
        syncAttempts: MoreThanOrEqual(this.MAX_RETRY_ATTEMPTS),
      },
      relations: { failedTransactions: true },
    });

    const byErrorType: Record<ErrorType, number> = {} as Record<
      ErrorType,
      number
    >;
    const branchCounts: Record<string, number> = {};
    let oldestEntry: Date | null = null;
    let newestEntry: Date | null = null;

    for (const order of deadLetters) {
      // Count by error type — use the most recent failed transaction.
      const latest = [...(order.failedTransactions ?? [])].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      )[0];
      const errorType = latest?.errorType;
      if (errorType) {
        byErrorType[errorType] = (byErrorType[errorType] || 0) + 1;
      }

      // Count by branch
      branchCounts[order.branchCode] =
        (branchCounts[order.branchCode] || 0) + 1;

      // Track oldest/newest
      if (!oldestEntry || order.createdAt < oldestEntry) {
        oldestEntry = order.createdAt;
      }
      if (!newestEntry || order.createdAt > newestEntry) {
        newestEntry = order.createdAt;
      }
    }

    const byBranch = Object.entries(branchCounts)
      .map(([branchCode, count]) => ({ branchCode, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalDeadLetters: deadLetters.length,
      byErrorType,
      byBranch,
      oldestEntry,
      newestEntry,
    };
  }
}
