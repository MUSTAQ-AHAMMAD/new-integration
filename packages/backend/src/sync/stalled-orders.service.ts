import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  AlertSeverity,
  AlertType,
  ErrorType,
  Prisma,
  SyncStatus,
} from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { SyncControlService } from './sync-control.service';

/** Default stale-order threshold in hours (overridden by STALE_THRESHOLD_HOURS env var). */
const DEFAULT_STALE_THRESHOLD_HOURS = 6;

/**
 * Default age (hours) after which a still-pending sync request is cancelled by
 * the cleanup job. Overridden by STALE_CANCEL_THRESHOLD_HOURS. Must be larger
 * than the detection threshold so operators are alerted before cancellation.
 */
const DEFAULT_CANCEL_THRESHOLD_HOURS = 24;

/** Default maximum sync attempts before an order is permanently failed. */
const DEFAULT_MAX_SYNC_ATTEMPTS = 5;

/** Maximum number of orders processed by a single cleanup run. */
const CLEANUP_BATCH_LIMIT = 1000;

/** Order statuses that are still "in flight" and eligible for cleanup. */
const CLEANUP_ELIGIBLE_STATUSES: SyncStatus[] = [
  SyncStatus.PENDING,
  SyncStatus.QUEUED_FOR_RETRY,
];

@Injectable()
export class StalledOrdersService {
  private readonly logger = new Logger(StalledOrdersService.name);
  private readonly staleThresholdHours: number;
  private readonly cancelThresholdHours: number;
  private readonly maxSyncAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alertsService: AlertsService,
    private readonly syncControl: SyncControlService,
    configService: ConfigService,
  ) {
    const configured = configService.get<number>('STALE_THRESHOLD_HOURS');
    this.staleThresholdHours =
      configured && configured > 0 ? configured : DEFAULT_STALE_THRESHOLD_HOURS;

    const cancelConfigured = configService.get<number>(
      'STALE_CANCEL_THRESHOLD_HOURS',
    );
    this.cancelThresholdHours =
      cancelConfigured && cancelConfigured > 0
        ? cancelConfigured
        : DEFAULT_CANCEL_THRESHOLD_HOURS;

    const maxAttemptsConfigured =
      configService.get<number>('MAX_SYNC_ATTEMPTS');
    this.maxSyncAttempts =
      maxAttemptsConfigured && maxAttemptsConfigured > 0
        ? maxAttemptsConfigured
        : DEFAULT_MAX_SYNC_ATTEMPTS;
  }

  /**
   * Runs every night at 01:00.
   * Finds orders stuck in PENDING for more than staleThresholdHours,
   * groups them by branch, and fires one SYNC_STALLED alert per branch.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async detectStalledOrders(): Promise<void> {
    // Check if sync control allows this service to run
    const enabled = await this.syncControl.isEnabled('stalled-orders');
    if (!enabled) {
      this.logger.debug(
        'Stalled orders service is disabled, skipping cron run',
      );
      return;
    }

    await this.syncControl.markRunning('stalled-orders');
    try {
      await this._detectStalledOrders();
      await this.syncControl.markStopped('stalled-orders', 'success');
    } catch (err) {
      this.logger.error(
        'detectStalledOrders cron failed',
        err instanceof Error ? err.stack : String(err),
      );
      await this.syncControl.markStopped('stalled-orders', 'error');
    }
  }

  private async _detectStalledOrders(): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.staleThresholdHours * 60 * 60 * 1000,
    );

    const stalledOrders = await this.prisma.orderSyncQueue.findMany({
      where: {
        status: SyncStatus.PENDING,
        createdAt: { lt: cutoff },
      },
      select: {
        id: true,
        odooOrderId: true,
        odooOrderNumber: true,
        branchCode: true,
        createdAt: true,
      },
      orderBy: { branchCode: 'asc' },
    });

    if (stalledOrders.length === 0) {
      return;
    }

    // Group by branch for targeted alerts
    const byBranch = stalledOrders.reduce<Record<string, typeof stalledOrders>>(
      (acc, order) => {
        (acc[order.branchCode] ??= []).push(order);
        return acc;
      },
      {},
    );

    for (const [branchCode, orders] of Object.entries(byBranch)) {
      const orderList = orders
        .slice(0, 10)
        .map((o) => o.odooOrderNumber ?? o.odooOrderId)
        .join(', ');
      const overflow =
        orders.length > 10 ? ` ... and ${orders.length - 10} more` : '';

      await this.alertsService.createAlert({
        alertType: AlertType.SYNC_STALLED,
        severity: AlertSeverity.WARNING,
        title: `Stalled orders detected — branch ${branchCode}`,
        message:
          `${orders.length} order(s) in branch ${branchCode} have been in PENDING status ` +
          `for more than ${this.staleThresholdHours} hours and may have been missed. ` +
          `Orders: ${orderList}${overflow}. ` +
          `Use POST /sync/jobs with scopeType=BRANCH_DATE_RANGE to re-sync the affected period.`,
        relatedEntityId: branchCode,
        relatedEntityType: 'BRANCH',
      });

      this.logger.warn(
        `Stalled orders detected for branch ${branchCode}: ${orders.length} order(s)`,
      );
    }
  }

  /**
   * Cleanup job — runs hourly.
   *
   * 1. Cancels sync requests that have been stuck in a non-terminal state
   *    (PENDING / QUEUED_FOR_RETRY) for longer than `cancelThresholdHours`.
   * 2. Permanently fails orders that have exceeded `maxSyncAttempts`, removing
   *    them from the active queue so they stop being retried.
   *
   * Cancelled orders are marked FAILED (there is no CANCELLED order status),
   * an audit FailedTransaction row is written, and all actions are logged.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupStalePendingOrders(): Promise<void> {
    const enabled = await this.syncControl.isEnabled('stalled-orders');
    if (!enabled) {
      this.logger.debug('Stalled orders service is disabled, skipping cleanup');
      return;
    }

    try {
      const cancelledByAge = await this.cancelStaleRequests();
      const failedByRetries = await this.failExhaustedRetries();

      if (cancelledByAge > 0 || failedByRetries > 0) {
        this.logger.log(
          `Cleanup complete: cancelled ${cancelledByAge} stale request(s), ` +
            `permanently failed ${failedByRetries} order(s) over the retry limit`,
        );
      } else {
        this.logger.debug('Cleanup complete: nothing to clean up');
      }
    } catch (err) {
      this.logger.error(
        'cleanupStalePendingOrders cron failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Cancels sync requests older than `cancelThresholdHours` that are still in a
   * non-terminal state. Returns the number of requests cancelled.
   */
  private async cancelStaleRequests(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.cancelThresholdHours * 60 * 60 * 1000,
    );

    const staleOrders = await this.prisma.orderSyncQueue.findMany({
      where: {
        status: { in: CLEANUP_ELIGIBLE_STATUSES },
        createdAt: { lt: cutoff },
      },
      select: {
        id: true,
        odooOrderId: true,
        odooOrderNumber: true,
        branchCode: true,
        status: true,
        createdAt: true,
        syncAttempts: true,
      },
      take: CLEANUP_BATCH_LIMIT,
    });

    if (staleOrders.length === 0) {
      return 0;
    }

    for (const order of staleOrders) {
      const reason =
        `Cancelled by cleanup: stuck in ${order.status} for more than ` +
        `${this.cancelThresholdHours}h (created ${order.createdAt.toISOString()})`;

      await this.markOrderCancelled(
        order.id,
        reason,
        order.syncAttempts,
        ErrorType.TIMEOUT,
      );

      this.logger.warn(
        `Cancelled stale sync request ${order.odooOrderNumber ?? order.odooOrderId} ` +
          `(branch ${order.branchCode}): ${reason}`,
      );
    }

    await this.alertsService
      .createAlert({
        alertType: AlertType.SYNC_STALLED,
        severity: AlertSeverity.WARNING,
        title: 'Stale sync requests cancelled',
        message:
          `${staleOrders.length} sync request(s) were automatically cancelled ` +
          `after being stuck for more than ${this.cancelThresholdHours} hours.`,
        relatedEntityType: 'SYNC_QUEUE',
      })
      .catch((err) =>
        this.logger.error(
          `Failed to raise cleanup alert: ${(err as Error).message}`,
        ),
      );

    return staleOrders.length;
  }

  /**
   * Permanently fails orders that have exceeded the maximum number of sync
   * attempts, removing them from the active (retryable) queue. Returns the
   * number of orders failed.
   */
  private async failExhaustedRetries(): Promise<number> {
    const exhaustedOrders = await this.prisma.orderSyncQueue.findMany({
      where: {
        status: { in: CLEANUP_ELIGIBLE_STATUSES },
        syncAttempts: { gte: this.maxSyncAttempts },
      },
      select: {
        id: true,
        odooOrderId: true,
        odooOrderNumber: true,
        branchCode: true,
        syncAttempts: true,
      },
      take: CLEANUP_BATCH_LIMIT,
    });

    if (exhaustedOrders.length === 0) {
      return 0;
    }

    for (const order of exhaustedOrders) {
      const reason =
        `Permanently failed by cleanup: exceeded max retry limit ` +
        `(${order.syncAttempts}/${this.maxSyncAttempts} attempts)`;

      await this.markOrderCancelled(
        order.id,
        reason,
        order.syncAttempts,
        ErrorType.UNKNOWN_ERROR,
      );

      this.logger.error(
        `Permanently failed order ${order.odooOrderNumber ?? order.odooOrderId} ` +
          `(branch ${order.branchCode}): ${reason}`,
      );
    }

    return exhaustedOrders.length;
  }

  /**
   * Marks an order FAILED and records an audit FailedTransaction row. Failures
   * to write the audit row are logged but never abort the cleanup run.
   */
  private async markOrderCancelled(
    orderId: string,
    reason: string,
    attempts: number,
    errorType: ErrorType,
  ): Promise<void> {
    await this.prisma.orderSyncQueue.update({
      where: { id: orderId },
      data: {
        status: SyncStatus.FAILED,
        validationErrors: { error: reason, cancelledByCleanup: true },
      },
    });

    await this.prisma.failedTransaction
      .create({
        data: {
          orderSyncQueueId: orderId,
          originalPayload: Prisma.JsonNull,
          errorType,
          errorMessage: reason,
          retryCount: attempts,
          maxRetries: this.maxSyncAttempts,
        },
      })
      .catch((err) =>
        this.logger.error(
          `Failed to record cleanup audit for order ${orderId}: ${(err as Error).message}`,
        ),
      );
  }

  /** Returns the count of orders currently stalled (for dashboard/metrics). */
  async getStalledCount(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.staleThresholdHours * 60 * 60 * 1000,
    );
    return this.prisma.orderSyncQueue.count({
      where: {
        status: SyncStatus.PENDING,
        createdAt: { lt: cutoff },
      },
    });
  }
}
