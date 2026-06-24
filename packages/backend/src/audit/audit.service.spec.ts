import { NotFoundException } from '@nestjs/common';
import { AuditService } from './audit.service';
import { PrismaService } from '../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeAuditRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit-001',
    action: 'CREATE_INVOICE',
    entityType: 'ORDER',
    entityId: 'order-001',
    branchCode: 'BR001',
    userId: null,
    requestPayload: {},
    responsePayload: null,
    errorMessage: null,
    statusCode: 200,
    durationMs: 150,
    correlationId: null,
    createdAt: new Date('2024-01-15T10:00:00Z'),
    ...overrides,
  };
}

function makePrisma() {
  return {
    $queryRaw: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditService', () => {
  let service: AuditService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    service = new AuditService(prisma as unknown as PrismaService);
    jest.clearAllMocks();
  });

  // ── search ────────────────────────────────────────────────────────────────

  describe('search', () => {
    it('executes query with no conditions when params are empty', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([makeAuditRecord()]);
      const result = await service.search({});
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });

    it('returns empty array when no records match', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      const result = await service.search({ orderId: 'nonexistent' });
      expect(result).toHaveLength(0);
    });

    it('passes the query with orderId filter', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.search({ orderId: 'order-001' });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const sqlArg = prisma.$queryRaw.mock.calls[0][0];
      // The Prisma.sql tagged template produces a Sql object — check it includes the term
      const sqlStr = JSON.stringify(sqlArg);
      expect(sqlStr).toContain('order-001');
    });

    it('applies entityType filter', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.search({ entityType: 'ORDER' });
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('ORDER');
    });

    it('applies action filter', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.search({ action: 'CREATE_INVOICE' });
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('CREATE_INVOICE');
    });

    it('applies startDate and endDate filters', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.search({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      });
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('2024-01-01');
      expect(sqlStr).toContain('2024-01-31');
    });

    it('applies status "success" filter', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.search({ status: 'success' });
      // Successful path: COALESCE("statusCode", 0) < 400
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('400');
    });

    it('applies status "failed" filter', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.search({ status: 'failed' });
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('400');
    });

    it('applies status "error" filter (alias for failed)', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.search({ status: 'error' });
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('400');
    });

    it('applies numeric status code filter', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.search({ status: '500' });
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('500');
    });

    it('respects limit and offset params', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.search({ limit: 10, offset: 20 });
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('10');
      expect(sqlStr).toContain('20');
    });
  });

  // ── getEntry ─────────────────────────────────────────────────────────────

  describe('getEntry', () => {
    it('returns the record when found', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([makeAuditRecord()]);
      const record = await service.getEntry('audit-001');
      expect(record).toMatchObject({ id: 'audit-001', action: 'CREATE_INVOICE' });
    });

    it('throws NotFoundException when no record is found', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.getEntry('missing')).rejects.toThrow(NotFoundException);
      await expect(service.getEntry('missing')).rejects.toThrow(
        'Audit log entry missing not found',
      );
    });
  });

  // ── getStats ──────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('returns stats with byAction, byEntityType, errorRate, total, errors', async () => {
      // Three parallel queries: actions, entityTypes, totals
      prisma.$queryRaw
        .mockResolvedValueOnce([{ key: 'CREATE_INVOICE', count: 10 }])
        .mockResolvedValueOnce([{ key: 'ORDER', count: 10 }])
        .mockResolvedValueOnce([{ total: 10, errors: 2 }]);

      const stats = await service.getStats();

      expect(stats.byAction).toEqual([{ action: 'CREATE_INVOICE', count: 10 }]);
      expect(stats.byEntityType).toEqual([{ entityType: 'ORDER', count: 10 }]);
      expect(stats.total).toBe(10);
      expect(stats.errors).toBe(2);
      expect(stats.errorRate).toBeCloseTo(0.2);
    });

    it('returns 0 errorRate when total is 0', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0, errors: 0 }]);

      const stats = await service.getStats();
      expect(stats.errorRate).toBe(0);
      expect(stats.total).toBe(0);
    });

    it('handles missing totals row gracefully', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]); // empty totals

      const stats = await service.getStats();
      expect(stats.total).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.errorRate).toBe(0);
    });
  });
});
