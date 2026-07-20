import { ValueTransformer } from 'typeorm';
import { Decimal } from 'decimal.js';

/**
 * Column value transformers bridging Oracle's native types to the JS types the
 * app uses. Oracle has no BOOLEAN (pre-23c) and stores JSON as CLOB, so these
 * normalise the round-trip on the way in/out of the driver.
 *
 * IMPORTANT: `to` passes `undefined` through unchanged so TypeORM OMITS the
 * column from the INSERT and the DB default applies (mapping undefined→null
 * would insert an explicit NULL and break NOT NULL columns that have defaults).
 * Explicit `null` is still mapped to null.
 */

/** Oracle NUMBER(1) 0/1 ↔ JS boolean. */
export const booleanTransformer: ValueTransformer = {
  to: (value?: boolean | null): number | null | undefined =>
    value === undefined ? undefined : value === null ? null : value ? 1 : 0,
  from: (value?: number | string | null): boolean | null =>
    value === null || value === undefined ? null : Number(value) === 1,
};

/** Oracle NUMBER(p,s) ↔ decimal.js Decimal (preserves the precision Prisma.Decimal gave). */
export const decimalTransformer: ValueTransformer = {
  to: (value?: Decimal | number | string | null): number | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return value instanceof Decimal ? value.toNumber() : Number(value);
  },
  from: (value?: number | string | null): Decimal | null =>
    value === null || value === undefined ? null : new Decimal(value),
};

/** Oracle NUMBER ↔ JS bigint (Oracle IDs that exceed Number.MAX_SAFE_INTEGER). */
export const bigintTransformer: ValueTransformer = {
  to: (value?: bigint | number | string | null): string | null | undefined =>
    value === undefined ? undefined : value === null ? null : String(value),
  from: (value?: number | string | null): bigint | null =>
    value === null || value === undefined ? null : BigInt(value),
};

/** Oracle CLOB text ↔ parsed JSON. Tolerates already-parsed objects from the driver. */
export const jsonTransformer: ValueTransformer = {
  to: (value?: unknown): string | null | undefined =>
    value === undefined ? undefined : value === null ? null : JSON.stringify(value),
  from: (value?: string | null): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
};
