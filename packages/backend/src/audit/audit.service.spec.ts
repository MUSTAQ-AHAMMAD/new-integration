import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { AuditStatus } from '../database/enums';
import { AuditService } from './audit.service';

function makeAuditRecord(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'audit-001',
    idempotencyKey: 'key-001',
    externalId: 'order-001',
    externalSystem: 'ODOO',
    targetSystem: 'ORACLE',
    operation: 'CREATE_INVOICE',
    status: AuditStatus.SUCCESS,
    requestPayload: {},
    responsePayload: null,
    oracleResponseId: null,
    errorMessage: null,
    errorCode: null,
    processingDurationMs: 150,
    attempts: 1,
    createdAt: new Date('2024-01-15T10:00:00Z'),
    syncDate: new Date('2024-01-15T10:00:00Z'),
    assignId: jest.fn(),
  } as unknown as AuditLog;
}

describe('AuditService', () => {
  let service: AuditService;
  let repo: {
    findOne: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let qb: {
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    take: jest.Mock;
    skip: jest.Mock;
    select: jest.Mock;
    addSelect: jest.Mock;
    groupBy: jest.Mock;
    getMany: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(() => {
    qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    repo = {
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    service = new AuditService(repo as unknown as Repository<AuditLog>);
    jest.clearAllMocks();
    repo.createQueryBuilder.mockReturnValue(qb);
  });

  // ── search ────────────────────────────────────────────────────────────────

  describe('search', () => {
    it('executes query with no conditions when params are empty', async () => {
      qb.getMany.mockResolvedValueOnce([makeAuditRecord()]);
      const result = await service.search({});
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('returns empty array when no records match', async () => {
      qb.getMany.mockResolvedValueOnce([]);
      const result = await service.search({ orderId: 'nonexistent' });
      expect(result).toHaveLength(0);
    });

    it('applies orderId filter against externalId', async () => {
      await service.search({ orderId: 'order-001' });
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('externalId'),
        expect.objectContaining({ orderId: '%order-001%' }),
      );
    });

    it('applies entityType filter against externalSystem', async () => {
      await service.search({ entityType: 'ODOO' });
      expect(qb.andWhere).toHaveBeenCalledWith('a.externalSystem = :entityType', {
        entityType: 'ODOO',
      });
    });

    it('applies action filter against operation', async () => {
      await service.search({ action: 'CREATE_INVOICE' });
      expect(qb.andWhere).toHaveBeenCalledWith('a.operation = :action', {
        action: 'CREATE_INVOICE',
      });
    });

    it('applies startDate and endDate filters', async () => {
      await service.search({ startDate: '2024-01-01', endDate: '2024-01-31' });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'a.createdAt >= :startDate',
        expect.objectContaining({ startDate: expect.any(Date) }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'a.createdAt <= :endDate',
        expect.objectContaining({ endDate: expect.any(Date) }),
      );
    });

    it('maps status "success" to AuditStatus.SUCCESS', async () => {
      await service.search({ status: 'success' });
      expect(qb.andWhere).toHaveBeenCalledWith('a.status = :status', {
        status: AuditStatus.SUCCESS,
      });
    });

    it('maps status "failed" to AuditStatus.FAILED', async () => {
      await service.search({ status: 'failed' });
      expect(qb.andWhere).toHaveBeenCalledWith('a.status = :status', {
        status: AuditStatus.FAILED,
      });
    });

    it('maps status "error" to AuditStatus.FAILED', async () => {
      await service.search({ status: 'error' });
      expect(qb.andWhere).toHaveBeenCalledWith('a.status = :status', {
        status: AuditStatus.FAILED,
      });
    });

    it('passes an exact status value through', async () => {
      await service.search({ status: 'RETRY' });
      expect(qb.andWhere).toHaveBeenCalledWith('a.status = :status', {
        status: 'RETRY',
      });
    });

    it('respects limit and offset params', async () => {
      await service.search({ limit: 10, offset: 20 });
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(qb.skip).toHaveBeenCalledWith(20);
    });

    it('defaults limit to 50 and offset to 0', async () => {
      await service.search({});
      expect(qb.take).toHaveBeenCalledWith(50);
      expect(qb.skip).toHaveBeenCalledWith(0);
    });
  });

  // ── getEntry ─────────────────────────────────────────────────────────────

  describe('getEntry', () => {
    it('returns the record when found', async () => {
      repo.findOne.mockResolvedValueOnce(makeAuditRecord());
      const record = await service.getEntry('audit-001');
      expect(record).toMatchObject({
        id: 'audit-001',
        operation: 'CREATE_INVOICE',
      });
    });

    it('throws NotFoundException when no record is found', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getEntry('missing')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.getEntry('missing')).rejects.toThrow(
        'Audit log entry missing not found',
      );
    });
  });

  // ── getStats ──────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('returns stats with byAction, byEntityType, errorRate, total, errors', async () => {
      qb.getRawMany
        .mockResolvedValueOnce([{ key: 'CREATE_INVOICE', count: 10 }]) // actions
        .mockResolvedValueOnce([{ key: 'ODOO', count: 10 }]); // entity types
      repo.count
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(2); // errors

      const stats = await service.getStats();

      expect(stats.byAction).toEqual([{ action: 'CREATE_INVOICE', count: 10 }]);
      expect(stats.byEntityType).toEqual([{ entityType: 'ODOO', count: 10 }]);
      expect(stats.total).toBe(10);
      expect(stats.errors).toBe(2);
      expect(stats.errorRate).toBeCloseTo(0.2);
    });

    it('returns 0 errorRate when total is 0', async () => {
      qb.getRawMany.mockResolvedValue([]);
      repo.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      const stats = await service.getStats();
      expect(stats.errorRate).toBe(0);
      expect(stats.total).toBe(0);
    });
  });
});
