import { IdempotencyService } from './idempotency.service';
import { AuditOperation, AuditStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  auditLog: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
};

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService(mockPrisma as unknown as PrismaService);
    jest.clearAllMocks();
  });

  describe('generateKey', () => {
    it('produces a 64-char hex string (SHA-256)', () => {
      const key = service.generateKey(
        'order-1',
        AuditOperation.CREATE_INVOICE,
        'BR001',
      );
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[0-9a-f]+$/);
    });

    it('produces the same key for the same inputs', () => {
      const key1 = service.generateKey(
        'order-1',
        AuditOperation.CREATE_INVOICE,
        'BR001',
      );
      const key2 = service.generateKey(
        'order-1',
        AuditOperation.CREATE_INVOICE,
        'BR001',
      );
      expect(key1).toBe(key2);
    });

    it('produces different keys for different operations', () => {
      const key1 = service.generateKey(
        'order-1',
        AuditOperation.CREATE_INVOICE,
        'BR001',
      );
      const key2 = service.generateKey(
        'order-1',
        AuditOperation.CREATE_CREDIT_MEMO,
        'BR001',
      );
      expect(key1).not.toBe(key2);
    });
  });

  describe('isDuplicate', () => {
    it('returns true when an existing SUCCESS record is found', async () => {
      mockPrisma.auditLog.findUnique.mockResolvedValueOnce({
        status: AuditStatus.SUCCESS,
      });
      const result = await service.isDuplicate('some-key');
      expect(result).toBe(true);
    });

    it('returns true when an existing DUPLICATE record is found', async () => {
      mockPrisma.auditLog.findUnique.mockResolvedValueOnce({
        status: AuditStatus.DUPLICATE,
      });
      const result = await service.isDuplicate('some-key');
      expect(result).toBe(true);
    });

    it('returns false when no record exists', async () => {
      mockPrisma.auditLog.findUnique.mockResolvedValueOnce(null);
      const result = await service.isDuplicate('some-key');
      expect(result).toBe(false);
    });

    it('returns false for a FAILED record', async () => {
      mockPrisma.auditLog.findUnique.mockResolvedValueOnce({
        status: AuditStatus.FAILED,
      });
      const result = await service.isDuplicate('some-key');
      expect(result).toBe(false);
    });
  });

  describe('recordOperation', () => {
    it('calls prisma upsert with correct parameters', async () => {
      mockPrisma.auditLog.upsert.mockResolvedValueOnce({ id: 'log-1' });
      const params = {
        idempotencyKey: 'test-key',
        externalId: 'order-1',
        externalSystem: 'ODOO',
        targetSystem: 'ORACLE',
        operation: AuditOperation.CREATE_INVOICE,
        status: AuditStatus.SUCCESS,
        requestPayload: { test: true },
        processingDurationMs: 100,
      };
      await service.recordOperation(params);
      expect(mockPrisma.auditLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { idempotencyKey: 'test-key' },
        }),
      );
    });
  });
});
