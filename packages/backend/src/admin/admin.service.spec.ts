import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdminService } from './admin.service';

// Fake entity metadata: the columns the tests exercise on 'fusion-receipt-methods'.
const fakeMeta = {
  columns: [
    { propertyName: 'id', type: 'varchar2' },
    { propertyName: 'receiptMethodName', type: 'varchar2' },
    { propertyName: 'region', type: 'varchar2' },
    { propertyName: 'createdAt', type: 'timestamp', isCreateDate: true },
  ],
  relations: [],
};

function makeRepo() {
  return {
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn().mockResolvedValue(null),
    // create returns its input so tests can inspect the shaped data
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
    save: jest.fn().mockImplementation((x: Record<string, unknown>) =>
      Promise.resolve({ id: 'new-id', ...x }),
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn().mockResolvedValue([]),
  };
}

describe('AdminService', () => {
  let service: AdminService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    repo = makeRepo();
    const dataSource = {
      getMetadata: () => fakeMeta,
      getRepository: () => repo,
    } as unknown as DataSource;
    service = new AdminService(dataSource);
  });

  describe('unknown table', () => {
    it('throws BadRequestException for an unknown slug', async () => {
      await expect(service.list('non-existent-table', {})).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('list', () => {
    it('returns data and total, passing skip/take/order', async () => {
      repo.findAndCount.mockResolvedValue([[{ id: 'rec-001' }], 1]);
      const result = await service.list('fusion-receipt-methods', {
        skip: 10,
        take: 5,
      });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 5, order: { createdAt: 'DESC' } }),
      );
    });

    it('adds region where when region is provided', async () => {
      await service.list('fusion-receipt-methods', { region: 'AE' });
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { region: 'AE' } }),
      );
    });
  });

  describe('getOne', () => {
    it('returns the record when found', async () => {
      repo.findOne.mockResolvedValueOnce({ id: 'rec-001' });
      expect(await service.getOne('fusion-receipt-methods', 'rec-001')).toMatchObject({
        id: 'rec-001',
      });
    });

    it('throws NotFoundException when not found', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getOne('fusion-receipt-methods', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('strips id/createdAt/updatedAt and normalises region', async () => {
      await service.create('fusion-receipt-methods', {
        id: 'strip-me',
        createdAt: new Date(),
        updatedAt: new Date(),
        receiptMethodName: 'Cash',
        region: 'ae',
      });
      const data = repo.create.mock.calls[0][0];
      expect(data.id).toBeUndefined();
      expect(data.createdAt).toBeUndefined();
      expect(data.receiptMethodName).toBe('Cash');
      expect(data.region).toBe('AE'); // upper-cased
      expect(repo.save).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates the record when found', async () => {
      repo.findOne.mockResolvedValue({ id: 'rec-001' });
      await service.update('fusion-receipt-methods', 'rec-001', { receiptMethodName: 'X' });
      expect(repo.update).toHaveBeenCalledWith(
        'rec-001',
        expect.objectContaining({ receiptMethodName: 'X' }),
      );
    });

    it('throws NotFoundException when the record does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.update('fusion-receipt-methods', 'missing', { receiptMethodName: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes when found', async () => {
      repo.findOne.mockResolvedValueOnce({ id: 'rec-001' });
      await service.remove('fusion-receipt-methods', 'rec-001');
      expect(repo.delete).toHaveBeenCalledWith('rec-001');
    });

    it('throws NotFoundException when missing', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.remove('fusion-receipt-methods', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('tables', () => {
    it('returns slug/model descriptors', () => {
      const tables = AdminService.tables();
      expect(tables.length).toBeGreaterThan(0);
      expect(tables[0]).toHaveProperty('slug');
      expect(tables[0]).toHaveProperty('model');
    });
  });

  describe('exportCsv', () => {
    it('returns empty string with no rows', async () => {
      repo.find.mockResolvedValueOnce([]);
      expect(await service.exportCsv('fusion-receipt-methods')).toBe('');
    });

    it('returns CSV header + data rows and escapes commas/quotes', async () => {
      repo.find.mockResolvedValueOnce([
        { id: 'r1', receiptMethodName: 'Cash, Rounded', region: 'AE' },
        { id: 'r2', receiptMethodName: 'Say "Hi"', region: 'AE' },
      ]);
      const csv = await service.exportCsv('fusion-receipt-methods');
      const lines = csv.split('\n');
      expect(lines[0]).toBe('id,receiptMethodName,region');
      expect(csv).toContain('"Cash, Rounded"');
      expect(csv).toContain('"Say ""Hi"""');
    });

    it('passes region filter to find', async () => {
      await service.exportCsv('fusion-receipt-methods', 'KW');
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { region: 'KW' } }),
      );
    });
  });

  describe('importCsv', () => {
    it('returns zero for an empty CSV', async () => {
      const r = await service.importCsv('fusion-receipt-methods', 'header1\n');
      expect(r).toEqual({ imported: 0, skipped: 0, errors: [] });
    });

    it('imports valid rows', async () => {
      const csv = 'receiptMethodName,region\nCash,AE\nVisa,AE';
      const r = await service.importCsv('fusion-receipt-methods', csv);
      expect(r.imported).toBe(2);
      expect(r.skipped).toBe(0);
    });

    it('normalises UPPER_SNAKE_CASE headers and strips system columns', async () => {
      const csv = 'ID,RECEIPT_METHOD_NAME,REGION\nold,Cash,ae';
      await service.importCsv('fusion-receipt-methods', csv);
      const data = repo.create.mock.calls[0][0];
      expect(data.id).toBeUndefined();
      expect(data.receiptMethodName).toBe('Cash');
      expect(data.region).toBe('AE');
    });

    it('counts failing rows as skipped with error messages', async () => {
      repo.save.mockRejectedValue(new Error('Unique constraint failed'));
      const r = await service.importCsv(
        'fusion-receipt-methods',
        'receiptMethodName,region\nCash,AE',
      );
      expect(r.imported).toBe(0);
      expect(r.skipped).toBe(1);
      expect(r.errors[0]).toContain('Unique constraint failed');
    });

    it('rejects rows with unknown fields', async () => {
      const csv = 'receiptMethodName,bogusField\nCash,x';
      const r = await service.importCsv('fusion-receipt-methods', csv);
      expect(r.imported).toBe(0);
      expect(r.skipped).toBe(1);
      expect(r.errors[0]).toContain('Unknown fields');
    });
  });
});
