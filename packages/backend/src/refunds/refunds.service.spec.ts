import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Decimal } from 'decimal.js';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { SyncStatus } from '../database/enums';
import { ManualCreditMemoInput, RefundsService } from './refunds.service';

function makeRefundRecord(overrides: Partial<RefundTracking> = {}): RefundTracking {
  return {
    id: 'ref-1',
    originalOrderId: 'ORD-001',
    originalOrderNumber: 'S00001',
    originalInvoiceNumber: null,
    refundOrderId: 'REF-001',
    refundOrderNumber: 'R00001',
    branchCode: 'DXB',
    refundAmount: new Decimal(100),
    refundReason: 'Customer return',
    refundDate: new Date('2024-01-15T00:00:00Z'),
    oracleCreditMemoNumber: 'CM-001',
    creditMemoStatus: SyncStatus.SYNCED,
    syncedAt: null,
    failureReason: null,
    isReconciled: false,
    reconcileNote: null,
    reconciledAt: null,
    reconciledBy: null,
    createdAt: new Date('2024-01-15T00:00:00Z'),
    updatedAt: new Date('2024-01-15T00:00:00Z'),
    assignId: jest.fn(),
    ...overrides,
  } as RefundTracking;
}

describe('RefundsService', () => {
  let service: RefundsService;
  let repo: jest.Mocked<Pick<Repository<RefundTracking>, 'findOne' | 'create' | 'save' | 'count' | 'createQueryBuilder'>>;
  let qb: {
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    take: jest.Mock;
    getMany: jest.Mock;
  };

  beforeEach(() => {
    qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    repo = {
      findOne: jest.fn(),
      create: jest.fn((x) => x as RefundTracking),
      save: jest.fn((x) => Promise.resolve(x as RefundTracking)),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as never;
    service = new RefundsService(repo as unknown as Repository<RefundTracking>);
  });

  describe('listRefunds', () => {
    it('returns refunds from the query builder', async () => {
      qb.getMany.mockResolvedValue([makeRefundRecord(), makeRefundRecord({ id: 'ref-2' })]);
      const result = await service.listRefunds();
      expect(result).toHaveLength(2);
    });

    it('applies status/month/year filters and default limit', async () => {
      await service.listRefunds({ status: 'synced', month: 3, year: 2024 });
      expect(qb.andWhere).toHaveBeenCalledWith('r.creditMemoStatus = :status', { status: 'SYNCED' });
      expect(qb.andWhere).toHaveBeenCalledWith('EXTRACT(MONTH FROM r.refundDate) = :month', { month: 3 });
      expect(qb.andWhere).toHaveBeenCalledWith('EXTRACT(YEAR FROM r.refundDate) = :year', { year: 2024 });
      expect(qb.take).toHaveBeenCalledWith(50);
    });

    it('uses the custom limit', async () => {
      await service.listRefunds({ limit: 10 });
      expect(qb.take).toHaveBeenCalledWith(10);
    });
  });

  describe('getRefund', () => {
    it('returns the refund when found', async () => {
      repo.findOne.mockResolvedValue(makeRefundRecord());
      const result = await service.getRefund('ref-1');
      expect(result.id).toBe('ref-1');
    });

    it('throws NotFoundException with the id when missing', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getRefund('ref-999')).rejects.toThrow(NotFoundException);
      await expect(service.getRefund('ref-999')).rejects.toThrow('ref-999');
    });
  });

  describe('reconcileRefund', () => {
    it('marks the refund reconciled with a note', async () => {
      repo.findOne.mockResolvedValue(makeRefundRecord());
      const result = await service.reconcileRefund('ref-1', 'Verified by finance');
      expect(result.isReconciled).toBe(true);
      expect(result.reconcileNote).toBe('Verified by finance');
      expect(result.reconciledAt).toBeInstanceOf(Date);
      expect(repo.save).toHaveBeenCalled();
    });

    it('throws NotFoundException when the refund does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.reconcileRefund('missing', 'note')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createManualCreditMemo', () => {
    const input: ManualCreditMemoInput = {
      originalOrderId: 'ORD-001',
      originalOrderNumber: 'S00001',
      refundOrderId: 'REF-MANUAL-001',
      refundOrderNumber: 'R-MANUAL-001',
      refundAmount: 200,
      refundReason: 'Manual adjustment',
      refundDate: new Date('2024-02-01T00:00:00Z'),
    };

    it('creates a PENDING refund record with a Decimal amount', async () => {
      await service.createManualCreditMemo(input);
      const created = repo.create.mock.calls[0][0] as Partial<RefundTracking>;
      expect(created.refundAmount).toBeInstanceOf(Decimal);
      expect((created.refundAmount as Decimal).toNumber()).toBe(200);
      expect(created.creditMemoStatus).toBe(SyncStatus.PENDING);
      expect(created.refundOrderId).toBe('REF-MANUAL-001');
      expect(repo.save).toHaveBeenCalled();
    });
  });

  describe('getRefundStats', () => {
    it('aggregates counts by status and reconciliation', async () => {
      repo.count
        .mockResolvedValueOnce(50) // total
        .mockResolvedValueOnce(30) // reconciled
        .mockResolvedValueOnce(15) // pending
        .mockResolvedValueOnce(5); // failed
      const stats = await service.getRefundStats();
      expect(stats).toEqual({ total: 50, reconciled: 30, pending: 15, failed: 5 });
    });

    it('returns zeros when there are no refunds', async () => {
      repo.count.mockResolvedValue(0);
      const stats = await service.getRefundStats();
      expect(stats).toEqual({ total: 0, reconciled: 0, pending: 0, failed: 0 });
    });
  });
});
