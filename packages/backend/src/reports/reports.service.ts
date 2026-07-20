import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder, ObjectLiteral } from 'typeorm';
import { scalarFields } from '../database/entity-fields';
import {
  DATASETS,
  buildFieldMetas,
  coerceScalar,
  fieldMap,
  getDatasetDef,
  measureAlias,
  requireField,
  serialize,
  validateGroupBy,
  validateMeasures,
  MAX_EXPORT_ROWS,
  MAX_FILTERS,
  MAX_PAGE_SIZE,
  type DatasetDef,
  type DatasetDescription,
  type FieldMeta,
  type ReportFilter,
  type ReportMeasure,
  type ReportQueryDto,
  type ReportSort,
} from './report-query';

export interface ReportResult {
  mode: 'aggregate' | 'records';
  dataset: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
  summary?: Record<string, number>;
  measures?: ReportMeasure[];
  groupBy?: string[];
}

@Injectable()
export class ReportsService {
  private readonly fieldCache = new Map<string, FieldMeta[]>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Reportable fields for a dataset, from TypeORM entity metadata (cached). */
  private fieldsFor(def: DatasetDef): FieldMeta[] {
    const cached = this.fieldCache.get(def.slug);
    if (cached) return cached;
    const meta = this.dataSource.getMetadata(def.entity);
    const fields = buildFieldMetas(scalarFields(meta));
    this.fieldCache.set(def.slug, fields);
    return fields;
  }

  /** Metadata for the report builder: datasets + their reportable fields. */
  datasets(): DatasetDescription[] {
    return DATASETS.map((d) => ({
      slug: d.slug,
      label: d.label,
      description: d.description,
      defaultDateField: d.defaultDateField,
      fields: this.fieldsFor(d),
    }));
  }

  async run(dto: ReportQueryDto): Promise<ReportResult> {
    const def = getDatasetDef(dto.dataset);
    const fields = fieldMap(this.fieldsFor(def));
    const repo = this.dataSource.getRepository(def.entity);
    const alias = 't';

    const wantsAggregate = !!dto.groupBy && dto.groupBy.length > 0;

    if (wantsAggregate) {
      const by = validateGroupBy(fields, dto.groupBy!);
      if (by.length === 0)
        throw new BadRequestException('groupBy requires at least one field.');
      const measures = validateMeasures(fields, dto.measures);
      const limit = Math.min(dto.pageSize ?? 100, MAX_PAGE_SIZE);

      const qb = repo.createQueryBuilder(alias).select([]);
      for (const dim of by) {
        qb.addSelect(`${alias}.${dim}`, dim).addGroupBy(`${alias}.${dim}`);
      }
      for (const m of measures) {
        qb.addSelect(this.aggregateExpr(alias, m), measureAlias(m));
      }
      this.applyWhere(qb, alias, fields, dto);
      this.applyAggregateOrder(qb, alias, by, measures, dto.sort);
      qb.limit(limit);

      const raw = await qb.getRawMany<Record<string, unknown>>();
      const rows = raw.map((r) => this.shapeAggregateRow(r, by, measures, fields));

      const summary: Record<string, number> = {};
      for (const m of measures) {
        const a = measureAlias(m);
        summary[a] = rows.reduce((acc, r) => acc + (Number(r[a]) || 0), 0);
      }

      return {
        mode: 'aggregate',
        dataset: def.slug,
        columns: [...by, ...measures.map(measureAlias)],
        rows,
        total: rows.length,
        page: 1,
        pageSize: limit,
        summary,
        measures,
        groupBy: by,
      };
    }

    // Records mode — filtered/sorted/paginated raw rows.
    const page = Math.max(1, dto.page ?? 1);
    const pageSize = Math.min(Math.max(1, dto.pageSize ?? 50), MAX_PAGE_SIZE);
    const qb = repo.createQueryBuilder(alias);
    this.applyWhere(qb, alias, fields, dto);
    const [sortField, sortDir] = this.recordsOrder(fields, dto.sort);
    qb.orderBy(`${alias}.${sortField}`, sortDir);
    qb.skip((page - 1) * pageSize).take(pageSize);

    const [data, total] = await qb.getManyAndCount();
    const rows = data.map((r) => serialize(r) as Record<string, unknown>);
    return {
      mode: 'records',
      dataset: def.slug,
      columns: rows.length ? Object.keys(rows[0]) : [],
      rows,
      total,
      page,
      pageSize,
    };
  }

  async exportCsv(dto: ReportQueryDto): Promise<string> {
    const result = await this.run({
      ...dto,
      page: 1,
      pageSize: Math.min(dto.pageSize ?? MAX_EXPORT_ROWS, MAX_EXPORT_ROWS),
    });
    return ReportsService.rowsToCsv(result.columns, result.rows);
  }

  // ── QueryBuilder helpers ──────────────────────────────────────

  private aggregateExpr(alias: string, m: ReportMeasure): string {
    if (m.fn === 'count') return 'COUNT(*)';
    return `${m.fn.toUpperCase()}(${alias}.${m.field})`;
  }

  /** Applies filters + date range to the WHERE clause. */
  private applyWhere(
    qb: SelectQueryBuilder<ObjectLiteral>,
    alias: string,
    fields: Map<string, FieldMeta>,
    dto: ReportQueryDto,
  ): void {
    const filters = dto.filters ?? [];
    if (filters.length > MAX_FILTERS)
      throw new BadRequestException(`Too many filters (max ${MAX_FILTERS}).`);

    let p = 0;
    const next = () => `p${p++}`;
    // For NUMBER(1) boolean columns, bind 1/0 (raw SQL bypasses the transformer).
    const bind = (v: unknown, meta: FieldMeta) => {
      const c = coerceScalar(v, meta);
      return meta.role === 'boolean' ? (c ? 1 : 0) : c;
    };

    for (const f of filters) {
      const meta = requireField(fields, f.field);
      const col = `${alias}.${f.field}`;
      switch (f.op) {
        case 'eq': {
          const k = next();
          qb.andWhere(`${col} = :${k}`, { [k]: bind(f.value, meta) });
          break;
        }
        case 'ne': {
          const k = next();
          qb.andWhere(`${col} <> :${k}`, { [k]: bind(f.value, meta) });
          break;
        }
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
          if (meta.role !== 'measure' && meta.role !== 'date')
            throw new BadRequestException(
              `Operator "${f.op}" is only valid on numeric or date fields (${meta.name}).`,
            );
          const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op];
          const k = next();
          qb.andWhere(`${col} ${sym} :${k}`, { [k]: bind(f.value, meta) });
          break;
        }
        case 'contains':
        case 'startsWith': {
          if (meta.role !== 'dimension')
            throw new BadRequestException(
              `Operator "${f.op}" is only valid on text fields (${meta.name}).`,
            );
          const k = next();
          const val = String(f.value);
          const pattern = f.op === 'contains' ? `%${val}%` : `${val}%`;
          qb.andWhere(`LOWER(${col}) LIKE LOWER(:${k})`, { [k]: pattern });
          break;
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
          const k = next();
          qb.andWhere(`${col} IN (:...${k})`, {
            [k]: raw.map((v) => bind(v, meta)),
          });
          break;
        }
        case 'between': {
          if (meta.role !== 'measure' && meta.role !== 'date')
            throw new BadRequestException(
              `Operator "between" is only valid on numeric or date fields (${meta.name}).`,
            );
          const a = next();
          const b = next();
          qb.andWhere(`${col} BETWEEN :${a} AND :${b}`, {
            [a]: bind(f.value, meta),
            [b]: bind(f.value2, meta),
          });
          break;
        }
        case 'isNull':
          qb.andWhere(`${col} IS NULL`);
          break;
        default:
          throw new BadRequestException(`Unsupported operator: ${String(f.op)}`);
      }
    }

    // Date range on the requested (or default) date field.
    if (dto.dateFrom || dto.dateTo) {
      const dateField = dto.dateField;
      if (!dateField)
        throw new BadRequestException(
          'dateField is required when a date range is provided.',
        );
      const meta = requireField(fields, dateField);
      if (meta.role !== 'date')
        throw new BadRequestException(`"${dateField}" is not a date field.`);
      const col = `${alias}.${dateField}`;
      if (dto.dateFrom) {
        qb.andWhere(`${col} >= :dfrom`, {
          dfrom: coerceScalar(dto.dateFrom, meta),
        });
      }
      if (dto.dateTo) {
        qb.andWhere(`${col} <= :dto_`, { dto_: coerceScalar(dto.dateTo, meta) });
      }
    }
  }

  private applyAggregateOrder(
    qb: SelectQueryBuilder<ObjectLiteral>,
    alias: string,
    by: string[],
    measures: ReportMeasure[],
    sort?: ReportSort,
  ): void {
    const dir = (sort?.dir ?? 'desc').toUpperCase() as 'ASC' | 'DESC';
    if (sort && by.includes(sort.field)) {
      qb.orderBy(`${alias}.${sort.field}`, dir);
      return;
    }
    if (sort) {
      const m = measures.find((mm) => measureAlias(mm) === sort.field);
      if (m) {
        qb.orderBy(this.aggregateExpr(alias, m), dir);
        return;
      }
    }
    // Default: first grouped dimension ascending for stability.
    qb.orderBy(`${alias}.${by[0]}`, 'ASC');
  }

  private recordsOrder(
    fields: Map<string, FieldMeta>,
    sort?: ReportSort,
  ): [string, 'ASC' | 'DESC'] {
    if (sort) {
      requireField(fields, sort.field);
      return [sort.field, (sort.dir ?? 'desc').toUpperCase() as 'ASC' | 'DESC'];
    }
    if (fields.has('createdAt')) return ['createdAt', 'DESC'];
    if (fields.has('updatedAt')) return ['updatedAt', 'DESC'];
    return ['id', 'DESC'];
  }

  /** Case-insensitive raw-row value lookup (Oracle may upper-case aliases). */
  private rawGet(row: Record<string, unknown>, key: string): unknown {
    if (key in row) return row[key];
    const lower = key.toLowerCase();
    for (const k of Object.keys(row)) {
      if (k.toLowerCase() === lower) return row[k];
    }
    return undefined;
  }

  private shapeAggregateRow(
    row: Record<string, unknown>,
    by: string[],
    measures: ReportMeasure[],
    fields: Map<string, FieldMeta>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const g of by) {
      const v = this.rawGet(row, g);
      // NUMBER(1) boolean dimensions come back as 0/1 — restore boolean.
      out[g] = fields.get(g)?.role === 'boolean' && v != null ? Number(v) === 1 : v;
    }
    for (const m of measures) {
      const a = measureAlias(m);
      const v = this.rawGet(row, a);
      out[a] = v == null ? 0 : Number(v);
    }
    return out;
  }

  private static escapeCsvCell(value: unknown): string {
    const str = value == null ? '' : String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replaceAll('"', '""')}"`;
    }
    return str;
  }

  private static rowsToCsv(
    columns: string[],
    rows: Array<Record<string, unknown>>,
  ): string {
    const headers = columns.length
      ? columns
      : rows.length
        ? Object.keys(rows[0])
        : [];
    if (headers.length === 0) return '';
    const lines = [
      headers.map((h) => ReportsService.escapeCsvCell(h)).join(','),
      ...rows.map((row) =>
        headers.map((h) => ReportsService.escapeCsvCell(row[h])).join(','),
      ),
    ];
    return lines.join('\n');
  }
}
