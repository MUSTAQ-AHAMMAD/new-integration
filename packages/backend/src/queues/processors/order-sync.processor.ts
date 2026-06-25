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
import { OdooTransformationService } from '../../sync/odoo-transformation.service';
import { ValidationService } from '../../sync/validation.service';
import { QUEUE_NAMES } from '../queues.constants';
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
    private readonly odooTransformationService: OdooTransformationService,
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
        if (syncJobId)
          await this.incrementSyncJobCounters(syncJobId, 'skipped');
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
        this.gateway.emitOrderStatus({
          orderId: odooOrderId,
          status: SyncStatus.SKIPPED,
        });
        if (syncJobId) await this.incrementSyncJobCounters(syncJobId, 'failed');
        return;
      }

      // ── 2b. Negative-inventory hold ──────────────────────────
      if (validation.holdForNegativeInventory) {
        await this.prisma.orderSyncQueue.update({
          where: { id: order.id },
          data: { status: SyncStatus.NEGATIVE_INVENTORY_HOLD },
        });
        this.gateway.emitOrderStatus({
          orderId: odooOrderId,
          status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
        });
        if (syncJobId)
          await this.incrementSyncJobCounters(syncJobId, 'skipped');
        this.logger.warn(
          `Order ${odooOrderId} held due to negative inventory — use retry-negative-inventory to re-process after stock correction`,
        );
        return;
      }

      // ── 2c. Store configuration check ────────────────────────
      try {
        await this.storeConfigService.getValidatedConfig(branchCode);
      } catch (configErr) {
        const configMsg =
          configErr instanceof Error ? configErr.message : 'Store config error';
        await this.prisma.orderSyncQueue
          .update({
            where: { id: order.id },
            data: {
              status: SyncStatus.FAILED,
              validationErrors: { error: configMsg },
            },
          })
          .catch((dbErr) => {
            this.logger.error(
              `Failed to mark order ${odooOrderId} as FAILED after config error: ${(dbErr as Error).message}`,
            );
          });
        await this.prisma.failedTransaction
          .create({
            data: {
              orderSyncQueueId: order.id,
              originalPayload: order,
              errorType: ErrorType.CONFIGURATION_ERROR,
              errorMessage: configMsg,
              errorStack:
                configErr instanceof Error ? configErr.stack : undefined,
            },
          })
          .catch((dbErr) => {
            this.logger.error(
              `Failed to create FailedTransaction for order ${odooOrderId}: ${(dbErr as Error).message}`,
            );
          });
        await this.alertsService.createAlert({
          alertType: 'STORE_CONFIG_INVALID',
          severity: 'ERROR',
          title: `Store configuration error — ${branchCode}`,
          message: `Order ${odooOrderId} failed due to store configuration: ${configMsg}`,
          relatedEntityId: branchCode,
          relatedEntityType: 'STORE_CONFIGURATION',
        });
        this.gateway.emitOrderStatus({
          orderId: odooOrderId,
          status: SyncStatus.FAILED,
        });
        if (syncJobId)
          await this.incrementSyncJobCounters(syncJobId, 'failed').catch(
            () => undefined,
          );
        return;
      }

      // ── 3. Idempotency guard ──────────────────────────────────
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
        if (syncJobId)
          await this.incrementSyncJobCounters(syncJobId, 'success');
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
      this.gateway.emitOrderStatus({
        orderId: odooOrderId,
        status: SyncStatus.PROCESSING,
      });

      // ── 5. Resolve payment method (warn-only) ─────────────────
      const paymentMethodName = order.isRefund
        ? 'REFUND'
        : order.branchName?.trim()
          ? `${order.branchName.trim()}-DEFAULT`
          : 'DEFAULT';
      const resolvedMapping =
        await this.paymentMappingService.resolvePaymentMethod(
          'ODOO',
          paymentMethodName,
        );
      const fallbackAlert =
        resolvedMapping === null
          ? `Payment method "${paymentMethodName}" has no Oracle mapping — integration will continue without a receipt method`
          : null;

      // ── 6. Resolve backup source and build Oracle payloads ─────
      //
      // Priority order:
      //   A. Odoo backup path: order.odooBackupOrderId is set → use BackupOdooOrder
      //      + OdooTransformationService (direct Odoo→Oracle mapping).
      //   B. VendHQ backup path: look for BackupVendHqSale by saleNumber/invoiceNumber
      //      → use FusionTransformationService (existing VendHQ→Oracle mapping).
      //   C. No backup found: generate a placeholder reference and log a warning.
      //
      // The region used for all Oracle config lookups is taken from
      // order.region (populated during ingest from OdooCredential.region) with
      // a fallback to branchCode for legacy / VendHQ-sourced orders.
      const effectiveRegion = order.region ?? branchCode;

      let oracleInvoiceNumber: string | null = null;
      let oracleCreditMemoNumber: string | null = null;

      // Shared helper — pushes one set of transformation results to Oracle
      const pushToOracle = async (payloads: {
        invoiceHeader: import('../../clients/oracle/oracle-soap.client').InvoiceHeader;
        standardReceipts: import('../../clients/oracle/oracle-soap.client').StandardReceiptRequest[];
        miscReceipts: import('../../clients/oracle/oracle-soap.client').MiscReceiptRequest[];
        applyReceipts: import('../../clients/oracle/oracle-soap.client').ApplyReceiptRequest[];
        journalHeaders: import('../../clients/oracle/oracle-soap.client').JournalHeader[];
      }): Promise<string> => {
        const {
          invoiceHeader,
          standardReceipts,
          miscReceipts,
          applyReceipts,
          journalHeaders,
        } = payloads;

        // ── 8. Push Invoice ───────────────────────────────────────
        const invoiceResult =
          await this.soapClient.createSimpleInvoice(invoiceHeader);
        const txnNumber = String(
          invoiceResult.customerTrxId ??
            invoiceResult.transactionNumber ??
            odooOrderId,
        );

        const auditHeader = await this.prisma.fusionInvoiceHeader.create({
          data: {
            status: invoiceResult.serviceStatus ?? 'SUCCESS',
            requestDate: new Date(),
            billToCustName: invoiceHeader.billToCustomerName,
            billToLocation: invoiceHeader.billToLocation,
            billToAccNumber: invoiceHeader.billToAccountNumber ? BigInt(invoiceHeader.billToAccountNumber) : null,
            businessUnit: invoiceHeader.businessUnit,
            txnSource: invoiceHeader.transactionSource,
            txnType: invoiceHeader.transactionType,
            txnDate: invoiceHeader.saleDate,
            glDate: invoiceHeader.saleDate,
            currencyCode: invoiceHeader.invoiceCurrencyCode,
            txnNumber: Number(invoiceResult.customerTrxId) || null,
            customerTxnId: Number(invoiceResult.customerTrxId) || null,
            region: effectiveRegion,
          },
        });

        await this.prisma.fusionInvoiceLine.createMany({
          data: invoiceHeader.invoiceLines.map((il) => ({
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
            region: effectiveRegion,
            headerId: auditHeader.id,
          })),
        });

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
              receiptMethodId: BigInt(sr.receiptMethodId),
              receiptNumber: srResult.receiptNumber ?? sr.receiptNumber,
              remittanceBankAccId: String(sr.remittanceBankAccountId),
              orgId: sr.orgId,
              region: effectiveRegion,
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
              region: effectiveRegion,
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
              region: effectiveRegion,
            },
          });
        }

        // ── 12. Journal Entries ───────────────────────────────────
        for (const jh of journalHeaders) {
          const jeHeaderId = await this.soapClient.importJournalEntry(jh);
          const jhAudit = await this.prisma.fusionJournalHeader.create({
            data: {
              status: jeHeaderId != null ? 'SUCCESS' : 'ERROR',
              requestDate: new Date(),
              region: effectiveRegion,
              jeHeaderId: jeHeaderId ?? null,
              ledgerId: BigInt(jh.ledgerId),
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

          await this.prisma.fusionJournalLine.createMany({
            data: jh.journalLines.map((jl) => ({
              status: jeHeaderId != null ? 'SUCCESS' : 'ERROR',
              requestDate: new Date(),
              region: effectiveRegion,
              jeHeaderId: jeHeaderId ?? null,
              ledgerId: BigInt(jl.ledgerId),
              chartOfAccountsId: jl.chartOfAccountsId != null ? BigInt(jl.chartOfAccountsId) : null,
              currencyCode: jl.currencyCode,
              headerId: jhAudit.id,
            })),
          });
        }

        return txnNumber;
      };

      // ── Path A: Odoo backup ───────────────────────────────────────
      if (order.odooBackupOrderId) {
        this.logger.log(
          `Order ${odooOrderId}: using Odoo backup path (backupOrderId=${order.odooBackupOrderId})`,
        );
        const payloads =
          await this.odooTransformationService.buildOrderPayloads(
            order.odooBackupOrderId,
            branchCode,
            effectiveRegion,
          );
        const txnNumber = await pushToOracle(payloads);
        if (order.isRefund) {
          oracleCreditMemoNumber = txnNumber;
        } else {
          oracleInvoiceNumber = txnNumber;
        }
      } else {
        // ── Path B: VendHQ backup fallback ────────────────────────
        const backupSale = await this.prisma.backupVendHqSale.findFirst({
          where: {
            OR: [
              { saleNumber: order.odooOrderNumber ?? odooOrderId },
              { invoiceNumber: order.odooOrderNumber ?? odooOrderId },
            ],
          },
        });

        if (backupSale) {
          this.logger.log(
            `Order ${odooOrderId}: using VendHQ backup path (saleId=${backupSale.id})`,
          );
          const payloads = await this.transformationService.buildSalePayloads(
            backupSale.id,
            effectiveRegion,
          );
          const txnNumber = await pushToOracle(payloads);
          if (order.isRefund) {
            oracleCreditMemoNumber = txnNumber;
          } else {
            oracleInvoiceNumber = txnNumber;
          }
        } else {
          // ── Path C: No backup source available ───────────────────────────────
          // Without backup data we cannot build the Oracle SOAP payload.
          // Throw so the order is marked FAILED and remains retryable — the
          // operator should configure OdooCredential or VendHqCredential, run
          // the relevant backup job, and then use POST /sync/retry-failed to
          // re-process the order.
          throw new Error(
            `No backup data found for order ${odooOrderId} (orderNumber=${order.odooOrderNumber ?? odooOrderId}): ` +
              `odooBackupOrderId=${order.odooBackupOrderId ?? 'null'} and no matching BackupOdooOrder or BackupVendHqSale. ` +
              `Ensure credentials are configured (POST /odoo-backup/credentials or POST /admin/vendhq-credentials), ` +
              `run the relevant backup job (POST /odoo-backup/trigger or POST /vendhq-backup/trigger), ` +
              `then retry this order via POST /sync/retry-failed.`,
          );
        }
      }

      const oracleReference =
        oracleInvoiceNumber ?? oracleCreditMemoNumber ?? odooOrderId;

      // ── 13. Record idempotency / audit log ────────────────────
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
        this.logger.warn(
          `Order ${order.odooOrderNumber} has negative inventory items but was released for sync (Finance already notified).`,
        );
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
          oracleCreditMemoNumber: order.isRefund
            ? oracleCreditMemoNumber
            : null,
        },
      });

      if (syncJobId) await this.incrementSyncJobCounters(syncJobId, 'success');

      this.gateway.emitOrderStatus({
        orderId: odooOrderId,
        status: SyncStatus.SYNCED,
      });
      this.logger.log(
        `Order synced successfully: ${odooOrderId} → ${oracleReference}`,
      );
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

      if (syncJobId) {
        await this.incrementSyncJobCounters(syncJobId, 'failed').catch(
          () => undefined,
        );
      }

      await this.queuesService
        .enqueueNotification({
          type: 'ERROR_ALERT',
          subject: `Order sync failed: ${odooOrderId}`,
          body: `Order ${odooOrderId} (branch: ${branchCode}) failed to sync.\n\nError: ${errorMessage}`,
        })
        .catch(() => undefined);

      this.gateway.emitOrderStatus({
        orderId: odooOrderId,
        status: SyncStatus.FAILED,
      });
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

      this.gateway.emitSyncJobUpdate({
        jobId: syncJobId,
        status: finalStatus,
        progress: 100,
      });
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
