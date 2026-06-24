// Mock Bull decorators before any NestJS/Bull imports are evaluated
jest.mock('../queues.module', () => ({
  QUEUE_NAMES: {
    ORDER_SYNC: 'order-sync',
    INVENTORY_SYNC: 'inventory-sync',
    RETRY: 'retry',
    NOTIFICATIONS: 'notifications',
  },
  QueuesModule: class QueuesModule {},
}));

import { AuditStatus, ErrorType, SyncStatus } from '@prisma/client';
import { Job } from 'bull';
import { AlertsService } from '../../alerts/alerts.service';
import { OracleSoapClient } from '../../clients/oracle/oracle-soap.client';
import { GatewayService } from '../../gateway/gateway.service';
import { PaymentMappingService } from '../../payment-mapping/payment-mapping.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreConfigService } from '../../store-config/store-config.service';
import { FusionTransformationService } from '../../sync/fusion-transformation.service';
import { IdempotencyService } from '../../sync/idempotency.service';
import { ValidationService } from '../../sync/validation.service';
import { OrderSyncProcessor } from './order-sync.processor';
import { QueuesService } from '../queues.service';

/** Shared order record returned by prisma mock */
const BASE_ORDER = {
  id: 'q-001',
  odooOrderId: 'ORD-001',
  odooOrderNumber: 'S00001',
  branchCode: 'DXB',
  branchName: 'Dubai Store',
  isPaid: true,
  isCancelled: false,
  isRefund: false,
  negativeInventoryFlag: false,
  negativeInventoryItems: null,
  totalAmount: { toNumber: () => 150 },
  validationErrors: null,
};

function makeJob(overrides: Record<string, unknown> = {}): Job {
  return {
    data: {
      odooOrderId: 'ORD-001',
      branchCode: 'DXB',
      orderSyncQueueId: 'q-001',
      ...overrides,
    },
  } as unknown as Job;
}

describe('OrderSyncProcessor — payment mapping handling', () => {
  let processor: OrderSyncProcessor;

  // Mock every dependency
  let mockPrisma: jest.Mocked<Partial<PrismaService>>;
  let mockGateway: jest.Mocked<Partial<GatewayService>>;
  let mockValidation: jest.Mocked<Partial<ValidationService>>;
  let mockIdempotency: jest.Mocked<Partial<IdempotencyService>>;
  let mockStoreConfig: jest.Mocked<Partial<StoreConfigService>>;
  let mockPaymentMapping: jest.Mocked<Partial<PaymentMappingService>>;
  let mockAlerts: jest.Mocked<Partial<AlertsService>>;
  let mockQueues: jest.Mocked<Partial<QueuesService>>;
  let mockSoapClient: jest.Mocked<Partial<OracleSoapClient>>;
  let mockTransformation: jest.Mocked<Partial<FusionTransformationService>>;

  beforeEach(() => {
    mockPrisma = {
      orderSyncQueue: {
        findUnique: jest.fn().mockResolvedValue(BASE_ORDER),
        update: jest.fn().mockResolvedValue({ ...BASE_ORDER }),
      } as unknown as PrismaService['orderSyncQueue'],
      failedTransaction: {
        create: jest.fn().mockResolvedValue({}),
      } as unknown as PrismaService['failedTransaction'],
      fusionInvoiceHeader: {
        create: jest.fn().mockResolvedValue({ id: 'hdr-1' }),
      } as unknown as PrismaService['fusionInvoiceHeader'],
      fusionInvoiceLine: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      } as unknown as PrismaService['fusionInvoiceLine'],
      fusionStandardReceipt: {
        create: jest.fn().mockResolvedValue({}),
      } as unknown as PrismaService['fusionStandardReceipt'],
      fusionMiscReceipt: {
        create: jest.fn().mockResolvedValue({}),
      } as unknown as PrismaService['fusionMiscReceipt'],
      fusionApplyReceipt: {
        create: jest.fn().mockResolvedValue({}),
      } as unknown as PrismaService['fusionApplyReceipt'],
      fusionJournalHeader: {
        create: jest.fn().mockResolvedValue({ id: 'jh-1' }),
      } as unknown as PrismaService['fusionJournalHeader'],
      fusionJournalLine: {
        create: jest.fn().mockResolvedValue({}),
      } as unknown as PrismaService['fusionJournalLine'],
      syncJob: {
        update: jest.fn().mockResolvedValue({
          id: 'sj-1',
          processedRecords: 1,
          totalRecords: 1,
          failedCount: 0,
          skippedCount: 0,
          successCount: 1,
        }),
      } as unknown as PrismaService['syncJob'],
      backupVendHqSale: {
        findFirst: jest.fn().mockResolvedValue({ id: 'sale-001', region: 'AE' }),
      } as unknown as PrismaService['backupVendHqSale'],
    };

    mockGateway = {
      emitOrderStatus: jest.fn(),
      emitSyncJobUpdate: jest.fn(),
      emitAlert: jest.fn(),
    };

    mockValidation = {
      validateOrder: jest.fn().mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: [],
        holdForNegativeInventory: false,
      }),
    };

    mockIdempotency = {
      generateKey: jest.fn().mockReturnValue('idem-key-001'),
      isDuplicate: jest.fn().mockResolvedValue(false),
      recordOperation: jest.fn().mockResolvedValue({}),
    };

    mockStoreConfig = {
      getValidatedConfig: jest.fn().mockResolvedValue({ branchCode: 'DXB' }),
    };

    mockPaymentMapping = {
      resolvePaymentMethod: jest.fn().mockResolvedValue({
        id: 'pm-1',
        isActive: true,
      }),
    };

    mockAlerts = {
      createAlert: jest.fn().mockResolvedValue({}),
    };

    mockQueues = {
      enqueueNotification: jest.fn().mockResolvedValue({}),
    };

    mockSoapClient = {
      createSimpleInvoice: jest.fn().mockResolvedValue({
        customerTrxId: 'TRX-001',
        serviceStatus: 'SUCCESS',
      }),
      createStandardReceipt: jest
        .fn()
        .mockResolvedValue({ receiptNumber: 'SR-001' }),
      createMiscellaneousReceipt: jest
        .fn()
        .mockResolvedValue({ receiptNumber: 'MR-001' }),
      createApplyReceipt: jest.fn().mockResolvedValue({}),
      importJournalEntry: jest.fn().mockResolvedValue('JE-001'),
    };

    mockTransformation = {
      buildSalePayloads: jest.fn().mockResolvedValue({
        invoiceHeader: {
          billToCustomerName: 'Test',
          billToLocation: 'L1',
          billToAccountNumber: '12345',
          businessUnit: 'BU1',
          transactionSource: 'SRC',
          transactionType: 'TYPE',
          saleDate: new Date(),
          invoiceCurrencyCode: 'AED',
          conversionRateType: 'User',
          invoiceLines: [],
        },
        standardReceipts: [],
        miscReceipts: [],
        applyReceipts: [],
        journalHeaders: [],
      }),
    };

    processor = new OrderSyncProcessor(
      mockPrisma as unknown as PrismaService,
      mockGateway as unknown as GatewayService,
      mockValidation as unknown as ValidationService,
      mockIdempotency as unknown as IdempotencyService,
      mockStoreConfig as unknown as StoreConfigService,
      mockPaymentMapping as unknown as PaymentMappingService,
      mockAlerts as unknown as AlertsService,
      mockQueues as unknown as QueuesService,
      mockSoapClient as unknown as OracleSoapClient,
      mockTransformation as unknown as FusionTransformationService,
      {} as unknown as import('../../sync/odoo-transformation.service').OdooTransformationService,
    );

    jest.clearAllMocks();
    // Re-apply default mocks after clearAllMocks
    (mockPrisma.orderSyncQueue!.findUnique as jest.Mock).mockResolvedValue(
      BASE_ORDER,
    );
    (mockPrisma.orderSyncQueue!.update as jest.Mock).mockResolvedValue({
      ...BASE_ORDER,
      status: SyncStatus.SYNCED,
    });
    (mockPrisma.failedTransaction!.create as jest.Mock).mockResolvedValue({});
    (mockPrisma.backupVendHqSale!.findFirst as jest.Mock).mockResolvedValue(
      { id: 'sale-001', region: 'AE' },
    );
    (mockPrisma.fusionInvoiceHeader!.create as jest.Mock).mockResolvedValue({
      id: 'hdr-1',
    });
    (mockPrisma.syncJob!.update as jest.Mock).mockResolvedValue({
      id: 'sj-1',
      processedRecords: 1,
      totalRecords: 1,
      failedCount: 0,
      skippedCount: 0,
      successCount: 1,
    });
    (mockValidation.validateOrder as jest.Mock).mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: [],
      holdForNegativeInventory: false,
    });
    (mockIdempotency.generateKey as jest.Mock).mockReturnValue('idem-key-001');
    (mockIdempotency.isDuplicate as jest.Mock).mockResolvedValue(false);
    (mockIdempotency.recordOperation as jest.Mock).mockResolvedValue({});
    (mockStoreConfig.getValidatedConfig as jest.Mock).mockResolvedValue({
      branchCode: 'DXB',
    });
    (mockPaymentMapping.resolvePaymentMethod as jest.Mock).mockResolvedValue({
      id: 'pm-1',
      isActive: true,
    });
    (mockAlerts.createAlert as jest.Mock).mockResolvedValue({});
    (mockQueues.enqueueNotification as jest.Mock).mockResolvedValue({});
    (mockGateway.emitOrderStatus as jest.Mock).mockReturnValue(undefined);
    (mockGateway.emitSyncJobUpdate as jest.Mock).mockReturnValue(undefined);
  });

  describe('payment method null handling', () => {
    it('continues processing when resolvePaymentMethod returns null', async () => {
      (mockPaymentMapping.resolvePaymentMethod as jest.Mock).mockResolvedValue(
        null,
      );

      await processor.handleOrderSync(makeJob());

      // Order should be marked SYNCED, not FAILED
      const updateCall = (
        mockPrisma.orderSyncQueue!.update as jest.Mock
      ).mock.calls.find(
        (c: unknown[]) =>
          (c[0] as { data: { status: SyncStatus } }).data?.status ===
          SyncStatus.SYNCED,
      );
      expect(updateCall).toBeDefined();
    });

    it('does not mark the order as FAILED when payment method is unmapped', async () => {
      (mockPaymentMapping.resolvePaymentMethod as jest.Mock).mockResolvedValue(
        null,
      );

      await processor.handleOrderSync(makeJob());

      const updateCalls = (mockPrisma.orderSyncQueue!.update as jest.Mock).mock
        .calls as Array<[{ data: { status?: SyncStatus } }]>;
      const failedUpdate = updateCalls.find(
        (c) => c[0].data?.status === SyncStatus.FAILED,
      );
      expect(failedUpdate).toBeUndefined();
    });

    it('records a fallback warning in the audit log when payment method is unmapped', async () => {
      (mockPaymentMapping.resolvePaymentMethod as jest.Mock).mockResolvedValue(
        null,
      );

      await processor.handleOrderSync(makeJob());

      expect(mockIdempotency.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          responsePayload: expect.objectContaining({
            paymentFallback: expect.stringContaining('no Oracle mapping'),
          }),
        }),
      );
    });
  });

  describe('store config error isolation', () => {
    it('marks the order as FAILED with CONFIGURATION_ERROR when store config is invalid', async () => {
      (mockStoreConfig.getValidatedConfig as jest.Mock).mockRejectedValue(
        new Error('Store DXB has invalid configuration'),
      );

      await processor.handleOrderSync(makeJob());

      expect(mockPrisma.failedTransaction!.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            errorType: ErrorType.CONFIGURATION_ERROR,
          }),
        }),
      );
    });

    it('fires a STORE_CONFIG_INVALID alert when store config fails', async () => {
      (mockStoreConfig.getValidatedConfig as jest.Mock).mockRejectedValue(
        new Error('Store DXB has invalid configuration'),
      );

      await processor.handleOrderSync(makeJob());

      expect(mockAlerts.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({ alertType: 'STORE_CONFIG_INVALID' }),
      );
    });

    it('does NOT throw when store config fails (other orders can continue)', async () => {
      (mockStoreConfig.getValidatedConfig as jest.Mock).mockRejectedValue(
        new Error('Config error'),
      );

      // Must resolve without throwing
      await expect(
        processor.handleOrderSync(makeJob()),
      ).resolves.toBeUndefined();
    });
  });

  describe('NEGATIVE_INVENTORY_HOLD handling', () => {
    it('sets status to NEGATIVE_INVENTORY_HOLD when holdForNegativeInventory is true', async () => {
      (mockValidation.validateOrder as jest.Mock).mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: [],
        holdForNegativeInventory: true,
      });

      await processor.handleOrderSync(makeJob());

      expect(mockPrisma.orderSyncQueue!.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
          }),
        }),
      );
    });

    it('does NOT call Oracle when order is held for negative inventory', async () => {
      (mockValidation.validateOrder as jest.Mock).mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: [],
        holdForNegativeInventory: true,
      });

      await processor.handleOrderSync(makeJob());

      expect(mockSoapClient.createSimpleInvoice).not.toHaveBeenCalled();
    });

    it('uses SKIPPED outcome in SyncJob counters for a held order', async () => {
      (mockValidation.validateOrder as jest.Mock).mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: [],
        holdForNegativeInventory: true,
      });

      await processor.handleOrderSync(makeJob({ syncJobId: 'sj-1' }));

      expect(mockPrisma.syncJob!.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            skippedCount: { increment: 1 },
          }),
        }),
      );
    });
  });

  describe('duplicate detection', () => {
    it('skips Oracle call and marks SYNCED when order is already a duplicate', async () => {
      (mockIdempotency.isDuplicate as jest.Mock).mockResolvedValue(true);

      await processor.handleOrderSync(makeJob());

      expect(mockSoapClient.createSimpleInvoice).not.toHaveBeenCalled();
      expect(mockPrisma.orderSyncQueue!.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: SyncStatus.SYNCED }),
        }),
      );
    });

    it('records DUPLICATE status in the audit log', async () => {
      (mockIdempotency.isDuplicate as jest.Mock).mockResolvedValue(true);

      await processor.handleOrderSync(makeJob());

      expect(mockIdempotency.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({ status: AuditStatus.DUPLICATE }),
      );
    });
  });

  describe('no backup source (Path C)', () => {
    beforeEach(() => {
      // No odooBackupOrderId and no VendHQ sale → Path C
      (mockPrisma.orderSyncQueue!.findUnique as jest.Mock).mockResolvedValue({
        ...BASE_ORDER,
        odooBackupOrderId: null,
      });
      (mockPrisma.backupVendHqSale!.findFirst as jest.Mock).mockResolvedValue(null);
    });

    it('marks the order as FAILED when no backup data exists', async () => {
      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow(
        'No backup data found',
      );

      const updateCalls = (mockPrisma.orderSyncQueue!.update as jest.Mock).mock
        .calls as Array<[{ data: { status?: SyncStatus } }]>;
      const failedUpdate = updateCalls.find(
        (c) => c[0].data?.status === SyncStatus.FAILED,
      );
      expect(failedUpdate).toBeDefined();
    });

    it('does NOT mark the order as SYNCED when no backup data exists', async () => {
      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow();

      const updateCalls = (mockPrisma.orderSyncQueue!.update as jest.Mock).mock
        .calls as Array<[{ data: { status?: SyncStatus } }]>;
      const syncedUpdate = updateCalls.find(
        (c) => c[0].data?.status === SyncStatus.SYNCED,
      );
      expect(syncedUpdate).toBeUndefined();
    });

    it('does NOT call Oracle when no backup data exists', async () => {
      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow();

      expect(mockSoapClient.createSimpleInvoice).not.toHaveBeenCalled();
    });

    it('creates a FailedTransaction record when no backup data exists', async () => {
      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow();

      expect(mockPrisma.failedTransaction!.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            errorMessage: expect.stringContaining('No backup data found'),
          }),
        }),
      );
    });

    it('does NOT record an idempotency SUCCESS when no backup data exists', async () => {
      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow();

      const calls = (mockIdempotency.recordOperation as jest.Mock).mock.calls as Array<
        [{ status: AuditStatus }]
      >;
      const successCall = calls.find((c) => c[0].status === AuditStatus.SUCCESS);
      expect(successCall).toBeUndefined();
    });
  });
});
