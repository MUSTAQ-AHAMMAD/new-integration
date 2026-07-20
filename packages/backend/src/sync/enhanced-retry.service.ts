import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, MoreThanOrEqual, Repository } from 'typeorm';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { ErrorType, SyncStatus } from '../database/enums';
import { QueuesService } from '../queues/queues.service';
import { DeadLetterQueueService } from '../queues/dead-letter.service';
import { CircuitBreakerService } from '../clients/circuit-breaker.service';

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
}

export interface RetryResult {
  success: boolean;
  attempts: number;
  lastError?: {
    type: ErrorType;
    message: string;
    code?: string;
  };
  movedToDeadLetter: boolean;
}

@Injectable()
export class EnhancedRetryService {
  private readonly logger = new Logger(EnhancedRetryService.name);

  // Default retry configuration
  private readonly defaultConfig: RetryConfig = {
    maxAttempts: 5,
    baseDelayMs: 5000, // 5 seconds
    maxDelayMs: 300000, // 5 minutes
    backoffMultiplier: 2, // Exponential backoff
    jitterFactor: 0.2, // ±20% jitter
  };

  // Error-specific retry configurations
  private readonly errorConfigs: Partial<Record<ErrorType, RetryConfig>> = {
    [ErrorType.RATE_LIMIT_ERROR]: {
      maxAttempts: 10,
      baseDelayMs: 30000, // 30 seconds
      maxDelayMs: 600000, // 10 minutes
      backoffMultiplier: 2,
      jitterFactor: 0.3,
    },
    [ErrorType.NETWORK_ERROR]: {
      maxAttempts: 7,
      baseDelayMs: 10000, // 10 seconds
      maxDelayMs: 300000, // 5 minutes
      backoffMultiplier: 2,
      jitterFactor: 0.2,
    },
    [ErrorType.TIMEOUT]: {
      maxAttempts: 6,
      baseDelayMs: 15000, // 15 seconds
      maxDelayMs: 300000, // 5 minutes
      backoffMultiplier: 2,
      jitterFactor: 0.2,
    },
    // Permanent errors - don't retry
    [ErrorType.VALIDATION_ERROR]: {
      maxAttempts: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
      jitterFactor: 0,
    },
    [ErrorType.AUTHENTICATION_ERROR]: {
      maxAttempts: 2, // Retry once in case of transient auth issue
      baseDelayMs: 5000,
      maxDelayMs: 10000,
      backoffMultiplier: 1.5,
      jitterFactor: 0.1,
    },
  };

  constructor(
    @InjectRepository(OrderSyncQueue)
    private readonly orderSyncQueueRepo: Repository<OrderSyncQueue>,
    @InjectRepository(FailedTransaction)
    private readonly failedTransactionRepo: Repository<FailedTransaction>,
    private readonly queuesService: QueuesService,
    private readonly deadLetterQueue: DeadLetterQueueService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  /**
   * Calculate retry delay with exponential backoff and jitter
   */
  calculateRetryDelay(attempt: number, errorType: ErrorType): number {
    const config = this.errorConfigs[errorType] || this.defaultConfig;

    // Exponential backoff
    const exponentialDelay =
      config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);

    // Add jitter to prevent thundering herd
    const jitter =
      exponentialDelay * config.jitterFactor * (Math.random() - 0.5);

    const finalDelay = exponentialDelay + jitter;

    // Cap at maximum delay
    return Math.min(finalDelay, config.maxDelayMs);
  }

  /**
   * Determine if an error is retryable
   */
  isRetryableError(errorType: ErrorType): boolean {
    const retryableErrors: ErrorType[] = [
      ErrorType.NETWORK_ERROR,
      ErrorType.TIMEOUT,
      ErrorType.RATE_LIMIT_ERROR,
      ErrorType.AUTHENTICATION_ERROR,
      ErrorType.UNKNOWN_ERROR,
    ];

    return retryableErrors.includes(errorType);
  }

  /**
   * Get max retry attempts for specific error type
   */
  getMaxRetries(errorType: ErrorType): number {
    const config = this.errorConfigs[errorType] || this.defaultConfig;
    return config.maxAttempts;
  }

  /**
   * Schedule a retry for a failed order
   */
  async scheduleRetry(
    odooOrderId: string,
    branchCode: string,
    error: {
      type: ErrorType;
      message: string;
      code?: string;
      stack?: string;
    },
    currentAttempt: number,
  ): Promise<RetryResult> {
    this.logger.log(
      `Scheduling retry for order ${odooOrderId} (attempt ${currentAttempt + 1})`,
    );

    // Check if error is retryable
    if (!this.isRetryableError(error.type)) {
      this.logger.warn(
        `Error type ${error.type} is not retryable. Moving to dead-letter queue.`,
      );

      const order = await this.orderSyncQueueRepo.findOne({
        where: { odooOrderId, branchCode },
      });

      if (order) {
        await this.deadLetterQueue.moveToDeadLetter(
          odooOrderId,
          branchCode,
          error,
          currentAttempt,
          order,
        );
      }

      return {
        success: false,
        attempts: currentAttempt,
        lastError: error,
        movedToDeadLetter: true,
      };
    }

    // Check if max retries exceeded
    const maxRetries = this.getMaxRetries(error.type);
    if (currentAttempt >= maxRetries) {
      this.logger.error(
        `Max retries (${maxRetries}) exceeded for order ${odooOrderId}. Moving to dead-letter queue.`,
      );

      const order = await this.orderSyncQueueRepo.findOne({
        where: { odooOrderId, branchCode },
      });

      if (order) {
        await this.deadLetterQueue.moveToDeadLetter(
          odooOrderId,
          branchCode,
          error,
          currentAttempt,
          order,
        );
      }

      return {
        success: false,
        attempts: currentAttempt,
        lastError: error,
        movedToDeadLetter: true,
      };
    }

    // Check circuit breaker state
    if (await this.circuitBreaker.isOpen()) {
      this.logger.warn(
        `Circuit breaker is OPEN. Delaying retry for order ${odooOrderId}.`,
      );
      // Add extra delay when circuit is open
      const circuitOpenDelay = 60000; // 1 minute
      const delay = this.calculateRetryDelay(currentAttempt, error.type);
      const totalDelay = delay + circuitOpenDelay;

      await this.scheduleRetryWithDelay(
        odooOrderId,
        branchCode,
        currentAttempt + 1,
        totalDelay,
      );

      return {
        success: false,
        attempts: currentAttempt + 1,
        lastError: error,
        movedToDeadLetter: false,
      };
    }

    // Calculate delay and schedule retry
    const delay = this.calculateRetryDelay(currentAttempt, error.type);

    await this.scheduleRetryWithDelay(
      odooOrderId,
      branchCode,
      currentAttempt + 1,
      delay,
    );

    return {
      success: false,
      attempts: currentAttempt + 1,
      lastError: error,
      movedToDeadLetter: false,
    };
  }

  /**
   * Schedule retry with specific delay
   */
  private async scheduleRetryWithDelay(
    odooOrderId: string,
    branchCode: string,
    attempt: number,
    delayMs: number,
  ): Promise<void> {
    this.logger.log(
      `Scheduling retry for ${odooOrderId} in ${Math.round(delayMs / 1000)}s (attempt ${attempt})`,
    );

    // Update order sync queue
    await this.orderSyncQueueRepo.update(
      { odooOrderId, branchCode },
      {
        status: SyncStatus.QUEUED_FOR_RETRY,
        syncAttempts: attempt,
      },
    );

    // Get order details for queue
    const order = await this.orderSyncQueueRepo.findOne({
      where: { odooOrderId, branchCode },
    });

    if (!order) {
      throw new Error(`Order ${odooOrderId} not found`);
    }

    // Enqueue with delay
    await this.queuesService.enqueueRetry(
      {
        orderSyncQueueId: order.id,
        odooOrderId: order.odooOrderId,
        branchCode: order.branchCode,
        isRetry: true,
      },
      delayMs,
    );

    // Update next retry timestamp in failed transactions
    const nextRetryAt = new Date(Date.now() + delayMs);
    await this.failedTransactionRepo.update(
      {
        orderSyncQueueId: order.id,
        isResolved: false,
      },
      {
        nextRetryAt,
        retryCount: attempt,
      },
    );
  }

  /**
   * Retry all orders in QUEUED_FOR_RETRY status (recovery after system restart)
   */
  async recoverPendingRetries(): Promise<{
    recovered: number;
    failed: number;
  }> {
    this.logger.log('Recovering pending retries after system restart...');

    const pendingRetries = await this.orderSyncQueueRepo.find({
      where: {
        status: SyncStatus.QUEUED_FOR_RETRY,
      },
      take: 1000, // Limit to prevent overwhelming the system
    });

    let recovered = 0;
    let failed = 0;

    for (const order of pendingRetries) {
      try {
        // Reset to PENDING and let the system re-queue
        await this.orderSyncQueueRepo.update(order.id, {
          status: SyncStatus.PENDING,
        });

        await this.queuesService.enqueueOrderSync({
          orderSyncQueueId: order.id,
          odooOrderId: order.odooOrderId,
          branchCode: order.branchCode,
          isRetry: true,
        });

        recovered++;
      } catch (err) {
        this.logger.error(
          `Failed to recover retry for order ${order.odooOrderId}: ${(err as Error).message}`,
        );
        failed++;
      }
    }

    this.logger.log(
      `Recovery complete: ${recovered} recovered, ${failed} failed`,
    );

    return { recovered, failed };
  }

  /**
   * Get retry statistics
   */
  async getRetryStatistics(): Promise<{
    pendingRetries: number;
    retriesLast24h: number;
    retriesLast7d: number;
    averageAttemptsBeforeSuccess: number;
    topErrorTypes: Array<{ errorType: ErrorType; count: number }>;
  }> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [pendingRetries, retriesLast24h, retriesLast7d, failedTransactions] =
      await Promise.all([
        this.orderSyncQueueRepo.count({
          where: { status: SyncStatus.QUEUED_FOR_RETRY },
        }),
        this.failedTransactionRepo.count({
          where: { createdAt: MoreThanOrEqual(oneDayAgo) },
        }),
        this.failedTransactionRepo.count({
          where: { createdAt: MoreThanOrEqual(sevenDaysAgo) },
        }),
        this.failedTransactionRepo
          .createQueryBuilder('ft')
          .select('ft.errorType', 'errorType')
          .addSelect('COUNT(*)', 'count')
          .groupBy('ft.errorType')
          .orderBy('count', 'DESC')
          .limit(10)
          .getRawMany<{ errorType: ErrorType; count: string | number }>(),
      ]);

    // Calculate average attempts before success
    const successfulRetries = await this.orderSyncQueueRepo.find({
      where: {
        status: SyncStatus.SYNCED,
        syncAttempts: MoreThan(1),
        updatedAt: MoreThanOrEqual(sevenDaysAgo),
      },
      select: { syncAttempts: true },
    });

    const averageAttemptsBeforeSuccess =
      successfulRetries.length > 0
        ? successfulRetries.reduce((sum, o) => sum + o.syncAttempts, 0) /
          successfulRetries.length
        : 0;

    const topErrorTypes = failedTransactions.map((ft) => ({
      errorType: ft.errorType,
      count: Number(ft.count),
    }));

    return {
      pendingRetries,
      retriesLast24h,
      retriesLast7d,
      averageAttemptsBeforeSuccess:
        Math.round(averageAttemptsBeforeSuccess * 10) / 10,
      topErrorTypes,
    };
  }
}
