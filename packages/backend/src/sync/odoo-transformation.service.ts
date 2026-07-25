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
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ApplyReceiptRequest,
  CreditMemoHeader,
  CreditMemoLine,
  InvoiceHeader,
  InvoiceLine,
  JournalHeader,
  JournalLine,
  MiscReceiptRequest,
  StandardReceiptRequest,
} from '../clients/oracle/oracle-soap.client';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionCustomerAccount } from '../database/entities/fusion-customer-account.entity';
import { FusionReceiptMethod } from '../database/entities/fusion-receipt-method.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { ServiceProviderJournalMeta } from '../database/entities/service-provider-journal-meta.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
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

  constructor(
    @InjectRepository(FusionSalesMetadata)
    private readonly salesMetadataRepo: Repository<FusionSalesMetadata>,
    @InjectRepository(VendHqRegister)
    private readonly registerRepo: Repository<VendHqRegister>,
    @InjectRepository(FusionCustomerAccount)
    private readonly customerAccountRepo: Repository<FusionCustomerAccount>,
    @InjectRepository(BackupOdooOrder)
    private readonly backupOrderRepo: Repository<BackupOdooOrder>,
    @InjectRepository(StoreConfiguration)
    private readonly storeConfigRepo: Repository<StoreConfiguration>,
    @InjectRepository(FusionBusinessUnitMap)
    private readonly businessUnitMapRepo: Repository<FusionBusinessUnitMap>,
    @InjectRepository(FusionReceiptMethod)
    private readonly receiptMethodRepo: Repository<FusionReceiptMethod>,
    @InjectRepository(ServiceProviderJournalMeta)
    private readonly journalMetaRepo: Repository<ServiceProviderJournalMeta>,
  ) {}

  /**
   * Convert Prisma Decimal or BigInt to number safely
   * Handles various data types that can come from Prisma queries
   * @deprecated Use toSafeNumber from bigint-utils instead
   */
  private convertDecimal(value: any): number {
    return toSafeNumber(value);
  }

  /** Round a computed journal amount to 2dp (Oracle rejects long mantissas). */
  private round2Journal(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  /** Normalise a store/mall name for matching (strip spacing, punctuation, case). */
  private normalizeName(s: string | null | undefined): string {
    return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Resolves the FusionSalesMetadata bill-to record for an order.
   *
   * Java parity: the lookup key is (SUBINVENTORY = outlet name, CUSTOMER_TYPE,
   * REGION) — SUBINVENTORY is the branch code, while BILL_TO_NAME is the Oracle
   * customer's display name ("AL JUBAIL MALL" for branch JUBAIL), so matching
   * on billToName finds nothing (or, worse, a region fallback used to pick an
   * arbitrary other store's bill-to account).
   *
   * - Primary: normalised subinventory == branchName within (customerType, region).
   * - NORMAL fallback: normalised billToName == branchName (stores whose
   *   bill-to IS the branch code, and rows imported without a subinventory).
   * - Non-NORMAL fallback: any (customerType, region) row — the platform
   *   customer/account is shared across branches; only the site is per-branch,
   *   so this is flagged but still usable.
   * Returns null when no record matches (caller flags the branch as unmapped).
   */
  private async resolveBillToMetadata(
    customerType: string,
    region: string,
    branchName: string,
  ) {
    const typeUpper = (customerType || 'NORMAL').trim().toUpperCase();
    const target = this.normalizeName(branchName);

    const regionRows = await this.salesMetadataRepo.find({ where: { region } });
    const ofType = regionRows.filter(
      (r) => (r.customerType ?? '').trim().toUpperCase() === typeUpper,
    );

    const bySubinventory = ofType.find(
      (r) => this.normalizeName(r.subinventory) === target,
    );
    if (bySubinventory) return bySubinventory;

    if (typeUpper !== 'NORMAL') {
      const fallback = ofType[0] ?? null;
      if (fallback) {
        this.logger.warn(
          `No ${typeUpper} FusionSalesMetadata row with subinventory ` +
            `"${branchName}" in ${region} — using the region's shared ` +
            `${typeUpper} bill-to (site ${fallback.siteNumber ?? '?'}). ` +
            `Re-import FUSION_SALES_METADATA to restore per-branch sites.`,
        );
      }
      return fallback;
    }

    return (
      ofType.find((c) => this.normalizeName(c.billToName) === target) ?? null
    );
  }

  /**
   * Resolves the VendHqRegister holding this store's Oracle bank/cash account
   * IDs, matched by normalised registerName == branchName within the region.
   * StoreConfiguration's own bank/cash IDs are unpopulated, so VendHqRegister is
   * the source of truth for receipt remittance accounts.
   */
  private async resolveRegisterAccounts(branchName: string, region: string) {
    const registers = await this.registerRepo.find({
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
    const row = await this.customerAccountRepo.findOne({
      where: { accountNumber: parsed, region },
    });
    return row
      ? bigIntToNumber(row.customerAccountId, 'customerAccountId')
      : null;
  }

  /**
   * Checks the order's REAL payment names against FusionReceiptMethod for the
   * store's region (exact-string lookup, mirroring the Java system — there is
   * deliberately no default receipt method). Returns which names have no
   * mapping so the caller can surface a configuration alert; 'Credit On Cust'
   * is excluded because it intentionally posts no receipt.
   */
  async findUnmappedPaymentNames(
    orderName: string,
    region: string,
  ): Promise<{ paymentNames: string[]; unmapped: string[] }> {
    const backup = await this.backupOrderRepo.findOne({
      where: { orderName },
      relations: { orderPayments: true },
    });
    const paymentNames = [
      ...new Set(
        (backup?.orderPayments ?? [])
          .map((p) => p.paymentName?.trim())
          .filter((n): n is string => !!n),
      ),
    ];
    // Service-provider payments (TABBY/TAMARA/…) intentionally post NO receipt —
    // the sale bills the platform on account — so they must not be flagged as
    // "unmapped" (that raised a false PAYMENT_METHOD_DISCOVERED alert). Excluded
    // here alongside 'Credit On Cust', which likewise posts no receipt.
    const providerNames = await this.getServiceProviderNames(region);
    const unmapped: string[] = [];
    for (const name of paymentNames) {
      if (name.toLowerCase() === 'credit on cust') continue;
      if (providerNames.has(name.toUpperCase())) continue;
      const method = await this.receiptMethodRepo.findOne({
        where: { receiptMethodName: name, region },
      });
      if (!method) unmapped.push(name);
    }
    return { paymentNames, unmapped };
  }

  /**
   * The canonical service-provider names configured for a region (the distinct
   * ServiceProviderJournalMeta.serviceProvider values, upper-cased). Used to
   * classify an Odoo order as a delivery-platform sale from its payment method,
   * since the Odoo POS payload carries no `customer_type` field — the provider
   * only shows up as a payment name (e.g. "TABBY", "TAMARA").
   */
  async getServiceProviderNames(region: string): Promise<Set<string>> {
    const rows = await this.journalMetaRepo.find({
      where: { region },
      select: { serviceProvider: true },
    });
    return new Set(
      rows
        .map((r) => (r.serviceProvider ?? '').trim().toUpperCase())
        .filter((n) => n.length > 0),
    );
  }

  /**
   * Derives the service provider (delivery platform) for an order from its
   * payment names, given the region's configured provider set (see
   * getServiceProviderNames). Returns the canonical provider name when any
   * payment matches — picking the provider that settled the largest amount when
   * several are present — or null for an ordinary retail sale.
   *
   * This is what makes a service-provider order route to its own invoice group,
   * platform bill-to and commission GL journal, replacing the missing
   * `customer_type` signal from Odoo.
   */
  deriveServiceProvider(
    order: BackupOdooOrder,
    providerNames: Set<string>,
  ): string | null {
    if (providerNames.size === 0) return null;
    const byProvider = new Map<string, number>();
    for (const payment of order.orderPayments ?? []) {
      const name = (payment.paymentName ?? '').trim().toUpperCase();
      if (!providerNames.has(name)) continue;
      const amount = Math.abs(toSafeNumber(payment.amount ?? 0));
      byProvider.set(name, (byProvider.get(name) ?? 0) + amount);
    }
    if (byProvider.size === 0) return null;
    // Prefer the provider that settled the most; ties fall to the first seen.
    let best: string | null = null;
    let bestAmount = -1;
    for (const [name, amount] of byProvider) {
      if (amount > bestAmount) {
        best = name;
        bestAmount = amount;
      }
    }
    return best;
  }

  // ── Accessors for DailyAggregationService ────────────────────────────────
  // The daily aggregation path needs the same lookups, but keyed on a group of
  // orders rather than one. They are exposed here rather than duplicated so the
  // two paths can never drift apart on bill-to / register / account resolution.

  /** @see resolveBillToMetadata */
  async resolveBillToForAggregate(
    customerType: string,
    region: string,
    branchName: string,
  ) {
    return this.resolveBillToMetadata(customerType, region, branchName);
  }

  /**
   * Resolves the register holding the Oracle bank/cash account ids, preferring
   * the POS register recorded on the order and falling back to the store name.
   * Matching the register (not just the store) keeps receipts for a multi-till
   * outlet remitting to the correct account.
   */
  async resolveRegisterForAggregate(
    registerName: string | null | undefined,
    branchName: string,
    region: string,
  ) {
    const registers = await this.registerRepo.find({ where: { region } });
    const byRegister = registerName
      ? registers.find(
          (r) =>
            this.normalizeName(r.registerName) ===
            this.normalizeName(registerName),
        )
      : undefined;
    return (
      byRegister ??
      registers.find(
        (r) =>
          this.normalizeName(r.registerName) === this.normalizeName(branchName),
      ) ??
      null
    );
  }

  /** @see resolveCustomerAccountId */
  async resolveCustomerAccountForAggregate(
    accountNumber: string,
    region: string,
  ): Promise<number | null> {
    return this.resolveCustomerAccountId(accountNumber, region);
  }

  /** @see buildJournalHeaders */
  async buildJournalHeadersForAggregate(
    serviceProvider: string,
    region: string,
    branchName: string,
    branchCode: string,
    invoiceHeader: InvoiceHeader,
    saleDate: Date,
    txnNumber: string,
  ): Promise<JournalHeader[]> {
    return this.buildJournalHeaders(
      serviceProvider,
      region,
      branchName,
      branchCode,
      invoiceHeader,
      saleDate,
      txnNumber,
    );
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
    const backup = await this.backupOrderRepo.findOne({
      where: { id: backupOrderId },
      relations: { orderLines: true, orderPayments: true },
    });
    if (!backup) {
      throw new Error(`BackupOdooOrder not found: ${backupOrderId}`);
    }

    // ── 2. Load store configuration ──────────────────────────────────────────
    const storeConfig = await this.storeConfigRepo.findOne({
      where: { branchCode },
    });
    if (!storeConfig) {
      throw new Error(
        `StoreConfiguration not found for branchCode=${branchCode}`,
      );
    }

    // ── 3. Load Oracle regional config tables ────────────────────────────────
    const buMap = await this.businessUnitMapRepo.findOne({
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
    // Odoo POS orders carry no `customer_type`; a delivery-platform sale is
    // recognised from its payment method (e.g. TABBY / TAMARA). Mirrors the
    // daily-aggregation grouping so the per-order and aggregated paths classify
    // an order identically — otherwise provider orders synced here would bill to
    // the store instead of the platform and post no commission GL journal.
    const providerNames = await this.getServiceProviderNames(region);
    const derivedProvider = this.deriveServiceProvider(backup, providerNames);
    const orderCustomerType =
      derivedProvider ?? (backup.customerType ?? 'NORMAL');
    // Service-provider (delivery-platform) sales bill the platform on account and
    // are settled later via the platform's receivable, so per requirement they
    // post ONLY the invoice + commission journal — no standard/misc/apply
    // receipts. (A NORMAL retail sale is settled at the till and does get them.)
    const isServiceProviderOrder = derivedProvider != null;
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
      // Java parity: BU / txn source / txn type come from the store's
      // FUSION_SALES_METADATA row; StoreConfiguration is only the fallback.
      businessUnit: salesMeta.businessUnit || storeConfig.oracleBusinessUnit,
      // Prefer warehouse name (outlet name from old integration); fall back to branch name
      outletName: backup.warehouseName ?? backup.branchName ?? undefined,
      saleDate,
      trxDate: saleDate, // Transaction date same as sale date
      paymentTermsName: storeConfig.paymentTermsName,
      transactionSource: salesMeta.txnSource || storeConfig.transactionSource,
      transactionType: salesMeta.txnType || storeConfig.transactionType,
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
        // UOM/tax code intentionally omitted here too — see DailyAggregation.
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

    // Provider sales post no receipts (see isServiceProviderOrder above); the
    // platform payment (TABBY/TAMARA/…) is a receivable, not a till settlement.
    for (const payment of isServiceProviderOrder ? [] : backup.orderPayments) {
      const pmtMethod = payment.paymentName ?? '';
      if (!pmtMethod || pmtMethod.toLowerCase() === 'credit on cust') continue;

      const receiptMethod = await this.receiptMethodRepo.findOne({
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
      const numericAccountId =
        rawAccountId == null ? null : Number(rawAccountId);

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
          receivableActivityName:
            salesMeta.recActivityNameBank ?? 'Bank Charges',
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

  /**
   * Builds the Oracle credit-memo payload for a refund order. A refund is NOT
   * pushed as an invoice; instead this produces a Credit-Memo-class transaction
   * with the refund's line items (amounts are magnitudes here — the SOAP builder
   * negates them). When `originalTransactionNumber` is supplied the memo is tied
   * to the invoice it credits ("applied"); otherwise it is created on-account.
   *
   * Receipts and journals are intentionally omitted — a credit memo reduces the
   * customer's receivable and is settled by finance (refund payment / netting),
   * not by an AR receipt in this integration.
   *
   * @param backupOrderId  BackupOdooOrder.id of the refund order, or null when
   *                       only the header is known (a single line is synthesised
   *                       from `refundAmount`).
   */
  async buildCreditMemoPayload(
    backupOrderId: string | null,
    branchCode: string,
    region: string,
    opts: {
      refundOrderNumber: string;
      refundAmount: number;
      refundDate?: Date;
      reason?: string;
      originalTransactionNumber?: string;
    },
  ): Promise<CreditMemoHeader> {
    // ── 1. Store configuration (region, bill-to store, CM transaction type) ──
    const storeConfig = await this.storeConfigRepo.findOne({
      where: { branchCode },
    });
    if (!storeConfig) {
      throw new Error(
        `StoreConfiguration not found for branchCode=${branchCode}`,
      );
    }

    // Credit memos require a Credit-Memo-class transaction type. Resolve the
    // per-store override first, then the global env default; refuse to build if
    // neither is configured so a wrong/invoice type never reaches Oracle.
    const creditMemoTransactionType =
      storeConfig.creditMemoTransactionType ??
      process.env.ORACLE_CREDIT_MEMO_TRANSACTION_TYPE ??
      null;
    if (!creditMemoTransactionType) {
      throw new Error(
        `No credit-memo transaction type configured for branch ${branchCode} ` +
          `(region ${region}). Set StoreConfiguration.creditMemoTransactionType ` +
          `or ORACLE_CREDIT_MEMO_TRANSACTION_TYPE to a valid Oracle Credit Memo ` +
          `transaction type before pushing refunds as credit memos.`,
      );
    }

    // ── 2. Load the refund backup order (lines) when available ───────────────
    const backup = backupOrderId
      ? await this.backupOrderRepo.findOne({
          where: { id: backupOrderId },
          relations: { orderLines: true },
        })
      : null;

    const memoDate =
      backup?.dateOrder instanceof Date
        ? backup.dateOrder
        : (opts.refundDate ??
          new Date(String(backup?.dateOrder ?? new Date())));

    // ── 3. Resolve the bill-to (same rules as the invoice path) ──────────────
    const customerType = backup?.customerType ?? 'NORMAL';
    const salesMeta = await this.resolveBillToMetadata(
      customerType,
      region,
      storeConfig.branchName,
    );
    if (!salesMeta) {
      throw new Error(
        `No FusionSalesMetadata bill-to match for branch ${branchCode} ` +
          `(name="${storeConfig.branchName}", type=${customerType}, ` +
          `region=${region}) — cannot build credit memo.`,
      );
    }

    const header: CreditMemoHeader = {
      billToCustomerName: salesMeta.billToName,
      billToLocation: salesMeta.siteNumber ?? '',
      billToAccountNumber: String(
        bigIntToNumber(salesMeta.billToAccount, 'billToAccount'),
      ),
      businessUnit: storeConfig.oracleBusinessUnit,
      outletName: backup?.warehouseName ?? backup?.branchName ?? undefined,
      memoDate,
      glDate: memoDate,
      paymentTermsName: storeConfig.paymentTermsName,
      transactionSource: storeConfig.transactionSource,
      transactionType: creditMemoTransactionType,
      invoiceCurrencyCode: storeConfig.invoiceCurrencyCode,
      conversionRateType: 'Corporate',
      conversionRate: 1,
      conversionDate: memoDate,
      originalTransactionNumber: opts.originalTransactionNumber,
      reason: opts.reason,
      creditMemoLines: [],
    };

    // ── 4. Build credit-memo lines from the refund order lines ───────────────
    if (backup && backup.orderLines.length > 0) {
      for (const line of backup.orderLines) {
        const qty = Math.abs(Number(line.qty ?? 1));
        if (qty === 0) continue;

        const total =
          line.priceSubtotalIncl != null
            ? this.convertDecimal(line.priceSubtotalIncl)
            : line.priceSubtotal != null
              ? this.convertDecimal(line.priceSubtotal)
              : this.convertDecimal(line.priceUnit ?? 0) * qty;

        const unitPrice =
          line.priceUnit != null
            ? Math.abs(this.convertDecimal(line.priceUnit))
            : qty !== 0
              ? Math.abs(total / qty)
              : 0;

        const productName = line.productName ?? '';
        const isDiscount = productName === 'Discount Item';

        const memoLine: CreditMemoLine = {
          lineNumber: header.creditMemoLines.length + 1,
          itemNumber:
            line.productCode ??
            (line.productId != null ? String(line.productId) : undefined),
          memoLineName: isDiscount ? 'Discount Item' : undefined,
          description: productName,
          quantity: isDiscount && total > 0 ? 1 : qty,
          unitSellingPrice: unitPrice,
          currencyCode: header.invoiceCurrencyCode,
          salesOrder: opts.refundOrderNumber,
          salesOrderLine: String(header.creditMemoLines.length + 1),
        };
        header.creditMemoLines.push(memoLine);
      }
    }

    // Header-only refund (no line detail) → synthesise a single line from the
    // refund amount so Oracle always receives a valid, non-empty memo.
    if (header.creditMemoLines.length === 0) {
      header.creditMemoLines.push({
        lineNumber: 1,
        description: `Refund — ${opts.refundOrderNumber}`,
        quantity: 1,
        unitSellingPrice: Math.abs(opts.refundAmount),
        currencyCode: header.invoiceCurrencyCode,
        salesOrder: opts.refundOrderNumber,
        salesOrderLine: '1',
      });
    }

    return header;
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
  /** Public accessor for the credit-memo path's revenue-account resolution. */
  async resolveStoreCostCenterPublic(
    branchName: string,
    region: string,
  ): Promise<string | null> {
    return this.resolveStoreCostCenter(branchName, region);
  }

  private async resolveStoreCostCenter(
    branchName: string,
    region: string,
  ): Promise<string | null> {
    const target = this.normalizeName(branchName);
    const rows = await this.salesMetadataRepo.find({
      where: { region, customerType: 'NORMAL' },
      select: { subinventory: true, billToName: true, costCenterCode: true },
    });
    // The store's key in FusionSalesMetadata is SUBINVENTORY (== branchCode /
    // branchName), the same key the bill-to lookup uses — NOT billToName, which
    // is the Oracle customer's display name (e.g. "Mahmal Center" for MAHMAL).
    // Matching on billToName failed for every store whose display name differs
    // from its code, wrongly reporting "No cost-center code". Fall back to
    // billToName for legacy rows imported without a subinventory.
    const match =
      rows.find((r) => this.normalizeName(r.subinventory) === target) ??
      rows.find((r) => this.normalizeName(r.billToName) === target);
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
    if (!serviceProvider || serviceProvider.toUpperCase() === 'NORMAL')
      return [];

    const metaRows = await this.journalMetaRepo.find({
      where: { serviceProvider, region },
    });
    if (metaRows.length === 0) return [];

    const debitMeta = metaRows.find((m) => m.creditDebit === 'CREDIT');
    const creditMeta = metaRows.find((m) => m.creditDebit === 'DEBIT');
    if (!debitMeta || !creditMeta) {
      // Non-fatal: skip the journal but let the invoice/receipts/inventory post.
      // A GL-metadata gap must never fail the whole store's day.
      this.logger.warn(
        `ServiceProviderJournalMeta for "${serviceProvider}" (region ${region}) ` +
          `is missing a CREDIT/DEBIT account pair — GL journal skipped for ${txnNumber}.`,
      );
      return [];
    }

    const total = invoiceHeader.invoiceLines.reduce(
      (s, il) => s + il.unitSellingPrice * il.quantity,
      0,
    );
    if (!(total > 0)) return [];

    // The GL journal posts the service-provider COMMISSION, not the gross sale.
    // Legacy: bankCharge = orderTotal × bankChargeRate; a fixed-freight override
    // replaces it when configured. Posting the full invoice total (the previous
    // behaviour) overstated GL by orders of magnitude for delivery-platform sales.
    const bankChargeRate =
      creditMeta.bankChargeRate ?? debitMeta.bankChargeRate;
    const fixedFreight =
      creditMeta.fixedFreightCharge ?? debitMeta.fixedFreightCharge;
    const commission =
      fixedFreight && fixedFreight > 0
        ? fixedFreight
        : this.round2Journal(total * (bankChargeRate ?? 0));
    if (!(commission > 0)) {
      this.logger.warn(
        `Service provider "${serviceProvider}" (region ${region}) has no ` +
          `bankChargeRate/fixedFreightCharge configured — no GL journal posted ` +
          `for invoice total ${total}.`,
      );
      return [];
    }

    const costCenter = await this.resolveStoreCostCenter(branchName, region);
    if (!costCenter) {
      // Non-fatal: skip the journal, don't fail the invoice. (With the
      // subinventory-keyed lookup this should only happen for a genuinely
      // unmapped store.)
      this.logger.warn(
        `No cost-center code (journal SEGMENT4) for store "${branchName}" ` +
          `(region ${region}) — GL journal skipped for ${txnNumber}. Add ` +
          `costCenterCode to its NORMAL FusionSalesMetadata row.`,
      );
      return [];
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
        enteredDrAmount: commission,
        accountedDr: commission,
      },
      {
        ...common,
        ...segmentsFor(creditMeta.account),
        enteredCrAmount: commission,
        accountedCr: commission,
      },
    ];

    // Balance guard: never post an unbalanced batch (Oracle would reject it, and
    // an unbalanced GL entry is a data-integrity hazard).
    const drSum = journalLines.reduce(
      (s, l) => s + (l.enteredDrAmount ?? 0),
      0,
    );
    const crSum = journalLines.reduce(
      (s, l) => s + (l.enteredCrAmount ?? 0),
      0,
    );
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
        // Persistence-only label for the dashboard (not sent to Oracle). Taken
        // from the CREDIT-side meta row that drove this journal.
        cashCredit: debitMeta.isCash ? 'Cash' : 'Credit',
      },
    ];
  }
}
