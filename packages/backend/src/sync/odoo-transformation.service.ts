/**
 * OdooTransformationService — builds Oracle Fusion SOAP payloads from
 * BackupOdooOrder data stored in the local PostgreSQL backup tables.
 *
 * This is the Odoo-native counterpart of FusionTransformationService (which
 * operates on BackupVendHqSale records).  It follows the same
 * Invoice → StandardReceipt → MiscReceipt → ApplyReceipt → Journal pattern
 * as the Java VendHQSalesToFusionInvRecTransBackup, but sources data from the
 * Odoo backup tables.
 *
 * Field mapping:
 *   BackupOdooOrder.amountTotal      → InvoiceHeader total / receipt amounts
 *   BackupOdooOrderLine.productName  → InvoiceLine description
 *   BackupOdooOrderLine.qty          → InvoiceLine quantity
 *   BackupOdooOrderLine.priceUnit    → InvoiceLine unitSellingPrice
 *   BackupOdooOrderPayment.paymentName → FusionReceiptMethod lookup key
 *   BackupOdooOrderPayment.amount    → receipt amount
 *   StoreConfiguration               → billTo / businessUnit / transactionSource
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
import { bigIntToNumber, toSafeNumber } from '../common/utils/bigint-utils';

export interface OdooTransformResult {
  invoiceHeader: InvoiceHeader;
  standardReceipts: StandardReceiptRequest[];
  miscReceipts: MiscReceiptRequest[];
  applyReceipts: ApplyReceiptRequest[];
  journalHeaders: JournalHeader[];
}

@Injectable()
export class OdooTransformationService {
  private readonly logger = new Logger(OdooTransformationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Convert Prisma Decimal or BigInt to number safely
   * Handles various data types that can come from Prisma queries
   * @deprecated Use toSafeNumber from bigint-utils instead
   */
  private convertDecimal(value: any): number {
    return toSafeNumber(value);
  }

  /**
   * Builds all Oracle SOAP payloads for one Odoo order stored in the backup
   * tables, ready to be submitted to Oracle Fusion.
   *
   * Flow: Invoice → StandardReceipts → MiscReceipts → ApplyReceipts → Journal
   *
   * @param backupOrderId   BackupOdooOrder.id (cuid)
   * @param branchCode      StoreConfiguration.branchCode for this order
   * @param region          Region identifier (e.g. "AE", "KW", "OM")
   * @param transactionNumberOverride  Pass if the invoice was already created
   */
  async buildOrderPayloads(
    backupOrderId: string,
    branchCode: string,
    region: string,
    transactionNumberOverride?: string,
  ): Promise<OdooTransformResult> {
    // ── 1. Load raw backup data ──────────────────────────────────────────────
    const backup = await this.prisma.backupOdooOrder.findUnique({
      where: { id: backupOrderId },
      include: { orderLines: true, orderPayments: true },
    });
    if (!backup) {
      throw new Error(`BackupOdooOrder not found: ${backupOrderId}`);
    }

    // ── 2. Load store configuration ──────────────────────────────────────────
    const storeConfig = await this.prisma.storeConfiguration.findUnique({
      where: { branchCode },
    });
    if (!storeConfig) {
      throw new Error(
        `StoreConfiguration not found for branchCode=${branchCode}`,
      );
    }

    // ── 3. Load Oracle regional config tables ────────────────────────────────
    const [buMap, journalMeta] = await Promise.all([
      this.prisma.fusionBusinessUnitMap.findFirst({ where: { region } }),
      this.prisma.serviceProviderJournalMeta.findFirst({ where: { region } }),
    ]);

    // ── 4. Build InvoiceHeader ───────────────────────────────────────────────
    const saleDate =
      backup.dateOrder instanceof Date
        ? backup.dateOrder
        : new Date(String(backup.dateOrder ?? new Date()));

    const orderNumber = backup.orderName ?? String(backup.orderId);
    const txnNumber = transactionNumberOverride ?? orderNumber;

    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: storeConfig.billToSiteName,
      billToLocation: storeConfig.billToLocation ?? '',
      billToAccountNumber: storeConfig.odooBranchId, // Use odooBranchId for proper Oracle account mapping
      businessUnit: storeConfig.oracleBusinessUnit,
      // Prefer warehouse name (outlet name from old integration); fall back to branch name
      outletName: backup.warehouseName ?? backup.branchName ?? undefined,
      saleDate,
      trxDate: saleDate, // Transaction date same as sale date
      paymentTermsName: storeConfig.paymentTermsName,
      transactionSource: storeConfig.transactionSource,
      transactionType: storeConfig.transactionType,
      invoiceCurrencyCode: storeConfig.invoiceCurrencyCode,
      conversionRateType: 'Corporate',
      conversionRate: 1, // Default to 1 for Corporate rate type
      conversionDate: saleDate, // Conversion date same as transaction date
      // Optional fields - can be populated from backup data if available
      purchaseOrder: undefined, // Could map from backup.clientOrderRef if needed
      soldToCustomerName: undefined, // Could map from backup.partnerName if needed
      billToContact: undefined, // Could map from contact data if available
      invoiceLines: [],
    };

    // ── 5. Build InvoiceLines ────────────────────────────────────────────────
    for (const line of backup.orderLines) {
      const qty = Number(line.qty ?? 1);
      if (qty === 0) continue;

      // Prefer price_subtotal_incl (tax-inclusive) → price_subtotal → derive
      const total =
        line.priceSubtotalIncl != null
          ? this.convertDecimal(line.priceSubtotalIncl)
          : line.priceSubtotal != null
            ? this.convertDecimal(line.priceSubtotal)
            : this.convertDecimal(line.priceUnit ?? 0) * qty;

      const unitPrice =
        line.priceUnit != null
          ? this.convertDecimal(line.priceUnit)
          : qty !== 0
            ? Math.abs(total / qty)
            : 0;

      const productName = line.productName ?? '';
      const isDiscount = productName === 'Discount Item';

      const invLine: InvoiceLine = {
        lineNumber: invoiceHeader.invoiceLines.length + 1,
        // Prefer SKU/product_code (ITEM_NUMBER) over numeric product id
        itemNumber:
          line.productCode ??
          (line.productId != null ? String(line.productId) : undefined),
        memoLineName: isDiscount ? 'Discount Item' : undefined,
        description: productName,
        quantity: isDiscount && total > 0 ? 1 : qty,
        unitSellingPrice: unitPrice,
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: orderNumber,
        salesOrderLine: String(invoiceHeader.invoiceLines.length + 1),
      };
      invoiceHeader.invoiceLines.push(invLine);
    }

    // When there are no line items (e.g. the API returned only the header),
    // synthesise a single line from the order total so Oracle always receives
    // a valid invoice with at least one line.
    // Use amountUntaxed (excl. tax) when available — matches old integration's TOTAL_PRICE mapping.
    if (invoiceHeader.invoiceLines.length === 0 && backup.amountTotal != null) {
      this.logger.warn(
        `BackupOdooOrder id=${backupOrderId} has no line items — synthesising single line from amountTotal`,
      );
      const syntheticAmount =
        backup.amountUntaxed != null
          ? this.convertDecimal(backup.amountUntaxed)
          : this.convertDecimal(backup.amountTotal);
      invoiceHeader.invoiceLines.push({
        lineNumber: 1,
        description: backup.orderName ?? 'Sale',
        quantity: 1,
        unitSellingPrice: syntheticAmount,
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: orderNumber,
        salesOrderLine: '1',
      });
    }

    // ── 6. Build Standard & Misc Receipts ────────────────────────────────────
    const standardReceipts: StandardReceiptRequest[] = [];
    const miscReceipts: MiscReceiptRequest[] = [];

    for (const payment of backup.orderPayments) {
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
      // Use the numeric Oracle bank/cash account ID from StoreConfiguration.
      // These mirror VendHqRegister.bankAccountId / cashAccountId and must be
      // populated by the operator for receipt creation to succeed.
      const numericAccountId = isCash
        ? (storeConfig.cashAccountId ?? null)
        : (storeConfig.bankAccountId ?? null);

      const pmtAmount = this.convertDecimal(payment.amount ?? 0);
      const lowerMethod = pmtMethod.toLowerCase();

      if (lowerMethod !== 'cash rounding') {
        if (numericAccountId == null) {
          this.logger.warn(
            `StoreConfiguration branchCode=${branchCode} has no ` +
              `${isCash ? 'cashAccountId' : 'bankAccountId'} — ` +
              `standard receipt for "${pmtMethod}" skipped. ` +
              `Set the field on the StoreConfiguration record to enable receipt creation.`,
          );
        } else {
          standardReceipts.push({
            currencyCode: invoiceHeader.invoiceCurrencyCode,
            saleDate,
            receiptMethodId: bigIntToNumber(
              receiptMethod.receiptMethodId,
              'receiptMethodId',
            ),
            receiptNumber: `${pmtMethod}-${txnNumber}`,
            remittanceBankAccountId: numericAccountId,
            accountValue: invoiceHeader.billToAccountNumber,
            orgId: bigIntToNumber(
              buMap?.businessUnitId ?? 0n,
              'businessUnitId',
            ),
            receiptAmount: pmtAmount,
          });
        }
      }

      if (!isCash) {
        let miscAmount =
          pmtAmount *
          receiptMethod.receiptBankCharge *
          (1 + receiptMethod.receiptMethodTax);
        // Regional cap matching Java logic: Debit Card in OM capped at 10
        if (pmtMethod === 'Debit Card' && region === 'OM' && miscAmount > 10) {
          miscAmount = 10;
        }
        miscReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: bigIntToNumber(
            receiptMethod.receiptMethodId,
            'receiptMethodId',
          ),
          receiptMethodName: pmtMethod,
          receiptNumber: `${pmtMethod}-${txnNumber}-MISC`,
          bankAccountName: storeConfig.bankAccountName,
          receivableActivityName: 'Bank Charges',
          orgId: bigIntToNumber(buMap?.businessUnitId ?? 0n, 'businessUnitId'),
          receiptAmount: -miscAmount,
        });
      } else if (lowerMethod === 'cash rounding') {
        miscReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: bigIntToNumber(
            receiptMethod.receiptMethodId,
            'receiptMethodId',
          ),
          receiptMethodName: pmtMethod,
          receiptNumber: `${pmtMethod}-${txnNumber}-MISC`,
          bankAccountName: storeConfig.cashAccountName,
          receivableActivityName: 'Cash Rounding',
          orgId: bigIntToNumber(buMap?.businessUnitId ?? 0n, 'businessUnitId'),
          receiptAmount: -pmtAmount,
        });
      }
    }

    // ── 7. Apply receipts (linked after receipt creation) ────────────────────
    const applyReceipts: ApplyReceiptRequest[] = standardReceipts.map((sr) => ({
      receiptDate: saleDate,
      transactionNumber: txnNumber,
      receiptNumber: sr.receiptNumber,
      amountApplied: sr.receiptAmount,
      receiptCurrency: sr.currencyCode,
      transactionSource: invoiceHeader.transactionSource,
    }));

    // ── 8. Journal entries ───────────────────────────────────────────────────
    const journalHeaders: JournalHeader[] = [];
    if (journalMeta && invoiceHeader.invoiceLines.length > 0) {
      const journalLines: JournalLine[] = invoiceHeader.invoiceLines.map(
        (il) => ({
          ledgerId: bigIntToNumber(journalMeta.ledgerId, 'ledgerId'),
          accountingDate: saleDate,
          userJeSourceName: journalMeta.jeSource ?? 'Odoo',
          jeCategoryName: journalMeta.jeCategory ?? 'Odoo',
          chartOfAccountsId: bigIntToNumber(
            journalMeta.chartOfAccountsId,
            'chartOfAccountsId',
          ),
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
        ledgerId: bigIntToNumber(journalMeta.ledgerId, 'ledgerId'),
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
