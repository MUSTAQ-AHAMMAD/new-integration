import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import {
  AuditOperation,
  AuditStatus,
  ErrorType,
  JobStatus,
  OrderSyncQueue,
  Prisma,
  SyncStatus,
} from '@prisma/client';
import { Job } from 'bull';
import { AlertsService } from '../../alerts/alerts.service';
import { OracleClient } from '../../clients/oracle/oracle.client';
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
import {
  numberToBigInt,
  toBigIntOrNull,
} from '../../common/utils/bigint-utils';

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
    private readonly oracleClient: OracleClient,
    private readonly transformationService: FusionTransformationService,
    private readonly odooTransformationService: OdooTransformationService,
    private readonly enrichmentService: OrderEnrichmentService,
  ) {}

  @Process({ name: 'sync', concurrency: 10 })
  async handleOrderSync(job: Job<OrderSyncJobData>) {
    const { odooOrderId, branchCode, syncJobId } = job.data;
    const startedAt = Date.now();

    this.logger.log(
      `[${odooOrderId}] ========================================`,
    );
    this.logger.log(`[${odooOrderId}] Starting order sync process`);
    this.logger.log(`[${odooOrderId}]   Branch: ${branchCode}`);
    this.logger.log(`[${odooOrderId}]   Sync Job ID: ${syncJobId ?? 'N/A'}`);
    this.logger.log(
      `[${odooOrderId}] ========================================`,
    );

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
        `  - Total Amount: ${String(order.totalAmount)} ${order.currency}\n` +
        `  - Order Date: ${order.orderDate.toISOString()}\n` +
        `  - Customer: ${order.customerName ?? 'N/A'}\n` +
        `  - Is Paid: ${order.isPaid}\n` +
        `  - Is Cancelled: ${order.isCancelled}\n` +
        `  - Is Refund: ${order.isRefund}\n` +
        `  - Current Status: ${order.status}\n` +
        `  - Sync Attempts: ${order.syncAttempts}`,
    );

    try {
      // ── 0. Separate refunds — the Oracle cycle is invoice-only ────────
      // Refund / credit-memo orders (negative-amount, isRefund=true) are NOT
      // pushed to Oracle as invoices. They are diverted to RefundTracking so
      // they surface on the Refunds admin page for manual credit-memo handling.
      // Only non-refund orders continue to invoice creation below.
      if (order.isRefund) {
        await this.separateRefund(order, odooOrderId, syncJobId);
        return;
      }

      // ── 1. Skip unpaid / cancelled orders ────────────────────
      this.logger.log(
        `[${odooOrderId}] Step 1/14: Checking payment/cancellation status...`,
      );
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
      this.logger.log(
        `[${odooOrderId}] ✅ Step 1/14: Order is paid and not cancelled`,
      );

      // ── 2. Business-rule validation ───────────────────────────
      this.logger.log(
        `[${odooOrderId}] Step 2/14: Running business-rule validation...`,
      );
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
          `[${odooOrderId}] ⚠️  Validation warnings:\n${validation.warnings.map((w) => `  - ${w}`).join('\n')}`,
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
      this.logger.log(
        `[${odooOrderId}] Step 3/14: Checking store configuration...`,
      );
      // The store's real Oracle region (e.g. "SA") drives every region-keyed
      // config lookup (metadata, receipt method, journal). It is NOT the same
      // as branchCode — using branchCode made those lookups fall back to
      // arbitrary defaults, producing wrong-BU invoices and placeholder
      // receipts that Oracle rejects.
      let storeRegion = branchCode;
      try {
        const storeConfig =
          await this.storeConfigService.getValidatedConfig(branchCode);
        if (storeConfig.region && storeConfig.region.trim() !== '') {
          storeRegion = storeConfig.region.trim();
        }
        this.logger.log(
          `[${odooOrderId}] ✅ Step 3/14: Store configuration valid (region=${storeRegion})`,
        );
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
      this.logger.log(
        `[${odooOrderId}] Step 4/14: Marking order as PROCESSING...`,
      );
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
      this.logger.log(
        `[${odooOrderId}] ✅ Step 4/14: Status updated to PROCESSING (attempt ${order.syncAttempts + 1})`,
      );

      // ── 4. Resolve payment method (warn-only) ─────────────────
      this.logger.log(
        `[${odooOrderId}] Step 5/14: Resolving payment method...`,
      );
      const paymentMethodName = order.isRefund
        ? 'REFUND'
        : order.branchName?.trim()
          ? `${order.branchName.trim()}-DEFAULT`
          : 'DEFAULT';

      this.logger.debug(
        `[${odooOrderId}]   Payment method name: ${paymentMethodName}`,
      );

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
      this.logger.debug(
        `[${odooOrderId}]   Idempotency key: ${idempotencyKey}`,
      );

      if (await this.idempotencyService.isDuplicate(idempotencyKey)) {
        this.logger.warn(
          `[${odooOrderId}] 🔁 DUPLICATE: Order already synced (idempotency check)`,
        );
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
      this.logger.log(
        `[${odooOrderId}] ✅ Step 6/14: Not a duplicate, proceeding with sync`,
      );

      // ── 6. Resolve backup source and build Oracle payloads ─────
      //
      // ✅ FIXED: Uses backup tables for order data
      // The enrichment service uses a 2-tier approach (in priority order):
      //   A. Backup tables: BackupOdooOrder/BackupVendHqSale tables
      //      → primary source for order lines and payments
      //   B. Minimal viable data: create default line/payment from totalAmount
      //      → fallback ensures ALL orders can sync
      //
      // The enrichment service NEVER fails - it always returns valid Oracle payloads.
      //
      // effectiveRegion is the store's real Oracle region (resolved from
      // StoreConfiguration above), NOT the branchCode — regional config tables
      // (FusionSalesMetadata, FusionReceiptMethod, journal meta, VendHqRegister)
      // are all keyed on the region code.
      const effectiveRegion = storeRegion;
      this.logger.log(
        `[${odooOrderId}] Step 7/14: Enriching order data...\n` +
          `  - Effective Region: ${effectiveRegion}\n` +
          `  - Order Number: ${order.odooOrderNumber}\n` +
          `  - Enrichment will use backup tables or minimal fallback`,
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
        // Validate invoice payload before sending to Oracle
        this.logger.log(
          `[${odooOrderId}] Step 8a/14: Validating and creating Oracle invoice...\n` +
            `  - Bill To: ${invoiceHeader.billToCustomerName}\n` +
            `  - Business Unit: ${invoiceHeader.businessUnit}\n` +
            `  - Account Number: ${invoiceHeader.billToAccountNumber}\n` +
            `  - Transaction Date (trxDate): ${invoiceHeader.trxDate?.toISOString() || 'MISSING - will use saleDate'}\n` +
            `  - Sale Date (glDate): ${invoiceHeader.saleDate?.toISOString()}\n` +
            `  - Payment Terms: ${invoiceHeader.paymentTermsName || 'N/A'}\n` +
            `  - Conversion Rate Type: ${invoiceHeader.conversionRateType}\n` +
            `  - Invoice Lines: ${invoiceHeader.invoiceLines.length}`,
        );

        // ✅ Log complete invoice header structure for debugging
        this.logger.debug(
          `[${odooOrderId}] 📋 Complete Invoice Header Payload:\n${JSON.stringify(
            {
              billToCustomerName: invoiceHeader.billToCustomerName,
              billToLocation: invoiceHeader.billToLocation,
              billToAccountNumber: invoiceHeader.billToAccountNumber,
              businessUnit: invoiceHeader.businessUnit,
              transactionSource: invoiceHeader.transactionSource,
              transactionType: invoiceHeader.transactionType,
              trxDate: invoiceHeader.trxDate?.toISOString(),
              saleDate: invoiceHeader.saleDate?.toISOString(),
              invoiceCurrencyCode: invoiceHeader.invoiceCurrencyCode,
              conversionRateType: invoiceHeader.conversionRateType,
              conversionRate: invoiceHeader.conversionRate,
              conversionDate: invoiceHeader.conversionDate?.toISOString(),
              paymentTermsName: invoiceHeader.paymentTermsName,
              billToContact: invoiceHeader.billToContact,
              soldToCustomerName: invoiceHeader.soldToCustomerName,
              purchaseOrder: invoiceHeader.purchaseOrder,
              invoiceLines: invoiceHeader.invoiceLines.map((line, idx) => ({
                index: idx + 1,
                lineNumber: line.lineNumber,
                memoLineName: line.memoLineName,
                itemNumber: line.itemNumber,
                description: line.description,
                quantity: line.quantity,
                uomCode: line.uomCode,
                unitSellingPrice: line.unitSellingPrice,
                currencyCode: line.currencyCode,
                taxClassificationCode: line.taxClassificationCode,
                salesOrder: line.salesOrder,
                salesOrderLine: line.salesOrderLine,
              })),
            },
            null,
            2,
          )}`,
        );

        // ✅ CRITICAL: Ensure trxDate is set (defaults to saleDate if missing)
        if (!invoiceHeader.trxDate) {
          this.logger.warn(
            `[${odooOrderId}] ⚠️  trxDate is missing, defaulting to saleDate: ${invoiceHeader.saleDate.toISOString()}`,
          );
          invoiceHeader.trxDate = invoiceHeader.saleDate;
        }

        // ✅ Validate required fields
        const missingFields: string[] = [];
        if (!invoiceHeader.billToCustomerName)
          missingFields.push('billToCustomerName');
        if (!invoiceHeader.billToLocation) missingFields.push('billToLocation');
        if (!invoiceHeader.billToAccountNumber)
          missingFields.push('billToAccountNumber');
        if (!invoiceHeader.businessUnit) missingFields.push('businessUnit');
        if (!invoiceHeader.saleDate) missingFields.push('saleDate');
        if (!invoiceHeader.transactionSource)
          missingFields.push('transactionSource');
        if (!invoiceHeader.transactionType)
          missingFields.push('transactionType');
        if (!invoiceHeader.invoiceCurrencyCode)
          missingFields.push('invoiceCurrencyCode');
        if (!invoiceHeader.conversionRateType)
          missingFields.push('conversionRateType');
        if (invoiceHeader.invoiceLines.length === 0)
          missingFields.push('invoiceLines (empty)');

        if (missingFields.length > 0) {
          const errorMsg = `Invoice validation failed - missing required fields: ${missingFields.join(', ')}`;
          this.logger.error(`[${odooOrderId}] ❌ ${errorMsg}`);
          await this.prisma.fusionInvoiceHeader.create({
            data: {
              status: 'ERROR',
              message: errorMsg,
              requestDate: new Date(),
              billToCustName: invoiceHeader.billToCustomerName || 'MISSING',
              billToLocation: invoiceHeader.billToLocation || 'MISSING',
              billToAccNumber:
                invoiceHeader.billToAccountNumber != null
                  ? numberToBigInt(Number(invoiceHeader.billToAccountNumber))
                  : null,
              businessUnit: invoiceHeader.businessUnit || 'MISSING',
              txnSource: invoiceHeader.transactionSource || 'MISSING',
              txnType: invoiceHeader.transactionType || 'MISSING',
              txnDate: invoiceHeader.trxDate || invoiceHeader.saleDate,
              glDate: invoiceHeader.saleDate,
              currencyCode: invoiceHeader.invoiceCurrencyCode || 'MISSING',
              totalAmount: order.totalAmount,
              region: effectiveRegion,
            },
          });
          throw new Error(errorMsg);
        }

        // ── Duplicate check A (Java: getFusionInvoiceLineFindSalesTxnLine) ──
        // If SUCCESS invoice lines already exist for this sale's salesOrder
        // reference, the invoice was created in a prior (possibly partial) run.
        // Skip re-creating it, reuse the existing Oracle transaction number, and
        // fall through to the receipt/journal steps (each has its own dup check).
        const salesOrderRef = invoiceHeader.invoiceLines[0]?.salesOrder ?? null;
        const existingInvoiceLine = salesOrderRef
          ? await this.prisma.fusionInvoiceLine.findFirst({
              where: {
                salesOrder: salesOrderRef,
                region: effectiveRegion,
                // Accept both the normalised 'SUCCESS' and Oracle's raw 'S'
                // (older rows) so an already-created invoice is reused instead
                // of re-created (which would duplicate it in Oracle).
                status: { in: ['SUCCESS', 'S'] },
                invoiceNumber: { not: null },
              },
              orderBy: { createdAt: 'desc' },
            })
          : null;

        let invoiceResult: any;
        if (existingInvoiceLine?.invoiceNumber) {
          this.logger.log(
            `[${odooOrderId}] ⏭️ Step 8a/14: Invoice already exists for ` +
              `salesOrder=${salesOrderRef} (txn ${existingInvoiceLine.invoiceNumber}); ` +
              `skipping invoice creation, reusing existing transaction`,
          );
          invoiceResult = {
            transactionNumber: existingInvoiceLine.invoiceNumber,
            customerTrxId: null,
            serviceStatus: 'SUCCESS',
          };
        } else {
          try {
            invoiceResult =
              await this.soapClient.createSimpleInvoice(invoiceHeader);
          } catch (invoiceError) {
          const errorMessage =
            invoiceError instanceof Error
              ? invoiceError.message
              : String(invoiceError);
          this.logger.error(
            `[${odooOrderId}] ❌ Oracle invoice creation failed:\n` +
              `  Error: ${errorMessage}\n` +
              `  Invoice Header: ${JSON.stringify(
                {
                  billToCustomerName: invoiceHeader.billToCustomerName,
                  billToLocation: invoiceHeader.billToLocation,
                  billToAccountNumber: invoiceHeader.billToAccountNumber,
                  businessUnit: invoiceHeader.businessUnit,
                  transactionSource: invoiceHeader.transactionSource,
                  transactionType: invoiceHeader.transactionType,
                  trxDate: invoiceHeader.trxDate?.toISOString(),
                  saleDate: invoiceHeader.saleDate?.toISOString(),
                  invoiceCurrencyCode: invoiceHeader.invoiceCurrencyCode,
                  conversionRateType: invoiceHeader.conversionRateType,
                  lineCount: invoiceHeader.invoiceLines.length,
                },
                null,
                2,
              )}`,
          );
          // Store failed invoice attempt
          await this.prisma.fusionInvoiceHeader.create({
            data: {
              status: 'ERROR',
              message: errorMessage,
              requestDate: new Date(),
              billToCustName: invoiceHeader.billToCustomerName,
              billToLocation: invoiceHeader.billToLocation,
              billToAccNumber:
                invoiceHeader.billToAccountNumber != null
                  ? numberToBigInt(Number(invoiceHeader.billToAccountNumber))
                  : null,
              businessUnit: invoiceHeader.businessUnit,
              txnSource: invoiceHeader.transactionSource,
              txnType: invoiceHeader.transactionType,
              txnDate: invoiceHeader.trxDate || invoiceHeader.saleDate,
              glDate: invoiceHeader.saleDate,
              currencyCode: invoiceHeader.invoiceCurrencyCode,
              totalAmount: order.totalAmount,
              region: effectiveRegion,
            },
          });
          throw new Error(`Oracle invoice creation failed: ${errorMessage}`);
          }
        }

        // Get the transaction number properly - prefer transactionNumber over customerTrxId.
        // Stored as BigInt: Oracle AR ids exceed Int32 (e.g. 300000236179413).
        const txnNumberOrOrderId =
          invoiceResult.transactionNumber ??
          invoiceResult.customerTrxId ??
          odooOrderId;
        const txnNumber = toBigIntOrNull(txnNumberOrOrderId);

        this.logger.log(
          `[${odooOrderId}] ✅ Step 8a/14: Oracle invoice created\n` +
            `  - Transaction Number: ${txnNumber}\n` +
            `  - Customer Trx ID: ${invoiceResult.customerTrxId || 'N/A'}\n` +
            `  - Status: ${invoiceResult.serviceStatus || 'SUCCESS'}`,
        );

        // ── Restate receipt numbers against the Oracle transaction number ────
        // The transformation seeds receipt numbers from the Odoo order number
        // (e.g. "Mada-RYDAVNUMAL/0231") because the Oracle txn isn't known until
        // the invoice is created. Now that it is, restate them as
        // "<method>-<oracleTxn>" (misc receipts: "<method>-<oracleTxn>-MISC")
        // and point apply receipts at the Oracle transaction, so receipts
        // reference the real invoice — e.g. "Mada-1242176" / "Mada-1242176-MISC".
        if (txnNumber != null) {
          const oracleTxn = txnNumber.toString();
          const methodPrefix = (receiptNumber: string): string =>
            receiptNumber.split(`-${order.odooOrderNumber}`)[0];
          for (const sr of standardReceipts) {
            sr.receiptNumber = `${methodPrefix(sr.receiptNumber)}-${oracleTxn}`;
          }
          for (const mr of miscReceipts) {
            mr.receiptNumber = `${methodPrefix(mr.receiptNumber)}-${oracleTxn}-MISC`;
          }
          for (const ar of applyReceipts) {
            ar.receiptNumber = `${methodPrefix(ar.receiptNumber)}-${oracleTxn}`;
            ar.transactionNumber = oracleTxn;
          }
        }

        // Normalise Oracle's service status ('S'/'E') to the 'SUCCESS'/'ERROR'
        // values the dedupe checks query on — storing the raw 'S' meant dup
        // check A never matched, so every retry re-created the invoice in Oracle
        // (duplicate transactions).
        const normalizedInvoiceStatus =
          invoiceResult.serviceStatus === 'E' ||
          invoiceResult.serviceStatus === 'ERROR'
            ? 'ERROR'
            : 'SUCCESS';

        // Persist the invoice audit rows + inventory txns only when we actually
        // created the invoice this run. On reuse (dup check A) they already exist.
        if (!existingInvoiceLine) {
        const auditHeader = await this.prisma.fusionInvoiceHeader.create({
          data: {
            status: normalizedInvoiceStatus,
            requestDate: new Date(),
            billToCustName: invoiceHeader.billToCustomerName,
            billToLocation: invoiceHeader.billToLocation,
            billToAccNumber:
              invoiceHeader.billToAccountNumber != null
                ? numberToBigInt(Number(invoiceHeader.billToAccountNumber))
                : null,
            businessUnit: invoiceHeader.businessUnit,
            paymentTermsName: invoiceHeader.paymentTermsName,
            txnSource: invoiceHeader.transactionSource,
            txnType: invoiceHeader.transactionType,
            txnDate: invoiceHeader.trxDate || invoiceHeader.saleDate,
            glDate: invoiceHeader.saleDate,
            currencyCode: invoiceHeader.invoiceCurrencyCode,
            txnNumber: txnNumber, // ✅ Store the actual transaction number (BigInt)
            customerTxnId: toBigIntOrNull(invoiceResult.customerTrxId),
            totalAmount: order.totalAmount, // Store total amount for reference
            region: effectiveRegion,
          },
        });

        await this.prisma.fusionInvoiceLine.createMany({
          data: invoiceHeader.invoiceLines.map((il) => ({
            status: normalizedInvoiceStatus,
            requestDate: new Date(),
            invoiceNumber: txnNumber ? String(txnNumber) : null,
            lineNumber: il.lineNumber,
            itemNumber: il.itemNumber ?? null,
            description: il.description,
            uom: il.uomCode ?? null,
            quantity: il.quantity,
            currencyCode: invoiceHeader.invoiceCurrencyCode,
            taxCode: il.taxClassificationCode ?? null,
            salesOrder: il.salesOrder ?? null,
            salesOrderLine: Number(il.salesOrderLine) || null,
            region: effectiveRegion,
            headerId: auditHeader.id,
          })),
        });

        // ── 8b. Create Inventory Transactions for Each Line ───────
        this.logger.log(
          `[${odooOrderId}] Step 8b/14: Creating ${invoiceHeader.invoiceLines.length} inventory transaction(s)...`,
        );

        const inventoryTxns = invoiceHeader.invoiceLines
          .filter((il) => il.itemNumber && il.quantity > 0) // Only create for valid items with quantity
          .map((il) => ({
            status: 'SUCCESS',
            requestDate: new Date(),
            organizationName: invoiceHeader.businessUnit,
            itemNumber: il.itemNumber!,
            txnSourceName: invoiceHeader.transactionSource,
            subInventory: null, // Could be enriched from store config if needed
            txnUom: il.uomCode || 'Ea',
            txnDate: invoiceHeader.trxDate || invoiceHeader.saleDate,
            txnQty: il.quantity,
            region: effectiveRegion,
            integMode: `${effectiveRegion}-ORDER-SYNC`,
          }));

        if (inventoryTxns.length > 0) {
          try {
            await this.prisma.fusionInvTxn.createMany({
              data: inventoryTxns,
            });
            this.logger.log(
              `[${odooOrderId}] ✅ Step 8b/14: Created ${inventoryTxns.length} inventory transaction(s)`,
            );
          } catch (invTxnError) {
            // Log error but don't fail the entire sync
            this.logger.warn(
              `[${odooOrderId}] ⚠️  Inventory transaction creation failed (non-critical): ${
                invTxnError instanceof Error
                  ? invTxnError.message
                  : String(invTxnError)
              }`,
            );
          }
        } else {
          this.logger.log(
            `[${odooOrderId}] ⏭️  Step 8b/14: No valid items for inventory transactions`,
          );
        }
        } // end if (!existingInvoiceLine)

        // ── 9. Push Standard Receipts ─────────────────────────────
        this.logger.log(
          `[${odooOrderId}] Step 9/14: Creating ${standardReceipts.length} standard receipt(s)...`,
        );
        for (const sr of standardReceipts) {
          // ── Duplicate check B (Java: getFindStandardReceipt) ──
          const existingSr = await this.prisma.fusionStandardReceipt.findFirst({
            where: {
              receiptNumber: sr.receiptNumber,
              region: effectiveRegion,
              status: 'SUCCESS',
            },
          });
          if (existingSr) {
            this.logger.log(
              `[${odooOrderId}]   ⏭️ Standard receipt ${sr.receiptNumber} already exists; skipping`,
            );
            continue;
          }
          try {
            const srResult = await this.soapClient.createStandardReceipt(sr);
            await this.prisma.fusionStandardReceipt.create({
              data: {
                status: 'SUCCESS',
                requestDate: new Date(),
                currencyCode: sr.currencyCode,
                receiptDate: sr.saleDate,
                glDate: sr.saleDate,
                receiptMethodId: numberToBigInt(sr.receiptMethodId),
                receiptNumber: srResult.receiptNumber ?? sr.receiptNumber,
                remittanceBankAccId: String(sr.remittanceBankAccountId),
                customerId: toBigIntOrNull(sr.customerId),
                accountValue: sr.accountValue,
                receiptAmount: sr.receiptAmount,
                orgId: toBigIntOrNull(sr.orgId),
                region: effectiveRegion,
              },
            });
            this.logger.log(
              `[${odooOrderId}]   ✅ Standard receipt created: ${srResult.receiptNumber}`,
            );
          } catch (receiptError) {
            this.logger.error(
              `[${odooOrderId}]   ❌ Standard receipt failed: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`,
            );
            await this.prisma.fusionStandardReceipt.create({
              data: {
                status: 'ERROR',
                message:
                  receiptError instanceof Error
                    ? receiptError.message
                    : String(receiptError),
                requestDate: new Date(),
                currencyCode: sr.currencyCode,
                receiptDate: sr.saleDate,
                glDate: sr.saleDate,
                receiptMethodId: numberToBigInt(sr.receiptMethodId),
                receiptNumber: sr.receiptNumber,
                remittanceBankAccId: String(sr.remittanceBankAccountId),
                customerId: toBigIntOrNull(sr.customerId),
                accountValue: sr.accountValue,
                receiptAmount: sr.receiptAmount,
                orgId: toBigIntOrNull(sr.orgId),
                region: effectiveRegion,
              },
            });
            throw receiptError;
          }
        }

        // ── 10. Push Misc Receipts ────────────────────────────────
        this.logger.log(
          `[${odooOrderId}] Step 10/14: Creating ${miscReceipts.length} misc receipt(s)...`,
        );
        for (const mr of miscReceipts) {
          try {
            const mrResult =
              await this.soapClient.createMiscellaneousReceipt(mr);
            await this.prisma.fusionMiscReceipt.create({
              data: {
                status: 'SUCCESS',
                requestDate: new Date(),
                currencyCode: mr.currencyCode,
                glDate: mr.saleDate,
                receiptDate: mr.saleDate,
                receiptMethodId: numberToBigInt(mr.receiptMethodId),
                receiptMethodName: mr.receiptMethodName,
                receiptNumber: mrResult.receiptNumber ?? mr.receiptNumber,
                bankAccNumber: mr.bankAccountName,
                recActivityName: mr.receivableActivityName,
                receiptAmount: mr.receiptAmount,
                orgId: toBigIntOrNull(mr.orgId),
                region: effectiveRegion,
              },
            });
            this.logger.log(
              `[${odooOrderId}]   ✅ Misc receipt created: ${mrResult.receiptNumber}`,
            );
          } catch (miscError) {
            this.logger.error(
              `[${odooOrderId}]   ❌ Misc receipt failed: ${miscError instanceof Error ? miscError.message : String(miscError)}`,
            );
            await this.prisma.fusionMiscReceipt.create({
              data: {
                status: 'ERROR',
                message:
                  miscError instanceof Error
                    ? miscError.message
                    : String(miscError),
                requestDate: new Date(),
                currencyCode: mr.currencyCode,
                glDate: mr.saleDate,
                receiptDate: mr.saleDate,
                receiptMethodId: numberToBigInt(mr.receiptMethodId),
                receiptMethodName: mr.receiptMethodName,
                receiptNumber: mr.receiptNumber,
                bankAccNumber: mr.bankAccountName,
                recActivityName: mr.receivableActivityName,
                receiptAmount: mr.receiptAmount,
                orgId: toBigIntOrNull(mr.orgId),
                region: effectiveRegion,
              },
            });
            throw miscError;
          }
        }

        // ── 11. Apply Receipts to Invoice ─────────────────────────
        for (const ar of applyReceipts) {
          // ── Duplicate check C (Java: getFindApplyReceipt) ──
          const existingAr = await this.prisma.fusionApplyReceipt.findFirst({
            where: {
              receiptNumber: ar.receiptNumber,
              region: effectiveRegion,
              status: 'SUCCESS',
            },
          });
          if (existingAr) {
            this.logger.log(
              `[${odooOrderId}]   ⏭️ Apply receipt ${ar.receiptNumber} already applied; skipping`,
            );
            continue;
          }
          const arResult = await this.soapClient.createApplyReceipt(ar);
          await this.prisma.fusionApplyReceipt.create({
            data: {
              status: 'SUCCESS',
              requestDate: new Date(),
              accountingDate: ar.receiptDate,
              applicationDate: ar.receiptDate,
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
          // ── Duplicate check D (Java: getFindJournalHeader) ──
          // Keyed on the invoice txn number + region (the txnNumber column was
          // previously left unset; it is now populated below so this check works).
          const existingJh =
            txnNumber != null
              ? await this.prisma.fusionJournalHeader.findFirst({
                  where: {
                    txnNumber,
                    region: effectiveRegion,
                    status: 'SUCCESS',
                  },
                })
              : await this.prisma.fusionJournalHeader.findFirst({
                  where: {
                    batchDescription: jh.batchDescription,
                    region: effectiveRegion,
                    status: 'SUCCESS',
                  },
                });
          if (existingJh) {
            this.logger.log(
              `[${odooOrderId}]   ⏭️ Journal already posted for txn ${txnNumber} (${jh.batchDescription}); skipping`,
            );
            continue;
          }
          const jeHeaderId = await this.soapClient.importJournalEntry(jh);
          const jhAudit = await this.prisma.fusionJournalHeader.create({
            data: {
              status: jeHeaderId != null ? 'SUCCESS' : 'ERROR',
              requestDate: new Date(),
              region: effectiveRegion,
              txnNumber: txnNumber ?? null,
              jeHeaderId: jeHeaderId ?? null,
              ledgerId: numberToBigInt(jh.ledgerId),
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
              ledgerId: numberToBigInt(jl.ledgerId),
              chartOfAccountsId:
                jl.chartOfAccountsId != null
                  ? numberToBigInt(jl.chartOfAccountsId)
                  : null,
              currencyCode: jl.currencyCode,
              headerId: jhAudit.id,
            })),
          });
        }

        return String(txnNumber || '');
      };

      // ── Build Oracle payloads ─────────────────────────────────────────────
      // Prefer OdooTransformationService when backup data exists: it resolves
      // the REAL Oracle receipt-method id (FusionReceiptMethod by payment name +
      // region), remittance bank/cash account (VendHqRegister/StoreConfiguration)
      // and org id — unlike the enrichment service, which hardcodes placeholder
      // receipt ids (1/1000/1) that Oracle rejects (JBO-27024). The enrichment
      // service remains the fallback for orders with no backup order row.
      const backupOrder = await this.prisma.backupOdooOrder.findFirst({
        where: { orderName: order.odooOrderNumber },
        select: { id: true },
      });

      let payloads;
      if (backupOrder) {
        this.logger.log(
          `[${odooOrderId}] Transforming from Odoo backup (region=${effectiveRegion})...`,
        );
        payloads = await this.odooTransformationService.buildOrderPayloads(
          backupOrder.id,
          branchCode,
          effectiveRegion,
        );
      } else {
        this.logger.warn(
          `[${odooOrderId}] No Odoo backup order found — using minimal enrichment fallback.`,
        );
        payloads = await this.enrichmentService.enrichOrder(
          order.id,
          branchCode,
          effectiveRegion,
        );
      }

      // ── 7b. Validate line items exist in Oracle's catalog ─────────────────
      // Oracle rejects the whole AR invoice (AR_INVALID_INVENTORY_ITEM) if any
      // line references an item it doesn't know. Rather than create a partial
      // or memo-line invoice, hold the order for review when any item is
      // missing — only fully-valid orders are invoiced.
      const missingItems = await this.findMissingOracleItems(
        payloads.invoiceHeader.invoiceLines,
      );
      if (missingItems.length > 0) {
        await this.holdOrderForInvalidItems(
          order,
          odooOrderId,
          missingItems,
          syncJobId,
        );
        return;
      }

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

      // A circuit-breaker rejection means the downstream Oracle service is
      // temporarily unavailable and the request never actually reached it.
      // This is a transient condition, not a permanent failure — do not mark
      // the order FAILED (which would require manual intervention) or generate
      // FailedTransaction / error-alert noise. Instead, return the order to
      // PENDING so the pipeline scheduler retries it automatically once the
      // circuit recovers.
      if (this.isTransientCircuitError(errorMessage)) {
        this.logger.warn(
          `[${odooOrderId}] ⏳ Sync deferred (transient): ${errorMessage}. ` +
            `Order returned to PENDING for automatic retry.`,
        );
        await this.prisma.orderSyncQueue
          .update({
            where: { id: order.id },
            data: {
              status: SyncStatus.PENDING,
              validationErrors: { error: errorMessage },
            },
          })
          .catch(() => undefined);

        if (syncJobId) {
          await this.incrementSyncJobCounters(syncJobId, 'skipped').catch(
            () => undefined,
          );
        }

        this.gateway.emitOrderStatus({
          orderId: odooOrderId,
          status: SyncStatus.PENDING,
        });
        return;
      }

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
   * Detects transient circuit-breaker rejections thrown by
   * CircuitBreakerService. When a circuit is OPEN (or HALF_OPEN and busy) the
   * request is rejected before it ever reaches the downstream service, so the
   * failure is temporary and the order should be retried rather than
   * permanently failed. The message is matched (rather than the exception
   * type) because the circuit error is often re-wrapped by callers
   * (e.g. "Oracle invoice creation failed: Circuit ... is open and recovering").
   */
  private isTransientCircuitError(message: string): boolean {
    return (
      /circuit \S+ is open and recovering/i.test(message) ||
      /circuit \S+ is half-open and busy/i.test(message)
    );
  }

  /**
   * Diverts a refund / credit-memo order out of the invoice-creation pipeline.
   *
   * The Oracle cycle is invoice-only: refunds must NOT create Oracle invoices
   * (or auto credit memos). Instead the refund is recorded in RefundTracking
   * — the backing table for the Refunds admin page — where finance can raise
   * the credit memo manually and reconcile it. The source order is marked
   * SKIPPED (not FAILED) so it does not count against the failure rate.
   */
  private async separateRefund(
    order: OrderSyncQueue,
    odooOrderId: string,
    syncJobId?: string,
  ): Promise<void> {
    this.logger.warn(
      `[${odooOrderId}] ↩️  REFUND SEPARATED: skipping Oracle invoice creation. ` +
        `Recorded in RefundTracking for manual credit-memo handling.`,
    );

    // totalAmount is negative for refunds; store the magnitude to match the
    // manual-credit-memo convention in RefundsService.
    const refundAmount = new Prisma.Decimal(order.totalAmount).abs();

    try {
      await this.prisma.refundTracking.upsert({
        where: { refundOrderId: order.odooOrderId },
        create: {
          originalOrderId: order.refundReferenceId ?? order.odooOrderId,
          originalOrderNumber: order.odooOrderNumber,
          originalInvoiceNumber: order.oracleInvoiceNumber ?? null,
          refundOrderId: order.odooOrderId,
          refundOrderNumber: order.odooOrderNumber,
          refundAmount,
          refundReason:
            'Auto-separated refund (negative-amount order); credit memo not auto-created',
          refundDate: order.orderDate,
          oracleCreditMemoNumber: '',
          creditMemoStatus: SyncStatus.PENDING,
        },
        update: {
          refundOrderNumber: order.odooOrderNumber,
          refundAmount,
          refundDate: order.orderDate,
        },
      });
    } catch (err) {
      // Tracking is best-effort — never fail the order over it.
      this.logger.error(
        `[${odooOrderId}] Failed to record refund in RefundTracking: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.prisma.orderSyncQueue.update({
      where: { id: order.id },
      data: {
        status: SyncStatus.SKIPPED,
        validationErrors: {
          reasons: [
            'Refund separated — credit memos are not auto-created. Handle via the Refunds page.',
          ],
        },
      },
    });

    this.gateway.emitOrderStatus({
      orderId: odooOrderId,
      status: SyncStatus.SKIPPED,
    });

    if (syncJobId) await this.incrementSyncJobCounters(syncJobId, 'skipped');
  }

  /**
   * Returns the distinct set of line ItemNumbers that do NOT exist in Oracle's
   * item catalog. Oracle rejects the whole AR invoice (AR_INVALID_INVENTORY_ITEM)
   * if any line references an unknown item, so callers hold such orders.
   */
  private async findMissingOracleItems(
    invoiceLines: Array<{ itemNumber?: string | null }>,
  ): Promise<string[]> {
    const itemNumbers = [
      ...new Set(
        invoiceLines
          .map((l) => l.itemNumber?.trim())
          .filter((n): n is string => !!n),
      ),
    ];

    const missing: string[] = [];
    for (const itemNumber of itemNumbers) {
      const exists = await this.oracleClient.itemExists(itemNumber);
      if (!exists) missing.push(itemNumber);
    }
    return missing;
  }

  /**
   * Holds an order that references items unknown to Oracle. Marks it SKIPPED
   * (not FAILED — it is a data-completeness issue, not a system fault), records
   * the missing SKUs for review, and raises an alert. The invoice is never
   * attempted, so Oracle never sees the invalid items.
   */
  private async holdOrderForInvalidItems(
    order: OrderSyncQueue,
    odooOrderId: string,
    missingItems: string[],
    syncJobId?: string,
  ): Promise<void> {
    const preview = missingItems.slice(0, 20).join(', ');
    this.logger.warn(
      `[${odooOrderId}] ⏸️  HELD: ${missingItems.length} item(s) not in Oracle catalog — ` +
        `invoice skipped. Missing: ${preview}`,
    );

    await this.prisma.orderSyncQueue.update({
      where: { id: order.id },
      data: {
        status: SyncStatus.SKIPPED,
        validationErrors: {
          reasons: [
            "Order held for review — one or more items do not exist in Oracle's item " +
              'catalog (AR_INVALID_INVENTORY_ITEM). No invoice was created.',
          ],
          missingOracleItems: missingItems,
        },
      },
    });

    await this.alertsService
      .createAlert({
        alertType: 'INVALID_ORACLE_ITEM',
        severity: 'WARNING',
        title: `Order ${order.odooOrderNumber} held — invalid Oracle item(s)`,
        message:
          `Order ${odooOrderId} (branch ${order.branchCode}) was not invoiced because ` +
          `${missingItems.length} item(s) are not in Oracle's catalog: ${preview}. ` +
          `Create the item(s) in Oracle, then retry the order.`,
        relatedEntityId: odooOrderId,
        relatedEntityType: 'ORDER',
      })
      .catch(() => undefined);

    this.gateway.emitOrderStatus({
      orderId: odooOrderId,
      status: SyncStatus.SKIPPED,
    });

    if (syncJobId) await this.incrementSyncJobCounters(syncJobId, 'skipped');
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
