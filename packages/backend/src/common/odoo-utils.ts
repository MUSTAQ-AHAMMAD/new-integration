/**
 * Shared utilities for Odoo / IBQ data extraction.
 * Used by backup services and sync controllers.
 */

/** Default timezone assumed for Odoo/IBQ orders that carry no explicit timezone. */
export const DEFAULT_ODOO_TIMEZONE = 'Asia/Dubai';

/** Enable detailed logging for payment detection (set via env var ODOO_UTILS_DEBUG=true) */
const DEBUG_PAYMENT_DETECTION = process.env.ODOO_UTILS_DEBUG === 'true';

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
  amount_untaxed?: number | null;
  amount_tax?: number | null;
  amount_discount?: number | null;
  state?: string | null;
  /** Present on main-Odoo orders; absent on IBQ/multi-tenant instances. */
  timezone?: string | null;
  /** Optional payment data for enhanced payment detection */
  statement_ids?: unknown[] | null;
  payment_ids?: unknown[] | null;
  payments?: unknown[] | null;
  /** Order lines for direct processing */
  lines?: unknown[] | null;
  order_lines?: unknown[] | null;
  /** Warehouse/outlet information */
  warehouse_id?: number | [number, string] | null;
  /** POS config/register information */
  pos_config_id?: number | [number, string] | null;
  session_id?: number | [number, string] | null;
  /** Customer type (e.g., NORMAL, HUNGERSTATION, TALABAT) */
  customer_type?: string | null;
}

/**
 * Odoo/IBQ order states that indicate the order is completed and ready for Oracle sync.
 *
 * This list is comprehensive and includes all known states across different Odoo/IBQ versions
 * that indicate an order is finalized and should be synced to Oracle.
 *
 * Supported states (case-insensitive):
 * - 'paid': Payment completed (POS orders)
 * - 'done': Order fulfilled/completed
 * - 'posted': Invoice posted to accounting
 * - 'invoiced': Invoice generated (common in IBQ)
 * - 'sale': Sales order confirmed (Odoo Sales workflow)
 * - 'invoice': Invoice state (some Odoo versions)
 * - 'confirmed': Order confirmed (some Odoo workflows)
 * - 'validated': Order validated (some IBQ workflows)
 * - 'sent': Order sent (some Odoo workflows)
 * - 'open': Invoice/order is open and finalized (common in Odoo Accounting)
 * - 'to invoice': Order ready to be invoiced (often means payment received)
 * - 'progress': Order in progress (some Odoo workflows)
 * - 'in_payment': Payment is being processed
 * - 'processing': Order is being processed
 * - 'complete': Order is complete
 * - 'closed': Order is closed/completed
 * - 'finalized': Order is finalized
 *
 * Excluded states (will be marked as unpaid):
 * - 'draft': Order not yet finalized
 * - 'cancel'/'cancelled': Order cancelled
 * - 'quotation': Just a quote, not an order
 * - 'sent_quotation': Quote sent but not confirmed
 */
export const PAID_ORDER_STATES = [
  'paid',
  'done',
  'posted',
  'invoiced',
  'sale',
  'invoice',
  'confirmed',
  'validated',
  'sent',
  'open',
  'to invoice',
  'to_invoice',
  'progress',
  'in_payment',
  'in payment',
  'processing',
  'complete',
  'completed',
  'closed',
  'finalized',
  'finalised',
] as const;

/**
 * Order states that explicitly indicate the order should NOT be synced.
 * These orders are either incomplete, cancelled, or just quotes.
 */
export const UNPAID_ORDER_STATES = [
  'draft',
  'cancel',
  'cancelled',
  'quotation',
  'sent_quotation',
  'sent quotation',
] as const;

/**
 * Check if an order has payment data in any of the payment fields.
 * Returns true if the order has at least one payment entry.
 */
function hasPaymentData(order: RawOdooOrderFields): boolean {
  if (Array.isArray(order.statement_ids) && order.statement_ids.length > 0) {
    // Filter out integer-only entries (ID references without data)
    const hasObjects = order.statement_ids.some(
      (item) => typeof item === 'object' && item !== null,
    );
    if (hasObjects) return true;
  }

  if (Array.isArray(order.payment_ids) && order.payment_ids.length > 0) {
    const hasObjects = order.payment_ids.some(
      (item) => typeof item === 'object' && item !== null,
    );
    if (hasObjects) return true;
  }

  if (Array.isArray(order.payments) && order.payments.length > 0) {
    const hasObjects = order.payments.some(
      (item) => typeof item === 'object' && item !== null,
    );
    if (hasObjects) return true;
  }

  return false;
}

/**
 * Normalised ingestion payload extracted from a raw Odoo/IBQ order.
 * Returns null when the order is missing a branch code (must be skipped).
 *
 * @param order      Raw order from the API
 * @param timezone   Override timezone (pass undefined to read from order.timezone)
 *
 * Payment detection logic:
 * 1. First checks if the order is explicitly cancelled/draft (marked as unpaid)
 * 2. Then checks if the state is in the PAID_ORDER_STATES list
 * 3. As a fallback, checks for payment data (statement_ids, payment_ids, payments)
 * 4. If none of the above apply, the order is marked as unpaid
 *
 * This multi-layered approach ensures we catch paid orders across different Odoo/IBQ
 * configurations and versions, while still filtering out truly unpaid/draft orders.
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
  // New fields for direct processing
  orderLines?: Array<{
    productId?: number;
    productName?: string;
    productCode?: string;
    qty?: number;
    priceUnit?: number;
    priceSubtotal?: number;
    priceSubtotalIncl?: number;
    discount?: number;
    taxName?: string;
  }>;
  orderPayments?: Array<{
    paymentId?: number;
    paymentName?: string;
    amount?: number;
    currency?: string;
    paymentDate?: Date;
  }>;
  warehouseName?: string;
  posConfigName?: string;
  customerType?: string;
  amountUntaxed?: number;
  amountTax?: number;
  amountDiscount?: number;
} | null {
  const branchCode = extractBranchCode(order.branch_id);
  if (!branchCode) return null;

  const amountTotal = Number(order.amount_total ?? 0);
  // Treat null/undefined state as unknown to enable payment data fallback check
  const state = typeof order.state === 'string' ? order.state : null;
  const resolvedTimezone =
    timezone ??
    (typeof order.timezone === 'string' && order.timezone
      ? order.timezone
      : DEFAULT_ODOO_TIMEZONE);

  // Normalize state for comparison (handle null state)
  const normalizedState = state ? state.toLowerCase().trim() : null;

  // Check if order is explicitly cancelled
  const isCancelled =
    normalizedState === 'cancel' || normalizedState === 'cancelled';

  // Determine if order is paid using multi-layered logic:
  let isPaid = false;
  let paymentDetectionReason = 'not_determined';

  if (!isCancelled) {
    // 1. Check if state explicitly indicates unpaid (draft, quotation, etc.)
    // The explicit null check ensures null states skip this check and fall through to payment detection
    const isExplicitlyUnpaid =
      normalizedState !== null &&
      (UNPAID_ORDER_STATES as readonly string[]).includes(normalizedState);

    if (isExplicitlyUnpaid) {
      // Order is in draft or quotation state - definitely not paid
      isPaid = false;
      paymentDetectionReason = `unpaid_state:${normalizedState}`;

      if (DEBUG_PAYMENT_DETECTION) {
        console.log(
          `[odoo-utils] Order ${order.id}: isPaid=false - state "${normalizedState}" is in UNPAID_ORDER_STATES`,
        );
      }
    } else {
      // 2. Check if state is in the known paid states list
      const stateIndicatesPaid =
        normalizedState !== null &&
        (PAID_ORDER_STATES as readonly string[]).includes(normalizedState);

      if (stateIndicatesPaid) {
        // State explicitly indicates payment
        isPaid = true;
        paymentDetectionReason = `paid_state:${normalizedState}`;

        if (DEBUG_PAYMENT_DETECTION) {
          console.log(
            `[odoo-utils] Order ${order.id}: isPaid=true - state "${normalizedState}" is in PAID_ORDER_STATES`,
          );
        }
      } else {
        // 3. Fallback: check for payment data
        // If the state is unknown/null but there are payments, assume it's paid
        const hasPayments = hasPaymentData(order);

        if (hasPayments) {
          // Has payment data, so likely paid even if state is unusual/null
          isPaid = true;
          paymentDetectionReason = normalizedState
            ? `payment_data_found:${normalizedState}`
            : 'payment_data_found:null_state';

          if (DEBUG_PAYMENT_DETECTION) {
            const stateMsg = normalizedState || 'null';
            console.log(
              `[odoo-utils] Order ${order.id}: isPaid=true - ${stateMsg} state but has payment data`,
            );
          }
        } else {
          // Unknown/null state and no payments - mark as unpaid to be safe
          isPaid = false;
          paymentDetectionReason = normalizedState
            ? `unknown_state_no_payment:${normalizedState}`
            : 'null_state_no_payment';

          if (DEBUG_PAYMENT_DETECTION) {
            const stateMsg = normalizedState || 'null';
            console.log(
              `[odoo-utils] Order ${order.id}: isPaid=false - ${stateMsg} state with no payment data`,
            );
            if (normalizedState) {
              console.log(
                `[odoo-utils] Order ${order.id}: Consider adding "${normalizedState}" to PAID_ORDER_STATES if this state indicates payment`,
              );
            }
          }
        }
      }
    }
  } else {
    paymentDetectionReason = 'cancelled';

    if (DEBUG_PAYMENT_DETECTION) {
      console.log(
        `[odoo-utils] Order ${order.id}: cancelled - will be skipped`,
      );
    }
  }

  // Extract order lines
  const rawLines = order.lines || order.order_lines;
  const orderLines = Array.isArray(rawLines)
    ? rawLines.map((line: any) => ({
        productId:
          typeof line.product_id === 'number'
            ? line.product_id
            : Array.isArray(line.product_id)
              ? line.product_id[0]
              : undefined,
        productName: line.product_name || line.name || undefined,
        productCode:
          line.product_code ||
          line.default_code ||
          line.product_barcode ||
          undefined,
        qty: typeof line.qty === 'number' ? line.qty : undefined,
        priceUnit:
          typeof line.price_unit === 'number' ? line.price_unit : undefined,
        priceSubtotal:
          typeof line.price_subtotal === 'number'
            ? line.price_subtotal
            : undefined,
        priceSubtotalIncl:
          typeof line.price_subtotal_incl === 'number'
            ? line.price_subtotal_incl
            : undefined,
        discount: typeof line.discount === 'number' ? line.discount : undefined,
        taxName:
          line.tax_name || line.tax_id
            ? Array.isArray(line.tax_id)
              ? line.tax_id[1]
              : line.tax_name
            : undefined,
      }))
    : undefined;

  // Extract payments
  const rawPayments =
    order.payments || order.payment_ids || order.statement_ids;
  const orderPayments = Array.isArray(rawPayments)
    ? rawPayments.map((pmt: any) => ({
        paymentId: typeof pmt.id === 'number' ? pmt.id : undefined,
        paymentName:
          pmt.payment_name ||
          pmt.name ||
          pmt.journal_name ||
          (Array.isArray(pmt.payment_method_id)
            ? pmt.payment_method_id[1]
            : undefined),
        amount: typeof pmt.amount === 'number' ? pmt.amount : undefined,
        currency:
          pmt.currency || pmt.currency_id
            ? Array.isArray(pmt.currency_id)
              ? pmt.currency_id[1]
              : pmt.currency
            : undefined,
        paymentDate: pmt.payment_date ? new Date(pmt.payment_date) : undefined,
      }))
    : undefined;

  // Extract warehouse/outlet name
  const warehouseName = order.warehouse_id
    ? Array.isArray(order.warehouse_id)
      ? order.warehouse_id[1]
      : undefined
    : undefined;

  // Extract POS config/register name
  const posConfigName = order.pos_config_id
    ? Array.isArray(order.pos_config_id)
      ? order.pos_config_id[1]
      : undefined
    : order.session_id
      ? Array.isArray(order.session_id)
        ? order.session_id[1]
        : undefined
      : undefined;

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
    orderLines,
    orderPayments,
    warehouseName,
    posConfigName,
    customerType: order.customer_type || undefined,
    amountUntaxed:
      order.amount_untaxed != null ? Number(order.amount_untaxed) : undefined,
    amountTax: order.amount_tax != null ? Number(order.amount_tax) : undefined,
    amountDiscount:
      order.amount_discount != null ? Number(order.amount_discount) : undefined,
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
