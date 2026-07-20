import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  booleanTransformer,
  decimalTransformer,
} from '../database/transformers';
import { ReportsService } from './reports.service';
import {
  buildFieldMetas,
  fieldMap,
  humanize,
  measureAlias,
  serialize,
  validateGroupBy,
  validateMeasures,
  type FieldMeta,
} from './report-query';

// ── Pure helpers ──────────────────────────────────────────────────────────────
describe('report-query helpers', () => {
  it('humanize converts camelCase to Title Case', () => {
    expect(humanize('orderSyncQueue')).toBe('Order Sync Queue');
    expect(humanize('created_at')).toBe('Created At');
  });

  it('buildFieldMetas classifies categories into roles and skips Json', () => {
    const metas = buildFieldMetas([
      { name: 'status', category: 'String' },
      { name: 'orderDate', category: 'DateTime' },
      { name: 'totalAmount', category: 'Decimal' },
      { name: 'isPaid', category: 'Boolean' },
      { name: 'validationErrors', category: 'Json' },
    ]);
    const byName = new Map(metas.map((m) => [m.name, m.role]));
    expect(byName.get('status')).toBe('dimension');
    expect(byName.get('orderDate')).toBe('date');
    expect(byName.get('totalAmount')).toBe('measure');
    expect(byName.get('isPaid')).toBe('boolean');
    expect(byName.has('validationErrors')).toBe(false); // Json skipped
  });

  const fields = fieldMap(
    buildFieldMetas([
      { name: 'status', category: 'String' },
      { name: 'totalAmount', category: 'Decimal' },
    ]),
  );

  it('validateGroupBy rejects measures and unknown fields', () => {
    expect(validateGroupBy(fields, ['status'])).toEqual(['status']);
    expect(() => validateGroupBy(fields, ['totalAmount'])).toThrow(
      BadRequestException,
    );
    expect(() => validateGroupBy(fields, ['nope'])).toThrow(BadRequestException);
  });

  it('validateMeasures defaults to count and validates fields', () => {
    expect(validateMeasures(fields, undefined)).toEqual([{ fn: 'count' }]);
    expect(
      validateMeasures(fields, [{ fn: 'sum', field: 'totalAmount' }]),
    ).toEqual([{ fn: 'sum', field: 'totalAmount' }]);
    expect(() =>
      validateMeasures(fields, [{ fn: 'sum', field: 'status' }]),
    ).toThrow(BadRequestException);
  });

  it('measureAlias and serialize', () => {
    expect(measureAlias({ fn: 'count' })).toBe('count');
    expect(measureAlias({ fn: 'sum', field: 'totalAmount' })).toBe(
      'sum_totalAmount',
    );
    expect(
      serialize({ a: 10n, b: new Date('2024-01-01T00:00:00Z') }),
    ).toEqual({ a: '10', b: '2024-01-01T00:00:00.000Z' });
  });
});

// ── Service (TypeORM DataSource mocked) ───────────────────────────────────────
describe('ReportsService', () => {
  let service: ReportsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let qb: any;

  const fakeColumns = [
    { propertyName: 'id', type: 'varchar2' },
    { propertyName: 'status', type: 'varchar2' },
    { propertyName: 'orderDate', type: 'timestamp' },
    {
      propertyName: 'totalAmount',
      type: 'number',
      transformer: decimalTransformer,
    },
    { propertyName: 'isPaid', type: 'number', transformer: booleanTransformer },
    { propertyName: 'createdAt', type: 'timestamp', isCreateDate: true },
  ];

  beforeEach(() => {
    qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const dataSource = {
      getMetadata: () => ({ columns: fakeColumns, relations: [] }),
      getRepository: () => ({ createQueryBuilder: () => qb }),
    } as unknown as DataSource;
    service = new ReportsService(dataSource);
  });

  it('lists datasets with reportable fields', () => {
    const datasets = service.datasets();
    expect(datasets.length).toBeGreaterThan(0);
    const orders = datasets.find((d) => d.slug === 'orders');
    expect(orders?.fields.some((f: FieldMeta) => f.name === 'status')).toBe(true);
  });

  it('runs records mode with pagination and serialized rows', async () => {
    qb.getManyAndCount.mockResolvedValue([[{ id: 'a', status: 'SYNCED' }], 1]);
    const result = await service.run({
      dataset: 'orders',
      page: 1,
      pageSize: 25,
    });
    expect(result.mode).toBe('records');
    expect(result.total).toBe(1);
    expect(result.rows).toEqual([{ id: 'a', status: 'SYNCED' }]);
    expect(qb.take).toHaveBeenCalledWith(25);
  });

  it('runs aggregate mode and shapes rows + summary', async () => {
    qb.getRawMany.mockResolvedValue([
      { status: 'SYNCED', count: 5 },
      { status: 'FAILED', count: 2 },
    ]);
    const result = await service.run({
      dataset: 'orders',
      groupBy: ['status'],
      measures: [{ fn: 'count' }],
    });
    expect(result.mode).toBe('aggregate');
    expect(result.columns).toEqual(['status', 'count']);
    expect(result.rows).toEqual([
      { status: 'SYNCED', count: 5 },
      { status: 'FAILED', count: 2 },
    ]);
    expect(result.summary).toEqual({ count: 7 });
  });

  it('rejects an unknown filter field', async () => {
    await expect(
      service.run({
        dataset: 'orders',
        filters: [{ field: 'nope', op: 'eq', value: 1 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an unknown dataset', async () => {
    await expect(service.run({ dataset: 'nope' })).rejects.toThrow(
      BadRequestException,
    );
  });
});
