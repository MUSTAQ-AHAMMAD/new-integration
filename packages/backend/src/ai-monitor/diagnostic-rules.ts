import type {
  DiagnosticSignals,
  Finding,
  FindingSeverity,
  OverallStatus,
} from './ai-monitor.types';

/**
 * Deterministic diagnostic rule engine.
 *
 * These are pure functions — given a {@link DiagnosticSignals} snapshot they
 * return the list of {@link Finding}s, a health score and an overall status.
 * Keeping them pure makes the "brain" of the AI monitor fully unit-testable
 * without a database, and lets the (optional) LLM layer sit on top purely to
 * rephrase these deterministic conclusions in natural language.
 */

const SCORE_PENALTY: Record<FindingSeverity, number> = {
  CRITICAL: 30,
  WARNING: 10,
  INFO: 3,
};

/** Thresholds — kept here so they are easy to tune and to assert in tests. */
export const THRESHOLDS = {
  /** Failed sync jobs in the window before it becomes CRITICAL. */
  failedJobsCritical: 5,
  /** Failed sync jobs in the window before it becomes a WARNING. */
  failedJobsWarning: 1,
  /** Pending queue backlog before warning about throughput. */
  backlogWarning: 500,
  /** Pending queue backlog before it becomes critical. */
  backlogCritical: 2000,
  /** Unresolved failed transactions before warning. */
  failedTxWarning: 25,
};

/**
 * Classifies a free-text failure reason into a likely root cause. This mirrors
 * the kind of pattern-matching the Oracle SOAP error extractor performs and
 * lets us turn opaque errors into actionable advice.
 */
export function classifyFailureReason(reason: string | null | undefined): {
  cause: string;
  recommendation: string;
} {
  const text = (reason ?? '').toLowerCase();

  if (
    text.includes('certificate') ||
    text.includes('self signed') ||
    text.includes('cert') ||
    text.includes('ssl') ||
    text.includes('tls')
  ) {
    return {
      cause: 'TLS/SSL certificate mismatch',
      recommendation:
        'The endpoint certificate does not match the hostname. For a *.dev instance set rejectUnauthorizedSsl=false on the credential; for production verify the correct base URL.',
    };
  }
  if (
    text.includes('401') ||
    text.includes('403') ||
    text.includes('unauthor') ||
    text.includes('forbidden') ||
    text.includes('authentication') ||
    text.includes('invalid credentials') ||
    text.includes('access denied')
  ) {
    return {
      cause: 'Authentication rejected',
      recommendation:
        'The username/password or API key is wrong or expired. Re-enter the credential in the Admin panel and restart the backend.',
    };
  }
  if (
    text.includes('enotfound') ||
    text.includes('econnrefused') ||
    text.includes('etimedout') ||
    text.includes('timeout') ||
    text.includes('econnreset') ||
    text.includes('network') ||
    text.includes('getaddrinfo')
  ) {
    return {
      cause: 'Network / connectivity failure',
      recommendation:
        'The host is unreachable. Check the base URL/hostname, DNS, and that the server is online and not blocked by a firewall.',
    };
  }
  if (text.includes('404') || text.includes('not found')) {
    return {
      cause: 'Endpoint path not found (404)',
      recommendation:
        'The API path is wrong. Verify the API Path on the credential (e.g. /api/pos/order vs /api/sale.order).',
    };
  }
  return {
    cause: 'Unclassified error',
    recommendation:
      'Inspect the backend/worker logs for the full error and address the reported message.',
  };
}

/**
 * Runs every detector against the signal snapshot and returns the findings,
 * ordered by severity (CRITICAL first).
 */
export function analyzeSignals(signals: DiagnosticSignals): Finding[] {
  const findings: Finding[] = [];
  const { credentials, syncControls, queue, recentJobs, failedTransactions } =
    signals;

  // ── Credentials ──────────────────────────────────────────────────────────
  if (credentials.fusion.active === 0) {
    findings.push({
      id: 'no-active-fusion-credentials',
      severity: 'CRITICAL',
      category: 'credentials',
      title: 'No active Oracle Fusion credentials',
      detail:
        'There is no active FusionCredential, so the integration cannot push invoices, receipts or journals to Oracle. Every downstream sync will fail or be skipped.',
      recommendation:
        'Add an active credential under Admin → Fusion Credentials (host name + server + username + password), then restart the backend.',
      evidence: { ...credentials.fusion },
    });
  }

  const hasOdoo = credentials.odoo.active > 0;
  const hasIbq = credentials.ibq.active > 0;
  const hasVendhq = credentials.vendhq.active > 0;
  if (!hasOdoo && !hasIbq && !hasVendhq) {
    findings.push({
      id: 'no-active-source-credentials',
      severity: 'CRITICAL',
      category: 'credentials',
      title: 'No active data-source credentials',
      detail:
        'No active Odoo, IBQ or VendHQ credential exists, so there is no source system to pull orders from. Nothing will ever enter the pipeline.',
      recommendation:
        'Add at least one active source credential under Admin → Odoo / IBQ / VendHQ Credentials.',
      evidence: {
        odoo: credentials.odoo,
        ibq: credentials.ibq,
        vendhq: credentials.vendhq,
      },
    });
  }

  // ── Health checks ──────────────────────────────────────────────────────────
  for (const h of signals.health) {
    if (h.status === 'UNHEALTHY') {
      const { cause, recommendation } = classifyFailureReason(h.failureReason);
      findings.push({
        id: `service-unhealthy-${h.serviceName.toLowerCase()}`,
        severity: 'CRITICAL',
        category: 'connectivity',
        title: `${h.serviceName} is unhealthy (${cause})`,
        detail: `The last health check for ${h.serviceName} failed${
          h.consecutiveFailures
            ? ` (${h.consecutiveFailures} consecutive failures)`
            : ''
        }: ${h.failureReason ?? 'no reason reported'}.`,
        recommendation,
        evidence: {
          serviceName: h.serviceName,
          consecutiveFailures: h.consecutiveFailures,
          failureReason: h.failureReason,
        },
      });
    } else if (h.status === 'DEGRADED') {
      findings.push({
        id: `service-degraded-${h.serviceName.toLowerCase()}`,
        severity: 'WARNING',
        category: 'connectivity',
        title: `${h.serviceName} is degraded`,
        detail: `${h.serviceName} responded but is reporting degraded performance.`,
        recommendation:
          'Monitor response times; investigate if it escalates to UNHEALTHY.',
        evidence: { serviceName: h.serviceName },
      });
    }
  }

  // ── Sync control switches ────────────────────────────────────────────────
  const disabled = syncControls.filter((s) => !s.enabled);
  if (disabled.length > 0) {
    findings.push({
      id: 'sync-services-disabled',
      severity: 'WARNING',
      category: 'pipeline',
      title: `${disabled.length} sync service(s) disabled`,
      detail: `These services are switched off and will not run: ${disabled
        .map((s) => s.serviceName)
        .join(', ')}. Orders will not flow while they are disabled.`,
      recommendation:
        'Enable the required services under Admin → Sync Control if they were disabled unintentionally.',
      evidence: { disabled: disabled.map((s) => s.serviceName) },
    });
  }

  // A processing backlog with no service currently running often means the
  // worker process is down.
  const anyRunning = syncControls.some((s) => s.isRunning);
  if (queue.pending > 0 && syncControls.length > 0 && !anyRunning) {
    findings.push({
      id: 'worker-possibly-down',
      severity: 'WARNING',
      category: 'pipeline',
      title: 'Pending orders but no sync service is running',
      detail: `${queue.pending} order(s) are waiting in the queue but no sync service reports isRunning=true. The worker process may be stopped.`,
      recommendation:
        'Check that the worker container is up (docker compose ps) and healthy, and review worker logs.',
      evidence: { pending: queue.pending },
    });
  }

  // ── Stale (stuck) jobs ─────────────────────────────────────────────────────
  if (recentJobs.stale > 0) {
    findings.push({
      id: 'stale-sync-jobs',
      severity: 'WARNING',
      category: 'pipeline',
      title: `${recentJobs.stale} sync job(s) stuck in PROCESSING`,
      detail:
        'One or more sync jobs have been in PROCESSING far longer than expected, suggesting a hung worker or a job that crashed without updating status.',
      recommendation:
        'Restart the worker; consider retrying via POST /sync/jobs with scopeType=FAILED_ONLY once it is back.',
      evidence: { stale: recentJobs.stale },
    });
  }

  // ── Failed jobs in the recent window ───────────────────────────────────────
  if (recentJobs.failed >= THRESHOLDS.failedJobsCritical) {
    findings.push({
      id: 'many-failed-jobs',
      severity: 'CRITICAL',
      category: 'pipeline',
      title: `${recentJobs.failed} sync jobs failed in the last ${recentJobs.windowHours}h`,
      detail:
        'A high number of failed sync jobs indicates a systemic problem (credentials, connectivity or configuration) rather than isolated bad orders.',
      recommendation:
        'Review the failed transactions below and the worker logs, fix the common root cause, then retry with scopeType=FAILED_ONLY.',
      evidence: {
        failed: recentJobs.failed,
        windowHours: recentJobs.windowHours,
      },
    });
  } else if (recentJobs.failed >= THRESHOLDS.failedJobsWarning) {
    findings.push({
      id: 'some-failed-jobs',
      severity: 'WARNING',
      category: 'pipeline',
      title: `${recentJobs.failed} sync job(s) failed in the last ${recentJobs.windowHours}h`,
      detail: 'Some sync jobs failed recently.',
      recommendation:
        'Inspect the failed transactions and retry with scopeType=FAILED_ONLY.',
      evidence: { failed: recentJobs.failed },
    });
  }

  // ── Failed transactions grouped by error type ─────────────────────────────
  const byType = failedTransactions.byType;
  if ((byType.AUTHENTICATION_ERROR ?? 0) > 0) {
    findings.push({
      id: 'failed-tx-authentication',
      severity: 'CRITICAL',
      category: 'credentials',
      title: `${byType.AUTHENTICATION_ERROR} transaction(s) failed with authentication errors`,
      detail:
        'Oracle or a source system is rejecting the credentials. This blocks all affected orders.',
      recommendation:
        'Verify and re-enter the relevant credential in the Admin panel, then restart the backend and retry.',
      evidence: { count: byType.AUTHENTICATION_ERROR },
    });
  }
  const connectivityCount = (byType.NETWORK_ERROR ?? 0) + (byType.TIMEOUT ?? 0);
  if (connectivityCount > 0) {
    findings.push({
      id: 'failed-tx-connectivity',
      severity: 'WARNING',
      category: 'connectivity',
      title: `${connectivityCount} transaction(s) failed due to network/timeout`,
      detail:
        'Transactions failed while reaching an external system, indicating an unstable or unreachable endpoint.',
      recommendation:
        'Confirm the endpoint URLs are correct and reachable; transient issues will auto-retry with backoff.',
      evidence: {
        network: byType.NETWORK_ERROR ?? 0,
        timeout: byType.TIMEOUT ?? 0,
      },
    });
  }
  const configCount =
    (byType.VALIDATION_ERROR ?? 0) +
    (byType.MAPPING_ERROR ?? 0) +
    (byType.CONFIGURATION_ERROR ?? 0) +
    (byType.PAYMENT_METHOD_ERROR ?? 0);
  if (configCount > 0) {
    findings.push({
      id: 'failed-tx-configuration',
      severity: 'WARNING',
      category: 'configuration',
      title: `${configCount} transaction(s) failed due to validation/mapping/config`,
      detail:
        'Orders failed because of missing store configuration, unmapped payment methods, or invalid data — not an outage.',
      recommendation:
        'Populate store config (POST /store-config/populate/all-branches), map payment methods, then retry the affected orders.',
      evidence: {
        validation: byType.VALIDATION_ERROR ?? 0,
        mapping: byType.MAPPING_ERROR ?? 0,
        configuration: byType.CONFIGURATION_ERROR ?? 0,
        paymentMethod: byType.PAYMENT_METHOD_ERROR ?? 0,
      },
    });
  }
  if (failedTransactions.unresolved >= THRESHOLDS.failedTxWarning) {
    findings.push({
      id: 'many-unresolved-failed-tx',
      severity: 'WARNING',
      category: 'pipeline',
      title: `${failedTransactions.unresolved} unresolved failed transactions`,
      detail:
        'A large dead-letter backlog is accumulating. These orders are not in Oracle.',
      recommendation:
        'Work through the Failed Transactions page; fix root causes and retry.',
      evidence: { unresolved: failedTransactions.unresolved },
    });
  }

  // ── Queue backlog / throughput ─────────────────────────────────────────────
  if (queue.pending >= THRESHOLDS.backlogCritical) {
    findings.push({
      id: 'critical-backlog',
      severity: 'CRITICAL',
      category: 'pipeline',
      title: `Critical backlog: ${queue.pending} orders pending`,
      detail:
        'The pipeline is not keeping up. Orders are queuing faster than they are processed.',
      recommendation:
        'Ensure the worker is running and scaled; investigate any upstream failures blocking throughput.',
      evidence: { pending: queue.pending },
    });
  } else if (queue.pending >= THRESHOLDS.backlogWarning) {
    findings.push({
      id: 'growing-backlog',
      severity: 'WARNING',
      category: 'pipeline',
      title: `Growing backlog: ${queue.pending} orders pending`,
      detail: 'The pending queue is larger than usual.',
      recommendation: 'Monitor throughput; make sure the worker is running.',
      evidence: { pending: queue.pending },
    });
  }

  // ── Skip rate ─────────────────────────────────────────────────────────────
  if (queue.skipped > 0 && queue.skipped > queue.synced) {
    findings.push({
      id: 'high-skip-rate',
      severity: 'INFO',
      category: 'pipeline',
      title: `${queue.skipped} orders skipped (more than synced)`,
      detail:
        'Many orders are being skipped (typically unpaid, cancelled, missing branch code, or missing store config). Some skipping is normal, but a high rate can hide misconfiguration.',
      recommendation:
        'Review Skipped Orders; use POST /sync/auto-fix/skipped-orders then POST /sync/orders/retry-skipped.',
      evidence: { skipped: queue.skipped, synced: queue.synced },
    });
  }

  // ── Item sync errors ──────────────────────────────────────────────────────
  if (signals.itemSyncErrors > 0) {
    findings.push({
      id: 'item-sync-errors',
      severity: 'WARNING',
      category: 'configuration',
      title: `${signals.itemSyncErrors} item(s) have sync errors`,
      detail:
        'Item metadata failed to sync, which can block inventory transactions for those items.',
      recommendation:
        'Re-run item sync and inspect the errored items under Admin → Item Meta.',
      evidence: { itemSyncErrors: signals.itemSyncErrors },
    });
  }

  // ── Surface pre-existing unresolved CRITICAL/ERROR alerts ──────────────────
  const severeAlerts = signals.unresolvedAlerts.filter(
    (a) => a.severity === 'CRITICAL' || a.severity === 'ERROR',
  );
  if (severeAlerts.length > 0) {
    findings.push({
      id: 'unresolved-severe-alerts',
      severity: 'WARNING',
      category: 'alerts',
      title: `${severeAlerts.length} unresolved high-severity alert(s)`,
      detail: `The system has open alerts that need attention: ${severeAlerts
        .slice(0, 5)
        .map((a) => a.title)
        .join('; ')}${severeAlerts.length > 5 ? '…' : ''}.`,
      recommendation: 'Review and resolve open alerts on the Alerts page.',
      evidence: { count: severeAlerts.length },
    });
  }

  return sortBySeverity(findings);
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

export function sortBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

/** Computes a 0–100 health score from the findings. */
export function computeHealthScore(findings: Finding[]): number {
  const penalty = findings.reduce(
    (sum, f) => sum + SCORE_PENALTY[f.severity],
    0,
  );
  return Math.max(0, Math.min(100, 100 - penalty));
}

/** Derives the overall status from the findings and score. */
export function deriveStatus(
  findings: Finding[],
  score: number,
): OverallStatus {
  const hasCritical = findings.some((f) => f.severity === 'CRITICAL');
  if (hasCritical || score < 50) return 'unhealthy';
  const hasWarning = findings.some((f) => f.severity === 'WARNING');
  if (hasWarning || score < 80) return 'degraded';
  return 'healthy';
}

/**
 * Deterministic natural-language summary used when no LLM is configured (or if
 * the LLM call fails). Guarantees the feature is always useful offline.
 */
export function buildRuleBasedSummary(
  findings: Finding[],
  status: OverallStatus,
  score: number,
): string {
  if (findings.length === 0) {
    return `All monitored checks passed. System status is healthy (score ${score}/100). No action needed.`;
  }
  const critical = findings.filter((f) => f.severity === 'CRITICAL');
  const warning = findings.filter((f) => f.severity === 'WARNING');
  const parts: string[] = [];
  parts.push(
    `Overall status: ${status.toUpperCase()} (health score ${score}/100).`,
  );
  if (critical.length > 0) {
    parts.push(
      `${critical.length} critical issue(s) are blocking the integration and must be fixed first: ${critical
        .map((f) => f.title)
        .join('; ')}.`,
    );
    parts.push(`Start here: ${critical[0].recommendation}`);
  }
  if (warning.length > 0) {
    parts.push(
      `${warning.length} warning(s) also need attention: ${warning
        .map((f) => f.title)
        .join('; ')}.`,
    );
  }
  return parts.join(' ');
}

export function countBySeverity(findings: Finding[]): {
  critical: number;
  warning: number;
  info: number;
} {
  return {
    critical: findings.filter((f) => f.severity === 'CRITICAL').length,
    warning: findings.filter((f) => f.severity === 'WARNING').length,
    info: findings.filter((f) => f.severity === 'INFO').length,
  };
}
