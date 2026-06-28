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
import { OrderEnrichmentService } from '../../sync/order-enrichment.service';
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
    private readonly enrichmentService: OrderEnrichmentService,
  ) {}

  @Process({ name: 'sync', concurrency: 10 })
  async handleOrderSync(job: Job<OrderSyncJobData>) {
    const { odooOrderId, branchCode, syncJobId } = job.data;
    const startedAt = Date.now();
    
    this.logger.log(`[${odooOrderId}] ========================================`);
    this.logger.log(`[${odooOrderId}] Starting order sync process`);
    this.logger.log(`[${odooOrderId}]   Branch: ${branchCode}`);
    this.logger.log(`[${odooOrderId}]   Sync Job ID: ${syncJobId ?? 'N/A'}`);
    this.logger.log(`[${odooOrderId}] ========================================`);

    const order = await this.prisma.orderSyncQueue.findUnique({
      where: { odooOrderId_branchCode: { odooOrderId, branchCode } },
    });

    if (!order) {
      this.logger.warn(`[${odooOrderId}] ❌ Order not found in queue`);
      return;
    }

    this.logger.log(
      `[${odooOrderId}] 📋 Order details:\n` +
      `  - Order Number: ${order.odooOrderNumber}\n` +
      `  - Total Amount: ${order.totalAmount} ${order.currency}\n` +
      `  - Order Date: ${order.orderDate.toISOString()}\n` +
      `  - Customer: ${order.customerName ?? 'N/A'}\n` +
      `  - Is Paid: ${order.isPaid}\n` +
      `  - Is Cancelled: ${order.isCancelled}\n` +
      `  - Is Refund: ${order.isRefund}\n` +
      `  - Current Status: ${order.status}\n` +
      `  - Sync Attempts: ${order.syncAttempts}`,
    );

    try {
      // ── 1. Skip unpaid / cancelled orders ────────────────────
      this.logger.log(`[${odooOrderId}] Step 1/14: Checking payment/cancellation status...`);
      if (!order.isPaid || order.isCancelled) {
        const skipReasons = [
          !order.isPaid ? 'Order is not paid/posted' : null,
          order.isCancelled ? 'Order is cancelled' : null,
        ].filter(Boolean);
        
        this.logger.warn(
          `[${odooOrderId}] ⏭️  SKIPPED: ${skipReasons.join(', ')}`,
        );
        
        await this.prisma.orderSyncQueue.update({
          where: { id: order.id },
          data: {
            status: SyncStatus.SKIPPED,
            validationErrors: { reasons: skipReasons },
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
      this.logger.log(`[${odooOrderId}] ✅ Step 1/14: Order is paid and not cancelled`);

      // ── 2. Business-rule validation ───────────────────────────
      this.logger.log(`[${odooOrderId}] Step 2/14: Running business-rule validation...`);
      const validation = await this.validationService.validateOrder(
        odooOrderId,
        branchCode,
      );
      if (!validation.isValid) {
        this.logger.error(
          `[${odooOrderId}] ❌ VALIDATION FAILED:\n` +
          `  Errors: ${JSON.stringify(validation.errors, null, 2)}\n` +
          `  Warnings: ${JSON.stringify(validation.warnings, null, 2)}`,
        );
        
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
      
      if (validation.warnings.length > 0) {
        this.logger.warn(
          `[${odooOrderId}] ⚠️  Validation warnings:\n${validation.warnings.map(w => `  - ${w}`).join('\n')}`,
        );
      }
      this.logger.log(`[${odooOrderId}] ✅ Step 2/14: Validation passed`);

      // ── 2b. Negative-inventory hold ──────────────────────────
      if (validation.holdForNegativeInventory) {
        this.logger.warn(
          `[${odooOrderId}] ⏸️  HELD: Negative inventory detected. Use retry-negative-inventory endpoint to re-process.`,
        );
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
        return;
      }

      // ── 2c. Store configuration check ────────────────────────
      this.logger.log(`[${odooOrderId}] Step 3/14: Checking store configuration...`);
      try {
        await this.storeConfigService.getValidatedConfig(branchCode);
        this.logger.log(`[${odooOrderId}] ✅ Step 3/14: Store configuration valid`);
      } catch (configErr) {
        const configMsg =
          configErr instanceof Error ? configErr.message : 'Store config error';
        this.logger.error(
          `[${odooOrderId}] ❌ CONFIGURATION ERROR: ${configMsg}`,
        );
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

      // ── 3. Mark as PROCESSING ─────────────────────────────────
      this.logger.log(`[${odooOrderId}] Step 4/14: Marking order as PROCESSING...`);
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
      this.logger.log(`[${odooOrderId}] ✅ Step 4/14: Status updated to PROCESSING (attempt ${order.syncAttempts + 1})`);

      // ── 4. Resolve payment method (warn-only) ─────────────────
      this.logger.log(`[${odooOrderId}] Step 5/14: Resolving payment method...`);
      const paymentMethodName = order.isRefund
        ? 'REFUND'
        : order.branchName?.trim()
          ? `${order.branchName.trim()}-DEFAULT`
          : 'DEFAULT';
      
      this.logger.debug(`[${odooOrderId}]   Payment method name: ${paymentMethodName}`);
      
      const resolvedMapping =
        await this.paymentMappingService.resolvePaymentMethod(
          'ODOO',
          paymentMethodName,
        );
      const fallbackAlert =
        resolvedMapping === null
          ? `Payment method "${paymentMethodName}" has no Oracle mapping — integration will continue without a receipt method`
          : null;
      
      if (resolvedMapping) {
        this.logger.log(
          `[${odooOrderId}] ✅ Step 5/14: Payment method resolved: ${JSON.stringify(resolvedMapping)}`,
        );
      } else {
        this.logger.warn(
          `[${odooOrderId}] ⚠️  Step 5/14: No payment mapping found for "${paymentMethodName}" - will proceed without receipt method`,
        );
      }

      // ── 5. Idempotency guard ──────────────────────────────────
      this.logger.log(`[${odooOrderId}] Step 6/14: Checking idempotency...`);
      const idempotencyKey = this.idempotencyService.generateKey(
        odooOrderId,
        order.isRefund
          ? AuditOperation.CREATE_CREDIT_MEMO
          : AuditOperation.CREATE_INVOICE,
        branchCode,
      );
      this.logger.debug(`[${odooOrderId}]   Idempotency key: ${idempotencyKey}`);

      if (await this.idempotencyService.isDuplicate(idempotencyKey)) {
        this.logger.warn(`[${odooOrderId}] 🔁 DUPLICATE: Order already synced (idempotency check)`);
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
      this.logger.log(`[${odooOrderId}] ✅ Step 6/14: Not a duplicate, proceeding with sync`);

      // ── 6. Resolve backup source and build Oracle payloads ─────
      //
      // ✅ FIXED: Direct enrichment without backup dependency
      // The enrichment service uses a 3-tier approach (in priority order):
      //   A. Direct order data: orderLines + orderPayments JSON fields populated
      //      → fastest path, no database lookups required
      //   B. Backup tables: BackupOdooOrder/BackupVendHqSale tables
      //      → fallback when direct data not available  
      //   C. Minimal viable data: create default line/payment from totalAmount
      //      → last resort, ensures ALL orders can sync
      //
      // The enrichment service NEVER fails - it always returns valid Oracle payloads.
      // The region used for all Oracle config lookups is taken from
      // order.region (populated during ingest from OdooCredential.region) with
      // a fallback to branchCode for legacy / VendHQ-sourced orders.
      const effectiveRegion = order.region ?? branchCode;
      this.logger.log(
        `[${odooOrderId}] Step 7/14: Enriching order data...\n` +
        `  - Effective Region: ${effectiveRegion}\n` +
        `  - Has orderLines: ${Array.isArray(order.orderLines) && order.orderLines.length > 0}\n` +
        `  - Has orderPayments: ${Array.isArray(order.orderPayments) && order.orderPayments.length > 0}\n` +
        `  - Odoo Backup Order ID: ${order.odooBackupOrderId ?? 'null'}\n` +
        `  - Order Number: ${order.odooOrderNumber}\n` +
        `  - Enrichment will use: ${Array.isArray(order.orderLines) && order.orderLines.length > 0 ? 'Direct Queue Data' : order.odooBackupOrderId ? 'Backup Tables' : 'Minimal Fallback'}`,
      );

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

        this.logger.log(
          `[${odooOrderId}] Step 8/14: Pushing Oracle payloads:\n` +
          `  - Invoice Lines: ${invoiceHeader.invoiceLines.length}\n` +
          `  - Standard Receipts: ${standardReceipts.length}\n` +
          `  - Misc Receipts: ${miscReceipts.length}\n` +
          `  - Apply Receipts: ${applyReceipts.length}\n` +
          `  - Journal Entries: ${journalHeaders.length}`,
        );

        // ── 8. Push Invoice ───────────────────────────────────────
        this.logger.log(`[${odooOrderId}] Step 8a/14: Creating Oracle invoice...`);
        const invoiceResult =
          await this.soapClient.createSimpleInvoice(invoiceHeader);
        
        // Get the transaction number properly - prefer transactionNumber over customerTrxId
        // Convert to number since Prisma schema expects Int
        const txnNumberOrOrderId = 
          invoiceResult.transactionNumber ?? 
          invoiceResult.customerTrxId ?? 
          odooOrderId;
        const parsedTxnNumber = parseInt(txnNumberOrOrderId, 10);
        const txnNumber = isNaN(parsedTxnNumber) ? null : parsedTxnNumber;
        
        this.logger.log(
          `[${odooOrderId}] ✅ Step 8a/14: Oracle invoice created\n` +
          `  - Transaction Number: ${txnNumber}\n` +
          `  - Customer Trx ID: ${invoiceResult.customerTrxId || 'N/A'}\n` +
          `  - Status: ${invoiceResult.serviceStatus || 'SUCCESS'}`,
        );

        const auditHeader = await this.prisma.fusionInvoiceHeader.create({
          data: {
            status: invoiceResult.serviceStatus || 'SUCCESS',
            requestDate: new Date(),
            billToCustName: invoiceHeader.billToCustomerName,
            billToLocation: invoiceHeader.billToLocation,
            billToAccNumber: invoiceHeader.billToAccountNumber != null ? BigInt(invoiceHeader.billToAccountNumber) : null,
            businessUnit: invoiceHeader.businessUnit,
            txnSource: invoiceHeader.transactionSource,
            txnType: invoiceHeader.transactionType,
            txnDate: invoiceHeader.saleDate,
            glDate: invoiceHeader.saleDate,
            currencyCode: invoiceHeader.invoiceCurrencyCode,
            txnNumber: txnNumber,  // ✅ Store the actual transaction number
            customerTxnId: Number(invoiceResult.customerTrxId) || null,
            region: effectiveRegion,
          },
        });

        await this.prisma.fusionInvoiceLine.createMany({
          data: invoiceHeader.invoiceLines.map((il) => ({
            status: invoiceResult.serviceStatus ?? 'SUCCESS',
            requestDate: new Date(),
            invoiceNumber: txnNumber ? String(txnNumber) : null,
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

        return String(txnNumber || '');
      };

      // ── NEW APPROACH: Use Enrichment Service ──────────────────────────────────
      // The enrichment service will:
      // 1. Try to use direct order data from OrderSyncQueue (orderLines, orderPayments)
      // 2. Fall back to backup tables if needed (BackupOdooOrder, BackupVendHqSale)
      // 3. Create minimal viable payloads if neither are available
      //
      // This removes the hard dependency on backup tables and allows orders to
      // sync directly when they have complete data.
      
      this.logger.log(
        `[${odooOrderId}] Using enrichment service for flexible order processing...`,
      );
      
      const payloads = await this.enrichmentService.enrichOrder(
        order.id,
        branchCode,
        effectiveRegion,
      );
      
      const txnNumber = await pushToOracle(payloads);
      const txnNumberStr = txnNumber ? String(txnNumber) : null;
      if (order.isRefund) {
        oracleCreditMemoNumber = txnNumberStr;
      } else {
        oracleInvoiceNumber = txnNumberStr;
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
