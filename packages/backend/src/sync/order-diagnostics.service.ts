/**
 * Order Diagnostics Service - Helper service to troubleshoot Oracle sync issues
 * 
 * Provides detailed diagnostics on why orders are being skipped or failed during
 * the Oracle sync process.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface OrderDiagnostic {
  orderSyncQueue: {
    odooOrderId: string;
    odooOrderNumber: string | null;
    branchCode: string;
    status: SyncStatus;
    isPaid: boolean;
    isCancelled: boolean;
    isRefund: boolean;
    totalAmount: number | string;
    negativeInventoryFlag: boolean;
    validationErrors: unknown;
    syncAttempts: number;
    lastSyncAt: Date | null;
    createdAt: Date;
  } | null;
  backupOdooOrder: {
    orderId: number;
    orderName: string | null;
    state: string | null;
    amountTotal: number | null;
    dateOrder: Date | null;
    branchId: unknown;
  } | null;
  backupIbqOrder: {
    orderId: number;
    orderName: string | null;
    state: string | null;
    amountTotal: number | null;
    dateOrder: Date | null;
    branchId: unknown;
  } | null;
  storeConfig: {
    branchCode: string;
    branchName: string | null;
    isActive: boolean;
    validationStatus: string | null;
    billToSiteName: string | null;
    oracleOperatingUnitId: bigint | null;
  } | null;
  analysis: {
    primaryIssue: string;
    reasons: string[];
    recommendations: string[];
    canRetry: boolean;
  };
}

@Injectable()
export class OrderDiagnosticsService {
  private readonly logger = new Logger(OrderDiagnosticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Diagnose why a specific order is not syncing to Oracle
   * @param odooOrderId The Odoo order ID to diagnose
   * @param branchCode The branch code (required for unique identification)
   */
  async diagnoseOrder(
    odooOrderId: string,
    branchCode?: string,
  ): Promise<OrderDiagnostic> {
    // Find order in sync queue
    const queueEntry = branchCode
      ? await this.prisma.orderSyncQueue.findUnique({
          where: { odooOrderId_branchCode: { odooOrderId, branchCode } },
        })
      : await this.prisma.orderSyncQueue.findFirst({
          where: { odooOrderId },
        });

    if (!queueEntry) {
      return {
        orderSyncQueue: null,
        backupOdooOrder: null,
        backupIbqOrder: null,
        storeConfig: null,
        analysis: {
          primaryIssue: 'ORDER_NOT_FOUND',
          reasons: [
            `Order ${odooOrderId} not found in OrderSyncQueue`,
            'This order has not been ingested from Odoo/IBQ backup yet',
          ],
          recommendations: [
            'Run a backup fetch from Odoo/IBQ to ingest this order',
            'POST /odoo-backup/fetch-orders or POST /ibq-backup/fetch-orders',
            'Verify the order exists in the source system (Odoo/IBQ)',
          ],
          canRetry: false,
        },
      };
    }

    const effectiveBranchCode = queueEntry.branchCode;

    // Fetch related data in parallel
    const [backupOdoo, backupIbq, storeConfig] = await Promise.all([
      queueEntry.odooBackupOrderId
        ? this.prisma.backupOdooOrder.findUnique({
            where: { id: queueEntry.odooBackupOrderId },
            select: {
              orderId: true,
              orderName: true,
              state: true,
              amountTotal: true,
              dateOrder: true,
              branchId: true,
            },
          })
        : null,
      this.prisma.backupIbqOrder.findFirst({
        where: {
          OR: [
            { orderId: parseInt(odooOrderId, 10) || -1 },
            { orderName: queueEntry.odooOrderNumber },
          ],
        },
        select: {
          orderId: true,
          orderName: true,
          state: true,
          amountTotal: true,
          dateOrder: true,
          branchId: true,
        },
      }),
      this.prisma.storeConfiguration.findUnique({
        where: { branchCode: effectiveBranchCode },
        select: {
          branchCode: true,
          branchName: true,
          isActive: true,
          validationStatus: true,
          billToSiteName: true,
          oracleOperatingUnitId: true,
        },
      }),
    ]);

    // Perform analysis
    const analysis = this.analyzeOrder(
      queueEntry,
      backupOdoo,
      backupIbq,
      storeConfig,
    );

    return {
      orderSyncQueue: {
        odooOrderId: queueEntry.odooOrderId,
        odooOrderNumber: queueEntry.odooOrderNumber,
        branchCode: queueEntry.branchCode,
        status: queueEntry.status,
        isPaid: queueEntry.isPaid,
        isCancelled: queueEntry.isCancelled,
        isRefund: queueEntry.isRefund,
        totalAmount: queueEntry.totalAmount.toString(),
        negativeInventoryFlag: queueEntry.negativeInventoryFlag,
        validationErrors: queueEntry.validationErrors,
        syncAttempts: queueEntry.syncAttempts,
        lastSyncAt: queueEntry.lastSyncAt,
        createdAt: queueEntry.createdAt,
      },
      backupOdooOrder: backupOdoo,
      backupIbqOrder: backupIbq,
      storeConfig,
      analysis,
    };
  }

  private analyzeOrder(
    queue: any,
    backupOdoo: any,
    backupIbq: any,
    storeConfig: any,
  ): OrderDiagnostic['analysis'] {
    const reasons: string[] = [];
    const recommendations: string[] = [];
    let primaryIssue = 'UNKNOWN';
    let canRetry = false;

    // Check status
    if (queue.status === SyncStatus.SKIPPED) {
      primaryIssue = 'ORDER_SKIPPED';
      reasons.push('Order was skipped during sync job processing');

      // Analyze why it was skipped
      if (!queue.isPaid) {
        const backup = backupOdoo || backupIbq;
        const state = backup?.state || 'unknown';
        reasons.push(
          `Order is not marked as paid (isPaid=false)`,
          `Source order state: "${state}"`,
          `Accepted paid states: paid, done, posted, invoiced, sale, invoice`,
        );
        recommendations.push(
          `Check if the order state "${state}" should be considered paid`,
          'If the state is valid, the PAID_ORDER_STATES list may need to be expanded',
          'Contact the development team to update the state mapping',
          'After fixing the mapping, use POST /sync/orders/retry-skipped to re-process this order',
        );
        canRetry = true;
      }

      if (queue.isCancelled) {
        reasons.push('Order is marked as cancelled');
        recommendations.push(
          'Cancelled orders are intentionally skipped',
          'If this order should be synced, update its state in the source system',
        );
        canRetry = false;
      }
    } else if (queue.status === SyncStatus.FAILED) {
      primaryIssue = 'SYNC_FAILED';
      reasons.push(
        `Order failed during Oracle sync (${queue.syncAttempts} attempts)`,
      );
      
      if (queue.validationErrors) {
        reasons.push(`Validation errors: ${JSON.stringify(queue.validationErrors)}`);
      }

      recommendations.push(
        'Check FailedTransaction table for detailed error information',
        'Query: SELECT * FROM "FailedTransaction" WHERE "orderSyncQueueId" = $orderQueueId',
        'Use POST /sync/orders/retry-failed to retry this order',
      );
      canRetry = true;
    } else if (queue.status === SyncStatus.PENDING) {
      primaryIssue = 'PENDING_SYNC';
      reasons.push('Order is waiting in queue to be synced to Oracle');
      recommendations.push(
        'Check BullMQ queue status to ensure workers are processing',
        'Check backend logs for any worker errors',
        'Verify Oracle SOAP connectivity',
      );
      canRetry = false;
    } else if (queue.status === SyncStatus.PROCESSING) {
      primaryIssue = 'CURRENTLY_PROCESSING';
      reasons.push('Order is currently being processed');
      recommendations.push('Wait for processing to complete', 'Check logs for progress');
      canRetry = false;
    } else if (queue.status === SyncStatus.SYNCED) {
      primaryIssue = 'ALREADY_SYNCED';
      reasons.push('Order has been successfully synced to Oracle');
      recommendations.push(
        'Check FusionInvoiceHeader table for Oracle invoice details',
        'Query: SELECT * FROM "FusionInvoiceHeader" WHERE region = $region',
      );
      canRetry = false;
    } else if (queue.status === SyncStatus.NEGATIVE_INVENTORY_HOLD) {
      primaryIssue = 'NEGATIVE_INVENTORY_HOLD';
      reasons.push(
        'Order is on hold due to negative inventory',
        `Negative inventory items: ${JSON.stringify(queue.negativeInventoryItems || [])}`,
      );
      recommendations.push(
        'Finance team must correct inventory levels in Oracle',
        'After correction, use POST /sync/orders/retry-negative-inventory to retry',
      );
      canRetry = true;
    }

    // Check store configuration
    if (!storeConfig) {
      reasons.push(
        `No store configuration found for branch: ${queue.branchCode}`,
      );
      recommendations.push(
        'Create store configuration via /admin/store-configurations',
        'Ensure all required Oracle mapping fields are filled',
      );
      canRetry = false;
    } else if (!storeConfig.isActive) {
      reasons.push(`Store ${queue.branchCode} is marked as inactive`);
      recommendations.push(
        'Activate the store in store configuration settings',
      );
      canRetry = false;
    } else if (storeConfig.validationStatus === 'INVALID') {
      reasons.push(`Store ${queue.branchCode} has invalid configuration`);
      recommendations.push(
        'Review and fix store configuration validation errors',
        'Check required Oracle fields: billToSiteName, oracleOperatingUnitId',
      );
      canRetry = false;
    }

    // Check if backup data is missing
    if (!backupOdoo && !backupIbq && queue.odooBackupOrderId) {
      reasons.push(
        'Backup order data is missing or has been purged',
      );
      recommendations.push(
        'Re-fetch the order from source system',
        'The order may need to be re-ingested',
      );
    }

    return {
      primaryIssue,
      reasons,
      recommendations,
      canRetry,
    };
  }

  /**
   * Get summary statistics for all orders to identify common issues
   */
  async getOrderStatsSummary() {
    const [
      totalOrders,
      skippedOrders,
      failedOrders,
      pendingOrders,
      syncedOrders,
      negativeInventoryOrders,
      skippedUnpaid,
      skippedCancelled,
    ] = await Promise.all([
      this.prisma.orderSyncQueue.count(),
      this.prisma.orderSyncQueue.count({
        where: { status: SyncStatus.SKIPPED },
      }),
      this.prisma.orderSyncQueue.count({ where: { status: SyncStatus.FAILED } }),
      this.prisma.orderSyncQueue.count({
        where: { status: SyncStatus.PENDING },
      }),
      this.prisma.orderSyncQueue.count({ where: { status: SyncStatus.SYNCED } }),
      this.prisma.orderSyncQueue.count({
        where: { status: SyncStatus.NEGATIVE_INVENTORY_HOLD },
      }),
      this.prisma.orderSyncQueue.count({
        where: { status: SyncStatus.SKIPPED, isPaid: false },
      }),
      this.prisma.orderSyncQueue.count({
        where: { status: SyncStatus.SKIPPED, isCancelled: true },
      }),
    ]);

    return {
      totalOrders,
      byStatus: {
        skipped: skippedOrders,
        failed: failedOrders,
        pending: pendingOrders,
        synced: syncedOrders,
        negativeInventoryHold: negativeInventoryOrders,
      },
      skippedReasons: {
        unpaid: skippedUnpaid,
        cancelled: skippedCancelled,
      },
      syncRate:
        totalOrders > 0
          ? ((syncedOrders / totalOrders) * 100).toFixed(2) + '%'
          : 'N/A',
    };
  }
}
