import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, MoreThanOrEqual, Repository } from 'typeorm';
import { IntegrationHealthCheck } from '../database/entities/integration-health-check.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import {
  AuditStatus,
  HealthStatus,
  JobStatus,
  ServiceName,
  SyncStatus,
} from '../database/enums';
import { GatewayService } from '../gateway/gateway.service';
import { RedisService } from '../redis/redis.service';
import { OracleSoapClient } from '../clients/oracle/oracle-soap.client';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  // Alert thresholds
  private readonly FAILURE_RATE_WARNING_THRESHOLD = 10; // percentage
  private readonly FAILURE_RATE_CRITICAL_THRESHOLD = 25; // percentage
  private readonly HIGH_PROCESSING_COUNT_THRESHOLD = 100;
  private readonly LARGE_BACKLOG_THRESHOLD = 1000;
  private readonly HIGH_UNRESOLVED_FAILURES_THRESHOLD = 100;

  constructor(
    @InjectRepository(IntegrationHealthCheck)
    private readonly healthChecks: Repository<IntegrationHealthCheck>,
    @InjectRepository(OrderSyncQueue)
    private readonly orderQueue: Repository<OrderSyncQueue>,
    @InjectRepository(SyncJob)
    private readonly syncJobs: Repository<SyncJob>,
    @InjectRepository(FailedTransaction)
    private readonly failedTransactions: Repository<FailedTransaction>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly gateway: GatewayService,
    private readonly oracleSoap: OracleSoapClient,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async runHealthChecks() {
    await Promise.allSettled([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkOracle(),
    ]);
  }

  private async checkService(
    serviceName: ServiceName,
    checkFn: () => Promise<void>,
  ) {
    const start = Date.now();
    try {
      await checkFn();
      const responseTimeMs = Date.now() - start;
      await this.healthChecks.save(
        this.healthChecks.create({
          serviceName,
          status: HealthStatus.HEALTHY,
          responseTimeMs,
          lastSuccessAt: new Date(),
          consecutiveFailures: 0,
        }),
      );
      this.gateway.emitHealthUpdate({
        service: serviceName,
        status: HealthStatus.HEALTHY,
      });
    } catch (err) {
      const responseTimeMs = Date.now() - start;
      const failureReason =
        err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(
        `Health check failed for ${serviceName}: ${failureReason}`,
      );

      // Retrieve the current consecutive-failure count so we can increment it.
      const lastCheck = await this.healthChecks
        .findOne({
          where: { serviceName },
          order: { createdAt: 'DESC' },
          select: { consecutiveFailures: true },
        })
        .catch(() => null);

      const consecutiveFailures = (lastCheck?.consecutiveFailures ?? 0) + 1;

      await this.healthChecks
        .save(
          this.healthChecks.create({
            serviceName,
            status: HealthStatus.UNHEALTHY,
            responseTimeMs,
            lastSuccessAt: new Date(0),
            lastFailureAt: new Date(),
            failureReason,
            consecutiveFailures,
          }),
        )
        .catch(() => undefined);
      this.gateway.emitHealthUpdate({
        service: serviceName,
        status: HealthStatus.UNHEALTHY,
      });
    }
  }

  private checkDatabase() {
    return this.checkService(ServiceName.DATABASE, async () => {
      await this.dataSource.query('SELECT 1 FROM DUAL');
    });
  }

  private checkRedis() {
    return this.checkService(ServiceName.REDIS, async () => {
      await this.redis.ping();
    });
  }

  private checkOracle() {
    return this.checkService(ServiceName.ORACLE_SOAP, async () => {
      await this.oracleSoap.ping();
    });
  }

  /**
   * Latest health check per service. Replaces the Prisma `findMany` with
   * `distinct: ['serviceName']` (Postgres DISTINCT ON) — Oracle has no such
   * clause, so fetch ordered rows and keep the first (most recent) per service.
   */
  async getLatestHealthPerService(): Promise<IntegrationHealthCheck[]> {
    const rows = await this.healthChecks.find({
      order: { serviceName: 'ASC', createdAt: 'DESC' },
    });

    const seen = new Set<string>();
    const latest: IntegrationHealthCheck[] = [];
    for (const row of rows) {
      if (seen.has(row.serviceName)) continue;
      seen.add(row.serviceName);
      latest.push(row);
    }
    return latest;
  }

  /**
   * Get comprehensive sync system status including queue sizes,
   * processing rates, and error rates
   */
  async getSyncSystemStatus() {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Get order sync queue status
    const [
      pendingCount,
      processingCount,
      syncedCount,
      failedCount,
      skippedCount,
      recentlyProcessed,
      recentlyFailed,
    ] = await Promise.all([
      this.orderQueue.count({ where: { status: SyncStatus.PENDING } }),
      this.orderQueue.count({ where: { status: SyncStatus.PROCESSING } }),
      this.orderQueue.count({ where: { status: SyncStatus.SYNCED } }),
      this.orderQueue.count({ where: { status: SyncStatus.FAILED } }),
      this.orderQueue.count({ where: { status: SyncStatus.SKIPPED } }),
      this.orderQueue.count({
        where: {
          status: SyncStatus.SYNCED,
          updatedAt: MoreThanOrEqual(oneHourAgo),
        },
      }),
      this.orderQueue.count({
        where: {
          status: SyncStatus.FAILED,
          updatedAt: MoreThanOrEqual(oneHourAgo),
        },
      }),
    ]);

    const totalOrders =
      pendingCount + processingCount + syncedCount + failedCount + skippedCount;
    const recentTotal = recentlyProcessed + recentlyFailed;
    const failureRate =
      recentTotal > 0 ? (recentlyFailed / recentTotal) * 100 : 0;

    // Get sync job status
    const [runningJobs, pendingJobs, failedJobs] = await Promise.all([
      this.syncJobs.count({ where: { status: JobStatus.PROCESSING } }),
      this.syncJobs.count({ where: { status: JobStatus.PENDING } }),
      this.syncJobs.count({
        where: {
          status: JobStatus.FAILED,
          createdAt: MoreThanOrEqual(oneDayAgo),
        },
      }),
    ]);

    // Get failed transaction stats
    const [unresolvedFailures, todayFailures] = await Promise.all([
      this.failedTransactions.count({ where: { isResolved: false } }),
      this.failedTransactions.count({
        where: {
          isResolved: false,
          createdAt: MoreThanOrEqual(oneDayAgo),
        },
      }),
    ]);

    // Determine overall health status
    let overallStatus = 'HEALTHY';
    const alerts = [];

    if (failureRate > this.FAILURE_RATE_WARNING_THRESHOLD) {
      overallStatus = 'DEGRADED';
      alerts.push({
        severity: 'WARNING',
        message: `High failure rate detected: ${failureRate.toFixed(1)}% in the last hour`,
      });
    }

    if (failureRate > this.FAILURE_RATE_CRITICAL_THRESHOLD) {
      overallStatus = 'UNHEALTHY';
      alerts.push({
        severity: 'CRITICAL',
        message: `Critical failure rate: ${failureRate.toFixed(1)}% in the last hour`,
      });
    }

    if (processingCount > this.HIGH_PROCESSING_COUNT_THRESHOLD) {
      alerts.push({
        severity: 'INFO',
        message: `High number of orders currently processing: ${processingCount}`,
      });
    }

    if (pendingCount > this.LARGE_BACKLOG_THRESHOLD) {
      overallStatus = overallStatus === 'HEALTHY' ? 'DEGRADED' : overallStatus;
      alerts.push({
        severity: 'WARNING',
        message: `Large backlog detected: ${pendingCount} orders pending`,
      });
    }

    if (unresolvedFailures > this.HIGH_UNRESOLVED_FAILURES_THRESHOLD) {
      alerts.push({
        severity: 'WARNING',
        message: `${unresolvedFailures} unresolved failures need attention`,
      });
    }

    return {
      timestamp: now.toISOString(),
      overallStatus,
      alerts,
      orderQueue: {
        total: totalOrders,
        pending: pendingCount,
        processing: processingCount,
        synced: syncedCount,
        failed: failedCount,
        skipped: skippedCount,
      },
      performance: {
        processedLastHour: recentlyProcessed,
        failedLastHour: recentlyFailed,
        failureRatePercent: parseFloat(failureRate.toFixed(2)),
        processingRate: `${recentlyProcessed} orders/hour`,
      },
      syncJobs: {
        running: runningJobs,
        pending: pendingJobs,
        failedToday: failedJobs,
      },
      failures: {
        unresolved: unresolvedFailures,
        today: todayFailures,
      },
    };
  }

  /**
   * Get system-wide metrics and counters
   */
  async getSystemMetrics() {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalOrdersToday,
      totalOrdersWeek,
      syncedToday,
      syncedWeek,
      failedToday,
      failedWeek,
      averageProcessingTime,
    ] = await Promise.all([
      this.orderQueue.count({
        where: { createdAt: MoreThanOrEqual(oneDayAgo) },
      }),
      this.orderQueue.count({
        where: { createdAt: MoreThanOrEqual(sevenDaysAgo) },
      }),
      this.orderQueue.count({
        where: {
          status: SyncStatus.SYNCED,
          updatedAt: MoreThanOrEqual(oneDayAgo),
        },
      }),
      this.orderQueue.count({
        where: {
          status: SyncStatus.SYNCED,
          updatedAt: MoreThanOrEqual(sevenDaysAgo),
        },
      }),
      this.orderQueue.count({
        where: {
          status: SyncStatus.FAILED,
          updatedAt: MoreThanOrEqual(oneDayAgo),
        },
      }),
      this.orderQueue.count({
        where: {
          status: SyncStatus.FAILED,
          updatedAt: MoreThanOrEqual(sevenDaysAgo),
        },
      }),
      this.getAverageProcessingTimeMs(oneDayAgo),
    ]);

    return {
      timestamp: now.toISOString(),
      orders: {
        ingestedToday: totalOrdersToday,
        ingestedThisWeek: totalOrdersWeek,
        syncedToday,
        syncedThisWeek: syncedWeek,
        failedToday,
        failedThisWeek: failedWeek,
      },
      performance: {
        averageProcessingTimeMs: Math.round(averageProcessingTime),
        successRateToday:
          totalOrdersToday > 0
            ? parseFloat(((syncedToday / totalOrdersToday) * 100).toFixed(2))
            : 0,
        successRateWeek:
          totalOrdersWeek > 0
            ? parseFloat(((syncedWeek / totalOrdersWeek) * 100).toFixed(2))
            : 0,
      },
    };
  }

  /**
   * Average processing duration (ms) of successful audit-log operations since
   * the given cutoff. Replaces the Prisma `auditLog.aggregate({ _avg })` call.
   */
  private async getAverageProcessingTimeMs(since: Date): Promise<number> {
    const row = await this.dataSource
      .getRepository(AuditLog)
      .createQueryBuilder('a')
      .select('AVG(a.processingDurationMs)', 'avg')
      .where('a.status = :status', { status: AuditStatus.SUCCESS })
      .andWhere('a.createdAt >= :since', { since })
      .getRawOne<{ avg: string | number | null }>();

    return row?.avg != null ? Number(row.avg) : 0;
  }
}
