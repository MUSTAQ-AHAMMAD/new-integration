import { TimezoneService } from './timezone.service';

describe('TimezoneService', () => {
  const service = new TimezoneService();

  it('normalizes a zoned date to UTC', () => {
    const result = service.normalizeToUtc('2024-01-01T12:00:00', 'Asia/Dubai');
    expect(result.toISOString()).toBe('2024-01-01T08:00:00.000Z');
  });

  it('normalizes a Date object to UTC', () => {
    const date = new Date('2024-06-15T10:00:00');
    const result = service.normalizeToUtc(date, 'UTC');
    expect(result instanceof Date).toBe(true);
  });

  it('formats a date for Oracle', () => {
    const date = new Date('2024-01-01T00:00:00Z');
    const formatted = service.formatForOracle(date, 'UTC');
    expect(formatted).toBe('2024-01-01T00:00:00');
  });

  it('returns a UTC date range spanning full days', () => {
    const range = service.getDateRangeUtc('2024-01-01', '2024-01-03', 'UTC');
    expect(range.start < range.end).toBe(true);
    expect(range.start.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2024-01-03T23:59:59.000Z');
  });

  it('accounts for timezone offset in range', () => {
    const range = service.getDateRangeUtc(
      '2024-01-01',
      '2024-01-01',
      'Asia/Dubai',
    );
    // Asia/Dubai is UTC+4, so midnight local = 20:00 previous day UTC
    expect(range.start.toISOString()).toBe('2023-12-31T20:00:00.000Z');
  });
});
