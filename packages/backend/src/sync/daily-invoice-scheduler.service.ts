/**
 * DailyInvoiceSchedulerService — runs the aggregated daily invoicing unattended.
 *
 * Mirrors the legacy Java scheduler (VendHQIntegrationScheduler, cron
 * "0 0 3 1/1 * ? *"): once a day at 03:00 local server time, catch up from the
 * last successfully-posted business day to today, capped at 7 days.
 *
 * Today is deliberately included even though it is still partial — the day is
 * re-posted on the next run and DailyAggregationService's per-line idempotency
 * means only the orders that arrived since last time are added.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { DailyInvoiceService, DailyInvoiceOutcome } from './daily-invoice.service';
import { SyncControlService } from './sync-control.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Matches DailyInvoiceService's own clamp. */
const MAX_CATCHUP_DAYS = 7;
/** Used when a region has never posted an invoice. */
const DEFAULT_LOOKBACK_DAYS = 1;

@Injectable()
export class DailyInvoiceSchedulerService {
  private readonly logger = new Logger(DailyInvoiceSchedulerService.name);

  constructor(
    private readonly dailyInvoice: DailyInvoiceService,
    private readonly syncControl: SyncControlService,
    private readonly notifications: NotificationsService,
    @InjectRepository(StoreConfiguration)
    private readonly storeConfigRepo: Repository<StoreConfiguration>,
    @InjectRepository(FusionInvoiceHeader)
    private readonly invoiceHeaderRepo: Repository<FusionInvoiceHeader>,
  ) {}

  /** 03:00 daily — same slot the legacy Quartz job used. */
  @Cron('0 0 3 * * *')
  async runDailyInvoicing(): Promise<void> {
    const enabled = await this.syncControl.isEnabled('daily-invoice');
    if (!enabled) {
      this.logger.debug('Daily invoicing is disabled, skipping cron run');
      return;
    }
    await this.run();
  }

  /**
   * Posts the outstanding window for every region that has active stores.
   * Safe to call manually; concurrent invocations are ignored.
   */
  async run(): Promise<DailyInvoiceOutcome[]> {
    // Cross-process lock: safe when the API and worker (or two instances) both
    // have the cron. The lease auto-expires so a crash never wedges the job.
    const locked = await this.syncControl.acquireLock('daily-invoice');
    if (!locked) {
      this.logger.warn(
        'Daily invoicing is already running elsewhere — skipping this trigger',
      );
      return [];
    }
    const started = Date.now();
    const outcomes: DailyInvoiceOutcome[] = [];

    try {
      const regions = await this.activeRegions();
      if (regions.length === 0) {
        this.logger.warn('No active stores configured — nothing to invoice');
        return [];
      }

      for (const region of regions) {
        const { startDate, days } = await this.catchUpWindow(region);
        this.logger.log(
          `[${region}] daily invoicing: ${days} day(s) from ${startDate}`,
        );
        try {
          outcomes.push(
            ...(await this.dailyInvoice.postRange({
              region,
              startDate,
              days,
              // Scheduled run: only AUTOMATIC outlets are eligible.
              trigger: 'AUTOMATIC',
            })),
          );
        } catch (err) {
          // One bad region must not stop the others.
          this.logger.error(
            `[${region}] daily invoicing failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      const created = outcomes.filter((o) => o.status === 'CREATED').length;
      const failed = outcomes.filter((o) => o.status === 'FAILED').length;
      const elapsedS = Math.round((Date.now() - started) / 1000);
      this.logger.log(
        `Daily invoicing finished in ${elapsedS}s — ` +
          `${created} invoice(s) created, ${failed} failed across ${regions.length} region(s)`,
      );
      await this.emailRunSummary(outcomes, regions, elapsedS).catch(() =>
        undefined,
      );
      return outcomes;
    } finally {
      await this.syncControl
        .releaseLock('daily-invoice')
        .catch(() => undefined);
    }
  }

  /**
   * Emails a per-run summary — invoices created, failures, and orders held back
   * — matching the legacy system's run-summary email. Silently a no-op when no
   * recipients are configured or SMTP is off (the notification service logs it).
   */
  private async emailRunSummary(
    outcomes: DailyInvoiceOutcome[],
    regions: string[],
    elapsedS: number,
  ): Promise<void> {
    const recipients = await this.notifications.getDailyReportRecipients();
    if (recipients.length === 0) return;

    const created = outcomes.filter((o) => o.status === 'CREATED');
    const failed = outcomes.filter((o) => o.status === 'FAILED');
    const excluded = outcomes.flatMap((o) => o.excludedOrders ?? []);

    const lines: string[] = [];
    lines.push(`Daily invoicing run summary`);
    lines.push(`Regions: ${regions.join(', ')}`);
    lines.push(`Duration: ${elapsedS}s`);
    lines.push('');
    lines.push(`Invoices created: ${created.length}`);
    for (const o of created) {
      lines.push(
        `  • ${o.transactionNumber}  ${o.branchCode} ${o.businessDay}  ` +
          `${o.sourceOrderCount} orders, ${o.invoiceLineCount} lines, ` +
          `${o.standardReceipts} receipt(s), ${o.inventoryTransactions ?? 0} inv txn`,
      );
    }
    if (failed.length) {
      lines.push('');
      lines.push(`Failures: ${failed.length}`);
      for (const o of failed) {
        lines.push(`  • ${o.branchCode} ${o.businessDay}: ${o.error ?? 'unknown'}`);
      }
    }
    if (excluded.length) {
      lines.push('');
      lines.push(`Orders held back (unknown item): ${excluded.length}`);
      for (const e of excluded) lines.push(`  • ${e.orderNumber}: ${e.reason}`);
    }

    const subject =
      `[Integration] Daily invoicing: ${created.length} created` +
      (failed.length ? `, ${failed.length} FAILED` : '');
    this.notifications.sendNotification({
      subject,
      body: lines.join('\n'),
      recipients,
    });
  }

  private async activeRegions(): Promise<string[]> {
    const stores = await this.storeConfigRepo.find({
      where: { isActive: true },
      select: { region: true },
    });
    return [
      ...new Set(
        stores
          .map((s) => s.region?.trim())
          .filter((r): r is string => !!r && r.length > 0),
      ),
    ].sort();
  }

  /**
   * Start date = the last business day this region posted, re-run so late
   * arrivals on that day are picked up; today when there is no history.
   */
  private async catchUpWindow(
    region: string,
  ): Promise<{ startDate: string; days: number }> {
    const today = this.todayUtc();
    const last = await this.invoiceHeaderRepo.findOne({
      where: { region, status: 'SUCCESS' },
      order: { txnDate: 'DESC' },
      select: { txnDate: true },
    });

    if (!last?.txnDate) {
      return {
        startDate: this.addDays(today, -DEFAULT_LOOKBACK_DAYS),
        days: DEFAULT_LOOKBACK_DAYS + 1,
      };
    }

    const startDate = new Date(last.txnDate).toISOString().slice(0, 10);
    const diff = this.daysBetween(startDate, today);
    return {
      startDate,
      days: Math.min(Math.max(diff + 1, 1), MAX_CATCHUP_DAYS),
    };
  }

  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private addDays(day: string, n: number): string {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  private daysBetween(from: string, to: string): number {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    return Math.round(
      (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
    );
  }
}
