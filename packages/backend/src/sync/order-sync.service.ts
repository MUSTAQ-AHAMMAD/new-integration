import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SyncStatus } from '@prisma/client';
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
  ) {}

  async ingestOrder(data: OdooOrderData): Promise<void> {
    const orderDateUtc = this.timezoneService.normalizeToUtc(data.orderDate, data.originalTimezone);
    const hasNegativeInventory = (data.negativeInventoryItems?.length ?? 0) > 0;

    const order = await this.prisma.orderSyncQueue.upsert({
      where: { odooOrderId_branchCode: { odooOrderId: data.odooOrderId, branchCode: data.branchCode } },
      create: {
        odooOrderId: data.odooOrderId,
        odooOrderNumber: data.odooOrderNumber,
        branchCode: data.branchCode,
        branchName: data.branchName,
        orderDate: data.orderDate,
        orderDateUtc,
        originalTimezone: data.originalTimezone,
        customerName: data.customerName,
        customerEmail: data.customerEmail,
        totalAmount: new Prisma.Decimal(data.totalAmount),
        currency: data.currency || 'AED',
        isPaid: data.isPaid,
        isCancelled: data.isCancelled ?? false,
        isRefund: data.isRefund ?? false,
        refundReferenceId: data.refundReferenceId,
        negativeInventoryFlag: hasNegativeInventory,
        negativeInventoryItems: data.negativeInventoryItems ? (data.negativeInventoryItems as unknown as Prisma.InputJsonValue) : undefined,
        status: data.isPaid && !(data.isCancelled ?? false) ? SyncStatus.PENDING : SyncStatus.SKIPPED,
      },
      update: {
        odooOrderNumber: data.odooOrderNumber,
        branchName: data.branchName,
        orderDate: data.orderDate,
        orderDateUtc,
        originalTimezone: data.originalTimezone,
        customerName: data.customerName,
        customerEmail: data.customerEmail,
        totalAmount: new Prisma.Decimal(data.totalAmount),
        currency: data.currency || 'AED',
        isPaid: data.isPaid,
        isCancelled: data.isCancelled ?? false,
        isRefund: data.isRefund ?? false,
        refundReferenceId: data.refundReferenceId,
        negativeInventoryFlag: hasNegativeInventory,
        negativeInventoryItems: data.negativeInventoryItems ? (data.negativeInventoryItems as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        status: data.isPaid && !(data.isCancelled ?? false) ? SyncStatus.PENDING : SyncStatus.SKIPPED,
      },
    });

    if (data.isRefund && data.refundReferenceId) {
      await this.prisma.refundTracking.upsert({
        where: { refundOrderId: data.odooOrderId },
        create: {
          originalOrderId: data.refundReferenceId,
          originalOrderNumber: data.refundReferenceId,
          refundOrderId: data.odooOrderId,
          refundOrderNumber: data.odooOrderNumber,
          refundAmount: new Prisma.Decimal(Math.abs(data.totalAmount)),
          refundReason: 'Webhook refund event',
          refundDate: orderDateUtc,
          oracleCreditMemoNumber: '',
          creditMemoStatus: SyncStatus.PENDING,
        },
        update: {
          refundAmount: new Prisma.Decimal(Math.abs(data.totalAmount)),
          refundDate: orderDateUtc,
          creditMemoStatus: SyncStatus.PENDING,
        },
      });
    }

    if (data.isPaid && !(data.isCancelled ?? false)) {
      await this.queues.enqueueOrderSync({
        orderSyncQueueId: order.id,
        odooOrderId: data.odooOrderId,
        branchCode: data.branchCode,
      });
    }

    this.logger.log(`Order ${data.odooOrderId} ingested for branch ${data.branchCode}`);
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
}
