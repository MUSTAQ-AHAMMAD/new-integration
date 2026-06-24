import { toApiDatetime } from './odoo-utils';

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
