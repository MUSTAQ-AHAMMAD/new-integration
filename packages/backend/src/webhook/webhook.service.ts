import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { WebhookEvent } from '../database/entities/webhook-event.entity';
import { SyncStatus } from '../database/enums';
import { OrderSyncService } from '../sync/order-sync.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly webhookSecret: string | undefined;

  constructor(
    @InjectRepository(WebhookEvent)
    private readonly webhookEvents: Repository<WebhookEvent>,
    private readonly orderSyncService: OrderSyncService,
    private readonly configService: ConfigService,
  ) {
    this.webhookSecret = this.configService.get<string>('WEBHOOK_SECRET');
  }

  async processOdooEvent(
    payload: Record<string, unknown>,
    rawBody: Buffer,
    signature?: string,
  ) {
    // Verify HMAC signature if a secret is configured
    if (this.webhookSecret) {
      if (!signature) {
        throw new UnauthorizedException('Missing x-odoo-signature header');
      }
      this.verifySignature(rawBody, signature);
    }

    const eventType = (payload.event_type as string) || 'unknown';

    // Idempotency: skip reprocessing if an event with the same external ID has
    // already been successfully handled. Odoo may retry deliveries on timeout.
    const externalEventId =
      typeof payload.event_id === 'string' ||
      typeof payload.event_id === 'number'
        ? String(payload.event_id)
        : undefined;

    if (externalEventId) {
      // Oracle stores the payload as a CLOB (no JSON-path querying), so scan
      // recent successfully-processed Odoo events and match the parsed payload.
      const candidates = await this.webhookEvents.find({
        where: {
          sourceSystem: 'ODOO',
          processingStatus: SyncStatus.SYNCED,
        },
        order: { receivedAt: 'DESC' },
        take: 500,
      });

      const duplicate = candidates.find((c) => {
        const eventId = (c.payload as Record<string, unknown> | null)?.event_id;
        return (
          (typeof eventId === 'string' || typeof eventId === 'number') &&
          String(eventId) === externalEventId
        );
      });

      if (duplicate) {
        this.logger.debug(
          `Duplicate Odoo webhook event skipped (event_id=${externalEventId})`,
        );
        return { received: true, eventId: duplicate.id, duplicate: true };
      }
    }

    const event = await this.webhookEvents.save(
      this.webhookEvents.create({
        eventType,
        sourceSystem: 'ODOO',
        payload,
        processingStatus: SyncStatus.PENDING,
      }),
    );

    try {
      await this.handleEvent(eventType, payload);

      await this.webhookEvents.update(event.id, {
        processedAt: new Date(),
        processingStatus: SyncStatus.SYNCED,
      });

      return { received: true, eventId: event.id };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      await this.webhookEvents.update(event.id, {
        processingStatus: SyncStatus.FAILED,
        processingError: errorMessage,
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

  private verifySignature(rawBody: Buffer, signature: string): void {
    const expected = createHmac('sha256', this.webhookSecret!)
      .update(rawBody)
      .digest('hex');

    // The Odoo signature may be prefixed with "sha256=" — strip it
    const incoming = signature.startsWith('sha256=')
      ? signature.slice(7)
      : signature;

    const expectedBuf = Buffer.from(expected, 'hex');
    const incomingBuf = Buffer.from(incoming, 'hex');

    if (
      expectedBuf.length !== incomingBuf.length ||
      !timingSafeEqual(expectedBuf, incomingBuf)
    ) {
      this.logger.warn('Webhook signature verification failed');
      throw new UnauthorizedException('Invalid webhook signature');
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
