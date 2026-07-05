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

/**
 * Options controlling the guided remediation flow. The flow mirrors the
 * diagnostic runbook: it populates store configuration, resolves unmapped
 * payment methods, retries the failed backlog (only once the previous two are
 * clean) and finally re-processes skipped orders.
 */
export interface RemediationOptions {
  /**
   * When true, no state-changing action is performed. Each step reports what
   * it *would* do so operators can preview the plan safely.
   */
  dryRun?: boolean;
  /**
   * When provided, any payment-method mappings still awaiting approval are
   * approved on behalf of this operator. Without it, pending mappings block
   * the retry step (step 4) so orders are not retried against unmapped
   * payment methods.
   */
  approvePaymentMappingsBy?: string;
  /**
   * When true (default), the skipped-order auto-fix + retry step runs after
   * the failed backlog is retried.
   */
  includeSkipped?: boolean;
  /** Max number of skipped orders to auto-fix / retry. */
  skippedLimit?: number;
}

export type RemediationStepStatus = 'ok' | 'skipped' | 'failed' | 'blocked';

/** Result of a single remediation step. */
export interface RemediationStepResult {
  /** Stable step identifier, e.g. "store-config". */
  id: string;
  /** Runbook step number this maps to (2–5). */
  step: number;
  title: string;
  status: RemediationStepStatus;
  /** Human-readable outcome / reason (especially for skipped/blocked). */
  message: string;
  /** Optional structured details (counts, mapping names, …). */
  details?: Record<string, unknown>;
}

export interface RemediationResult {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  /** True when every attempted step finished with status "ok". */
  ok: boolean;
  steps: RemediationStepResult[];
  /** Short human-readable summary of what happened. */
  summary: string;
}
