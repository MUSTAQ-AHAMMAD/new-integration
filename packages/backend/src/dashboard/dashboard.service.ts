import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  In,
  Not,
  IsNull,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { AlertLog } from '../database/entities/alert-log.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupVendHqSale } from '../database/entities/backup-vend-hq-sale.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { IntegrationHealthCheck } from '../database/entities/integration-health-check.entity';
import { InventorySyncTracker } from '../database/entities/inventory-sync-tracker.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { WebhookEvent } from '../database/entities/webhook-event.entity';
import { JobStatus, SyncStatus, ValidationStatus } from '../database/enums';
import { RedisService } from '../redis/redis.service';

export interface RegionStatusRow {
  region: string;
  /** Any active Odoo credential for the region. */
  odooActive: boolean;
  /** ISO — most recent Odoo pull watermark (OdooCredential.lastSyncAt). */
  lastOdooSync: string | null;
  /** ISO — most recent successful Oracle invoice push. */
  lastOraclePush: string | null;
  /** Backup orders stored for the region. */
  ordersFetched: number;
  /** Net Odoo revenue (Σ amountTotal, refunds included). */
  odooRevenue: number;
  /** Successful invoices posted to Oracle. */
  invoicesPushed: number;
  /** Σ Oracle invoice totals (SUCCESS only). */
  oracleRevenue: number;
  /** OrderSyncQueue rows in FAILED state, rolled up from branchCode. */
  failedOrders: number;
}

/** Per-store revenue (from the Odoo backup — the source of truth for a store). */
export interface StoreRevenueRow {
  store: string;
  region: string;
  orders: number;
  odooRevenue: number;
}

/** Management/CEO-level KPIs for the executive overview. */
export interface ExecutiveSummary {
  generatedAt: string;
  /** Money — is our revenue reaching the ERP? (amounts summed across regions). */
  revenue: {
    /** Source-of-truth net sales value pulled from Odoo. */
    odooFetched: number;
    /** Value posted to Oracle (SUCCESS invoices), all-time. */
    oraclePosted: number;
    /** Value posted to Oracle in the last 30 days. */
    oraclePosted30d: number;
    /** oraclePosted / odooFetched, %. */
    completenessPct: number;
    /** odooFetched − oraclePosted, the value not yet in Oracle. */
    gap: number;
  };
  /** Throughput & risk. */
  orders: {
    fetched: number;
    synced: number;
    syncedPct: number;
    pending: number;
    failed: number;
    /** Σ amount of pending + failed orders — money stuck in the pipeline. */
    valueAtRisk: number;
    /** Age of the oldest pending order, hours (SLA signal). */
    oldestPendingHours: number | null;
  };
  /** Refund exposure awaiting credit memos. */
  refunds: { pendingCount: number; pendingValue: number };
  /** Coverage & freshness across regions. */
  regions: { total: number; current: number; stale: number };
  /** Store estate. */
  stores: { active: number; needsReview: number };
  /** Oracle revenue this calendar month vs last, with growth %. */
  revenueMoM: { thisMonth: number; lastMonth: number; growthPct: number };
  /** Per-region detail (same shape as the Region Status board). */
  byRegion: RegionStatusRow[];
  /** Oracle revenue posted per day for the last 14 days (momentum). */
  revenueTrend: Array<{ date: string; posted: number }>;
  /** Top unresolved failure reasons by count. */
  topFailures: Array<{ reason: string; count: number }>;
}

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
    @InjectRepository(BackupOdooOrder)
    private readonly backupOdoo: Repository<BackupOdooOrder>,
    @InjectRepository(FusionInvoiceHeader)
    private readonly invoiceHeaders: Repository<FusionInvoiceHeader>,
    @InjectRepository(OdooCredential)
    private readonly odooCredentials: Repository<OdooCredential>,
    @InjectRepository(RefundTracking)
    private readonly refunds: Repository<RefundTracking>,
    private readonly redis: RedisService,
  ) {}

  /**
   * One row per region for the Region Status Board: Odoo pull watermark +
   * fetched orders/revenue, Oracle push watermark + invoices/revenue, and the
   * failed-order count. Regions come from the union of Odoo credentials, backup
   * orders and posted invoices, so a region shows up even if one side is empty.
   */
  async getRegionStatus(): Promise<RegionStatusRow[]> {
    return this.getCached('dashboard:region-status', 30, async () => {
      const lower = (row: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
        return out;
      };
      const num = (v: unknown) => {
        const n = Number(v ?? 0);
        return Number.isFinite(n) ? n : 0;
      };

      const [creds, backupAgg, invoiceAgg, storeRows, failedByBranch] =
        await Promise.all([
          this.odooCredentials.find(),
          this.backupOdoo
            .createQueryBuilder('b')
            .select('b.region', 'region')
            .addSelect('COUNT(*)', 'orders')
            .addSelect('SUM(b.amountTotal)', 'revenue')
            .groupBy('b.region')
            .getRawMany(),
          this.invoiceHeaders
            .createQueryBuilder('i')
            .select('i.region', 'region')
            .addSelect(
              "SUM(CASE WHEN i.status = 'SUCCESS' THEN 1 ELSE 0 END)",
              'invoices',
            )
            .addSelect(
              "SUM(CASE WHEN i.status = 'SUCCESS' THEN i.totalAmount ELSE 0 END)",
              'revenue',
            )
            .addSelect(
              "MAX(CASE WHEN i.status = 'SUCCESS' THEN i.createdAt END)",
              'lastpush',
            )
            .groupBy('i.region')
            .getRawMany(),
          this.stores.find({ select: { branchCode: true, region: true } }),
          this.orders
            .createQueryBuilder('o')
            .select('o.branchCode', 'branchcode')
            .addSelect('COUNT(*)', 'failed')
            .where('o.status = :s', { s: SyncStatus.FAILED })
            .groupBy('o.branchCode')
            .getRawMany(),
        ]);

      // Failed orders are keyed by branchCode; roll them up to region.
      const regionByBranch = new Map<string, string>();
      for (const s of storeRows) {
        if (s.branchCode && s.region) regionByBranch.set(s.branchCode, s.region);
      }
      const failedByRegion = new Map<string, number>();
      for (const r of failedByBranch.map(lower)) {
        const region = regionByBranch.get(String(r.branchcode)) ?? 'UNMAPPED';
        failedByRegion.set(
          region,
          (failedByRegion.get(region) ?? 0) + num(r.failed),
        );
      }

      const rows = new Map<string, RegionStatusRow>();
      const ensure = (region: string): RegionStatusRow => {
        const key = region || 'UNKNOWN';
        let row = rows.get(key);
        if (!row) {
          row = {
            region: key,
            odooActive: false,
            lastOdooSync: null,
            lastOraclePush: null,
            ordersFetched: 0,
            odooRevenue: 0,
            invoicesPushed: 0,
            oracleRevenue: 0,
            failedOrders: 0,
          };
          rows.set(key, row);
        }
        return row;
      };

      for (const c of creds) {
        const row = ensure(c.region);
        if (c.active) row.odooActive = true;
        const t = c.lastSyncAt ? new Date(c.lastSyncAt).toISOString() : null;
        if (t && (!row.lastOdooSync || t > row.lastOdooSync))
          row.lastOdooSync = t;
      }
      for (const b of backupAgg.map(lower)) {
        const row = ensure(String(b.region ?? ''));
        row.ordersFetched = num(b.orders);
        row.odooRevenue = num(b.revenue);
      }
      for (const i of invoiceAgg.map(lower)) {
        const row = ensure(String(i.region ?? ''));
        row.invoicesPushed = num(i.invoices);
        row.oracleRevenue = num(i.revenue);
        row.lastOraclePush = i.lastpush
          ? new Date(i.lastpush as string).toISOString()
          : null;
      }
      for (const [region, failed] of failedByRegion) {
        if (region !== 'UNMAPPED') ensure(region).failedOrders = failed;
      }

      return [...rows.values()].sort((a, b) => a.region.localeCompare(b.region));
    });
  }

  /**
   * Per-store revenue from the Odoo backup (all pulled orders, so it reflects
   * Integration Run data which never touches OrderSyncQueue). Sorted by revenue.
   */
  async getStoreRevenue(): Promise<StoreRevenueRow[]> {
    return this.getCached('dashboard:store-revenue', 60, async () => {
      const raw = await this.backupOdoo
        .createQueryBuilder('b')
        .select('b.branchName', 'store')
        .addSelect('b.region', 'region')
        .addSelect('COUNT(*)', 'orders')
        .addSelect('SUM(b.amountTotal)', 'revenue')
        .groupBy('b.branchName')
        .addGroupBy('b.region')
        .getRawMany<Record<string, unknown>>();
      const num = (v: unknown) => {
        const n = Number(v ?? 0);
        return Number.isFinite(n) ? n : 0;
      };
      return raw
        .map((r) => {
          const row: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) row[k.toLowerCase()] = v;
          return {
            store: row.store ? String(row.store) : '(unknown)',
            region: row.region ? String(row.region) : '',
            orders: num(row.orders),
            odooRevenue: num(row.revenue),
          };
        })
        .sort((a, b) => b.odooRevenue - a.odooRevenue);
    });
  }

  /**
   * Executive/management KPIs: revenue completeness (Odoo vs Oracle), value at
   * risk, refund exposure, region freshness and store estate. Amounts are summed
   * across regions (mixed currency) as an indicative top-line; the per-region
   * breakdown keeps each region's own currency.
   */
  async getExecutiveSummary(): Promise<ExecutiveSummary> {
    return this.getCached('dashboard:executive-summary', 30, async () => {
      const now = Date.now();
      const since30 = new Date(now - 30 * 86_400_000);

      const sumOne = async (
        qb: SelectQueryBuilder<ObjectLiteral>,
      ): Promise<number> => {
        const raw = await qb.getRawOne<Record<string, unknown>>();
        const v = raw ? Number(Object.values(raw)[0] ?? 0) : 0;
        return Number.isFinite(v) ? v : 0;
      };

      const byRegion = await this.getRegionStatus();

      const [
        odooFetched,
        oraclePosted,
        oraclePosted30d,
        ordersFetched,
        ordersSynced,
        pending,
        failed,
        valueAtRisk,
        oldestPendingRaw,
        refundPendingCount,
        refundPendingValue,
        storesActive,
        storesNeedReview,
      ] = await Promise.all([
        sumOne(
          this.backupOdoo.createQueryBuilder('b').select('SUM(b.amountTotal)', 'v'),
        ),
        sumOne(
          this.invoiceHeaders
            .createQueryBuilder('i')
            .select('SUM(i.totalAmount)', 'v')
            .where("i.status = 'SUCCESS'"),
        ),
        sumOne(
          this.invoiceHeaders
            .createQueryBuilder('i')
            .select('SUM(i.totalAmount)', 'v')
            .where("i.status = 'SUCCESS'")
            .andWhere('i.createdAt >= :d', { d: since30 }),
        ),
        this.backupOdoo.count(),
        this.orders.count({ where: { status: SyncStatus.SYNCED } }),
        this.orders.count({ where: { status: SyncStatus.PENDING } }),
        this.orders.count({ where: { status: SyncStatus.FAILED } }),
        sumOne(
          this.orders
            .createQueryBuilder('o')
            .select('SUM(o.totalAmount)', 'v')
            .where('o.status IN (:...s)', {
              s: [SyncStatus.PENDING, SyncStatus.FAILED],
            }),
        ),
        this.orders
          .createQueryBuilder('o')
          .select('MIN(o.createdAt)', 'v')
          .where('o.status = :s', { s: SyncStatus.PENDING })
          .getRawOne<Record<string, unknown>>(),
        this.refunds.count({ where: { creditMemoStatus: SyncStatus.PENDING } }),
        sumOne(
          this.refunds
            .createQueryBuilder('r')
            .select('SUM(r.refundAmount)', 'v')
            .where('r.creditMemoStatus = :s', { s: SyncStatus.PENDING }),
        ),
        this.stores.count({ where: { isActive: true } }),
        this.stores.count({
          where: { validationStatus: Not(ValidationStatus.VALIDATED) },
        }),
      ]);

      const oldestVal = oldestPendingRaw
        ? Object.values(oldestPendingRaw)[0]
        : null;
      const oldestPendingHours = oldestVal
        ? Math.max(
            0,
            Math.round((now - new Date(oldestVal as string).getTime()) / 3_600_000),
          )
        : null;

      const current = byRegion.filter(
        (r) =>
          r.lastOdooSync &&
          now - new Date(r.lastOdooSync).getTime() < 86_400_000,
      ).length;

      const pct = (n: number, d: number) =>
        d > 0 ? Math.round((n / d) * 100) : 0;

      // Month-over-month Oracle revenue (calendar months).
      const dNow = new Date(now);
      const startThisMonth = new Date(dNow.getFullYear(), dNow.getMonth(), 1);
      const startLastMonth = new Date(
        dNow.getFullYear(),
        dNow.getMonth() - 1,
        1,
      );

      // Revenue momentum (last 14 days) + failure taxonomy + MoM sums.
      const since14 = new Date(now - 14 * 86_400_000);
      const [revenueTrendRaw, failureRows, mtdThis, mtdLast] = await Promise.all([
        this.invoiceHeaders
          .createQueryBuilder('i')
          .select("TO_CHAR(i.createdAt, 'YYYY-MM-DD')", 'day')
          .addSelect('SUM(i.totalAmount)', 'posted')
          .where("i.status = 'SUCCESS'")
          .andWhere('i.createdAt >= :d', { d: since14 })
          .groupBy("TO_CHAR(i.createdAt, 'YYYY-MM-DD')")
          .getRawMany<Record<string, unknown>>(),
        this.failedTransactions.find({
          where: { isResolved: false },
          select: { errorType: true },
          take: 5000,
        }),
        sumOne(
          this.invoiceHeaders
            .createQueryBuilder('i')
            .select('SUM(i.totalAmount)', 'v')
            .where("i.status = 'SUCCESS'")
            .andWhere('i.createdAt >= :d', { d: startThisMonth }),
        ),
        sumOne(
          this.invoiceHeaders
            .createQueryBuilder('i')
            .select('SUM(i.totalAmount)', 'v')
            .where("i.status = 'SUCCESS'")
            .andWhere('i.createdAt >= :a', { a: startLastMonth })
            .andWhere('i.createdAt < :b', { b: startThisMonth }),
        ),
      ]);

      const momGrowth =
        mtdLast > 0
          ? Math.round(((mtdThis - mtdLast) / mtdLast) * 100)
          : mtdThis > 0
            ? 100
            : 0;

      const trendMap = new Map<string, number>();
      for (const r of revenueTrendRaw) {
        const row: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) row[k.toLowerCase()] = v;
        if (row.day) trendMap.set(String(row.day), Number(row.posted ?? 0));
      }
      const revenueTrend: Array<{ date: string; posted: number }> = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
        revenueTrend.push({ date: d, posted: trendMap.get(d) ?? 0 });
      }

      const failureCounts = new Map<string, number>();
      for (const f of failureRows) {
        const reason = f.errorType || 'UNKNOWN';
        failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
      }
      const topFailures = [...failureCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      return {
        generatedAt: new Date(now).toISOString(),
        revenue: {
          odooFetched,
          oraclePosted,
          oraclePosted30d,
          completenessPct: pct(oraclePosted, odooFetched),
          gap: Math.max(0, odooFetched - oraclePosted),
        },
        orders: {
          fetched: ordersFetched,
          synced: ordersSynced,
          syncedPct: pct(ordersSynced, ordersFetched),
          pending,
          failed,
          valueAtRisk,
          oldestPendingHours,
        },
        refunds: {
          pendingCount: refundPendingCount,
          pendingValue: refundPendingValue,
        },
        regions: {
          total: byRegion.length,
          current,
          stale: byRegion.length - current,
        },
        stores: { active: storesActive, needsReview: storesNeedReview },
        revenueMoM: {
          thisMonth: mtdThis,
          lastMonth: mtdLast,
          growthPct: momGrowth,
        },
        byRegion,
        revenueTrend,
        topFailures,
      };
    });
  }

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
