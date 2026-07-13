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

  /** Normalise a store/mall name for matching (strip spacing, punctuation, case). */
  private normalizeName(s: string | null | undefined): string {
    return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Resolves the FusionSalesMetadata bill-to record for an order.
   * - Non-NORMAL customerType (delivery platforms) → match by (customerType, region).
   * - NORMAL → match the store's mall by normalised branchName == billToName.
   * Returns null when no record matches (caller flags the branch as unmapped).
   */
  private async resolveBillToMetadata(
    customerType: string,
    region: string,
    branchName: string,
  ) {
    if (customerType && customerType.toUpperCase() !== 'NORMAL') {
      const byType = await this.prisma.fusionSalesMetadata.findFirst({
        where: { customerType, region },
      });
      if (byType) return byType;
    }
    const candidates = await this.prisma.fusionSalesMetadata.findMany({
      where: { region, customerType: 'NORMAL' },
    });
    const target = this.normalizeName(branchName);
    return (
      candidates.find((c) => this.normalizeName(c.billToName) === target) ?? null
    );
  }

  /**
   * Resolves the VendHqRegister holding this store's Oracle bank/cash account
   * IDs, matched by normalised registerName == branchName within the region.
   * StoreConfiguration's own bank/cash IDs are unpopulated, so VendHqRegister is
   * the source of truth for receipt remittance accounts.
   */
  private async resolveRegisterAccounts(branchName: string, region: string) {
    const registers = await this.prisma.vendHqRegister.findMany({
      where: { region },
    });
    const target = this.normalizeName(branchName);
    return (
      registers.find((r) => this.normalizeName(r.registerName) === target) ??
      null
    );
  }

  /**
   * Resolves the Oracle customer ACCOUNT ID (hz_cust_accounts.cust_account_id)
   * for a customer account number. This is the value a standard receipt must
   * carry as <CustomerId>; without it Oracle creates an "Unidentified" receipt
   * and createApplyReceipt fails with AR_NO_RECEIPTS. Looked up from the seeded
   * FusionCustomerAccount map (Oracle's CustomerProfileService is unavailable on
   * the current pod). Returns null when the account isn't mapped.
   */
  private async resolveCustomerAccountId(
    accountNumber: string,
    region: string,
  ): Promise<number | null> {
    const parsed = /^\d+$/.test((accountNumber ?? '').trim())
      ? BigInt(accountNumber.trim())
      : null;
    if (parsed == null) return null;
    const row = await this.prisma.fusionCustomerAccount.findUnique({
      where: { accountNumber_region: { accountNumber: parsed, region } },
    });
    return row ? bigIntToNumber(row.customerAccountId, 'customerAccountId') : null;
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
    const buMap = await this.prisma.fusionBusinessUnitMap.findFirst({
      where: { region },
    });

    // ── 4. Build InvoiceHeader ───────────────────────────────────────────────
    const saleDate =
      backup.dateOrder instanceof Date
        ? backup.dateOrder
        : new Date(String(backup.dateOrder ?? new Date()));

    const orderNumber = backup.orderName ?? String(backup.orderId);
    const txnNumber = transactionNumberOverride ?? orderNumber;

    // ── 3b. Resolve the accurate bill-to from FusionSalesMetadata ────────────
    // StoreConfiguration.billToSiteName/billToLocation hold placeholders and
    // billToAccountNumber was (wrongly) derived from odooBranchId. The real
    // customer name / site / account live in FusionSalesMetadata, keyed by the
    // store name (billToName). Delivery-platform sales (non-NORMAL customerType,
    // e.g. Tamara/Tabby/Mrsool) bill to the platform's own account; NORMAL sales
    // bill to the store's mall, matched by branchName == billToName.
    const orderCustomerType = backup.customerType ?? 'NORMAL';
    const salesMeta = await this.resolveBillToMetadata(
      orderCustomerType,
      region,
      storeConfig.branchName,
    );
    if (!salesMeta) {
      throw new Error(
        `No FusionSalesMetadata bill-to match for branch ${branchCode} ` +
          `(name="${storeConfig.branchName}", type=${orderCustomerType}, ` +
          `region=${region}) — add/align the FusionSalesMetadata record.`,
      );
    }

    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: salesMeta.billToName,
      billToLocation: salesMeta.siteNumber ?? '',
      billToAccountNumber: String(
        bigIntToNumber(salesMeta.billToAccount, 'billToAccount'),
      ), // Convert BigInt to string
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

    // Oracle bank/cash account IDs come from VendHqRegister (StoreConfiguration's
    // are unpopulated); matched by store name within the region.
    const register = await this.resolveRegisterAccounts(
      storeConfig.branchName,
      region,
    );

    // Oracle customer account id for the bill-to customer — required on every
    // standard receipt as <CustomerId> so the receipt is customer-identified and
    // can be applied to the invoice (otherwise createApplyReceipt → AR_NO_RECEIPTS).
    const customerAccountId = await this.resolveCustomerAccountId(
      invoiceHeader.billToAccountNumber,
      region,
    );

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
      // Numeric Oracle bank/cash account ID — sourced from VendHqRegister
      // (matched by store), falling back to StoreConfiguration if present.
      // VendHqRegister IDs are BigInt; normalise to number for the SOAP payload.
      const rawAccountId = isCash
        ? (register?.cashAccountId ?? storeConfig.cashAccountId ?? null)
        : (register?.bankAccountId ?? storeConfig.bankAccountId ?? null);
      const numericAccountId = rawAccountId == null ? null : Number(rawAccountId);

      const pmtAmount = this.convertDecimal(payment.amount ?? 0);
      const lowerMethod = pmtMethod.toLowerCase();

      if (lowerMethod !== 'cash rounding') {
        // Java parity: a sale must not post an invoice without its receipt, so a
        // missing register account is fatal (not a silent skip that would leave
        // an unpaid invoice in Oracle) —
        // "Bank Account Details for Register: <name> is not entered!!"
        if (numericAccountId == null) {
          throw new Error(
            `Bank/cash account for register "${storeConfig.branchName}" ` +
              `(branch ${branchCode}, region ${region}) is not entered in ` +
              `VendHqRegister — cannot create receipt for "${pmtMethod}".`,
          );
        }
        // A receipt without a customer id posts to Oracle as "Unidentified" and
        // then cannot be applied to the invoice (AR_NO_RECEIPTS). Hold the order
        // with an actionable message rather than create an unapplicable receipt.
        if (customerAccountId == null) {
          throw new Error(
            `No Oracle customer account id mapped for account ` +
              `"${invoiceHeader.billToAccountNumber}" (${invoiceHeader.billToCustomerName}, ` +
              `region ${region}) — add it to FusionCustomerAccount (seed via ` +
              `admin oracle-import). Cannot create an applicable receipt for "${pmtMethod}".`,
          );
        }
        {
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
            customerId: customerAccountId,
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
          // Real Oracle bank account name from the register (StoreConfiguration's
          // bankAccountName is an auto-created placeholder like "BANK_SA" that
          // Oracle rejects).
          bankAccountName: register?.bankAccount ?? storeConfig.bankAccountName,
          // Real Oracle receivable-activity name from metadata (the hardcoded
          // 'Bank Charges' is not a valid activity in every BU).
          receivableActivityName: salesMeta.recActivityNameBank ?? 'Bank Charges',
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
          bankAccountName: register?.cashAccount ?? storeConfig.cashAccountName,
          receivableActivityName:
            salesMeta.recActivityNameCash ?? 'Cash Rounding',
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

    // ── 8. Journal entries (service-provider / delivery-platform sales only) ──
    // NORMAL retail sales post no GL journal (mirrors the Java system). For a
    // service provider (Tabby/HungerStation/Mrsool/…) we post a balanced pair:
    // DEBIT the provider's "CREDIT"-row account (the receivable from the
    // platform) and CREDIT its "DEBIT"-row account (revenue), for the invoice
    // total. Both lines carry the full 10-segment code combination and share a
    // GroupId (set on the real Oracle txn in the processor) so Oracle validates
    // their balance together. Amounts must net to zero or Oracle rejects them.
    const journalHeaders: JournalHeader[] = await this.buildJournalHeaders(
      orderCustomerType,
      region,
      storeConfig.branchName,
      branchCode,
      invoiceHeader,
      saleDate,
      String(txnNumber),
    );

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

  /** The store's own cost-center code (journal SEGMENT4), from its NORMAL
   *  FusionSalesMetadata row — NOT the platform bill-to's. Null if unmapped. */
  private async resolveStoreCostCenter(
    branchName: string,
    region: string,
  ): Promise<string | null> {
    const target = this.normalizeName(branchName);
    const rows = await this.prisma.fusionSalesMetadata.findMany({
      where: { region, customerType: 'NORMAL' },
      select: { billToName: true, costCenterCode: true },
    });
    const match = rows.find((r) => this.normalizeName(r.billToName) === target);
    return match?.costCenterCode ?? null;
  }

  /**
   * Builds the GL journal for a service-provider (delivery-platform) order.
   * Returns [] for NORMAL retail sales or providers without journal metadata.
   *
   * The two offsetting accounts come from the provider's paired
   * ServiceProviderJournalMeta rows: creditDebit='CREDIT' → the DEBITED account,
   * creditDebit='DEBIT' → the CREDITED account. The line carries the full COA
   * code combination (10 segments): company / account / department /
   * store-cost-center / productCategory / interCompany / futUsed / extra1-3.
   */
  private async buildJournalHeaders(
    serviceProvider: string,
    region: string,
    branchName: string,
    branchCode: string,
    invoiceHeader: InvoiceHeader,
    saleDate: Date,
    txnNumber: string,
  ): Promise<JournalHeader[]> {
    // NORMAL retail sales don't post a service-provider journal.
    if (!serviceProvider || serviceProvider.toUpperCase() === 'NORMAL') return [];

    const metaRows = await this.prisma.serviceProviderJournalMeta.findMany({
      where: { serviceProvider, region },
    });
    if (metaRows.length === 0) return [];

    const debitMeta = metaRows.find((m) => m.creditDebit === 'CREDIT');
    const creditMeta = metaRows.find((m) => m.creditDebit === 'DEBIT');
    if (!debitMeta || !creditMeta) {
      throw new Error(
        `ServiceProviderJournalMeta for "${serviceProvider}" (region ${region}) ` +
          `is missing a CREDIT/DEBIT account pair — cannot build a balanced journal.`,
      );
    }

    const total = invoiceHeader.invoiceLines.reduce(
      (s, il) => s + il.unitSellingPrice * il.quantity,
      0,
    );
    if (!(total > 0)) return [];

    const costCenter = await this.resolveStoreCostCenter(branchName, region);
    if (!costCenter) {
      throw new Error(
        `No cost-center code (journal SEGMENT4) for store "${branchName}" ` +
          `(region ${region}) — add costCenterCode to its NORMAL FusionSalesMetadata row.`,
      );
    }

    const ledgerId = bigIntToNumber(debitMeta.ledgerId, 'ledgerId');
    const chartOfAccountsId = bigIntToNumber(
      debitMeta.chartOfAccountsId,
      'chartOfAccountsId',
    );
    const jeSource = debitMeta.jeSource ?? 'Vend';
    const jeCategory = debitMeta.jeCategory ?? 'Vend';

    // 10-segment code combination; the natural account (SEGMENT2) is the only
    // segment that differs between the debit and credit sides.
    const segmentsFor = (account: string | null) => ({
      segment1: debitMeta.company ?? undefined,
      segment2: account ?? undefined,
      segment3: debitMeta.department ?? undefined,
      segment4: costCenter,
      segment5: debitMeta.productCategory ?? '00',
      segment6: debitMeta.interCompany ?? '00',
      segment7: debitMeta.futUsed ?? '00',
      segment8: debitMeta.extraSegment1 ?? '00',
      segment9: debitMeta.extraSegment2 ?? '00',
      segment10: debitMeta.extraSegment3 ?? '00',
    });

    const common = {
      ledgerId,
      accountingDate: saleDate,
      userJeSourceName: jeSource,
      jeCategoryName: jeCategory,
      chartOfAccountsId,
      currencyCode: invoiceHeader.invoiceCurrencyCode,
      currencyConversionRate: 1,
      transactionDate: saleDate,
      // groupId is assigned in the processor once the Oracle txn is known, so
      // all lines of this journal batch together for balance validation.
    };

    const journalLines: JournalLine[] = [
      {
        ...common,
        ...segmentsFor(debitMeta.account),
        enteredDrAmount: total,
        accountedDr: total,
      },
      {
        ...common,
        ...segmentsFor(creditMeta.account),
        enteredCrAmount: total,
        accountedCr: total,
      },
    ];

    // Balance guard: never post an unbalanced batch (Oracle would reject it, and
    // an unbalanced GL entry is a data-integrity hazard).
    const drSum = journalLines.reduce((s, l) => s + (l.enteredDrAmount ?? 0), 0);
    const crSum = journalLines.reduce((s, l) => s + (l.enteredCrAmount ?? 0), 0);
    if (Math.abs(drSum - crSum) > 0.001) {
      throw new Error(
        `Journal for "${serviceProvider}" txn ${txnNumber} does not balance ` +
          `(Dr ${drSum} vs Cr ${crSum}) — refusing to post.`,
      );
    }

    return [
      {
        batchName: `${saleDate.toISOString().split('T')[0]}: ${branchCode}`,
        batchDescription: `Odoo Journal Import: ${txnNumber}`,
        ledgerId,
        accountingPeriodName: this.getPeriodName(saleDate),
        accountingDate: saleDate,
        userSourceName: jeSource,
        userCategoryName: jeCategory,
        errorToSuspenseFlag: false,
        summaryFlag: false,
        journalLines,
      },
    ];
  }
}
