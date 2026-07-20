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

import { Repository } from 'typeorm';
import { Decimal } from 'decimal.js';
import { AuditStatus, ErrorType, SyncStatus } from '../../database/enums';
import { Job } from 'bull';
import { AlertsService } from '../../alerts/alerts.service';
import { OracleSoapClient } from '../../clients/oracle/oracle-soap.client';
import { GatewayService } from '../../gateway/gateway.service';
import { PaymentMappingService } from '../../payment-mapping/payment-mapping.service';
import { StoreConfigService } from '../../store-config/store-config.service';
import { FusionTransformationService } from '../../sync/fusion-transformation.service';
import { IdempotencyService } from '../../sync/idempotency.service';
import { ValidationService } from '../../sync/validation.service';
import { OrderSyncQueue } from '../../database/entities/order-sync-queue.entity';
import { FailedTransaction } from '../../database/entities/failed-transaction.entity';
import { FusionInvoiceHeader } from '../../database/entities/fusion-invoice-header.entity';
import { FusionInvoiceLine } from '../../database/entities/fusion-invoice-line.entity';
import { FusionInvTxn } from '../../database/entities/fusion-inv-txn.entity';
import { FusionStandardReceipt } from '../../database/entities/fusion-standard-receipt.entity';
import { FusionMiscReceipt } from '../../database/entities/fusion-misc-receipt.entity';
import { FusionApplyReceipt } from '../../database/entities/fusion-apply-receipt.entity';
import { FusionJournalHeader } from '../../database/entities/fusion-journal-header.entity';
import { FusionJournalLine } from '../../database/entities/fusion-journal-line.entity';
import { SyncJob } from '../../database/entities/sync-job.entity';
import { RefundTracking } from '../../database/entities/refund-tracking.entity';
import { BackupOdooOrder } from '../../database/entities/backup-odoo-order.entity';
import { OrderSyncProcessor } from './order-sync.processor';
import { QueuesService } from '../queues.service';

/** Shared order record returned by the OrderSyncQueue repo mock */
const BASE_ORDER = {
  id: 'q-001',
  odooOrderId: 'ORD-001',
  odooOrderNumber: 'S00001',
  branchCode: 'DXB',
  branchName: 'Dubai Store',
  orderDate: new Date('2024-06-15T10:00:00Z'),
  currency: 'AED',
  isPaid: true,
  isCancelled: false,
  isRefund: false,
  negativeInventoryFlag: false,
  negativeInventoryItems: null,
  totalAmount: new Decimal(150),
  validationErrors: null,
};

/**
 * Builds a jest-mocked TypeORM repository. `create` returns its input (so
 * assertions can inspect the built entity) and `save`/`update`/`increment`
 * resolve to benign defaults.
 */
function makeRepoMock<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    create: jest.fn((x) => x),
    save: jest.fn((x) => Promise.resolve(x)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<Repository<T>>;
}

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

  // Repository mocks
  let orders: jest.Mocked<Repository<OrderSyncQueue>>;
  let failedTransactions: jest.Mocked<Repository<FailedTransaction>>;
  let invoiceHeaders: jest.Mocked<Repository<FusionInvoiceHeader>>;
  let invoiceLines: jest.Mocked<Repository<FusionInvoiceLine>>;
  let invTxns: jest.Mocked<Repository<FusionInvTxn>>;
  let standardReceipts: jest.Mocked<Repository<FusionStandardReceipt>>;
  let miscReceipts: jest.Mocked<Repository<FusionMiscReceipt>>;
  let applyReceipts: jest.Mocked<Repository<FusionApplyReceipt>>;
  let journalHeaders: jest.Mocked<Repository<FusionJournalHeader>>;
  let journalLines: jest.Mocked<Repository<FusionJournalLine>>;
  let syncJobs: jest.Mocked<Repository<SyncJob>>;
  let refundTracking: jest.Mocked<Repository<RefundTracking>>;
  let backupOdooOrders: jest.Mocked<Repository<BackupOdooOrder>>;

  // Service mocks
  let mockGateway: jest.Mocked<Partial<GatewayService>>;
  let mockValidation: jest.Mocked<Partial<ValidationService>>;
  let mockIdempotency: jest.Mocked<Partial<IdempotencyService>>;
  let mockStoreConfig: jest.Mocked<Partial<StoreConfigService>>;
  let mockPaymentMapping: jest.Mocked<Partial<PaymentMappingService>>;
  let mockAlerts: jest.Mocked<Partial<AlertsService>>;
  let mockQueues: jest.Mocked<Partial<QueuesService>>;
  let mockSoapClient: jest.Mocked<Partial<OracleSoapClient>>;
  let mockOracleClient: { itemExists: jest.Mock };
  let mockTransformation: jest.Mocked<Partial<FusionTransformationService>>;
  let mockEnrichment: { enrichOrder: jest.Mock };

  beforeEach(() => {
    orders = makeRepoMock<OrderSyncQueue>();
    failedTransactions = makeRepoMock<FailedTransaction>();
    invoiceHeaders = makeRepoMock<FusionInvoiceHeader>();
    invoiceLines = makeRepoMock<FusionInvoiceLine>();
    invTxns = makeRepoMock<FusionInvTxn>();
    standardReceipts = makeRepoMock<FusionStandardReceipt>();
    miscReceipts = makeRepoMock<FusionMiscReceipt>();
    applyReceipts = makeRepoMock<FusionApplyReceipt>();
    journalHeaders = makeRepoMock<FusionJournalHeader>();
    journalLines = makeRepoMock<FusionJournalLine>();
    syncJobs = makeRepoMock<SyncJob>();
    refundTracking = makeRepoMock<RefundTracking>();
    backupOdooOrders = makeRepoMock<BackupOdooOrder>();

    // Order lookup returns the base order; audit headers get an id on save.
    orders.findOne.mockResolvedValue(BASE_ORDER as unknown as OrderSyncQueue);
    invoiceHeaders.save.mockImplementation((e) =>
      Promise.resolve({ id: 'hdr-1', ...(e as object) } as never),
    );
    journalHeaders.save.mockImplementation((e) =>
      Promise.resolve({ id: 'jh-1', ...(e as object) } as never),
    );
    // Default: no Odoo backup row → processor uses the enrichment fallback.
    backupOdooOrders.findOne.mockResolvedValue(null);
    // SyncJob re-read after increments: job is complete + successful.
    syncJobs.findOne.mockResolvedValue({
      id: 'sj-1',
      processedRecords: 1,
      totalRecords: 1,
      failedCount: 0,
      skippedCount: 0,
      successCount: 1,
    } as unknown as SyncJob);

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

    // Default: every item exists in Oracle, so orders proceed to invoicing.
    mockOracleClient = {
      itemExists: jest.fn().mockResolvedValue(true),
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
    } as unknown as jest.Mocked<Partial<FusionTransformationService>>;

    mockEnrichment = {
      enrichOrder: jest.fn().mockResolvedValue({
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
          invoiceLines: [
            {
              lineNumber: 1,
              itemNumber: 'ITEM-001',
              description: 'Test Product',
              quantity: 1,
              unitSellingPrice: 100,
              currencyCode: 'AED',
            },
          ],
        },
        standardReceipts: [],
        miscReceipts: [],
        applyReceipts: [],
        journalHeaders: [],
      }),
    };

    processor = new OrderSyncProcessor(
      orders,
      failedTransactions,
      invoiceHeaders,
      invoiceLines,
      invTxns,
      standardReceipts,
      miscReceipts,
      applyReceipts,
      journalHeaders,
      journalLines,
      syncJobs,
      refundTracking,
      backupOdooOrders,
      mockGateway as unknown as GatewayService,
      mockValidation as unknown as ValidationService,
      mockIdempotency as unknown as IdempotencyService,
      mockStoreConfig as unknown as StoreConfigService,
      mockPaymentMapping as unknown as PaymentMappingService,
      mockAlerts as unknown as AlertsService,
      mockQueues as unknown as QueuesService,
      mockSoapClient as unknown as OracleSoapClient,
      mockOracleClient as unknown as import('../../clients/oracle/oracle.client').OracleClient,
      mockTransformation as unknown as FusionTransformationService,
      {} as unknown as import('../../sync/odoo-transformation.service').OdooTransformationService,
      mockEnrichment as unknown as import('../../sync/order-enrichment.service').OrderEnrichmentService,
    );
  });

  describe('payment method null handling', () => {
    it('continues processing when resolvePaymentMethod returns null', async () => {
      (mockPaymentMapping.resolvePaymentMethod as jest.Mock).mockResolvedValue(
        null,
      );

      await processor.handleOrderSync(makeJob());

      // Order should be marked SYNCED, not FAILED
      const updateCall = (orders.update as jest.Mock).mock.calls.find(
        (c: unknown[]) =>
          (c[1] as { status?: SyncStatus }).status === SyncStatus.SYNCED,
      );
      expect(updateCall).toBeDefined();
    });

    it('does not mark the order as FAILED when payment method is unmapped', async () => {
      (mockPaymentMapping.resolvePaymentMethod as jest.Mock).mockResolvedValue(
        null,
      );

      await processor.handleOrderSync(makeJob());

      const updateCalls = (orders.update as jest.Mock).mock.calls as Array<
        [unknown, { status?: SyncStatus }]
      >;
      const failedUpdate = updateCalls.find(
        (c) => c[1]?.status === SyncStatus.FAILED,
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

      expect(failedTransactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: ErrorType.CONFIGURATION_ERROR,
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

      expect(orders.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: SyncStatus.NEGATIVE_INVENTORY_HOLD,
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

      expect(syncJobs.increment).toHaveBeenCalledWith(
        { id: 'sj-1' },
        'skippedCount',
        1,
      );
    });
  });

  describe('duplicate detection', () => {
    it('skips Oracle call and marks SYNCED when order is already a duplicate', async () => {
      (mockIdempotency.isDuplicate as jest.Mock).mockResolvedValue(true);

      await processor.handleOrderSync(makeJob());

      expect(mockSoapClient.createSimpleInvoice).not.toHaveBeenCalled();
      expect(orders.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: SyncStatus.SYNCED }),
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

  describe('enrichment failure handling', () => {
    // The enrichment service owns backup resolution and only throws for
    // orders it genuinely cannot process (e.g. the OrderSyncQueue row was
    // deleted). The processor must surface that failure safely: mark the
    // order FAILED, avoid Oracle calls, and never record a SUCCESS.
    beforeEach(() => {
      mockEnrichment.enrichOrder.mockRejectedValue(
        new Error('Order not found: q-001'),
      );
    });

    it('marks the order as FAILED when enrichment fails', async () => {
      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow(
        'Order not found',
      );

      const updateCalls = (orders.update as jest.Mock).mock.calls as Array<
        [unknown, { status?: SyncStatus }]
      >;
      const failedUpdate = updateCalls.find(
        (c) => c[1]?.status === SyncStatus.FAILED,
      );
      expect(failedUpdate).toBeDefined();
    });

    it('does NOT mark the order as SYNCED when enrichment fails', async () => {
      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow();

      const updateCalls = (orders.update as jest.Mock).mock.calls as Array<
        [unknown, { status?: SyncStatus }]
      >;
      const syncedUpdate = updateCalls.find(
        (c) => c[1]?.status === SyncStatus.SYNCED,
      );
      expect(syncedUpdate).toBeUndefined();
    });

    it('does NOT call Oracle when enrichment fails', async () => {
      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow();

      expect(mockSoapClient.createSimpleInvoice).not.toHaveBeenCalled();
    });

    it('creates a FailedTransaction record when enrichment fails', async () => {
      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow();

      expect(failedTransactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: expect.stringContaining('Order not found'),
        }),
      );
    });

    it('does NOT record an idempotency SUCCESS when enrichment fails', async () => {
      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow();

      const calls = (mockIdempotency.recordOperation as jest.Mock).mock
        .calls as Array<[{ status: AuditStatus }]>;
      const successCall = calls.find(
        (c) => c[0].status === AuditStatus.SUCCESS,
      );
      expect(successCall).toBeUndefined();
    });
  });

  describe('transient circuit-breaker handling', () => {
    // When the Oracle circuit breaker is OPEN, createSimpleInvoice rejects
    // before reaching Oracle. This is a transient condition and must not be
    // treated as a permanent failure.
    const CIRCUIT_ERROR =
      'Oracle invoice creation failed: Circuit oracle:createSimpleInvoice is open and recovering';

    beforeEach(() => {
      (mockSoapClient.createSimpleInvoice as jest.Mock).mockRejectedValue(
        new Error(CIRCUIT_ERROR),
      );
    });

    it('returns the order to PENDING instead of FAILED', async () => {
      await processor.handleOrderSync(makeJob());

      const updateCalls = (orders.update as jest.Mock).mock.calls as Array<
        [unknown, { status?: SyncStatus }]
      >;
      expect(
        updateCalls.find((c) => c[1]?.status === SyncStatus.PENDING),
      ).toBeDefined();
      expect(
        updateCalls.find((c) => c[1]?.status === SyncStatus.FAILED),
      ).toBeUndefined();
    });

    it('does NOT create a FailedTransaction for a transient circuit error', async () => {
      await processor.handleOrderSync(makeJob());

      expect(failedTransactions.save).not.toHaveBeenCalled();
    });

    it('does NOT send an error-alert notification for a transient circuit error', async () => {
      await processor.handleOrderSync(makeJob());

      expect(mockQueues.enqueueNotification).not.toHaveBeenCalled();
    });

    it('does not throw so the queue job completes cleanly', async () => {
      await expect(
        processor.handleOrderSync(makeJob()),
      ).resolves.toBeUndefined();
    });

    it('still permanently fails on a genuine (non-transient) Oracle error', async () => {
      (mockSoapClient.createSimpleInvoice as jest.Mock).mockRejectedValue(
        new Error('Oracle invoice creation failed: Invalid customer account'),
      );

      await expect(processor.handleOrderSync(makeJob())).rejects.toThrow();

      const updateCalls = (orders.update as jest.Mock).mock.calls as Array<
        [unknown, { status?: SyncStatus }]
      >;
      expect(
        updateCalls.find((c) => c[1]?.status === SyncStatus.FAILED),
      ).toBeDefined();
    });
  });

  describe('refund separation (invoice-only Oracle cycle)', () => {
    const REFUND_ORDER = {
      ...BASE_ORDER,
      id: 'q-refund-1',
      odooOrderId: 'ORD-REFUND-1',
      odooOrderNumber: 'S00099',
      isRefund: true,
      refundReferenceId: 'ORD-ORIGINAL-1',
      oracleInvoiceNumber: 'INV-777',
      totalAmount: new Decimal(-150),
      orderDate: new Date('2024-06-16T10:00:00Z'),
    };

    beforeEach(() => {
      orders.findOne.mockResolvedValue(
        REFUND_ORDER as unknown as OrderSyncQueue,
      );
    });

    it('never creates an Oracle invoice for a refund order', async () => {
      await processor.handleOrderSync(makeJob({ odooOrderId: 'ORD-REFUND-1' }));

      expect(mockSoapClient.createSimpleInvoice).not.toHaveBeenCalled();
      expect(mockEnrichment.enrichOrder).not.toHaveBeenCalled();
    });

    it('records the refund in RefundTracking for manual handling', async () => {
      await processor.handleOrderSync(makeJob({ odooOrderId: 'ORD-REFUND-1' }));

      // No existing tracking row → a new one is created + saved.
      expect(refundTracking.save).toHaveBeenCalledTimes(1);
      const created = (refundTracking.create as jest.Mock).mock
        .calls[0][0] as {
        refundOrderId: string;
        refundAmount: Decimal;
        originalOrderId: string;
      };
      expect(created.refundOrderId).toBe('ORD-REFUND-1');
      // stored as positive magnitude
      expect(created.refundAmount.toString()).toBe('150');
      expect(created.originalOrderId).toBe('ORD-ORIGINAL-1');
    });

    it('marks the refund order SKIPPED, not FAILED', async () => {
      await processor.handleOrderSync(makeJob({ odooOrderId: 'ORD-REFUND-1' }));

      const updateCalls = (orders.update as jest.Mock).mock.calls as Array<
        [unknown, { status?: SyncStatus }]
      >;
      expect(
        updateCalls.find((c) => c[1]?.status === SyncStatus.SKIPPED),
      ).toBeDefined();
      expect(
        updateCalls.find((c) => c[1]?.status === SyncStatus.FAILED),
      ).toBeUndefined();
    });
  });

  describe('invalid Oracle item handling (hold, do not invoice)', () => {
    it('holds the order and never calls Oracle when an item is missing', async () => {
      // ITEM-001 (the only enriched line) is not in Oracle's catalog.
      mockOracleClient.itemExists.mockResolvedValue(false);

      await processor.handleOrderSync(makeJob());

      // No invoice attempted
      expect(mockSoapClient.createSimpleInvoice).not.toHaveBeenCalled();

      // Order held as SKIPPED with the missing item recorded
      const updateCalls = (orders.update as jest.Mock).mock.calls as Array<
        [unknown, { status?: SyncStatus; validationErrors?: unknown }]
      >;
      const held = updateCalls.find(
        (c) => c[1]?.status === SyncStatus.SKIPPED,
      );
      expect(held).toBeDefined();
      expect(
        (held![1].validationErrors as { missingOracleItems?: string[] })
          .missingOracleItems,
      ).toContain('ITEM-001');
      expect(
        updateCalls.find((c) => c[1]?.status === SyncStatus.FAILED),
      ).toBeUndefined();
    });

    it('proceeds to invoicing when all items exist', async () => {
      mockOracleClient.itemExists.mockResolvedValue(true);

      await processor.handleOrderSync(makeJob());

      expect(mockOracleClient.itemExists).toHaveBeenCalledWith('ITEM-001');
      expect(mockSoapClient.createSimpleInvoice).toHaveBeenCalled();
    });
  });
});
