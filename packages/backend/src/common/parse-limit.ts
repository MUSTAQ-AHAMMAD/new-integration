/**
 * Safely parse a query-string limit value into a bounded integer.
 *
 * - Falls back to `defaultValue` when the input is absent or not a number.
 * - Clamps the result to [1, MAX_LIMIT] to prevent DoS via oversized queries.
 */
const MAX_LIMIT = 200;

export function parseLimit(
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined || value === '') return defaultValue;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.min(Math.max(1, n), MAX_LIMIT);
}
