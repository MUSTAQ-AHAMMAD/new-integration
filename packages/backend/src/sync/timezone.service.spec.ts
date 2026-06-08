import { TimezoneService } from './timezone.service';

describe('TimezoneService', () => {
  const service = new TimezoneService();

  it('normalizes a zoned date to UTC', () => {
    const result = service.normalizeToUtc('2024-01-01T12:00:00', 'Asia/Dubai');
    expect(result.toISOString()).toBe('2024-01-01T08:00:00.000Z');
  });
});
