/**
 * DailyAggregationService — collapses a day's Odoo orders for one branch into a
 * single Oracle AR invoice per group, replacing the previous one-invoice-per-order
 * model.
 *
 * Ported from the legacy Java integration
 * (VendHQSalesToFusionInvRecTransBackup#addInvoiceMapping), which groups sales by
 * outlet + calendar day + customer type + credit flag. The differences from that
 * reference are deliberate and listed in docs/RUNBOOK_E2E_AND_DEPLOYMENT.md:
 *
 *   - Refunds are NOT folded in as negative lines; they stay on the credit-memo
 *     path, so this service only ever aggregates positive sales.
 *   - The register is part of the receipt key, so an outlet with several
 *     registers no longer silently attributes every receipt to the first one.
 *   - The outlet is recorded on the invoice header instead of being recoverable
 *     only via the bill-to customer name.
 *
 * Grouping key:  branchCode | businessDay (store-local) | customerType | credit
 * Line grain:    one Oracle line per source order line (no item-level summing),
 *                numbered continuously across the whole group.
 * Traceability:  every line carries salesOrder = source order number and
 *                salesOrderLine = source line number, which is also the
 *                idempotency key that prevents a re-run duplicating a day.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';
import {
  ApplyReceiptRequest,
  InvoiceHeader,
  InvoiceLine,
  JournalHeader,
  MiscReceiptRequest,
  StandardReceiptRequest,
} from '../clients/oracle/oracle-soap.client';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionReceiptMethod } from '../database/entities/fusion-receipt-method.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { VendHqTaxMeta } from '../database/entities/vend-hq-tax-meta.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { bigIntToNumber, toSafeNumber } from '../common/utils/bigint-utils';
import { OracleClient } from '../clients/oracle/oracle.client';
import { OdooTransformationService } from './odoo-transformation.service';

/** Placeholder used in receipt numbers until Oracle issues the transaction number. */
export const TXN_PLACEHOLDER = '__TXN__';

/** States that must never be invoiced. Mirrors the ingest-side rules. */
const NON_INVOICEABLE_STATES = new Set([
  'draft',
  'cancel',
  'cancelled',
  'quotation',
  'sent_quotation',
]);

/**
 * Which calendar day an order belongs to depends on the store's wall clock, not
 * UTC — a 01:30 sale in Riyadh belongs to the previous UTC day. There is no
 * timezone column on StoreConfiguration, so resolve by region and fall back to
 * the order's own `timezone` field, then to the Odoo default.
 */
const REGION_TIMEZONE: Record<string, string> = {
  SN: 'Asia/Riyadh',
  SA: 'Asia/Riyadh',
  AE: 'Asia/Dubai',
  KW: 'Asia/Kuwait',
  BH: 'Asia/Bahrain',
  OM: 'Asia/Muscat',
};
const DEFAULT_TIMEZONE = 'Asia/Dubai';

export interface DailyInvoiceGroup {
  /** Stable identity of the group — also the daily idempotency scope. */
  groupKey: string;
  branchCode: string;
  /** Human-readable store name for the UI. */
  branchName: string | null;
  region: string;
  /** Store-local calendar day, YYYY-MM-DD. */
  businessDay: string;
  customerType: string;
  isCredit: boolean;
  /** Every Odoo order considered for this group, for traceability. */
  sourceOrderNumbers: string[];
  /** All Odoo order ids considered, including ones already fully posted. */
  sourceOdooOrderIds: string[];
  /**
   * Odoo order ids that actually contributed a line to THIS invoice — the only
   * ones that may be stamped with its transaction number. Orders whose lines
   * were posted by an earlier run keep pointing at their original invoice.
   */
  contributingOdooOrderIds: string[];
  /** Lines skipped because a previous run already posted them successfully. */
  alreadyPostedLines: number;
  /** Oracle transaction number a prior run assigned, when every line was posted. */
  existingTransactionNumber: string | null;
  /**
   * False when the invoice already exists in Oracle and only its receipts /
   * journals still need posting. The orchestrator must then reuse
   * `existingTransactionNumber` instead of calling createSimpleInvoice.
   */
  postInvoice: boolean;
  /** Orders held back because Oracle does not know one of their items. */
  excludedOrders: Array<{ orderNumber: string; reason: string }>;
  invoiceHeader: InvoiceHeader;
  standardReceipts: StandardReceiptRequest[];
  miscReceipts: MiscReceiptRequest[];
  applyReceipts: ApplyReceiptRequest[];
  journalHeaders: JournalHeader[];
  /** One inventory issue per contributing line, to relieve Oracle stock. */
  inventoryTransactions: InventoryTransactionPlan[];
}

/** A planned inventory issue, before the Oracle organisation id is resolved. */
export interface InventoryTransactionPlan {
  itemNumber: string;
  subinventoryCode: string;
  /** Positive magnitude; the client negates it for an issue. */
  quantity: number;
  uomCode: string;
  transactionDate: Date;
  /** Source order number, for the Oracle TransactionSourceName + audit trail. */
  salesOrder: string;
  salesOrderLine: number;
}

/** Receipt accumulator keyed by payment method + register. */
interface ReceiptBucket {
  paymentMethod: string;
  receiptMethodId: number;
  isCash: boolean;
  registerKey: string;
  accountId: number | null;
  bankAccountName: string | null;
  cashAccountName: string | null;
  amount: number;
  bankChargeAmount: number;
  cashRoundingAmount: number;
}

@Injectable()
export class DailyAggregationService {
  private readonly logger = new Logger(DailyAggregationService.name);

  constructor(
    @InjectRepository(BackupOdooOrder)
    private readonly backupOrderRepo: Repository<BackupOdooOrder>,
    @InjectRepository(StoreConfiguration)
    private readonly storeConfigRepo: Repository<StoreConfiguration>,
    @InjectRepository(FusionBusinessUnitMap)
    private readonly businessUnitMapRepo: Repository<FusionBusinessUnitMap>,
    @InjectRepository(FusionReceiptMethod)
    private readonly receiptMethodRepo: Repository<FusionReceiptMethod>,
    @InjectRepository(FusionInvoiceLine)
    private readonly invoiceLineRepo: Repository<FusionInvoiceLine>,
    @InjectRepository(VendHqItemMeta)
    private readonly itemMetaRepo: Repository<VendHqItemMeta>,
    @InjectRepository(VendHqTaxMeta)
    private readonly taxMetaRepo: Repository<VendHqTaxMeta>,
    private readonly transformation: OdooTransformationService,
    private readonly oracleClient: OracleClient,
  ) {}

  /**
   * Region → VAT rate (fraction, e.g. 0.15), resolved once and cached.
   * The rate is derived from VendHqTaxMeta: the meta carries no numeric rate
   * column, so it is parsed from the "…-N%" suffix of the row's Fusion name
   * (falling back to the tax name). Operator choice: one rate per region, folded
   * into each invoice line's unit price so the Oracle total includes VAT.
   */
  private readonly regionVatRateCache = new Map<string, number>();

  private async resolveRegionVatRate(region: string): Promise<number> {
    const key = region.trim().toUpperCase();
    const cached = this.regionVatRateCache.get(key);
    if (cached !== undefined) return cached;

    const rows = await this.taxMetaRepo.find({ where: { region: key } });
    const parseRate = (name: string | null): number | null => {
      const m = name?.match(/(\d+(?:\.\d+)?)\s*%/);
      if (!m) return null;
      const pct = Number(m[1]);
      return Number.isFinite(pct) && pct > 0 ? pct / 100 : null;
    };
    const rates = [
      ...new Set(
        rows
          .map((r) => parseRate(r.fusionName) ?? parseRate(r.taxName))
          .filter((r): r is number => r != null),
      ),
    ];

    let rate = 0;
    if (rates.length === 1) {
      rate = rates[0];
    } else if (rates.length > 1) {
      // "One rate per region" is ambiguous here (e.g. SA lists both 5% and 15%).
      // Use the highest and warn so the operator can prune the meta to one row.
      rate = Math.max(...rates);
      this.logger.warn(
        `Region ${key} has multiple VAT rates in VendHqTaxMeta ` +
          `(${rates.map((r) => `${r * 100}%`).join(', ')}) — using ${rate * 100}%. ` +
          `Keep a single rate per region to make this deterministic.`,
      );
    } else {
      this.logger.warn(
        `No parseable VAT rate in VendHqTaxMeta for region ${key} — ` +
          `invoice lines will be posted without tax (0%).`,
      );
    }
    this.regionVatRateCache.set(key, rate);
    return rate;
  }

  /**
   * Returns the UTC instants bounding a store-local calendar day.
   *
   * The legacy system applied a fixed per-outlet hour/minute offset; using the
   * IANA zone instead means DST transitions are handled correctly rather than
   * silently shifting the day boundary.
   */
  localDayWindow(
    businessDay: string,
    timeZone: string,
  ): { start: Date; end: Date } {
    const [y, m, d] = businessDay.split('-').map(Number);
    // Offset of the target zone at roughly midday on that date, in minutes.
    const probe = Date.UTC(y, m - 1, d, 12, 0, 0);
    const offsetMinutes = this.zoneOffsetMinutes(new Date(probe), timeZone);
    const startUtc = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60_000;
    return {
      start: new Date(startUtc),
      end: new Date(startUtc + 86_400_000 - 1),
    };
  }

  /** Minutes that `timeZone` is ahead of UTC at `at`. */
  private zoneOffsetMinutes(at: Date, timeZone: string): number {
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const parts = Object.fromEntries(
        dtf.formatToParts(at).map((p) => [p.type, p.value]),
      );
      const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour === '24' ? '0' : parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
      return Math.round((asUtc - at.getTime()) / 60_000);
    } catch {
      this.logger.warn(`Unknown timezone "${timeZone}" — treating as UTC`);
      return 0;
    }
  }

  /** Store-local calendar day (YYYY-MM-DD) for an instant. */
  localDayOf(at: Date, timeZone: string): string {
    const offset = this.zoneOffsetMinutes(at, timeZone);
    return new Date(at.getTime() + offset * 60_000).toISOString().slice(0, 10);
  }

  /**
   * Builds every Oracle invoice group for one branch on one store-local day.
   *
   * Returns an empty array when the day has nothing left to post — either no
   * eligible orders, or every line already posted by an earlier run.
   */
  async buildDailyGroups(
    branchCode: string,
    businessDay: string,
    timeZoneOverride?: string,
  ): Promise<DailyInvoiceGroup[]> {
    const storeConfig = await this.storeConfigRepo.findOne({
      where: { branchCode },
    });
    if (!storeConfig) {
      throw new Error(
        `StoreConfiguration not found for branchCode=${branchCode}`,
      );
    }
    const region = storeConfig.region?.trim() || branchCode;
    const timeZone =
      timeZoneOverride ?? REGION_TIMEZONE[region] ?? DEFAULT_TIMEZONE;
    const { start, end } = this.localDayWindow(businessDay, timeZone);

    const orders = await this.backupOrderRepo.find({
      where: [
        { resolvedBranchCode: branchCode, dateOrder: Between(start, end) },
        {
          // odooBranchId is a bigint column; BackupOdooOrder.branchId is numeric.
          branchId: Number(storeConfig.odooBranchId),
          dateOrder: Between(start, end),
        },
      ],
      relations: { orderLines: true, orderPayments: true },
      order: { dateOrder: 'ASC', orderId: 'ASC' },
    });

    const eligible = orders.filter((o) => this.isInvoiceable(o));
    if (eligible.length === 0) {
      this.logger.log(
        `[${branchCode} ${businessDay}] no invoiceable orders in window ` +
          `${start.toISOString()}..${end.toISOString()}`,
      );
      return [];
    }

    // ── Group ────────────────────────────────────────────────────────────────
    // Odoo POS orders carry no `customer_type`, so a delivery-platform sale is
    // recognised from its payment method (e.g. TABBY / TAMARA) against the
    // region's configured providers. A matched order then forms its own invoice
    // group, bills to the platform account and posts a commission GL journal;
    // ordinary retail stays NORMAL.
    const providerNames =
      await this.transformation.getServiceProviderNames(region);
    const buckets = new Map<string, BackupOdooOrder[]>();
    for (const order of eligible) {
      const derivedProvider = this.transformation.deriveServiceProvider(
        order,
        providerNames,
      );
      const customerType =
        derivedProvider ??
        ((order.customerType ?? 'NORMAL').trim() || 'NORMAL');
      const isCredit = (order.orderPayments ?? []).some(
        (p) => (p.paymentName ?? '').toLowerCase() === 'credit on cust',
      );
      // Credit sales bill the customer's account rather than being settled by a
      // receipt, so they must not share an invoice with cash/card sales.
      const key = `${businessDay}|${customerType}|${isCredit ? 'CREDIT' : 'CASH'}`;
      const list = buckets.get(key);
      if (list) list.push(order);
      else buckets.set(key, [order]);
    }

    const groups: DailyInvoiceGroup[] = [];
    for (const [key, groupOrders] of buckets) {
      const group = await this.buildGroup(
        key,
        groupOrders,
        storeConfig,
        region,
        businessDay,
      );
      if (group) groups.push(group);
    }
    return groups;
  }

  /** Paid, not cancelled, not a refund (refunds go down the credit-memo path). */
  private isInvoiceable(order: BackupOdooOrder): boolean {
    const state = (order.state ?? '').toLowerCase().trim();
    if (NON_INVOICEABLE_STATES.has(state)) return false;
    const total = toSafeNumber(order.amountTotal ?? 0);
    return total >= 0;
  }

  private async buildGroup(
    groupKey: string,
    orders: BackupOdooOrder[],
    storeConfig: StoreConfiguration,
    region: string,
    businessDay: string,
  ): Promise<DailyInvoiceGroup | null> {
    const [, customerType, creditFlag] = groupKey.split('|');
    const isCredit = creditFlag === 'CREDIT';
    const first = orders[0];

    const salesMeta = await this.transformation.resolveBillToForAggregate(
      customerType,
      region,
      storeConfig.branchName,
    );
    if (!salesMeta) {
      throw new Error(
        `No FusionSalesMetadata bill-to match for branch ${storeConfig.branchCode} ` +
          `(name="${storeConfig.branchName}", type=${customerType}, region=${region}) ` +
          `— cannot aggregate ${businessDay}.`,
      );
    }

    const buMap = await this.businessUnitMapRepo.findOne({ where: { region } });
    const uomCodes = await this.loadUomCodes(region);
    // VAT rate for this region (folded into each line's unit price below so the
    // Oracle invoice total is tax-inclusive). 0 when no rate is configured.
    const vatRate = await this.resolveRegionVatRate(region);
    // Subinventory that stock is issued from — the store's metadata value, e.g.
    // "RYDAVNUMAL". Absent → inventory relief is skipped for the whole group.
    const subinventory = salesMeta.subinventory?.trim() || null;
    const inventoryPlans: InventoryTransactionPlan[] = [];
    // The legacy system stamps the group with the first sale's timestamp; keep
    // that so TrxDate/GlDate land inside the business day being posted.
    const saleDate =
      first.dateOrder instanceof Date
        ? first.dateOrder
        : new Date(String(first.dateOrder ?? new Date()));

    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: salesMeta.billToName,
      billToLocation: salesMeta.siteNumber ?? '',
      billToAccountNumber: String(
        bigIntToNumber(salesMeta.billToAccount, 'billToAccount'),
      ),
      // Java parity: BUSINESS_UNIT / TXN_SOURCE / TXN_TYPE come from the
      // store's FUSION_SALES_METADATA row, not the StoreConfiguration — a stale
      // config would otherwise send the invoice to the wrong BU (e.g. an AED
      // invoice on the Bahrain BU → AR_EXCHG_RATE_NOT_NULL).
      businessUnit: salesMeta.businessUnit || storeConfig.oracleBusinessUnit,
      outletName:
        first.warehouseName ?? first.branchName ?? storeConfig.branchName,
      saleDate,
      trxDate: saleDate,
      paymentTermsName: storeConfig.paymentTermsName,
      transactionSource: salesMeta.txnSource || storeConfig.transactionSource,
      transactionType: salesMeta.txnType || storeConfig.transactionType,
      invoiceCurrencyCode: storeConfig.invoiceCurrencyCode,
      conversionRateType: 'Corporate',
      conversionRate: 1,
      conversionDate: saleDate,
      purchaseOrder: undefined,
      soldToCustomerName: undefined,
      billToContact: undefined,
      invoiceLines: [],
    };

    // ── Lines: one per source order line, skipping anything already posted ────
    const posted = await this.loadPostedLines(orders, region);
    let alreadyPostedLines = 0;
    let existingTransactionNumber: string | null = null;
    const sourceOrderNumbers: string[] = [];
    const sourceOdooOrderIds: string[] = [];

    // Only orders that actually contribute a line may contribute a payment —
    // otherwise re-running a day would re-receipt orders whose lines were
    // already posted, over-paying the new invoice.
    const contributingOrders: BackupOdooOrder[] = [];

    // Oracle rejects an entire invoice when any line names an unknown item
    // (AR_INVALID_INVENTORY_ITEM). Under aggregation that would cost a whole
    // branch-day, so hold just the offending orders back and let the rest post.
    // The check is scoped to the branch's inventory organization when it can be
    // resolved — an item can exist in the master org yet not be assigned to the
    // region's org (e.g. KW), and AR still rejects it.
    let branchOrgId: number | null = null;
    try {
      branchOrgId = await this.oracleClient.resolveSubinventoryOrgId(
        storeConfig.branchName,
      );
    } catch {
      branchOrgId = null; // lookup outage → fall back to the global item check
    }
    const { excludedOrders, excludedOrderNumbers } =
      await this.excludeOrdersWithUnknownItems(orders, branchOrgId);

    for (const order of orders) {
      const orderNumber = order.orderName ?? String(order.orderId);
      if (excludedOrderNumbers.has(orderNumber)) continue;
      sourceOrderNumbers.push(orderNumber);
      sourceOdooOrderIds.push(String(order.orderId));
      const linesBefore = invoiceHeader.invoiceLines.length;

      const lines = [...(order.orderLines ?? [])].sort(
        (a, b) => (a.lineId ?? 0) - (b.lineId ?? 0),
      );
      let fallbackLineNo = 0;
      for (const line of lines) {
        const qty = Number(line.qty ?? 1);
        if (qty === 0) continue; // legacy rule: zero-quantity lines never post

        fallbackLineNo += 1;
        const sourceLineNo = line.lineId ?? fallbackLineNo;

        const itemNumber = line.productCode?.trim();
        const uomCode = itemNumber ? (uomCodes.get(itemNumber) ?? null) : null;

        // Plan the inventory issue for EVERY line that names a real item —
        // even lines whose invoice was already posted. Inventory is deduped
        // per line at post time (sourceLineRef), so this never double-pushes,
        // but it does mean an interrupted run that posted the invoice but not
        // the inventory can still relieve stock on retry (no stranded stock).
        // One issue per line — never aggregated by item.
        if (itemNumber && uomCode && subinventory && qty > 0) {
          inventoryPlans.push({
            itemNumber,
            subinventoryCode: subinventory,
            quantity: qty,
            uomCode,
            transactionDate: saleDate,
            salesOrder: orderNumber,
            salesOrderLine: sourceLineNo,
          });
        }

        const priorInvoice = posted.get(`${orderNumber}|${sourceLineNo}`);
        if (priorInvoice) {
          // Invoice line already posted — don't re-add it to the invoice
          // header, but its inventory plan (above) still stands for retry.
          alreadyPostedLines += 1;
          existingTransactionNumber ??= priorInvoice;
          continue;
        }

        invoiceHeader.invoiceLines.push(
          this.buildLine(
            line,
            orderNumber,
            sourceLineNo,
            invoiceHeader.invoiceLines.length + 1,
            invoiceHeader.invoiceCurrencyCode,
            uomCode,
            vatRate,
          ),
        );
      }

      if (invoiceHeader.invoiceLines.length > linesBefore) {
        contributingOrders.push(order);
      }
    }

    // Every line was posted by an earlier run. The invoice must NOT be created
    // again — but its receipts and journals may still be missing if the previous
    // run died between the invoice and the receipt calls. Rebuild the group
    // against the existing transaction number so those can be retried; each
    // object is guarded individually before it is posted (as the Java does),
    // rather than short-circuiting the whole day on the invoice alone.
    const postInvoice = invoiceHeader.invoiceLines.length > 0;
    if (!postInvoice) {
      if (!existingTransactionNumber) {
        this.logger.log(
          `[${storeConfig.branchCode} ${businessDay}] group ${groupKey} has no ` +
            `postable lines and no prior transaction — skipping`,
        );
        return null;
      }
      this.logger.log(
        `[${storeConfig.branchCode} ${businessDay}] group ${groupKey} invoice ` +
          `${existingTransactionNumber} already posted (${alreadyPostedLines} lines) — ` +
          `re-checking its receipts and journals`,
      );
      // Receipts belong to the orders that produced the existing invoice.
      contributingOrders.push(...orders);
    }

    // Service-provider (delivery-platform) groups post ONLY the invoice + the
    // commission journal — no receipts. The platform settles the receivable
    // later, so there is no till receipt to record (per requirement). A NORMAL
    // retail group is settled at the till and does get its receipts.
    const providerNames =
      await this.transformation.getServiceProviderNames(region);
    const isServiceProviderGroup = providerNames.has(
      customerType.toUpperCase(),
    );

    const { standardReceipts, miscReceipts, applyReceipts } =
      isServiceProviderGroup
        ? { standardReceipts: [], miscReceipts: [], applyReceipts: [] }
        : await this.buildAggregatedReceipts(
            contributingOrders,
            storeConfig,
            region,
            invoiceHeader,
            salesMeta,
            buMap,
            saleDate,
            isCredit,
          );

    const journalHeaders =
      await this.transformation.buildJournalHeadersForAggregate(
        customerType,
        region,
        storeConfig.branchName,
        storeConfig.branchCode,
        invoiceHeader,
        saleDate,
        TXN_PLACEHOLDER,
      );

    return {
      groupKey: `${storeConfig.branchCode}|${groupKey}`,
      branchCode: storeConfig.branchCode,
      branchName: storeConfig.branchName ?? null,
      region,
      businessDay,
      customerType,
      isCredit,
      sourceOrderNumbers,
      sourceOdooOrderIds,
      contributingOdooOrderIds: contributingOrders.map((o) =>
        String(o.orderId),
      ),
      alreadyPostedLines,
      existingTransactionNumber,
      postInvoice,
      excludedOrders,
      invoiceHeader,
      standardReceipts,
      miscReceipts,
      applyReceipts,
      journalHeaders,
      inventoryTransactions: inventoryPlans,
    };
  }

  /**
   * Checks every distinct item number in the group against Oracle once, then
   * holds back any order that references one Oracle does not know.
   *
   * The old per-order pipeline did this per order; under aggregation it matters
   * far more, because without it a single bad SKU fails the whole branch-day.
   * Lines carrying no item number are not checked — they post as description-only
   * lines, exactly as before.
   */
  private async excludeOrdersWithUnknownItems(
    orders: BackupOdooOrder[],
    organizationId: number | null = null,
  ): Promise<{
    excludedOrders: Array<{ orderNumber: string; reason: string }>;
    excludedOrderNumbers: Set<string>;
  }> {
    const excludedOrders: Array<{ orderNumber: string; reason: string }> = [];
    const excludedOrderNumbers = new Set<string>();

    const itemNumbers = new Set<string>();
    for (const order of orders) {
      for (const line of order.orderLines ?? []) {
        const item = line.productCode?.trim();
        if (item) itemNumbers.add(item);
      }
    }
    const missing = new Set<string>();
    for (const item of itemNumbers) {
      try {
        if (!(await this.oracleClient.itemExists(item, organizationId)))
          missing.add(item);
      } catch (err) {
        // A lookup outage must not silently drop the day's sales — let the order
        // through and allow Oracle itself to accept or reject the line.
        this.logger.warn(
          `Item existence check failed for "${item}": ${
            err instanceof Error ? err.message : String(err)
          } — treating as present`,
        );
      }
    }
    for (const order of orders) {
      const orderNumber = order.orderName ?? String(order.orderId);
      const reasons: string[] = [];

      const bad = (order.orderLines ?? [])
        .map((l) => l.productCode?.trim())
        .filter((i): i is string => !!i && missing.has(i));
      if (bad.length > 0) {
        reasons.push(`item(s) not in Oracle: ${[...new Set(bad)].join(', ')}`);
      }

      // A non-discount line with no item code cannot post: Oracle AR requires
      // an item or a memo line, and inventing one from the Odoo product id is
      // exactly what produced AR_INVALID_INVENTORY_ITEM.
      const codeless = (order.orderLines ?? []).filter(
        (l) =>
          Number(l.qty ?? 1) !== 0 &&
          !l.productCode?.trim() &&
          !this.isDiscountLine(l),
      );
      if (codeless.length > 0) {
        reasons.push(
          `${codeless.length} line(s) have no item code (product id ` +
            `${codeless.map((l) => l.productId).join(', ')}) and are not discounts`,
        );
      }

      if (reasons.length === 0) continue;
      const reason = `${reasons.join('; ')} — order held back so the rest of the day can post`;
      excludedOrders.push({ orderNumber, reason });
      excludedOrderNumbers.add(orderNumber);
      this.logger.warn(`[${orderNumber}] ${reason}`);
    }
    return { excludedOrders, excludedOrderNumbers };
  }

  /**
   * Loads `(salesOrder, salesOrderLine) → invoiceNumber` for lines this group's
   * orders already posted successfully. This is the durable idempotency guard:
   * re-running a day re-posts only what is genuinely missing.
   */
  private async loadPostedLines(
    orders: BackupOdooOrder[],
    region: string,
  ): Promise<Map<string, string>> {
    const orderNumbers = orders.map((o) => o.orderName ?? String(o.orderId));
    if (orderNumbers.length === 0) return new Map();

    const rows = await this.invoiceLineRepo.find({
      where: {
        salesOrder: In(orderNumbers),
        region,
        status: In(['SUCCESS', 'S']),
      },
      select: {
        salesOrder: true,
        salesOrderLine: true,
        invoiceNumber: true,
      },
    });

    const map = new Map<string, string>();
    for (const row of rows) {
      if (!row.salesOrder || row.salesOrderLine == null) continue;
      if (!row.invoiceNumber) continue;
      map.set(`${row.salesOrder}|${row.salesOrderLine}`, row.invoiceNumber);
    }
    return map;
  }

  /**
   * Builds a `productCode → Oracle UOM code` map from the imported item master
   * (VendHqItemMeta). Its `uomCode` column holds the valid short Oracle codes
   * ("Ea", "G"), unlike the Odoo line's display name.
   *
   * A unit of measure is intrinsic to the item, not the region — but the source
   * data is region-inconsistent (a SKU can be "Ea" in one region and null in
   * another). So we prefer this region's code and fall back to any region's
   * non-null code for the same SKU. Without this fallback, inventory relief and
   * the line UomCode silently drop for items the source left blank in-region.
   */
  private async loadUomCodes(region: string): Promise<Map<string, string>> {
    const rows = await this.itemMetaRepo.find({
      select: { sku: true, uomCode: true, region: true },
    });
    const inRegion = new Map<string, string>();
    const anyRegion = new Map<string, string>();
    for (const r of rows) {
      const sku = r.sku?.trim();
      const code = r.uomCode?.trim();
      if (!sku || !code) continue;
      if (r.region === region) inRegion.set(sku, code);
      else if (!anyRegion.has(sku)) anyRegion.set(sku, code);
    }
    // Region-specific wins; fall back to any region's code for the same SKU.
    for (const [sku, code] of anyRegion) {
      if (!inRegion.has(sku)) inRegion.set(sku, code);
    }
    return inRegion;
  }

  /**
   * A line is a discount/promotion when the legacy product name says so, or
   * when it has no product code and a negative amount (Odoo POS promotions,
   * e.g. "100% on your order"). Discount lines post as the 'Discount Item'
   * memo line and never carry an ItemNumber.
   */
  private isDiscountLine(line: {
    qty: number | null;
    priceUnit: number | null;
    priceSubtotal: number | null;
    priceSubtotalIncl: number | null;
    productName: string | null;
    productCode: string | null;
  }): boolean {
    if ((line.productName ?? '') === 'Discount Item') return true;
    if (line.productCode?.trim()) return false;
    const qty = Number(line.qty ?? 1);
    const total =
      line.priceSubtotalIncl != null
        ? toSafeNumber(line.priceSubtotalIncl)
        : line.priceSubtotal != null
          ? toSafeNumber(line.priceSubtotal)
          : toSafeNumber(line.priceUnit ?? 0) * qty;
    return total < 0;
  }

  private buildLine(
    line: {
      qty: number | null;
      priceUnit: number | null;
      priceSubtotal: number | null;
      priceSubtotalIncl: number | null;
      productName: string | null;
      productCode: string | null;
      productId: number | null;
      lineName?: string | null;
      taxName: string | null;
      productUomName: string | null;
    },
    salesOrder: string,
    salesOrderLine: number,
    lineNumber: number,
    currencyCode: string,
    uomCode: string | null,
    vatRate = 0,
  ): InvoiceLine {
    let qty = Number(line.qty ?? 1);
    const total =
      line.priceSubtotalIncl != null
        ? toSafeNumber(line.priceSubtotalIncl)
        : line.priceSubtotal != null
          ? toSafeNumber(line.priceSubtotal)
          : toSafeNumber(line.priceUnit ?? 0) * qty;

    // Sign lives in the quantity, never in the unit price (legacy parity) —
    // a negative line (discount / promotion) posts as negative quantity.
    const baseUnitPrice =
      line.priceUnit != null
        ? Math.abs(toSafeNumber(line.priceUnit))
        : qty !== 0
          ? Math.abs(total / qty)
          : 0;
    if (total < 0 && qty > 0) qty = -qty;

    // Fold the region VAT into the unit price so the Oracle invoice total is
    // tax-inclusive (operator choice: middleware computes tax, one rate per
    // region). Odoo priceUnit is ex-tax, so this never double-counts. Rounded to
    // 4dp to avoid float noise while keeping the qty×price total accurate.
    const unitPrice =
      vatRate > 0
        ? Math.round(baseUnitPrice * (1 + vatRate) * 10000) / 10000
        : baseUnitPrice;

    const productName = line.productName ?? '';
    // Discount/promotion lines: the legacy feed names the product
    // 'Discount Item'; Odoo POS promotions carry no product code and a
    // negative amount with the promo text in lineName ("100% on your order").
    // Both map to the AR memo line — an ItemNumber must NEVER be invented from
    // the Odoo product id, which Oracle rejects with AR_INVALID_INVENTORY_ITEM.
    const isDiscount = this.isDiscountLine(line);

    return {
      lineNumber,
      itemNumber: !isDiscount ? (line.productCode ?? undefined) : undefined,
      memoLineName: isDiscount ? 'Discount Item' : undefined,
      description:
        productName ||
        line.lineName ||
        (isDiscount ? 'Discount' : `POS product ${line.productId ?? ''}`),
      quantity: isDiscount && total > 0 ? 1 : qty,
      // A valid short Oracle UOM code resolved from the item master (e.g. "Ea",
      // "G") — NOT the Odoo display name "Gram", which Oracle rejects as too
      // long. Omitted when unknown so Oracle falls back to the item's own UOM.
      uomCode: uomCode ?? undefined,
      unitSellingPrice: unitPrice,
      currencyCode,
      salesOrder,
      salesOrderLine: String(salesOrderLine),
      // taxClassificationCode is intentionally NOT set from the raw Odoo tax
      // name: an unrecognised code makes Oracle reject the whole invoice, and
      // the bill-to customer/site already carries the correct default VAT. A
      // per-line tax code would need a validated Odoo-tax → Oracle-code map.
    };
  }

  /**
   * Sums every payment in the group into one receipt per
   * (payment method, register), rather than one receipt per order.
   *
   * Unlike the reference implementation the register is part of the key: an
   * outlet with two registers previously had all of its receipts remitted to
   * whichever register happened to appear on the first sale of the day.
   */
  private async buildAggregatedReceipts(
    orders: BackupOdooOrder[],
    storeConfig: StoreConfiguration,
    region: string,
    invoiceHeader: InvoiceHeader,
    salesMeta: {
      recActivityNameBank: string | null;
      recActivityNameCash: string | null;
    },
    buMap: FusionBusinessUnitMap | null,
    saleDate: Date,
    isCredit: boolean,
  ): Promise<{
    standardReceipts: StandardReceiptRequest[];
    miscReceipts: MiscReceiptRequest[];
    applyReceipts: ApplyReceiptRequest[];
  }> {
    const standardReceipts: StandardReceiptRequest[] = [];
    const miscReceipts: MiscReceiptRequest[] = [];

    // Credit sales are settled against the customer account, not by a receipt.
    if (isCredit) {
      return { standardReceipts, miscReceipts, applyReceipts: [] };
    }

    const customerAccountId =
      await this.transformation.resolveCustomerAccountForAggregate(
        invoiceHeader.billToAccountNumber,
        region,
      );
    const orgId = bigIntToNumber(buMap?.businessUnitId ?? 0n, 'businessUnitId');
    const buckets = new Map<string, ReceiptBucket>();

    for (const order of orders) {
      const registerName =
        order.posConfigName ?? order.branchName ?? storeConfig.branchName;
      const register = await this.transformation.resolveRegisterForAggregate(
        registerName,
        storeConfig.branchName,
        region,
      );

      for (const payment of order.orderPayments ?? []) {
        const rawMethod = (payment.paymentName ?? '').trim();
        if (!rawMethod || rawMethod.toLowerCase() === 'credit on cust')
          continue;

        const isRounding = rawMethod.toLowerCase() === 'cash rounding';
        // Java parity: a cash-rounding payment is folded into the "Cash"
        // standard receipt (both share the same Oracle receipt-method id), while
        // still producing the negative misc adjustment below. Look up the
        // rounding method's own config, but bucket it under Cash so the physical
        // cash receipt reflects what was actually collected.
        const method = isRounding ? 'Cash' : rawMethod;

        const receiptMethod = await this.receiptMethodRepo.findOne({
          where: { receiptMethodName: rawMethod, region },
        });
        if (!receiptMethod) {
          this.logger.warn(
            `Receipt method not configured: "${rawMethod}" (region=${region}) — payment skipped`,
          );
          continue;
        }

        const isCash = receiptMethod.receiptIsCash;
        const accountId = isCash
          ? (register?.cashAccountId ?? storeConfig.cashAccountId ?? null)
          : (register?.bankAccountId ?? storeConfig.bankAccountId ?? null);

        const registerKey = register?.registerName ?? storeConfig.branchName;
        const key = `${method}|${registerKey}`;
        const amount = toSafeNumber(payment.amount ?? 0);

        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            paymentMethod: method,
            receiptMethodId: bigIntToNumber(
              receiptMethod.receiptMethodId,
              'receiptMethodId',
            ),
            isCash,
            registerKey,
            accountId: accountId == null ? null : Number(accountId),
            bankAccountName:
              register?.bankAccount ?? storeConfig.bankAccountName ?? null,
            cashAccountName:
              register?.cashAccount ?? storeConfig.cashAccountName ?? null,
            amount: 0,
            bankChargeAmount: 0,
            cashRoundingAmount: 0,
          };
          buckets.set(key, bucket);
        }

        if (isRounding) {
          // Fold into the Cash standard receipt AND record the rounding for the
          // negative misc adjustment emitted below.
          bucket.amount += amount;
          bucket.cashRoundingAmount += amount;
          continue;
        }

        bucket.amount += amount;

        if (!isCash) {
          let charge =
            amount *
            receiptMethod.receiptBankCharge *
            (1 + receiptMethod.receiptMethodTax);
          if (method === 'Debit Card' && region === 'OM' && charge > 10) {
            charge = 10;
          }
          bucket.bankChargeAmount += charge;
        }
      }
    }

    for (const bucket of buckets.values()) {
      // Java parity: the standard receipt is NET of the bank charge — the bank
      // credits gross − charge, and the charge itself is booked by the negative
      // misc receipt below. A receipt that nets to ≤ 0 is skipped (reference
      // behaviour), leaving only its misc adjustment.
      const netAmount = this.round2(bucket.amount - bucket.bankChargeAmount);
      if (bucket.amount !== 0 && netAmount <= 0) {
        this.logger.warn(
          `[${storeConfig.branchCode}] ${bucket.paymentMethod} receipts net to ` +
            `${netAmount} after bank charges (gross ${this.round2(bucket.amount)}, ` +
            `charge ${this.round2(bucket.bankChargeAmount)}) — standard receipt skipped.`,
        );
      }
      if (netAmount > 0) {
        if (bucket.accountId == null) {
          throw new Error(
            `Bank/cash account for register "${bucket.registerKey}" ` +
              `(branch ${storeConfig.branchCode}, region ${region}) is not entered in ` +
              `VendHqRegister — cannot create receipt for "${bucket.paymentMethod}".`,
          );
        }
        if (customerAccountId == null) {
          throw new Error(
            `No Oracle customer account id mapped for account ` +
              `"${invoiceHeader.billToAccountNumber}" (${invoiceHeader.billToCustomerName}, ` +
              `region ${region}) — seed FusionCustomerAccount via admin oracle-import.`,
          );
        }
        standardReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: bucket.receiptMethodId,
          receiptNumber: `${bucket.paymentMethod}-${TXN_PLACEHOLDER}`,
          remittanceBankAccountId: bucket.accountId,
          accountValue: invoiceHeader.billToAccountNumber,
          customerId: customerAccountId,
          orgId,
          receiptAmount: netAmount,
        });
      }

      if (bucket.bankChargeAmount !== 0) {
        miscReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: bucket.receiptMethodId,
          receiptMethodName: bucket.paymentMethod,
          receiptNumber: `${bucket.paymentMethod}-${TXN_PLACEHOLDER}-MISC`,
          bankAccountName: bucket.bankAccountName ?? '',
          receivableActivityName:
            salesMeta.recActivityNameBank ?? 'Bank Charges',
          orgId,
          receiptAmount: -this.round2(bucket.bankChargeAmount),
        });
      }

      if (bucket.cashRoundingAmount !== 0) {
        miscReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: bucket.receiptMethodId,
          receiptMethodName: bucket.paymentMethod,
          receiptNumber: `${bucket.paymentMethod}-${TXN_PLACEHOLDER}-MISC`,
          bankAccountName: bucket.cashAccountName ?? '',
          receivableActivityName:
            salesMeta.recActivityNameCash ?? 'Cash Rounding',
          orgId,
          receiptAmount: -this.round2(bucket.cashRoundingAmount),
        });
      }
    }

    // ── Apply receipts ───────────────────────────────────────────────────────
    // The reference retried a failed application 50 times, subtracting 0.01 each
    // attempt, to grope for the rounding delta. Compute it instead.
    //
    // The comparison must use the TAX-INCLUSIVE total: invoice lines carry
    // ex-tax unit prices and Oracle derives tax from each line's classification
    // code, so summing the lines understates what the customer actually owes and
    // would trim a perfectly valid payment. The source orders' amountTotal is
    // already tax-inclusive and is what the customer paid.
    const invoiceTotal = this.round2(
      orders.reduce((sum, o) => sum + toSafeNumber(o.amountTotal ?? 0), 0),
    );
    const receiptTotal = this.round2(
      standardReceipts.reduce((sum, r) => sum + r.receiptAmount, 0),
    );
    let overApplied = this.round2(Math.max(0, receiptTotal - invoiceTotal));
    if (overApplied > 0) {
      this.logger.warn(
        `[${storeConfig.branchCode}] receipts total ${receiptTotal} exceed invoice ` +
          `total ${invoiceTotal} by ${overApplied} — trimming the application ` +
          `(rounding/discount difference).`,
      );
    }

    const applyReceipts: ApplyReceiptRequest[] = [];
    for (const sr of standardReceipts) {
      let applied = sr.receiptAmount;
      if (overApplied > 0) {
        const trim = Math.min(overApplied, applied);
        applied = this.round2(applied - trim);
        overApplied = this.round2(overApplied - trim);
      }
      if (applied <= 0) continue;
      applyReceipts.push({
        receiptDate: saleDate,
        transactionNumber: TXN_PLACEHOLDER,
        receiptNumber: sr.receiptNumber,
        amountApplied: applied,
        receiptCurrency: sr.currencyCode,
        transactionSource: invoiceHeader.transactionSource,
      });
    }

    return { standardReceipts, miscReceipts, applyReceipts };
  }

  private round2(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  /**
   * Rewrites the placeholder in every receipt/journal reference once Oracle has
   * issued the real transaction number.
   */
  stampTransactionNumber(group: DailyInvoiceGroup, txnNumber: string): void {
    const swap = (value: string) =>
      value.split(TXN_PLACEHOLDER).join(txnNumber);

    for (const r of group.standardReceipts)
      r.receiptNumber = swap(r.receiptNumber);
    for (const r of group.miscReceipts) r.receiptNumber = swap(r.receiptNumber);
    for (const r of group.applyReceipts) {
      r.receiptNumber = swap(r.receiptNumber);
      r.transactionNumber = swap(r.transactionNumber);
    }
    for (const jh of group.journalHeaders) {
      jh.batchName = swap(jh.batchName);
      if (jh.batchDescription) jh.batchDescription = swap(jh.batchDescription);
    }
  }
}
