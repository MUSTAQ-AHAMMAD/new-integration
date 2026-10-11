import {
  toApiDatetime,
  normalizeOrderForIngestion,
  RawOdooOrderFields,
} from './odoo-utils';

describe('toApiDatetime', () => {
  // Pin the zone so the test is deterministic regardless of APP_INTEGRATION_TIMEZONE.
  // Asia/Riyadh is UTC+3 (no DST) — the production default.
  const tz = 'Asia/Riyadh';

  it('converts a date-only start date to the UTC start of that local day', () => {
    // 2026-02-01 00:00:00 in UTC+3 → 2026-01-31 21:00:00 UTC
    expect(toApiDatetime('2026-02-01', { timeZone: tz })).toBe(
      '2026-01-31 21:00:00',
    );
  });

  it('converts a date-only end date to the UTC end of that local day', () => {
    // 2026-02-01 23:59:59 in UTC+3 → 2026-02-01 20:59:59 UTC
    expect(toApiDatetime('2026-02-01', { end: true, timeZone: tz })).toBe(
      '2026-02-01 20:59:59',
    );
  });

  it('reproduces the operator example (26/07/2026 → 25th 21:00 .. 26th 20:59:59 UTC)', () => {
    expect(toApiDatetime('2026-07-26', { timeZone: tz })).toBe(
      '2026-07-25 21:00:00',
    );
    expect(toApiDatetime('2026-07-26', { end: true, timeZone: tz })).toBe(
      '2026-07-26 20:59:59',
    );
  });

  it('treats a naive datetime (no offset) as local wall time and converts to UTC', () => {
    // 21:00 local (UTC+3) → 18:00 UTC; the { end } flag is irrelevant once a time is present.
    expect(toApiDatetime('2026-02-01 21:00:00', { timeZone: tz })).toBe(
      '2026-02-01 18:00:00',
    );
    expect(toApiDatetime('2026-02-01T21:00:00', { timeZone: tz })).toBe(
      '2026-02-01 18:00:00',
    );
  });

  it('re-emits an explicit UTC instant (Z) as a naive UTC string, no shift', () => {
    // Watermark path: lastSyncAt.toISOString() is already absolute.
    expect(toApiDatetime('2026-02-01T10:00:00.000Z', { timeZone: tz })).toBe(
      '2026-02-01 10:00:00',
    );
  });

  it('respects an explicit ± offset instead of the local zone', () => {
    // 10:00 at +05:00 → 05:00 UTC, regardless of the configured zone.
    expect(toApiDatetime('2026-02-01T10:00:00+05:00', { timeZone: tz })).toBe(
      '2026-02-01 05:00:00',
    );
  });

  it('returns an empty string unchanged', () => {
    expect(toApiDatetime('')).toBe('');
  });
});

describe('normalizeOrderForIngestion - isPaid logic', () => {
  const createMockOrder = (
    state: string,
    amount = 100,
  ): RawOdooOrderFields => ({
    id: 123456,
    name: 'TEST-ORDER-001',
    branch_id: [1, 'Test Branch'],
    date_order: '2026-06-26 10:00:00',
    amount_total: amount,
    state,
  });

  const createMockOrderWithPayments = (
    state: string,
    amount = 100,
    hasPayments = true,
  ): RawOdooOrderFields => ({
    id: 123456,
    name: 'TEST-ORDER-001',
    branch_id: [1, 'Test Branch'],
    date_order: '2026-06-26 10:00:00',
    amount_total: amount,
    state,
    statement_ids: hasPayments
      ? [{ id: 1, amount: 100, paymentName: 'Cash' }]
      : [],
  });

  describe('State-based paid order detection - original states', () => {
    it('should mark "paid" state as paid', () => {
      const order = createMockOrder('paid');
      const result = normalizeOrderForIngestion(order);
      expect(result).not.toBeNull();
      expect(result?.isPaid).toBe(true);
      expect(result?.isCancelled).toBe(false);
    });

    it('should mark "done" state as paid', () => {
      const order = createMockOrder('done');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "posted" state as paid', () => {
      const order = createMockOrder('posted');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "invoiced" state as paid', () => {
      const order = createMockOrder('invoiced');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "sale" state as paid', () => {
      const order = createMockOrder('sale');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "confirmed" state as paid', () => {
      const order = createMockOrder('confirmed');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "validated" state as paid', () => {
      const order = createMockOrder('validated');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "sent" state as paid', () => {
      const order = createMockOrder('sent');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });
  });

  describe('State-based paid order detection - new states', () => {
    it('should mark "open" state as paid', () => {
      const order = createMockOrder('open');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "to invoice" state as paid', () => {
      const order = createMockOrder('to invoice');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "to_invoice" state as paid', () => {
      const order = createMockOrder('to_invoice');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "progress" state as paid', () => {
      const order = createMockOrder('progress');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "in_payment" state as paid', () => {
      const order = createMockOrder('in_payment');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "in payment" state as paid', () => {
      const order = createMockOrder('in payment');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "processing" state as paid', () => {
      const order = createMockOrder('processing');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "complete" state as paid', () => {
      const order = createMockOrder('complete');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "completed" state as paid', () => {
      const order = createMockOrder('completed');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "closed" state as paid', () => {
      const order = createMockOrder('closed');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "finalized" state as paid', () => {
      const order = createMockOrder('finalized');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "finalised" state as paid', () => {
      const order = createMockOrder('finalised');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should be case-insensitive for state matching', () => {
      const order = createMockOrder('PAID');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should handle state with whitespace', () => {
      const order = createMockOrder('  paid  ');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });
  });

  describe('Explicitly unpaid states', () => {
    it('should mark "draft" state as NOT paid', () => {
      const order = createMockOrder('draft');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(false);
    });

    it('should mark "quotation" state as NOT paid', () => {
      const order = createMockOrder('quotation');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(false);
    });

    it('should mark "sent_quotation" state as NOT paid', () => {
      const order = createMockOrder('sent_quotation');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(false);
    });

    it('should mark "sent quotation" state as NOT paid', () => {
      const order = createMockOrder('sent quotation');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(false);
    });
  });

  describe('Payment-based fallback detection', () => {
    it('should mark order with unknown state but valid payments as PAID', () => {
      const order = createMockOrderWithPayments('unknown_state', 100, true);
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
      expect(result?.isCancelled).toBe(false);
    });

    it('should mark order with unknown state and NO payments as NOT paid', () => {
      const order = createMockOrderWithPayments('unknown_state', 100, false);
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(false);
    });

    it('should NOT mark draft order with payments as paid (explicit unpaid state)', () => {
      const order = createMockOrderWithPayments('draft', 100, true);
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(false);
    });

    it('should detect payments in payment_ids field', () => {
      const order: RawOdooOrderFields = {
        id: 123456,
        name: 'TEST-ORDER-002',
        branch_id: [1, 'Test Branch'],
        date_order: '2026-06-26 10:00:00',
        amount_total: 100,
        state: 'weird_state',
        payment_ids: [{ id: 1, amount: 100 }],
      };
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should detect payments in payments field', () => {
      const order: RawOdooOrderFields = {
        id: 123456,
        name: 'TEST-ORDER-003',
        branch_id: [1, 'Test Branch'],
        date_order: '2026-06-26 10:00:00',
        amount_total: 100,
        state: 'custom_state',
        payments: [{ id: 1, amount: 100 }],
      };
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should ignore payment IDs without objects (integer-only arrays)', () => {
      const order: RawOdooOrderFields = {
        id: 123456,
        name: 'TEST-ORDER-004',
        branch_id: [1, 'Test Branch'],
        date_order: '2026-06-26 10:00:00',
        amount_total: 100,
        state: 'weird_state',
        statement_ids: [1, 2, 3], // Just IDs, no payment objects
      };
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
    });
  });

  describe('Cancelled order states', () => {
    it('should mark "cancel" state as NOT paid', () => {
      const order = createMockOrder('cancel');
      const result = normalizeOrderForIngestion(order);
      expect(result).not.toBeNull();
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(true);
    });

    it('should mark "cancelled" state as NOT paid', () => {
      const order = createMockOrder('cancelled');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(true);
    });

    it('should be case-insensitive for "CANCEL"', () => {
      const order = createMockOrder('CANCEL');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(true);
    });

    it('should mark cancelled order as not paid even with payments', () => {
      const order = createMockOrderWithPayments('cancelled', 100, true);
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should return null when branch_id is missing', () => {
      const order: RawOdooOrderFields = {
        id: 123,
        name: 'NO-BRANCH',
        branch_id: null,
        state: 'paid',
      };
      const result = normalizeOrderForIngestion(order);
      expect(result).toBeNull();
    });

    it('should handle negative amount as refund', () => {
      const order = createMockOrder('paid', -50);
      const result = normalizeOrderForIngestion(order);
      expect(result?.isRefund).toBe(true);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "cancel" state as NOT paid and cancelled', () => {
      const order = createMockOrder('cancel');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(true);
    });

    it('should handle null state as draft (unpaid) when no payment data', () => {
      const order: RawOdooOrderFields = {
        id: 123456,
        name: 'NULL-STATE',
        branch_id: [1, 'Test Branch'],
        state: null,
      };
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
    });

    it('should handle null state as PAID when payment data exists', () => {
      const order: RawOdooOrderFields = {
        id: 123456,
        name: 'NULL-STATE-WITH-PAYMENT',
        branch_id: [1, 'Test Branch'],
        state: null,
        statement_ids: [{ id: 1, amount: 100, paymentName: 'Cash' }],
      };
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should handle undefined state as draft (unpaid) when no payment data', () => {
      const order: RawOdooOrderFields = {
        id: 123456,
        name: 'UNDEFINED-STATE',
        branch_id: [1, 'Test Branch'],
        state: undefined,
      };
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
    });

    it('should handle undefined state as PAID when payment data exists', () => {
      const order: RawOdooOrderFields = {
        id: 123456,
        name: 'UNDEFINED-STATE-WITH-PAYMENT',
        branch_id: [1, 'Test Branch'],
        state: undefined,
        payments: [{ id: 1, amount: 100 }],
      };
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });
  });
});
