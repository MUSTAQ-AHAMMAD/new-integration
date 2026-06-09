// ─── API constants ─────────────────────────────────────────────────────────

export const API_PREFIX = 'api/v1';
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_RETRY_LIMIT = 3;

// ─── Queue names ───────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  ORDER_SYNC: 'order-sync',
  RETRY: 'retry',
} as const;

// ─── Circuit breaker defaults ──────────────────────────────────────────────

export const CIRCUIT_BREAKER_DEFAULTS = {
  FAILURE_THRESHOLD: 5,
  RECOVERY_TIMEOUT_MS: 30_000,
  HALF_OPEN_REQUESTS: 1,
} as const;

// ─── Retry policy defaults ─────────────────────────────────────────────────

export const RETRY_DEFAULTS = {
  MAX_RETRIES: 3,
  INITIAL_DELAY_MS: 1_000,
  BACKOFF_MULTIPLIER: 2,
  MAX_DELAY_MS: 30_000,
} as const;

// ─── Health check defaults ─────────────────────────────────────────────────

export const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes

// ─── Supported timezones ───────────────────────────────────────────────────

export const SUPPORTED_TIMEZONES = [
  'UTC',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Kuwait',
  'Asia/Bahrain',
  'Asia/Qatar',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Singapore',
  'Asia/Tokyo',
] as const;

// ─── Error type labels ─────────────────────────────────────────────────────

export const ERROR_TYPE_LABELS: Record<string, string> = {
  VALIDATION: 'Validation Error',
  NETWORK: 'Network Error',
  ORACLE: 'Oracle Fusion Error',
  ODOO: 'Odoo Error',
  DUPLICATE: 'Duplicate Entry',
  UNKNOWN: 'Unknown Error',
} as const;

// ─── Status colors (Tailwind classes) ─────────────────────────────────────

export const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
  PROCESSING: { bg: 'bg-blue-100', text: 'text-blue-700' },
  SYNCED: { bg: 'bg-green-100', text: 'text-green-700' },
  COMPLETED: { bg: 'bg-green-100', text: 'text-green-700' },
  FAILED: { bg: 'bg-red-100', text: 'text-red-700' },
  SKIPPED: { bg: 'bg-gray-100', text: 'text-gray-600' },
  PARTIAL: { bg: 'bg-orange-100', text: 'text-orange-700' },
  CANCELLED: { bg: 'bg-gray-100', text: 'text-gray-500' },
  HEALTHY: { bg: 'bg-green-100', text: 'text-green-700' },
  DEGRADED: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
  UNHEALTHY: { bg: 'bg-red-100', text: 'text-red-700' },
  ACTIVE: { bg: 'bg-green-100', text: 'text-green-700' },
  INACTIVE: { bg: 'bg-gray-100', text: 'text-gray-500' },
  REJECTED: { bg: 'bg-red-100', text: 'text-red-700' },
  CRITICAL: { bg: 'bg-red-100', text: 'text-red-700' },
  WARNING: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
  INFO: { bg: 'bg-blue-100', text: 'text-blue-700' },
} as const;
