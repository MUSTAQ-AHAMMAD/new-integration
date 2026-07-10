import { BadRequestException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildAggregateArgs,
  buildRecordsOrderBy,
  buildWhere,
  describeDataset,
  describeFields,
  humanize,
  listDatasets,
  measureAlias,
  serialize,
  shapeAggregateRows,
  validateGroupBy,
  validateMeasures,
} from './report-query';

// ── Pure helpers (no DB) ─────────────────────────────────────────────────────

describe('report-query helpers', () => {
  describe('humanize', () => {
    it('turns camelCase into Title Case', () => {
      expect(humanize('branchCode')).toBe('Branch Code');
      expect(humanize('totalAmount')).toBe('Total Amount');
      expect(humanize('alert_code')).toBe('Alert Code');
    });
  });

  describe('describeFields', () => {
    it('classifies OrderSyncQueue fields by role', () => {
      const fields = describeFields('OrderSyncQueue');
      const byName = new Map(fields.map((f) => [f.name, f]));

      expect(byName.get('branchCode')?.role).toBe('dimension');
      expect(byName.get('status')?.role).toBe('dimension');
      expect(byName.get('totalAmount')?.role).toBe('measure');
      expect(byName.get('syncAttempts')?.role).toBe('measure');
      expect(byName.get('isPaid')?.role).toBe('boolean');
      expect(byName.get('orderDate')?.role).toBe('date');
    });

    it('exposes enum values for enum dimensions', () => {
      const status = describeFields('OrderSyncQueue').find(
        (f) => f.name === 'status',
      );
      expect(status?.enumValues).toEqual(
        expect.arrayContaining(['SYNCED', 'FAILED', 'PENDING']),
      );
    });

    it('skips relations, list fields and Json blobs', () => {
      const names = describeFields('OrderSyncQueue').map((f) => f.name);
      expect(names).not.toContain('failedTransactions'); // relation list
      expect(names).not.toContain('validationErrors'); // Json
      expect(names).not.toContain('negativeInventoryItems'); // Json
    });

    it('returns an empty list for an unknown model', () => {
      expect(describeFields('NopeNotAModel')).toEqual([]);
    });
  });

  describe('listDatasets / describeDataset', () => {
    it('lists the whitelisted datasets with fields', () => {
      const datasets = listDatasets();
      const slugs = datasets.map((d) => d.slug);
      expect(slugs).toContain('orders');
      expect(slugs).toContain('vendhq-sales');
      expect(datasets.every((d) => d.fields.length > 0)).toBe(true);
    });

    it('rejects an unknown dataset', () => {
      expect(() => describeDataset('made-up')).toThrow(BadRequestException);
    });
  });

  describe('buildWhere', () => {
    it('builds equality, comparison and text conditions', () => {
      const where = buildWhere('OrderSyncQueue', {
        filters: [
          { field: 'branchCode', op: 'eq', value: 'BR001' },
          { field: 'totalAmount', op: 'gte', value: '100' },
          { field: 'customerName', op: 'contains', value: 'ali' },
          { field: 'isPaid', op: 'eq', value: 'true' },
        ],
      });

      expect(where.branchCode).toBe('BR001');
      expect(where.totalAmount).toEqual({ gte: 100 });
      expect(where.customerName).toEqual({
        contains: 'ali',
        mode: 'insensitive',
      });
      expect(where.isPaid).toBe(true);
    });

    it('supports in and between operators', () => {
      const where = buildWhere('OrderSyncQueue', {
        filters: [
          { field: 'status', op: 'in', value: 'SYNCED,FAILED' },
          { field: 'totalAmount', op: 'between', value: '10', value2: '50' },
        ],
      });
      expect(where.status).toEqual({ in: ['SYNCED', 'FAILED'] });
      expect(where.totalAmount).toEqual({ gte: 10, lte: 50 });
    });

    it('applies a date range on the requested date field', () => {
      const where = buildWhere('OrderSyncQueue', {
        dateField: 'orderDate',
        dateFrom: '2026-01-01',
        dateTo: '2026-02-01',
      });
      const range = where.orderDate as { gte: Date; lte: Date };
      expect(range.gte).toBeInstanceOf(Date);
      expect(range.lte).toBeInstanceOf(Date);
    });

    it('rejects an unknown filter field', () => {
      expect(() =>
        buildWhere('OrderSyncQueue', {
          filters: [{ field: 'notReal', op: 'eq', value: 'x' }],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects a non-numeric value for a numeric comparison', () => {
      expect(() =>
        buildWhere('OrderSyncQueue', {
          filters: [{ field: 'totalAmount', op: 'gte', value: 'abc' }],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects gt/lt on a text field', () => {
      expect(() =>
        buildWhere('OrderSyncQueue', {
          filters: [{ field: 'branchCode', op: 'gt', value: 'x' }],
        }),
      ).toThrow(BadRequestException);
    });

    it('requires a date field when a range is supplied', () => {
      expect(() =>
        buildWhere('OrderSyncQueue', { dateFrom: '2026-01-01' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('validateGroupBy', () => {
    it('accepts dimension and boolean fields', () => {
      expect(validateGroupBy('OrderSyncQueue', ['branchCode', 'isPaid'])).toEqual(
        ['branchCode', 'isPaid'],
      );
    });

    it('dedupes fields', () => {
      expect(
        validateGroupBy('OrderSyncQueue', ['status', 'status']),
      ).toEqual(['status']);
    });

    it('rejects grouping by a numeric measure', () => {
      expect(() =>
        validateGroupBy('OrderSyncQueue', ['totalAmount']),
      ).toThrow(BadRequestException);
    });

    it('rejects too many group-by fields', () => {
      expect(() =>
        validateGroupBy('OrderSyncQueue', ['branchCode', 'status', 'currency']),
      ).toThrow(BadRequestException);
    });
  });

  describe('validateMeasures', () => {
    it('defaults to a single count', () => {
      expect(validateMeasures('OrderSyncQueue', undefined)).toEqual([
        { fn: 'count' },
      ]);
    });

    it('accepts sum/avg on numeric fields', () => {
      expect(
        validateMeasures('OrderSyncQueue', [
          { fn: 'sum', field: 'totalAmount' },
          { fn: 'avg', field: 'syncAttempts' },
        ]),
      ).toHaveLength(2);
    });

    it('rejects sum without a field', () => {
      expect(() =>
        validateMeasures('OrderSyncQueue', [{ fn: 'sum' }]),
      ).toThrow(BadRequestException);
    });

    it('rejects sum on a non-numeric field', () => {
      expect(() =>
        validateMeasures('OrderSyncQueue', [{ fn: 'sum', field: 'branchCode' }]),
      ).toThrow(BadRequestException);
    });
  });

  describe('measureAlias', () => {
    it('names count and aggregate measures', () => {
      expect(measureAlias({ fn: 'count' })).toBe('count');
      expect(measureAlias({ fn: 'sum', field: 'totalAmount' })).toBe(
        'sum_totalAmount',
      );
    });
  });

  describe('buildAggregateArgs', () => {
    it('builds groupBy args with count and sum', () => {
      const args = buildAggregateArgs('OrderSyncQueue', {
        groupBy: ['branchCode'],
        measures: [{ fn: 'count' }, { fn: 'sum', field: 'totalAmount' }],
        where: { status: 'SYNCED' },
        limit: 100,
      });
      expect(args.by).toEqual(['branchCode']);
      expect(args._count).toEqual({ _all: true });
      expect(args._sum).toEqual({ totalAmount: true });
      expect(args.take).toBe(100);
      expect(args.where).toEqual({ status: 'SYNCED' });
    });

    it('clamps take to the max page size', () => {
      const args = buildAggregateArgs('OrderSyncQueue', {
        groupBy: ['branchCode'],
        measures: [{ fn: 'count' }],
        where: {},
        limit: 10_000,
      });
      expect(args.take).toBeLessThanOrEqual(500);
    });

    it('orders by a measure alias when requested', () => {
      const args = buildAggregateArgs('OrderSyncQueue', {
        groupBy: ['branchCode'],
        measures: [{ fn: 'sum', field: 'totalAmount' }],
        where: {},
        sort: { field: 'sum_totalAmount', dir: 'desc' },
        limit: 50,
      });
      expect(args.orderBy).toEqual({ _sum: { totalAmount: 'desc' } });
    });
  });

  describe('shapeAggregateRows', () => {
    it('flattens Prisma groupBy output into flat rows', () => {
      const raw = [
        {
          branchCode: 'BR001',
          _count: { _all: 12 },
          _sum: { totalAmount: 3400 },
        },
        {
          branchCode: 'BR002',
          _count: { _all: 5 },
          _sum: { totalAmount: 900 },
        },
      ];
      const rows = shapeAggregateRows(raw, ['branchCode'], [
        { fn: 'count' },
        { fn: 'sum', field: 'totalAmount' },
      ]);
      expect(rows).toEqual([
        { branchCode: 'BR001', count: 12, sum_totalAmount: 3400 },
        { branchCode: 'BR002', count: 5, sum_totalAmount: 900 },
      ]);
    });
  });

  describe('serialize', () => {
    it('converts BigInt to string and Date to ISO', () => {
      const out = serialize({ big: 10n, when: new Date('2026-01-01') }) as {
        big: string;
        when: string;
      };
      expect(out.big).toBe('10');
      expect(out.when).toBe('2026-01-01T00:00:00.000Z');
    });

    it('converts Prisma-like Decimal to number', () => {
      const decimalLike = { d: [1], e: 0, s: 1, toNumber: () => 42.5 };
      expect(serialize({ amount: decimalLike })).toEqual({ amount: 42.5 });
    });
  });

  describe('buildRecordsOrderBy', () => {
    it('defaults to createdAt desc', () => {
      expect(buildRecordsOrderBy('OrderSyncQueue', undefined)).toEqual({
        createdAt: 'desc',
      });
    });

    it('honours an explicit sort field', () => {
      expect(
        buildRecordsOrderBy('OrderSyncQueue', {
          field: 'totalAmount',
          dir: 'asc',
        }),
      ).toEqual({ totalAmount: 'asc' });
    });

    it('rejects an unknown sort field', () => {
      expect(() =>
        buildRecordsOrderBy('OrderSyncQueue', { field: 'bogus' }),
      ).toThrow(BadRequestException);
    });
  });
});

// ── Service (Prisma mocked) ──────────────────────────────────────────────────

describe('ReportsService', () => {
  const mockDelegate = {
    findMany: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  };
  const mockPrisma = { orderSyncQueue: mockDelegate };
  let service: ReportsService;

  beforeEach(() => {
    service = new ReportsService(mockPrisma as unknown as PrismaService);
    jest.clearAllMocks();
  });

  it('exposes datasets metadata', () => {
    const datasets = service.datasets();
    expect(datasets.find((d) => d.slug === 'orders')).toBeDefined();
  });

  it('runs an aggregate query and computes a summary', async () => {
    mockDelegate.groupBy.mockResolvedValueOnce([
      { branchCode: 'BR001', _count: { _all: 3 }, _sum: { totalAmount: 300 } },
      { branchCode: 'BR002', _count: { _all: 2 }, _sum: { totalAmount: 150 } },
    ]);

    const result = await service.run({
      dataset: 'orders',
      groupBy: ['branchCode'],
      measures: [{ fn: 'count' }, { fn: 'sum', field: 'totalAmount' }],
    });

    expect(result.mode).toBe('aggregate');
    expect(result.columns).toEqual(['branchCode', 'count', 'sum_totalAmount']);
    expect(result.rows).toHaveLength(2);
    expect(result.summary).toEqual({ count: 5, sum_totalAmount: 450 });
  });

  it('runs a records query with pagination', async () => {
    mockDelegate.findMany.mockResolvedValueOnce([
      { id: '1', branchCode: 'BR001', totalAmount: 10 },
    ]);
    mockDelegate.count.mockResolvedValueOnce(1);

    const result = await service.run({
      dataset: 'orders',
      pageSize: 25,
      page: 1,
    });

    expect(result.mode).toBe('records');
    expect(result.total).toBe(1);
    expect(mockDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25, skip: 0 }),
    );
  });

  it('rejects an unknown dataset', async () => {
    await expect(service.run({ dataset: 'nope' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('renders CSV from an aggregate result', async () => {
    mockDelegate.groupBy.mockResolvedValueOnce([
      { branchCode: 'BR001', _count: { _all: 3 } },
    ]);
    const csv = await service.exportCsv({
      dataset: 'orders',
      groupBy: ['branchCode'],
      measures: [{ fn: 'count' }],
    });
    expect(csv).toBe('branchCode,count\nBR001,3');
  });
});
