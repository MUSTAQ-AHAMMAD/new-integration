/**
 * BigInt Utilities - Centralized BigInt handling utilities
 *
 * This module provides safe conversion utilities for BigInt values
 * to prevent serialization errors and precision loss issues.
 */

/**
 * Safely convert a BigInt to a Number with overflow protection
 * @param value - The BigInt value to convert
 * @param fieldName - Optional field name for error messages
 * @returns Number representation of the BigInt
 * @throws RangeError if the value exceeds MAX_SAFE_INTEGER
 */
export function bigIntToNumber(
  value: bigint | null | undefined,
  fieldName?: string,
): number {
  if (value === null || value === undefined) {
    return 0;
  }

  // Check for precision loss
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(-Number.MAX_SAFE_INTEGER)
  ) {
    const field = fieldName ? ` (${fieldName})` : '';
    throw new RangeError(
      `BigInt value${field} ${value.toString()} exceeds MAX_SAFE_INTEGER and cannot be safely converted to number`,
    );
  }

  return Number(value);
}

/**
 * Safely convert a BigInt to a Number, returning null if the value is null/undefined
 * @param value - The BigInt value to convert
 * @param fieldName - Optional field name for error messages
 * @returns Number representation or null
 */
export function bigIntToNumberOrNull(
  value: bigint | null | undefined,
  fieldName?: string,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return bigIntToNumber(value, fieldName);
}

/**
 * Safely convert any value (including BigInt, Decimal, string) to Number
 * Handles Prisma Decimal, BigInt, and primitive types
 * @param value - The value to convert
 * @returns Number representation
 */
export function toSafeNumber(value: any): number {
  if (value === null || value === undefined) {
    return 0;
  }

  // Handle BigInt
  if (typeof value === 'bigint') {
    return bigIntToNumber(value);
  }

  // Handle numbers
  if (typeof value === 'number') {
    return value;
  }

  // Handle strings
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
  }

  // Handle Prisma Decimal with toNumber() method
  if (
    value &&
    typeof value === 'object' &&
    typeof value.toNumber === 'function'
  ) {
    return value.toNumber();
  }

  // Handle Prisma Decimal internal structure { s, e, d }
  if (
    value &&
    typeof value === 'object' &&
    's' in value &&
    'e' in value &&
    'd' in value
  ) {
    try {
      return parseFloat(value.toString());
    } catch {
      return 0;
    }
  }

  // Fallback to Number conversion
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

/**
 * Recursively serialize an object, converting all BigInt values to numbers
 * This is useful for logging and debugging
 * @param obj - Object to serialize
 * @returns Serialized object with BigInts converted
 */
export function serializeBigIntForLog(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return bigIntToNumber(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => serializeBigIntForLog(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = serializeBigIntForLog(value);
    }
    return result;
  }

  return obj;
}

/**
 * Check if a BigInt value is safe to convert to number
 * @param value - BigInt value to check
 * @returns true if safe to convert
 */
export function isSafeBigInt(value: bigint): boolean {
  return (
    value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(-Number.MAX_SAFE_INTEGER)
  );
}

/**
 * Convert a number to BigInt safely
 * @param value - Number to convert
 * @returns BigInt representation
 */
export function numberToBigInt(value: number | null | undefined): bigint {
  if (value === null || value === undefined || isNaN(value)) {
    return BigInt(0);
  }

  // Check if value is an integer
  if (!Number.isInteger(value)) {
    // Truncate to integer
    value = Math.trunc(value);
  }

  return BigInt(value);
}

/**
 * Safe JSON stringify that handles BigInt values
 * Uses the global BigInt.prototype.toJSON if available
 * @param obj - Object to stringify
 * @param space - Indentation space
 * @returns JSON string
 */
export function stringifyWithBigInt(obj: any, space?: number): string {
  return JSON.stringify(
    obj,
    (_, value) => {
      if (typeof value === 'bigint') {
        return bigIntToNumber(value);
      }
      return value;
    },
    space,
  );
}
