/**
 * Shared money rounding helpers.
 *
 * Monetary values flowing to Oracle must be exactly 2 decimal places — never a
 * long binary-float like `3.3333333333333335` (which comes from `total / qty`
 * divisions) and never with more precision than the currency supports. Rounding
 * once, deterministically, at well-defined points keeps line sums penny-exact
 * and prevents "large" numbers from reaching the SOAP wire.
 *
 * The formula matches the pre-existing `round2` used in the aggregation and
 * journal services (adding `Number.EPSILON` before scaling avoids cases like
 * `1.005 * 100 = 100.49999…` rounding the wrong way), so behaviour is
 * consistent everywhere money is rounded.
 */

/** Round a monetary value to 2 decimal places. Non-finite input → 0. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Round to 2 decimals and render as a plain decimal string with no exponent —
 * safe for direct interpolation into SOAP/XML. `round2` already removes long
 * floats; this guards the rare large-magnitude value that would otherwise
 * stringify in scientific notation.
 */
export function money2(value: number): string {
  const n = round2(value);
  // toFixed(2) never uses exponent notation and always yields 2 dp.
  return n.toFixed(2);
}
