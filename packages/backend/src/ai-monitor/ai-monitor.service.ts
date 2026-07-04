import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
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
    private readonly prisma: PrismaService,
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
      this.safe(() => this.prisma.fusionCredential.count(), 0),
      this.safe(
        () => this.prisma.fusionCredential.count({ where: { active: true } }),
        0,
      ),
      this.safe(() => this.prisma.odooCredential.count(), 0),
      this.safe(
        () => this.prisma.odooCredential.count({ where: { active: true } }),
        0,
      ),
      this.safe(() => this.prisma.vendHqCredential.count(), 0),
      this.safe(
        () => this.prisma.vendHqCredential.count({ where: { active: true } }),
        0,
      ),
      this.safe(() => this.prisma.ibqCredential.count(), 0),
      this.safe(
        () => this.prisma.ibqCredential.count({ where: { active: true } }),
        0,
      ),
      this.safe(() => this.prisma.syncControl.findMany(), []),
      this.safe(
        () =>
          this.prisma.orderSyncQueue.count({ where: { status: 'PENDING' } }),
        0,
      ),
      this.safe(
        () =>
          this.prisma.orderSyncQueue.count({
            where: { status: 'PROCESSING' },
          }),
        0,
      ),
      this.safe(
        () =>
          this.prisma.orderSyncQueue.count({ where: { status: 'SKIPPED' } }),
        0,
      ),
      this.safe(
        () => this.prisma.orderSyncQueue.count({ where: { status: 'FAILED' } }),
        0,
      ),
      this.safe(
        () => this.prisma.orderSyncQueue.count({ where: { status: 'SYNCED' } }),
        0,
      ),
      this.safe(
        () =>
          this.prisma.syncJob.findMany({
            where: { createdAt: { gte: windowStart } },
            select: { status: true },
          }),
        [] as Array<{ status: string }>,
      ),
      this.safe(
        () =>
          this.prisma.syncJob.count({
            where: {
              status: 'PROCESSING',
              startedAt: { lt: staleBefore },
            },
          }),
        0,
      ),
      this.safe(
        () =>
          this.prisma.failedTransaction.groupBy({
            by: ['errorType'],
            where: { isResolved: false },
            _count: { _all: true },
          }),
        [] as Array<{ errorType: string; _count: { _all: number } }>,
      ),
      this.safe(
        () =>
          this.prisma.failedTransaction.count({
            where: { isResolved: false },
          }),
        0,
      ),
      this.safe(
        () =>
          this.prisma.alertLog.findMany({
            where: { isResolved: false },
            select: { severity: true, alertType: true, title: true },
            take: 100,
          }),
        [] as Array<{ severity: string; alertType: string; title: string }>,
      ),
      this.safe(() => this.getLatestHealthPerService(), []),
      this.safe(
        () => this.prisma.vendHqItemMeta.count({ where: { status: 'ERROR' } }),
        0,
      ),
    ]);

    const byType: Record<string, number> = {};
    for (const row of failedTx) {
      byType[row.errorType] = row._count._all;
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
          alertType: 'SYNC_FAILURE',
          severity: 'CRITICAL',
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
    const records = await this.prisma.integrationHealthCheck.findMany({
      orderBy: { createdAt: 'desc' },
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
