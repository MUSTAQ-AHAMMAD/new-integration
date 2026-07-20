import { Controller, Get, Query, Param } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { FusionCredential } from '../database/entities/fusion-credential.entity';
import { IbqCredential } from '../database/entities/ibq-credential.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncControl } from '../database/entities/sync-control.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { JobStatus, SyncStatus } from '../database/enums';
import { Roles } from '../auth/roles.decorator';

@ApiTags('admin')
@Controller('admin/diagnostics')
@Roles('ADMIN')
export class AdminDiagnosticsController {
  constructor(
    @InjectRepository(OrderSyncQueue)
    private readonly orders: Repository<OrderSyncQueue>,
    @InjectRepository(VendHqItemMeta)
    private readonly items: Repository<VendHqItemMeta>,
    @InjectRepository(FusionCredential)
    private readonly fusionCreds: Repository<FusionCredential>,
    @InjectRepository(VendHqCredential)
    private readonly vendhqCreds: Repository<VendHqCredential>,
    @InjectRepository(OdooCredential)
    private readonly odooCreds: Repository<OdooCredential>,
    @InjectRepository(IbqCredential)
    private readonly ibqCreds: Repository<IbqCredential>,
    @InjectRepository(SyncJob)
    private readonly syncJobs: Repository<SyncJob>,
    @InjectRepository(SyncControl)
    private readonly syncControls: Repository<SyncControl>,
  ) {}

  @Get('sync/skipped-orders')
  @ApiOperation({
    summary: 'Get orders that were skipped during sync with reasons',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'region', required: false })
  async getSkippedOrders(
    @Query('limit') limit?: string,
    @Query('region') region?: string,
  ) {
    const take = limit ? parseInt(limit, 10) : 50;

    if (region) {
      // OrderSyncQueue doesn't have a direct region field, so we need to filter differently
      // For now, just return all skipped orders
    }

    const skippedOrders = await this.orders.find({
      where: { status: SyncStatus.SKIPPED },
      take,
      order: { createdAt: 'DESC' },
      select: {
        id: true,
        odooOrderId: true,
        odooOrderNumber: true,
        branchCode: true,
        branchName: true,
        orderDate: true,
        isPaid: true,
        isCancelled: true,
        totalAmount: true,
        status: true,
        validationErrors: true,
        syncAttempts: true,
        lastSyncAt: true,
        createdAt: true,
      },
    });

    // Analyze why each order was skipped
    const analysis = skippedOrders.map((order) => {
      const reasons: string[] = [];

      if (!order.isPaid) {
        reasons.push('Order is not marked as paid (isPaid=false)');
      }

      if (order.isCancelled) {
        reasons.push('Order is cancelled');
      }

      if (order.validationErrors) {
        reasons.push(
          `Validation errors: ${JSON.stringify(order.validationErrors)}`,
        );
      }

      if (reasons.length === 0) {
        reasons.push(
          'Unknown reason - order meets all criteria but was skipped',
        );
      }

      return {
        ...order,
        skipReasons: reasons,
      };
    });

    return {
      total: analysis.length,
      orders: analysis,
      summary: {
        notPaid: analysis.filter((o) => !o.isPaid).length,
        cancelled: analysis.filter((o) => o.isCancelled).length,
        validationErrors: analysis.filter((o) => o.validationErrors !== null)
          .length,
      },
    };
  }

  @Get('sync/order-status/:orderId')
  @ApiOperation({ summary: 'Get detailed status for a specific order' })
  async getOrderStatus(@Param('orderId') orderId: string) {
    const orderQueue = await this.orders.findOne({
      where: { odooOrderId: orderId },
    });

    if (!orderQueue) {
      return {
        found: false,
        message: `Order ${orderId} not found in OrderSyncQueue`,
      };
    }

    const reasons: string[] = [];
    const recommendations: string[] = [];

    if (!orderQueue.isPaid) {
      reasons.push('Order is marked as isPaid=false');
      recommendations.push(
        'Check if the order state in Odoo/IBQ indicates payment. Use POST /sync/orders/retry-skipped to re-evaluate.',
      );
    }

    if (orderQueue.isCancelled) {
      reasons.push('Order is marked as cancelled');
      recommendations.push('Verify if this order should actually be synced.');
    }

    if (orderQueue.validationErrors) {
      reasons.push(
        `Validation errors: ${JSON.stringify(orderQueue.validationErrors)}`,
      );
      recommendations.push(
        'Fix the validation errors in the source data and re-ingest the order.',
      );
    }

    return {
      found: true,
      order: orderQueue,
      skipReasons:
        reasons.length > 0 ? reasons : ['Order should be eligible for sync'],
      recommendations,
      canRetry:
        orderQueue.status === SyncStatus.SKIPPED && !orderQueue.isCancelled,
    };
  }

  @Get('items/sync-status')
  @ApiOperation({ summary: 'Get item sync status summary' })
  @ApiQuery({ name: 'region', required: false })
  async getItemSyncStatus(@Query('region') region?: string) {
    const where = region ? { region } : {};

    const [total, successCount, errorCount, recentItems] = await Promise.all([
      this.items.count({ where }),
      this.items.count({
        where: { ...where, status: 'SUCCESS' },
      }),
      this.items.count({
        where: { ...where, status: 'ERROR' },
      }),
      this.items.find({
        where,
        take: 20,
        order: { lastUpdateDate: 'DESC' },
        select: {
          itemId: true,
          sku: true,
          name: true,
          region: true,
          status: true,
          message: true,
          active: true,
          lastUpdateDate: true,
        },
      }),
    ]);

    const errors = recentItems.filter((item) => item.status === 'ERROR');

    return {
      summary: {
        total,
        successCount,
        errorCount,
        successRate:
          total > 0 ? ((successCount / total) * 100).toFixed(2) : '0',
      },
      recentItems,
      recentErrors: errors,
      recommendations:
        errorCount > 0
          ? [
              'Review error messages in VendHqItemMeta table',
              'Check VendHQ credentials are active and valid',
              'Verify Oracle Fusion API is returning items correctly',
              'Use POST /item-sync/trigger/{region} to manually trigger sync',
            ]
          : [
              'Item sync appears healthy',
              'Use POST /item-sync/trigger/{region} to manually trigger sync if needed',
            ],
    };
  }

  @Get('credentials/status')
  @ApiOperation({ summary: 'Check status of all credentials' })
  async getCredentialsStatus() {
    const [fusionCreds, vendhqCreds, odooCreds, ibqCreds] = await Promise.all([
      this.fusionCreds.find({
        select: {
          id: true,
          hostName: true,
          server: true,
          username: true,
          active: true,
          createdAt: true,
        },
      }),
      this.vendhqCreds.find({
        select: {
          id: true,
          region: true,
          domainName: true,
          active: true,
          fusionOrgCode: true,
          createdAt: true,
        },
      }),
      this.odooCreds.find({
        select: {
          id: true,
          baseUrl: true,
          region: true,
          active: true,
          createdAt: true,
        },
      }),
      this.ibqCreds.find({
        select: {
          id: true,
          baseUrl: true,
          region: true,
          active: true,
          createdAt: true,
        },
      }),
    ]);

    const issues: string[] = [];
    const recommendations: string[] = [];

    if (fusionCreds.filter((c) => c.active).length === 0) {
      issues.push('No active Fusion credentials');
      recommendations.push(
        'Add active Fusion credentials via /admin/fusion-credentials',
      );
    }

    if (vendhqCreds.filter((c) => c.active).length === 0) {
      issues.push('No active VendHQ credentials');
      recommendations.push(
        'Add active VendHQ credentials via /admin/vendhq-credentials',
      );
    }

    return {
      status: issues.length === 0 ? 'healthy' : 'issues_found',
      credentials: {
        fusion: {
          total: fusionCreds.length,
          active: fusionCreds.filter((c) => c.active).length,
          credentials: fusionCreds,
        },
        vendhq: {
          total: vendhqCreds.length,
          active: vendhqCreds.filter((c) => c.active).length,
          credentials: vendhqCreds,
        },
        odoo: {
          total: odooCreds.length,
          active: odooCreds.filter((c) => c.active).length,
          credentials: odooCreds,
        },
        ibq: {
          total: ibqCreds.length,
          active: ibqCreds.filter((c) => c.active).length,
          credentials: ibqCreds,
        },
      },
      issues,
      recommendations,
    };
  }

  @Get('system/health')
  @ApiOperation({ summary: 'Overall system health check' })
  async getSystemHealth() {
    const [
      syncJobs,
      syncControls,
      pendingOrdersCount,
      skippedOrdersCount,
      itemSyncErrors,
    ] = await Promise.all([
      this.syncJobs.find({
        where: {
          createdAt: MoreThanOrEqual(
            new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
          ),
        },
        order: { createdAt: 'DESC' },
        take: 10,
      }),
      this.syncControls.find(),
      this.orders.count({ where: { status: SyncStatus.PENDING } }),
      this.orders.count({ where: { status: SyncStatus.SKIPPED } }),
      this.items.count({ where: { status: 'ERROR' } }),
    ]);

    const issues: string[] = [];
    const warnings: string[] = [];

    // Check if any sync controls are disabled
    const disabledServices = syncControls.filter((s) => !s.enabled);
    if (disabledServices.length > 0) {
      warnings.push(
        `Sync services disabled: ${disabledServices.map((s) => s.serviceName).join(', ')}`,
      );
    }

    // Check for high skip rate
    if (skippedOrdersCount > pendingOrdersCount) {
      warnings.push(
        `High skip rate: ${skippedOrdersCount} skipped vs ${pendingOrdersCount} pending orders`,
      );
    }

    // Check for item sync errors
    if (itemSyncErrors > 0) {
      warnings.push(`${itemSyncErrors} items have sync errors`);
    }

    // Check for failed jobs
    const recentFailedJobs = syncJobs.filter(
      (j) => j.status === JobStatus.FAILED,
    );
    if (recentFailedJobs.length > 0) {
      issues.push(
        `${recentFailedJobs.length} sync jobs failed in the last 24 hours`,
      );
    }

    return {
      status:
        issues.length > 0
          ? 'unhealthy'
          : warnings.length > 0
            ? 'degraded'
            : 'healthy',
      timestamp: new Date().toISOString(),
      summary: {
        pendingOrders: pendingOrdersCount,
        skippedOrders: skippedOrdersCount,
        itemSyncErrors,
        recentJobsCount: syncJobs.length,
        failedJobsCount: recentFailedJobs.length,
      },
      syncControls: syncControls.map((s) => ({
        service: s.serviceName,
        enabled: s.enabled,
        isRunning: s.isRunning,
        lastRunAt: s.lastRunAt,
        lastStatus: s.lastStatus,
      })),
      recentJobs: syncJobs.map((j) => ({
        id: j.id,
        jobType: j.jobType,
        status: j.status,
        totalRecords: j.totalRecords,
        processedRecords: j.processedRecords,
        successCount: j.successCount,
        failedCount: j.failedCount,
        skippedCount: j.skippedCount,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
      })),
      issues,
      warnings,
    };
  }
}
