/**
 * OrderEnrichmentService — enriches orders for Oracle transformation
 * Works DIRECTLY with OrderSyncQueue data without requiring backup tables.
 * 
 * This service enables order processing when:
 * 1. Orders are ingested with complete line/payment data
 * 2. Backup tables are unavailable or incomplete
 * 3. Real-time processing is needed without backup step
 * 
 * Flow:
 * 1. Check if order has complete data in OrderSyncQueue (lines, payments, amounts)
 * 2. If complete → build Oracle payloads directly from queue data
 * 3. If incomplete → fallback to backup tables (BackupOdooOrder/BackupVendHqSale)
 * 4. If still incomplete → create minimal viable payloads
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  ApplyReceiptRequest,
  InvoiceHeader,
  InvoiceLine,
  JournalHeader,
  JournalLine,
  MiscReceiptRequest,
  StandardReceiptRequest,
} from '../clients/oracle/oracle-soap.client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderLineData, OrderPaymentData } from './order-sync.service';

export interface EnrichedOrderData {
  invoiceHeader: InvoiceHeader;
  standardReceipts: StandardReceiptRequest[];
  miscReceipts: MiscReceiptRequest[];
  applyReceipts: ApplyReceiptRequest[];
  journalHeaders: JournalHeader[];
}

@Injectable()
export class OrderEnrichmentService {
  private readonly logger = new Logger(OrderEnrichmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enriches an order for Oracle sync by building all required payloads.
   * Priority: Direct order data > Backup tables > Minimal fallback
   */
  async enrichOrder(
    orderSyncQueueId: string,
    branchCode: string,
    region: string,
    transactionNumberOverride?: string,
  ): Promise<EnrichedOrderData> {
    this.logger.log(
      `Enriching order ${orderSyncQueueId} for region ${region}, branch ${branchCode}`,
    );

    // Step 1: Load order from OrderSyncQueue
    const order = await this.prisma.orderSyncQueue.findUnique({
      where: { id: orderSyncQueueId },
    });

    if (!order) {
      throw new Error(`OrderSyncQueue record not found: ${orderSyncQueueId}`);
    }

    // Step 2: Check if order has complete data
    if (this.hasCompleteData(order)) {
      this.logger.log(
        `✅ Order ${order.odooOrderId} has complete data in queue - using DIRECT enrichment (no backup needed)`,
      );
      return this.enrichFromQueueData(order, branchCode, region, transactionNumberOverride);
    }

    // Step 3: Fallback to backup tables if odooBackupOrderId is set
    if (order.odooBackupOrderId) {
      this.logger.log(
        `⚠️  Order ${order.odooOrderId} incomplete - falling back to BackupOdooOrder`,
      );
      try {
        return await this.enrichFromBackupOdooOrder(
          order.odooBackupOrderId,
          branchCode,
          region,
          transactionNumberOverride,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to load backup data for order ${order.odooOrderId}: ${
            err instanceof Error ? err.message : 'Unknown error'
          } - will create minimal payloads instead`,
        );
        // Continue to minimal enrichment below
      }
    }

    // Step 4: Try VendHQ backup as last resort
    this.logger.log(
      `Order ${order.odooOrderId} has no backup - attempting VendHQ backup lookup`,
    );
    const backupSale = await this.prisma.backupVendHqSale.findFirst({
      where: {
        OR: [
          { saleNumber: order.odooOrderNumber },
          { invoiceNumber: order.odooOrderNumber },
        ],
      },
    });

    if (backupSale) {
      this.logger.warn(
        `Found VendHQ backup for order ${order.odooOrderId} but VendHQ enrichment not yet integrated - creating minimal payloads instead`,
      );
      // VendHQ backup integration would require FusionTransformationService
      // For now, fall through to minimal enrichment
    }

    // Step 5: Create minimal viable order payloads
    // This ensures ALL orders can sync even without backup data
    this.logger.log(
      `⚠️  Order ${order.odooOrderId} has no complete data - creating MINIMAL payloads (will still sync successfully)`,
    );
    return this.createMinimalEnrichment(order, branchCode, region, transactionNumberOverride);
  }

  /**
   * Checks if order has complete data for direct processing
   */
  private hasCompleteData(order: any): boolean {
    const hasLines = Array.isArray(order.orderLines) && order.orderLines.length > 0;
    const hasPayments = Array.isArray(order.orderPayments) && order.orderPayments.length > 0;
    const hasTotal = order.totalAmount != null && Number(order.totalAmount) > 0;
    
    return hasLines && hasPayments && hasTotal;
  }

  /**
   * Enriches order directly from OrderSyncQueue data
   */
  private async enrichFromQueueData(
    order: any,
    branchCode: string,
    region: string,
    transactionNumberOverride?: string,
  ): Promise<EnrichedOrderData> {
    // Load store configuration
    const storeConfig = await this.prisma.storeConfiguration.findUnique({
      where: { branchCode },
    });
    if (!storeConfig) {
      throw new Error(
        `StoreConfiguration not found for branchCode=${branchCode}`,
      );
    }

    // Load Oracle regional config tables
    const [buMap, journalMeta] = await Promise.all([
      this.prisma.fusionBusinessUnitMap.findFirst({ where: { region } }),
      this.prisma.serviceProviderJournalMeta.findFirst({ where: { region } }),
    ]);

    const saleDate = order.orderDate instanceof Date 
      ? order.orderDate 
      : new Date(String(order.orderDate));
    const txnNumber = transactionNumberOverride ?? order.odooOrderNumber;

    // Build invoice header
    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: storeConfig.billToSiteName,
      billToLocation: storeConfig.billToLocation ?? '',
      billToAccountNumber: String(storeConfig.oracleOperatingUnitId),
      businessUnit: storeConfig.oracleBusinessUnit,
      outletName: order.warehouseName ?? order.branchName ?? undefined,
      saleDate,
      transactionSource: storeConfig.transactionSource,
      transactionType: storeConfig.transactionType,
      invoiceCurrencyCode: order.currency ?? storeConfig.invoiceCurrencyCode,
      conversionRateType: 'Corporate',
      invoiceLines: [],
    };

    // Build invoice lines from orderLines
    const orderLines: OrderLineData[] = order.orderLines || [];
    for (const line of orderLines) {
      const qty = Number(line.qty ?? 1);
      if (qty === 0) continue;

      // Prefer price_subtotal_incl (tax-inclusive) → price_subtotal → derive
      const total =
        line.priceSubtotalIncl != null
          ? Number(line.priceSubtotalIncl)
          : line.priceSubtotal != null
            ? Number(line.priceSubtotal)
            : Number(line.priceUnit ?? 0) * qty;

      const unitPrice =
        line.priceUnit != null
          ? Number(line.priceUnit)
          : qty !== 0
            ? Math.abs(total / qty)
            : 0;

      const productName = line.productName ?? '';
      const isDiscount = productName === 'Discount Item';

      const invLine: InvoiceLine = {
        lineNumber: invoiceHeader.invoiceLines.length + 1,
        itemNumber:
          line.productCode ??
          (line.productId != null ? String(line.productId) : undefined),
        memoLineName: isDiscount ? 'Discount Item' : undefined,
        description: productName,
        quantity: isDiscount && total > 0 ? 1 : qty,
        unitSellingPrice: unitPrice,
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: order.odooOrderNumber,
        salesOrderLine: String(invoiceHeader.invoiceLines.length + 1),
      };
      invoiceHeader.invoiceLines.push(invLine);
    }

    // If no line items, synthesize one from order total
    if (invoiceHeader.invoiceLines.length === 0) {
      this.logger.warn(
        `Order ${order.odooOrderId} has no line items — synthesising single line from totalAmount`,
      );
      const syntheticAmount = order.amountUntaxed != null
        ? Number(order.amountUntaxed)
        : Number(order.totalAmount);
      
      invoiceHeader.invoiceLines.push({
        lineNumber: 1,
        description: order.odooOrderNumber ?? 'Sale',
        quantity: 1,
        unitSellingPrice: syntheticAmount,
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: order.odooOrderNumber,
        salesOrderLine: '1',
      });
    }

    // Build receipts from orderPayments
    const standardReceipts: StandardReceiptRequest[] = [];
    const miscReceipts: MiscReceiptRequest[] = [];

    const orderPayments: OrderPaymentData[] = order.orderPayments || [];
    for (const payment of orderPayments) {
      const pmtMethod = payment.paymentName ?? '';
      if (!pmtMethod || pmtMethod.toLowerCase() === 'credit on cust') continue;

      const receiptMethod = await this.prisma.fusionReceiptMethod.findFirst({
        where: { receiptMethodName: pmtMethod, region },
      });

      if (!receiptMethod) {
        this.logger.warn(
          `Receipt method not configured: "${pmtMethod}" (region=${region}) — payment skipped`,
        );
        continue;
      }

      const isCash = receiptMethod.receiptIsCash;
      const numericAccountId = isCash
        ? (storeConfig.cashAccountId ?? null)
        : (storeConfig.bankAccountId ?? null);

      const pmtAmount = Number(payment.amount ?? 0);
      const lowerMethod = pmtMethod.toLowerCase();

      if (lowerMethod !== 'cash rounding') {
        if (numericAccountId == null) {
          this.logger.warn(
            `StoreConfiguration branchCode=${branchCode} has no ` +
              `${isCash ? 'cashAccountId' : 'bankAccountId'} — ` +
              `standard receipt for "${pmtMethod}" skipped.`,
          );
        } else {
          standardReceipts.push({
            currencyCode: invoiceHeader.invoiceCurrencyCode,
            saleDate,
            receiptMethodId: Number(receiptMethod.receiptMethodId),
            receiptNumber: `${pmtMethod}-${txnNumber}`,
            remittanceBankAccountId: numericAccountId,
            accountValue: invoiceHeader.billToAccountNumber,
            orgId: Number(buMap?.businessUnitId ?? 0n),
            receiptAmount: pmtAmount,
          });
        }
      }

      if (!isCash) {
        let miscAmount =
          pmtAmount *
          receiptMethod.receiptBankCharge *
          (1 + receiptMethod.receiptMethodTax);
        // Regional cap: Debit Card in OM capped at 10
        if (pmtMethod === 'Debit Card' && region === 'OM' && miscAmount > 10) {
          miscAmount = 10;
        }
        miscReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: Number(receiptMethod.receiptMethodId),
          receiptMethodName: pmtMethod,
          receiptNumber: `${pmtMethod}-${txnNumber}-MISC`,
          bankAccountName: storeConfig.bankAccountName,
          receivableActivityName: 'Bank Charges',
          orgId: Number(buMap?.businessUnitId ?? 0n),
          receiptAmount: -miscAmount,
        });
      } else if (lowerMethod === 'cash rounding') {
        miscReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: Number(receiptMethod.receiptMethodId),
          receiptMethodName: pmtMethod,
          receiptNumber: `${pmtMethod}-${txnNumber}-MISC`,
          bankAccountName: storeConfig.cashAccountName,
          receivableActivityName: 'Cash Rounding',
          orgId: Number(buMap?.businessUnitId ?? 0n),
          receiptAmount: -pmtAmount,
        });
      }
    }

    // Build apply receipts
    const applyReceipts: ApplyReceiptRequest[] = standardReceipts.map((sr) => ({
      transactionNumber: txnNumber,
      receiptNumber: sr.receiptNumber,
      amountApplied: sr.receiptAmount,
      receiptCurrency: sr.currencyCode,
      transactionSource: invoiceHeader.transactionSource,
      accountingDate: saleDate,
      applicationDate: saleDate,
    }));

    // Build journal entries
    const journalHeaders: JournalHeader[] = [];
    if (journalMeta && invoiceHeader.invoiceLines.length > 0) {
      const journalLines: JournalLine[] = invoiceHeader.invoiceLines.map(
        (il) => ({
          ledgerId: Number(journalMeta.ledgerId),
          accountingDate: saleDate,
          userJeSourceName: journalMeta.jeSource ?? 'Odoo',
          jeCategoryName: journalMeta.jeCategory ?? 'Odoo',
          chartOfAccountsId: Number(journalMeta.chartOfAccountsId),
          segment1: journalMeta.company ?? undefined,
          segment2: journalMeta.account ?? undefined,
          segment3: journalMeta.department ?? undefined,
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          enteredCrAmount: il.unitSellingPrice * il.quantity,
          accountedCr: il.unitSellingPrice * il.quantity,
          currencyConversionRate: 1,
          currencyConversionType: invoiceHeader.conversionRateType,
          currencyConversionDate: saleDate,
          transactionDate: saleDate,
          status: 'P',
          taxCode: 'N',
        }),
      );

      journalHeaders.push({
        batchName: `${saleDate.toISOString().split('T')[0]}: ${branchCode}`,
        batchDescription: `Odoo Journal Import: ${txnNumber}`,
        ledgerId: Number(journalMeta.ledgerId),
        accountingPeriodName: this.getPeriodName(saleDate),
        accountingDate: saleDate,
        userSourceName: journalMeta.jeSource ?? 'Odoo',
        userCategoryName: journalMeta.jeCategory ?? 'Odoo',
        errorToSuspenseFlag: false,
        summaryFlag: false,
        journalLines,
      });
    }

    return {
      invoiceHeader,
      standardReceipts,
      miscReceipts,
      applyReceipts,
      journalHeaders,
    };
  }

  /**
   * Enriches order from BackupOdooOrder tables (existing backup path)
   */
  private async enrichFromBackupOdooOrder(
    backupOrderId: string,
    branchCode: string,
    region: string,
    transactionNumberOverride?: string,
  ): Promise<EnrichedOrderData> {
    // This delegates to OdooTransformationService for backward compatibility
    // We import it dynamically to avoid circular dependencies
    const { OdooTransformationService } = await import('./odoo-transformation.service');
    const odooTransformService = new OdooTransformationService(this.prisma);
    
    return odooTransformService.buildOrderPayloads(
      backupOrderId,
      branchCode,
      region,
      transactionNumberOverride,
    );
  }

  /**
   * Creates minimal viable payloads when no complete data is available
   */
  private async createMinimalEnrichment(
    order: any,
    branchCode: string,
    region: string,
    transactionNumberOverride?: string,
  ): Promise<EnrichedOrderData> {
    const storeConfig = await this.prisma.storeConfiguration.findUnique({
      where: { branchCode },
    });
    if (!storeConfig) {
      throw new Error(
        `StoreConfiguration not found for branchCode=${branchCode}`,
      );
    }

    const saleDate = order.orderDate instanceof Date 
      ? order.orderDate 
      : new Date(String(order.orderDate));
    const txnNumber = transactionNumberOverride ?? order.odooOrderNumber;
    const totalAmount = Number(order.totalAmount);

    // Create a single-line invoice from the order total
    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: storeConfig.billToSiteName,
      billToLocation: storeConfig.billToLocation ?? '',
      billToAccountNumber: String(storeConfig.oracleOperatingUnitId),
      businessUnit: storeConfig.oracleBusinessUnit,
      outletName: order.warehouseName ?? order.branchName ?? undefined,
      saleDate,
      transactionSource: storeConfig.transactionSource,
      transactionType: storeConfig.transactionType,
      invoiceCurrencyCode: order.currency ?? storeConfig.invoiceCurrencyCode,
      conversionRateType: 'Corporate',
      invoiceLines: [
        {
          lineNumber: 1,
          description: `${order.odooOrderNumber} - Minimal Sync`,
          quantity: 1,
          unitSellingPrice: totalAmount,
          currencyCode: order.currency ?? storeConfig.invoiceCurrencyCode,
          salesOrder: order.odooOrderNumber,
          salesOrderLine: '1',
        },
      ],
    };

    this.logger.warn(
      `Created minimal invoice for order ${order.odooOrderId} with single line of ${totalAmount} ${invoiceHeader.invoiceCurrencyCode}`,
    );

    // No receipts or journal entries for minimal sync
    return {
      invoiceHeader,
      standardReceipts: [],
      miscReceipts: [],
      applyReceipts: [],
      journalHeaders: [],
    };
  }

  private getPeriodName(d: Date): string {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return `${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
  }
}
