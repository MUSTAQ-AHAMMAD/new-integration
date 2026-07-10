import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Flexible reporting query engine.
 *
 * This module contains the *pure* (DB-free) logic that powers the
 * `/reports` API:
 *
 *   • A whitelist registry of report-worthy datasets (fact tables).
 *   • Field metadata derived from the Prisma DMMF at runtime, so we never
 *     reference a column that does not exist and we never let a caller
 *     query an un-whitelisted table or field (injection-safe).
 *   • Builders that translate a declarative report request into Prisma
 *     `where` / `groupBy` / `findMany` arguments.
 *
 * Everything here is deterministic and side-effect-free, which makes it
 * straightforward to unit-test without a database (see reports.service.spec.ts).
 */

// ── Dataset registry ────────────────────────────────────────────────────────

export interface DatasetDef {
  /** URL/route slug used by the API and UI. */
  slug: string;
  /** Prisma model name (PascalCase) — used to look up the DMMF model. */
  model: string;
  /** Prisma delegate name (camelCase) — the key on PrismaService. */
  delegate: string;
  /** Human-friendly dataset name. */
  label: string;
  /** Short description shown in the report builder. */
  description: string;
  /** Preferred DateTime field for range filtering / trend charts. */
  defaultDateField?: string;
}

/**
 * Curated list of datasets exposed to the reporting UI. Only these tables can
 * be queried — anything else is rejected with a 400. Keep this list to genuine
 * "fact" tables that are useful to slice, group and measure.
 */
export const DATASETS: DatasetDef[] = [
  {
    slug: 'orders',
    model: 'OrderSyncQueue',
    delegate: 'orderSyncQueue',
    label: 'Orders (Sync Queue)',
    description:
      'Odoo → Oracle order pipeline. Slice by branch, status, currency, paid/refund flags.',
    defaultDateField: 'orderDate',
  },
  {
    slug: 'sync-jobs',
    model: 'SyncJob',
    delegate: 'syncJob',
    label: 'Sync Jobs',
    description:
      'Batch sync jobs with record counts and outcomes by type and status.',
    defaultDateField: 'createdAt',
  },
  {
    slug: 'audit',
    model: 'AuditLog',
    delegate: 'auditLog',
    label: 'Audit Log',
    description:
      'Every external operation with status and processing duration.',
    defaultDateField: 'createdAt',
  },
  {
    slug: 'failed-transactions',
    model: 'FailedTransaction',
    delegate: 'failedTransaction',
    label: 'Failed Transactions',
    description: 'Failures grouped by error type, resolution and retry counts.',
    defaultDateField: 'createdAt',
  },
  {
    slug: 'alerts',
    model: 'AlertLog',
    delegate: 'alertLog',
    label: 'Alerts',
    description: 'Operational alerts by type, severity and resolution state.',
    defaultDateField: 'createdAt',
  },
  {
    slug: 'webhooks',
    model: 'WebhookEvent',
    delegate: 'webhookEvent',
    label: 'Webhook Events',
    description: 'Inbound webhook events by source system and processing state.',
    defaultDateField: 'receivedAt',
  },
  {
    slug: 'vendhq-sales',
    model: 'BackupVendHqSale',
    delegate: 'backupVendHqSale',
    label: 'VendHQ Sales',
    description:
      'Backed-up VendHQ sales by region and outlet with revenue and tax totals.',
    defaultDateField: 'saleDate',
  },
  {
    slug: 'fusion-invoices',
    model: 'FusionInvoiceHeader',
    delegate: 'fusionInvoiceHeader',
    label: 'Fusion Invoice Headers',
    description: 'Oracle Fusion invoice headers by business unit and source.',
    defaultDateField: 'createdAt',
  },
];

const DATASET_BY_SLUG = new Map(DATASETS.map((d) => [d.slug, d]));

// ── Field metadata ──────────────────────────────────────────────────────────

export type FieldRole = 'dimension' | 'measure' | 'date' | 'boolean';

export interface FieldMeta {
  /** Prisma field name. */
  name: string;
  /** Humanised label for display. */
  label: string;
  /** Reporting role, used to drive the UI and validation. */
  role: FieldRole;
  /** Underlying Prisma scalar/enum type (e.g. 'String', 'Int', 'DateTime'). */
  type: string;
  /** Allowed values when the field is an enum. */
  enumValues?: string[];
}

const NUMERIC_TYPES = new Set(['Int', 'BigInt', 'Float', 'Decimal']);

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

function getDmmfModel(modelName: string) {
  return Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
}

function getDmmfEnum(enumName: string): string[] | undefined {
  const e = Prisma.dmmf.datamodel.enums.find((x) => x.name === enumName);
  return e?.values.map((v) => v.name);
}

/**
 * Derives the reportable field list for a dataset from the Prisma DMMF.
 * Relations, list fields and JSON blobs are skipped; scalars are classified
 * into dimensions (group/filter), measures (aggregate) and dates.
 */
export function describeFields(modelName: string): FieldMeta[] {
  const model = getDmmfModel(modelName);
  if (!model) return [];
  const out: FieldMeta[] = [];
  for (const f of model.fields) {
    if (f.kind === 'object' || f.isList) continue; // relations / arrays
    if (f.type === 'Json') continue; // opaque blobs
    let role: FieldRole;
    if (f.type === 'DateTime') role = 'date';
    else if (f.type === 'Boolean') role = 'boolean';
    else if (NUMERIC_TYPES.has(f.type)) role = 'measure';
    else role = 'dimension'; // String + enums
    out.push({
      name: f.name,
      label: humanize(f.name),
      role,
      type: f.type,
      enumValues: f.kind === 'enum' ? getDmmfEnum(f.type) : undefined,
    });
  }
  return out;
}

export interface DatasetDescription extends DatasetDef {
  fields: FieldMeta[];
}

export function describeDataset(slug: string): DatasetDescription {
  const def = DATASET_BY_SLUG.get(slug);
  if (!def) throw new BadRequestException(`Unknown dataset: ${slug}`);
  return { ...def, fields: describeFields(def.model) };
}

export function listDatasets(): DatasetDescription[] {
  return DATASETS.map((d) => ({ ...d, fields: describeFields(d.model) }));
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
  /** Second bound, only for `between`. */
  value2?: unknown;
}

export type MeasureFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface ReportMeasure {
  fn: MeasureFn;
  /** Required for every fn except `count`. */
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

// ── Validation + builders ───────────────────────────────────────────────────

function fieldMap(modelName: string): Map<string, FieldMeta> {
  return new Map(describeFields(modelName).map((f) => [f.name, f]));
}

function requireField(
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

function coerceScalar(value: unknown, meta: FieldMeta): unknown {
  if (meta.role === 'measure') return coerceNumber(value, meta.name);
  if (meta.role === 'date') return coerceDate(value, meta.name);
  if (meta.role === 'boolean') {
    if (typeof value === 'boolean') return value;
    return ['true', '1', 'yes', 'y'].includes(String(value).toLowerCase());
  }
  return String(value);
}

/** Builds one Prisma condition object for a single filter. */
function buildCondition(meta: FieldMeta, f: ReportFilter): unknown {
  switch (f.op) {
    case 'eq':
      return coerceScalar(f.value, meta);
    case 'ne':
      return { not: coerceScalar(f.value, meta) };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (meta.role !== 'measure' && meta.role !== 'date')
        throw new BadRequestException(
          `Operator "${f.op}" is only valid on numeric or date fields (${meta.name}).`,
        );
      return { [f.op]: coerceScalar(f.value, meta) };
    }
    case 'contains':
    case 'startsWith': {
      if (meta.role !== 'dimension')
        throw new BadRequestException(
          `Operator "${f.op}" is only valid on text fields (${meta.name}).`,
        );
      return { [f.op]: String(f.value), mode: 'insensitive' };
    }
    case 'in': {
      const raw = Array.isArray(f.value)
        ? f.value
        : String(f.value ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      if (raw.length === 0)
        throw new BadRequestException(
          `Operator "in" on "${meta.name}" requires at least one value.`,
        );
      return { in: raw.map((v) => coerceScalar(v, meta)) };
    }
    case 'between': {
      if (meta.role !== 'measure' && meta.role !== 'date')
        throw new BadRequestException(
          `Operator "between" is only valid on numeric or date fields (${meta.name}).`,
        );
      return {
        gte: coerceScalar(f.value, meta),
        lte: coerceScalar(f.value2, meta),
      };
    }
    case 'isNull':
      return null;
    default:
      throw new BadRequestException(`Unsupported operator: ${String(f.op)}`);
  }
}

/**
 * Builds the Prisma `where` clause from filters + an optional date range.
 * Validates every referenced field against the dataset schema.
 */
export function buildWhere(
  modelName: string,
  opts: {
    filters?: ReportFilter[];
    dateField?: string;
    dateFrom?: string;
    dateTo?: string;
  },
): Record<string, unknown> {
  const fields = fieldMap(modelName);
  const where: Record<string, unknown> = {};

  const filters = opts.filters ?? [];
  if (filters.length > MAX_FILTERS)
    throw new BadRequestException(`Too many filters (max ${MAX_FILTERS}).`);

  for (const f of filters) {
    const meta = requireField(fields, f.field);
    where[f.field] = buildCondition(meta, f);
  }

  // Date range — applied to the requested (or default) date field.
  if (opts.dateFrom || opts.dateTo) {
    const dateField = opts.dateField;
    if (!dateField)
      throw new BadRequestException(
        'dateField is required when a date range is provided.',
      );
    const meta = requireField(fields, dateField);
    if (meta.role !== 'date')
      throw new BadRequestException(`"${dateField}" is not a date field.`);
    const range: Record<string, Date> = {};
    if (opts.dateFrom) range.gte = coerceDate(opts.dateFrom, dateField);
    if (opts.dateTo) range.lte = coerceDate(opts.dateTo, dateField);
    where[dateField] = range;
  }

  return where;
}

/** Validates a group-by list and returns it (deduped, length-checked). */
export function validateGroupBy(
  modelName: string,
  groupBy: string[],
): string[] {
  const fields = fieldMap(modelName);
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

/** Validates measures and returns them (defaults to a single count). */
export function validateMeasures(
  modelName: string,
  measures: ReportMeasure[] | undefined,
): ReportMeasure[] {
  const fields = fieldMap(modelName);
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

const FN_TO_PRISMA: Record<Exclude<MeasureFn, 'count'>, string> = {
  sum: '_sum',
  avg: '_avg',
  min: '_min',
  max: '_max',
};

/** Stable alias for a measure column in the flattened result rows. */
export function measureAlias(m: ReportMeasure): string {
  return m.fn === 'count' ? 'count' : `${m.fn}_${m.field}`;
}

export interface AggregateArgs {
  by: string[];
  where: Record<string, unknown>;
  orderBy?: Record<string, 'asc' | 'desc'>;
  take: number;
  _count?: true | { _all: true };
  _sum?: Record<string, true>;
  _avg?: Record<string, true>;
  _min?: Record<string, true>;
  _max?: Record<string, true>;
}

/** Builds the argument object for `prisma.<model>.groupBy(...)`. */
export function buildAggregateArgs(
  modelName: string,
  opts: {
    groupBy: string[];
    measures: ReportMeasure[];
    where: Record<string, unknown>;
    sort?: ReportSort;
    limit: number;
  },
): AggregateArgs {
  const by = validateGroupBy(modelName, opts.groupBy);
  if (by.length === 0)
    throw new BadRequestException('groupBy requires at least one field.');
  const measures = validateMeasures(modelName, opts.measures);
  const fields = fieldMap(modelName);

  const args: AggregateArgs = {
    by,
    where: opts.where,
    take: Math.min(Math.max(1, opts.limit), MAX_PAGE_SIZE),
  };

  let needsCount = false;
  for (const m of measures) {
    if (m.fn === 'count') {
      needsCount = true;
      continue;
    }
    const key = FN_TO_PRISMA[m.fn];
    const bag = args as unknown as Record<string, Record<string, true>>;
    bag[key] = { ...(bag[key] ?? {}), [m.field as string]: true };
  }
  if (needsCount) args._count = { _all: true };

  // Sort: by a grouped dimension directly, or by a measure via its aggregate.
  if (opts.sort) {
    const dir = opts.sort.dir ?? 'desc';
    if (by.includes(opts.sort.field)) {
      args.orderBy = { [opts.sort.field]: dir };
    } else {
      const m = measures.find((mm) => measureAlias(mm) === opts.sort!.field);
      if (m && m.fn !== 'count') {
        args.orderBy = {
          [FN_TO_PRISMA[m.fn]]: { [m.field as string]: dir },
        } as unknown as Record<string, 'asc' | 'desc'>;
      } else if (m && m.fn === 'count') {
        args.orderBy = { _count: { [by[0]]: dir } } as unknown as Record<
          string,
          'asc' | 'desc'
        >;
      }
    }
  } else if (fields.size) {
    // Default: order by the first grouped dimension ascending for stability.
    args.orderBy = { [by[0]]: 'asc' };
  }

  return args;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v as string);
  return Number.isNaN(n) ? null : n;
}

/**
 * Flattens Prisma groupBy output into simple `{ dimension..., measure... }`
 * rows that a chart / table can consume directly.
 */
export function shapeAggregateRows(
  rawRows: Array<Record<string, unknown>>,
  groupBy: string[],
  measures: ReportMeasure[],
): Array<Record<string, unknown>> {
  return rawRows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const g of groupBy) out[g] = row[g];
    for (const m of measures) {
      const alias = measureAlias(m);
      if (m.fn === 'count') {
        const c = row._count as Record<string, unknown> | number | undefined;
        out[alias] =
          typeof c === 'number'
            ? c
            : toNumber((c as Record<string, unknown>)?._all) ?? 0;
      } else {
        const bucket = row[FN_TO_PRISMA[m.fn]] as
          | Record<string, unknown>
          | undefined;
        out[alias] = toNumber(bucket?.[m.field as string]);
      }
    }
    return out;
  });
}

/** Recursively converts BigInt → string and Decimal → number for JSON output. */
export function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    // Prisma Decimal exposes toNumber(); detect duck-typed decimals.
    const maybeDecimal = value as { toNumber?: () => number; s?: unknown };
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

/** Builds an `orderBy` for records mode, validating the sort field. */
export function buildRecordsOrderBy(
  modelName: string,
  sort: ReportSort | undefined,
): Record<string, 'asc' | 'desc'> {
  const fields = fieldMap(modelName);
  if (sort) {
    requireField(fields, sort.field);
    return { [sort.field]: sort.dir ?? 'desc' };
  }
  if (fields.has('createdAt')) return { createdAt: 'desc' };
  if (fields.has('updatedAt')) return { updatedAt: 'desc' };
  return { id: 'desc' };
}
