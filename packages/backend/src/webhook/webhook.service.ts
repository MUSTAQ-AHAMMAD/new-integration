import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SyncStatus } from '@prisma/client';
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
        payload: payload as Prisma.InputJsonObject,
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
        data: {
          processingStatus: SyncStatus.FAILED,
          processingError: errorMessage,
        },
      });
      this.logger.error(
        `Failed to process webhook event ${event.id}`,
        err instanceof Error ? err.stack : undefined,
      );
      return {
        received: true,
        eventId: event.id,
        processingError: errorMessage,
      };
    }
  }

  private async handleEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ) {
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

    const toStringValue = (value: unknown, fallback = ''): string =>
      typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : fallback;

    const amountTotal = Number(order.amount_total ?? 0);
    const state = toStringValue(order.state, 'draft');

    await this.orderSyncService.ingestOrder({
      odooOrderId: toStringValue(order.id),
      odooOrderNumber: toStringValue(order.name ?? order.number ?? order.id),
      branchCode: toStringValue(
        order.branch_code ?? order.company_id,
        'UNKNOWN',
      ),
      branchName:
        typeof order.branch_name === 'string' ? order.branch_name : undefined,
      orderDate: new Date(
        toStringValue(order.date_order, new Date().toISOString()),
      ),
      originalTimezone: toStringValue(order.timezone, 'Asia/Dubai'),
      customerName:
        typeof order.partner_name === 'string' ? order.partner_name : undefined,
      customerEmail:
        typeof order.partner_email === 'string'
          ? order.partner_email
          : undefined,
      totalAmount: amountTotal,
      currency: toStringValue(order.currency, 'AED'),
      isPaid: ['paid', 'done', 'posted'].includes(state),
      isCancelled: state === 'cancel',
      isRefund: Boolean(order.is_refund) || amountTotal < 0,
      refundReferenceId: order.refund_reference_id
        ? toStringValue(order.refund_reference_id)
        : undefined,
      negativeInventoryItems: Array.isArray(order.negative_inventory_items)
        ? (order.negative_inventory_items as Array<{
            sku: string;
            quantity: number;
          }>)
        : undefined,
    });
  }
}
