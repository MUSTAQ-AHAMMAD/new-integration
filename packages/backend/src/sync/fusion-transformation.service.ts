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
import { OracleUomService } from '../clients/oracle/oracle-uom.service';
import { OracleTaxService } from '../clients/oracle/oracle-tax.service';
import { OracleCustomerService } from '../clients/oracle/oracle-customer.service';
import { FusionPayloadValidator } from './fusion-payload-validator';
import { bigIntToNumber, toSafeNumber } from '../common/utils/bigint-utils';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly uomService: OracleUomService,
    private readonly taxService: OracleTaxService,
    private readonly customerService: OracleCustomerService,
  ) {}

  /**
   * Convert Prisma Decimal or BigInt to number safely
   * Handles various data types that can come from Prisma queries
   * @deprecated Use toSafeNumber from bigint-utils instead
   */
  private convertDecimal(value: any): number {
    return toSafeNumber(value);
  }

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

    // Java equivalent: FusionInvoiceMapping.java line 41-54
    // Fetch customer profile to get payment terms (if available)
    const customerProfile = await this.customerService.getCustomerProfile(
      String(salesMeta.billToAccount),
      region,
    );

    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: salesMeta.billToName,
      billToLocation: salesMeta.siteNumber ?? '',
      billToAccountNumber: String(salesMeta.billToAccount),
      businessUnit: salesMeta.businessUnit,
      outletName: sale.outletName ?? undefined,
      saleDate,
      trxDate: saleDate, // Transaction date same as sale date
      // Java: Fetched from CustomerProfileService
      paymentTermsName: customerProfile?.paymentTermsName,
      transactionSource: salesMeta.txnSource,
      transactionType: salesMeta.txnType,
      invoiceCurrencyCode: outlet?.currency ?? 'AED',
      conversionRateType: salesMeta.rateIsCorporate ? 'Corporate' : 'User',
      conversionRate: salesMeta.rateIsCorporate ? 1 : undefined, // Default to 1 for Corporate, undefined for User (may need to fetch)
      conversionDate: saleDate, // Conversion date same as transaction date
      // Optional fields - can be populated from VendHQ data if available
      purchaseOrder: undefined, // Could map from sale.note or custom field if needed
      soldToCustomerName: undefined, // Could map from customer data if needed
      billToContact: undefined, // Could map from customer contact if available
      invoiceLines: [],
    };

    // ── 5. Build InvoiceLines ────────────────────────────────
    // CRITICAL: Use invoiceNumber (VendHQ invoice/receipt number) as Oracle salesOrder reference
    // NOT saleNumber (internal sequence). Matches Java: BackupVendhqSales.invoiceNumber
    const invoiceNumber = sale.invoiceNumber;

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
        // FIXED: Use invoiceNumber instead of saleNumber to match Java implementation
        salesOrder: invoiceNumber,
        salesOrderLine: String(invoiceHeader.invoiceLines.length + 1),
        // Implement UOM service - Java: FusionInvoiceMapping.getUomCode()
        uomCode:
          (await this.uomService.getUomCode(
            li.productId ?? undefined,
            region,
          )) ?? '',
        // Implement Tax service - Java: FusionInvoiceMapping.getTaxClassificationCode()
        taxClassificationCode:
          (await this.taxService.getTaxClassificationCode(
            li.productId ?? undefined,
            region,
          )) ?? '',
      };
      invoiceHeader.invoiceLines.push(invLine);
    }

    // ── 6. Build Standard Receipts ───────────────────────────
    // Use invoiceNumber for transaction references, keep saleNumber for fallback
    const txnNumber = transactionNumberOverride ?? invoiceNumber;
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

      const pmtAmount = this.convertDecimal(payment.amount ?? 0);

      // Standard receipt for everything except cash rounding
      if (pmtMethod.toLowerCase() !== 'cash rounding') {
        standardReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: bigIntToNumber(
            receiptMethod.receiptMethodId,
            'receiptMethodId',
          ),
          receiptNumber: `${pmtMethod}-${txnNumber}`,
          remittanceBankAccountId: Number(bankAccountId!),
          accountValue: invoiceHeader.billToAccountNumber,
          // FIXED: Add region field for duplicate checking in Oracle
          region,
          orgId: Number(buMap?.businessUnitId ?? 0n),
          receiptAmount: pmtAmount,
          // Implement Customer Profile service - Java: FusionStdReceiptMapping.getCustomerId()
          customerId:
            (await this.customerService.getCustomerId(
              invoiceHeader.billToAccountNumber,
              region,
            )) ?? undefined,
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
          receiptMethodId: bigIntToNumber(
            receiptMethod.receiptMethodId,
            'receiptMethodId',
          ),
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
          receiptMethodId: bigIntToNumber(
            receiptMethod.receiptMethodId,
            'receiptMethodId',
          ),
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
      receiptDate: saleDate,
      transactionNumber: txnNumber,
      receiptNumber: sr.receiptNumber,
      amountApplied: sr.receiptAmount,
      receiptCurrency: sr.currencyCode,
      transactionSource: invoiceHeader.transactionSource,
    }));

    // ── 8. Journal entries (non-NORMAL customers only) ───────
    // Java equivalent: FusionJournalEntryMapping.java
    const journalHeaders: JournalHeader[] = [];
    if (customerType !== 'NORMAL' && journalMeta) {
      const periodName = this.getPeriodName(saleDate);

      const journalLines: JournalLine[] = invoiceHeader.invoiceLines.map(
        (il, idx) => ({
          ledgerId: bigIntToNumber(journalMeta.ledgerId, 'ledgerId'),
          periodName, // Java line 84: getPeriodName(invoice.getSaleDate())
          accountingDate: saleDate,
          userJeSourceName: journalMeta.jeSource ?? 'Vend',
          jeCategoryName: journalMeta.jeCategory ?? 'Vend',
          chartOfAccountsId: bigIntToNumber(
            journalMeta.chartOfAccountsId,
            'chartOfAccountsId',
          ),
          segment1: journalMeta.company ?? undefined,
          segment2: journalMeta.account ?? undefined,
          segment3: journalMeta.department ?? undefined,
          segment4: salesMeta.costCenterCode ?? undefined,
          segment5: '00', // Java line 101
          segment6: journalMeta.interCompany ?? undefined,
          segment7: journalMeta.futUsed ?? undefined,
          segment8: '00', // Java line 104
          segment9: '00', // Java line 105
          segment10: '00', // Java line 106
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          // Java logic (lines 109-115): CREDIT lines get Cr amounts, DEBIT lines get Dr amounts
          enteredCrAmount: il.unitSellingPrice * il.quantity,
          accountedCr: il.unitSellingPrice * il.quantity,
          currencyConversionRate: 1, // Java line 119
          currencyConversionType: 'Corporate', // Java line 118
          currencyConversionDate: saleDate, // Java line 120
          transactionDate: saleDate, // Java line 107
          taxCode: 'N', // Java line 121
        }),
      );

      journalHeaders.push({
        // Java line 153: getPeriodName(invoice.getSaleDate()) + ": " + journalMapping.getServiceProvider()
        batchName: `${periodName}: ${customerType}`,
        // Java line 154: "Journal Import: " + transactionNumber
        batchDescription: `Journal Import: ${txnNumber}`,
        ledgerId: bigIntToNumber(journalMeta.ledgerId, 'ledgerId'),
        // Java line 155: getPeriodName(invoice.getSaleDate())
        accountingPeriodName: periodName,
        accountingDate: saleDate,
        userSourceName: journalMeta.jeSource ?? 'Vend',
        userCategoryName: journalMeta.jeCategory ?? 'Vend',
        // Java lines 163-164
        errorToSuspenseFlag: false,
        summaryFlag: false,
        journalLines,
      });
    }

    // ── 9. Validate all payloads before returning ────────────
    const validation = FusionPayloadValidator.validateTransaction(
      invoiceHeader,
      standardReceipts,
      miscReceipts,
      applyReceipts,
      journalHeaders,
    );

    if (!validation.valid) {
      this.logger.warn(
        `Validation warnings for sale ${saleDbId}:`,
        JSON.stringify(validation.errors, null, 2),
      );
      // Log detailed payload for debugging
      this.logger.debug('Invoice:', JSON.stringify(invoiceHeader, null, 2));
      this.logger.debug(
        'Standard Receipts:',
        JSON.stringify(standardReceipts, null, 2),
      );
      this.logger.debug(
        'Misc Receipts:',
        JSON.stringify(miscReceipts, null, 2),
      );
      this.logger.debug(
        'Apply Receipts:',
        JSON.stringify(applyReceipts, null, 2),
      );
      this.logger.debug(
        'Journal Headers:',
        JSON.stringify(journalHeaders, null, 2),
      );
    } else {
      this.logger.debug(
        `All payloads validated successfully for sale ${saleDbId}`,
      );
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
