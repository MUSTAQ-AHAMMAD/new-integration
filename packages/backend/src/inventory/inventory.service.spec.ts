import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InventoryService } from './inventory.service';
import { InventorySyncTracker } from '../database/entities/inventory-sync-tracker.entity';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeRecord(
  overrides: Partial<InventorySyncTracker> = {},
): InventorySyncTracker {
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
  } as unknown as InventorySyncTracker;
}

function makeQb() {
  return {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue(undefined),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InventoryService', () => {
  let service: InventoryService;
  let repo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };
  let qb: ReturnType<typeof makeQb>;

  beforeEach(() => {
    qb = makeQb();
    repo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn(),
      save: jest.fn((x) => Promise.resolve(x)),
      find: jest.fn().mockResolvedValue([]),
    };
    service = new InventoryService(
      repo as unknown as Repository<InventorySyncTracker>,
    );
    jest.clearAllMocks();
  });

  // ── listNegativeInventory ─────────────────────────────────────────────────

  describe('listNegativeInventory', () => {
    it('returns records with isNegativeInventory=true', async () => {
      qb.getMany.mockResolvedValueOnce([makeRecord()]);
      const result = await service.listNegativeInventory();
      expect(result).toHaveLength(1);
      expect(result[0].isNegativeInventory).toBe(true);
    });

    it('returns empty array when no negative inventory', async () => {
      qb.getMany.mockResolvedValueOnce([]);
      const result = await service.listNegativeInventory();
      expect(result).toHaveLength(0);
    });

    it('applies branchCode filter when provided', async () => {
      qb.getMany.mockResolvedValueOnce([makeRecord()]);
      await service.listNegativeInventory({ branchCode: 'BR001' });
      expect(qb.andWhere).toHaveBeenCalledWith('t.branchCode = :branchCode', {
        branchCode: 'BR001',
      });
    });

    it('uses default limit of 50', async () => {
      qb.getMany.mockResolvedValueOnce([]);
      await service.listNegativeInventory();
      expect(qb.take).toHaveBeenCalledWith(50);
    });

    it('uses custom limit when provided', async () => {
      qb.getMany.mockResolvedValueOnce([]);
      await service.listNegativeInventory({ limit: 10 });
      expect(qb.take).toHaveBeenCalledWith(10);
    });
  });

  // ── markAsReviewed ────────────────────────────────────────────────────────

  describe('markAsReviewed', () => {
    it('returns the updated record on success', async () => {
      repo.findOne.mockResolvedValueOnce(makeRecord());
      const result = await service.markAsReviewed(
        'inv-001',
        'admin',
        'Checked and confirmed',
      );
      expect(result.reviewedBy).toBe('admin');
      expect(result.reviewNote).toBe('Checked and confirmed');
      expect(result.reviewedAt).toBeInstanceOf(Date);
      expect(repo.save).toHaveBeenCalled();
    });

    it('throws NotFoundException when record is not found', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.markAsReviewed('missing', 'admin')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.markAsReviewed('missing', 'admin')).rejects.toThrow(
        'Inventory tracker missing not found',
      );
    });

    it('sets null for reviewNote when omitted', async () => {
      repo.findOne.mockResolvedValueOnce(makeRecord());
      const result = await service.markAsReviewed('inv-001', 'admin');
      expect(result.reviewNote).toBeNull();
    });
  });

  // ── getInventoryStats ─────────────────────────────────────────────────────

  describe('getInventoryStats', () => {
    it('returns summary and byBranch stats', async () => {
      qb.getRawOne.mockResolvedValueOnce({
        totalNegative: 5,
        reviewed: 3,
        unreviewed: 2,
      });
      qb.getRawMany.mockResolvedValueOnce([
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
      qb.getRawOne.mockResolvedValueOnce(undefined);
      qb.getRawMany.mockResolvedValueOnce([]);
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
      repo.find.mockResolvedValueOnce([
        makeRecord(),
        makeRecord({ id: 'inv-002' }),
      ]);
      const result = await service.getAlertHistory();
      expect(result).toHaveLength(2);
    });

    it('passes custom limit to the query', async () => {
      repo.find.mockResolvedValueOnce([]);
      await service.getAlertHistory(10);
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });

    it('defaults to limit 50 when not specified', async () => {
      repo.find.mockResolvedValueOnce([]);
      await service.getAlertHistory();
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });
  });
});
