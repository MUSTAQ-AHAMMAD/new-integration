import { Injectable, Logger } from '@nestjs/common';
import { AlertSeverity, AlertType, Prisma, SyncStatus } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { TimezoneService } from './timezone.service';

export interface OdooOrderData {
  odooOrderId: string;
  odooOrderNumber: string;
  branchCode: string;
  branchName?: string;
  orderDate: Date;
  originalTimezone: string;
  customerName?: string;
  customerEmail?: string;
  totalAmount: number;
  currency?: string;
  isPaid: boolean;
  isCancelled?: boolean;
  isRefund?: boolean;
  refundReferenceId?: string;
  negativeInventoryItems?: Array<{ sku: string; quantity: number }>;
}

@Injectable()
export class OrderSyncService {
  private readonly logger = new Logger(OrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly timezoneService: TimezoneService,
    private readonly alertsService: AlertsService,
  ) {}

  async ingestOrder(data: OdooOrderData): Promise<void> {
    // Auto-detect refunds: negative total amount must be treated as a credit note
    // even when the caller did not explicitly set isRefund.
    let processedData = data;
    if (data.totalAmount < 0 && !data.isRefund) {
      processedData = { ...data, isRefund: true };
      await this.alertsService.createAlert({
        alertType: AlertType.REFUND_DETECTED,
        severity: AlertSeverity.WARNING,
        title: 'Negative-amount invoice auto-detected as refund',
        message: `Order ${data.odooOrderNumber} (branch: ${data.branchCode}) has a negative total (${data.totalAmount}). It has been automatically classified as a refund and will be recorded as a credit note instead of an AR invoice.`,
        relatedEntityId: data.odooOrderId,
        relatedEntityType: 'ORDER_SYNC_QUEUE',
      });
    }

    const orderDateUtc = this.timezoneService.normalizeToUtc(
      processedData.orderDate,
      processedData.originalTimezone,
    );
    const hasNegativeInventory =
      (processedData.negativeInventoryItems?.length ?? 0) > 0;

    const order = await this.prisma.orderSyncQueue.upsert({
      where: {
        odooOrderId_branchCode: {
          odooOrderId: processedData.odooOrderId,
          branchCode: processedData.branchCode,
        },
      },
      create: {
        odooOrderId: processedData.odooOrderId,
        odooOrderNumber: processedData.odooOrderNumber,
        branchCode: processedData.branchCode,
        branchName: processedData.branchName,
        orderDate: processedData.orderDate,
        orderDateUtc,
        originalTimezone: processedData.originalTimezone,
        customerName: processedData.customerName,
        customerEmail: processedData.customerEmail,
        totalAmount: new Prisma.Decimal(processedData.totalAmount),
        currency: processedData.currency || 'AED',
        isPaid: processedData.isPaid,
        isCancelled: processedData.isCancelled ?? false,
        isRefund: processedData.isRefund ?? false,
        refundReferenceId: processedData.refundReferenceId,
        negativeInventoryFlag: hasNegativeInventory,
        negativeInventoryItems: processedData.negativeInventoryItems
          ? (processedData.negativeInventoryItems as unknown as Prisma.InputJsonValue)
          : undefined,
        status:
          processedData.isPaid && !(processedData.isCancelled ?? false)
            ? SyncStatus.PENDING
            : SyncStatus.SKIPPED,
      },
      update: {
        odooOrderNumber: processedData.odooOrderNumber,
        branchName: processedData.branchName,
        orderDate: processedData.orderDate,
        orderDateUtc,
        originalTimezone: processedData.originalTimezone,
        customerName: processedData.customerName,
        customerEmail: processedData.customerEmail,
        totalAmount: new Prisma.Decimal(processedData.totalAmount),
        currency: processedData.currency || 'AED',
        isPaid: processedData.isPaid,
        isCancelled: processedData.isCancelled ?? false,
        isRefund: processedData.isRefund ?? false,
        refundReferenceId: processedData.refundReferenceId,
        negativeInventoryFlag: hasNegativeInventory,
        negativeInventoryItems: processedData.negativeInventoryItems
          ? (processedData.negativeInventoryItems as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        status:
          processedData.isPaid && !(processedData.isCancelled ?? false)
            ? SyncStatus.PENDING
            : SyncStatus.SKIPPED,
      },
    });

    if (processedData.isRefund && processedData.refundReferenceId) {
      await this.prisma.refundTracking.upsert({
        where: { refundOrderId: processedData.odooOrderId },
        create: {
          originalOrderId: processedData.refundReferenceId,
          originalOrderNumber: processedData.refundReferenceId,
          refundOrderId: processedData.odooOrderId,
          refundOrderNumber: processedData.odooOrderNumber,
          refundAmount: new Prisma.Decimal(Math.abs(processedData.totalAmount)),
          refundReason: 'Webhook refund event',
          refundDate: orderDateUtc,
          oracleCreditMemoNumber: '',
          creditMemoStatus: SyncStatus.PENDING,
        },
        update: {
          refundAmount: new Prisma.Decimal(Math.abs(processedData.totalAmount)),
          refundDate: orderDateUtc,
          creditMemoStatus: SyncStatus.PENDING,
        },
      });
    }

    if (processedData.isPaid && !(processedData.isCancelled ?? false)) {
      await this.queues.enqueueOrderSync({
        orderSyncQueueId: order.id,
        odooOrderId: processedData.odooOrderId,
        branchCode: processedData.branchCode,
      });
    }

    this.logger.log(
      `Order ${processedData.odooOrderId} ingested for branch ${processedData.branchCode}`,
    );
  }

  async retryFailedOrders(branchCode?: string) {
    const failedOrders = await this.prisma.orderSyncQueue.findMany({
      where: {
        status: SyncStatus.FAILED,
        ...(branchCode ? { branchCode } : {}),
        isPaid: true,
        isCancelled: false,
      },
      take: 100,
    });

    let enqueued = 0;
    for (const order of failedOrders) {
      await this.queues.enqueueOrderSync({
        orderSyncQueueId: order.id,
        odooOrderId: order.odooOrderId,
        branchCode: order.branchCode,
        isRetry: true,
      });
      enqueued += 1;
    }

    this.logger.log(`Re-queued ${enqueued} failed orders`);
    return { enqueued };
  }

  /**
   * Re-queues orders that were held due to negative inventory after Finance
   * has corrected the stock. Optionally scoped to a single branch.
   */
  async retryNegativeInventoryOrders(branchCode?: string) {
    const heldOrders = await this.prisma.orderSyncQueue.findMany({
      where: {
        status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
        ...(branchCode ? { branchCode } : {}),
        isPaid: true,
        isCancelled: false,
      },
      take: 100,
    });

    let enqueued = 0;
    for (const order of heldOrders) {
      await this.queues.enqueueOrderSync({
        orderSyncQueueId: order.id,
        odooOrderId: order.odooOrderId,
        branchCode: order.branchCode,
        isRetry: true,
      });
      enqueued += 1;
    }

    this.logger.log(
      `Re-queued ${enqueued} negative-inventory-hold orders` +
        (branchCode ? ` for branch ${branchCode}` : ''),
    );
    return { enqueued };
  }
}
