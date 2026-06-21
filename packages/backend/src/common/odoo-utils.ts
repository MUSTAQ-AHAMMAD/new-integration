/**
 * Shared utilities for Odoo / IBQ data extraction.
 * Used by backup services and sync controllers.
 */

/** Default timezone assumed for Odoo/IBQ orders that carry no explicit timezone. */
export const DEFAULT_ODOO_TIMEZONE = 'Asia/Dubai';

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
