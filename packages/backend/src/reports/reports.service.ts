import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildAggregateArgs,
  buildRecordsOrderBy,
  buildWhere,
  getDatasetDef,
  listDatasets,
  measureAlias,
  serialize,
  shapeAggregateRows,
  validateMeasures,
  MAX_EXPORT_ROWS,
  MAX_PAGE_SIZE,
  type DatasetDescription,
  type ReportMeasure,
  type ReportQueryDto,
} from './report-query';

interface PrismaDelegate {
  findMany(args?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  count(args?: Record<string, unknown>): Promise<number>;
  groupBy(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

export interface ReportResult {
  mode: 'aggregate' | 'records';
  dataset: string;
  /** Column keys in row order — dimensions then measures (aggregate mode). */
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** Total matching records (records mode) or number of groups (aggregate). */
  total: number;
  page: number;
  pageSize: number;
  /** Grand totals per measure across the full filtered set (aggregate mode). */
  summary?: Record<string, number>;
  measures?: ReportMeasure[];
  groupBy?: string[];
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private delegate(name: string): PrismaDelegate {
    const d = (this.prisma as unknown as Record<string, unknown>)[name];
    if (!d) throw new BadRequestException(`Dataset delegate not found: ${name}`);
    return d as PrismaDelegate;
  }

  /** Metadata for the report builder: datasets + their reportable fields. */
  datasets(): DatasetDescription[] {
    return listDatasets();
  }

  async run(dto: ReportQueryDto): Promise<ReportResult> {
    const def = getDatasetDef(dto.dataset);
    const delegate = this.delegate(def.delegate);
    const where = buildWhere(def.model, {
      filters: dto.filters,
      dateField: dto.dateField ?? def.defaultDateField,
      dateFrom: dto.dateFrom,
      dateTo: dto.dateTo,
    });

    const wantsAggregate = !!dto.groupBy && dto.groupBy.length > 0;

    if (wantsAggregate) {
      const measures = validateMeasures(def.model, dto.measures);
      const limit = Math.min(dto.pageSize ?? 100, MAX_PAGE_SIZE);
      const args = buildAggregateArgs(def.model, {
        groupBy: dto.groupBy!,
        measures,
        where,
        sort: dto.sort,
        limit,
      });
      const raw = await delegate.groupBy(
        args as unknown as Record<string, unknown>,
      );
      const rows = shapeAggregateRows(raw, args.by, measures).map(
        (r) => serialize(r) as Record<string, unknown>,
      );

      const summary: Record<string, number> = {};
      for (const m of measures) {
        const alias = measureAlias(m);
        summary[alias] = rows.reduce(
          (acc, r) => acc + (Number(r[alias]) || 0),
          0,
        );
      }

      return {
        mode: 'aggregate',
        dataset: def.slug,
        columns: [...args.by, ...measures.map(measureAlias)],
        rows,
        total: rows.length,
        page: 1,
        pageSize: limit,
        summary,
        measures,
        groupBy: args.by,
      };
    }

    // Records mode — filtered/sorted/paginated raw rows.
    const page = Math.max(1, dto.page ?? 1);
    const pageSize = Math.min(Math.max(1, dto.pageSize ?? 50), MAX_PAGE_SIZE);
    const orderBy = buildRecordsOrderBy(def.model, dto.sort);
    const [data, total] = await Promise.all([
      delegate.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      delegate.count({ where }),
    ]);
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

  /** Runs the query and renders the result rows as a CSV string. */
  async exportCsv(dto: ReportQueryDto): Promise<string> {
    const result = await this.run({
      ...dto,
      page: 1,
      pageSize: Math.min(dto.pageSize ?? MAX_EXPORT_ROWS, MAX_EXPORT_ROWS),
    });
    return ReportsService.rowsToCsv(result.columns, result.rows);
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
