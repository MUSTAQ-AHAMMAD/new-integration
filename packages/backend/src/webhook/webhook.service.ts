import { Injectable, Logger } from '@nestjs/common';
import { SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderSyncService } from '../sync/order-sync.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderSyncService: OrderSyncService,
  ) {}

  async processOdooEvent(payload: Record<string, unknown>, signature?: string) {
    const eventType = (payload.event_type as string) || 'unknown';

    const event = await this.prisma.webhookEvent.create({
      data: {
        eventType,
        sourceSystem: 'ODOO',
        payload: payload as object,
        processingStatus: SyncStatus.PENDING,
      },
    });

    try {
      if (signature) {
        this.logger.debug(`Received webhook signature for event ${event.id}`);
      }
      await this.handleEvent(eventType, payload);

      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date(), processingStatus: SyncStatus.SYNCED },
      });

      return { received: true, eventId: event.id };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processingStatus: SyncStatus.FAILED, processingError: errorMessage },
      });
      this.logger.error(`Failed to process webhook event ${event.id}`, err instanceof Error ? err.stack : undefined);
      return { received: true, eventId: event.id, processingError: errorMessage };
    }
  }

  private async handleEvent(eventType: string, payload: Record<string, unknown>) {
    switch (eventType) {
      case 'order.paid':
      case 'order.created':
      case 'order.updated':
      case 'order.refund':
        await this.handleOrderEvent(payload);
        break;
      default:
        this.logger.log(`Unhandled event type: ${eventType}`);
    }
  }

  private async handleOrderEvent(payload: Record<string, unknown>) {
    const order = payload.order as Record<string, unknown> | undefined;
    if (!order) return;

    const amountTotal = Number(order.amount_total ?? 0);
    const state = String(order.state ?? 'draft');

    await this.orderSyncService.ingestOrder({
      odooOrderId: String(order.id),
      odooOrderNumber: String(order.name || order.number || order.id),
      branchCode: String(order.branch_code || order.company_id || 'UNKNOWN'),
      branchName: order.branch_name as string | undefined,
      orderDate: new Date(String(order.date_order || new Date().toISOString())),
      originalTimezone: String(order.timezone || 'Asia/Dubai'),
      customerName: order.partner_name as string | undefined,
      customerEmail: order.partner_email as string | undefined,
      totalAmount: amountTotal,
      currency: String(order.currency || 'AED'),
      isPaid: ['paid', 'done', 'posted'].includes(state),
      isCancelled: state === 'cancel',
      isRefund: Boolean(order.is_refund) || amountTotal < 0,
      refundReferenceId: order.refund_reference_id ? String(order.refund_reference_id) : undefined,
      negativeInventoryItems: Array.isArray(order.negative_inventory_items)
        ? (order.negative_inventory_items as Array<{ sku: string; quantity: number }>)
        : undefined,
    });
  }
}
