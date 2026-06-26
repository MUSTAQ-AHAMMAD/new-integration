import { toApiDatetime, normalizeOrderForIngestion, RawOdooOrderFields } from './odoo-utils';

describe('toApiDatetime', () => {
  it('appends 00:00:00 to a date-only start date', () => {
    expect(toApiDatetime('2026-02-01')).toBe('2026-02-01 00:00:00');
  });

  it('appends 23:59:59 to a date-only end date', () => {
    expect(toApiDatetime('2026-02-01', { end: true })).toBe(
      '2026-02-01 23:59:59',
    );
  });

  it('leaves a datetime string with a space separator unchanged', () => {
    expect(toApiDatetime('2026-02-01 21:00:00')).toBe('2026-02-01 21:00:00');
    expect(toApiDatetime('2026-02-02 20:59:59', { end: true })).toBe(
      '2026-02-02 20:59:59',
    );
  });

  it('leaves a datetime string with a T separator unchanged', () => {
    expect(toApiDatetime('2026-02-01T21:00:00')).toBe('2026-02-01T21:00:00');
  });
});

describe('normalizeOrderForIngestion - isPaid logic', () => {
  const createMockOrder = (state: string, amount = 100): RawOdooOrderFields => ({
    id: 123456,
    name: 'TEST-ORDER-001',
    branch_id: [1, 'Test Branch'],
    date_order: '2026-06-26 10:00:00',
    amount_total: amount,
    state,
  });

  describe('State-based paid order detection', () => {
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

    it('should be case-insensitive for state matching', () => {
      const order = createMockOrder('PAID');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(true);
    });

    it('should mark "draft" state as NOT paid', () => {
      const order = createMockOrder('draft');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(false);
    });

    it('should mark unknown state as NOT paid', () => {
      const order = createMockOrder('unknown_state');
      const result = normalizeOrderForIngestion(order);
      expect(result?.isPaid).toBe(false);
      expect(result?.isCancelled).toBe(false);
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
  });
  });
});
