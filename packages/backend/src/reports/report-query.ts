import { BadRequestException } from '@nestjs/common';
import type { ScalarField } from '../database/entity-fields';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { AlertLog } from '../database/entities/alert-log.entity';
import { WebhookEvent } from '../database/entities/webhook-event.entity';
import { BackupVendHqSale } from '../database/entities/backup-vend-hq-sale.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';

/**
 * Flexible reporting query engine — the pure (DB-free) logic behind `/reports`.
 * Field metadata is derived from TypeORM entity metadata (supplied by the
 * service) rather than Prisma DMMF; the builders here validate a declarative
 * report request and the service compiles it into a TypeORM QueryBuilder.
 */

// ── Dataset registry ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EntityClass = new () => any;

export interface DatasetDef {
  slug: string;
  /** Entity class (was the Prisma model/delegate). */
  entity: EntityClass;
  label: string;
  description: string;
  /** Preferred DateTime field for range filtering / trend charts. */
  defaultDateField?: string;
}

/** Curated whitelist of report-worthy fact tables. */
export const DATASETS: DatasetDef[] = [
  {
    slug: 'orders',
    entity: OrderSyncQueue,
    label: 'Orders (Sync Queue)',
    description:
      'Odoo → Oracle order pipeline. Slice by branch, status, currency, paid/refund flags.',
    defaultDateField: 'orderDate',
  },
  {
    slug: 'sync-jobs',
    entity: SyncJob,
    label: 'Sync Jobs',
    description:
      'Batch sync jobs with record counts and outcomes by type and status.',
    defaultDateField: 'createdAt',
  },
  {
    slug: 'audit',
    entity: AuditLog,
    label: 'Audit Log',
    description: 'Every external operation with status and processing duration.',
    defaultDateField: 'createdAt',
  },
  {
    slug: 'failed-transactions',
    entity: FailedTransaction,
    label: 'Failed Transactions',
    description: 'Failures grouped by error type, resolution and retry counts.',
    defaultDateField: 'createdAt',
  },
  {
    slug: 'alerts',
    entity: AlertLog,
    label: 'Alerts',
    description: 'Operational alerts by type, severity and resolution state.',
    defaultDateField: 'createdAt',
  },
  {
    slug: 'webhooks',
    entity: WebhookEvent,
    label: 'Webhook Events',
    description: 'Inbound webhook events by source system and processing state.',
    defaultDateField: 'receivedAt',
  },
  {
    slug: 'vendhq-sales',
    entity: BackupVendHqSale,
    label: 'VendHQ Sales',
    description:
      'Backed-up VendHQ sales by region and outlet with revenue and tax totals.',
    defaultDateField: 'saleDate',
  },
  {
    slug: 'fusion-invoices',
    entity: FusionInvoiceHeader,
    label: 'Fusion Invoice Headers',
    description: 'Oracle Fusion invoice headers by business unit and source.',
    defaultDateField: 'createdAt',
  },
];

const DATASET_BY_SLUG = new Map(DATASETS.map((d) => [d.slug, d]));

// ── Field metadata ──────────────────────────────────────────────────────────

export type FieldRole = 'dimension' | 'measure' | 'date' | 'boolean';

export interface FieldMeta {
  name: string;
  label: string;
  role: FieldRole;
  /** Category (e.g. 'Int', 'DateTime', 'String'). */
  type: string;
  enumValues?: string[];
}

/** `camelCase` / `snake_case` → `Title Case`. */
export function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Builds the reportable field list from an entity's scalar fields. JSON blobs
 * are skipped; scalars are classified into dimensions/measures/dates/booleans.
 */
export function buildFieldMetas(fields: ScalarField[]): FieldMeta[] {
  const out: FieldMeta[] = [];
  for (const f of fields) {
    if (f.category === 'Json') continue;
    let role: FieldRole;
    if (f.category === 'DateTime') role = 'date';
    else if (f.category === 'Boolean') role = 'boolean';
    else if (
      f.category === 'Int' ||
      f.category === 'BigInt' ||
      f.category === 'Decimal'
    )
      role = 'measure';
    else role = 'dimension';
    out.push({ name: f.name, label: humanize(f.name), role, type: f.category });
  }
  return out;
}

export interface DatasetDescription {
  slug: string;
  label: string;
  description: string;
  defaultDateField?: string;
  fields: FieldMeta[];
}

export function getDatasetDef(slug: string): DatasetDef {
  const def = DATASET_BY_SLUG.get(slug);
  if (!def) throw new BadRequestException(`Unknown dataset: ${slug}`);
  return def;
}

// ── Request contract ────────────────────────────────────────────────────────

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'in'
  | 'between'
  | 'isNull';

export interface ReportFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
  value2?: unknown;
}

export type MeasureFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface ReportMeasure {
  fn: MeasureFn;
  field?: string;
}

export interface ReportSort {
  field: string;
  dir?: 'asc' | 'desc';
}

export interface ReportQueryDto {
  dataset: string;
  filters?: ReportFilter[];
  dateField?: string;
  dateFrom?: string;
  dateTo?: string;
  groupBy?: string[];
  measures?: ReportMeasure[];
  sort?: ReportSort;
  page?: number;
  pageSize?: number;
}

export const MAX_PAGE_SIZE = 500;
export const MAX_GROUP_BY = 2;
export const MAX_FILTERS = 25;
export const MAX_EXPORT_ROWS = 50_000;

// ── Validation + coercion ────────────────────────────────────────────────────

export function fieldMap(fields: FieldMeta[]): Map<string, FieldMeta> {
  return new Map(fields.map((f) => [f.name, f]));
}

export function requireField(
  fields: Map<string, FieldMeta>,
  name: string,
): FieldMeta {
  const f = fields.get(name);
  if (!f) throw new BadRequestException(`Unknown field: ${name}`);
  return f;
}

function coerceNumber(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n))
    throw new BadRequestException(
      `Filter on "${field}" expects a number, got: ${String(value)}`,
    );
  return n;
}

function coerceDate(value: unknown, field: string): Date {
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime()))
    throw new BadRequestException(
      `Filter on "${field}" expects a date, got: ${String(value)}`,
    );
  return d;
}

/** Coerces a scalar filter value to the JS type its field expects. */
export function coerceScalar(value: unknown, meta: FieldMeta): unknown {
  if (meta.role === 'measure') return coerceNumber(value, meta.name);
  if (meta.role === 'date') return coerceDate(value, meta.name);
  if (meta.role === 'boolean') {
    if (typeof value === 'boolean') return value;
    return ['true', '1', 'yes', 'y'].includes(String(value).toLowerCase());
  }
  return String(value);
}

/** Validates a group-by list (deduped, length-checked, no measures). */
export function validateGroupBy(
  fields: Map<string, FieldMeta>,
  groupBy: string[],
): string[] {
  const deduped = [...new Set(groupBy)];
  if (deduped.length > MAX_GROUP_BY)
    throw new BadRequestException(
      `Too many group-by fields (max ${MAX_GROUP_BY}).`,
    );
  for (const g of deduped) {
    const meta = requireField(fields, g);
    if (meta.role === 'measure')
      throw new BadRequestException(
        `Cannot group by a numeric measure field: ${g}.`,
      );
  }
  return deduped;
}

/** Validates measures (defaults to a single count). */
export function validateMeasures(
  fields: Map<string, FieldMeta>,
  measures: ReportMeasure[] | undefined,
): ReportMeasure[] {
  const list: ReportMeasure[] =
    measures && measures.length > 0 ? measures : [{ fn: 'count' }];
  for (const m of list) {
    if (m.fn === 'count') continue;
    if (!m.field)
      throw new BadRequestException(`Measure "${m.fn}" requires a field.`);
    const meta = requireField(fields, m.field);
    if (meta.role !== 'measure')
      throw new BadRequestException(
        `Measure "${m.fn}" requires a numeric field (${m.field} is ${meta.role}).`,
      );
  }
  return list;
}

/** Stable alias for a measure column in flattened result rows. */
export function measureAlias(m: ReportMeasure): string {
  return m.fn === 'count' ? 'count' : `${m.fn}_${m.field}`;
}

/** Recursively converts BigInt → string, Decimal → number, Date → ISO. */
export function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    const maybeDecimal = value as { toNumber?: () => number; d?: unknown };
    if (typeof maybeDecimal.toNumber === 'function' && 'd' in maybeDecimal) {
      return maybeDecimal.toNumber();
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serialize(v);
    }
    return out;
  }
  return value;
}
