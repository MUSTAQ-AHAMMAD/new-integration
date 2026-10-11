/**
 * ReconciliationService — end-to-end, order-traceable reconciliation of Odoo
 * sales against what the integration actually posted to Oracle Fusion.
 *
 * Grain: store × store-local business day — the SAME day window the daily
 * invoice aggregation uses (region IANA timezone), so a figure here lines up
 * one-to-one with the invoice Oracle received for that store/day.
 *
 * Every Oracle figure is traced back to Odoo through the keys the integration
 * persists, never by date guessing:
 *   invoice        FusionInvoiceLine.salesOrder  = Odoo order name
 *   receipts       receiptNumber "<method>-<invoiceTxn>[-MISC]" → invoice
 *   credit memos   RefundTracking.refundOrderNumber = Odoo refund order name
 *   inventory      FusionInvTxn.txnSourceName    = Odoo order name
 *
 * Checks per store/day (expected from Odoo ↔ posted in Oracle):
 *   invoice net      Σ amountUntaxed of sales orders  ↔ Σ invoice totalAmount
 *   orders invoiced  sales orders                     ↔ orders with a posted line
 *   receipts         Σ till payments (no provider /    ↔ Σ standard − Σ misc
 *                    credit-on-account)                  (std is net of bank
 *                                                        charges, misc = −charge)
 *   credit memos     Σ |refund amountTotal|           ↔ Σ synced credit memos
 *   inventory        −Σ line qty (items only)         ↔ Σ posted txnQty
 *
 * Read-only. Never writes.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { BackupOdooOrderPayment } from '../database/entities/backup-odoo-order-payment.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionInvTxn } from '../database/entities/fusion-inv-txn.entity';
import { FusionMiscReceipt } from '../database/entities/fusion-misc-receipt.entity';
import { FusionStandardReceipt } from '../database/entities/fusion-standard-receipt.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { SyncStatus } from '../database/enums';
import { OdooBackupService } from '../odoo-backup/odoo-backup.service';
import {
  DailyAggregationService,
  NON_INVOICEABLE_STATES,
} from './daily-aggregation.service';
import { OdooTransformationService } from './odoo-transformation.service';

/** Longest range one request may reconcile. */
const MAX_DAYS = 31;
/** Amount tolerance (currency units) before a difference counts as a variance. */
const AMOUNT_TOLERANCE = 0.1;
/** Quantity tolerance for inventory. */
const QTY_TOLERANCE = 0.0001;
/** Cap on order-level exception rows returned. */
const MAX_EXCEPTIONS = 5000;
/** Oracle IN-list limit. */
const CHUNK = 900;

const UNMAPPED = '__UNMAPPED__';

export type DayStatus = 'MATCHED' | 'VARIANCE' | 'NOT_POSTED' | 'NO_ACTIVITY';

export type ExceptionType =
  | 'UNMAPPED_BRANCH'
  | 'NOT_INVOICED'
  | 'CREDIT_MEMO_MISSING'
  | 'CREDIT_MEMO_PENDING'
  | 'CREDIT_MEMO_FAILED'
  | 'INVENTORY_NEGATIVE'
  | 'INVENTORY_ERROR'
  | 'INVENTORY_NOT_POSTED'
  | 'INVENTORY_QTY_MISMATCH'
  | 'INVOICE_FAILED';

export interface ReconExpected {
  orders: number;
  salesOrders: number;
  refundOrders: number;
  excludedOrders: number;
  excludedAmount: number;
  /** Σ amountTotal of sales orders (tax-inclusive). */
  salesGross: number;
  /** Σ amountUntaxed of sales orders — what the invoice should total. */
  salesNet: number;
  salesTax: number;
  /** Σ |amountTotal| of refund orders — what credit memos should total. */
  refundGross: number;
  /** Σ payments on sales orders (all methods). */
  payments: number;
  /** Payments that should become till receipts (no provider / credit). */
  expectedReceipts: number;
  /** Payments settled by a service provider (no receipt by design). */
  providerPayments: number;
  /** Credit-on-account payments (no receipt by design). */
  creditPayments: number;
  /**
   * What the invoice lines are priced at (|priceUnit| × qty — the integration's
   * pricing rule). Differs from salesNet when line discounts / tax-inclusive
   * prices aren't reflected in priceUnit.
   */
  invoiceBasis: number;
  /** Net inventory quantity Oracle should move (sales −, refunds +). */
  inventoryQty: number;
}

export interface ReconPosted {
  invoiceNumbers: string[];
  invoicedOrders: number;
  invoiceNet: number;
  receiptsStandard: number;
  /** Σ bank-charge misc receipts (negative). */
  receiptsMisc: number;
  /** Σ cash-rounding misc receipts (negative) — not part of the payment check. */
  receiptsRounding: number;
  /** standard − bank-charge misc ⇒ comparable to the till payments. */
  receiptsGross: number;
  creditMemos: number;
  creditMemoAmount: number;
  inventoryQty: number;
  inventoryHeld: number;
  inventoryErrors: number;
}

export interface ReconVariance {
  invoiceNet: number;
  ordersNotInvoiced: number;
  receipts: number;
  creditMemos: number;
  inventoryQty: number;
  /** invoiceBasis − salesNet: pricing gap baked into the invoice lines. */
  pricingGap: number;
}

export interface ReconStoreDay {
  branchCode: string;
  branchName: string;
  isActive: boolean;
  businessDay: string;
  currency: string | null;
  status: DayStatus;
  issues: string[];
  expected: ReconExpected;
  posted: ReconPosted;
  variance: ReconVariance;
}

export interface ReconException {
  type: ExceptionType;
  branchCode: string;
  branchName: string;
  businessDay: string;
  orderName: string | null;
  amount: number | null;
  quantity: number | null;
  detail: string;
}

export interface ReconciliationReport {
  region: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  windowUtc: { start: string; end: string };
  generatedAt: string;
  tolerance: { amount: number; quantity: number };
  totals: {
    expected: ReconExpected;
    posted: ReconPosted;
    variance: ReconVariance;
    storeDays: Record<DayStatus, number>;
  };
  rows: ReconStoreDay[];
  exceptions: ReconException[];
  exceptionCounts: Partial<Record<ExceptionType, number>>;
  exceptionsTruncated: boolean;
  notes: string[];
}

export interface OdooVsBackupReport {
  region: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  apiReachable: boolean;
  apiComplete: boolean;
  error: string | null;
  fetchedFromApi: number;
  days: Array<{
    businessDay: string;
    apiOrders: number;
    storedOrders: number;
    apiAmount: number;
    storedAmount: number;
    missingInBackup: number;
    notInOdoo: number;
    mismatched: number;
  }>;
  totals: {
    apiOrders: number;
    storedOrders: number;
    apiAmount: number;
    storedAmount: number;
    missingInBackup: number;
    notInOdoo: number;
    mismatched: number;
  };
  differences: Array<{
    type:
      | 'MISSING_IN_BACKUP'
      | 'STORED_UNDER_OTHER_DAY'
      | 'NOT_IN_ODOO'
      | 'AMOUNT_MISMATCH'
      | 'STATE_MISMATCH'
      | 'LINES_MISMATCH'
      | 'PAYMENTS_MISMATCH';
    odooOrderId: number;
    orderName: string | null;
    businessDay: string | null;
    branch: string | null;
    odoo: string;
    stored: string;
  }>;
  differencesTruncated: boolean;
  notes: string[];
}

interface OrderFacts {
  order: BackupOdooOrder;
  store: string;
  day: string;
  kind: 'SALE' | 'REFUND' | 'EXCLUDED';
  payments: Array<{ name: string; amount: number }>;
  invoiceBasis: number;
  inventoryQty: number;
  lineCount: number;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly aggregation: DailyAggregationService,
    private readonly transformation: OdooTransformationService,
    private readonly odooBackup: OdooBackupService,
    @InjectRepository(StoreConfiguration)
    private readonly storeRepo: Repository<StoreConfiguration>,
    @InjectRepository(BackupOdooOrder)
    private readonly orderRepo: Repository<BackupOdooOrder>,
    @InjectRepository(BackupOdooOrderLine)
    private readonly lineRepo: Repository<BackupOdooOrderLine>,
    @InjectRepository(BackupOdooOrderPayment)
    private readonly paymentRepo: Repository<BackupOdooOrderPayment>,
    @InjectRepository(FusionInvoiceLine)
    private readonly invLineRepo: Repository<FusionInvoiceLine>,
    @InjectRepository(FusionInvoiceHeader)
    private readonly invHeaderRepo: Repository<FusionInvoiceHeader>,
    @InjectRepository(FusionStandardReceipt)
    private readonly stdRepo: Repository<FusionStandardReceipt>,
    @InjectRepository(FusionMiscReceipt)
    private readonly miscRepo: Repository<FusionMiscReceipt>,
    @InjectRepository(RefundTracking)
    private readonly refundRepo: Repository<RefundTracking>,
    @InjectRepository(FusionInvTxn)
    private readonly invTxnRepo: Repository<FusionInvTxn>,
    @InjectRepository(OdooCredential)
    private readonly credRepo: Repository<OdooCredential>,
  ) {}

  // ════════════════════════════════════════════════════════════════════════
  // Odoo → Oracle
  // ════════════════════════════════════════════════════════════════════════

  async reconcile(params: {
    region: string;
    startDate: string;
    endDate: string;
    branchCode?: string;
  }): Promise<ReconciliationReport> {
    const region = params.region.trim().toUpperCase();
    this.validateRange(params.startDate, params.endDate);
    const timeZone = this.aggregation.regionTimeZone(region);
    const days = this.dayList(params.startDate, params.endDate);
    const window = {
      start: this.aggregation.localDayWindow(params.startDate, timeZone).start,
      end: this.aggregation.localDayWindow(params.endDate, timeZone).end,
    };

    // ── Stores & orders ──────────────────────────────────────────────────────
    const allStores = await this.storeRepo.find({ where: { region } });
    const stores = params.branchCode
      ? allStores.filter((s) => s.branchCode === params.branchCode)
      : allStores;
    const orders = await this.loadOrders(region, stores, window);
    const providerNames =
      await this.transformation.getServiceProviderNames(region);

    const allFacts = await this.buildFacts(orders, stores, timeZone, days);
    // A single-store report must not list the rest of the region as unmapped.
    const facts = params.branchCode
      ? allFacts.filter((f) => f.store === params.branchCode)
      : allFacts;
    const names = [...new Set(facts.map((f) => this.orderName(f.order)))];

    // ── Oracle side, traced by the persisted keys ────────────────────────────
    const invoiceByOrder = await this.loadInvoiceLines(names, region);
    const invoiceNumbers = [
      ...new Set([...invoiceByOrder.values()].flatMap((s) => [...s])),
    ];
    const headers = await this.loadHeaders(invoiceNumbers, region);
    const receipts = await this.loadReceipts(invoiceNumbers, region);
    const refunds = await this.loadRefunds(
      facts
        .filter((f) => f.kind === 'REFUND')
        .map((f) => this.orderName(f.order)),
    );
    const inventory = await this.loadInventory(names, region);

    // ── Roll up per store/day ────────────────────────────────────────────────
    const storeMeta = new Map(
      stores.map((s) => [
        s.branchCode,
        {
          name: s.branchName,
          active: s.isActive,
          currency: s.invoiceCurrencyCode ?? null,
        },
      ]),
    );
    const rows = new Map<string, ReconStoreDay>();
    const rowFor = (store: string, day: string): ReconStoreDay => {
      const key = `${store}|${day}`;
      let row = rows.get(key);
      if (!row) {
        const meta = storeMeta.get(store);
        row = {
          branchCode: store,
          branchName:
            store === UNMAPPED ? 'Unmapped Odoo branch' : (meta?.name ?? store),
          isActive: meta?.active ?? false,
          businessDay: day,
          currency: meta?.currency ?? null,
          status: 'NO_ACTIVITY',
          issues: [],
          expected: this.emptyExpected(),
          posted: this.emptyPosted(),
          variance: this.emptyVariance(),
        };
        rows.set(key, row);
      }
      return row;
    };
    // Every configured store gets a row for every day, so a store with no
    // Odoo data shows as NO_ACTIVITY rather than silently disappearing.
    for (const s of stores) for (const d of days) rowFor(s.branchCode, d);

    const exceptions: ReconException[] = [];
    const exceptionCounts: Partial<Record<ExceptionType, number>> = {};
    const addException = (e: ReconException) => {
      exceptionCounts[e.type] = (exceptionCounts[e.type] ?? 0) + 1;
      if (exceptions.length < MAX_EXCEPTIONS) exceptions.push(e);
    };

    const invoiceDay = new Map<string, string>(); // txn → row key
    for (const f of facts) {
      const row = rowFor(f.store, f.day);
      const e = row.expected;
      const name = this.orderName(f.order);
      const total = this.num(f.order.amountTotal);
      e.orders += 1;

      if (f.kind === 'EXCLUDED') {
        e.excludedOrders += 1;
        e.excludedAmount += total;
        continue;
      }

      // Inventory applies to sales AND refunds.
      e.inventoryQty += f.inventoryQty;
      const inv = inventory.get(name) ?? [];
      const live = inv.filter((r) => r.status !== 'SUPERSEDED');
      const postedQty = live
        .filter((r) => r.status === 'SUCCESS')
        .reduce((s, r) => s + this.num(r.txnQty), 0);
      row.posted.inventoryQty += postedQty;
      for (const r of live) {
        if (r.status === 'NEGATIVE_INVENTORY') {
          row.posted.inventoryHeld += 1;
          addException({
            ...this.exBase(row, name),
            type: 'INVENTORY_NEGATIVE',
            quantity: this.num(r.txnQty),
            amount: null,
            detail: `${r.itemNumber ?? '?'} in ${r.subInventory ?? '?'}: ${r.holdReason ?? 'negative stock'}`,
          });
        } else if (r.status === 'ERROR') {
          row.posted.inventoryErrors += 1;
          addException({
            ...this.exBase(row, name),
            type: 'INVENTORY_ERROR',
            quantity: this.num(r.txnQty),
            amount: null,
            detail: `${r.itemNumber ?? '?'}: ${r.holdReason ?? this.firstLine(r.message) ?? 'error'}`,
          });
        }
      }
      if (f.inventoryQty !== 0 && live.length === 0) {
        addException({
          ...this.exBase(row, name),
          type: 'INVENTORY_NOT_POSTED',
          quantity: f.inventoryQty,
          amount: null,
          detail: 'No inventory transaction recorded for this order',
        });
      } else if (
        live.length > 0 &&
        live.every((r) => r.status === 'SUCCESS') &&
        Math.abs(postedQty - f.inventoryQty) > QTY_TOLERANCE
      ) {
        addException({
          ...this.exBase(row, name),
          type: 'INVENTORY_QTY_MISMATCH',
          quantity: this.round(f.inventoryQty - postedQty, 4),
          amount: null,
          detail: `Expected ${this.round(f.inventoryQty, 4)}, posted ${this.round(postedQty, 4)}`,
        });
      }

      if (f.kind === 'REFUND') {
        e.refundOrders += 1;
        e.refundGross += Math.abs(total);
        const refund = refunds.get(name);
        if (!refund) {
          addException({
            ...this.exBase(row, name),
            type: 'CREDIT_MEMO_MISSING',
            amount: Math.abs(total),
            quantity: null,
            detail: 'Refund not tracked — no credit memo will be created',
          });
        } else if (refund.creditMemoStatus === SyncStatus.SYNCED) {
          row.posted.creditMemos += 1;
          row.posted.creditMemoAmount += Math.abs(
            this.num(refund.refundAmount),
          );
        } else {
          const failed = refund.creditMemoStatus === SyncStatus.FAILED;
          addException({
            ...this.exBase(row, name),
            type: failed ? 'CREDIT_MEMO_FAILED' : 'CREDIT_MEMO_PENDING',
            amount: Math.abs(total),
            quantity: null,
            detail: failed
              ? `Credit memo failed: ${refund.failureReason ?? 'unknown reason'}`
              : `Credit memo status ${refund.creditMemoStatus}`,
          });
        }
        continue;
      }

      // ── Sale ──
      e.salesOrders += 1;
      e.salesGross += total;
      e.salesNet += this.num(f.order.amountUntaxed ?? total);
      e.salesTax += this.num(f.order.amountTax);
      e.invoiceBasis += f.invoiceBasis;

      const isProvider =
        this.transformation.deriveServiceProvider(f.order, providerNames) !=
        null;
      for (const p of f.payments) {
        e.payments += p.amount;
        if (isProvider) e.providerPayments += p.amount;
        else if (p.name.toLowerCase() === 'credit on cust')
          e.creditPayments += p.amount;
        else e.expectedReceipts += p.amount;
      }

      const txns = invoiceByOrder.get(name);
      if (txns && txns.size > 0) {
        row.posted.invoicedOrders += 1;
        for (const t of txns) {
          if (!invoiceDay.has(t)) invoiceDay.set(t, `${f.store}|${f.day}`);
        }
      } else {
        addException({
          ...this.exBase(row, name),
          type: 'NOT_INVOICED',
          amount: total,
          quantity: null,
          detail: !row.isActive
            ? 'Store is inactive in StoreConfiguration — never invoiced'
            : 'No invoice line posted (item unknown to Oracle, invoice failed, or day not run yet)',
        });
      }
    }

    // Unmapped branches: one exception per Odoo branch name.
    const unmapped = new Map<
      string,
      { count: number; amount: number; day: string }
    >();
    for (const f of facts.filter((x) => x.store === UNMAPPED)) {
      const key = f.order.branchName ?? String(f.order.branchId ?? '?');
      const u = unmapped.get(key) ?? { count: 0, amount: 0, day: f.day };
      u.count += 1;
      u.amount += this.num(f.order.amountTotal);
      unmapped.set(key, u);
    }
    for (const [branch, u] of unmapped) {
      addException({
        type: 'UNMAPPED_BRANCH',
        branchCode: UNMAPPED,
        branchName: branch,
        businessDay: u.day,
        orderName: null,
        amount: this.round(u.amount),
        quantity: null,
        detail: `${u.count} order(s) from Odoo branch "${branch}" match no StoreConfiguration — they are never integrated`,
      });
    }

    // Invoices & receipts → their store/day.
    for (const [txn, key] of invoiceDay) {
      const row = rows.get(key);
      if (!row) continue;
      const header = headers.get(txn);
      row.posted.invoiceNumbers.push(txn);
      if (header && header.status === 'SUCCESS') {
        row.posted.invoiceNet += this.num(header.totalAmount);
      }
      const r = receipts.get(txn);
      if (r) {
        row.posted.receiptsStandard += r.standard;
        row.posted.receiptsMisc += r.misc;
        row.posted.receiptsRounding += r.rounding;
      }
    }

    // Failed invoice attempts in the window (not traceable to orders — the
    // header is the only record), surfaced so a NOT_POSTED day has a reason.
    const failedHeaders = await this.invHeaderRepo.find({
      where: {
        region,
        status: 'ERROR',
        txnDate: Between(window.start, window.end),
      },
      select: {
        id: true,
        billToCustName: true,
        message: true,
        txnDate: true,
      },
      take: 200,
    });
    for (const h of failedHeaders) {
      addException({
        type: 'INVOICE_FAILED',
        branchCode: '',
        branchName: h.billToCustName ?? '',
        businessDay: h.txnDate
          ? this.aggregation.localDayOf(new Date(h.txnDate), timeZone)
          : '',
        orderName: null,
        amount: null,
        quantity: null,
        detail: this.firstLine(h.message) ?? 'Invoice failed',
      });
    }

    // ── Finalise rows ────────────────────────────────────────────────────────
    const finalRows = [...rows.values()]
      .map((row) => this.finalise(row))
      .sort(
        (a, b) =>
          a.businessDay.localeCompare(b.businessDay) ||
          a.branchName.localeCompare(b.branchName),
      );

    const totals = {
      expected: this.emptyExpected(),
      posted: this.emptyPosted(),
      variance: this.emptyVariance(),
      storeDays: {
        MATCHED: 0,
        VARIANCE: 0,
        NOT_POSTED: 0,
        NO_ACTIVITY: 0,
      } as Record<DayStatus, number>,
    };
    for (const r of finalRows) {
      this.addInto(totals.expected, r.expected);
      this.addInto(totals.posted, r.posted);
      this.addInto(totals.variance, r.variance);
      totals.storeDays[r.status] += 1;
    }
    this.roundAll(totals.expected);
    this.roundAll(totals.posted);
    this.roundAll(totals.variance);

    const notes: string[] = [
      `Days are store-local (${timeZone}), matching how invoices are grouped.`,
      'Receipts compare standard receipts + bank-charge misc receipts (standard receipts are posted net of bank charges) with till payments. Cash-rounding misc receipts are shown separately. Service-provider and credit-on-account payments get no receipt by design.',
    ];
    if (Math.abs(totals.variance.pricingGap) > AMOUNT_TOLERANCE) {
      notes.push(
        `Invoice lines priced by the integration are ${this.fmt(totals.variance.pricingGap)} away from Odoo's net sales over this range — lines without a net subtotal from Odoo fell back to the list price.`,
      );
    }

    return {
      region,
      startDate: params.startDate,
      endDate: params.endDate,
      timeZone,
      windowUtc: {
        start: window.start.toISOString(),
        end: window.end.toISOString(),
      },
      generatedAt: new Date().toISOString(),
      tolerance: { amount: AMOUNT_TOLERANCE, quantity: QTY_TOLERANCE },
      totals,
      rows: finalRows,
      exceptions,
      exceptionCounts,
      exceptionsTruncated: exceptions.length >= MAX_EXCEPTIONS,
      notes,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Odoo API ↔ backup (did the pull store everything accurately?)
  // ════════════════════════════════════════════════════════════════════════

  async odooVsBackup(params: {
    region: string;
    startDate: string;
    endDate: string;
  }): Promise<OdooVsBackupReport> {
    const region = params.region.trim().toUpperCase();
    this.validateRange(params.startDate, params.endDate);
    const timeZone = this.aggregation.regionTimeZone(region);
    const days = this.dayList(params.startDate, params.endDate);
    const inRange = new Set(days);
    const window = {
      start: this.aggregation.localDayWindow(params.startDate, timeZone).start,
      end: this.aggregation.localDayWindow(params.endDate, timeZone).end,
    };

    const report: OdooVsBackupReport = {
      region,
      startDate: params.startDate,
      endDate: params.endDate,
      timeZone,
      apiReachable: false,
      apiComplete: false,
      error: null,
      fetchedFromApi: 0,
      days: [],
      totals: {
        apiOrders: 0,
        storedOrders: 0,
        apiAmount: 0,
        storedAmount: 0,
        missingInBackup: 0,
        notInOdoo: 0,
        mismatched: 0,
      },
      differences: [],
      differencesTruncated: false,
      notes: [],
    };

    const cred = await this.credRepo.findOne({
      where: { region, active: true },
    });
    if (!cred) {
      report.error = `No active Odoo credential for region ${region}`;
      return report;
    }

    // Ask Odoo for one extra day each side: the API's date filter and the
    // store-local day don't share a timezone, so this guarantees every order of
    // the local days is in the snapshot. Orders are then bucketed by local day.
    const snap = await this.odooBackup.fetchOrdersSnapshot(cred, {
      startDate: this.addDays(params.startDate, -1),
      endDate: this.addDays(params.endDate, 1),
    });
    report.apiReachable = snap.ok;
    report.apiComplete = snap.complete;
    report.error = snap.error;
    report.fetchedFromApi = snap.orders.length;
    if (!snap.ok) return report;
    if (!snap.complete) {
      report.notes.push(
        `Odoo reports ${snap.apiTotal} orders but returned ${snap.orders.length} — the snapshot is partial, so "not in Odoo" is not evaluated.`,
      );
    }

    const stores = await this.storeRepo.find({ where: { region } });
    const stored = await this.loadOrders(region, stores, window);
    const storedById = new Map(stored.map((o) => [Number(o.orderId), o]));
    const storedLineCounts = await this.countChildren(
      this.lineRepo,
      stored.map((o) => o.id),
    );
    const storedPaymentCounts = await this.countChildren(
      this.paymentRepo,
      stored.map((o) => o.id),
    );

    const dayStats = new Map(
      days.map((d) => [
        d,
        {
          businessDay: d,
          apiOrders: 0,
          storedOrders: 0,
          apiAmount: 0,
          storedAmount: 0,
          missingInBackup: 0,
          notInOdoo: 0,
          mismatched: 0,
        },
      ]),
    );
    const diff = (d: OdooVsBackupReport['differences'][number]) => {
      if (report.differences.length < MAX_EXCEPTIONS)
        report.differences.push(d);
      else report.differencesTruncated = true;
    };

    const apiIds = new Set<number>();
    const missingIds: number[] = [];
    const apiInRange: Array<{ o: Record<string, unknown>; day: string }> = [];
    for (const raw of snap.orders) {
      const o = raw as unknown as Record<string, unknown>;
      const id = Number(o['id']);
      if (!Number.isFinite(id)) continue;
      apiIds.add(id);
      const dateRaw = o['date_order'];
      if (typeof dateRaw !== 'string' && !(dateRaw instanceof Date)) continue;
      // Parsed exactly as the backup stores it (new Date(date_order)).
      const day = this.aggregation.localDayOf(new Date(dateRaw), timeZone);
      if (!inRange.has(day)) continue;
      apiInRange.push({ o, day });
    }

    for (const { o, day } of apiInRange) {
      const id = Number(o['id']);
      const stats = dayStats.get(day)!;
      const amount = this.num(o['amount_total']);
      stats.apiOrders += 1;
      stats.apiAmount += amount;
      const s = storedById.get(id);
      const name = typeof o['name'] === 'string' ? o['name'] : null;
      const branch = this.many2oneName(o['branch_id']);
      if (!s) {
        missingIds.push(id);
        continue;
      }
      const issues: Array<
        [OdooVsBackupReport['differences'][number]['type'], string, string]
      > = [];
      if (Math.abs(this.num(s.amountTotal) - amount) > 0.01) {
        issues.push([
          'AMOUNT_MISMATCH',
          this.fmt(amount),
          this.fmt(this.num(s.amountTotal)),
        ]);
      }
      const apiState = typeof o['state'] === 'string' ? o['state'] : '';
      if ((s.state ?? '') !== apiState) {
        issues.push(['STATE_MISMATCH', apiState || '—', s.state ?? '—']);
      }
      const apiLines = this.apiLineCount(o);
      const sLines = storedLineCounts.get(s.id) ?? 0;
      if (apiLines != null && apiLines !== sLines) {
        issues.push(['LINES_MISMATCH', `${apiLines} lines`, `${sLines} lines`]);
      }
      const apiPays = this.apiPaymentCount(o);
      const sPays = storedPaymentCounts.get(s.id) ?? 0;
      if (apiPays != null && apiPays !== sPays) {
        issues.push([
          'PAYMENTS_MISMATCH',
          `${apiPays} payments`,
          `${sPays} payments`,
        ]);
      }
      if (issues.length) stats.mismatched += 1;
      for (const [type, odoo, st] of issues) {
        diff({
          type,
          odooOrderId: id,
          orderName: name,
          businessDay: day,
          branch,
          odoo,
          stored: st,
        });
      }
    }

    // Orders Odoo has but the backup window doesn't: either never pulled, or
    // stored with a date that lands on another day.
    const elsewhere = new Map<number, BackupOdooOrder>();
    for (let i = 0; i < missingIds.length; i += CHUNK) {
      const found = await this.orderRepo.find({
        where: { orderId: In(missingIds.slice(i, i + CHUNK)) },
        select: { id: true, orderId: true, dateOrder: true, orderName: true },
      });
      for (const f of found) elsewhere.set(Number(f.orderId), f);
    }
    for (const { o, day } of apiInRange) {
      const id = Number(o['id']);
      if (storedById.has(id)) continue;
      const name = typeof o['name'] === 'string' ? o['name'] : null;
      const branch = this.many2oneName(o['branch_id']);
      const other = elsewhere.get(id);
      if (other) {
        diff({
          type: 'STORED_UNDER_OTHER_DAY',
          odooOrderId: id,
          orderName: name,
          businessDay: day,
          branch,
          odoo: `${String(o['date_order'])} (${day})`,
          stored: other.dateOrder
            ? `${other.dateOrder.toISOString()} (${this.aggregation.localDayOf(other.dateOrder, timeZone)})`
            : 'no date',
        });
        dayStats.get(day)!.mismatched += 1;
      } else {
        dayStats.get(day)!.missingInBackup += 1;
        diff({
          type: 'MISSING_IN_BACKUP',
          odooOrderId: id,
          orderName: name,
          businessDay: day,
          branch,
          odoo: `${this.fmt(this.num(o['amount_total']))} · ${typeof o['state'] === 'string' ? o['state'] : ''}`,
          stored: 'not stored',
        });
      }
    }

    for (const s of stored) {
      const day = s.dateOrder
        ? this.aggregation.localDayOf(new Date(s.dateOrder), timeZone)
        : null;
      if (!day || !dayStats.has(day)) continue;
      const stats = dayStats.get(day)!;
      stats.storedOrders += 1;
      stats.storedAmount += this.num(s.amountTotal);
      if (snap.complete && !apiIds.has(Number(s.orderId))) {
        stats.notInOdoo += 1;
        diff({
          type: 'NOT_IN_ODOO',
          odooOrderId: Number(s.orderId),
          orderName: s.orderName,
          businessDay: day,
          branch: s.branchName,
          odoo: 'not returned by Odoo',
          stored: `${this.fmt(this.num(s.amountTotal))} · ${s.state ?? ''}`,
        });
      }
    }

    report.days = [...dayStats.values()].map((d) => ({
      ...d,
      apiAmount: this.round(d.apiAmount),
      storedAmount: this.round(d.storedAmount),
    }));
    for (const d of report.days) {
      report.totals.apiOrders += d.apiOrders;
      report.totals.storedOrders += d.storedOrders;
      report.totals.apiAmount += d.apiAmount;
      report.totals.storedAmount += d.storedAmount;
      report.totals.missingInBackup += d.missingInBackup;
      report.totals.notInOdoo += d.notInOdoo;
      report.totals.mismatched += d.mismatched;
    }
    report.totals.apiAmount = this.round(report.totals.apiAmount);
    report.totals.storedAmount = this.round(report.totals.storedAmount);
    report.notes.push(
      `Orders are bucketed by store-local day (${timeZone}). Odoo was queried one extra day each side so no order near midnight is missed.`,
    );
    return report;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Loading
  // ════════════════════════════════════════════════════════════════════════

  /** Orders in the window for the region's stores (same matching as invoicing). */
  private async loadOrders(
    region: string,
    stores: StoreConfiguration[],
    window: { start: Date; end: Date },
  ): Promise<BackupOdooOrder[]> {
    const when = Between(window.start, window.end);
    const branchIds = stores
      .map((s) => Number(s.odooBranchId))
      .filter((n) => Number.isFinite(n) && n > 0);
    const codes = stores.map((s) => s.branchCode);
    const where: Array<Record<string, unknown>> = [{ region, dateOrder: when }];
    for (let i = 0; i < codes.length; i += CHUNK) {
      where.push({
        resolvedBranchCode: In(codes.slice(i, i + CHUNK)),
        dateOrder: when,
      });
    }
    for (let i = 0; i < branchIds.length; i += CHUNK) {
      where.push({
        branchId: In(branchIds.slice(i, i + CHUNK)),
        dateOrder: when,
      });
    }
    const rows = await this.orderRepo.find({
      where,
      order: { dateOrder: 'ASC' },
    });
    // Duplicate rows of the same Odoo order (re-pulls) count once.
    const byOrderId = new Map<number, BackupOdooOrder>();
    for (const r of rows) {
      const prev = byOrderId.get(Number(r.orderId));
      if (
        !prev ||
        (r.updatedAt ?? r.createdAt) > (prev.updatedAt ?? prev.createdAt)
      ) {
        byOrderId.set(Number(r.orderId), r);
      }
    }
    return [...byOrderId.values()];
  }

  private async buildFacts(
    orders: BackupOdooOrder[],
    stores: StoreConfiguration[],
    timeZone: string,
    days: string[],
  ): Promise<OrderFacts[]> {
    const inRange = new Set(days);
    const byCode = new Set(stores.map((s) => s.branchCode));
    const byBranchId = new Map(
      stores.map((s) => [Number(s.odooBranchId), s.branchCode]),
    );

    // Lines & payments loaded flat (only the columns needed), chunked.
    const ids = orders.map((o) => o.id);
    const lines = new Map<string, BackupOdooOrderLine[]>();
    const payments = new Map<string, BackupOdooOrderPayment[]>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const [ls, ps] = await Promise.all([
        this.lineRepo.find({
          where: { parentOrderId: In(slice) },
          select: {
            id: true,
            parentOrderId: true,
            productCode: true,
            productName: true,
            lineName: true,
            qty: true,
            priceUnit: true,
            priceSubtotal: true,
            priceSubtotalIncl: true,
          },
        }),
        this.paymentRepo.find({
          where: { parentOrderId: In(slice) },
          select: {
            id: true,
            parentOrderId: true,
            paymentName: true,
            amount: true,
          },
        }),
      ]);
      for (const l of ls) {
        if (!l.parentOrderId) continue;
        (
          lines.get(l.parentOrderId) ??
          lines.set(l.parentOrderId, []).get(l.parentOrderId)!
        ).push(l);
      }
      for (const p of ps) {
        if (!p.parentOrderId) continue;
        (
          payments.get(p.parentOrderId) ??
          payments.set(p.parentOrderId, []).get(p.parentOrderId)!
        ).push(p);
      }
    }

    const facts: OrderFacts[] = [];
    for (const o of orders) {
      if (!o.dateOrder) continue;
      const day = this.aggregation.localDayOf(new Date(o.dateOrder), timeZone);
      if (!inRange.has(day)) continue;
      const store =
        o.resolvedBranchCode && byCode.has(o.resolvedBranchCode)
          ? o.resolvedBranchCode
          : (byBranchId.get(Number(o.branchId)) ?? UNMAPPED);
      const state = (o.state ?? '').toLowerCase().trim();
      const total = this.num(o.amountTotal);
      const kind: OrderFacts['kind'] = NON_INVOICEABLE_STATES.has(state)
        ? 'EXCLUDED'
        : total < 0
          ? 'REFUND'
          : 'SALE';

      const ol = lines.get(o.id) ?? [];
      let invoiceBasis = 0;
      let soldQty = 0;
      for (const l of ol) {
        const qty = this.num(l.qty);
        if (qty === 0) continue;
        if (l.productCode?.trim()) soldQty += qty;
        invoiceBasis += this.linePricedAt(l);
      }
      // Attach payments so deriveServiceProvider can read them.
      const op = payments.get(o.id) ?? [];
      o.orderPayments = op;
      facts.push({
        order: o,
        store,
        day,
        kind,
        payments: op.map((p) => ({
          name: (p.paymentName ?? '').trim(),
          amount: this.num(p.amount),
        })),
        invoiceBasis,
        // Oracle qty = −(Odoo qty): sales issue, refunds return.
        inventoryQty: -soldQty,
        lineCount: ol.length,
      });
    }
    return facts;
  }

  /**
   * What the integration's invoice line is worth (DailyAggregationService
   * .buildLine): net ex-tax unit × qty, sign from the line total; a positive
   * discount line posts as qty 1.
   */
  private linePricedAt(l: BackupOdooOrderLine): number {
    let qty = this.num(l.qty ?? 1);
    const total =
      l.priceSubtotalIncl != null
        ? this.num(l.priceSubtotalIncl)
        : l.priceSubtotal != null
          ? this.num(l.priceSubtotal)
          : this.num(l.priceUnit) * qty;
    // Same rule as DailyAggregationService.buildLine: net ex-tax per unit
    // (priceSubtotal / qty, after line discounts), list price only as fallback.
    const unit =
      l.priceSubtotal != null && qty !== 0
        ? Math.abs(this.num(l.priceSubtotal) / qty)
        : l.priceUnit != null
          ? Math.abs(this.num(l.priceUnit))
          : qty !== 0
            ? Math.abs(total / qty)
            : 0;
    if (total < 0 && qty > 0) qty = -qty;
    const isDiscount =
      !l.productCode?.trim() ||
      (l.productName ?? '').toLowerCase() === 'discount item';
    if (isDiscount && total > 0) qty = 1;
    return unit * qty;
  }

  /** order name → invoice txn numbers with a SUCCESS line. */
  private async loadInvoiceLines(
    names: string[],
    region: string,
  ): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for (let i = 0; i < names.length; i += CHUNK) {
      const rows = await this.invLineRepo.find({
        where: {
          salesOrder: In(names.slice(i, i + CHUNK)),
          region,
          status: 'SUCCESS',
        },
        select: { id: true, salesOrder: true, invoiceNumber: true },
      });
      for (const r of rows) {
        if (!r.salesOrder || !r.invoiceNumber) continue;
        const set = out.get(r.salesOrder) ?? new Set<string>();
        set.add(String(r.invoiceNumber));
        out.set(r.salesOrder, set);
      }
    }
    return out;
  }

  private async loadHeaders(
    txns: string[],
    region: string,
  ): Promise<Map<string, FusionInvoiceHeader>> {
    const out = new Map<string, FusionInvoiceHeader>();
    const nums = txns.filter((t) => /^\d+$/.test(t)).map((t) => BigInt(t));
    for (let i = 0; i < nums.length; i += CHUNK) {
      const rows = await this.invHeaderRepo.find({
        where: { txnNumber: In(nums.slice(i, i + CHUNK)), region },
        select: {
          id: true,
          txnNumber: true,
          status: true,
          totalAmount: true,
          currencyCode: true,
        },
      });
      for (const r of rows) {
        const key = String(r.txnNumber);
        // Prefer a SUCCESS header if the txn has several rows.
        if (!out.has(key) || r.status === 'SUCCESS') out.set(key, r);
      }
    }
    return out;
  }

  /** invoice txn → Σ standard / Σ misc SUCCESS receipt amounts. */
  private async loadReceipts(
    txns: string[],
    region: string,
  ): Promise<
    Map<string, { standard: number; misc: number; rounding: number }>
  > {
    const out = new Map<
      string,
      { standard: number; misc: number; rounding: number }
    >();
    const wanted = new Set(txns);
    const add = (
      txn: string,
      field: 'standard' | 'misc' | 'rounding',
      amount: number,
    ) => {
      if (!wanted.has(txn)) return;
      const r = out.get(txn) ?? { standard: 0, misc: 0, rounding: 0 };
      r[field] += amount;
      out.set(txn, r);
    };
    for (let i = 0; i < txns.length; i += 150) {
      const slice = txns.slice(i, i + 150);
      const like = slice
        .map((_, j) => `r.receiptNumber LIKE :p${j}`)
        .join(' OR ');
      const params = Object.fromEntries(
        slice.map((t, j) => [`p${j}`, `%-${t}%`]),
      );
      const [std, misc] = await Promise.all([
        this.stdRepo
          .createQueryBuilder('r')
          .select(['r.id', 'r.receiptNumber', 'r.receiptAmount'])
          .where('r.region = :region', { region })
          .andWhere('r.status = :st', { st: 'SUCCESS' })
          .andWhere(`(${like})`, params)
          .getMany(),
        this.miscRepo
          .createQueryBuilder('r')
          .select([
            'r.id',
            'r.receiptNumber',
            'r.receiptAmount',
            'r.recActivityName',
          ])
          .where('r.region = :region', { region })
          .andWhere('r.status = :st', { st: 'SUCCESS' })
          .andWhere(`(${like})`, params)
          .getMany(),
      ]);
      for (const r of std) {
        const m = /-(\d+)$/.exec(r.receiptNumber ?? '');
        if (m) add(m[1], 'standard', this.num(r.receiptAmount));
      }
      for (const r of misc) {
        const m = /-(\d+)-MISC$/.exec(r.receiptNumber ?? '');
        // Cash rounding is booked against the cash-rounding receivable
        // activity; everything else is a bank charge.
        if (m)
          add(
            m[1],
            /round/i.test(r.recActivityName ?? '') ? 'rounding' : 'misc',
            this.num(r.receiptAmount),
          );
      }
    }
    return out;
  }

  private async loadRefunds(
    names: string[],
  ): Promise<Map<string, RefundTracking>> {
    const out = new Map<string, RefundTracking>();
    for (let i = 0; i < names.length; i += CHUNK) {
      const rows = await this.refundRepo.find({
        where: { refundOrderNumber: In(names.slice(i, i + CHUNK)) },
      });
      for (const r of rows) {
        const prev = out.get(r.refundOrderNumber);
        // A SYNCED row wins over failed/pending retries of the same refund.
        if (!prev || r.creditMemoStatus === SyncStatus.SYNCED) {
          out.set(r.refundOrderNumber, r);
        }
      }
    }
    return out;
  }

  private async loadInventory(
    names: string[],
    region: string,
  ): Promise<Map<string, FusionInvTxn[]>> {
    const out = new Map<string, FusionInvTxn[]>();
    for (let i = 0; i < names.length; i += CHUNK) {
      const rows = await this.invTxnRepo.find({
        where: { txnSourceName: In(names.slice(i, i + CHUNK)), region },
        select: {
          id: true,
          txnSourceName: true,
          itemNumber: true,
          subInventory: true,
          status: true,
          txnQty: true,
          holdReason: true,
          message: true,
        },
      });
      for (const r of rows) {
        if (!r.txnSourceName) continue;
        const list = out.get(r.txnSourceName) ?? [];
        list.push(r);
        out.set(r.txnSourceName, list);
      }
    }
    return out;
  }

  private async countChildren(
    repo: Repository<BackupOdooOrderLine> | Repository<BackupOdooOrderPayment>,
    parentIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < parentIds.length; i += CHUNK) {
      const rows = await (repo as Repository<BackupOdooOrderLine>)
        .createQueryBuilder('c')
        .select('c.parentOrderId', 'pid')
        .addSelect('COUNT(*)', 'n')
        .where('c.parentOrderId IN (:...ids)', {
          ids: parentIds.slice(i, i + CHUNK),
        })
        .groupBy('c.parentOrderId')
        .getRawMany<{ pid: string; n: number | string }>();
      for (const r of rows) out.set(r.pid, Number(r.n));
    }
    return out;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Row maths
  // ════════════════════════════════════════════════════════════════════════

  private finalise(row: ReconStoreDay): ReconStoreDay {
    const e = row.expected;
    const p = row.posted;
    p.receiptsGross = p.receiptsStandard - p.receiptsMisc;
    this.roundAll(e);
    this.roundAll(p);
    p.invoiceNumbers = [...new Set(p.invoiceNumbers)].sort();

    const v = row.variance;
    v.invoiceNet = this.round(e.salesNet - p.invoiceNet);
    v.ordersNotInvoiced = e.salesOrders - p.invoicedOrders;
    v.receipts = this.round(e.expectedReceipts - p.receiptsGross);
    v.creditMemos = this.round(e.refundGross - p.creditMemoAmount);
    v.inventoryQty = this.round(e.inventoryQty - p.inventoryQty, 4);
    v.pricingGap = this.round(e.invoiceBasis - e.salesNet);

    const issues: string[] = [];
    if (v.ordersNotInvoiced > 0)
      issues.push(`${v.ordersNotInvoiced} order(s) not invoiced`);
    if (Math.abs(v.invoiceNet) > AMOUNT_TOLERANCE)
      issues.push(`Invoice net off by ${this.fmt(v.invoiceNet)}`);
    if (Math.abs(v.receipts) > AMOUNT_TOLERANCE)
      issues.push(`Receipts off by ${this.fmt(v.receipts)}`);
    if (Math.abs(v.creditMemos) > AMOUNT_TOLERANCE)
      issues.push(`Credit memos off by ${this.fmt(v.creditMemos)}`);
    if (Math.abs(v.inventoryQty) > QTY_TOLERANCE)
      issues.push(`Inventory qty off by ${v.inventoryQty}`);
    if (p.inventoryHeld > 0)
      issues.push(
        `${p.inventoryHeld} inventory row(s) held for negative stock`,
      );
    if (p.inventoryErrors > 0)
      issues.push(`${p.inventoryErrors} inventory row(s) failed`);
    if (row.branchCode === UNMAPPED && e.orders > 0)
      issues.push('Odoo branch not mapped to any store');
    row.issues = issues;

    const activity = e.salesOrders + e.refundOrders > 0;
    const anythingPosted =
      p.invoicedOrders > 0 ||
      p.creditMemos > 0 ||
      Math.abs(p.inventoryQty) > 0 ||
      p.inventoryHeld + p.inventoryErrors > 0;
    row.status = !activity
      ? 'NO_ACTIVITY'
      : !anythingPosted
        ? 'NOT_POSTED'
        : issues.length === 0
          ? 'MATCHED'
          : 'VARIANCE';
    return row;
  }

  private emptyExpected(): ReconExpected {
    return {
      orders: 0,
      salesOrders: 0,
      refundOrders: 0,
      excludedOrders: 0,
      excludedAmount: 0,
      salesGross: 0,
      salesNet: 0,
      salesTax: 0,
      refundGross: 0,
      payments: 0,
      expectedReceipts: 0,
      providerPayments: 0,
      creditPayments: 0,
      invoiceBasis: 0,
      inventoryQty: 0,
    };
  }

  private emptyPosted(): ReconPosted {
    return {
      invoiceNumbers: [],
      invoicedOrders: 0,
      invoiceNet: 0,
      receiptsStandard: 0,
      receiptsMisc: 0,
      receiptsRounding: 0,
      receiptsGross: 0,
      creditMemos: 0,
      creditMemoAmount: 0,
      inventoryQty: 0,
      inventoryHeld: 0,
      inventoryErrors: 0,
    };
  }

  private emptyVariance(): ReconVariance {
    return {
      invoiceNet: 0,
      ordersNotInvoiced: 0,
      receipts: 0,
      creditMemos: 0,
      inventoryQty: 0,
      pricingGap: 0,
    };
  }

  /** Adds every numeric field of `src` into `dst` (arrays concatenated). */
  private addInto<T extends object>(dst: T, src: T): void {
    const d = dst as Record<string, unknown>;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (typeof v === 'number') d[k] = (d[k] as number) + v;
    }
  }

  private roundAll<T extends object>(obj: T): void {
    const o = obj as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number') {
        o[k] = k.toLowerCase().includes('qty')
          ? this.round(v, 4)
          : this.round(v);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Small helpers
  // ════════════════════════════════════════════════════════════════════════

  private validateRange(startDate: string, endDate: string): void {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(startDate ?? '') || !re.test(endDate ?? '')) {
      throw new BadRequestException(
        'startDate and endDate are required as YYYY-MM-DD',
      );
    }
    if (endDate < startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    if (this.dayList(startDate, endDate).length > MAX_DAYS) {
      throw new BadRequestException(
        `Reconcile at most ${MAX_DAYS} days at a time`,
      );
    }
  }

  private dayList(start: string, end: string): string[] {
    const out: string[] = [];
    for (
      let d = start;
      d <= end && out.length <= MAX_DAYS + 1;
      d = this.addDays(d, 1)
    ) {
      out.push(d);
    }
    return out;
  }

  private addDays(day: string, n: number): string {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  private exBase(row: ReconStoreDay, orderName: string) {
    return {
      branchCode: row.branchCode,
      branchName: row.branchName,
      businessDay: row.businessDay,
      orderName,
    };
  }

  private orderName(o: BackupOdooOrder): string {
    return o.orderName ?? String(o.orderId);
  }

  private num(v: unknown): number {
    if (v == null) return 0;
    // Number() also unwraps Decimal (valueOf) and numeric strings.
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  private round(n: number, dp = 2): number {
    const f = 10 ** dp;
    return Math.round((n + Number.EPSILON) * f) / f;
  }

  private fmt(n: number): string {
    return this.round(n).toFixed(2);
  }

  private firstLine(text: string | null | undefined): string | null {
    const line = (text ?? '').split('\n')[0]?.trim();
    return line ? line.slice(0, 300) : null;
  }

  private many2oneName(v: unknown): string | null {
    if (Array.isArray(v) && typeof v[1] === 'string') return v[1];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    return null;
  }

  /** Mirrors OdooBackupService.buildLineRows: lines ?? order_line, objects only. */
  private apiLineCount(o: Record<string, unknown>): number | null {
    const raw = Array.isArray(o['lines'])
      ? (o['lines'] as unknown[])
      : Array.isArray(o['order_line'])
        ? (o['order_line'] as unknown[])
        : null;
    if (!raw) return null;
    return raw.filter((l) => typeof l === 'object' && l !== null).length;
  }

  /** Mirrors OdooBackupService.extractPaymentItems precedence. */
  private apiPaymentCount(o: Record<string, unknown>): number | null {
    const objects = (arr: unknown[]) =>
      arr.filter((x) => typeof x === 'object' && x !== null).length;
    const st = o['statement_ids'];
    if (Array.isArray(st) && st.length > 0) return objects(st);
    const pi = o['payment_ids'];
    if (Array.isArray(pi) && pi.length > 0) return objects(pi);
    const p = o['payments'];
    if (Array.isArray(p)) return objects(p);
    return null;
  }
}
