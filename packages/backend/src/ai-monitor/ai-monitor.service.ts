import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { AlertsService } from '../alerts/alerts.service';
import { AlertLog } from '../database/entities/alert-log.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { FusionCredential } from '../database/entities/fusion-credential.entity';
import { IbqCredential } from '../database/entities/ibq-credential.entity';
import { IntegrationHealthCheck } from '../database/entities/integration-health-check.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncControl } from '../database/entities/sync-control.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import {
  AlertSeverity,
  AlertType,
  JobStatus,
  SyncStatus,
} from '../database/enums';
import { LlmSummaryClient } from './llm-summary.client';
import {
  analyzeSignals,
  buildRuleBasedSummary,
  computeHealthScore,
  countBySeverity,
  deriveStatus,
} from './diagnostic-rules';
import type { AnalysisResult, DiagnosticSignals } from './ai-monitor.types';

/**
 * AI-powered monitoring service.
 *
 * Collects a live snapshot of the integration's state, runs the deterministic
 * rule engine to detect issues, and optionally enriches the report with an
 * LLM-written summary. Also runs on a schedule and raises alerts for new
 * critical findings so operators are notified without opening the dashboard.
 */
@Injectable()
export class AiMonitorService {
  private readonly logger = new Logger(AiMonitorService.name);

  /** A PROCESSING job older than this is considered stuck/stale. */
  private readonly STALE_JOB_MS = 30 * 60 * 1000; // 30 minutes
  private readonly RECENT_WINDOW_HOURS = 24;

  constructor(
    @InjectRepository(FusionCredential)
    private readonly fusionCredentials: Repository<FusionCredential>,
    @InjectRepository(OdooCredential)
    private readonly odooCredentials: Repository<OdooCredential>,
    @InjectRepository(VendHqCredential)
    private readonly vendhqCredentials: Repository<VendHqCredential>,
    @InjectRepository(IbqCredential)
    private readonly ibqCredentials: Repository<IbqCredential>,
    @InjectRepository(SyncControl)
    private readonly syncControlsRepo: Repository<SyncControl>,
    @InjectRepository(OrderSyncQueue)
    private readonly orders: Repository<OrderSyncQueue>,
    @InjectRepository(SyncJob)
    private readonly jobs: Repository<SyncJob>,
    @InjectRepository(FailedTransaction)
    private readonly failedTransactions: Repository<FailedTransaction>,
    @InjectRepository(AlertLog)
    private readonly alertsRepo: Repository<AlertLog>,
    @InjectRepository(IntegrationHealthCheck)
    private readonly health: Repository<IntegrationHealthCheck>,
    @InjectRepository(VendHqItemMeta)
    private readonly vendhqItems: Repository<VendHqItemMeta>,
    private readonly alerts: AlertsService,
    private readonly llm: LlmSummaryClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * Gathers all diagnostic signals from the database. Each query is guarded so
   * a single failing query cannot take down the whole report.
   */
  async collectSignals(): Promise<DiagnosticSignals> {
    const windowStart = new Date(
      Date.now() - this.RECENT_WINDOW_HOURS * 60 * 60 * 1000,
    );
    const staleBefore = new Date(Date.now() - this.STALE_JOB_MS);

    const [
      fusionTotal,
      fusionActive,
      odooTotal,
      odooActive,
      vendhqTotal,
      vendhqActive,
      ibqTotal,
      ibqActive,
      syncControls,
      pending,
      processing,
      skipped,
      queueFailed,
      synced,
      recentJobs,
      staleJobs,
      failedTx,
      unresolvedFailedTx,
      unresolvedAlerts,
      health,
      itemSyncErrors,
    ] = await Promise.all([
      this.safe(() => this.fusionCredentials.count(), 0),
      this.safe(
        () => this.fusionCredentials.count({ where: { active: true } }),
        0,
      ),
      this.safe(() => this.odooCredentials.count(), 0),
      this.safe(
        () => this.odooCredentials.count({ where: { active: true } }),
        0,
      ),
      this.safe(() => this.vendhqCredentials.count(), 0),
      this.safe(
        () => this.vendhqCredentials.count({ where: { active: true } }),
        0,
      ),
      this.safe(() => this.ibqCredentials.count(), 0),
      this.safe(
        () => this.ibqCredentials.count({ where: { active: true } }),
        0,
      ),
      this.safe(() => this.syncControlsRepo.find(), []),
      this.safe(
        () => this.orders.count({ where: { status: SyncStatus.PENDING } }),
        0,
      ),
      this.safe(
        () => this.orders.count({ where: { status: SyncStatus.PROCESSING } }),
        0,
      ),
      this.safe(
        () => this.orders.count({ where: { status: SyncStatus.SKIPPED } }),
        0,
      ),
      this.safe(
        () => this.orders.count({ where: { status: SyncStatus.FAILED } }),
        0,
      ),
      this.safe(
        () => this.orders.count({ where: { status: SyncStatus.SYNCED } }),
        0,
      ),
      this.safe(
        () =>
          this.jobs.find({
            where: { createdAt: MoreThanOrEqual(windowStart) },
            select: { status: true },
          }),
        [] as Array<{ status: string }>,
      ),
      this.safe(
        () =>
          this.jobs.count({
            where: {
              status: JobStatus.PROCESSING,
              startedAt: LessThan(staleBefore),
            },
          }),
        0,
      ),
      this.safe(
        () =>
          this.failedTransactions
            .createQueryBuilder('f')
            .select('f.errorType', 'errorType')
            .addSelect('COUNT(*)', 'count')
            .where('f.isResolved = :resolved', { resolved: false })
            .groupBy('f.errorType')
            .getRawMany<{ errorType: string; count: string | number }>(),
        [] as Array<{ errorType: string; count: string | number }>,
      ),
      this.safe(
        () => this.failedTransactions.count({ where: { isResolved: false } }),
        0,
      ),
      this.safe(
        () =>
          this.alertsRepo.find({
            where: { isResolved: false },
            select: { severity: true, alertType: true, title: true },
            take: 100,
          }),
        [] as Array<{ severity: string; alertType: string; title: string }>,
      ),
      this.safe(() => this.getLatestHealthPerService(), []),
      this.safe(
        () => this.vendhqItems.count({ where: { status: 'ERROR' } }),
        0,
      ),
    ]);

    const byType: Record<string, number> = {};
    for (const row of failedTx) {
      byType[row.errorType] = Number(row.count);
    }

    return {
      collectedAt: new Date().toISOString(),
      credentials: {
        fusion: { active: fusionActive, total: fusionTotal },
        odoo: { active: odooActive, total: odooTotal },
        vendhq: { active: vendhqActive, total: vendhqTotal },
        ibq: { active: ibqActive, total: ibqTotal },
      },
      syncControls: syncControls.map((s) => ({
        serviceName: s.serviceName,
        enabled: s.enabled,
        isRunning: s.isRunning,
        lastStatus: s.lastStatus,
        lastRunAt: s.lastRunAt,
        errorCount: s.errorCount,
      })),
      queue: {
        pending,
        processing,
        skipped,
        failed: queueFailed,
        synced,
      },
      recentJobs: {
        windowHours: this.RECENT_WINDOW_HOURS,
        total: recentJobs.length,
        failed: recentJobs.filter((j) => j.status === 'FAILED').length,
        partial: recentJobs.filter((j) => j.status === 'PARTIAL').length,
        completed: recentJobs.filter((j) => j.status === 'COMPLETED').length,
        stale: staleJobs,
      },
      failedTransactions: {
        unresolved: unresolvedFailedTx,
        byType,
      },
      unresolvedAlerts,
      health,
      itemSyncErrors,
    };
  }

  /** Runs the full analysis: signals → findings → score → summary. */
  async analyze(): Promise<AnalysisResult> {
    const signals = await this.collectSignals();
    const findings = analyzeSignals(signals);
    const score = computeHealthScore(findings);
    const status = deriveStatus(findings, score);

    const aiSummary = await this.llm.summarise(signals, findings);
    const summary = aiSummary ?? buildRuleBasedSummary(findings, status, score);

    return {
      status,
      healthScore: score,
      generatedAt: new Date().toISOString(),
      findings,
      counts: countBySeverity(findings),
      summary,
      summarySource: aiSummary ? 'ai' : 'rule-based',
      signals,
    };
  }

  /**
   * Periodic analysis. Raises an alert for each critical finding (deduplicated
   * by the AlertsService) so operators are notified proactively.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async scheduledAnalysis(): Promise<void> {
    if (this.config.get<string>('AI_MONITOR_ENABLED') === 'false') {
      return;
    }
    try {
      const result = await this.analyze();
      const critical = result.findings.filter((f) => f.severity === 'CRITICAL');
      for (const finding of critical) {
        await this.alerts.createAlert({
          alertType: AlertType.SYNC_FAILURE,
          severity: AlertSeverity.CRITICAL,
          title: `AI Monitor: ${finding.title}`,
          message: `${finding.detail} Recommended fix: ${finding.recommendation}`,
          relatedEntityType: 'AI_MONITOR',
          relatedEntityId: finding.id,
        });
      }
      this.logger.log(
        `AI monitor analysis complete: status=${result.status} score=${result.healthScore} findings=${result.findings.length} (${critical.length} critical)`,
      );
    } catch (err) {
      this.logger.error(
        `Scheduled AI monitor analysis failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /** Returns the most recent health record for each service. */
  private async getLatestHealthPerService(): Promise<
    DiagnosticSignals['health']
  > {
    const records = await this.health.find({
      order: { createdAt: 'DESC' },
      take: 200,
      select: {
        serviceName: true,
        status: true,
        consecutiveFailures: true,
        failureReason: true,
        lastSuccessAt: true,
        createdAt: true,
      },
    });
    const latest = new Map<string, DiagnosticSignals['health'][number]>();
    for (const r of records) {
      if (!latest.has(r.serviceName)) {
        latest.set(r.serviceName, {
          serviceName: r.serviceName,
          status: r.status,
          consecutiveFailures: r.consecutiveFailures,
          failureReason: r.failureReason,
          lastSuccessAt: r.lastSuccessAt,
        });
      }
    }
    return [...latest.values()];
  }

  /**
   * Runs a query and returns a fallback value if it throws, logging a warning.
   * Keeps the diagnostics report resilient to individual query failures.
   */
  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(
        `Diagnostic signal query failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return fallback;
    }
  }
}
