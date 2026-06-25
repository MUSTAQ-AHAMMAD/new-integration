import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeDelegate(rows: Record<string, unknown>[] = []) {
  return {
    findMany: jest.fn().mockResolvedValue(rows),
    count: jest.fn().mockResolvedValue(rows.length),
    findUnique: jest.fn().mockResolvedValue(rows[0] ?? null),
    create: jest
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'new-id', ...data }),
      ),
    update: jest
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'existing-id', ...data }),
      ),
    delete: jest.fn().mockResolvedValue({}),
  };
}

function makePrisma(
  delegates: Record<string, ReturnType<typeof makeDelegate>> = {},
) {
  // Attach the provided delegates; fall back to an empty delegate for unknown names
  return new Proxy(
    {
      fusionReceiptMethod: makeDelegate(),
      ...delegates,
    },
    {
      get(target, prop: string) {
        return target[prop as keyof typeof target] ?? makeDelegate();
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdminService', () => {
  let service: AdminService;
  let delegate: ReturnType<typeof makeDelegate>;

  beforeEach(() => {
    delegate = makeDelegate([
      { id: 'rec-001', name: 'Test', createdAt: new Date() },
    ]);
    const prisma = makePrisma({ fusionReceiptMethod: delegate });
    service = new AdminService(prisma as unknown as PrismaService);
    jest.clearAllMocks();
  });

  // ── getDelegate ──────────────────────────────────────────────────────────

  describe('getDelegate', () => {
    it('returns a delegate for a valid table slug', () => {
      const d = service.getDelegate('fusion-receipt-methods');
      expect(d).toBeDefined();
    });

    it('throws BadRequestException for an unknown table slug', () => {
      expect(() => service.getDelegate('non-existent-table')).toThrow(
        BadRequestException,
      );
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns data array and total', async () => {
      const result = await service.list('fusion-receipt-methods', {});
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('passes skip and take options', async () => {
      await service.list('fusion-receipt-methods', { skip: 10, take: 5 });
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 5 }),
      );
    });

    it('adds where clause when region is provided', async () => {
      await service.list('fusion-receipt-methods', { region: 'AE' });
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { region: 'AE' } }),
      );
    });

    it('uses empty where when region is absent', async () => {
      await service.list('fusion-receipt-methods', {});
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });

  // ── getOne ────────────────────────────────────────────────────────────────

  describe('getOne', () => {
    it('returns the record when found', async () => {
      delegate.findUnique.mockResolvedValueOnce({
        id: 'rec-001',
        name: 'Found',
      });
      const record = await service.getOne('fusion-receipt-methods', 'rec-001');
      expect(record).toMatchObject({ id: 'rec-001' });
    });

    it('throws NotFoundException when not found', async () => {
      delegate.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.getOne('fusion-receipt-methods', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('strips id, createdAt, updatedAt before calling create', async () => {
      await service.create('fusion-receipt-methods', {
        id: 'should-be-stripped',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'My Method',
      });
      const [callArgs] = delegate.create.mock.calls;
      expect(callArgs[0].data.id).toBeUndefined();
      expect(callArgs[0].data.createdAt).toBeUndefined();
      expect(callArgs[0].data.name).toBe('My Method');
    });
  });

  // ── update ────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the record when found', async () => {
      delegate.findUnique.mockResolvedValueOnce({ id: 'rec-001' });
      await service.update('fusion-receipt-methods', 'rec-001', {
        name: 'Updated',
      });
      expect(delegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'rec-001' } }),
      );
    });

    it('throws NotFoundException when record does not exist', async () => {
      delegate.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.update('fusion-receipt-methods', 'missing', { name: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── remove ────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('deletes the record when found', async () => {
      delegate.findUnique.mockResolvedValueOnce({ id: 'rec-001' });
      await service.remove('fusion-receipt-methods', 'rec-001');
      expect(delegate.delete).toHaveBeenCalledWith({
        where: { id: 'rec-001' },
      });
    });

    it('throws NotFoundException when record does not exist', async () => {
      delegate.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.remove('fusion-receipt-methods', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── tables ────────────────────────────────────────────────────────────────

  describe('tables', () => {
    it('returns an array of table descriptors', () => {
      const tables = AdminService.tables();
      expect(tables.length).toBeGreaterThan(0);
      expect(tables[0]).toHaveProperty('slug');
      expect(tables[0]).toHaveProperty('model');
    });
  });

  // ── exportCsv ─────────────────────────────────────────────────────────────

  describe('exportCsv', () => {
    it('returns empty string when no rows exist', async () => {
      delegate.findMany.mockResolvedValueOnce([]);
      const csv = await service.exportCsv('fusion-receipt-methods');
      expect(csv).toBe('');
    });

    it('returns CSV with header row and data rows', async () => {
      delegate.findMany.mockResolvedValueOnce([
        { id: 'rec-001', name: 'Cash', region: 'AE' },
        { id: 'rec-002', name: 'Visa', region: 'AE' },
      ]);
      const csv = await service.exportCsv('fusion-receipt-methods');
      const lines = csv.split('\n');
      expect(lines[0]).toBe('id,name,region');
      expect(lines[1]).toContain('rec-001');
      expect(lines[2]).toContain('rec-002');
    });

    it('escapes values containing commas', async () => {
      delegate.findMany.mockResolvedValueOnce([
        { id: 'r1', name: 'Comma, Value' },
      ]);
      const csv = await service.exportCsv('fusion-receipt-methods');
      expect(csv).toContain('"Comma, Value"');
    });

    it('escapes values containing double-quotes', async () => {
      delegate.findMany.mockResolvedValueOnce([{ id: 'r1', name: 'Say "Hi"' }]);
      const csv = await service.exportCsv('fusion-receipt-methods');
      expect(csv).toContain('"Say ""Hi"""');
    });

    it('passes region filter to findMany when provided', async () => {
      delegate.findMany.mockResolvedValueOnce([]);
      await service.exportCsv('fusion-receipt-methods', 'KW');
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { region: 'KW' } }),
      );
    });
  });

  // ── importCsv ─────────────────────────────────────────────────────────────

  describe('importCsv', () => {
    it('returns 0 imported and 0 skipped for empty CSV', async () => {
      const result = await service.importCsv(
        'fusion-receipt-methods',
        'header1\n',
      );
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('imports valid rows and returns count', async () => {
      delegate.create.mockResolvedValue({ id: 'new-id' });
      const csv = 'name,region\nCash,AE\nVisa,AE';
      const result = await service.importCsv('fusion-receipt-methods', csv);
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('counts rows that fail create as skipped with error messages', async () => {
      delegate.create.mockRejectedValue(new Error('Unique constraint failed'));
      const csv = 'name,region\nCash,AE';
      const result = await service.importCsv('fusion-receipt-methods', csv);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]).toContain('Unique constraint failed');
    });

    it('handles partially failing rows independently', async () => {
      delegate.create
        .mockResolvedValueOnce({ id: 'ok' })
        .mockRejectedValueOnce(new Error('oops'));
      const csv = 'name,region\nCash,AE\nVisa,AE';
      const result = await service.importCsv('fusion-receipt-methods', csv);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('normalises UPPER_SNAKE_CASE headers to camelCase', async () => {
      delegate.create.mockResolvedValue({ id: 'new-id' });
      const csv = 'RECEIPT_METHOD_NAME,REGION\nCash,AE';
      await service.importCsv('fusion-receipt-methods', csv);
      const [callArgs] = delegate.create.mock.calls;
      // Should not pass RECEIPT_METHOD_NAME as a raw key
      expect(callArgs[0].data['RECEIPT_METHOD_NAME']).toBeUndefined();
    });

    it('strips id, createdAt, updatedAt from imported rows', async () => {
      delegate.create.mockResolvedValue({ id: 'new-id' });
      const csv = 'id,createdAt,name\nold-id,2024-01-01,Cash';
      await service.importCsv('fusion-receipt-methods', csv);
      const [callArgs] = delegate.create.mock.calls;
      expect(callArgs[0].data.id).toBeUndefined();
      expect(callArgs[0].data.createdAt).toBeUndefined();
    });

    it('handles quoted CSV fields correctly', async () => {
      delegate.create.mockResolvedValue({ id: 'new-id' });
      const csv = 'name,region\n"Cash, Rounded",AE';
      await service.importCsv('fusion-receipt-methods', csv);
      const [callArgs] = delegate.create.mock.calls;
      expect(callArgs[0].data.name).toBe('Cash, Rounded');
    });
  });
});
