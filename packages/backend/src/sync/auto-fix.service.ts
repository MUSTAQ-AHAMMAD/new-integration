/**
 * Auto-Fix Service - Automatically diagnoses and fixes common sync issues
 */
import { Injectable, Logger } from '@nestjs/common';
import { SyncStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderDiagnosticsService } from './order-diagnostics.service';
import { QueuesService } from '../queues/queues.service';
import { PAID_ORDER_STATES } from '../common/odoo-utils';

export interface AutoFixResult {
  orderSyncQueueId: string;
  odooOrderId: string;
  branchCode: string;
  issue: string;
  action: string;
  success: boolean;
  message: string;
}

export interface AutoFixSummary {
  totalProcessed: number;
  fixed: number;
  couldNotFix: number;
  results: AutoFixResult[];
}

@Injectable()
export class AutoFixService {
  private readonly logger = new Logger(AutoFixService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly diagnosticsService: OrderDiagnosticsService,
    private readonly queuesService: QueuesService,
  ) {}

  /**
   * Automatically diagnose and fix skipped orders
   * @param odooOrderId Optional specific order to fix
   * @param branchCode Optional branch filter
   * @param limit Maximum number of orders to process
   */
  async autoFixSkippedOrders(
    odooOrderId?: string,
    branchCode?: string,
    limit = 100,
  ): Promise<AutoFixSummary> {
    this.logger.log(
      `Auto-fixing skipped orders${odooOrderId ? ` for order ${odooOrderId}` : ''}${branchCode ? ` in branch ${branchCode}` : ''}`,
    );

    const results: AutoFixResult[] = [];

    // Find skipped orders
    const where: any = {
      status: SyncStatus.SKIPPED,
    };

    if (odooOrderId) {
      where.odooOrderId = odooOrderId;
    }

    if (branchCode) {
      where.branchCode = branchCode;
    }

    const skippedOrders = await this.prisma.orderSyncQueue.findMany({
      where,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    this.logger.log(`Found ${skippedOrders.length} skipped orders to analyze`);

    for (const order of skippedOrders) {
      try {
        const result = await this.autoFixOrder(order);
        results.push(result);
      } catch (error) {
        this.logger.error(
          `Error auto-fixing order ${order.odooOrderId}:`,
          error,
        );
        results.push({
          orderSyncQueueId: order.id,
          odooOrderId: order.odooOrderId,
          branchCode: order.branchCode,
          issue: 'ERROR',
          action: 'none',
          success: false,
          message: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const fixed = results.filter((r) => r.success).length;
    const couldNotFix = results.length - fixed;

    this.logger.log(
      `Auto-fix complete: ${fixed} fixed, ${couldNotFix} could not fix`,
    );

    return {
      totalProcessed: results.length,
      fixed,
      couldNotFix,
      results,
    };
  }

  private async autoFixOrder(
    order: any,
  ): Promise<AutoFixResult> {
    const result: AutoFixResult = {
      orderSyncQueueId: order.id,
      odooOrderId: order.odooOrderId,
      branchCode: order.branchCode,
      issue: 'unknown',
      action: 'none',
      success: false,
      message: '',
    };

    // Run diagnostics
    const diagnostic = await this.diagnosticsService.diagnoseOrder(
      order.odooOrderId,
      order.branchCode,
    );

    // Analyze and fix
    if (!order.isPaid && !order.isCancelled) {
      result.issue = 'not_marked_as_paid';

      // Check if we have backup data
      const backup = diagnostic.backupOdooOrder || diagnostic.backupIbqOrder;

      if (backup) {
        const state = (backup.state || '').toLowerCase().trim();

        // Check if state should be paid (use imported PAID_ORDER_STATES)
        if ((PAID_ORDER_STATES as readonly string[]).includes(state)) {
          // State indicates paid - re-ingest this order
          result.action = 'reingest';
          result.message = `Order state "${backup.state}" indicates payment, but isPaid=false. Re-ingesting from backup.`;

          // Re-ingest by updating the order
          await this.prisma.orderSyncQueue.update({
            where: { id: order.id },
            data: {
              isPaid: true,
              status: SyncStatus.PENDING,
              validationErrors: Prisma.JsonNull,
              updatedAt: new Date(),
            },
          });

          // Re-queue for processing
          await this.queuesService.enqueueOrderSync({
            orderSyncQueueId: order.id,
            odooOrderId: order.odooOrderId,
            branchCode: order.branchCode,
          });

          result.success = true;
          result.message += ' Order updated and re-queued for sync.';
        } else {
          // State does not indicate paid
          result.action = 'none';
          result.message = `Order state "${backup.state}" does not indicate payment. Cannot auto-fix. Consider adding this state to PAID_ORDER_STATES if it should be considered paid.`;
          result.success = false;
        }
      } else {
        // No backup data - try to sync anyway if order has basic data
        result.action = 'retry';
        result.message =
          'No backup data found, but order will sync with minimal data. Re-queuing for processing.';
        
        // Update status to PENDING and re-queue
        await this.prisma.orderSyncQueue.update({
          where: { id: order.id },
          data: {
            isPaid: true, // Assume paid since it was fetched
            status: SyncStatus.PENDING,
            validationErrors: Prisma.JsonNull,
            updatedAt: new Date(),
          },
        });

        await this.queuesService.enqueueOrderSync({
          orderSyncQueueId: order.id,
          odooOrderId: order.odooOrderId,
          branchCode: order.branchCode,
        });
        
        result.success = true;
      }
    } else if (order.isCancelled) {
      result.issue = 'cancelled';
      result.action = 'none';
      result.message = 'Order is cancelled - intentionally skipped.';
      result.success = false;
    } else if (order.isPaid && !order.isCancelled) {
      // Order is paid and not cancelled, but still skipped - validation issue
      result.issue = 'validation_error';
      result.action = 'retry';
      result.message = 'Order is marked as paid - retrying sync.';

      // Update status to PENDING and re-queue
      await this.prisma.orderSyncQueue.update({
        where: { id: order.id },
        data: {
          status: SyncStatus.PENDING,
          validationErrors: Prisma.JsonNull,
          updatedAt: new Date(),
        },
      });

      await this.queuesService.enqueueOrderSync({
        orderSyncQueueId: order.id,
        odooOrderId: order.odooOrderId,
        branchCode: order.branchCode,
      });

      result.success = true;
    }

    return result;
  }

  /**
   * Check if a specific order state should be added to PAID_ORDER_STATES
   */
  async suggestStatesToAdd(): Promise<{
    suggestions: Array<{ state: string; count: number; sample: any }>;
  }> {
    // Find skipped orders with backup data
    const skippedOrders = await this.prisma.orderSyncQueue.findMany({
      where: {
        status: SyncStatus.SKIPPED,
        isPaid: false,
        isCancelled: false,
        odooBackupOrderId: { not: null },
      },
      select: {
        id: true,
        odooOrderId: true,
        branchCode: true,
        odooBackupOrderId: true,
      },
      take: 1000,
    });

    // Get backup data
    const backupIds = skippedOrders
      .map((o) => o.odooBackupOrderId)
      .filter((id): id is string => id !== null);

    const backups = await this.prisma.backupOdooOrder.findMany({
      where: { id: { in: backupIds } },
      select: {
        id: true,
        orderId: true,
        orderName: true,
        state: true,
        amountTotal: true,
        orderPayments: true,
      },
    });

    // Group by state
    const stateGroups = new Map<string, any[]>();

    for (const backup of backups) {
      if (backup.state) {
        const normalized = backup.state.toLowerCase().trim();
        if (!stateGroups.has(normalized)) {
          stateGroups.set(normalized, []);
        }
        stateGroups.get(normalized)!.push(backup);
      }
    }

    // Build suggestions
    const suggestions = Array.from(stateGroups.entries())
      .map(([state, orders]) => ({
        state,
        count: orders.length,
        sample: {
          orderId: orders[0].orderId,
          orderName: orders[0].orderName,
          amountTotal: orders[0].amountTotal,
          hasPaymentData: (orders[0].orderPayments?.length ?? 0) > 0,
        },
      }))
      .sort((a, b) => b.count - a.count);

    this.logger.log(
      `Found ${suggestions.length} unique states in skipped orders`,
    );

    return { suggestions };
  }
}
