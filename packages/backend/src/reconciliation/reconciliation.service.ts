import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { BackupOdooOrderPayment } from '../database/entities/backup-odoo-order-payment.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionStandardReceipt } from '../database/entities/fusion-standard-receipt.entity';
import { FusionMiscReceipt } from '../database/entities/fusion-misc-receipt.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { PaymentMethodMapping } from '../database/entities/payment-method-mapping.entity';
import { PAID_ORDER_STATES } from '../common/odoo-utils';
import { round2 } from '../common/money';
import {
  OracleClient,
  type OracleLiveInvoice,
  type OracleLiveInvoiceLine,
} from '../clients/oracle/oracle.client';

/**
 * Where a single order stands when the Odoo source row is put next to what
 * actually landed in Oracle. Ordered by severity — `worstOf` picks the first
 * match, so an order that is both short a line and short money reports the
 * money problem, which is the one an accountant acts on.
 */
export type ReconciliationStatus =
  | 'ORACLE_ERROR'
  | 'MISSING_IN_ORACLE'
  | 'UNEXPECTED_IN_ORACLE'
  | 'AMOUNT_MISMATCH'
  | 'PAYMENT_MISMATCH'
  | 'LINE_MISMATCH'
  | 'NOT_SYNCABLE'
  | 'MATCHED';

const SEVERITY: ReconciliationStatus[] = [
  'ORACLE_ERROR',
  'MISSING_IN_ORACLE',
  'UNEXPECTED_IN_ORACLE',
  'AMOUNT_MISMATCH',
  'PAYMENT_MISMATCH',
  'LINE_MISMATCH',
  'NOT_SYNCABLE',
  'MATCHED',
];

/** Everything except MATCHED and NOT_SYNCABLE needs a human to look at it. */
export const PROBLEM_STATUSES: ReconciliationStatus[] = SEVERITY.filter(
  (s) => s !== 'MATCHED' && s !== 'NOT_SYNCABLE',
);

export interface ReconciliationParams {
  startDate?: string;
  endDate?: string;
  region?: string;
  branchCode?: string;
  /**
   * One store, matched against whichever identifier it is known by — the
   * resolved branch code, the Odoo branch name, or the POS config name. The
   * store breakdown keys on the same fallback chain, so a row from that table
   * always filters back to exactly the orders it counted.
   */
  store?: string;
  /** Filter the returned rows to one status (the summary always covers all). */
  status?: string;
  /** Free-text match on Odoo order name / id / Oracle invoice number. */
  search?: string;
  /** Absolute currency difference treated as equal. Defaults to 0.01. */
  tolerance?: number;
  limit?: number;
  offset?: number;
  /** Safety valve on how many Odoo orders one call will compare. */
  maxScan?: number;
}

export interface OdooSide {
  orderId: number;
  /** The Odoo order reference (`orderName`), the key everything joins on. */
  orderName: string;
  branchCode: string | null;
  branchName: string | null;
  posConfigName: string | null;
  region: string | null;
  orderDate: Date | null;
  state: string | null;
  total: number;
  untaxed: number;
  tax: number;
  discount: number;
  lineCount: number;
  lineTotal: number;
  paymentCount: number;
  paymentTotal: number;
}

export interface OracleSide {
  headerId: string | null;
  invoiceNumber: string | null;
  status: string | null;
  txnDate: Date | null;
  glDate: Date | null;
  /**
   * The invoice total. On an aggregated daily invoice this is the whole day for
   * the store, not this order — see `coversOrders`.
   */
  total: number | null;
  /**
   * How many distinct Odoo orders share this invoice. The daily invoice path
   * bills a whole store-day as one Oracle transaction, so this is routinely
   * greater than 1 and `total` then belongs to all of them jointly.
   */
  coversOrders: number;
  /** True when this invoice bills more than one Odoo order. */
  isAggregate: boolean;
  lineCount: number;
  /** null when no receipt row could be linked — unknown, not zero. */
  receiptTotal: number | null;
  receiptCount: number;
  message: string | null;
}

export interface ReconciliationRow {
  orderName: string;
  odoo: OdooSide;
  oracle: OracleSide | null;
  queueStatus: string | null;
  queueError: string | null;
  status: ReconciliationStatus;
  /** Positive = Odoo is higher than Oracle. */
  amountDifference: number | null;
  paymentDifference: number | null;
  lineDifference: number | null;
  issues: string[];
}

export interface OrphanRow {
  salesOrder: string;
  invoiceNumber: string | null;
  region: string | null;
  lineCount: number;
  firstSeen: Date | null;
}

/** Outcome of reading an invoice back out of Oracle and comparing it to Odoo. */
export type LiveVerifyStatus =
  | 'VERIFIED'
  | 'MISMATCH'
  | 'NOT_IN_ORACLE'
  | 'LOOKUP_FAILED';

export type BreakdownGroupBy = 'store' | 'date' | 'store-date';

/** Grain of the tender (payment-method) reconciliation. */
export type TenderGroupBy =
  | 'store-date-method'
  | 'store-method'
  | 'date-method'
  | 'method';

/** Whether an Odoo tender has a usable Oracle receipt method behind it. */
export type TenderMappingStatus =
  | 'MAPPED'
  | 'PENDING'
  | 'UNMAPPED'
  | 'ORACLE_ONLY';

export type TenderStatus =
  | 'MATCHED'
  | 'SHORT_IN_ORACLE'
  | 'OVER_IN_ORACLE'
  | 'MISSING_IN_ORACLE'
  | 'UNEXPECTED_IN_ORACLE'
  /** Not all orders behind this tender's invoices were in the window. */
  | 'INCOMPLETE';

/**
 * One tender line: what a store took in a given payment method on a given day,
 * against what Oracle receipted for it.
 *
 * This is the grain a cash-up actually happens at. Oracle numbers its receipts
 * `<Method>-<transactionNumber>`, keyed on the invoice rather than the
 * individual order, so per-order tender does not exist on the Oracle side at
 * all — store x day x method is the finest slice where both systems can
 * genuinely be compared.
 */
export interface TenderRow {
  key: string;
  branchCode: string | null;
  branchName: string | null;
  region: string | null;
  /** `YYYY-MM-DD`, or null when the grouping does not slice by date. */
  date: string | null;
  /** Display name of the tender, in the spelling the source system uses. */
  method: string;
  /** Oracle receipt method the mapping resolves this tender to. */
  mappedMethod: string | null;
  mappingStatus: TenderMappingStatus;
  odooCount: number;
  odooTotal: number;
  /** Standard receipts — the gross amount Oracle receipted. */
  oracleCount: number;
  oracleTotal: number;
  /**
   * Miscellaneous receipts against the same tender, normally negative: card
   * scheme and gateway fees deducted at settlement. Kept out of `oracleTotal`
   * so a fee never reads as a shortfall against the till.
   */
  oracleFees: number;
  /** Odoo minus Oracle. Positive = the till took more than Oracle receipted. */
  variance: number;
  /**
   * True when an invoice contributing to this row bills orders that fall
   * outside the scanned window. Oracle receipts always cover the whole invoice,
   * so the Odoo side would be short through nothing but the date filter — the
   * variance is suppressed rather than reported as a shortfall.
   */
  partial: boolean;
  status: TenderStatus;
}

/** Accumulator behind a {@link BreakdownRow}, carrying dedupe state. */
interface BreakdownAccumulator extends BreakdownRow {
  /** Invoice headers already added to `oracleTotal`, so shared ones count once. */
  countedHeaders: Set<string>;
}

/** One aggregated line of the store / date drill-down. */
export interface BreakdownRow {
  /** Stable identifier for the group; also what the UI filters on. */
  key: string;
  branchCode: string | null;
  branchName: string | null;
  region: string | null;
  /** `YYYY-MM-DD`, or null when the grouping does not slice by date. */
  date: string | null;
  orders: number;
  counts: Record<ReconciliationStatus, number>;
  problems: number;
  matchRate: number;
  odooTotal: number;
  oracleTotal: number;
  variance: number;
  odooPayments: number;
  oracleReceipts: number;
  /**
   * Orders whose Oracle receipts could not be linked by number. Their payments
   * are missing from `oracleReceipts`, so a non-zero count here means the
   * receipt column understates rather than proves a shortfall.
   */
  unlinkedReceiptOrders: number;
}

export interface ReconciliationSummary {
  scanned: number;
  truncated: boolean;
  counts: Record<ReconciliationStatus, number>;
  problems: number;
  odooTotal: number;
  oracleTotal: number;
  variance: number;
  /** Share of syncable orders that reconcile cleanly, 0–100. */
  matchRate: number;
  orphanCount: number;
  /**
   * Orders billed on an invoice they share with other orders. While this is
   * non-zero the money columns are not order-for-order comparable: Oracle's
   * side counts whole invoices, some of whose orders fall outside the window,
   * and our stored invoice lines carry no amount to split them by. Per-order
   * money for these has to come from the live Oracle check.
   */
  aggregatedOrders: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_MAX_SCAN = 2000;
const HARD_MAX_SCAN = 20000;
const DEFAULT_TOLERANCE = 0.01;
const ORPHAN_LIMIT = 200;
/**
 * How many invoice lines one live read pulls. Daily invoices aggregate a whole
 * store-day, so this has to cover a busy outlet's lines in a single page — a
 * partial page would silently understate an order's share.
 */
const AGGREGATE_LINE_FETCH = 500;
/** Shown when a payment row or receipt number carries no tender name. */
const UNKNOWN_TENDER = 'UNKNOWN';
/** Oracle caps an IN-list at 1000 bind values. */
const IN_CHUNK = 900;

/**
 * Joins the store and date halves of a composite group key. A printable,
 * unmistakable separator rather than a space: store names contain spaces, so
 * a space would make `Dubai Mall 2026-08-20` ambiguous to split back apart.
 */
const GROUP_KEY_SEPARATOR = ' :: ';

/**
 * Oracle refuses to aggregate a CLOB — `MAX(someClob)` raises ORA-00932
 * ("inconsistent datatypes: expected - got CLOB"). Narrowing the column to a
 * VARCHAR2 first makes it aggregatable. 2000 characters is far more than any
 * Oracle error message needs and stays inside the 4000-byte VARCHAR2 limit.
 */
const CLOB_TO_TEXT = (column: string): string =>
  `DBMS_LOB.SUBSTR(${column}, 2000, 1)`;

function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * Coerces whatever a column yields into a number. Raw aggregate rows arrive as
 * strings or numbers, while entity reads hand back `Decimal` — accepting only
 * the primitives would silently score every Decimal amount as zero.
 */
function num(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' || typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (
    typeof value === 'object' &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function'
  ) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function worstOf(statuses: ReconciliationStatus[]): ReconciliationStatus {
  for (const candidate of SEVERITY) {
    if (statuses.includes(candidate)) return candidate;
  }
  return 'MATCHED';
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectRepository(BackupOdooOrder)
    private readonly odooOrders: Repository<BackupOdooOrder>,
    @InjectRepository(BackupOdooOrderLine)
    private readonly odooLines: Repository<BackupOdooOrderLine>,
    @InjectRepository(BackupOdooOrderPayment)
    private readonly odooPayments: Repository<BackupOdooOrderPayment>,
    @InjectRepository(FusionInvoiceHeader)
    private readonly invoiceHeaders: Repository<FusionInvoiceHeader>,
    @InjectRepository(FusionInvoiceLine)
    private readonly invoiceLines: Repository<FusionInvoiceLine>,
    @InjectRepository(FusionStandardReceipt)
    private readonly standardReceipts: Repository<FusionStandardReceipt>,
    @InjectRepository(FusionMiscReceipt)
    private readonly miscReceipts: Repository<FusionMiscReceipt>,
    @InjectRepository(OrderSyncQueue)
    private readonly queue: Repository<OrderSyncQueue>,
    @InjectRepository(PaymentMethodMapping)
    private readonly paymentMappings: Repository<PaymentMethodMapping>,
    // Optional: the stored comparison must keep working on a deployment with no
    // Oracle REST credentials. Only liveVerify() needs this.
    @Optional() private readonly oracle?: OracleClient,
  ) {}

  /**
   * Compare every Odoo order in the window against the Oracle rows we recorded
   * when pushing it, and report the differences.
   *
   * The whole window is compared (up to `maxScan`) so the summary is accurate,
   * then the rows are filtered and paginated for display — a summary computed
   * only over the visible page would be worse than no summary at all.
   */
  async reconcile(params: ReconciliationParams): Promise<{
    window: { startDate: string | null; endDate: string | null };
    tolerance: number;
    summary: ReconciliationSummary;
    rows: ReconciliationRow[];
    orphans: OrphanRow[];
    pagination: { total: number; limit: number; offset: number };
  }> {
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(0, params.offset ?? 0);

    const { rows, truncated, tolerance } = await this.scan(params);
    const orphans = await this.findOrphans(params);

    const summary = this.summarise(rows, truncated, orphans.length);

    const filtered = this.applyRowFilters(rows, params);
    // Worst first: the point of the screen is the exceptions, not the matches.
    filtered.sort(
      (a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status),
    );

    return {
      window: {
        startDate: params.startDate ?? null,
        endDate: params.endDate ?? null,
      },
      tolerance,
      summary,
      rows: filtered.slice(offset, offset + limit),
      orphans,
      pagination: { total: filtered.length, limit, offset },
    };
  }

  /**
   * The same comparison rolled up per store, per day, or per store-day, so a
   * variance can be traced to the outlet and the trading day that produced it
   * before drilling into the individual Odoo order references.
   *
   * Grouping happens over the whole scanned window, not the visible page —
   * a per-store total that only covered 50 orders would be actively misleading.
   */
  async breakdown(
    params: ReconciliationParams,
    groupBy: BreakdownGroupBy,
  ): Promise<{
    groupBy: BreakdownGroupBy;
    tolerance: number;
    scanned: number;
    truncated: boolean;
    rows: BreakdownRow[];
    totals: BreakdownRow;
  }> {
    const { rows, truncated, tolerance } = await this.scan(params);

    // Status filtering is deliberately not applied: a store's totals must cover
    // every order it booked, or the variance column stops reconciling.
    const groups = new Map<string, BreakdownAccumulator>();
    for (const row of rows) {
      const key = this.groupKey(row, groupBy);
      const group = groups.get(key) ?? this.emptyGroup(key, row, groupBy);
      this.accumulate(group, row);
      groups.set(key, group);
    }

    const list = [...groups.values()].map((g) => this.finaliseGroup(g));
    // Worst first: most problems, then biggest money variance.
    list.sort(
      (a, b) =>
        b.problems - a.problems ||
        Math.abs(b.variance) - Math.abs(a.variance) ||
        a.key.localeCompare(b.key),
    );

    const totals = this.emptyGroup('TOTAL', null, groupBy);
    for (const row of rows) this.accumulate(totals, row);

    return {
      groupBy,
      tolerance,
      scanned: rows.length,
      truncated,
      rows: list,
      totals: this.finaliseGroup(totals),
    };
  }

  /**
   * Reconciles takings by payment method, per store and per day.
   *
   * Odoo's side comes from the payment rows on each order; Oracle's from the
   * receipts it raised, numbered `<Method>-<transactionNumber>`. The
   * transaction number is resolved back to a store and day through the orders
   * billed on that invoice, so both sides land in the same bucket.
   */
  async tenderBreakdown(
    params: ReconciliationParams,
    groupBy: TenderGroupBy,
  ): Promise<{
    groupBy: TenderGroupBy;
    tolerance: number;
    scanned: number;
    truncated: boolean;
    rows: TenderRow[];
    totals: TenderRow;
    /** Tenders Odoo used that have no usable Oracle receipt method. */
    unmappedMethods: string[];
  }> {
    const { rows, truncated, tolerance } = await this.scan(params);

    const groups = new Map<string, TenderRow>();
    const bucketFor = (row: ReconciliationRow, method: string): TenderRow => {
      const withStore =
        groupBy === 'store-date-method' || groupBy === 'store-method';
      const withDate =
        groupBy === 'store-date-method' || groupBy === 'date-method';
      const parts: string[] = [];
      if (withStore) parts.push(this.storeKey(row));
      if (withDate) parts.push(this.dateKey(row));
      // Case-folded so a till spelling "Mada" and a receipt spelling "MADA"
      // are one tender rather than two half-empty rows.
      parts.push(method.toUpperCase());
      const key = parts.join(GROUP_KEY_SEPARATOR);

      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          branchCode: withStore ? row.odoo.branchCode : null,
          branchName: withStore
            ? (row.odoo.branchName ?? row.odoo.posConfigName)
            : null,
          region: row.odoo.region,
          date: withDate ? this.dateKey(row) : null,
          method,
          mappedMethod: null,
          mappingStatus: 'UNMAPPED',
          odooCount: 0,
          odooTotal: 0,
          oracleCount: 0,
          oracleTotal: 0,
          oracleFees: 0,
          variance: 0,
          partial: false,
          status: 'MATCHED',
        };
        groups.set(key, group);
      }
      return group;
    };

    // ── Odoo side: the tenders the till recorded ──────────────────────────
    const odooByMethod = await this.aggregateOdooPaymentsByMethod(
      rows.map((r) => r.odoo.orderId),
    );
    for (const row of rows) {
      const perMethod = odooByMethod.get(row.odoo.orderId);
      if (!perMethod) continue;
      for (const [method, agg] of perMethod) {
        const group = bucketFor(row, method);
        group.odooCount += agg.count;
        group.odooTotal += agg.total;
      }
    }

    // ── Oracle side: the receipts it actually raised ──────────────────────
    // One invoice can carry many orders; any of them locates the same bucket,
    // so the first order seen for a transaction number is enough.
    const txnToRow = new Map<string, ReconciliationRow>();
    for (const row of rows) {
      const txn = row.oracle?.invoiceNumber;
      if (txn && !txnToRow.has(txn)) txnToRow.set(txn, row);
    }
    // How much of each invoice the window actually captured. An invoice bills
    // `coversOrders` orders; if fewer than that were scanned, the Odoo takings
    // for it are necessarily short and no variance drawn from them is real.
    const scannedPerTxn = new Map<string, number>();
    for (const row of rows) {
      const txn = row.oracle?.invoiceNumber;
      if (txn) scannedPerTxn.set(txn, (scannedPerTxn.get(txn) ?? 0) + 1);
    }

    const receipts = await this.receiptsByTransaction([...txnToRow.keys()]);
    for (const receipt of receipts) {
      const row = txnToRow.get(receipt.txnNumber);
      if (!row) continue;
      const group = bucketFor(row, receipt.method);
      if (
        (scannedPerTxn.get(receipt.txnNumber) ?? 0) <
        (row.oracle?.coversOrders ?? 1)
      ) {
        group.partial = true;
      }
      if (receipt.isMisc) {
        group.oracleFees += receipt.amount;
      } else {
        group.oracleCount += 1;
        group.oracleTotal += receipt.amount;
      }
    }

    // ── Mapping status, so an unmapped tender is visible as such ──────────
    const mappings = await this.loadPaymentMappings();
    const unmapped = new Set<string>();
    // Tenders Oracle demonstrably receipts *somewhere* in this window. A method
    // that settles fine for one store is mapped, full stop — so when another
    // store shows nothing receipted for it, that store has a sync problem, not
    // a mapping problem. Judging this per row would label every unsynced store
    // "unmapped" and bury the tenders that genuinely have nowhere to post.
    const receiptedSomewhere = new Set<string>();
    for (const group of groups.values()) {
      if (group.oracleCount > 0) {
        receiptedSomewhere.add(group.method.toUpperCase());
      }
    }
    for (const group of groups.values()) {
      const mapping = mappings.get(group.method.toUpperCase());
      if (mapping) {
        group.mappedMethod = mapping.oracleName;
        group.mappingStatus = mapping.usable ? 'MAPPED' : 'PENDING';
        // A stale PENDING_MAPPING row is still worth showing on the row, but it
        // only belongs in the headline list if the tender is actually stuck.
        // Oracle receipting it elsewhere proves it is not.
        if (
          !mapping.usable &&
          !receiptedSomewhere.has(group.method.toUpperCase())
        ) {
          unmapped.add(group.method);
        }
      } else if (group.odooCount === 0 && group.oracleCount > 0) {
        // Oracle receipted a tender the till never reported under that name.
        group.mappingStatus = 'ORACLE_ONLY';
      } else if (receiptedSomewhere.has(group.method.toUpperCase())) {
        // Oracle receipts this tender elsewhere, so it is plainly mapped — just
        // not through PaymentMethodMapping, which only covers the ODOO source
        // system. VendHQ-sourced regions resolve their methods elsewhere.
        group.mappingStatus = 'MAPPED';
      } else {
        // Took money, nothing receipted, and no mapping to explain it.
        group.mappingStatus = 'UNMAPPED';
        unmapped.add(group.method);
      }
    }

    const list = [...groups.values()].map((g) =>
      this.finaliseTender(g, tolerance),
    );
    // Biggest money gap first — that is what a cash-up chases.
    list.sort(
      (a, b) =>
        Math.abs(b.variance) - Math.abs(a.variance) ||
        a.key.localeCompare(b.key),
    );

    const blank: TenderRow = {
      key: 'TOTAL',
      branchCode: null,
      branchName: null,
      region: null,
      date: null,
      method: 'All tenders',
      mappedMethod: null,
      mappingStatus: 'MAPPED',
      odooCount: 0,
      odooTotal: 0,
      oracleCount: 0,
      oracleTotal: 0,
      oracleFees: 0,
      variance: 0,
      partial: false,
      status: 'MATCHED',
    };
    for (const r of list) {
      blank.odooCount += r.odooCount;
      blank.odooTotal += r.odooTotal;
      blank.oracleCount += r.oracleCount;
      blank.oracleTotal += r.oracleTotal;
      blank.oracleFees += r.oracleFees;
      if (r.partial) blank.partial = true;
    }

    return {
      groupBy,
      tolerance,
      scanned: rows.length,
      truncated,
      rows: list,
      totals: this.finaliseTender(blank, tolerance),
      unmappedMethods: [...unmapped].sort(),
    };
  }

  /** Rounds once at the end and decides which way a tender is out. */
  private finaliseTender(group: TenderRow, tolerance: number): TenderRow {
    const odooTotal = round2(group.odooTotal);
    const oracleTotal = round2(group.oracleTotal);
    const variance = round2(odooTotal - oracleTotal);

    let status: TenderStatus;
    if (group.partial && Math.abs(variance) > tolerance) {
      // The gap is explained by the window, not by the systems disagreeing.
      status = 'INCOMPLETE';
    } else if (Math.abs(variance) <= tolerance) {
      status = 'MATCHED';
    } else if (group.oracleCount === 0) {
      status = 'MISSING_IN_ORACLE';
    } else if (group.odooCount === 0) {
      status = 'UNEXPECTED_IN_ORACLE';
    } else {
      status = variance > 0 ? 'SHORT_IN_ORACLE' : 'OVER_IN_ORACLE';
    }

    return {
      ...group,
      odooTotal,
      oracleTotal,
      oracleFees: round2(group.oracleFees),
      variance,
      status,
    };
  }

  /** Line-by-line view of a single order, for the drill-down panel. */
  async orderDetail(orderName: string, tolerance = DEFAULT_TOLERANCE) {
    const order = await this.odooOrders.findOne({
      where: { orderName },
    });
    if (!order) {
      throw new NotFoundException(
        `No Odoo order named "${orderName}" is stored`,
      );
    }

    const [row] = await this.buildRows([order], tolerance);

    const odooLines = await this.odooLines.find({
      where: { orderId: order.orderId },
      order: { lineId: 'ASC' },
    });
    const odooPayments = await this.odooPayments.find({
      where: { orderId: order.orderId },
    });
    const oracleLines = await this.invoiceLines.find({
      where: { salesOrder: orderName },
      order: { lineNumber: 'ASC' },
    });

    return {
      summary: row,
      odooLines: odooLines.map((l) => ({
        lineId: l.lineId,
        product: l.productName ?? l.lineName,
        productCode: l.productCode,
        qty: num(l.qty),
        priceUnit: num(l.priceUnit),
        subtotal: round2(num(l.priceSubtotal)),
        subtotalIncl: round2(num(l.priceSubtotalIncl)),
        taxName: l.taxName,
      })),
      oracleLines: oracleLines.map((l) => ({
        lineNumber: l.lineNumber,
        itemNumber: l.itemNumber,
        description: l.description,
        qty: num(l.quantity),
        uom: l.uom,
        taxCode: l.taxCode,
        status: l.status,
        invoiceNumber: l.invoiceNumber,
        message: l.message,
      })),
      odooPayments: odooPayments.map((p) => ({
        paymentId: p.paymentId,
        method: p.paymentName,
        amount: round2(num(p.amount)),
        currency: p.currency,
        paymentDate: p.paymentDate,
      })),
      oracleReceipts: await this.receiptsFor(orderName),
    };
  }

  /**
   * Reads the invoice back out of Oracle *right now* and compares it against
   * Odoo, instead of trusting the FusionInvoiceHeader row we wrote at push time.
   *
   * The stored audit trail only records what we sent. An invoice that Oracle
   * rejected after the fact, or that someone completed, credited or adjusted in
   * the Fusion UI, still looks perfect in our tables — this is the only check
   * that catches it. One Oracle call per order, so it is a per-order action
   * rather than something the window-wide scan does for thousands of rows.
   */
  async liveVerify(orderName: string, tolerance = DEFAULT_TOLERANCE) {
    if (!this.oracle) {
      throw new ServiceUnavailableException(
        'Live Oracle lookup is not available — no Oracle REST client is configured.',
      );
    }

    const order = await this.odooOrders.findOne({ where: { orderName } });
    if (!order) {
      throw new NotFoundException(
        `No Odoo order named "${orderName}" is stored`,
      );
    }
    const [row] = await this.buildRows([order], tolerance);

    // The transaction number Oracle knows this invoice by. Prefer what the
    // queue recorded, fall back to the audit header, then to the order name —
    // the transformer uses the order name as the txn number by default.
    const queued = await this.queue.findOne({
      where: { odooOrderNumber: orderName },
    });
    const txnNumber =
      queued?.oracleInvoiceNumber ?? row?.oracle?.invoiceNumber ?? orderName;

    const startedAt = Date.now();
    let live: OracleLiveInvoice | null = null;
    let lines: { totalCount: number; lines: OracleLiveInvoiceLine[] } | null =
      null;
    let lookupError: string | null = null;

    try {
      live = await this.oracle.getInvoiceByTransactionNumber(txnNumber);
      if (live?.customerTransactionId != null) {
        lines = await this.oracle.getInvoiceLines(
          live.customerTransactionId,
          AGGREGATE_LINE_FETCH,
        );
      }
    } catch (err) {
      // A pod that is down or slow is a fact to report, not a 500 — the stored
      // comparison beside it is still useful on its own.
      lookupError = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Live Oracle lookup failed for txn ${txnNumber}: ${lookupError}`,
      );
    }

    const allLines = lines?.lines ?? [];
    // A daily invoice carries every order the store booked that day, each line
    // tagged with its own SalesOrder. Comparing one Odoo order against the whole
    // invoice would report the other orders on it as a shortfall, so the
    // comparison is scoped to the lines that actually belong to this order.
    const ownLines = allLines.filter((l) => l.salesOrder === orderName);
    const coversOrders = new Set(
      allLines.map((l) => l.salesOrder).filter((v): v is string => v != null),
    );
    const isAggregate = coversOrders.size > 1;
    // Lines beyond the fetched page would understate this order's share, so a
    // truncated read is reported rather than compared.
    const linesTruncated = lines != null && lines.totalCount > allLines.length;

    // Both sides net of tax: Oracle's LineAmount excludes VAT, while the Odoo
    // order total includes it.
    const odooTotal = row?.odoo.total ?? 0;
    const odooNet = round2(odooTotal - (row?.odoo.tax ?? 0));
    const oracleNet =
      live && !linesTruncated
        ? round2(ownLines.reduce((sum, l) => sum + (l.lineAmount ?? 0), 0))
        : null;

    const amountDifference =
      oracleNet != null ? round2(odooNet - oracleNet) : null;
    const oracleLineCount = linesTruncated ? null : ownLines.length;
    const lineDifference =
      oracleLineCount != null
        ? (row?.odoo.lineCount ?? 0) - oracleLineCount
        : null;

    const issues: string[] = [];
    let status: LiveVerifyStatus;
    if (lookupError) {
      status = 'LOOKUP_FAILED';
      issues.push(`Oracle could not be reached: ${lookupError}`);
    } else if (!live) {
      status = 'NOT_IN_ORACLE';
      issues.push(
        `Oracle holds no invoice with transaction number ${txnNumber}.`,
      );
    } else if (linesTruncated) {
      status = 'MISMATCH';
      issues.push(
        `Oracle invoice has ${lines?.totalCount} lines, more than the ${AGGREGATE_LINE_FETCH} read in one page — this order's share cannot be totalled reliably.`,
      );
    } else if (ownLines.length === 0) {
      status = 'NOT_IN_ORACLE';
      issues.push(
        `Oracle invoice ${live.transactionNumber} exists but carries no line for sales order ${orderName}.`,
      );
    } else {
      if (amountDifference != null && Math.abs(amountDifference) > tolerance) {
        issues.push(
          `Odoo ${odooNet} net of tax vs Oracle ${oracleNet} on this order's lines (difference ${amountDifference}).`,
        );
      }
      if (lineDifference != null && lineDifference !== 0) {
        issues.push(
          `Odoo has ${row?.odoo.lineCount} line(s), Oracle has ${oracleLineCount} for this order.`,
        );
      }
      // The balance is a property of the whole invoice, so on an aggregate it
      // is reported as context rather than as this order's fault.
      if (
        live.balanceAmount != null &&
        Math.abs(live.balanceAmount) > tolerance
      ) {
        issues.push(
          isAggregate
            ? `Invoice ${live.transactionNumber} (shared by ${coversOrders.size} orders) still shows ${live.balanceAmount} outstanding.`
            : `Oracle still shows ${live.balanceAmount} outstanding on this invoice.`,
        );
      }
      if (live.status && live.status.toUpperCase() !== 'COMPLETE') {
        issues.push(`Oracle invoice status is "${live.status}".`);
      }
      status = issues.length === 0 ? 'VERIFIED' : 'MISMATCH';
    }

    // What we recorded at push time, so the caller can see whether our own
    // audit row drifted from Oracle as well as whether Odoo did.
    const stored = row?.oracle
      ? {
          invoiceNumber: row.oracle.invoiceNumber,
          status: row.oracle.status,
          total: row.oracle.total,
          lineCount: row.oracle.lineCount,
        }
      : null;

    return {
      orderName,
      txnNumber: String(txnNumber),
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      status,
      issues,
      tolerance,
      odoo: {
        total: odooTotal,
        /** Net of tax — the basis Oracle's LineAmount uses. */
        net: odooNet,
        tax: row?.odoo.tax ?? 0,
        lineCount: row?.odoo.lineCount ?? 0,
        paymentTotal: row?.odoo.paymentTotal ?? 0,
        orderDate: row?.odoo.orderDate ?? null,
        branchName: row?.odoo.branchName ?? null,
        state: row?.odoo.state ?? null,
      },
      stored,
      live: live
        ? {
            ...live,
            /** This order's share of the invoice. */
            orderNet: oracleNet,
            lineCount: oracleLineCount,
            lines: ownLines,
            invoice: {
              /** Every line on the invoice, across all orders it covers. */
              totalLineCount: lines?.totalCount ?? 0,
              coversOrders: coversOrders.size,
              isAggregate,
              linesTruncated,
            },
          }
        : null,
      amountDifference,
      lineDifference,
    };
  }

  // ── Loading ──────────────────────────────────────────────────────

  /**
   * Compares the whole window once. Every public entry point goes through here
   * so the summary, the store/date roll-ups and the order list can never
   * disagree about what was compared.
   */
  private async scan(params: ReconciliationParams): Promise<{
    rows: ReconciliationRow[];
    truncated: boolean;
    tolerance: number;
  }> {
    const tolerance = Math.max(0, params.tolerance ?? DEFAULT_TOLERANCE);
    const maxScan = Math.min(params.maxScan ?? DEFAULT_MAX_SCAN, HARD_MAX_SCAN);

    const orders = await this.loadOdooOrders(params, maxScan + 1);
    const truncated = orders.length > maxScan;
    const scanned = truncated ? orders.slice(0, maxScan) : orders;

    return {
      rows: await this.buildRows(scanned, tolerance),
      truncated,
      tolerance,
    };
  }

  private async loadOdooOrders(
    params: ReconciliationParams,
    take: number,
  ): Promise<BackupOdooOrder[]> {
    const qb = this.odooOrders
      .createQueryBuilder('o')
      .select([
        'o.id',
        'o.orderId',
        'o.orderName',
        'o.branchName',
        'o.region',
        'o.dateOrder',
        'o.amountTotal',
        'o.amountUntaxed',
        'o.amountTax',
        'o.amountDiscount',
        'o.state',
        'o.resolvedBranchCode',
        'o.posConfigName',
      ])
      .orderBy('o.dateOrder', 'DESC')
      .take(take);

    if (params.startDate) {
      qb.andWhere('o.dateOrder >= :start', {
        start: new Date(params.startDate),
      });
    }
    if (params.endDate) {
      qb.andWhere('o.dateOrder <= :end', {
        end: this.endOfDay(params.endDate),
      });
    }
    if (params.region) {
      qb.andWhere('o.region = :region', { region: params.region });
    }
    if (params.branchCode) {
      qb.andWhere('o.resolvedBranchCode = :branchCode', {
        branchCode: params.branchCode,
      });
    }
    if (params.store) {
      qb.andWhere(
        '(o.resolvedBranchCode = :store OR o.branchName = :store OR o.posConfigName = :store)',
        { store: params.store },
      );
    }
    if (params.search) {
      qb.andWhere(
        '(UPPER(o.orderName) LIKE UPPER(:search) OR TO_CHAR(o.orderId) LIKE :search)',
        { search: `%${params.search}%` },
      );
    }
    return qb.getMany();
  }

  private async buildRows(
    orders: BackupOdooOrder[],
    tolerance: number,
  ): Promise<ReconciliationRow[]> {
    if (orders.length === 0) return [];

    const orderIds = orders.map((o) => o.orderId);
    // orderName is the join key across all three systems (OrderSyncQueue's
    // odooOrderNumber and FusionInvoiceLine's salesOrder both carry it); the
    // numeric id is the fallback Odoo uses for unnamed orders.
    const orderNames = orders.map((o) => o.orderName ?? String(o.orderId));

    const [lineAgg, paymentAgg, oracleLineAgg, queueRows] = await Promise.all([
      this.aggregateOdooLines(orderIds),
      this.aggregateOdooPayments(orderIds),
      this.aggregateOracleLines(orderNames),
      this.loadQueueRows(orderNames),
    ]);

    const headerIds = [...oracleLineAgg.values()]
      .map((a) => a.headerId)
      .filter((id): id is string => id != null);
    const headers = await this.loadHeaders(headerIds);
    const headerOrderCounts = await this.loadHeaderOrderCounts(headerIds);
    const receipts = await this.aggregateReceipts(orderNames);

    return orders.map((order) => {
      const orderName = order.orderName ?? String(order.orderId);
      const lines = lineAgg.get(order.orderId);
      const payments = paymentAgg.get(order.orderId);
      const oracleAgg = oracleLineAgg.get(orderName);
      const header = oracleAgg?.headerId
        ? headers.get(oracleAgg.headerId)
        : null;
      const receipt = receipts.get(orderName);
      const queueRow = queueRows.get(orderName);

      const odoo: OdooSide = {
        orderId: order.orderId,
        orderName,
        branchCode: order.resolvedBranchCode ?? null,
        branchName: order.branchName,
        posConfigName: order.posConfigName ?? null,
        region: order.region ?? null,
        orderDate: order.dateOrder,
        state: order.state,
        total: round2(num(order.amountTotal)),
        untaxed: round2(num(order.amountUntaxed)),
        tax: round2(num(order.amountTax)),
        discount: round2(num(order.amountDiscount)),
        lineCount: lines?.count ?? 0,
        lineTotal: round2(lines?.total ?? 0),
        paymentCount: payments?.count ?? 0,
        paymentTotal: round2(payments?.total ?? 0),
      };

      const oracle: OracleSide | null = oracleAgg
        ? {
            headerId: oracleAgg.headerId,
            invoiceNumber: oracleAgg.invoiceNumber,
            status: header?.status ?? oracleAgg.status,
            txnDate: header?.txnDate ?? null,
            glDate: header?.glDate ?? null,
            total:
              header?.totalAmount != null
                ? round2(num(header.totalAmount))
                : null,
            coversOrders: oracleAgg.headerId
              ? (headerOrderCounts.get(oracleAgg.headerId) ?? 1)
              : 1,
            isAggregate:
              (oracleAgg.headerId
                ? (headerOrderCounts.get(oracleAgg.headerId) ?? 1)
                : 1) > 1,
            lineCount: oracleAgg.count,
            receiptTotal: receipt ? round2(receipt.total) : null,
            receiptCount: receipt?.count ?? 0,
            message: header?.message ?? oracleAgg.message,
          }
        : null;

      return this.classify(odoo, oracle, queueRow, tolerance);
    });
  }

  private classify(
    odoo: OdooSide,
    oracle: OracleSide | null,
    queueRow: { status: string; validationErrors: unknown } | undefined,
    tolerance: number,
  ): ReconciliationRow {
    const issues: string[] = [];
    const statuses: ReconciliationStatus[] = [];

    const state = (odoo.state ?? '').toLowerCase().trim();
    const isCancelled = state === 'cancel' || state === 'cancelled';
    const syncable =
      !isCancelled &&
      (state === '' ||
        (PAID_ORDER_STATES as readonly string[]).includes(state));

    const queueError =
      queueRow?.validationErrors != null
        ? typeof queueRow.validationErrors === 'string'
          ? queueRow.validationErrors
          : JSON.stringify(queueRow.validationErrors)
        : null;

    if (!syncable) {
      if (oracle) {
        // A cancelled or unpaid order that reached Oracle is money booked that
        // should not have been — the single most expensive kind of mismatch.
        statuses.push('UNEXPECTED_IN_ORACLE');
        issues.push(
          `Odoo state "${odoo.state ?? 'unknown'}" is not syncable, yet Oracle invoice ` +
            `${oracle.invoiceNumber ?? '(unnumbered)'} exists`,
        );
      } else {
        statuses.push('NOT_SYNCABLE');
        issues.push(
          `Not expected in Oracle (Odoo state "${odoo.state ?? 'unknown'}")`,
        );
      }
      return this.finish(odoo, oracle, queueRow, queueError, statuses, issues);
    }

    if (!oracle) {
      statuses.push('MISSING_IN_ORACLE');
      issues.push(
        queueRow
          ? `Not in Oracle — sync queue status is ${queueRow.status}`
          : 'Not in Oracle and never entered the sync queue',
      );
      if (queueError) issues.push(`Queue error: ${queueError}`);
      return this.finish(odoo, oracle, queueRow, queueError, statuses, issues);
    }

    if (oracle.status && oracle.status.toUpperCase() === 'ERROR') {
      statuses.push('ORACLE_ERROR');
      issues.push(
        `Oracle rejected the invoice${oracle.message ? `: ${oracle.message}` : ''}`,
      );
    }

    // Money is only comparable when the invoice bills this order alone. On an
    // aggregated daily invoice the header total covers every order on it, and
    // our FusionInvoiceLine rows carry no amount, so this order's share simply
    // is not knowable from stored data — the live Oracle check reads the real
    // per-line amounts and is the answer there.
    const amountDifference =
      oracle.total != null && !oracle.isAggregate
        ? round2(odoo.total - oracle.total)
        : null;
    if (amountDifference != null && Math.abs(amountDifference) > tolerance) {
      statuses.push('AMOUNT_MISMATCH');
      issues.push(
        `Total differs by ${amountDifference.toFixed(2)} (Odoo ${odoo.total.toFixed(2)} vs Oracle ${oracle.total!.toFixed(2)})`,
      );
    } else if (oracle.isAggregate) {
      issues.push(
        `Billed on shared invoice ${oracle.invoiceNumber ?? '?'} covering ${oracle.coversOrders} orders — run the live Oracle check to verify this order's share`,
      );
    }

    // Receipts are matched by the number we generated when pushing; Oracle can
    // renumber them, so an unmatched receipt is "unknown", never "zero paid".
    const paymentDifference =
      oracle.receiptTotal != null
        ? round2(odoo.paymentTotal - oracle.receiptTotal)
        : null;
    if (paymentDifference != null && Math.abs(paymentDifference) > tolerance) {
      statuses.push('PAYMENT_MISMATCH');
      issues.push(
        `Payments differ by ${paymentDifference.toFixed(2)} (Odoo ${odoo.paymentTotal.toFixed(2)} vs Oracle receipts ${oracle.receiptTotal!.toFixed(2)})`,
      );
    }

    const lineDifference = odoo.lineCount - oracle.lineCount;
    // Discounts, rounding and service-fee lines legitimately collapse on the
    // Oracle side, so only flag a shortfall when Oracle has fewer lines than
    // Odoo booked and money is involved.
    if (odoo.lineCount > 0 && oracle.lineCount === 0) {
      statuses.push('LINE_MISMATCH');
      issues.push(
        `Odoo has ${odoo.lineCount} line(s); Oracle invoice has none`,
      );
    } else if (lineDifference !== 0) {
      statuses.push('LINE_MISMATCH');
      issues.push(
        `Line count differs: Odoo ${odoo.lineCount} vs Oracle ${oracle.lineCount}`,
      );
    }

    if (statuses.length === 0) issues.push('Odoo and Oracle agree');

    return this.finish(odoo, oracle, queueRow, queueError, statuses, issues);
  }

  private finish(
    odoo: OdooSide,
    oracle: OracleSide | null,
    queueRow: { status: string } | undefined,
    queueError: string | null,
    statuses: ReconciliationStatus[],
    issues: string[],
  ): ReconciliationRow {
    return {
      orderName: odoo.orderName,
      odoo,
      oracle,
      queueStatus: queueRow?.status ?? null,
      queueError,
      status: worstOf(statuses),
      // Same rule as the comparison in classify(): a total shared with other
      // orders is not this order's to differ from, so the difference is
      // unknown rather than huge. Keep the two in step.
      amountDifference:
        oracle?.total != null && !oracle.isAggregate
          ? round2(odoo.total - oracle.total)
          : null,
      paymentDifference:
        oracle?.receiptTotal != null
          ? round2(odoo.paymentTotal - oracle.receiptTotal)
          : null,
      lineDifference: oracle ? odoo.lineCount - oracle.lineCount : null,
      issues,
    };
  }

  // ── Aggregates ───────────────────────────────────────────────────

  private async aggregateOdooLines(orderIds: number[]) {
    const out = new Map<number, { count: number; total: number }>();
    for (const part of chunk(orderIds)) {
      const rows = await this.odooLines
        .createQueryBuilder('l')
        .select('l.orderId', 'orderId')
        .addSelect('COUNT(*)', 'cnt')
        .addSelect('SUM(l.priceSubtotalIncl)', 'total')
        .where('l.orderId IN (:...ids)', { ids: part })
        .groupBy('l.orderId')
        .getRawMany<{ orderId: number; cnt: string; total: string }>();
      for (const r of rows) {
        out.set(num(r.orderId), { count: num(r.cnt), total: num(r.total) });
      }
    }
    return out;
  }

  private async aggregateOdooPayments(orderIds: number[]) {
    const out = new Map<number, { count: number; total: number }>();
    for (const part of chunk(orderIds)) {
      const rows = await this.odooPayments
        .createQueryBuilder('p')
        .select('p.orderId', 'orderId')
        .addSelect('COUNT(*)', 'cnt')
        .addSelect('SUM(p.amount)', 'total')
        .where('p.orderId IN (:...ids)', { ids: part })
        .groupBy('p.orderId')
        .getRawMany<{ orderId: number; cnt: string; total: string }>();
      for (const r of rows) {
        out.set(num(r.orderId), { count: num(r.cnt), total: num(r.total) });
      }
    }
    return out;
  }

  private async aggregateOracleLines(orderNames: string[]) {
    const out = new Map<
      string,
      {
        count: number;
        headerId: string | null;
        invoiceNumber: string | null;
        status: string | null;
        message: string | null;
      }
    >();
    for (const part of chunk(orderNames)) {
      const rows = await this.invoiceLines
        .createQueryBuilder('l')
        .select('l.salesOrder', 'salesOrder')
        .addSelect('COUNT(*)', 'cnt')
        .addSelect('MAX(l.headerId)', 'headerId')
        .addSelect('MAX(l.invoiceNumber)', 'invoiceNumber')
        .addSelect('MAX(l.status)', 'status')
        .where('l.salesOrder IN (:...names)', { names: part })
        .groupBy('l.salesOrder')
        .getRawMany<{
          salesOrder: string;
          cnt: string;
          headerId: string | null;
          invoiceNumber: string | null;
          status: string | null;
        }>();
      for (const r of rows) {
        out.set(r.salesOrder, {
          count: num(r.cnt),
          headerId: r.headerId,
          invoiceNumber: r.invoiceNumber,
          status: r.status,
          message: null,
        });
      }
    }

    // Second pass: a group with even one ERROR line is an error, but MAX() over
    // status cannot express that ('SUCCESS' sorts above 'ERROR'). One extra
    // query keeps the common path cheap and the verdict correct.
    for (const part of chunk(orderNames)) {
      const errored = await this.invoiceLines
        .createQueryBuilder('l')
        .select('l.salesOrder', 'salesOrder')
        .addSelect(`MAX(${CLOB_TO_TEXT('l.message')})`, 'message')
        .where('l.salesOrder IN (:...names)', { names: part })
        .andWhere(`UPPER(l.status) = 'ERROR'`)
        .groupBy('l.salesOrder')
        .getRawMany<{ salesOrder: string; message: string | null }>();
      for (const r of errored) {
        const entry = out.get(r.salesOrder);
        if (entry) {
          entry.status = 'ERROR';
          entry.message = r.message;
        }
      }
    }
    return out;
  }

  /**
   * How many distinct Odoo orders each invoice header bills.
   *
   * The daily-invoice path posts one Oracle transaction per store per day, so a
   * header routinely covers dozens of orders. Without this count the comparison
   * measures every one of those orders against the whole day's total and calls
   * each of them a shortfall.
   */
  private async loadHeaderOrderCounts(
    headerIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const part of chunk([...new Set(headerIds)])) {
      const rows = await this.invoiceLines
        .createQueryBuilder('l')
        .select('l.headerId', 'headerId')
        .addSelect('COUNT(DISTINCT l.salesOrder)', 'orders')
        .where('l.headerId IN (:...ids)', { ids: part })
        .groupBy('l.headerId')
        .getRawMany<{ headerId: string; orders: string }>();
      for (const r of rows) out.set(r.headerId, num(r.orders));
    }
    return out;
  }

  private async loadHeaders(headerIds: string[]) {
    const out = new Map<string, FusionInvoiceHeader>();
    for (const part of chunk([...new Set(headerIds)])) {
      const rows = await this.invoiceHeaders.find({ where: { id: In(part) } });
      for (const h of rows) out.set(h.id, h);
    }
    return out;
  }

  private async loadQueueRows(orderNames: string[]) {
    const out = new Map<
      string,
      { status: string; validationErrors: unknown }
    >();
    for (const part of chunk(orderNames)) {
      const rows = await this.queue.find({
        where: { odooOrderNumber: In(part) },
        select: {
          odooOrderNumber: true,
          status: true,
          validationErrors: true,
        },
      });
      for (const r of rows) {
        out.set(r.odooOrderNumber, {
          status: r.status,
          validationErrors: r.validationErrors,
        });
      }
    }
    return out;
  }

  /**
   * Receipts carry no order id — they are numbered `<method>-<order>` (plus a
   * `-MISC` suffix for miscellaneous receipts) when pushed. Matching on that
   * suffix is the only link available, and Oracle may replace the number
   * entirely, so a miss means "cannot verify", handled by the caller.
   */
  /**
   * Odoo payments split by tender name, per order.
   *
   * `paymentName` is the till's own label ("Mada", "Cash"); it is normalised
   * only for grouping, never for display, so an operator still recognises it.
   */
  private async aggregateOdooPaymentsByMethod(
    orderIds: number[],
  ): Promise<Map<number, Map<string, { count: number; total: number }>>> {
    const out = new Map<
      number,
      Map<string, { count: number; total: number }>
    >();
    if (orderIds.length === 0) return out;

    for (const part of chunk([...new Set(orderIds)])) {
      const rows = await this.odooPayments
        .createQueryBuilder('p')
        .select('p.orderId', 'orderId')
        .addSelect('p.paymentName', 'method')
        .addSelect('COUNT(*)', 'cnt')
        .addSelect('SUM(p.amount)', 'total')
        .where('p.orderId IN (:...ids)', { ids: part })
        .groupBy('p.orderId')
        .addGroupBy('p.paymentName')
        .getRawMany<{
          orderId: number;
          method: string | null;
          cnt: string;
          total: string;
        }>();

      for (const r of rows) {
        const orderId = num(r.orderId);
        const method = (r.method ?? '').trim() || UNKNOWN_TENDER;
        const perOrder =
          out.get(orderId) ??
          new Map<string, { count: number; total: number }>();
        const entry = perOrder.get(method) ?? { count: 0, total: 0 };
        entry.count += num(r.cnt);
        entry.total += num(r.total);
        perOrder.set(method, entry);
        out.set(orderId, perOrder);
      }
    }
    return out;
  }

  /**
   * Oracle receipts for a set of invoice transaction numbers, with the tender
   * recovered from the receipt number.
   *
   * The number is built as `<Method>-<txnNumber>` (plus `-MISC` for a fee), so
   * the tender is everything left of the final `-<txnNumber>` occurrence.
   * Splitting on the first `-` instead would mangle a method like
   * "Credit-Card"; anchoring on the transaction number cannot.
   */
  private async receiptsByTransaction(txnNumbers: string[]): Promise<
    Array<{
      txnNumber: string;
      method: string;
      amount: number;
      isMisc: boolean;
    }>
  > {
    const out: Array<{
      txnNumber: string;
      method: string;
      amount: number;
      isMisc: boolean;
    }> = [];
    if (txnNumbers.length === 0) return out;

    const collect = async (
      repo: Repository<FusionStandardReceipt> | Repository<FusionMiscReceipt>,
      alias: string,
      isMisc: boolean,
    ) => {
      for (const part of chunk(txnNumbers, 200)) {
        const qb = repo
          .createQueryBuilder(alias)
          .select(`${alias}.receiptNumber`, 'receiptNumber')
          .addSelect(`${alias}.receiptAmount`, 'receiptAmount')
          // A rejected receipt never moved money, so it must not count as
          // takings — but it also must not hide a genuine shortfall.
          .where(`UPPER(${alias}.status) <> 'ERROR'`);
        qb.andWhere(
          `(${part
            .map((_, i) => `${alias}.receiptNumber LIKE :t${i}`)
            .join(' OR ')})`,
          Object.fromEntries(part.map((txn, i) => [`t${i}`, `%-${txn}%`])),
        );
        const rows = await qb.getRawMany<{
          receiptNumber: string | null;
          receiptAmount: string | null;
        }>();

        for (const r of rows) {
          const receiptNumber = r.receiptNumber ?? '';
          // Longest match wins, so `-2975` cannot claim `-29751`'s receipt.
          let matched: string | null = null;
          for (const txn of part) {
            if (
              receiptNumber.includes(`-${txn}`) &&
              (matched == null || txn.length > matched.length)
            ) {
              matched = txn;
            }
          }
          if (!matched) continue;
          const cut = receiptNumber.lastIndexOf(`-${matched}`);
          const method = receiptNumber.slice(0, cut).trim() || UNKNOWN_TENDER;
          out.push({
            txnNumber: matched,
            method,
            amount: num(r.receiptAmount),
            isMisc,
          });
        }
      }
    };

    await collect(this.standardReceipts, 'sr', false);
    await collect(this.miscReceipts, 'mr', true);
    return out;
  }

  /**
   * Odoo tender name → the Oracle receipt method it resolves to.
   *
   * A mapping that is inactive or still parked on PENDING_MAPPING is loaded but
   * marked unusable: those tenders are exactly the ones that block orders, so
   * hiding them would remove the reason a store fails to reconcile.
   */
  private async loadPaymentMappings(): Promise<
    Map<string, { oracleName: string; usable: boolean }>
  > {
    const out = new Map<string, { oracleName: string; usable: boolean }>();
    const rows = await this.paymentMappings.find();
    for (const m of rows) {
      const usable =
        m.isActive && m.oracleReceiptMethodName !== 'PENDING_MAPPING';
      out.set(m.sourcePaymentName.trim().toUpperCase(), {
        oracleName: m.oracleReceiptMethodName,
        usable,
      });
    }
    return out;
  }

  private async aggregateReceipts(orderNames: string[]) {
    const out = new Map<string, { count: number; total: number }>();

    const collect = async (
      repo: Repository<FusionStandardReceipt> | Repository<FusionMiscReceipt>,
      alias: string,
    ) => {
      for (const part of chunk(orderNames, 200)) {
        const qb = repo
          .createQueryBuilder(alias)
          .select(`${alias}.receiptNumber`, 'receiptNumber')
          .addSelect(`${alias}.receiptAmount`, 'receiptAmount')
          .where(`UPPER(${alias}.status) <> 'ERROR'`);
        qb.andWhere(
          `(${part
            .map((_, i) => `${alias}.receiptNumber LIKE :p${i}`)
            .join(' OR ')})`,
          Object.fromEntries(part.map((name, i) => [`p${i}`, `%-${name}%`])),
        );
        const rows = await qb.getRawMany<{
          receiptNumber: string | null;
          receiptAmount: string | null;
        }>();

        for (const r of rows) {
          const receiptNumber = r.receiptNumber ?? '';
          // A receipt number embeds exactly one order name; pick the longest
          // match so `POS-1` cannot claim `POS-12`'s receipt.
          let matched: string | null = null;
          for (const name of part) {
            if (
              receiptNumber.includes(`-${name}`) &&
              (matched == null || name.length > matched.length)
            ) {
              matched = name;
            }
          }
          if (!matched) continue;
          const entry = out.get(matched) ?? { count: 0, total: 0 };
          entry.count += 1;
          entry.total += num(r.receiptAmount);
          out.set(matched, entry);
        }
      }
    };

    await collect(this.standardReceipts, 'sr');
    await collect(this.miscReceipts, 'mr');
    return out;
  }

  private async receiptsFor(orderName: string) {
    // LIKE has no equivalent in the `where` object form, so use the builder.
    // The pattern is a coarse pre-filter: `_` and `%` in an order name are LIKE
    // wildcards, so the literal check below decides what actually belongs here.
    const pattern = `%-${orderName}%`;
    const belongs = (receiptNumber: string | null) =>
      (receiptNumber ?? '').includes(`-${orderName}`);

    const [std, mi] = await Promise.all([
      this.standardReceipts
        .createQueryBuilder('sr')
        .where('sr.receiptNumber LIKE :p', { p: pattern })
        .getMany()
        .then((rows) => rows.filter((r) => belongs(r.receiptNumber))),
      this.miscReceipts
        .createQueryBuilder('mr')
        .where('mr.receiptNumber LIKE :p', { p: pattern })
        .getMany()
        .then((rows) => rows.filter((r) => belongs(r.receiptNumber))),
    ]);

    return [
      ...std.map((r) => ({
        kind: 'STANDARD' as const,
        receiptNumber: r.receiptNumber,
        amount: round2(num(r.receiptAmount)),
        receiptDate: r.receiptDate,
        status: r.status,
        message: r.message,
      })),
      ...mi.map((r) => ({
        kind: 'MISC' as const,
        receiptNumber: r.receiptNumber,
        amount: round2(num(r.receiptAmount)),
        receiptDate: r.receiptDate,
        status: r.status,
        message: r.message,
      })),
    ];
  }

  /**
   * Invoice lines in Oracle whose sales order has no Odoo backup row — the
   * mirror image of MISSING_IN_ORACLE, and the case that inflates Oracle
   * revenue rather than understating it.
   */
  private async findOrphans(
    params: ReconciliationParams,
  ): Promise<OrphanRow[]> {
    const qb = this.invoiceLines
      .createQueryBuilder('l')
      .select('l.salesOrder', 'salesOrder')
      .addSelect('COUNT(*)', 'cnt')
      .addSelect('MAX(l.invoiceNumber)', 'invoiceNumber')
      .addSelect('MAX(l.region)', 'region')
      .addSelect('MIN(l.createdAt)', 'firstSeen')
      .where('l.salesOrder IS NOT NULL')
      .andWhere(
        // The correlated reference is written as `l.salesOrder`, not
        // `l."salesOrder"`: TypeORM only rewrites the bare `alias.property`
        // form into the quoted `"l"."salesOrder"` it actually emits. Pre-quoting
        // the column defeats that rewrite, leaving a bare `l` that Oracle folds
        // to `L` and then rejects (ORA-00904) because the alias is quoted lower.
        `NOT EXISTS (SELECT 1 FROM "BackupOdooOrder" bo WHERE bo."orderName" = l.salesOrder)`,
      )
      .groupBy('l.salesOrder')
      .orderBy('MIN(l.createdAt)', 'DESC')
      // limit(), not take(): take() is entity pagination and wraps the query in
      // a DISTINCT id sub-select, which a raw GROUP BY projection has no id for.
      .limit(ORPHAN_LIMIT);

    if (params.startDate) {
      qb.andWhere('l.createdAt >= :start', {
        start: new Date(params.startDate),
      });
    }
    if (params.endDate) {
      qb.andWhere('l.createdAt <= :end', {
        end: this.endOfDay(params.endDate),
      });
    }
    if (params.region) {
      qb.andWhere('l.region = :region', { region: params.region });
    }

    const rows = await qb.getRawMany<{
      salesOrder: string;
      cnt: string;
      invoiceNumber: string | null;
      region: string | null;
      firstSeen: Date | null;
    }>();

    return rows.map((r) => ({
      salesOrder: r.salesOrder,
      invoiceNumber: r.invoiceNumber,
      region: r.region,
      lineCount: num(r.cnt),
      firstSeen: r.firstSeen,
    }));
  }

  // ── Shaping ──────────────────────────────────────────────────────

  private summarise(
    rows: ReconciliationRow[],
    truncated: boolean,
    orphanCount: number,
  ): ReconciliationSummary {
    const counts = Object.fromEntries(SEVERITY.map((s) => [s, 0])) as Record<
      ReconciliationStatus,
      number
    >;

    let odooTotal = 0;
    let oracleTotal = 0;
    const countedHeaders = new Set<string>();
    let aggregatedOrders = 0;
    for (const row of rows) {
      counts[row.status] += 1;
      odooTotal += row.odoo.total;
      if (row.oracle?.isAggregate) aggregatedOrders += 1;
      // One invoice can bill many orders. Adding its total once per order
      // would multiply the Oracle side by the number of orders sharing it.
      if (row.oracle?.headerId) {
        if (!countedHeaders.has(row.oracle.headerId)) {
          countedHeaders.add(row.oracle.headerId);
          oracleTotal += row.oracle.total ?? 0;
        }
      } else {
        oracleTotal += row.oracle?.total ?? 0;
      }
    }

    const problems = PROBLEM_STATUSES.reduce((sum, s) => sum + counts[s], 0);
    const comparable = rows.length - counts.NOT_SYNCABLE;

    return {
      scanned: rows.length,
      truncated,
      counts,
      problems,
      odooTotal: round2(odooTotal),
      oracleTotal: round2(oracleTotal),
      variance: round2(odooTotal - oracleTotal),
      matchRate:
        comparable > 0 ? round2((counts.MATCHED / comparable) * 100) : 100,
      orphanCount,
      aggregatedOrders,
    };
  }

  /** `YYYY-MM-DD` for the trading day an order belongs to. */
  private dateKey(row: ReconciliationRow): string {
    const date = row.odoo.orderDate;
    return date ? date.toISOString().slice(0, 10) : 'unknown-date';
  }

  /** Identifies a store even when only one of code / name / POS config is set. */
  private storeKey(row: ReconciliationRow): string {
    return (
      row.odoo.branchCode ??
      row.odoo.branchName ??
      row.odoo.posConfigName ??
      'unknown-store'
    );
  }

  private groupKey(row: ReconciliationRow, groupBy: BreakdownGroupBy): string {
    if (groupBy === 'date') return this.dateKey(row);
    if (groupBy === 'store') return this.storeKey(row);
    return `${this.storeKey(row)}${GROUP_KEY_SEPARATOR}${this.dateKey(row)}`;
  }

  private emptyGroup(
    key: string,
    row: ReconciliationRow | null,
    groupBy: BreakdownGroupBy,
  ): BreakdownAccumulator {
    const bySide = groupBy !== 'date';
    return {
      key,
      branchCode: bySide ? (row?.odoo.branchCode ?? null) : null,
      branchName: bySide
        ? (row?.odoo.branchName ?? row?.odoo.posConfigName ?? null)
        : null,
      region: row?.odoo.region ?? null,
      date: groupBy === 'store' ? null : row ? this.dateKey(row) : null,
      orders: 0,
      counts: Object.fromEntries(SEVERITY.map((s) => [s, 0])) as Record<
        ReconciliationStatus,
        number
      >,
      problems: 0,
      matchRate: 0,
      odooTotal: 0,
      oracleTotal: 0,
      variance: 0,
      odooPayments: 0,
      oracleReceipts: 0,
      unlinkedReceiptOrders: 0,
      countedHeaders: new Set<string>(),
    };
  }

  private accumulate(
    group: BreakdownAccumulator,
    row: ReconciliationRow,
  ): void {
    group.orders += 1;
    group.counts[row.status] += 1;
    group.odooTotal += row.odoo.total;
    // Each shared invoice contributes to a group once, not once per order.
    if (row.oracle?.headerId) {
      if (!group.countedHeaders.has(row.oracle.headerId)) {
        group.countedHeaders.add(row.oracle.headerId);
        group.oracleTotal += row.oracle.total ?? 0;
      }
    } else {
      group.oracleTotal += row.oracle?.total ?? 0;
    }
    group.odooPayments += row.odoo.paymentTotal;
    if (row.oracle?.receiptTotal != null) {
      group.oracleReceipts += row.oracle.receiptTotal;
    } else if (row.oracle) {
      group.unlinkedReceiptOrders += 1;
    }
  }

  /** Rounds once at the end so a group of pennies does not drift. */
  private finaliseGroup(group: BreakdownAccumulator): BreakdownRow {
    const problems = PROBLEM_STATUSES.reduce(
      (sum, s) => sum + group.counts[s],
      0,
    );
    const comparable = group.orders - group.counts.NOT_SYNCABLE;
    const { countedHeaders: _dedupe, ...rest } = group;
    void _dedupe;
    return {
      ...rest,
      problems,
      matchRate:
        comparable > 0
          ? round2((group.counts.MATCHED / comparable) * 100)
          : 100,
      odooTotal: round2(group.odooTotal),
      oracleTotal: round2(group.oracleTotal),
      variance: round2(group.odooTotal - group.oracleTotal),
      odooPayments: round2(group.odooPayments),
      oracleReceipts: round2(group.oracleReceipts),
    };
  }

  private applyRowFilters(
    rows: ReconciliationRow[],
    params: ReconciliationParams,
  ): ReconciliationRow[] {
    let out = rows;
    if (params.status && params.status !== 'ALL') {
      if (params.status === 'PROBLEMS') {
        out = out.filter((r) => PROBLEM_STATUSES.includes(r.status));
      } else {
        out = out.filter((r) => r.status === params.status);
      }
    }
    if (params.search) {
      const needle = params.search.toLowerCase();
      out = out.filter(
        (r) =>
          r.orderName.toLowerCase().includes(needle) ||
          String(r.odoo.orderId).includes(needle) ||
          (r.oracle?.invoiceNumber ?? '').toLowerCase().includes(needle),
      );
    }
    return out;
  }

  /** An end date of `2026-08-27` must include everything that day, not midnight. */
  private endOfDay(value: string): Date {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
      date.setUTCHours(23, 59, 59, 999);
    }
    return date;
  }
}
