import { NotFoundException } from '@nestjs/common';
import { Prisma, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ManualCreditMemoInput, RefundsService } from './refunds.service';

const mockPrisma = {
  $queryRaw: jest.fn(),
  refundTracking: {
    create: jest.fn(),
  },
};

function makeRefundRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ref-1',
    originalOrderId: 'ORD-001',
    originalOrderNumber: 'S00001',
    refundOrderId: 'REF-001',
    refundOrderNumber: 'R00001',
    refundAmount: new Prisma.Decimal(100),
    refundReason: 'Customer return',
    refundDate: new Date('2024-01-15T00:00:00Z'),
    oracleCreditMemoNumber: 'CM-001',
    creditMemoStatus: 'SUCCESS',
    isReconciled: false,
    reconcileNote: null,
    createdAt: new Date('2024-01-15T00:00:00Z'),
    ...overrides,
  };
}

describe('RefundsService', () => {
  let service: RefundsService;

  beforeEach(() => {
    service = new RefundsService(mockPrisma as unknown as PrismaService);
    jest.clearAllMocks();
  });

  // ── listRefunds ─────────────────────────────────────────────

  describe('listRefunds', () => {
    it('returns all refunds when no filter is applied', async () => {
      const records = [makeRefundRecord(), makeRefundRecord({ id: 'ref-2' })];
      mockPrisma.$queryRaw.mockResolvedValue(records);

      const result = await service.listRefunds();

      expect(result).toHaveLength(2);
    });

    it('passes a status filter in the SQL query', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await service.listRefunds({ status: 'SUCCESS' });

      const sqlCall = mockPrisma.$queryRaw.mock.calls[0][0] as {
        strings: string[];
        values: unknown[];
      };
      const queryStr = sqlCall.strings.join('');
      expect(queryStr).toContain('creditMemoStatus');
    });

    it('passes a month filter in the SQL query', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await service.listRefunds({ month: 3 });

      const sqlCall = mockPrisma.$queryRaw.mock.calls[0][0] as {
        strings: string[];
      };
      const queryStr = sqlCall.strings.join('');
      expect(queryStr).toContain('MONTH');
    });

    it('passes a year filter in the SQL query', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await service.listRefunds({ year: 2024 });

      const sqlCall = mockPrisma.$queryRaw.mock.calls[0][0] as {
        strings: string[];
      };
      const queryStr = sqlCall.strings.join('');
      expect(queryStr).toContain('YEAR');
    });

    it('uses default limit of 50 when not specified', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await service.listRefunds();

      const sqlCall = mockPrisma.$queryRaw.mock.calls[0][0] as {
        strings: string[];
        values: unknown[];
      };
      // The limit value should appear in the values array
      expect(sqlCall.values).toContain(50);
    });

    it('uses the custom limit when provided', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await service.listRefunds({ limit: 10 });

      const sqlCall = mockPrisma.$queryRaw.mock.calls[0][0] as {
        values: unknown[];
      };
      expect(sqlCall.values).toContain(10);
    });
  });

  // ── getRefund ───────────────────────────────────────────────

  describe('getRefund', () => {
    it('returns the refund record when found', async () => {
      const record = makeRefundRecord();
      mockPrisma.$queryRaw.mockResolvedValue([record]);

      const result = await service.getRefund('ref-1');

      expect(result.id).toBe('ref-1');
    });

    it('throws NotFoundException when refund is not found', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await expect(service.getRefund('missing-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws with a message containing the refund id', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await expect(service.getRefund('ref-999')).rejects.toThrow('ref-999');
    });
  });

  // ── reconcileRefund ─────────────────────────────────────────

  describe('reconcileRefund', () => {
    it('marks the refund as reconciled with a note', async () => {
      const updated = makeRefundRecord({
        isReconciled: true,
        reconcileNote: 'Verified by finance',
      });
      mockPrisma.$queryRaw.mockResolvedValue([updated]);

      const result = await service.reconcileRefund(
        'ref-1',
        'Verified by finance',
      );

      expect(result.isReconciled).toBe(true);
      expect(result.reconcileNote).toBe('Verified by finance');
    });

    it('throws NotFoundException when the refund does not exist', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await expect(
        service.reconcileRefund('missing-id', 'some note'),
      ).rejects.toThrow(NotFoundException);
    });

    it('includes the reconcile note in the SQL UPDATE call', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([makeRefundRecord()]);

      await service.reconcileRefund('ref-1', 'Finance approved');

      const sqlCall = mockPrisma.$queryRaw.mock.calls[0][0] as {
        values: unknown[];
      };
      expect(sqlCall.values).toContain('Finance approved');
    });
  });

  // ── createManualCreditMemo ──────────────────────────────────

  describe('createManualCreditMemo', () => {
    const creditMemoInput: ManualCreditMemoInput = {
      originalOrderId: 'ORD-001',
      originalOrderNumber: 'S00001',
      refundOrderId: 'REF-MANUAL-001',
      refundOrderNumber: 'R-MANUAL-001',
      refundAmount: 200,
      refundReason: 'Manual adjustment',
      refundDate: new Date('2024-02-01T00:00:00Z'),
    };

    it('creates a new refund tracking record', async () => {
      const created = makeRefundRecord({
        id: 'ref-manual-1',
        refundOrderId: 'REF-MANUAL-001',
      });
      mockPrisma.refundTracking.create.mockResolvedValue(created);

      const result = await service.createManualCreditMemo(creditMemoInput);

      expect(result.id).toBe('ref-manual-1');
    });

    it('stores the refund amount as a Prisma Decimal', async () => {
      mockPrisma.refundTracking.create.mockResolvedValue(makeRefundRecord());

      await service.createManualCreditMemo(creditMemoInput);

      const data = mockPrisma.refundTracking.create.mock.calls[0][0].data as {
        refundAmount: Prisma.Decimal;
      };
      expect(data.refundAmount instanceof Prisma.Decimal).toBe(true);
      expect(data.refundAmount.toNumber()).toBe(200);
    });

    it('sets creditMemoStatus to PENDING', async () => {
      mockPrisma.refundTracking.create.mockResolvedValue(makeRefundRecord());

      await service.createManualCreditMemo(creditMemoInput);

      const data = mockPrisma.refundTracking.create.mock.calls[0][0].data as {
        creditMemoStatus: SyncStatus;
      };
      expect(data.creditMemoStatus).toBe(SyncStatus.PENDING);
    });

    it('maps all input fields to the create payload', async () => {
      mockPrisma.refundTracking.create.mockResolvedValue(makeRefundRecord());

      await service.createManualCreditMemo(creditMemoInput);

      expect(mockPrisma.refundTracking.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          originalOrderId: 'ORD-001',
          originalOrderNumber: 'S00001',
          refundOrderId: 'REF-MANUAL-001',
          refundOrderNumber: 'R-MANUAL-001',
          refundReason: 'Manual adjustment',
        }),
      });
    });
  });

  // ── getRefundStats ──────────────────────────────────────────

  describe('getRefundStats', () => {
    it('returns aggregate stats from the database', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { total: 50, reconciled: 30, pending: 15, failed: 5 },
      ]);

      const stats = await service.getRefundStats();

      expect(stats.total).toBe(50);
      expect(stats.reconciled).toBe(30);
      expect(stats.pending).toBe(15);
      expect(stats.failed).toBe(5);
    });

    it('returns zero values when no refunds exist', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([undefined]);

      const stats = await service.getRefundStats();

      expect(stats.total).toBe(0);
      expect(stats.reconciled).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.failed).toBe(0);
    });

    it('returns zero values when query returns empty array', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const stats = await service.getRefundStats();

      expect(stats.total).toBe(0);
    });
  });
});
