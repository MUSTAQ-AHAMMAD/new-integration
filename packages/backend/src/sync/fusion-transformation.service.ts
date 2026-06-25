/**
 * FusionTransformationService — TypeScript port of the Java
 * VendHQSalesToFusionInvRecTransBackup transformation layer.
 *
 * Maps raw backup data (BackupVendHqSale / BackupVendHqLineItem /
 * BackupVendHqPayment) + config tables (FusionSalesMetadata,
 * VendHqOutlet, FusionReceiptMethod) into the SOAP model objects
 * consumed by OracleSoapClient.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ApplyReceiptRequest,
  InvoiceHeader,
  InvoiceLine,
  JournalHeader,
  JournalLine,
  MiscReceiptRequest,
  StandardReceiptRequest,
} from '../clients/oracle/oracle-soap.client';

export interface TransformResult {
  invoiceHeader: InvoiceHeader;
  standardReceipts: StandardReceiptRequest[];
  miscReceipts: MiscReceiptRequest[];
  applyReceipts: ApplyReceiptRequest[];
  journalHeaders: JournalHeader[];
}

@Injectable()
export class FusionTransformationService {
  private readonly logger = new Logger(FusionTransformationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Builds all SOAP payload objects for one VendHQ sale stored in the
   * backup tables, ready to be submitted to Oracle Fusion.
   *
   * Matches the Java flow:
   *   addInvoiceMapping → addReceiptMappingLine → misc receipt
   *   → doApplyReceiptOnInvoice → addJournalEntry
   *
   * @param saleDbId  - BackupVendHqSale.id (cuid)
   * @param region    - region code (e.g. "AE", "KW", "OM")
   * @param transactionNumberOverride - if the invoice has already been created, pass its txn number
   */
  async buildSalePayloads(
    saleDbId: string,
    region: string,
    transactionNumberOverride?: string,
  ): Promise<TransformResult> {
    // ── 1. Load raw backup data ──────────────────────────────
    const sale = await this.prisma.backupVendHqSale.findUnique({
      where: { id: saleDbId },
      include: { backupLineItems: true, backupPayments: true },
    });
    if (!sale) throw new Error(`BackupVendHqSale not found: ${saleDbId}`);

    const rawJson = (sale.rawJson ?? {}) as Record<string, unknown>;
    const customerType =
      (rawJson.customer_code as string) ??
      (rawJson.customer_type as string) ??
      'NORMAL';
    const registerName =
      (rawJson.register_name as string) ??
      (rawJson.register_id as string) ??
      '';

    // ── 2. Load config tables ────────────────────────────────
    const outletId = sale.outletId ?? (rawJson.outlet_id as string | undefined);
    const [outlet, salesMeta, buMap, journalMeta] = await Promise.all([
      outletId
        ? this.prisma.vendHqOutlet.findFirst({
            where: { outletId, region },
          })
        : this.prisma.vendHqOutlet.findFirst({
            where: { outletName: sale.outletName ?? undefined, region },
          }),
      this.prisma.fusionSalesMetadata.findFirst({
        where: { customerType, region },
      }),
      this.prisma.fusionBusinessUnitMap.findFirst({ where: { region } }),
      this.prisma.serviceProviderJournalMeta.findFirst({ where: { region } }),
    ]);

    if (!salesMeta)
      throw new Error(
        `FusionSalesMetadata not found for type=${customerType} region=${region}`,
      );

    // ── 3. Resolve register / bank account ──────────────────
    // VendHqRegister records are imported from Oracle and stored with
    // outletId + region. Query directly to avoid reliance on the outletPk
    // relation FK which may not be populated.
    const resolvedOutletId = outletId ?? outlet?.outletId;
    const registers = resolvedOutletId
      ? await this.prisma.vendHqRegister.findMany({
          where: { outletId: resolvedOutletId, region },
        })
      : [];
    const register =
      registers.find((r) => r.registerName === registerName) ?? registers[0];

    // ── 4. Build InvoiceHeader ───────────────────────────────
    const saleDate =
      sale.saleDate instanceof Date
        ? sale.saleDate
        : new Date(String(sale.saleDate));

    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: salesMeta.billToName,
      billToLocation: salesMeta.siteNumber ?? '',
      billToAccountNumber: String(salesMeta.billToAccount),
      businessUnit: salesMeta.businessUnit,
      outletName: sale.outletName ?? undefined,
      saleDate,
      transactionSource: salesMeta.txnSource,
      transactionType: salesMeta.txnType,
      invoiceCurrencyCode: outlet?.currency ?? 'AED',
      conversionRateType: salesMeta.rateIsCorporate ? 'Corporate' : 'User',
      invoiceLines: [],
    };

    // ── 5. Build InvoiceLines ────────────────────────────────
    const saleNumber = sale.saleNumber ?? '';
    for (const li of sale.backupLineItems) {
      const qty = Number(li.quantity ?? 1);
      if (qty === 0) continue;
      const total = Number(li.totalPrice ?? 0);
      const unitPrice = qty !== 0 ? Math.abs(total / qty) : 0;
      const productName = li.productName ?? '';
      const isDiscount = productName === 'Discount Item';

      const invLine: InvoiceLine = {
        lineNumber: invoiceHeader.invoiceLines.length + 1,
        itemNumber: li.productId ?? undefined,
        memoLineName: isDiscount ? 'Discount Item' : undefined,
        description: productName,
        // Java: if Discount Item and total > 0, force qty to 1
        quantity: isDiscount && total > 0 ? 1 : qty,
        unitSellingPrice: unitPrice,
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: saleNumber,
        salesOrderLine: String(invoiceHeader.invoiceLines.length + 1),
      };
      invoiceHeader.invoiceLines.push(invLine);
    }

    // ── 6. Build Standard Receipts ───────────────────────────
    const txnNumber = transactionNumberOverride ?? saleNumber;
    const standardReceipts: StandardReceiptRequest[] = [];
    const miscReceipts: MiscReceiptRequest[] = [];

    for (const payment of sale.backupPayments) {
      const pmtMethod = payment.paymentMethod ?? '';
      if (pmtMethod.toLowerCase() === 'credit on cust') continue;

      const receiptMethod = await this.prisma.fusionReceiptMethod.findFirst({
        where: { receiptMethodName: pmtMethod, region },
      });

      if (!receiptMethod) {
        this.logger.warn(
          `Receipt method not configured: ${pmtMethod} (${region})`,
        );
        continue;
      }

      const isCash = receiptMethod.receiptIsCash;
      const bankAccountId = isCash
        ? (register?.cashAccountId ?? null)
        : (register?.bankAccountId ?? null);

      if (!bankAccountId && pmtMethod.toLowerCase() !== 'cash rounding') {
        throw new Error(
          `Bank/cash account not configured for register: ${register?.registerName ?? 'unknown'}`,
        );
      }

      const pmtAmount = Number(payment.amount ?? 0);

      // Standard receipt for everything except cash rounding
      if (pmtMethod.toLowerCase() !== 'cash rounding') {
        standardReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: Number(receiptMethod.receiptMethodId),
          receiptNumber: `${pmtMethod}-${txnNumber}`,
          remittanceBankAccountId: Number(bankAccountId!),
          accountValue: invoiceHeader.billToAccountNumber,
          orgId: Number(buMap?.businessUnitId ?? 0n),
          receiptAmount: pmtAmount,
        });
      }

      // Misc receipt for non-cash (bank charges) and cash rounding
      if (!isCash) {
        let miscAmount =
          pmtAmount *
          receiptMethod.receiptBankCharge *
          (1 + receiptMethod.receiptMethodTax);
        // Regional cap for Debit Card in OM
        if (pmtMethod === 'Debit Card' && region === 'OM' && miscAmount > 10) {
          miscAmount = 10;
        }
        miscReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: Number(receiptMethod.receiptMethodId),
          receiptMethodName: pmtMethod,
          receiptNumber: `${pmtMethod}-${txnNumber}-MISC`,
          bankAccountName: String(register?.bankAccount ?? ''),
          receivableActivityName:
            salesMeta.recActivityNameBank ?? 'Bank Charges',
          orgId: Number(buMap?.businessUnitId ?? 0n),
          receiptAmount: -miscAmount,
        });
      } else if (pmtMethod.toLowerCase() === 'cash rounding') {
        miscReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: Number(receiptMethod.receiptMethodId),
          receiptMethodName: pmtMethod,
          receiptNumber: `${pmtMethod}-${txnNumber}-MISC`,
          bankAccountName: String(register?.cashAccount ?? ''),
          receivableActivityName:
            salesMeta.recActivityNameCash ?? 'Cash Rounding',
          orgId: Number(buMap?.businessUnitId ?? 0n),
          receiptAmount: -pmtAmount,
        });
      }
    }

    // ── 7. Apply receipts (wired after receipt creation) ─────
    const applyReceipts: ApplyReceiptRequest[] = standardReceipts.map((sr) => ({
      transactionNumber: txnNumber,
      receiptNumber: sr.receiptNumber,
      amountApplied: sr.receiptAmount,
      receiptCurrency: sr.currencyCode,
      transactionSource: invoiceHeader.transactionSource,
      accountingDate: saleDate,
      applicationDate: saleDate,
    }));

    // ── 8. Journal entries (non-NORMAL customers only) ───────
    const journalHeaders: JournalHeader[] = [];
    if (customerType !== 'NORMAL' && journalMeta) {
      const journalLines: JournalLine[] = invoiceHeader.invoiceLines.map(
        (il) => ({
          ledgerId: Number(journalMeta.ledgerId),
          accountingDate: saleDate,
          userJeSourceName: journalMeta.jeSource ?? 'Vend',
          jeCategoryName: journalMeta.jeCategory ?? 'Vend',
          chartOfAccountsId: Number(journalMeta.chartOfAccountsId),
          segment1: journalMeta.company ?? undefined,
          segment2: journalMeta.account ?? undefined,
          segment3: journalMeta.department ?? undefined,
          segment4: salesMeta.costCenterCode ?? undefined,
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
        batchName: `${saleDate.toISOString().split('T')[0]}: ${customerType}`,
        batchDescription: `Journal Import: ${txnNumber}`,
        ledgerId: Number(journalMeta.ledgerId),
        accountingPeriodName: this.getPeriodName(saleDate),
        accountingDate: saleDate,
        userSourceName: journalMeta.jeSource ?? 'Vend',
        userCategoryName: journalMeta.jeCategory ?? 'Vend',
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
