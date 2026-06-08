import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import {
  AuditOperation,
  AuditStatus,
  ErrorType,
  Prisma,
  SyncStatus,
} from '@prisma/client';
import { Job } from 'bull';
import { AlertsService } from '../../alerts/alerts.service';
import { GatewayService } from '../../gateway/gateway.service';
import { PaymentMappingService } from '../../payment-mapping/payment-mapping.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreConfigService } from '../../store-config/store-config.service';
import { IdempotencyService } from '../../sync/idempotency.service';
import { ValidationService } from '../../sync/validation.service';
import { QUEUE_NAMES } from '../queues.module';
import { OrderSyncJobData } from '../queues.service';

@Processor(QUEUE_NAMES.ORDER_SYNC)
export class OrderSyncProcessor {
  private readonly logger = new Logger(OrderSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: GatewayService,
    private readonly validationService: ValidationService,
    private readonly idempotencyService: IdempotencyService,
    private readonly storeConfigService: StoreConfigService,
    private readonly paymentMappingService: PaymentMappingService,
    private readonly alertsService: AlertsService,
  ) {}

  @Process('sync')
  async handleOrderSync(job: Job<OrderSyncJobData>) {
    const { odooOrderId, branchCode } = job.data;
    const startedAt = Date.now();
    this.logger.log(`Processing order sync: ${odooOrderId} / ${branchCode}`);

    const order = await this.prisma.orderSyncQueue.findUnique({
      where: { odooOrderId_branchCode: { odooOrderId, branchCode } },
    });

    if (!order) {
      this.logger.warn(`Order not found in queue: ${odooOrderId}`);
      return;
    }

    try {
      if (!order.isPaid || order.isCancelled) {
        await this.prisma.orderSyncQueue.update({
          where: { id: order.id },
          data: {
            status: SyncStatus.SKIPPED,
            validationErrors: {
              reasons: [
                !order.isPaid ? 'Order is not paid/posted' : null,
                order.isCancelled ? 'Order is cancelled' : null,
              ].filter(Boolean),
            },
          },
        });
        this.gateway.emitOrderStatus({
          orderId: odooOrderId,
          status: SyncStatus.SKIPPED,
        });
        return;
      }

      const validation = await this.validationService.validateOrder(
        odooOrderId,
        branchCode,
      );
      if (!validation.isValid) {
        await this.prisma.orderSyncQueue.update({
          where: { id: order.id },
          data: {
            status: SyncStatus.SKIPPED,
            validationErrors: {
              errors: validation.errors,
              warnings: validation.warnings,
            },
          },
        });
        await this.prisma.failedTransaction.create({
          data: {
            orderSyncQueueId: order.id,
            originalPayload: order,
            errorType: ErrorType.VALIDATION_ERROR,
            errorMessage: validation.errors.join('; '),
          },
        });
        this.gateway.emitOrderStatus({
          orderId: odooOrderId,
          status: SyncStatus.SKIPPED,
        });
        return;
      }

      await this.storeConfigService.getValidatedConfig(branchCode);

      const idempotencyKey = this.idempotencyService.generateKey(
        odooOrderId,
        order.isRefund
          ? AuditOperation.CREATE_CREDIT_MEMO
          : AuditOperation.CREATE_INVOICE,
        branchCode,
      );

      if (await this.idempotencyService.isDuplicate(idempotencyKey)) {
        await this.prisma.orderSyncQueue.update({
          where: { id: order.id },
          data: { status: SyncStatus.SYNCED },
        });
        await this.idempotencyService.recordOperation({
          idempotencyKey,
          externalId: odooOrderId,
          externalSystem: 'ODOO',
          targetSystem: 'ORACLE',
          operation: order.isRefund
            ? AuditOperation.CREATE_CREDIT_MEMO
            : AuditOperation.CREATE_INVOICE,
          status: AuditStatus.DUPLICATE,
          requestPayload: order,
          processingDurationMs: Date.now() - startedAt,
        });
        this.gateway.emitOrderStatus({
          orderId: odooOrderId,
          status: 'DUPLICATE',
        });
        return;
      }

      await this.prisma.orderSyncQueue.update({
        where: { id: order.id },
        data: {
          status: SyncStatus.PROCESSING,
          syncAttempts: { increment: 1 },
          lastSyncAt: new Date(),
        },
      });
      this.gateway.emitOrderStatus({
        orderId: odooOrderId,
        status: SyncStatus.PROCESSING,
      });

      const paymentMethodName = order.isRefund
        ? 'REFUND'
        : order.branchName?.trim()
          ? `${order.branchName.trim()}-DEFAULT`
          : 'DEFAULT';
      let fallbackAlert: string | null = null;
      try {
        await this.paymentMappingService.resolvePaymentMethod(
          'ODOO',
          paymentMethodName,
        );
      } catch (error) {
        fallbackAlert =
          error instanceof Error
            ? error.message
            : 'Payment mapping resolution failed';
      }

      const oracleReference = order.isRefund
        ? `CM-${order.odooOrderNumber}`
        : `INV-${order.odooOrderNumber}`;

      await this.idempotencyService.recordOperation({
        idempotencyKey,
        externalId: odooOrderId,
        externalSystem: 'ODOO',
        targetSystem: 'ORACLE',
        operation: order.isRefund
          ? AuditOperation.CREATE_CREDIT_MEMO
          : AuditOperation.CREATE_INVOICE,
        status: AuditStatus.SUCCESS,
        requestPayload: order,
        responsePayload: {
          oracleReference,
          warnings: validation.warnings,
          paymentFallback: fallbackAlert,
          negativeInventory: order.negativeInventoryFlag,
        },
        oracleResponseId: oracleReference,
        processingDurationMs: Date.now() - startedAt,
      });

      const validationWarnings = [...validation.warnings];
      if (fallbackAlert) {
        validationWarnings.push(
          `Payment mapping fallback applied: ${fallbackAlert}`,
        );
      }

      if (order.negativeInventoryFlag) {
        await this.alertsService.createAlert({
          alertType: 'NEGATIVE_INVENTORY',
          severity: 'WARNING',
          title: 'Negative inventory detected',
          message: `Order ${order.odooOrderNumber} contains negative inventory items but was synced.`,
          relatedEntityId: order.id,
          relatedEntityType: 'ORDER_SYNC_QUEUE',
        });
      }

      await this.prisma.orderSyncQueue.update({
        where: { id: order.id },
        data: {
          status: SyncStatus.SYNCED,
          validationErrors: validationWarnings.length
            ? { warnings: validationWarnings }
            : Prisma.JsonNull,
          oracleInvoiceNumber: order.isRefund ? null : oracleReference,
          oracleCreditMemoNumber: order.isRefund ? oracleReference : null,
        },
      });

      this.gateway.emitOrderStatus({
        orderId: odooOrderId,
        status: SyncStatus.SYNCED,
      });
      this.logger.log(`Order synced successfully: ${odooOrderId}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Order sync failed: ${odooOrderId} - ${errorMessage}`);
      await this.prisma.orderSyncQueue
        .update({
          where: { id: order.id },
          data: {
            status: SyncStatus.FAILED,
            validationErrors: { error: errorMessage },
          },
        })
        .catch(() => undefined);
      await this.prisma.failedTransaction
        .create({
          data: {
            orderSyncQueueId: order.id,
            originalPayload: order,
            errorType: ErrorType.UNKNOWN_ERROR,
            errorMessage,
            errorStack: err instanceof Error ? err.stack : undefined,
          },
        })
        .catch(() => undefined);
      this.gateway.emitOrderStatus({
        orderId: odooOrderId,
        status: SyncStatus.FAILED,
      });
      throw err;
    }
  }
}
