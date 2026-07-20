import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Decimal } from 'decimal.js';
import { AlertsService } from '../alerts/alerts.service';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { AlertSeverity, AlertType, SyncStatus } from '../database/enums';
import { QueuesService } from '../queues/queues.service';
import { TimezoneService } from './timezone.service';

export interface OrderLineData {
  productId?: number;
  productName?: string;
  productCode?: string;
  qty?: number;
  priceUnit?: number;
  priceSubtotal?: number;
  priceSubtotalIncl?: number;
  discount?: number;
  taxName?: string;
}

export interface OrderPaymentData {
  paymentId?: number;
  paymentName?: string;
  amount?: number;
  currency?: string;
  paymentDate?: Date;
}

export interface OdooOrderData {
  odooOrderId: string;
  odooOrderNumber: string;
  branchCode: string;
  branchName?: string;
  /** Region identifier from the OdooCredential (e.g. "AE", "KW"). Stored on
   *  OrderSyncQueue so the processor can look up FusionSalesMetadata / StoreConfig
   *  by region without re-parsing the numeric branchCode. */
  region?: string;
  /** BackupOdooOrder.id — links the queue entry back to the raw Odoo backup so
   *  the processor can fetch full line/payment data for Oracle transformation. */
  odooBackupOrderId?: string;
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
  // Direct order data for processing without backup tables
  orderLines?: OrderLineData[];
  orderPayments?: OrderPaymentData[];
  warehouseName?: string;
  posConfigName?: string;
  customerType?: string;
  amountUntaxed?: number;
  amountTax?: number;
  amountDiscount?: number;
}

@Injectable()
export class OrderSyncService {
  private readonly logger = new Logger(OrderSyncService.name);

  constructor(
    @InjectRepository(OrderSyncQueue)
    private readonly orderSyncQueueRepo: Repository<OrderSyncQueue>,
    @InjectRepository(RefundTracking)
    private readonly refundTrackingRepo: Repository<RefundTracking>,
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

    // An order is invoiced only when it is paid, not cancelled AND not a refund.
    // Cancels and refunds must never reach Oracle as invoices: cancels are simply
    // skipped, refunds are recorded in RefundTracking and pushed as credit memos.
    const isInvoiceable =
      processedData.isPaid &&
      !(processedData.isCancelled ?? false) &&
      !(processedData.isRefund ?? false);

    // Log order ingestion status for debugging
    const statusReason = !processedData.isPaid
      ? 'unpaid'
      : processedData.isCancelled
        ? 'cancelled'
        : processedData.isRefund
          ? 'refund (credit memo)'
          : 'will-sync';
    this.logger.debug(
      `Ingesting order ${processedData.odooOrderNumber}: isPaid=${processedData.isPaid}, ` +
        `isCancelled=${processedData.isCancelled}, status=${statusReason}`,
    );

    const orderDateUtc = this.timezoneService.normalizeToUtc(
      processedData.orderDate,
      processedData.originalTimezone,
    );
    const hasNegativeInventory =
      (processedData.negativeInventoryItems?.length ?? 0) > 0;

    // Upsert on the (odooOrderId, branchCode) unique key: find-then-save.
    const existing = await this.orderSyncQueueRepo.findOne({
      where: {
        odooOrderId: processedData.odooOrderId,
        branchCode: processedData.branchCode,
      },
    });

    const order = await this.orderSyncQueueRepo.save(
      this.orderSyncQueueRepo.create({
        ...(existing ?? {}),
        odooOrderId: processedData.odooOrderId,
        odooOrderNumber: processedData.odooOrderNumber,
        branchCode: processedData.branchCode,
        branchName: processedData.branchName ?? null,
        orderDate: processedData.orderDate,
        orderDateUtc,
        originalTimezone: processedData.originalTimezone,
        customerName: processedData.customerName ?? null,
        customerEmail: processedData.customerEmail ?? null,
        totalAmount: new Decimal(processedData.totalAmount),
        currency: processedData.currency || 'AED',
        isPaid: processedData.isPaid,
        isCancelled: processedData.isCancelled ?? false,
        isRefund: processedData.isRefund ?? false,
        refundReferenceId: processedData.refundReferenceId ?? null,
        negativeInventoryFlag: hasNegativeInventory,
        negativeInventoryItems: processedData.negativeInventoryItems ?? null,
        status: isInvoiceable ? SyncStatus.PENDING : SyncStatus.SKIPPED,
      }),
    );

    // Every refund is tracked so the credit-memo pipeline can push it, even when
    // no original-order reference is supplied (falls back to the refund's own id
    // — the credit memo is then created on-account). branchCode lets the builder
    // resolve store config without re-joining OrderSyncQueue.
    if (processedData.isRefund) {
      const originalRef =
        processedData.refundReferenceId ?? processedData.odooOrderId;
      const existingRefund = await this.refundTrackingRepo.findOne({
        where: { refundOrderId: processedData.odooOrderId },
      });

      await this.refundTrackingRepo.save(
        this.refundTrackingRepo.create({
          ...(existingRefund ?? {}),
          originalOrderId: existingRefund?.originalOrderId ?? originalRef,
          originalOrderNumber: existingRefund?.originalOrderNumber ?? originalRef,
          refundOrderId: processedData.odooOrderId,
          refundOrderNumber:
            existingRefund?.refundOrderNumber ?? processedData.odooOrderNumber,
          branchCode: processedData.branchCode,
          refundAmount: new Decimal(Math.abs(processedData.totalAmount)),
          refundReason: existingRefund?.refundReason ?? 'Webhook refund event',
          refundDate: orderDateUtc,
          // Oracle: never write '' into a column — use null so the sentinel
          // stays NULL rather than tripping a NOT NULL / empty-string rule.
          oracleCreditMemoNumber: existingRefund?.oracleCreditMemoNumber ?? null,
          creditMemoStatus: SyncStatus.PENDING,
        }),
      );
    }

    // Only invoiceable orders are enqueued for the Oracle invoice pipeline.
    // Refunds are handled by the credit-memo pipeline; cancels/unpaid are skipped.
    if (isInvoiceable) {
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
    const failedOrders = await this.orderSyncQueueRepo.find({
      where: {
        status: SyncStatus.FAILED,
        ...(branchCode ? { branchCode } : {}),
        isPaid: true,
        isCancelled: false,
      },
      take: 1000,
    });

    if (failedOrders.length === 0) {
      this.logger.log('Re-queued 0 failed orders');
      return { enqueued: 0 };
    }

    await this.queues.enqueueOrderSyncBulk(
      failedOrders.map((order) => ({
        orderSyncQueueId: order.id,
        odooOrderId: order.odooOrderId,
        branchCode: order.branchCode,
        isRetry: true,
      })),
    );

    this.logger.log(`Re-queued ${failedOrders.length} failed orders`);
    return { enqueued: failedOrders.length };
  }

  /**
   * Re-queues orders that were held due to negative inventory after Finance
   * has corrected the stock. Optionally scoped to a single branch.
   */
  async retryNegativeInventoryOrders(branchCode?: string) {
    const heldOrders = await this.orderSyncQueueRepo.find({
      where: {
        status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
        ...(branchCode ? { branchCode } : {}),
        isPaid: true,
        isCancelled: false,
      },
      take: 1000,
    });

    if (heldOrders.length === 0) {
      this.logger.log('Re-queued 0 negative-inventory-hold orders');
      return { enqueued: 0 };
    }

    await this.queues.enqueueOrderSyncBulk(
      heldOrders.map((order) => ({
        orderSyncQueueId: order.id,
        odooOrderId: order.odooOrderId,
        branchCode: order.branchCode,
        isRetry: true,
      })),
    );

    this.logger.log(
      `Re-queued ${heldOrders.length} negative-inventory-hold orders` +
        (branchCode ? ` for branch ${branchCode}` : ''),
    );
    return { enqueued: heldOrders.length };
  }
}
