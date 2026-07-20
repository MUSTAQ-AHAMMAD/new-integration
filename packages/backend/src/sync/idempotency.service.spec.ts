import { Repository } from 'typeorm';
import { IdempotencyService } from './idempotency.service';
import { AuditLog } from '../database/entities/audit-log.entity';
import { AuditOperation, AuditStatus } from '../database/enums';

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let repo: jest.Mocked<
    Pick<Repository<AuditLog>, 'findOne' | 'create' | 'save'>
  >;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      create: jest.fn((x) => x as AuditLog),
      save: jest.fn((x) => Promise.resolve(x as AuditLog)),
    } as never;
    service = new IdempotencyService(repo as unknown as Repository<AuditLog>);
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
      repo.findOne.mockResolvedValueOnce({
        status: AuditStatus.SUCCESS,
      } as AuditLog);
      const result = await service.isDuplicate('some-key');
      expect(result).toBe(true);
    });

    it('returns true when an existing DUPLICATE record is found', async () => {
      repo.findOne.mockResolvedValueOnce({
        status: AuditStatus.DUPLICATE,
      } as AuditLog);
      const result = await service.isDuplicate('some-key');
      expect(result).toBe(true);
    });

    it('returns false when no record exists', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      const result = await service.isDuplicate('some-key');
      expect(result).toBe(false);
    });

    it('returns false for a FAILED record', async () => {
      repo.findOne.mockResolvedValueOnce({
        status: AuditStatus.FAILED,
      } as AuditLog);
      const result = await service.isDuplicate('some-key');
      expect(result).toBe(false);
    });
  });

  describe('recordOperation', () => {
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

    it('creates a new audit log when none exists', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await service.recordOperation(params);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: 'test-key',
          status: AuditStatus.SUCCESS,
        }),
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('increments attempts and updates status on an existing record', async () => {
      repo.findOne.mockResolvedValueOnce({
        idempotencyKey: 'test-key',
        status: AuditStatus.FAILED,
        attempts: 2,
      } as AuditLog);
      await service.recordOperation({ ...params, status: AuditStatus.RETRY });
      const saved = repo.save.mock.calls[0][0] as AuditLog;
      expect(saved.attempts).toBe(3);
      expect(saved.status).toBe(AuditStatus.RETRY);
    });
  });
});
