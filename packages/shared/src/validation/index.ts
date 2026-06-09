// ─── Validation schemas (Zod) ──────────────────────────────────────────────
// These are shared validation schemas used by both backend and frontend

export const SYNC_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED', 'FAILED', 'SKIPPED'] as const;
export const JOB_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIAL', 'CANCELLED'] as const;
export const JOB_TYPES = ['ORDER_SYNC', 'INVENTORY_SYNC', 'PAYMENT_SYNC', 'CONFIG_SYNC', 'REFUND_SYNC'] as const;
export const SCOPE_TYPES = ['SINGLE_ORDER', 'DATE_RANGE', 'BRANCH', 'ALL', 'FAILED_ONLY'] as const;
export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export const HEALTH_STATUSES = ['HEALTHY', 'DEGRADED', 'UNHEALTHY'] as const;
export const SERVICE_NAMES = ['ODOO', 'ORACLE', 'REDIS', 'DATABASE', 'QUEUE'] as const;
export const CREDIT_MEMO_STATUSES = ['PENDING', 'SYNCED', 'FAILED'] as const;

// ─── Field validation rules ────────────────────────────────────────────────

export const VALIDATION_RULES = {
  branchCode: { minLength: 2, maxLength: 20, pattern: /^[A-Z0-9_-]+$/ },
  email: { pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  currency: { pattern: /^[A-Z]{3}$/ },
  maxRetries: { min: 0, max: 10 },
  latencyThresholdMs: { min: 100, max: 60_000 },
  failureRateThreshold: { min: 0, max: 100 },
} as const;
