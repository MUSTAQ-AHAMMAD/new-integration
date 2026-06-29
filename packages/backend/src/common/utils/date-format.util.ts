/**
 * DateFormatUtil - Utility for consistent date formatting across the application
 *
 * Fixes the "[object Ob]" issue by ensuring dates are properly serialized to ISO strings
 */
export class DateFormatUtil {
  /**
   * Format a date to ISO string for API responses
   * Returns null if date is invalid or missing
   */
  static formatDate(date: any): string | null {
    if (!date) return null;
    try {
      const d = new Date(date);
      if (isNaN(d.getTime())) return null;
      return d.toISOString();
    } catch {
      return null;
    }
  }

  /**
   * Format a date for display in UI
   * Returns a human-readable format or fallback text
   */
  static formatDateDisplay(date: any): string {
    if (!date) return 'N/A';
    try {
      const d = new Date(date);
      if (isNaN(d.getTime())) return 'Invalid Date';
      return d.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return 'Invalid Date';
    }
  }

  /**
   * Batch format dates in an object
   * Useful for formatting multiple date fields at once
   */
  static formatDatesInObject<T extends Record<string, any>>(
    obj: T,
    dateFields: (keyof T)[],
  ): T {
    const formatted = { ...obj };
    for (const field of dateFields) {
      if (formatted[field]) {
        formatted[field] = this.formatDate(formatted[field]) as any;
      }
    }
    return formatted;
  }
}
