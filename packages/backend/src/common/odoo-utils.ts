/**
 * Shared utilities for Odoo / IBQ data extraction.
 * Used by backup services and sync controllers.
 */

/** Default timezone assumed for Odoo/IBQ orders that carry no explicit timezone. */
export const DEFAULT_ODOO_TIMEZONE = 'Asia/Dubai';

/**
 * Ensures a date string sent to the Odoo/IBQ `/api/pos/order` endpoint has a
 * time component. The UI date-picker produces `YYYY-MM-DD` (no time) but the
 * API requires `YYYY-MM-DD HH:MM:SS`.
 *
 * - If the string already contains a time (a space or 'T' after the date part)
 *   it is returned unchanged.
 * - For start dates (default) the time `00:00:00` is appended.
 * - For end dates pass `{ end: true }` and `23:59:59` is appended instead.
 */
export function toApiDatetime(
  date: string,
  options?: { end?: boolean },
): string {
  // Already has a time component — leave it alone
  if (/[\sT]\d{2}:\d{2}/.test(date)) return date;
  const time = options?.end ? '23:59:59' : '00:00:00';
  return `${date} ${time}`;
}

/**
 * Extract a branch-code string from an Odoo Many2one branch_id field.
 * Returns null when the field is absent so callers can skip the order.
 *
 * @example
 *   extractBranchCode([3, 'Abu Dhabi'])  // → '3'
 *   extractBranchCode(3)                 // → '3'
 *   extractBranchCode(null)              // → null
 */
export function extractBranchCode(
  branchRaw: number | [number, string] | null | undefined,
): string | null {
  if (branchRaw == null) return null;
  if (Array.isArray(branchRaw)) return String(branchRaw[0]);
  return String(branchRaw);
}

/** Minimal shape of a raw Odoo/IBQ POS order needed for queue ingestion. */
export interface RawOdooOrderFields {
  id: number;
  name?: string | null;
  pos_reference?: string | null;
  branch_id?: number | [number, string] | null;
  date_order?: string | null;
  amount_total?: number | null;
  state?: string | null;
  /** Present on main-Odoo orders; absent on IBQ/multi-tenant instances. */
  timezone?: string | null;
}

/**
 * Odoo/IBQ order states that indicate the order is completed and ready for Oracle sync.
 * 
 * Only orders with these states (case-insensitive) will be marked as paid and
 * queued for Oracle sync. Orders with other states (e.g., 'draft', 'cancel')
 * will be marked as unpaid and skipped during sync.
 * 
 * Supported Odoo POS/ERP states:
 * - 'paid': Payment completed (POS orders)
 * - 'done': Order fulfilled/completed
 * - 'posted': Invoice posted to accounting
 * - 'invoiced': Invoice generated (common in IBQ)
 * - 'sale': Sales order confirmed (Odoo Sales workflow)
 * - 'invoice': Invoice state (some Odoo versions)
 * - 'confirmed': Order confirmed (some Odoo workflows)
 * - 'validated': Order validated (some IBQ workflows)
 * - 'sent': Order sent (some Odoo workflows)
 * 
 * Note: 'draft' and 'cancel' states are explicitly excluded to prevent
 * incomplete or cancelled orders from being synced to Oracle.
 */
const PAID_ORDER_STATES = [
  'paid',
  'done',
  'posted',
  'invoiced',
  'sale',
  'invoice',
  'confirmed',
  'validated',
  'sent',
] as const;

/**
 * Normalised ingestion payload extracted from a raw Odoo/IBQ order.
 * Returns null when the order is missing a branch code (must be skipped).
 *
 * @param order      Raw order from the API
 * @param timezone   Override timezone (pass undefined to read from order.timezone)
 *
 * Note: when `order.date_order` is absent the current wall-clock time is used
 * as a best-effort fallback. The caller's `TimezoneService.normalizeToUtc()`
 * will still apply the correct UTC offset using `originalTimezone`, so the
 * stored `orderDateUtc` value is consistent even in that edge case.
 */
export function normalizeOrderForIngestion(
  order: RawOdooOrderFields,
  timezone?: string,
): {
  odooOrderId: string;
  odooOrderNumber: string;
  branchCode: string;
  orderDate: Date;
  originalTimezone: string;
  totalAmount: number;
  isPaid: boolean;
  isCancelled: boolean;
  isRefund: boolean;
} | null {
  const branchCode = extractBranchCode(order.branch_id);
  if (!branchCode) return null;

  const amountTotal = Number(order.amount_total ?? 0);
  const state = typeof order.state === 'string' ? order.state : 'draft';
  const resolvedTimezone =
    timezone ??
    (typeof order.timezone === 'string' && order.timezone
      ? order.timezone
      : DEFAULT_ODOO_TIMEZONE);

  // Check if the order state indicates it's paid and ready for Oracle sync.
  // The order is considered paid if its state (case-insensitive) is in the
  // PAID_ORDER_STATES list and it's not cancelled.
  const normalizedState = state.toLowerCase();
  const isCancelled = normalizedState === 'cancel' || normalizedState === 'cancelled';
  
  // Order is paid only if:
  // 1. It's not cancelled, AND
  // 2. Its state is in the PAID_ORDER_STATES list
  const isPaid = !isCancelled && PAID_ORDER_STATES.includes(normalizedState as any);

  return {
    odooOrderId: String(order.id),
    odooOrderNumber: String(order.name ?? order.pos_reference ?? order.id),
    branchCode,
    orderDate: order.date_order ? new Date(order.date_order) : new Date(),
    originalTimezone: resolvedTimezone,
    totalAmount: amountTotal,
    isPaid,
    isCancelled,
    isRefund: amountTotal < 0,
  };
}

/**
 * Generic fallback: scans a plain-object payload for the first non-empty array
 * value.  This covers custom Odoo REST modules that use non-standard envelope
 * keys (e.g. "items", "rows", "Sale_detail", "orders_list").
 *
 * Searches at two levels of depth:
 *   1. Top-level keys of `payload`
 *   2. One level of nested objects (e.g. `{ response: { items: [...] } }`)
 *
 * Return values:
 *   - Non-empty array: the first array with at least one element found.
 *   - Empty array `[]`: all discovered arrays were empty — caller receives `[]`
 *     to indicate no records exist (not an absence of an array key).
 *   - `null`: no array value found at all — the payload uses a completely
 *     unrecognised structure and the caller should fall back to `[]` itself.
 *
 * @param payload  A plain object extracted from an HTTP response body.
 *
 * @example
 *   findArrayInPayload({ Sale_detail: [{...}] }) // → [{...}]
 *   findArrayInPayload({ orders: [] })           // → []  (empty — no records)
 *   findArrayInPayload({ count: 0 })             // → null (no array key found)
 */
export function findArrayInPayload(
  payload: Record<string, unknown>,
): unknown[] | null {
  let firstEmpty: unknown[] | null = null;

  for (const key of Object.keys(payload)) {
    const val = payload[key];

    if (Array.isArray(val)) {
      if (val.length > 0) return val as unknown[];
      if (!firstEmpty) firstEmpty = val as unknown[];
      continue;
    }

    // One level deeper — e.g. { response: { items: [...] } }
    if (typeof val === 'object' && val !== null) {
      const nested = val as Record<string, unknown>;
      for (const innerKey of Object.keys(nested)) {
        const inner = nested[innerKey];
        if (Array.isArray(inner)) {
          if (inner.length > 0) return inner as unknown[];
          if (!firstEmpty) firstEmpty = inner as unknown[];
        }
      }
    }
  }

  // No array key found anywhere in the payload — caller should fall back to [] when null is returned.
  return firstEmpty;
}
