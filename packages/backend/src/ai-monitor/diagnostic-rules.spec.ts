import {
  analyzeSignals,
  buildRuleBasedSummary,
  classifyFailureReason,
  computeHealthScore,
  countBySeverity,
  deriveStatus,
} from './diagnostic-rules';
import type { DiagnosticSignals } from './ai-monitor.types';

/** Builds a fully-healthy baseline snapshot that individual tests mutate. */
function healthySignals(): DiagnosticSignals {
  return {
    collectedAt: new Date().toISOString(),
    credentials: {
      fusion: { active: 1, total: 1 },
      odoo: { active: 1, total: 1 },
      vendhq: { active: 0, total: 0 },
      ibq: { active: 0, total: 0 },
    },
    syncControls: [
      {
        serviceName: 'odoo-backup',
        enabled: true,
        isRunning: true,
        lastStatus: 'SUCCESS',
        lastRunAt: new Date(),
        errorCount: 0,
      },
    ],
    queue: { pending: 0, processing: 0, skipped: 0, failed: 0, synced: 100 },
    recentJobs: {
      windowHours: 24,
      total: 5,
      failed: 0,
      partial: 0,
      completed: 5,
      stale: 0,
    },
    failedTransactions: { unresolved: 0, byType: {} },
    unresolvedAlerts: [],
    health: [
      {
        serviceName: 'ORACLE_SOAP',
        status: 'HEALTHY',
        consecutiveFailures: 0,
        failureReason: null,
        lastSuccessAt: new Date(),
      },
    ],
    itemSyncErrors: 0,
  };
}

describe('classifyFailureReason', () => {
  it('detects TLS/SSL certificate issues', () => {
    expect(classifyFailureReason('self signed certificate').cause).toBe(
      'TLS/SSL certificate mismatch',
    );
  });

  it('detects authentication failures', () => {
    expect(classifyFailureReason('HTTP 401 Unauthorized').cause).toBe(
      'Authentication rejected',
    );
  });

  it('detects network/connectivity failures', () => {
    expect(classifyFailureReason('getaddrinfo ENOTFOUND host').cause).toBe(
      'Network / connectivity failure',
    );
  });

  it('detects 404 path errors', () => {
    expect(classifyFailureReason('404 Not Found').cause).toBe(
      'Endpoint path not found (404)',
    );
  });

  it('falls back to unclassified for unknown text', () => {
    expect(classifyFailureReason('something weird').cause).toBe(
      'Unclassified error',
    );
    expect(classifyFailureReason(null).cause).toBe('Unclassified error');
  });
});

describe('analyzeSignals', () => {
  it('returns no findings for a healthy system', () => {
    expect(analyzeSignals(healthySignals())).toEqual([]);
  });

  it('flags missing Fusion credentials as critical', () => {
    const s = healthySignals();
    s.credentials.fusion = { active: 0, total: 0 };
    const findings = analyzeSignals(s);
    const f = findings.find((x) => x.id === 'no-active-fusion-credentials');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('CRITICAL');
  });

  it('flags missing source credentials as critical', () => {
    const s = healthySignals();
    s.credentials.odoo = { active: 0, total: 0 };
    s.credentials.ibq = { active: 0, total: 0 };
    s.credentials.vendhq = { active: 0, total: 0 };
    const findings = analyzeSignals(s);
    expect(findings.some((x) => x.id === 'no-active-source-credentials')).toBe(
      true,
    );
  });

  it('flags an unhealthy service and root-causes the reason', () => {
    const s = healthySignals();
    s.health = [
      {
        serviceName: 'ORACLE_SOAP',
        status: 'UNHEALTHY',
        consecutiveFailures: 3,
        failureReason: 'connect ETIMEDOUT',
        lastSuccessAt: null,
      },
    ];
    const findings = analyzeSignals(s);
    const f = findings.find((x) => x.id === 'service-unhealthy-oracle_soap');
    expect(f?.severity).toBe('CRITICAL');
    expect(f?.title).toContain('Network / connectivity failure');
  });

  it('warns when sync services are disabled', () => {
    const s = healthySignals();
    s.syncControls[0].enabled = false;
    const findings = analyzeSignals(s);
    expect(findings.some((x) => x.id === 'sync-services-disabled')).toBe(true);
  });

  it('warns when pending orders exist but nothing is running (worker down)', () => {
    const s = healthySignals();
    s.queue.pending = 10;
    s.syncControls[0].isRunning = false;
    const findings = analyzeSignals(s);
    expect(findings.some((x) => x.id === 'worker-possibly-down')).toBe(true);
  });

  it('escalates many failed jobs to critical', () => {
    const s = healthySignals();
    s.recentJobs.failed = 6;
    const findings = analyzeSignals(s);
    const f = findings.find((x) => x.id === 'many-failed-jobs');
    expect(f?.severity).toBe('CRITICAL');
  });

  it('flags authentication failed transactions as critical credential issue', () => {
    const s = healthySignals();
    s.failedTransactions.byType = { AUTHENTICATION_ERROR: 4 };
    const findings = analyzeSignals(s);
    const f = findings.find((x) => x.id === 'failed-tx-authentication');
    expect(f?.severity).toBe('CRITICAL');
    expect(f?.category).toBe('credentials');
  });

  it('groups validation/mapping/config failures into a configuration warning', () => {
    const s = healthySignals();
    s.failedTransactions.byType = {
      VALIDATION_ERROR: 2,
      MAPPING_ERROR: 1,
    };
    const findings = analyzeSignals(s);
    const f = findings.find((x) => x.id === 'failed-tx-configuration');
    expect(f?.severity).toBe('WARNING');
  });

  it('flags a critical backlog', () => {
    const s = healthySignals();
    s.queue.pending = 5000;
    s.syncControls[0].isRunning = true;
    const findings = analyzeSignals(s);
    const f = findings.find((x) => x.id === 'critical-backlog');
    expect(f?.severity).toBe('CRITICAL');
  });

  it('reports a high skip rate as info', () => {
    const s = healthySignals();
    s.queue.skipped = 200;
    s.queue.synced = 10;
    const findings = analyzeSignals(s);
    const f = findings.find((x) => x.id === 'high-skip-rate');
    expect(f?.severity).toBe('INFO');
  });

  it('orders findings CRITICAL first', () => {
    const s = healthySignals();
    s.credentials.fusion = { active: 0, total: 0 }; // critical
    s.queue.skipped = 200; // info
    s.queue.synced = 1;
    const findings = analyzeSignals(s);
    expect(findings[0].severity).toBe('CRITICAL');
  });
});

describe('scoring and status', () => {
  it('gives a perfect score with no findings', () => {
    expect(computeHealthScore([])).toBe(100);
    expect(deriveStatus([], 100)).toBe('healthy');
  });

  it('marks unhealthy when a critical finding exists', () => {
    const findings = analyzeSignals({
      ...healthySignals(),
      credentials: {
        fusion: { active: 0, total: 0 },
        odoo: { active: 1, total: 1 },
        vendhq: { active: 0, total: 0 },
        ibq: { active: 0, total: 0 },
      },
    });
    const score = computeHealthScore(findings);
    expect(deriveStatus(findings, score)).toBe('unhealthy');
    expect(score).toBeLessThan(100);
  });

  it('never returns a score below 0', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `x${i}`,
      severity: 'CRITICAL' as const,
      category: 'test',
      title: 't',
      detail: 'd',
      recommendation: 'r',
    }));
    expect(computeHealthScore(many)).toBe(0);
  });

  it('counts findings by severity', () => {
    const counts = countBySeverity([
      {
        id: 'a',
        severity: 'CRITICAL',
        category: 'c',
        title: 't',
        detail: 'd',
        recommendation: 'r',
      },
      {
        id: 'b',
        severity: 'WARNING',
        category: 'c',
        title: 't',
        detail: 'd',
        recommendation: 'r',
      },
    ]);
    expect(counts).toEqual({ critical: 1, warning: 1, info: 0 });
  });
});

describe('buildRuleBasedSummary', () => {
  it('reports all-clear when there are no findings', () => {
    expect(buildRuleBasedSummary([], 'healthy', 100)).toContain('healthy');
  });

  it('leads with critical issues', () => {
    const summary = buildRuleBasedSummary(
      [
        {
          id: 'a',
          severity: 'CRITICAL',
          category: 'credentials',
          title: 'No active Oracle Fusion credentials',
          detail: 'd',
          recommendation: 'Add a credential',
        },
      ],
      'unhealthy',
      70,
    );
    expect(summary).toContain('critical');
    expect(summary).toContain('Add a credential');
  });
});
