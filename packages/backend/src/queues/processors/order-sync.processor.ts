import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import {
  AuditOperation,
  AuditStatus,
  ErrorType,
  JobStatus,
  Prisma,
  SyncStatus,
} from '@prisma/client';
import { Job } from 'bull';
import { AlertsService } from '../../alerts/alerts.service';
import { OracleSoapClient } from '../../clients/oracle/oracle-soap.client';
import { GatewayService } from '../../gateway/gateway.service';
import { PaymentMappingService } from '../../payment-mapping/payment-mapping.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreConfigService } from '../../store-config/store-config.service';
import { FusionTransformationService } from '../../sync/fusion-transformation.service';
import { IdempotencyService } from '../../sync/idempotency.service';
import { ValidationService } from '../../sync/validation.service';
import { QUEUE_NAMES } from '../queues.module';
import { OrderSyncJobData, QueuesService } from '../queues.service';

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
    private readonly queuesService: QueuesService,
    private readonly soapClient: OracleSoapClient,
    private readonly transformationService: FusionTransformationService,
  ) {}

  @Process({ name: 'sync', concurrency: 10 })
  async handleOrderSync(job: Job<OrderSyncJobData>) {
    const { odooOrderId, branchCode, syncJobId } = job.data;
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
      // ── 1. Skip unpaid / cancelled orders ────────────────────
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
        if (syncJobId) await this.incrementSyncJobCounters(syncJobId, 'skipped');
        return;
      }

      // ── 2. Business-rule validation ───────────────────────────
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
        this.gateway.emitOrderStatus({ orderId: odooOrderId, status: SyncStatus.SKIPPED });
        if (syncJobId) await this.incrementSyncJobCounters(syncJobId, 'failed');
        return;
      }

      await this.storeConfigService.getValidatedConfig(branchCode);

      // ── 3. Idempotency guard ──────────────────────────────────
      const idempotencyKey = this.idempotencyService.generateKey(
        odooOrderId,
        order.isRefund ? AuditOperation.CREATE_CREDIT_MEMO : AuditOperation.CREATE_INVOICE,
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
          operation: order.isRefund ? AuditOperation.CREATE_CREDIT_MEMO : AuditOperation.CREATE_INVOICE,
          status: AuditStatus.DUPLICATE,
          requestPayload: order,
          processingDurationMs: Date.now() - startedAt,
        });
        this.gateway.emitOrderStatus({ orderId: odooOrderId, status: 'DUPLICATE' });
        if (syncJobId) await this.incrementSyncJobCounters(syncJobId, 'success');
        return;
      }

      // ── 4. Mark as PROCESSING ─────────────────────────────────
      await this.prisma.orderSyncQueue.update({
        where: { id: order.id },
        data: {
          status: SyncStatus.PROCESSING,
          syncAttempts: { increment: 1 },
          lastSyncAt: new Date(),
        },
      });
      this.gateway.emitOrderStatus({ orderId: odooOrderId, status: SyncStatus.PROCESSING });

      // ── 5. Resolve payment method (warn-only) ─────────────────
      const paymentMethodName = order.isRefund
        ? 'REFUND'
        : order.branchName?.trim()
          ? `${order.branchName.trim()}-DEFAULT`
          : 'DEFAULT';
      let fallbackAlert: string | null = null;
      try {
        await this.paymentMappingService.resolvePaymentMethod('ODOO', paymentMethodName);
      } catch (error) {
        fallbackAlert =
          error instanceof Error ? error.message : 'Payment mapping resolution failed';
      }

      // ── 6. Locate the BackupVendhqSales record ────────────────
      //    The backup job stores the raw sale with its saleNumber equal to odooOrderNumber.
      const backupSale = await this.prisma.backupVendhqSales.findFirst({
        where: { saleNumber: order.odooOrderNumber ?? odooOrderId },
      });

      let oracleInvoiceNumber: string | null = null;
      let oracleCreditMemoNumber: string | null = null;

      if (backupSale) {
        // ── 7. Transform backup data → SOAP payloads ─────────────
        const region = branchCode;
        const { invoiceHeader, standardReceipts, miscReceipts, applyReceipts, journalHeaders } =
          await this.transformationService.buildSalePayloads(backupSale.id, region);

        // ── 8. Push Invoice to Oracle Fusion ─────────────────────
        const invoiceResult = await this.soapClient.createSimpleInvoice(invoiceHeader);
        const txnNumber = String(
          invoiceResult.customerTrxId ?? invoiceResult.transactionNumber ?? odooOrderId,
        );

        // Persist audit record
        const auditHeader = await this.prisma.fusionInvoiceHeader.create({
          data: {
            status: invoiceResult.serviceStatus ?? 'SUCCESS',
            requestDate: new Date(),
            billToCustName: invoiceHeader.billToCustomerName,
            billToLocation: invoiceHeader.billToLocation,
            billToAccNumber: Number(invoiceHeader.billToAccountNumber) || null,
            businessUnit: invoiceHeader.businessUnit,
            txnSource: invoiceHeader.transactionSource,
            txnType: invoiceHeader.transactionType,
            txnDate: invoiceHeader.saleDate,
            glDate: invoiceHeader.saleDate,
            currencyCode: invoiceHeader.invoiceCurrencyCode,
            txnNumber: Number(invoiceResult.customerTrxId) || null,
            customerTxnId: Number(invoiceResult.customerTrxId) || null,
            region,
          },
        });

        for (const il of invoiceHeader.invoiceLines) {
          await this.prisma.fusionInvoiceLine.create({
            data: {
              status: invoiceResult.serviceStatus ?? 'SUCCESS',
              requestDate: new Date(),
              invoiceNumber: txnNumber,
              lineNumber: il.lineNumber,
              itemNumber: il.itemNumber ?? null,
              description: il.description,
              quantity: il.quantity,
              currencyCode: invoiceHeader.invoiceCurrencyCode,
              salesOrder: il.salesOrder ?? null,
              salesOrderLine: Number(il.salesOrderLine) || null,
              region,
              headerId: auditHeader.id,
            },
          });
        }

        if (order.isRefund) {
          oracleCreditMemoNumber = txnNumber;
        } else {
          oracleInvoiceNumber = txnNumber;
        }

        // ── 9. Push Standard Receipts ─────────────────────────────
        for (const sr of standardReceipts) {
          const srResult = await this.soapClient.createStandardReceipt(sr);
          await this.prisma.fusionStandardReceipt.create({
            data: {
              status: 'SUCCESS',
              requestDate: new Date(),
              currencyCode: sr.currencyCode,
              receiptDate: sr.saleDate,
              glDate: sr.saleDate,
              receiptMethodId: sr.receiptMethodId,
              receiptNumber: srResult.receiptNumber ?? sr.receiptNumber,
              remittanceBankAccId: String(sr.remittanceBankAccountId),
              orgId: sr.orgId,
              region,
            },
          });
        }

        // ── 10. Push Misc Receipts ────────────────────────────────
        for (const mr of miscReceipts) {
          const mrResult = await this.soapClient.createMiscellaneousReceipt(mr);
          await this.prisma.fusionMiscReceipt.create({
            data: {
              status: 'SUCCESS',
              requestDate: new Date(),
              currencyCode: mr.currencyCode,
              glDate: mr.saleDate,
              receiptDate: mr.saleDate,
              receiptMethodName: mr.receiptMethodName,
              receiptNumber: mrResult.receiptNumber ?? mr.receiptNumber,
              bankAccNumber: mr.bankAccountName,
              recActivityName: mr.receivableActivityName,
              region,
            },
          });
        }

        // ── 11. Apply Receipts to Invoice ─────────────────────────
        for (const ar of applyReceipts) {
          const arResult = await this.soapClient.createApplyReceipt(ar);
          await this.prisma.fusionApplyReceipt.create({
            data: {
              status: 'SUCCESS',
              requestDate: new Date(),
              accountingDate: ar.accountingDate,
              applicationDate: ar.applicationDate,
              txnNumber: arResult.customerTrxId ?? ar.transactionNumber,
              receiptNumber: arResult.receiptNumber ?? ar.receiptNumber,
              currencyCode: ar.receiptCurrency,
              txnSource: ar.transactionSource,
              region,
            },
          });
        }

        // ── 12. Journal Entries (non-NORMAL customers) ────────────
        for (const jh of journalHeaders) {
          const jeHeaderId = await this.soapClient.importJournalEntry(jh);
          const jhAudit = await this.prisma.fusionJournalHeader.create({
            data: {
              status: jeHeaderId != null ? 'SUCCESS' : 'ERROR',
              requestDate: new Date(),
              region,
              jeHeaderId: jeHeaderId ?? null,
              ledgerId: jh.ledgerId,
              batchName: jh.batchName,
              batchDescription: jh.batchDescription,
              accountingPeriodName: jh.accountingPeriodName,
              userSourceName: jh.userSourceName,
              userCategoryName: jh.userCategoryName,
              errorToSuspenseFlag: jh.errorToSuspenseFlag,
              summaryFlag: jh.summaryFlag,
              accountingDate: jh.accountingDate,
            },
          });

          for (const jl of jh.journalLines) {
            await this.prisma.fusionJournalLine.create({
              data: {
                status: jeHeaderId != null ? 'SUCCESS' : 'ERROR',
                requestDate: new Date(),
                region,
                jeHeaderId: jeHeaderId ?? null,
                ledgerId: jl.ledgerId,
                chartOfAccountsId: jl.chartOfAccountsId ?? null,
                currencyCode: jl.currencyCode,
                headerId: jhAudit.id,
              },
            });
          }
        }
      } else {
        // No backup sale found — generate a reference but log a warning
        this.logger.warn(
          `No BackupVendhqSales found for orderNumber=${order.odooOrderNumber ?? odooOrderId}. Oracle SOAP calls skipped.`,
        );
        oracleInvoiceNumber = order.isRefund ? null : `INV-${order.odooOrderNumber}`;
        oracleCreditMemoNumber = order.isRefund ? `CM-${order.odooOrderNumber}` : null;
      }

      const oracleReference = oracleInvoiceNumber ?? oracleCreditMemoNumber ?? odooOrderId;

      // ── 13. Record idempotency / audit log ────────────────────
      await this.idempotencyService.recordOperation({
        idempotencyKey,
        externalId: odooOrderId,
        externalSystem: 'ODOO',
        targetSystem: 'ORACLE',
        operation: order.isRefund ? AuditOperation.CREATE_CREDIT_MEMO : AuditOperation.CREATE_INVOICE,
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
        validationWarnings.push(`Payment mapping fallback applied: ${fallbackAlert}`);
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

      // ── 14. Mark SYNCED ───────────────────────────────────────
      await this.prisma.orderSyncQueue.update({
        where: { id: order.id },
        data: {
          status: SyncStatus.SYNCED,
          validationErrors: validationWarnings.length
            ? { warnings: validationWarnings }
            : Prisma.JsonNull,
          oracleInvoiceNumber: order.isRefund ? null : oracleInvoiceNumber,
          oracleCreditMemoNumber: order.isRefund ? oracleCreditMemoNumber : null,
        },
      });

      if (syncJobId) await this.incrementSyncJobCounters(syncJobId, 'success');

      this.gateway.emitOrderStatus({ orderId: odooOrderId, status: SyncStatus.SYNCED });
      this.logger.log(`Order synced successfully: ${odooOrderId} → ${oracleReference}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Order sync failed: ${odooOrderId} - ${errorMessage}`);
      await this.prisma.orderSyncQueue
        .update({
          where: { id: order.id },
          data: { status: SyncStatus.FAILED, validationErrors: { error: errorMessage } },
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

      if (syncJobId) {
        await this.incrementSyncJobCounters(syncJobId, 'failed').catch(() => undefined);
      }

      await this.queuesService
        .enqueueNotification({
          type: 'ERROR_ALERT',
          subject: `Order sync failed: ${odooOrderId}`,
          body: `Order ${odooOrderId} (branch: ${branchCode}) failed to sync.\n\nError: ${errorMessage}`,
        })
        .catch(() => undefined);

      this.gateway.emitOrderStatus({ orderId: odooOrderId, status: SyncStatus.FAILED });
      throw err;
    }
  }

  /**
   * Increments the parent SyncJob counters and finalises the job status once
   * all records have been processed.
   */
  private async incrementSyncJobCounters(
    syncJobId: string,
    outcome: 'success' | 'failed' | 'skipped',
  ) {
    const update: Prisma.SyncJobUpdateInput = {
      processedRecords: { increment: 1 },
    };

    if (outcome === 'success') update.successCount = { increment: 1 };
    else if (outcome === 'failed') update.failedCount = { increment: 1 };
    else update.skippedCount = { increment: 1 };

    const job = await this.prisma.syncJob.update({
      where: { id: syncJobId },
      data: update,
    });

    if (job.processedRecords >= job.totalRecords && job.totalRecords > 0) {
      let finalStatus: JobStatus;
      if (job.failedCount === 0 && job.skippedCount === 0) {
        finalStatus = JobStatus.COMPLETED;
      } else if (job.successCount > 0) {
        finalStatus = JobStatus.PARTIAL;
      } else {
        finalStatus = JobStatus.FAILED;
      }

      await this.prisma.syncJob.update({
        where: { id: syncJobId },
        data: { status: finalStatus, completedAt: new Date() },
      });

      this.gateway.emitSyncJobUpdate({ jobId: syncJobId, status: finalStatus, progress: 100 });
    } else {
      const progress =
        job.totalRecords > 0
          ? Math.round((job.processedRecords / job.totalRecords) * 100)
          : 0;
      this.gateway.emitSyncJobUpdate({
        jobId: syncJobId,
        status: JobStatus.PROCESSING,
        progress,
      });
    }
  }
}
