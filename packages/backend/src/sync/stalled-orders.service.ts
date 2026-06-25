import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertSeverity, AlertType, SyncStatus } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { SyncControlService } from './sync-control.service';

/** Default stale-order threshold in hours (overridden by STALE_THRESHOLD_HOURS env var). */
const DEFAULT_STALE_THRESHOLD_HOURS = 6;

@Injectable()
export class StalledOrdersService {
  private readonly logger = new Logger(StalledOrdersService.name);
  private readonly staleThresholdHours: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alertsService: AlertsService,
    private readonly syncControl: SyncControlService,
    configService: ConfigService,
  ) {
    const configured = configService.get<number>('STALE_THRESHOLD_HOURS');
    this.staleThresholdHours =
      configured && configured > 0 ? configured : DEFAULT_STALE_THRESHOLD_HOURS;
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
      this.logger.debug('Stalled orders service is disabled, skipping cron run');
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
