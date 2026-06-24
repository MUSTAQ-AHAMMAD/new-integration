import { NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { PrismaService } from '../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-001',
    productSku: 'SKU-A',
    productName: 'Widget A',
    branchCode: 'BR001',
    quantityChange: -5,
    isNegativeInventory: true,
    negativeInventoryAlertSent: false,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    createdAt: new Date('2024-01-15T00:00:00Z'),
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

describe('InventoryService', () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    service = new InventoryService(prisma as unknown as PrismaService);
    jest.clearAllMocks();
  });

  // ── listNegativeInventory ─────────────────────────────────────────────────

  describe('listNegativeInventory', () => {
    it('returns records with isNegativeInventory=true', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([makeRecord()]);
      const result = await service.listNegativeInventory();
      expect(result).toHaveLength(1);
      expect(result[0].isNegativeInventory).toBe(true);
    });

    it('returns empty array when no negative inventory', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      const result = await service.listNegativeInventory();
      expect(result).toHaveLength(0);
    });

    it('applies branchCode filter in query when provided', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([makeRecord()]);
      await service.listNegativeInventory({ branchCode: 'BR001' });
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('BR001');
    });

    it('uses default limit of 50', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.listNegativeInventory();
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('50');
    });

    it('uses custom limit when provided', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.listNegativeInventory({ limit: 10 });
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('10');
    });
  });

  // ── markAsReviewed ────────────────────────────────────────────────────────

  describe('markAsReviewed', () => {
    it('returns the updated record on success', async () => {
      const reviewed = makeRecord({
        reviewedAt: new Date(),
        reviewedBy: 'admin',
        reviewNote: 'Checked and confirmed',
      });
      prisma.$queryRaw.mockResolvedValueOnce([reviewed]);
      const result = await service.markAsReviewed('inv-001', 'admin', 'Checked and confirmed');
      expect(result.reviewedBy).toBe('admin');
      expect(result.reviewNote).toBe('Checked and confirmed');
    });

    it('throws NotFoundException when record is not found', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.markAsReviewed('missing', 'admin')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.markAsReviewed('missing', 'admin')).rejects.toThrow(
        'Inventory tracker missing not found',
      );
    });

    it('passes null for reviewNote when omitted', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([makeRecord({ reviewedAt: new Date() })]);
      await service.markAsReviewed('inv-001', 'admin');
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      // null should appear in the parameterised query values
      expect(sqlStr).toContain('null');
    });
  });

  // ── getInventoryStats ─────────────────────────────────────────────────────

  describe('getInventoryStats', () => {
    it('returns summary and byBranch stats', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ totalNegative: 5, reviewed: 3, unreviewed: 2 }])
        .mockResolvedValueOnce([
          { branchCode: 'BR001', total: 5, reviewed: 3, unreviewed: 2 },
        ]);
      const result = await service.getInventoryStats();
      expect(result.totalNegative).toBe(5);
      expect(result.reviewed).toBe(3);
      expect(result.unreviewed).toBe(2);
      expect(result.byBranch).toHaveLength(1);
      expect(result.byBranch[0].branchCode).toBe('BR001');
    });

    it('returns zeros when no data', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const result = await service.getInventoryStats();
      expect(result.totalNegative).toBe(0);
      expect(result.reviewed).toBe(0);
      expect(result.unreviewed).toBe(0);
      expect(result.byBranch).toHaveLength(0);
    });
  });

  // ── getAlertHistory ───────────────────────────────────────────────────────

  describe('getAlertHistory', () => {
    it('returns records ordered by createdAt desc', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([makeRecord(), makeRecord({ id: 'inv-002' })]);
      const result = await service.getAlertHistory();
      expect(result).toHaveLength(2);
    });

    it('passes custom limit to the query', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.getAlertHistory(10);
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('10');
    });

    it('defaults to limit 50 when not specified', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.getAlertHistory();
      const sqlStr = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sqlStr).toContain('50');
    });
  });
});
