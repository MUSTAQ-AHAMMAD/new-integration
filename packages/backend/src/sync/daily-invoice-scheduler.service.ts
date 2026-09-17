/**
 * DailyInvoiceSchedulerService — runs the aggregated daily invoicing unattended.
 *
 * Mirrors the legacy Java scheduler (VendHQIntegrationScheduler, cron
 * "0 0 3 1/1 * ? *"): once a day at 03:00 local server time it posts every
 * business day that still owes Oracle work.
 *
 * Which days those are is decided by IntegrationCoverageService, which compares
 * the Odoo backup tables against the lines Oracle confirmed. The previous
 * version instead started from the newest invoice it had already posted, and
 * that lost data two ways: the anchor was region-wide, so one healthy store
 * dragged it past another store's unposted days, and orders that reached Odoo
 * after their business day had already been posted were never revisited. Both
 * are silent — the run reported success while the orders sat there. Driving the
 * window off outstanding work instead means a day stays on the list until
 * Oracle actually holds its lines.
 *
 * Every run is tracked as a SyncJob (jobType=INTEGRATION_RUN, createdBy=
 * SCHEDULER) with live websocket progress, so an automatic run is visible on
 * the Integration Run page exactly like an operator-triggered one.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GatewayService } from '../gateway/gateway.service';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { JobStatus, JobType, ScopeType } from '../database/enums';
import { generateId } from '../database/id.util';
import { DailyInvoiceService, DailyInvoiceOutcome } from './daily-invoice.service';
import { DailyAggregationService } from './daily-aggregation.service';
import {
  DEFAULT_COVERAGE_LOOKBACK_DAYS,
  IntegrationCoverageService,
} from './integration-coverage.service';
import { IntegrationRunEvent, IntegrationRunScope } from './integration-run.service';
import { SyncControlService } from './sync-control.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Used when a region has no outstanding work at all — re-check yesterday. */
const DEFAULT_LOOKBACK_DAYS = 1;
/** Keep the live event log bounded; the UI shows the tail. */
const MAX_EVENTS = 300;

@Injectable()
export class DailyInvoiceSchedulerService {
  private readonly logger = new Logger(DailyInvoiceSchedulerService.name);

  constructor(
    private readonly dailyInvoice: DailyInvoiceService,
    private readonly aggregation: DailyAggregationService,
    private readonly coverage: IntegrationCoverageService,
    private readonly syncControl: SyncControlService,
    private readonly notifications: NotificationsService,
    private readonly gateway: GatewayService,
    @InjectRepository(StoreConfiguration)
    private readonly storeConfigRepo: Repository<StoreConfiguration>,
    @InjectRepository(SyncJob)
    private readonly jobs: Repository<SyncJob>,
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
   * Posts every outstanding business day for every region that has active
   * stores. Safe to call manually; concurrent invocations are ignored.
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
        try {
          outcomes.push(...(await this.runRegion(region)));
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
   * One region's run, reported live.
   *
   * The days come from coverage, so a run posts exactly what is owed: a day
   * whose lines are all in Oracle is not re-attempted, and a day that has been
   * owed for a week still is. Today and yesterday are always included on top of
   * that — today is still accumulating orders, and yesterday may have taken
   * late arrivals since the last run, and neither shows as outstanding until
   * those orders are actually backed up.
   */
  private async runRegion(region: string): Promise<DailyInvoiceOutcome[]> {
    const days = await this.daysToPost(region);
    const job = await this.openJob(region, days);
    const scope = job.scopeValue as IntegrationRunScope;

    this.logger.log(
      `[${region}] daily invoicing: ${days.length} day(s) — ${days.join(', ')}`,
    );
    await this.report(
      job.id,
      scope,
      'POST',
      `Automatic run for ${region}: ${days.length} outstanding day(s) — ${days.join(', ')}`,
    );

    // Work older than the catch-up window is invisible to this run and needs an
    // operator-triggered range. Say so loudly rather than letting it rot.
    const stale = await this.coverage
      .hasWorkOlderThanWindow(region)
      .catch(() => ({ found: false, oldestDay: null, orders: 0 }));
    if (stale.found) {
      await this.report(
        job.id,
        scope,
        'POST',
        `⚠ ${stale.orders} order(s) are still unposted from before ${stale.oldestDay} — ` +
          `older than the ${DEFAULT_COVERAGE_LOOKBACK_DAYS}-day catch-up window. ` +
          `Run the integration manually over that range to recover them.`,
      );
    }

    const outcomes: DailyInvoiceOutcome[] = [];
    let lastEmit = 0;
    try {
      for (const [i, day] of days.entries()) {
        const dayOutcomes = await this.dailyInvoice.postRange(
          {
            region,
            startDate: day,
            days: 1,
            // Scheduled run: only AUTOMATIC outlets are eligible.
            trigger: 'AUTOMATIC',
          },
          (p) => {
            for (const o of p.outcomes) this.applyOutcome(scope, o);
            scope.results.push(...p.outcomes);
            const now = Date.now();
            if (now - lastEmit < 800 && p.storesDone < p.storesTotal) return;
            lastEmit = now;
            void this.report(
              job.id,
              scope,
              'POST',
              `${day}: ${p.branchName ?? p.branchCode} (${p.branchCode}) — ` +
                `${p.storesDone}/${p.storesTotal} stores · ` +
                `${scope.post.invoicesCreated} invoice(s), ` +
                `${scope.post.journals} journal(s) so far…`,
            );
          },
        );
        outcomes.push(...dayOutcomes);
        scope.post.daysDone = i + 1;
        await this.report(
          job.id,
          scope,
          'POST',
          `${day} complete: ${scope.post.invoicesCreated} invoice(s) created, ` +
            `${scope.post.invoicesFailed} failed, ${scope.post.invoicesSkipped} skipped.`,
        );
      }

      // Re-measure afterwards: the honest answer to "did the run finish the
      // cycle?" is what Oracle holds now, not what the run believes it sent.
      const remaining = await this.coverage
        .outstandingDays(region)
        .catch(() => [] as string[]);
      scope.phase = 'DONE';
      await this.report(
        job.id,
        scope,
        'DONE',
        remaining.length === 0
          ? `Region ${region} fully posted — no outstanding days remain.`
          : `⚠ ${remaining.length} day(s) still outstanding after the run: ${remaining.join(', ')}. ` +
            `Check the failures above.`,
        JobStatus.COMPLETED,
      );
      await this.jobs.update(job.id, { completedAt: new Date() });
      return outcomes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scope.phase = 'DONE';
      await this.report(
        job.id,
        scope,
        'DONE',
        `Automatic run for ${region} failed: ${message}`,
        JobStatus.FAILED,
      );
      await this.jobs.update(job.id, {
        completedAt: new Date(),
        errorMessage: message.slice(0, 1000),
      });
      throw err;
    }
  }

  /**
   * The business days this region owes, oldest first, plus yesterday and today.
   */
  private async daysToPost(region: string): Promise<string[]> {
    const tz = this.aggregation.timeZoneForRegion(region);
    const today = this.aggregation.localDayOf(new Date(), tz);

    let outstanding: string[] = [];
    try {
      outstanding = await this.coverage.outstandingDays(region);
    } catch (err) {
      // Coverage is a query over two large tables; if it fails, fall back to
      // the conservative window rather than skipping the region entirely.
      this.logger.warn(
        `[${region}] coverage lookup failed (${
          err instanceof Error ? err.message : String(err)
        }) — falling back to the last ${DEFAULT_LOOKBACK_DAYS + 1} day(s)`,
      );
    }

    const days = new Set(outstanding);
    for (let i = 0; i <= DEFAULT_LOOKBACK_DAYS; i++) {
      days.add(this.addDays(today, -i));
    }
    return [...days].sort();
  }

  private applyOutcome(scope: IntegrationRunScope, o: DailyInvoiceOutcome) {
    if (o.status === 'CREATED') scope.post.invoicesCreated++;
    else if (o.status === 'FAILED') scope.post.invoicesFailed++;
    else scope.post.invoicesSkipped++;
    scope.post.standardReceipts += o.standardReceipts;
    scope.post.miscReceipts += o.miscReceipts;
    scope.post.journals += o.journals;
    scope.post.inventoryTransactions += o.inventoryTransactions ?? 0;
  }

  /** Creates the tracking job an automatic run reports through. */
  private async openJob(region: string, days: string[]): Promise<SyncJob> {
    const scope: IntegrationRunScope = {
      kind: 'INTEGRATION_RUN',
      region,
      startDate: days[0],
      endDate: days[days.length - 1],
      phase: 'POST',
      // The scheduled run posts from data the 15-minute Odoo backup already
      // landed; it does not pull, so these stay at zero by design.
      pull: {
        credentials: 0,
        saved: 0,
        skipped: 0,
        ingested: 0,
        ingestSkipped: 0,
      },
      post: {
        daysPlanned: days.length,
        daysDone: 0,
        invoicesCreated: 0,
        invoicesFailed: 0,
        invoicesSkipped: 0,
        standardReceipts: 0,
        miscReceipts: 0,
        journals: 0,
        inventoryTransactions: 0,
      },
      results: [],
      events: [],
    };

    return this.jobs.save(
      this.jobs.create({
        id: generateId(),
        jobType: JobType.INTEGRATION_RUN,
        scopeType: ScopeType.DATE_RANGE,
        scopeValue: scope,
        status: JobStatus.PROCESSING,
        totalRecords: days.length,
        startedAt: new Date(),
        createdBy: 'SCHEDULER',
      }),
    );
  }

  /** Persists the run scope and pushes the same websocket event the UI reads. */
  private async report(
    jobId: string,
    scope: IntegrationRunScope,
    phase: IntegrationRunEvent['phase'],
    message: string,
    status?: JobStatus,
  ): Promise<void> {
    scope.events.push({ at: new Date().toISOString(), phase, message });
    if (scope.events.length > MAX_EVENTS) {
      scope.events.splice(0, scope.events.length - MAX_EVENTS);
    }
    this.logger.log(`[auto ${jobId}] [${phase}] ${message}`);
    try {
      await this.jobs.update(jobId, {
        scopeValue: scope,
        processedRecords: scope.post.daysDone,
        successCount: scope.post.invoicesCreated,
        failedCount: scope.post.invoicesFailed,
        skippedCount: scope.post.invoicesSkipped,
        ...(status ? { status } : {}),
      });
    } catch (err) {
      // Progress reporting must never take the run down with it.
      this.logger.warn(
        `Could not persist run progress: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.gateway.emitIntegrationRun({
      jobId,
      status: status ?? JobStatus.PROCESSING,
      phase,
      message,
      counters: {
        ingested: scope.pull.ingested,
        daysDone: scope.post.daysDone,
        daysPlanned: scope.post.daysPlanned,
        invoicesCreated: scope.post.invoicesCreated,
        invoicesFailed: scope.post.invoicesFailed,
      },
    });
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

    // What is still owed after the run — the number that actually says whether
    // the cycle completed.
    const stillOwed: string[] = [];
    for (const region of regions) {
      const remaining = await this.coverage
        .outstandingDays(region)
        .catch(() => [] as string[]);
      if (remaining.length) {
        stillOwed.push(`  • ${region}: ${remaining.join(', ')}`);
      }
    }
    if (stillOwed.length) {
      lines.push('');
      lines.push('Days still outstanding after this run:');
      lines.push(...stillOwed);
    }

    const subject =
      `[Integration] Daily invoicing: ${created.length} created` +
      (failed.length ? `, ${failed.length} FAILED` : '') +
      (stillOwed.length ? `, ${stillOwed.length} region(s) incomplete` : '');
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

  private addDays(day: string, n: number): string {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
}
