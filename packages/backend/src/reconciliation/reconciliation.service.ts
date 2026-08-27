import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { PAID_ORDER_STATES } from '../common/odoo-utils';
import { round2 } from '../common/money';

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
  total: number | null;
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

export type BreakdownGroupBy = 'store' | 'date' | 'store-date';

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
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_MAX_SCAN = 2000;
const HARD_MAX_SCAN = 20000;
const DEFAULT_TOLERANCE = 0.01;
const ORPHAN_LIMIT = 200;
/** Oracle caps an IN-list at 1000 bind values. */
const IN_CHUNK = 900;

/**
 * Joins the store and date halves of a composite group key. A printable,
 * unmistakable separator rather than a space: store names contain spaces, so
 * a space would make `Dubai Mall 2026-08-20` ambiguous to split back apart.
 */
const GROUP_KEY_SEPARATOR = ' :: ';

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
    const groups = new Map<string, BreakdownRow>();
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

    const amountDifference =
      oracle.total != null ? round2(odoo.total - oracle.total) : null;
    if (amountDifference != null && Math.abs(amountDifference) > tolerance) {
      statuses.push('AMOUNT_MISMATCH');
      issues.push(
        `Total differs by ${amountDifference.toFixed(2)} (Odoo ${odoo.total.toFixed(2)} vs Oracle ${oracle.total!.toFixed(2)})`,
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
      amountDifference:
        oracle?.total != null ? round2(odoo.total - oracle.total) : null,
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
        .addSelect('MAX(l.message)', 'message')
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
        `NOT EXISTS (SELECT 1 FROM "BackupOdooOrder" bo WHERE bo."orderName" = l."salesOrder")`,
      )
      .groupBy('l.salesOrder')
      .orderBy('MIN(l.createdAt)', 'DESC')
      .take(ORPHAN_LIMIT);

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
    for (const row of rows) {
      counts[row.status] += 1;
      odooTotal += row.odoo.total;
      oracleTotal += row.oracle?.total ?? 0;
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
  ): BreakdownRow {
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
    };
  }

  private accumulate(group: BreakdownRow, row: ReconciliationRow): void {
    group.orders += 1;
    group.counts[row.status] += 1;
    group.odooTotal += row.odoo.total;
    group.oracleTotal += row.oracle?.total ?? 0;
    group.odooPayments += row.odoo.paymentTotal;
    if (row.oracle?.receiptTotal != null) {
      group.oracleReceipts += row.oracle.receiptTotal;
    } else if (row.oracle) {
      group.unlinkedReceiptOrders += 1;
    }
  }

  /** Rounds once at the end so a group of pennies does not drift. */
  private finaliseGroup(group: BreakdownRow): BreakdownRow {
    const problems = PROBLEM_STATUSES.reduce(
      (sum, s) => sum + group.counts[s],
      0,
    );
    const comparable = group.orders - group.counts.NOT_SYNCABLE;
    return {
      ...group,
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
