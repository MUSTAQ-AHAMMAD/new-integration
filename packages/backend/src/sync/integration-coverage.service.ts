/**
 * IntegrationCoverageService — answers "what has NOT been invoiced yet?".
 *
 * Everything else in the pipeline reasons forward: pull orders, aggregate a
 * day, post it. Nothing reasoned backwards, and that is how days went missing.
 * The scheduler used to pick its catch-up window from the newest invoice it had
 * already posted (`MAX(FusionInvoiceHeader.txnDate)` for the region), which has
 * two failure modes that both lose data silently:
 *
 *   1. The anchor is region-wide. One store posting normally drags the anchor
 *      forward past another store's unposted days; once those fall outside the
 *      window they are never revisited.
 *   2. Odoo orders arrive late. An order written days after its business day is
 *      backed up correctly, but by then the window has moved past that day, so
 *      nothing ever aggregates it.
 *
 * This service compares the backup tables against what Oracle actually holds,
 * per store-local business day, so the scheduler can target exactly the days
 * that still owe work — and so an operator can see the gap on the dashboard.
 *
 * "Outstanding" is measured in LINES, not orders: an order whose invoice was
 * posted for two of its three lines is still incomplete. Zero-quantity lines
 * are excluded because DailyAggregationService never posts them, so counting
 * them would make every day look permanently outstanding.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import {
  DailyAggregationService,
  NON_INVOICEABLE_STATES,
} from './daily-aggregation.service';

/** Oracle IN () lists are capped; chunk anything built from order numbers. */
const IN_CHUNK = 900;

/** How far back coverage looks by default, and how far the scheduler catches up. */
export const DEFAULT_COVERAGE_LOOKBACK_DAYS = Math.max(
  1,
  parseInt(process.env.INTEGRATION_COVERAGE_LOOKBACK_DAYS ?? '14', 10),
);

/**
 * How far back the "did we abandon anything?" check looks. Deliberately far
 * wider than the catch-up window — abandoned work sits outside that window by
 * definition, so a horizon of a couple of weeks would never see it.
 */
export const STALE_HORIZON_DAYS = Math.max(
  1,
  parseInt(process.env.INTEGRATION_STALE_HORIZON_DAYS ?? '90', 10),
);

/** One store-local business day, as it stands between Odoo and Oracle. */
export interface DayCoverage {
  region: string;
  /** Store-local calendar day, YYYY-MM-DD. */
  businessDay: string;
  /** Invoiceable orders backed up for this day. */
  ordersTotal: number;
  /** Orders whose every postable line is in Oracle. */
  ordersComplete: number;
  /** Orders with no posted line at all. */
  ordersMissing: number;
  /** Orders posted only in part — some lines landed, some did not. */
  ordersPartial: number;
  /** Postable lines Oracle is still missing across the day. */
  linesOutstanding: number;
  /** Odoo value of the orders that are missing or partial. */
  amountOutstanding: number;
  /** Branch codes with outstanding work, for the operator to act on. */
  branches: string[];
  /** A sample of the order numbers still owed, capped for display. */
  sampleOrderNumbers: string[];
}

@Injectable()
export class IntegrationCoverageService {
  private readonly logger = new Logger(IntegrationCoverageService.name);

  constructor(
    @InjectRepository(BackupOdooOrder)
    private readonly backupOrders: Repository<BackupOdooOrder>,
    @InjectRepository(BackupOdooOrderLine)
    private readonly backupLines: Repository<BackupOdooOrderLine>,
    @InjectRepository(FusionInvoiceLine)
    private readonly invoiceLines: Repository<FusionInvoiceLine>,
    private readonly aggregation: DailyAggregationService,
  ) {}

  /**
   * Per-day coverage for a region, newest day first.
   *
   * Days with nothing backed up are omitted entirely — a day with no orders is
   * not a gap, and listing it would bury the days that are.
   */
  async regionCoverage(
    region: string,
    lookbackDays = DEFAULT_COVERAGE_LOOKBACK_DAYS,
  ): Promise<DayCoverage[]> {
    const tz = this.aggregation.timeZoneForRegion(region);
    const today = this.aggregation.localDayOf(new Date(), tz);
    const firstDay = this.addDays(today, -Math.max(lookbackDays, 0));

    // Fetch with a day of slack on each side in UTC, then bucket by the store's
    // own clock — the UTC instant of a local day boundary shifts by region.
    const from = new Date(`${this.addDays(firstDay, -1)}T00:00:00.000Z`);
    const to = new Date(`${this.addDays(today, 1)}T23:59:59.999Z`);

    const orders = await this.backupOrders.find({
      where: { region, dateOrder: Between(from, to) },
      select: {
        orderId: true,
        orderName: true,
        dateOrder: true,
        state: true,
        amountTotal: true,
        resolvedBranchCode: true,
        branchName: true,
      },
      order: { dateOrder: 'ASC' },
    });

    // Same eligibility rule the aggregator applies, so coverage never reports a
    // gap the pipeline would refuse to fill (refunds go down the credit-memo
    // path; drafts and cancellations are never invoiced).
    const eligible = orders.filter((o) => {
      const state = (o.state ?? '').trim().toLowerCase();
      if (NON_INVOICEABLE_STATES.has(state)) return false;
      return Number(o.amountTotal ?? 0) >= 0;
    });

    const inWindow = eligible.filter((o) => {
      if (!o.dateOrder) return false;
      const day = this.aggregation.localDayOf(new Date(o.dateOrder), tz);
      return day >= firstDay && day <= today;
    });
    if (inWindow.length === 0) return [];

    const expected = await this.expectedLineCounts(
      inWindow.map((o) => o.orderId),
    );
    const posted = await this.postedLineCounts(
      region,
      inWindow.map((o) => this.orderNumberOf(o)),
    );

    const byDay = new Map<string, DayCoverage>();
    for (const order of inWindow) {
      const day = this.aggregation.localDayOf(new Date(order.dateOrder!), tz);
      let row = byDay.get(day);
      if (!row) {
        row = {
          region,
          businessDay: day,
          ordersTotal: 0,
          ordersComplete: 0,
          ordersMissing: 0,
          ordersPartial: 0,
          linesOutstanding: 0,
          amountOutstanding: 0,
          branches: [],
          sampleOrderNumbers: [],
        };
        byDay.set(day, row);
      }

      const orderNumber = this.orderNumberOf(order);
      // An order with no postable lines (every line zero-quantity) can never be
      // outstanding — treat it as complete rather than as a permanent gap.
      const want = expected.get(order.orderId) ?? 0;
      const have = posted.get(orderNumber) ?? 0;

      row.ordersTotal += 1;
      if (want === 0 || have >= want) {
        row.ordersComplete += 1;
        continue;
      }

      if (have === 0) row.ordersMissing += 1;
      else row.ordersPartial += 1;
      row.linesOutstanding += want - have;
      row.amountOutstanding += Math.abs(Number(order.amountTotal ?? 0));

      const branch = order.resolvedBranchCode ?? order.branchName ?? null;
      if (branch && !row.branches.includes(branch)) row.branches.push(branch);
      if (row.sampleOrderNumbers.length < 20) {
        row.sampleOrderNumbers.push(orderNumber);
      }
    }

    return [...byDay.values()]
      .map((row) => ({
        ...row,
        amountOutstanding: Math.round(row.amountOutstanding * 100) / 100,
        branches: row.branches.sort(),
      }))
      .sort((a, b) => b.businessDay.localeCompare(a.businessDay));
  }

  /**
   * Every business day in the window that still owes Oracle at least one line,
   * oldest first — exactly the days the scheduler should post.
   */
  async outstandingDays(
    region: string,
    lookbackDays = DEFAULT_COVERAGE_LOOKBACK_DAYS,
  ): Promise<string[]> {
    const coverage = await this.regionCoverage(region, lookbackDays);
    return coverage
      .filter((d) => d.ordersMissing > 0 || d.ordersPartial > 0)
      .map((d) => d.businessDay)
      .sort();
  }

  /**
   * True when orders older than the catch-up window are still unposted — data
   * the scheduler will never reach on its own. Worth shouting about rather than
   * letting it sit: it needs an operator-triggered run over that range.
   */
  async hasWorkOlderThanWindow(
    region: string,
    lookbackDays = DEFAULT_COVERAGE_LOOKBACK_DAYS,
  ): Promise<{ found: boolean; oldestDay: string | null; orders: number }> {
    // Look over a much longer horizon than the catch-up window: the point is to
    // find work that was abandoned, which by definition sits well outside it.
    const wide = await this.regionCoverage(
      region,
      Math.max(STALE_HORIZON_DAYS, lookbackDays + 1),
    );
    const tz = this.aggregation.timeZoneForRegion(region);
    const cutoff = this.addDays(
      this.aggregation.localDayOf(new Date(), tz),
      -lookbackDays,
    );
    const stale = wide.filter(
      (d) =>
        d.businessDay < cutoff && (d.ordersMissing > 0 || d.ordersPartial > 0),
    );
    if (stale.length === 0) {
      return { found: false, oldestDay: null, orders: 0 };
    }
    return {
      found: true,
      oldestDay: stale[stale.length - 1].businessDay,
      orders: stale.reduce((s, d) => s + d.ordersMissing + d.ordersPartial, 0),
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private orderNumberOf(order: {
    orderName: string | null;
    orderId: number;
  }): string {
    return order.orderName ?? String(order.orderId);
  }

  /** Postable lines per backup order — zero-quantity lines never post. */
  private async expectedLineCounts(
    orderIds: number[],
  ): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    for (const chunk of this.chunk(orderIds)) {
      const rows = await this.backupLines.find({
        where: { orderId: In(chunk) },
        select: { orderId: true, qty: true },
      });
      for (const row of rows) {
        if (Number(row.qty ?? 0) === 0) continue;
        counts.set(row.orderId, (counts.get(row.orderId) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** Lines Oracle confirmed for each source order number. */
  private async postedLineCounts(
    region: string,
    orderNumbers: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const chunk of this.chunk(orderNumbers)) {
      const rows = await this.invoiceLines.find({
        where: {
          salesOrder: In(chunk),
          region,
          status: In(['SUCCESS', 'S']),
        },
        select: { salesOrder: true, salesOrderLine: true, invoiceNumber: true },
      });
      // Distinct by (order, line): a re-run that re-posted a line must not make
      // an order look more complete than it is.
      const seen = new Set<string>();
      for (const row of rows) {
        if (!row.salesOrder || row.salesOrderLine == null) continue;
        if (!row.invoiceNumber) continue;
        const key = `${row.salesOrder}|${row.salesOrderLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        counts.set(row.salesOrder, (counts.get(row.salesOrder) ?? 0) + 1);
      }
    }
    return counts;
  }

  private chunk<T>(items: T[]): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += IN_CHUNK) {
      out.push(items.slice(i, i + IN_CHUNK));
    }
    return out;
  }

  private addDays(day: string, n: number): string {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
}
