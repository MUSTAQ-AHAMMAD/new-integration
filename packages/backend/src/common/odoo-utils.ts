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

  return {
    odooOrderId: String(order.id),
    odooOrderNumber: String(
      order.name ?? order.pos_reference ?? order.id,
    ),
    branchCode,
    orderDate: order.date_order ? new Date(order.date_order) : new Date(),
    originalTimezone: resolvedTimezone,
    totalAmount: amountTotal,
    isPaid: ['paid', 'done', 'posted'].includes(state),
    isCancelled: state === 'cancel',
    isRefund: amountTotal < 0,
  };
}
