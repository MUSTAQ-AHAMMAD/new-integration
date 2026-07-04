/**
 * Types for the AI-powered monitoring / diagnostics feature.
 *
 * The monitor collects a snapshot of live "signals" from the database and
 * running services, runs a deterministic rule engine over them to produce
 * {@link Finding}s, and (optionally) asks an LLM to write a human-friendly
 * summary. Everything here is plain data so the rule engine stays pure and
 * easily unit-testable.
 */

export type FindingSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export type OverallStatus = 'healthy' | 'degraded' | 'unhealthy';

/** A single issue detected by the rule engine. */
export interface Finding {
  /** Stable identifier for the detector that produced this finding. */
  id: string;
  severity: FindingSeverity;
  /** High-level area, e.g. "credentials", "connectivity", "pipeline". */
  category: string;
  title: string;
  /** Human-readable explanation of what is wrong and why it matters. */
  detail: string;
  /** Concrete next step the operator should take to fix it. */
  recommendation: string;
  /** Optional structured data backing the finding (counts, names, …). */
  evidence?: Record<string, unknown>;
}

export interface CredentialSignal {
  active: number;
  total: number;
}

export interface SyncControlSignal {
  serviceName: string;
  enabled: boolean;
  isRunning: boolean;
  lastStatus: string | null;
  lastRunAt: Date | null;
  errorCount: number;
}

export interface HealthSignal {
  serviceName: string;
  status: string;
  consecutiveFailures: number;
  failureReason: string | null;
  lastSuccessAt: Date | null;
}

export interface UnresolvedAlertSignal {
  severity: string;
  alertType: string;
  title: string;
}

/**
 * A point-in-time snapshot of everything the rule engine reasons about.
 * Collected by {@link AiMonitorService.collectSignals}.
 */
export interface DiagnosticSignals {
  collectedAt: string;
  credentials: {
    fusion: CredentialSignal;
    odoo: CredentialSignal;
    vendhq: CredentialSignal;
    ibq: CredentialSignal;
  };
  syncControls: SyncControlSignal[];
  queue: {
    pending: number;
    processing: number;
    skipped: number;
    failed: number;
    synced: number;
  };
  recentJobs: {
    windowHours: number;
    total: number;
    failed: number;
    partial: number;
    completed: number;
    /** Jobs stuck in PROCESSING beyond the stale threshold. */
    stale: number;
  };
  failedTransactions: {
    unresolved: number;
    byType: Record<string, number>;
  };
  unresolvedAlerts: UnresolvedAlertSignal[];
  health: HealthSignal[];
  itemSyncErrors: number;
}

export interface AnalysisResult {
  status: OverallStatus;
  /** 0 (broken) – 100 (perfect). */
  healthScore: number;
  generatedAt: string;
  findings: Finding[];
  counts: {
    critical: number;
    warning: number;
    info: number;
  };
  summary: string;
  summarySource: 'ai' | 'rule-based';
  signals: DiagnosticSignals;
}
