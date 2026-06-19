import { Injectable } from '@nestjs/common';
import { JobStatus, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

// Cache TTLs in seconds
const CACHE_TTL = {
  overview: 15,
  syncTrend: 30,
  ordersByBranch: 30,
  health: 15,
} as const;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private async getCached<T>(
    key: string,
    ttl: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as T;
    const result = await fn();
    await this.redis.setex(key, ttl, JSON.stringify(result));
    return result;
  }

  async getOverview() {
    return this.getCached('dashboard:overview', CACHE_TTL.overview, async () => {
      const [
        totalOrders,
        syncedOrders,
        failedOrders,
        pendingOrders,
        processingOrders,
      ] = await Promise.all([
        this.prisma.orderSyncQueue.count(),
        this.prisma.orderSyncQueue.count({
          where: { status: SyncStatus.SYNCED },
        }),
        this.prisma.orderSyncQueue.count({
          where: { status: SyncStatus.FAILED },
        }),
        this.prisma.orderSyncQueue.count({
          where: { status: SyncStatus.PENDING },
        }),
        this.prisma.orderSyncQueue.count({
          where: { status: SyncStatus.PROCESSING },
        }),
      ]);

      const [unresolvedAlerts, activeJobs, storeCount] = await Promise.all([
        this.prisma.alertLog.count({ where: { isResolved: false } }),
        this.prisma.syncJob.count({
          where: { status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] } },
        }),
        this.prisma.storeConfiguration.count({ where: { isActive: true } }),
      ]);

      const syncRate =
        totalOrders > 0 ? Math.round((syncedOrders / totalOrders) * 100) : 0;

      return {
        totalOrders,
        syncedOrders,
        failedOrders,
        pendingOrders,
        processingOrders,
        syncRate,
        unresolvedAlerts,
        activeJobs,
        storeCount,
      };
    });
  }

  async getSyncTrend(days = 7) {
    return this.getCached(
      `dashboard:sync-trend:${days}`,
      CACHE_TTL.syncTrend,
      () => {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        return this.prisma.orderSyncQueue.groupBy({
          by: ['status'],
          where: { createdAt: { gte: startDate } },
          _count: { id: true },
        });
      },
    );
  }

  async getFailedTransactions(limit = 20) {
    return this.prisma.failedTransaction.findMany({
      where: { isResolved: false },
      include: {
        orderSyncQueue: { select: { odooOrderNumber: true, branchCode: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getOrdersByBranch() {
    return this.getCached(
      'dashboard:orders-by-branch',
      CACHE_TTL.ordersByBranch,
      () =>
        this.prisma.orderSyncQueue.groupBy({
          by: ['branchCode', 'status'],
          _count: { id: true },
          orderBy: [{ branchCode: 'asc' }, { status: 'asc' }],
        }),
    );
  }

  async getRecentActivity(limit = 50) {
    return this.prisma.auditLog.findMany({
      select: {
        id: true,
        externalId: true,
        externalSystem: true,
        operation: true,
        status: true,
        processingDurationMs: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getHealthStatus() {
    return this.getCached('dashboard:health', CACHE_TTL.health, () =>
      this.prisma.integrationHealthCheck.findMany({
        orderBy: [{ serviceName: 'asc' }, { createdAt: 'desc' }],
        distinct: ['serviceName'],
      }),
    );
  }

  async getNegativeInventory(limit = 20) {
    return this.prisma.inventorySyncTracker.findMany({
      where: { isNegativeInventory: true, negativeInventoryAlertSent: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getWebhookEvents(limit = 100) {
    return this.prisma.webhookEvent.findMany({
      select: {
        id: true,
        eventType: true,
        sourceSystem: true,
        processingStatus: true,
        receivedAt: true,
        processedAt: true,
        processingError: true,
      },
      orderBy: { receivedAt: 'desc' },
      take: limit,
    });
  }
}
