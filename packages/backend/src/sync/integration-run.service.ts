/**
 * IntegrationRunService — the operator's "run the whole integration" button.
 *
 * One run = (region, startDate..endDate):
 *   Phase 1  PULL   — fetch the region's Odoo orders for the date range into
 *                     the backup tables and ingest them into OrderSyncQueue.
 *   Phase 2  POST   — one Oracle AR invoice per (store, business day,
 *                     customer type, credit flag) with the FULL cycle:
 *                     invoice → standard receipts → misc receipts → apply
 *                     receipts → GL journals → inventory issues
 *                     (all inside DailyInvoiceService.postDay).
 *
 * The run is tracked as a SyncJob (jobType=INTEGRATION_RUN) whose scopeValue
 * carries a live event log + per-day results, and progress is pushed over the
 * websocket ('integrationRun') so the dashboard can monitor it in real time.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { GatewayService } from '../gateway/gateway.service';
import { OdooBackupService } from '../odoo-backup/odoo-backup.service';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { JobStatus, JobType, ScopeType } from '../database/enums';
import { generateId } from '../database/id.util';
import {
  DailyInvoiceOutcome,
  DailyInvoiceService,
} from './daily-invoice.service';

/** Hard cap so an operator cannot accidentally walk a year of history. */
const MAX_RANGE_DAYS = 31;
/** Keep the live event log bounded — the UI shows the tail anyway. */
const MAX_EVENTS = 300;

export interface IntegrationRunEvent {
  at: string;
  phase: 'PULL' | 'POST' | 'DONE';
  message: string;
}

export interface IntegrationRunScope {
  kind: 'INTEGRATION_RUN';
  region: string;
  startDate: string;
  endDate: string;
  phase: 'PENDING' | 'PULL' | 'POST' | 'DONE';
  pull: {
    credentials: number;
    saved: number;
    skipped: number;
    ingested: number;
    ingestSkipped: number;
  };
  post: {
    daysPlanned: number;
    daysDone: number;
    invoicesCreated: number;
    invoicesFailed: number;
    invoicesSkipped: number;
    standardReceipts: number;
    miscReceipts: number;
    journals: number;
    inventoryTransactions: number;
  };
  /** Per (store, day, group) Oracle outcome rows for the results table. */
  results: DailyInvoiceOutcome[];
  events: IntegrationRunEvent[];
}

@Injectable()
export class IntegrationRunService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntegrationRunService.name);
  /**
   * Regions with a run in flight. Different regions run concurrently (their
   * Oracle cycles touch disjoint stores/BUs), but the SAME region must never
   * race itself — re-posting the same store/day mid-flight risks duplicates.
   */
  private readonly runningRegions = new Set<string>();

  constructor(
    @InjectRepository(SyncJob)
    private readonly jobs: Repository<SyncJob>,
    @InjectRepository(OdooCredential)
    private readonly credentials: Repository<OdooCredential>,
    private readonly odooBackup: OdooBackupService,
    private readonly dailyInvoice: DailyInvoiceService,
    private readonly gateway: GatewayService,
  ) {}

  /**
   * A run executes as an in-memory fire-and-forget task, so any process restart
   * (deploy, crash, or a dev `nest --watch` hot-reload triggered by a source
   * edit) orphans an in-flight run: its SyncJob row is left at PROCESSING with
   * nothing driving it forward, and the dashboard polls it forever showing
   * "stuck". On startup nothing is executing, so ANY run still marked
   * PROCESSING/PENDING is by definition orphaned — mark it FAILED with a clear
   * cause. The range is safe to re-run (stores already posted are skipped).
   */
  async onApplicationBootstrap(): Promise<void> {
    let stranded: SyncJob[];
    try {
      stranded = await this.jobs.find({
        where: {
          jobType: JobType.INTEGRATION_RUN,
          status: In([JobStatus.PROCESSING, JobStatus.PENDING]),
        },
      });
    } catch (err) {
      // Never block boot on this housekeeping step.
      this.logger.warn(
        `Could not scan for stranded integration runs: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (stranded.length === 0) return;

    for (const job of stranded) {
      const scope = job.scopeValue as IntegrationRunScope | null;
      if (scope) {
        scope.phase = 'DONE';
        scope.events = scope.events ?? [];
        scope.events.push({
          at: new Date().toISOString(),
          phase: 'DONE',
          message:
            '❌ Run interrupted by a server restart — nothing was left running ' +
            'to finish it. Re-run the same range; stores already posted are ' +
            'skipped automatically.',
        });
      }
      await this.jobs
        .update(job.id, {
          status: JobStatus.FAILED,
          errorMessage:
            'Interrupted by a server restart (the process running it was ' +
            'replaced before it finished).',
          completedAt: new Date(),
          ...(scope ? { scopeValue: scope } : {}),
        })
        .catch(() => undefined);
      this.logger.warn(
        `Marked stranded integration run ${job.id} (${scope?.region ?? '?'}) ` +
          `as FAILED — interrupted by a restart.`,
      );
    }
  }

  /** Starts a run and returns immediately with the tracking job. */
  async startRun(params: {
    region: string;
    startDate: string;
    endDate: string;
    createdBy?: string;
  }): Promise<SyncJob> {
    const region = (params.region ?? '').trim().toUpperCase();
    if (!region) throw new BadRequestException('region is required');
    for (const [name, v] of [
      ['startDate', params.startDate],
      ['endDate', params.endDate],
    ] as const) {
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new BadRequestException(`${name} is required as YYYY-MM-DD`);
      }
    }
    const days = this.dayCount(params.startDate, params.endDate);
    if (days < 1) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Date range too large (${days} days) — maximum is ${MAX_RANGE_DAYS} days per run.`,
      );
    }

    const creds = await this.credentials.find({
      where: { region, active: true },
    });
    if (creds.length === 0) {
      throw new BadRequestException(
        `No active OdooCredential configured for region ${region} — ` +
          `add one under Admin → Odoo Credentials before running the integration.`,
      );
    }

    if (this.runningRegions.has(region)) {
      throw new BadRequestException(
        `An integration run for ${region} is already in progress — wait for it ` +
          `to finish. (Other regions can run at the same time.)`,
      );
    }

    const scope: IntegrationRunScope = {
      kind: 'INTEGRATION_RUN',
      region,
      startDate: params.startDate,
      endDate: params.endDate,
      phase: 'PENDING',
      pull: {
        credentials: creds.length,
        saved: 0,
        skipped: 0,
        ingested: 0,
        ingestSkipped: 0,
      },
      post: {
        daysPlanned: days,
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

    const job = await this.jobs.save(
      this.jobs.create({
        id: generateId(),
        jobType: JobType.INTEGRATION_RUN,
        scopeType: ScopeType.DATE_RANGE,
        scopeValue: scope,
        status: JobStatus.PENDING,
        totalRecords: days,
        createdBy: params.createdBy ?? 'ADMIN_UI',
      }),
    );

    this.runningRegions.add(region);
    // Fire and forget — progress is observable via GET + websocket.
    void this.execute(job.id, scope, creds).finally(() => {
      this.runningRegions.delete(region);
    });
    return job;
  }

  /**
   * Starts a run for EVERY active region over the same date range. Regions run
   * concurrently (each has its own per-region lock). A region already running,
   * or with no credentials, is reported in `skipped` rather than aborting the
   * batch. Returns the started jobs so the UI can track them all.
   */
  async startAllActiveRegions(params: {
    startDate: string;
    endDate: string;
    createdBy?: string;
  }): Promise<{
    started: Array<{ region: string; jobId: string }>;
    skipped: Array<{ region: string; reason: string }>;
  }> {
    const rows = await this.credentials.find({
      where: { active: true },
      select: { region: true },
    });
    const regions = [
      ...new Set(
        rows
          .map((c) => c.region?.trim().toUpperCase())
          .filter((r): r is string => !!r && r.length > 0),
      ),
    ].sort();

    const started: Array<{ region: string; jobId: string }> = [];
    const skipped: Array<{ region: string; reason: string }> = [];
    for (const region of regions) {
      try {
        const job = await this.startRun({
          region,
          startDate: params.startDate,
          endDate: params.endDate,
          createdBy: params.createdBy ?? 'ADMIN_UI',
        });
        started.push({ region, jobId: job.id });
      } catch (err) {
        skipped.push({
          region,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { started, skipped };
  }

  async getRun(id: string): Promise<SyncJob | null> {
    return this.jobs.findOne({
      where: { id, jobType: JobType.INTEGRATION_RUN },
    });
  }

  async listRuns(limit = 20): Promise<SyncJob[]> {
    return this.jobs.find({
      where: { jobType: JobType.INTEGRATION_RUN },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async execute(
    jobId: string,
    scope: IntegrationRunScope,
    creds: OdooCredential[],
  ): Promise<void> {
    const save = async (status?: JobStatus, patch?: Partial<SyncJob>) => {
      await this.jobs.update(jobId, {
        scopeValue: scope,
        ...(status ? { status } : {}),
        ...(patch as object),
      });
    };
    const log = async (
      phase: IntegrationRunEvent['phase'],
      message: string,
      status?: JobStatus,
    ) => {
      scope.events.push({ at: new Date().toISOString(), phase, message });
      if (scope.events.length > MAX_EVENTS)
        scope.events.splice(0, scope.events.length - MAX_EVENTS);
      this.logger.log(`[run ${jobId}] [${phase}] ${message}`);
      await save(status);
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
    };

    try {
      await this.jobs.update(jobId, {
        status: JobStatus.PROCESSING,
        startedAt: new Date(),
      });

      // ── Phase 1: pull Odoo orders for the range ─────────────────────────
      scope.phase = 'PULL';
      await log(
        'PULL',
        `Pulling Odoo orders for ${scope.region} ` +
          `${scope.startDate} → ${scope.endDate} (${creds.length} credential(s))…`,
      );
      for (const cred of creds) {
        try {
          // Live pull progress: BACKUP/INGEST report `done/total` per credential.
          // Persist the running counters to the job scope (throttled) so the
          // dashboard's "Orders pulled" tile climbs in real time instead of
          // staying at 0 until the whole (possibly multi-thousand-row) pull ends.
          const baseSaved = scope.pull.saved;
          const baseIngested = scope.pull.ingested;
          let lastEmit = 0;
          const r = await this.odooBackup.backupAndIngestForCredential(
            cred,
            {
              startDate: `${scope.startDate} 00:00:00`,
              endDate: `${scope.endDate} 23:59:59`,
              // The POST phase aggregates straight from the backup tables, so the
              // per-order OrderSyncQueue ingest is pure overhead here — skip it.
              skipIngest: true,
            },
            (p) => {
              if (p.phase === 'BACKUP') scope.pull.saved = baseSaved + p.done;
              else scope.pull.ingested = baseIngested + p.done;
              const now = Date.now();
              if (now - lastEmit < 800 && p.done < p.total) return;
              lastEmit = now;
              void log(
                'PULL',
                `${cred.region}: ${p.phase === 'BACKUP' ? 'backing up' : 'queuing'} ` +
                  `${p.done}/${p.total} order(s)…`,
              );
            },
          );
          scope.pull.saved = baseSaved + r.saved;
          scope.pull.skipped += r.skipped;
          scope.pull.ingested = baseIngested + r.ingested;
          scope.pull.ingestSkipped += r.ingestSkipped;
          await log(
            'PULL',
            `${cred.region} (${cred.baseUrl}): ${r.total} order(s) fetched — ` +
              `${r.saved} backed up, ${r.ingested} queued, ${r.ingestSkipped} skipped.`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await log(
            'PULL',
            `⚠ Pull failed for credential ${cred.baseUrl}: ${msg} — continuing with backed-up data.`,
          );
        }
      }

      // ── Phase 2: one invoice per store per day + full Oracle cycle ──────
      scope.phase = 'POST';
      await log(
        'POST',
        `Posting daily invoices for ${scope.region}: ` +
          `${scope.post.daysPlanned} day(s), one invoice per store per day…`,
      );
      let processed = 0;
      let lastPostEmit = 0;
      const applyOutcome = (o: DailyInvoiceOutcome) => {
        if (o.status === 'CREATED') scope.post.invoicesCreated++;
        else if (o.status === 'FAILED') scope.post.invoicesFailed++;
        else scope.post.invoicesSkipped++;
        scope.post.standardReceipts += o.standardReceipts;
        scope.post.miscReceipts += o.miscReceipts;
        scope.post.journals += o.journals;
        scope.post.inventoryTransactions += o.inventoryTransactions ?? 0;
      };
      for (let i = 0; i < scope.post.daysPlanned; i++) {
        const day = this.addDays(scope.startDate, i);
        // Live per-store progress: fold each store's outcomes into the counters
        // and results table as they land, so the dashboard fills in step by step.
        await this.dailyInvoice.postRange(
          {
            region: scope.region,
            startDate: day,
            days: 1,
            trigger: 'ALL',
          },
          (p) => {
            for (const o of p.outcomes) applyOutcome(o);
            scope.results.push(...p.outcomes);
            const now = Date.now();
            if (
              now - lastPostEmit < 800 &&
              p.storesDone < p.storesTotal
            )
              return;
            lastPostEmit = now;
            void log(
              'POST',
              `${day}: ${p.branchName ?? p.branchCode} (${p.branchCode}) — ` +
                `${p.storesDone}/${p.storesTotal} stores · ` +
                `${scope.post.invoicesCreated} invoice(s), ` +
                `${scope.post.journals} journal(s) so far…`,
            );
          },
        );
        scope.post.daysDone = i + 1;
        processed = i + 1;
        await this.jobs.update(jobId, {
          processedRecords: processed,
          successCount: scope.post.invoicesCreated,
          failedCount: scope.post.invoicesFailed,
          skippedCount: scope.post.invoicesSkipped,
        });
        await log(
          'POST',
          `${day} complete: ${scope.post.invoicesCreated} invoice(s) created, ` +
            `${scope.post.invoicesFailed} failed, ${scope.post.invoicesSkipped} skipped.`,
        );
      }

      // ── Wrap up ─────────────────────────────────────────────────────────
      scope.phase = 'DONE';
      const finalStatus =
        scope.post.invoicesFailed === 0
          ? JobStatus.COMPLETED
          : scope.post.invoicesCreated > 0
            ? JobStatus.PARTIAL
            : JobStatus.FAILED;
      await this.jobs.update(jobId, { completedAt: new Date() });
      await log(
        'DONE',
        `Run finished: ${scope.pull.ingested} order(s) pulled, ` +
          `${scope.post.invoicesCreated} invoice(s) created, ` +
          `${scope.post.standardReceipts} standard + ${scope.post.miscReceipts} misc receipt(s), ` +
          `${scope.post.journals} journal(s), ` +
          `${scope.post.inventoryTransactions} inventory transaction(s), ` +
          `${scope.post.invoicesFailed} failure(s).`,
        finalStatus,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      scope.phase = 'DONE';
      this.logger.error(`[run ${jobId}] aborted: ${msg}`);
      scope.events.push({
        at: new Date().toISOString(),
        phase: 'DONE',
        message: `❌ Run aborted: ${msg}`,
      });
      await this.jobs
        .update(jobId, {
          status: JobStatus.FAILED,
          errorMessage: msg,
          completedAt: new Date(),
          scopeValue: scope,
        })
        .catch(() => undefined);
      this.gateway.emitIntegrationRun({
        jobId,
        status: JobStatus.FAILED,
        phase: 'DONE',
        message: `Run aborted: ${msg}`,
      });
    }
  }

  private dayCount(start: string, end: string): number {
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ey, em, ed] = end.split('-').map(Number);
    const ms = Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd);
    return Math.floor(ms / 86_400_000) + 1;
  }

  private addDays(day: string, n: number): string {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
}
