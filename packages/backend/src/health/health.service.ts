import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HealthStatus, ServiceName } from '@prisma/client';
import { GatewayService } from '../gateway/gateway.service';
import { PrismaService } from '../prisma/prisma.service';
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
    private readonly prisma: PrismaService,
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
      await this.prisma.integrationHealthCheck.create({
        data: {
          serviceName,
          status: HealthStatus.HEALTHY,
          responseTimeMs,
          lastSuccessAt: new Date(),
          consecutiveFailures: 0,
        },
      });
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
      const lastCheck = await this.prisma.integrationHealthCheck
        .findFirst({
          where: { serviceName },
          orderBy: { createdAt: 'desc' },
          select: { consecutiveFailures: true },
        })
        .catch(() => null);

      const consecutiveFailures = (lastCheck?.consecutiveFailures ?? 0) + 1;

      await this.prisma.integrationHealthCheck
        .create({
          data: {
            serviceName,
            status: HealthStatus.UNHEALTHY,
            responseTimeMs,
            lastSuccessAt: new Date(0),
            lastFailureAt: new Date(),
            failureReason,
            consecutiveFailures,
          },
        })
        .catch(() => undefined);
      this.gateway.emitHealthUpdate({
        service: serviceName,
        status: HealthStatus.UNHEALTHY,
      });
    }
  }

  private checkDatabase() {
    return this.checkService(ServiceName.DATABASE, async () => {
      await this.prisma.$queryRaw`SELECT 1`;
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
      this.prisma.orderSyncQueue.count({
        where: { status: 'PENDING' },
      }),
      this.prisma.orderSyncQueue.count({
        where: { status: 'PROCESSING' },
      }),
      this.prisma.orderSyncQueue.count({
        where: { status: 'SYNCED' },
      }),
      this.prisma.orderSyncQueue.count({
        where: { status: 'FAILED' },
      }),
      this.prisma.orderSyncQueue.count({
        where: { status: 'SKIPPED' },
      }),
      this.prisma.orderSyncQueue.count({
        where: {
          status: 'SYNCED',
          updatedAt: { gte: oneHourAgo },
        },
      }),
      this.prisma.orderSyncQueue.count({
        where: {
          status: 'FAILED',
          updatedAt: { gte: oneHourAgo },
        },
      }),
    ]);

    const totalOrders = pendingCount + processingCount + syncedCount + failedCount + skippedCount;
    const recentTotal = recentlyProcessed + recentlyFailed;
    const failureRate = recentTotal > 0 ? (recentlyFailed / recentTotal) * 100 : 0;

    // Get sync job status
    const [runningJobs, pendingJobs, failedJobs] = await Promise.all([
      this.prisma.syncJob.count({
        where: { status: 'PROCESSING' },
      }),
      this.prisma.syncJob.count({
        where: { status: 'PENDING' },
      }),
      this.prisma.syncJob.count({
        where: {
          status: 'FAILED',
          createdAt: { gte: oneDayAgo },
        },
      }),
    ]);

    // Get failed transaction stats
    const [unresolvedFailures, todayFailures] = await Promise.all([
      this.prisma.failedTransaction.count({
        where: { isResolved: false },
      }),
      this.prisma.failedTransaction.count({
        where: {
          isResolved: false,
          createdAt: { gte: oneDayAgo },
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
      this.prisma.orderSyncQueue.count({
        where: { createdAt: { gte: oneDayAgo } },
      }),
      this.prisma.orderSyncQueue.count({
        where: { createdAt: { gte: sevenDaysAgo } },
      }),
      this.prisma.orderSyncQueue.count({
        where: {
          status: 'SYNCED',
          updatedAt: { gte: oneDayAgo },
        },
      }),
      this.prisma.orderSyncQueue.count({
        where: {
          status: 'SYNCED',
          updatedAt: { gte: sevenDaysAgo },
        },
      }),
      this.prisma.orderSyncQueue.count({
        where: {
          status: 'FAILED',
          updatedAt: { gte: oneDayAgo },
        },
      }),
      this.prisma.orderSyncQueue.count({
        where: {
          status: 'FAILED',
          updatedAt: { gte: sevenDaysAgo },
        },
      }),
      this.prisma.auditLog.aggregate({
        where: {
          status: 'SUCCESS',
          createdAt: { gte: oneDayAgo },
        },
        _avg: {
          processingDurationMs: true,
        },
      }),
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
        averageProcessingTimeMs: Math.round(
          averageProcessingTime._avg.processingDurationMs ?? 0,
        ),
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
}
