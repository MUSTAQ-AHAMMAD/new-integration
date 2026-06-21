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
