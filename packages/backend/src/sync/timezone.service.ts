import { Injectable } from '@nestjs/common';
import { format, fromZonedTime, toZonedTime } from 'date-fns-tz';

@Injectable()
export class TimezoneService {
  normalizeToUtc(date: Date | string, timezone: string): Date {
    const value = typeof date === 'string' ? new Date(date) : date;
    return fromZonedTime(value, timezone);
  }

  toTimezone(date: Date, timezone: string): Date {
    return toZonedTime(date, timezone);
  }

  formatForOracle(date: Date, timezone = 'UTC'): string {
    return format(toZonedTime(date, timezone), "yyyy-MM-dd'T'HH:mm:ss", { timeZone: timezone });
  }

  getDateRangeUtc(startDate: string, endDate: string, timezone: string): { start: Date; end: Date } {
    return {
      start: this.normalizeToUtc(`${startDate}T00:00:00`, timezone),
      end: this.normalizeToUtc(`${endDate}T23:59:59`, timezone),
    };
  }
}
