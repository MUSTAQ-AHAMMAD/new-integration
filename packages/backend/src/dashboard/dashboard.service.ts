import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, IsNull, Repository } from 'typeorm';
import { AlertLog } from '../database/entities/alert-log.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import { BackupVendHqSale } from '../database/entities/backup-vend-hq-sale.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { IntegrationHealthCheck } from '../database/entities/integration-health-check.entity';
import { InventorySyncTracker } from '../database/entities/inventory-sync-tracker.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { WebhookEvent } from '../database/entities/webhook-event.entity';
import { JobStatus, SyncStatus } from '../database/enums';
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
    @InjectRepository(OrderSyncQueue)
    private readonly orders: Repository<OrderSyncQueue>,
    @InjectRepository(AlertLog)
    private readonly alerts: Repository<AlertLog>,
    @InjectRepository(SyncJob)
    private readonly jobs: Repository<SyncJob>,
    @InjectRepository(StoreConfiguration)
    private readonly stores: Repository<StoreConfiguration>,
    @InjectRepository(BackupVendHqSale)
    private readonly vendhqSales: Repository<BackupVendHqSale>,
    @InjectRepository(FailedTransaction)
    private readonly failedTransactions: Repository<FailedTransaction>,
    @InjectRepository(AuditLog)
    private readonly audit: Repository<AuditLog>,
    @InjectRepository(IntegrationHealthCheck)
    private readonly health: Repository<IntegrationHealthCheck>,
    @InjectRepository(InventorySyncTracker)
    private readonly inventory: Repository<InventorySyncTracker>,
    @InjectRepository(WebhookEvent)
    private readonly webhooks: Repository<WebhookEvent>,
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

  async getOverview(region?: string) {
    const cacheKey = region
      ? `dashboard:overview:${region}`
      : 'dashboard:overview';
    return this.getCached(cacheKey, CACHE_TTL.overview, async () => {
      // When a specific region is provided, return VendHQ backup-based stats
      // (BackupVendHqSale has a `region` field) alongside global counts.
      if (region) {
        const [totalOrders, syncedOrders, failedOrders, pendingOrders] =
          await Promise.all([
            this.vendhqSales.count({ where: { region } }),
            this.vendhqSales.count({ where: { region, fusionSynced: true } }),
            this.vendhqSales.count({
              where: { region, fusionSyncError: Not(IsNull()) },
            }),
            this.vendhqSales.count({
              where: { region, fusionSynced: false, fusionSyncError: IsNull() },
            }),
          ]);

        const [unresolvedAlerts, activeJobs, storeCount] = await Promise.all([
          this.alerts.count({ where: { isResolved: false } }),
          this.jobs.count({
            where: { status: In([JobStatus.PENDING, JobStatus.PROCESSING]) },
          }),
          this.stores.count({ where: { isActive: true } }),
        ]);

        const syncRate =
          totalOrders > 0 ? Math.round((syncedOrders / totalOrders) * 100) : 0;

        return {
          totalOrders,
          syncedOrders,
          failedOrders,
          pendingOrders,
          processingOrders: 0,
          syncRate,
          unresolvedAlerts,
          activeJobs,
          storeCount,
          region,
          dataSource: 'vendhq-backup',
        };
      }

      // No region selected: return global Odoo → Oracle OrderSyncQueue stats
      const [
        totalOrders,
        syncedOrders,
        failedOrders,
        pendingOrders,
        processingOrders,
      ] = await Promise.all([
        this.orders.count(),
        this.orders.count({ where: { status: SyncStatus.SYNCED } }),
        this.orders.count({ where: { status: SyncStatus.FAILED } }),
        this.orders.count({ where: { status: SyncStatus.PENDING } }),
        this.orders.count({ where: { status: SyncStatus.PROCESSING } }),
      ]);

      const [unresolvedAlerts, activeJobs, storeCount] = await Promise.all([
        this.alerts.count({ where: { isResolved: false } }),
        this.jobs.count({
          where: { status: In([JobStatus.PENDING, JobStatus.PROCESSING]) },
        }),
        this.stores.count({ where: { isActive: true } }),
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
      async () => {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const rows = await this.orders
          .createQueryBuilder('o')
          .select('o.status', 'status')
          .addSelect('COUNT(*)', 'count')
          .where('o.createdAt >= :startDate', { startDate })
          .groupBy('o.status')
          .getRawMany<{ status: string; count: string | number }>();
        return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
      },
    );
  }

  async getFailedTransactions(limit = 20) {
    return this.failedTransactions.find({
      where: { isResolved: false },
      relations: { orderSyncQueue: true },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getOrdersByBranch() {
    return this.getCached(
      'dashboard:orders-by-branch',
      CACHE_TTL.ordersByBranch,
      async () => {
        const rows = await this.orders
          .createQueryBuilder('o')
          .select('o.branchCode', 'branchCode')
          .addSelect('o.status', 'status')
          .addSelect('COUNT(*)', 'count')
          .groupBy('o.branchCode')
          .addGroupBy('o.status')
          .orderBy('o.branchCode', 'ASC')
          .addOrderBy('o.status', 'ASC')
          .getRawMany<{
            branchCode: string;
            status: string;
            count: string | number;
          }>();
        return rows.map((r) => ({
          branchCode: r.branchCode,
          status: r.status,
          count: Number(r.count),
        }));
      },
    );
  }

  async getRecentActivity(limit = 50) {
    return this.audit.find({
      select: {
        id: true,
        externalId: true,
        externalSystem: true,
        operation: true,
        status: true,
        processingDurationMs: true,
        createdAt: true,
      },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getHealthStatus() {
    return this.getCached('dashboard:health', CACHE_TTL.health, async () => {
      // Oracle has no DISTINCT ON — take the latest record per service in memory.
      const records = await this.health.find({
        order: { serviceName: 'ASC', createdAt: 'DESC' },
        take: 500,
      });
      const latest = new Map<string, IntegrationHealthCheck>();
      for (const r of records) {
        if (!latest.has(r.serviceName)) latest.set(r.serviceName, r);
      }
      return [...latest.values()];
    });
  }

  async getNegativeInventory(limit = 20) {
    return this.inventory.find({
      where: { isNegativeInventory: true, negativeInventoryAlertSent: false },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getWebhookEvents(limit = 100) {
    return this.webhooks.find({
      select: {
        id: true,
        eventType: true,
        sourceSystem: true,
        processingStatus: true,
        receivedAt: true,
        processedAt: true,
        processingError: true,
      },
      order: { receivedAt: 'DESC' },
      take: limit,
    });
  }
}
