/**
 * IntegrationSchedulerService — the automatic Odoo→Oracle integration, per
 * region, driven by an admin-editable schedule and CUT-OFF.
 *
 * How a region is automated
 *   • Switches: Sync Control "integration-auto" — the global master (region
 *     null) AND the region's own row must both be ON.
 *   • Schedule (IntegrationSchedule row, region-local clock):
 *       runTime     — when the run fires each day;
 *       cutoffTime  — business day D is CLOSED once the clock passes this time
 *                     on D+1. Only closed days are ever posted, so a day is
 *                     invoiced once, complete — never as a partial day that
 *                     later gets a second invoice for its remaining sales;
 *       lookbackDays— how many closed days each run (re)checks. Re-checking is
 *                     safe (already-posted lines/receipts/inventory are skipped)
 *                     and is what retries yesterday's failures automatically.
 *   • A minute-by-minute tick fires the run once per local day at/after
 *     runTime, so a server that was down at exactly runTime still runs on
 *     recovery instead of skipping the day.
 *
 * How you know it works
 *   • Every tick stamps lastTickAt (heartbeat); every run records its job,
 *     window, status and summary; consecutive failures are counted.
 *   • A FAILED / PARTIAL / NOT_STARTED run, a stalled region (no success within
 *     staleAfterHours) or a dead scheduler raises an Alert (+ email to the
 *     error-alert recipients).
 *   • status() turns all of that into one verdict per region for the admin
 *     panel; preview() is a read-only dry run that shows exactly what the next
 *     run would do (at any simulated time, to test the cut-off).
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';
import { AlertsService } from '../alerts/alerts.service';
import {
  AlertSeverity,
  AlertType,
  JobStatus,
  JobType,
} from '../database/enums';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { IntegrationSchedule } from '../database/entities/integration-schedule.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { OutletIntegrationConfig } from '../database/entities/outlet-integration-config.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { OdooBackupService } from '../odoo-backup/odoo-backup.service';
import { withTimeout, MODULE_INIT_TIMEOUT_MS } from '../common/utils/timeout';
import { DailyAggregationService } from './daily-aggregation.service';
import {
  IntegrationRunScope,
  IntegrationRunService,
} from './integration-run.service';
import { ReadinessReport, ReadinessService } from './readiness.service';
import { SyncControlService } from './sync-control.service';

const SERVICE = 'integration-auto';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A scheduler that hasn't ticked for this long is reported as down. */
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export type AutomationHealth =
  | 'HEALTHY'
  | 'RUNNING'
  | 'ATTENTION'
  | 'FAILING'
  | 'STALE'
  | 'NEVER_RAN'
  | 'DISABLED'
  | 'SCHEDULER_DOWN';

export interface AutomationPlan {
  region: string;
  timeZone: string;
  /** The instant evaluated (now, or the simulated time). */
  at: string;
  localNow: string;
  localToday: string;
  cutoffTime: string;
  runTime: string;
  /** Has today's cut-off passed (i.e. is yesterday closed)? */
  cutoffPassedToday: boolean;
  latestClosedDay: string;
  /** Business days a run started at `at` would post. */
  window: { startDate: string; endDate: string; days: string[] };
  /** Has the scheduled run already fired for `localToday`? */
  firedToday: boolean;
  nextRunLocal: string;
  nextRunUtc: string;
  explanation: string[];
}

export interface AutomationSettingsDto {
  runTime?: string;
  cutoffTime?: string;
  lookbackDays?: number;
  outletMode?: 'AUTOMATIC' | 'ALL';
  postIfPullFails?: boolean;
  alertOnFailure?: boolean;
  staleAfterHours?: number;
}

export interface AutomationRegionStatus {
  region: string;
  masterEnabled: boolean;
  regionEnabled: boolean;
  enabled: boolean;
  running: boolean;
  health: AutomationHealth;
  healthReason: string;
  schedule: IntegrationSchedule;
  plan: AutomationPlan;
  recentRuns: Array<{
    id: string;
    status: string;
    source: string;
    window: string;
    createdAt: Date;
    completedAt: Date | null;
    invoicesCreated: number;
    invoicesFailed: number;
    stepFailures: number;
    error: string | null;
  }>;
}

export interface AutomationPreview {
  plan: AutomationPlan;
  settings: IntegrationSchedule;
  enabled: boolean;
  readiness: ReadinessReport | { error: string };
  odoo: {
    reachable: boolean;
    ordersInWindow: number | null;
    error: string | null;
  };
  outlets: {
    stores: number;
    willPost: number;
    skippedManual: string[];
    skippedNone: string[];
  };
  days: Array<{
    businessDay: string;
    ordersInBackup: number;
    amountInBackup: number;
    ordersAlreadyInvoiced: number;
    ordersToPost: number;
  }>;
  verdict: string[];
}

@Injectable()
export class IntegrationSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationSchedulerService.name);
  private ticking = false;
  /** alert key → last raised (ms); alerts + emails repeat at most every 4h. */
  private readonly lastRaised = new Map<string, number>();

  constructor(
    private readonly integrationRun: IntegrationRunService,
    private readonly syncControl: SyncControlService,
    private readonly aggregation: DailyAggregationService,
    private readonly readiness: ReadinessService,
    private readonly odooBackup: OdooBackupService,
    private readonly alerts: AlertsService,
    private readonly notifications: NotificationsService,
    @InjectRepository(OdooCredential)
    private readonly credentials: Repository<OdooCredential>,
    @InjectRepository(IntegrationSchedule)
    private readonly schedules: Repository<IntegrationSchedule>,
    @InjectRepository(SyncJob)
    private readonly jobs: Repository<SyncJob>,
    @InjectRepository(StoreConfiguration)
    private readonly stores: Repository<StoreConfiguration>,
    @InjectRepository(OutletIntegrationConfig)
    private readonly outlets: Repository<OutletIntegrationConfig>,
    @InjectRepository(BackupOdooOrder)
    private readonly orders: Repository<BackupOdooOrder>,
    @InjectRepository(FusionInvoiceLine)
    private readonly invoiceLines: Repository<FusionInvoiceLine>,
  ) {}

  /** Seed a per-region toggle (OFF) and default schedule for every region. */
  async onModuleInit(): Promise<void> {
    await withTimeout(
      (async () => {
        for (const region of await this.activeRegions()) {
          await this.ensureRegion(region);
        }
      })(),
      MODULE_INIT_TIMEOUT_MS,
      'IntegrationSchedulerService.onModuleInit',
    ).catch((err) =>
      this.logger.warn(
        `Could not seed integration schedules: ${this.msg(err)}`,
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scheduler tick
  // ══════════════════════════════════════════════════════════════════════════

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const master = await this.syncControl.isEnabled(SERVICE);
      for (const region of await this.activeRegions()) {
        try {
          await this.tickRegion(region, master);
        } catch (err) {
          this.logger.error(
            `[${region}] automation tick failed: ${this.msg(err)}`,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickRegion(region: string, master: boolean): Promise<void> {
    const schedule = await this.ensureRegion(region);
    const now = new Date();
    await this.schedules.update(schedule.id, { lastTickAt: now });

    const enabled =
      master && (await this.syncControl.isEnabled(SERVICE, region));
    if (!enabled) return;

    const plan = this.plan(schedule, now);
    // Fire once per local day, at or after runTime (catches up after downtime).
    if (!plan.firedToday && plan.localNow.slice(11) >= schedule.runTime) {
      await this.schedules.update(schedule.id, {
        lastScheduledDate: plan.localToday,
      });
      await this.startAutomatic(region, 'SCHEDULER', now);
      return;
    }

    // Stalled: enabled, but nothing has succeeded for too long.
    // Measured from the last success, or from the first run if none has
    // succeeded yet; a region that has never run is reported as NEVER_RAN
    // instead of alerting.
    const staleMs = schedule.staleAfterHours * 3_600_000;
    const since = schedule.lastSuccessAt ?? schedule.lastRunStartedAt;
    if (
      since &&
      schedule.alertOnFailure &&
      !this.integrationRun.isRegionRunning(region) &&
      now.getTime() - new Date(since).getTime() > staleMs
    ) {
      await this.raise(
        region,
        AlertType.SYNC_STALLED,
        AlertSeverity.WARNING,
        `Automatic integration stalled — ${region}`,
        `No successful automatic integration for ${region} in the last ` +
          `${schedule.staleAfterHours}h (last success: ${
            schedule.lastSuccessAt
              ? schedule.lastSuccessAt.toISOString()
              : 'never'
          }). Check Admin → Automation & Cut-off.`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Running
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Legacy entry point ("Run auto now" on the Integration Run page): runs every
   * ENABLED region exactly as the scheduler would. Returns regions started.
   */
  async run(createdBy = 'SCHEDULER'): Promise<string[]> {
    const master = await this.syncControl.isEnabled(SERVICE);
    if (!master) return [];
    const started: string[] = [];
    for (const region of await this.activeRegions()) {
      await this.ensureRegion(region);
      if (!(await this.syncControl.isEnabled(SERVICE, region))) continue;
      const r = await this.startAutomatic(region, createdBy, new Date());
      if (r.started) started.push(region);
    }
    return started;
  }

  /**
   * Admin "Run now (test)": runs ONE region exactly as the scheduler would —
   * same cut-off window, outlet mode and failure policy — even if its toggle is
   * off, so automation can be proven before it is switched on.
   */
  async runNow(
    region: string,
    user: string,
  ): Promise<{
    started: boolean;
    jobId?: string;
    reason?: string;
    plan: AutomationPlan;
  }> {
    const reg = this.normalizeRegion(region);
    await this.assertKnownRegion(reg);
    return this.startAutomatic(
      reg,
      `AUTOMATION_TEST:${user}`.slice(0, 40),
      new Date(),
    );
  }

  private async startAutomatic(
    region: string,
    source: string,
    at: Date,
  ): Promise<{
    started: boolean;
    jobId?: string;
    reason?: string;
    plan: AutomationPlan;
  }> {
    const schedule = await this.ensureRegion(region);
    const plan = this.plan(schedule, at);
    const windowLabel = `${plan.window.startDate} → ${plan.window.endDate}`;

    try {
      const job = await this.integrationRun.startRun({
        region,
        startDate: plan.window.startDate,
        endDate: plan.window.endDate,
        createdBy: source,
        trigger: schedule.outletMode === 'ALL' ? 'ALL' : 'AUTOMATIC',
        postIfPullFails: schedule.postIfPullFails,
        onDone: (finished, scope) => {
          void this.recordFinished(region, finished, scope).catch((err) =>
            this.logger.error(
              `[${region}] could not record run result: ${this.msg(err)}`,
            ),
          );
        },
      });
      await this.schedules.update(schedule.id, {
        lastRunJobId: job.id,
        lastRunSource: source.slice(0, 40),
        lastRunStartedAt: new Date(),
        lastRunFinishedAt: null,
        lastRunStatus: 'RUNNING',
        lastRunWindow: windowLabel,
        lastRunSummary: `Started by ${source}`,
      });
      this.logger.log(
        `[${region}] automatic integration started (${source}) for ${windowLabel}`,
      );
      return { started: true, jobId: job.id, plan };
    } catch (err) {
      const reason = this.msg(err);
      await this.schedules.update(schedule.id, {
        lastRunSource: source.slice(0, 40),
        lastRunStartedAt: new Date(),
        lastRunFinishedAt: new Date(),
        lastRunStatus: 'NOT_STARTED',
        lastRunWindow: windowLabel,
        lastRunSummary: reason.slice(0, 1000),
        lastError: reason,
        consecutiveFailures: schedule.consecutiveFailures + 1,
      });
      this.logger.warn(
        `[${region}] automatic integration NOT started: ${reason}`,
      );
      if (schedule.alertOnFailure) {
        await this.raise(
          region,
          AlertType.SYNC_FAILURE,
          AlertSeverity.ERROR,
          `Automatic integration did not start — ${region}`,
          `${windowLabel}: ${reason}`,
        );
      }
      return { started: false, reason, plan };
    }
  }

  private async recordFinished(
    region: string,
    job: SyncJob | null,
    scope: IntegrationRunScope,
  ): Promise<void> {
    const schedule = await this.ensureRegion(region);
    if (job && schedule.lastRunJobId && schedule.lastRunJobId !== job.id)
      return;
    const status = String(job?.status ?? JobStatus.FAILED);
    const p = scope.post;
    const summary =
      scope.blockedReason ??
      `${scope.pull.saved} order(s) pulled · ${p.invoicesCreated} invoice(s) created, ` +
        `${p.invoicesFailed} failed, ${p.invoicesSkipped} skipped · ` +
        `${p.standardReceipts} receipt(s), ${p.journals} journal(s), ` +
        `${p.inventoryTransactions} inventory txn · ${p.stepFailures} step failure(s)`;
    const ok = status === String(JobStatus.COMPLETED);
    const failures = scope.results
      .filter((o) => o.status === 'FAILED' || (o.stepFailures?.length ?? 0) > 0)
      .slice(0, 15)
      .map(
        (o) =>
          `${o.branchName ?? o.branchCode} ${o.businessDay}: ${
            o.error ?? (o.stepFailures ?? []).join('; ')
          }`,
      );

    await this.schedules.update(schedule.id, {
      lastRunFinishedAt: new Date(),
      lastRunStatus: status,
      lastRunSummary: summary.slice(0, 1000),
      lastSuccessAt: ok ? new Date() : schedule.lastSuccessAt,
      consecutiveFailures: ok ? 0 : schedule.consecutiveFailures + 1,
      lastError: ok
        ? null
        : [job?.errorMessage, ...failures].filter(Boolean).join('\n') ||
          summary,
    });

    if (!ok && schedule.alertOnFailure) {
      await this.raise(
        region,
        AlertType.SYNC_FAILURE,
        status === String(JobStatus.PARTIAL)
          ? AlertSeverity.WARNING
          : AlertSeverity.ERROR,
        `Automatic integration ${status} — ${region} (${schedule.lastRunWindow ?? ''})`,
        [summary, ...failures].join('\n'),
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Cut-off maths
  // ══════════════════════════════════════════════════════════════════════════

  plan(schedule: IntegrationSchedule, at: Date): AutomationPlan {
    const timeZone = this.aggregation.regionTimeZone(schedule.region);
    const { date: localToday, time: localTime } = this.localParts(at, timeZone);
    const cutoffPassedToday = localTime >= schedule.cutoffTime;
    const latestClosedDay = this.addDays(
      localToday,
      cutoffPassedToday ? -1 : -2,
    );
    const lookback = Math.max(1, schedule.lookbackDays);
    const startDate = this.addDays(latestClosedDay, -(lookback - 1));
    const days: string[] = [];
    for (let d = startDate; d <= latestClosedDay; d = this.addDays(d, 1))
      days.push(d);

    const firedToday = schedule.lastScheduledDate === localToday;
    const nextRunDay =
      !firedToday && localTime < schedule.runTime
        ? localToday
        : this.addDays(localToday, 1);
    const nextRunUtc = this.localToUtc(nextRunDay, schedule.runTime, timeZone);

    const explanation = [
      `Local time in ${schedule.region} (${timeZone}) is ${localToday} ${localTime}.`,
      cutoffPassedToday
        ? `Today's cut-off ${schedule.cutoffTime} has passed, so ${this.addDays(localToday, -1)} is closed.`
        : `Today's cut-off ${schedule.cutoffTime} has NOT passed yet, so ${this.addDays(localToday, -1)} is still open and will not be posted.`,
      `A run now posts ${days.length} closed day(s): ${startDate} → ${latestClosedDay} (lookback ${lookback}).`,
      schedule.runTime < schedule.cutoffTime
        ? `⚠ Run time ${schedule.runTime} is BEFORE the cut-off ${schedule.cutoffTime}: each scheduled run can only post up to the day before yesterday. Set the run time after the cut-off.`
        : `Scheduled daily at ${schedule.runTime} local (after the ${schedule.cutoffTime} cut-off).`,
      firedToday
        ? `Today's scheduled run has already fired; next run ${nextRunDay} ${schedule.runTime} local.`
        : `Next scheduled run: ${nextRunDay} ${schedule.runTime} local.`,
    ];

    return {
      region: schedule.region,
      timeZone,
      at: at.toISOString(),
      localNow: `${localToday} ${localTime}`,
      localToday,
      cutoffTime: schedule.cutoffTime,
      runTime: schedule.runTime,
      cutoffPassedToday,
      latestClosedDay,
      window: { startDate, endDate: latestClosedDay, days },
      firedToday,
      nextRunLocal: `${nextRunDay} ${schedule.runTime}`,
      nextRunUtc: nextRunUtc.toISOString(),
      explanation,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Admin API
  // ══════════════════════════════════════════════════════════════════════════

  async status(): Promise<AutomationRegionStatus[]> {
    const master = await this.syncControl.isEnabled(SERVICE);
    const regions = await this.activeRegions();
    const recent = await this.jobs.find({
      where: { jobType: JobType.INTEGRATION_RUN },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    const now = new Date();
    const out: AutomationRegionStatus[] = [];
    for (const region of regions) {
      const schedule = await this.ensureRegion(region);
      const regionEnabled = await this.syncControl.isEnabled(SERVICE, region);
      const running = this.integrationRun.isRegionRunning(region);
      const { health, reason } = this.health(
        schedule,
        master,
        regionEnabled,
        running,
        now,
      );
      out.push({
        region,
        masterEnabled: master,
        regionEnabled,
        enabled: master && regionEnabled,
        running,
        health,
        healthReason: reason,
        schedule,
        plan: this.plan(schedule, now),
        recentRuns: recent
          .filter(
            (j) =>
              (j.scopeValue as IntegrationRunScope | null)?.region === region,
          )
          .slice(0, 8)
          .map((j) => {
            const s = j.scopeValue as IntegrationRunScope;
            return {
              id: j.id,
              status: String(j.status),
              source: s?.source ?? j.createdBy ?? '',
              window: `${s?.startDate ?? ''} → ${s?.endDate ?? ''}`,
              createdAt: j.createdAt,
              completedAt: j.completedAt ?? null,
              invoicesCreated: s?.post?.invoicesCreated ?? 0,
              invoicesFailed: s?.post?.invoicesFailed ?? 0,
              stepFailures: s?.post?.stepFailures ?? 0,
              error: j.errorMessage ?? null,
            };
          }),
      });
    }
    return out;
  }

  async updateSettings(
    region: string,
    dto: AutomationSettingsDto,
    user: string,
  ): Promise<IntegrationSchedule> {
    const reg = this.normalizeRegion(region);
    await this.assertKnownRegion(reg);
    const schedule = await this.ensureRegion(reg);
    const patch: Partial<IntegrationSchedule> = { updatedBy: user };
    if (dto.runTime !== undefined) {
      if (!TIME_RE.test(dto.runTime))
        throw new BadRequestException('runTime must be HH:mm (24h)');
      patch.runTime = dto.runTime;
    }
    if (dto.cutoffTime !== undefined) {
      if (!TIME_RE.test(dto.cutoffTime))
        throw new BadRequestException('cutoffTime must be HH:mm (24h)');
      patch.cutoffTime = dto.cutoffTime;
    }
    if (dto.lookbackDays !== undefined) {
      const n = Number(dto.lookbackDays);
      if (!Number.isInteger(n) || n < 1 || n > 7) {
        throw new BadRequestException(
          'lookbackDays must be a whole number 1–7',
        );
      }
      patch.lookbackDays = n;
    }
    if (dto.outletMode !== undefined) {
      if (!['AUTOMATIC', 'ALL'].includes(dto.outletMode)) {
        throw new BadRequestException('outletMode must be AUTOMATIC or ALL');
      }
      patch.outletMode = dto.outletMode;
    }
    if (dto.staleAfterHours !== undefined) {
      const n = Number(dto.staleAfterHours);
      if (!Number.isInteger(n) || n < 1 || n > 168) {
        throw new BadRequestException('staleAfterHours must be 1–168');
      }
      patch.staleAfterHours = n;
    }
    if (dto.postIfPullFails !== undefined)
      patch.postIfPullFails = !!dto.postIfPullFails;
    if (dto.alertOnFailure !== undefined)
      patch.alertOnFailure = !!dto.alertOnFailure;
    await this.schedules.update(schedule.id, patch);
    return (await this.schedules.findOne({ where: { id: schedule.id } }))!;
  }

  async setEnabled(region: string | null, enabled: boolean): Promise<void> {
    if (region) {
      const reg = this.normalizeRegion(region);
      await this.assertKnownRegion(reg);
      await this.ensureRegion(reg);
      if (enabled) await this.syncControl.enable(SERVICE, reg);
      else await this.syncControl.disable(SERVICE, reg);
    } else if (enabled) {
      await this.syncControl.enable(SERVICE);
    } else {
      await this.syncControl.disable(SERVICE);
    }
  }

  /**
   * Read-only dry run: what would a run at `at` (default now) post, and would
   * it succeed? Checks the cut-off window, Oracle/reference-data readiness,
   * Odoo reachability, outlet gating and the backed-up orders per day.
   * Writes nothing and calls no Oracle write API.
   */
  async preview(region: string, atIso?: string): Promise<AutomationPreview> {
    const reg = this.normalizeRegion(region);
    await this.assertKnownRegion(reg);
    const at = atIso ? new Date(atIso) : new Date();
    if (Number.isNaN(at.getTime()))
      throw new BadRequestException('at must be an ISO date-time');
    const schedule = await this.ensureRegion(reg);
    const plan = this.plan(schedule, at);
    const master = await this.syncControl.isEnabled(SERVICE);
    const regionEnabled = await this.syncControl.isEnabled(SERVICE, reg);

    const [readiness, odoo, outlets, days] = await Promise.all([
      this.readiness
        .checkRegion(reg)
        .catch((err) => ({ error: this.msg(err) })),
      this.probeOdoo(reg, plan),
      this.outletGate(reg, schedule.outletMode),
      this.backupDays(reg, plan),
    ]);

    const verdict: string[] = [];
    if (!(master && regionEnabled)) {
      verdict.push(
        `Automation is OFF for ${reg} (${!master ? 'master switch off' : 'region switch off'}) — the scheduler will not run it. "Run now (test)" still works.`,
      );
    }
    if ('error' in readiness)
      verdict.push(`Readiness check failed: ${readiness.error}`);
    else if (!readiness.ready)
      verdict.push(
        `${readiness.blockers} readiness blocker(s) — runs will fail until fixed.`,
      );
    if (!odoo.reachable) {
      verdict.push(
        schedule.postIfPullFails
          ? `Odoo is not reachable — the run would post from already backed-up data only.`
          : `Odoo is not reachable — the run would stop before posting (no partial days).`,
      );
    }
    if (outlets.willPost === 0)
      verdict.push('No outlet would be posted with the current outlet mode.');
    const toPost = days.reduce((s, d) => s + d.ordersToPost, 0);
    if (toPost === 0)
      verdict.push(
        'Nothing new to post in the window — every backed-up order is already invoiced (receipts/inventory are still re-checked).',
      );
    if (verdict.length === 0)
      verdict.push(
        `Ready: a run would post ${toPost} order(s) across ${plan.window.days.length} closed day(s).`,
      );

    return {
      plan,
      settings: schedule,
      enabled: master && regionEnabled,
      readiness,
      odoo,
      outlets,
      days,
      verdict,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════════════════

  private health(
    s: IntegrationSchedule,
    master: boolean,
    regionEnabled: boolean,
    running: boolean,
    now: Date,
  ): { health: AutomationHealth; reason: string } {
    if (!master)
      return {
        health: 'DISABLED',
        reason: 'Master switch "Automatic Integration" is off.',
      };
    if (!regionEnabled)
      return {
        health: 'DISABLED',
        reason: `Automation is off for ${s.region}.`,
      };
    if (
      !s.lastTickAt ||
      now.getTime() - new Date(s.lastTickAt).getTime() > HEARTBEAT_STALE_MS
    ) {
      return {
        health: 'SCHEDULER_DOWN',
        reason: `The scheduler has not checked this region since ${
          s.lastTickAt ? new Date(s.lastTickAt).toISOString() : 'startup'
        } — the backend scheduler is not running.`,
      };
    }
    if (running) return { health: 'RUNNING', reason: 'A run is in progress.' };
    if (!s.lastRunFinishedAt)
      return {
        health: 'NEVER_RAN',
        reason: 'Enabled, waiting for its first scheduled run.',
      };
    if (s.lastRunStatus === 'FAILED' || s.lastRunStatus === 'NOT_STARTED') {
      return {
        health: 'FAILING',
        reason: `Last run ${s.lastRunStatus} (${s.consecutiveFailures} in a row): ${(s.lastError ?? s.lastRunSummary ?? '').split('\n')[0]}`,
      };
    }
    if (s.lastRunStatus === 'PARTIAL') {
      return {
        health: 'ATTENTION',
        reason: `Last run PARTIAL: ${s.lastRunSummary ?? ''}`,
      };
    }
    const staleMs = s.staleAfterHours * 3_600_000;
    if (
      !s.lastSuccessAt ||
      now.getTime() - new Date(s.lastSuccessAt).getTime() > staleMs
    ) {
      return {
        health: 'STALE',
        reason: `No fully successful run in the last ${s.staleAfterHours}h.`,
      };
    }
    return {
      health: 'HEALTHY',
      reason: `Last run COMPLETED ${new Date(s.lastRunFinishedAt).toISOString()}.`,
    };
  }

  private async probeOdoo(region: string, plan: AutomationPlan) {
    const cred = await this.credentials.findOne({
      where: { region, active: true },
    });
    if (!cred)
      return {
        reachable: false,
        ordersInWindow: null,
        error: 'No active Odoo credential',
      };
    const r = await this.odooBackup.reconcileForCredential(cred, {
      startDate: plan.window.startDate,
      endDate: plan.window.endDate,
    });
    return { reachable: r.ok, ordersInWindow: r.apiTotal, error: r.error };
  }

  private async outletGate(region: string, outletMode: string) {
    const stores = await this.stores.find({
      where: { region, isActive: true },
    });
    const configs = await this.outlets.find({ where: { region } });
    const norm = (v: string | null | undefined) =>
      (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const skippedManual: string[] = [];
    const skippedNone: string[] = [];
    for (const s of stores) {
      const mode = (
        configs.find((c) => norm(c.outletName) === norm(s.branchName))
          ?.integMode ?? 'AUTOMATIC'
      )
        .trim()
        .toUpperCase();
      if (mode === 'NONE') skippedNone.push(s.branchName);
      else if (mode === 'MANUAL' && outletMode !== 'ALL')
        skippedManual.push(s.branchName);
    }
    return {
      stores: stores.length,
      willPost: stores.length - skippedManual.length - skippedNone.length,
      skippedManual,
      skippedNone,
    };
  }

  private async backupDays(region: string, plan: AutomationPlan) {
    const tz = plan.timeZone;
    const start = this.aggregation.localDayWindow(
      plan.window.startDate,
      tz,
    ).start;
    const end = this.aggregation.localDayWindow(plan.window.endDate, tz).end;
    const orders = await this.orders.find({
      where: { region, dateOrder: Between(start, end) },
      select: {
        id: true,
        orderName: true,
        orderId: true,
        dateOrder: true,
        amountTotal: true,
        state: true,
      },
    });
    const names = orders.map((o) => o.orderName ?? String(o.orderId));
    const invoiced = new Set<string>();
    for (let i = 0; i < names.length; i += 900) {
      const rows = await this.invoiceLines.find({
        where: {
          salesOrder: In(names.slice(i, i + 900)),
          region,
          status: 'SUCCESS',
        },
        select: { id: true, salesOrder: true },
      });
      for (const r of rows) if (r.salesOrder) invoiced.add(r.salesOrder);
    }
    const byDay = new Map(
      plan.window.days.map((d) => [
        d,
        {
          businessDay: d,
          ordersInBackup: 0,
          amountInBackup: 0,
          ordersAlreadyInvoiced: 0,
          ordersToPost: 0,
        },
      ]),
    );
    for (const o of orders) {
      if (!o.dateOrder) continue;
      const day = byDay.get(
        this.aggregation.localDayOf(new Date(o.dateOrder), tz),
      );
      if (!day) continue;
      day.ordersInBackup += 1;
      day.amountInBackup += Number(o.amountTotal ?? 0);
      const name = o.orderName ?? String(o.orderId);
      const sale =
        Number(o.amountTotal ?? 0) >= 0 &&
        !['draft', 'cancel', 'cancelled'].includes(
          (o.state ?? '').toLowerCase(),
        );
      if (invoiced.has(name)) day.ordersAlreadyInvoiced += 1;
      else if (sale) day.ordersToPost += 1;
    }
    return [...byDay.values()].map((d) => ({
      ...d,
      amountInBackup: Math.round(d.amountInBackup * 100) / 100,
    }));
  }

  private async raise(
    region: string,
    type: AlertType,
    severity: AlertSeverity,
    title: string,
    message: string,
  ): Promise<void> {
    const key = `${region}:${type}:${severity}`;
    const last = this.lastRaised.get(key) ?? 0;
    if (Date.now() - last < 4 * 3_600_000) return;
    this.lastRaised.set(key, Date.now());
    try {
      await this.alerts.createAlert({
        alertType: type,
        severity,
        title,
        message,
        relatedEntityId: `${SERVICE}:${region}:${type}`,
        relatedEntityType: 'INTEGRATION_SCHEDULE',
      });
      const recipients = await this.notifications.getErrorAlertRecipients();
      this.notifications.sendNotification({
        subject: `[Integration] ${title}`,
        body: message,
        recipients,
      });
    } catch (err) {
      this.logger.warn(`[${region}] could not raise alert: ${this.msg(err)}`);
    }
  }

  private async ensureRegion(region: string): Promise<IntegrationSchedule> {
    await this.syncControl.ensureControl(SERVICE, region, {
      displayName: `Automatic Integration — ${region}`,
      description: `Auto-runs the full integration cycle for ${region} on its schedule.`,
      enabled: false,
    });
    const existing = await this.schedules.findOne({ where: { region } });
    if (existing) return existing;
    try {
      return await this.schedules.save(this.schedules.create({ region }));
    } catch {
      // Created concurrently by another tick — read it back.
      return (await this.schedules.findOne({ where: { region } }))!;
    }
  }

  private async activeRegions(): Promise<string[]> {
    const creds = await this.credentials.find({
      where: { active: true },
      select: { region: true },
    });
    return [
      ...new Set(
        creds
          .map((c) => c.region?.trim().toUpperCase())
          .filter((r): r is string => !!r && r.length > 0),
      ),
    ].sort();
  }

  private async assertKnownRegion(region: string): Promise<void> {
    if (!(await this.activeRegions()).includes(region)) {
      throw new BadRequestException(
        `No active Odoo credential for region ${region}`,
      );
    }
  }

  private normalizeRegion(region: string): string {
    const r = (region ?? '').trim().toUpperCase();
    if (!r) throw new BadRequestException('region is required');
    return r;
  }

  /** Local calendar date + HH:mm of an instant in a timezone. */
  private localParts(
    at: Date,
    timeZone: string,
  ): { date: string; time: string } {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    );
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`,
    };
  }

  /** UTC instant of a local date + HH:mm in a timezone. */
  private localToUtc(day: string, time: string, timeZone: string): Date {
    const [h, m] = time.split(':').map(Number);
    const midnight = this.aggregation.localDayWindow(day, timeZone).start;
    return new Date(midnight.getTime() + (h * 60 + m) * 60_000);
  }

  private addDays(day: string, n: number): string {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
