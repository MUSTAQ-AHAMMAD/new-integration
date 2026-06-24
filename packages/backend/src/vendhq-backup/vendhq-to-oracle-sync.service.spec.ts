import {
  ApplyReceiptRequest,
  MiscReceiptRequest,
  StandardReceiptRequest,
} from '../clients/oracle/oracle-soap.client';
import { OracleSoapClient } from '../clients/oracle/oracle-soap.client';
import { PrismaService } from '../prisma/prisma.service';
import { FusionTransformationService } from '../sync/fusion-transformation.service';
import { VendHqToOracleSyncService } from './vendhq-to-oracle-sync.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeSale(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sale-db-001',
    region: 'AE',
    invoiceNumber: 'INV-001',
    outletId: 'outlet-1',
    saleDate: new Date('2024-03-15T10:00:00Z'),
    fusionSynced: false,
    ...overrides,
  };
}

function makeInvoiceResult() {
  return {
    customerTrxId: 1001,
    transactionNumber: 'TRX-1001',
    serviceStatus: 'SUCCESS',
  };
}

function makeTransformResult() {
  return {
    invoiceHeader: {
      billToCustomerName: 'Acme Corp',
      billToLocation: 'Dubai',
      billToAccountNumber: '101',
      businessUnit: 'BU-AE',
      transactionSource: 'POS',
      transactionType: 'Invoice',
      invoiceCurrencyCode: 'AED',
      saleDate: new Date(),
      outletName: 'Main',
      invoiceLines: [
        {
          lineNumber: 1,
          description: 'Widget',
          quantity: 1,
          unitSellingPrice: 100,
          currencyCode: 'AED',
          salesOrder: 'INV-001',
          salesOrderLine: '1',
        },
      ],
    },
    standardReceipts: [] as StandardReceiptRequest[],
    miscReceipts: [] as MiscReceiptRequest[],
    applyReceipts: [] as ApplyReceiptRequest[],
    journalHeaders: [],
  };
}

function makePrisma() {
  return {
    backupVendHqSale: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(makeSale()),
      update: jest.fn().mockResolvedValue({}),
    },
    fusionInvoiceHeader: {
      create: jest.fn().mockResolvedValue({ id: 'inv-header-001' }),
    },
    fusionInvoiceLine: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    fusionStandardReceipt: {
      create: jest.fn().mockResolvedValue({}),
    },
    fusionMiscReceipt: {
      create: jest.fn().mockResolvedValue({}),
    },
    fusionApplyReceipt: {
      create: jest.fn().mockResolvedValue({}),
    },
    fusionJournalHeader: {
      create: jest.fn().mockResolvedValue({ id: 'jh-001' }),
    },
    fusionJournalLine: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    saleSyncStatus: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function makeTransformation() {
  return {
    buildSalePayloads: jest.fn().mockResolvedValue(makeTransformResult()),
  };
}

function makeSoapClient() {
  return {
    createSimpleInvoice: jest.fn().mockResolvedValue(makeInvoiceResult()),
    createStandardReceipt: jest.fn().mockResolvedValue({ receiptNumber: 'RCP-001' }),
    createMiscellaneousReceipt: jest.fn().mockResolvedValue({ receiptNumber: 'MISC-001' }),
    createApplyReceipt: jest.fn().mockResolvedValue({}),
    importJournalEntry: jest.fn().mockResolvedValue(9001),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VendHqToOracleSyncService', () => {
  let service: VendHqToOracleSyncService;
  let prisma: ReturnType<typeof makePrisma>;
  let transformation: ReturnType<typeof makeTransformation>;
  let soapClient: ReturnType<typeof makeSoapClient>;

  beforeEach(() => {
    prisma = makePrisma();
    transformation = makeTransformation();
    soapClient = makeSoapClient();
    service = new VendHqToOracleSyncService(
      prisma as unknown as PrismaService,
      transformation as unknown as FusionTransformationService,
      soapClient as unknown as OracleSoapClient,
    );
    jest.clearAllMocks();
  });

  // ── handleCron ────────────────────────────────────────────────────────────

  describe('handleCron', () => {
    it('does not run twice concurrently (running guard)', async () => {
      // Directly set the private running flag to simulate an in-progress sync
      (service as unknown as { running: boolean }).running = true;

      await service.handleCron();

      // findMany should not have been called since handleCron returned early
      expect(prisma.backupVendHqSale.findMany).not.toHaveBeenCalled();
    });
  });

  // ── runSyncJob ────────────────────────────────────────────────────────────

  describe('runSyncJob', () => {
    it('returns zeros when no pending sales', async () => {
      prisma.backupVendHqSale.findMany.mockResolvedValueOnce([]);
      const result = await service.runSyncJob();
      expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    });

    it('processes sales and returns succeeded count', async () => {
      prisma.backupVendHqSale.findMany.mockResolvedValueOnce([makeSale()]);
      const result = await service.runSyncJob();
      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('filters by region when provided', async () => {
      prisma.backupVendHqSale.findMany.mockResolvedValueOnce([]);
      await service.runSyncJob('KW');
      expect(prisma.backupVendHqSale.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ region: 'KW' }),
        }),
      );
    });

    it('increments failed count when processSale throws', async () => {
      prisma.backupVendHqSale.findMany.mockResolvedValueOnce([makeSale()]);
      transformation.buildSalePayloads.mockRejectedValueOnce(
        new Error('transformation failed'),
      );
      const result = await service.runSyncJob();
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(0);
    });

    it('processes multiple sales independently', async () => {
      prisma.backupVendHqSale.findMany.mockResolvedValueOnce([
        makeSale({ id: 'sale-001' }),
        makeSale({ id: 'sale-002' }),
        makeSale({ id: 'sale-003' }),
      ]);
      // Second sale fails
      transformation.buildSalePayloads
        .mockResolvedValueOnce(makeTransformResult())
        .mockRejectedValueOnce(new Error('bad data'))
        .mockResolvedValueOnce(makeTransformResult());

      const result = await service.runSyncJob();
      expect(result.processed).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
    });
  });

  // ── processSale (via runSyncJob) ──────────────────────────────────────────

  describe('processSale — Oracle pipeline', () => {
    it('creates invoice header and lines in DB', async () => {
      prisma.backupVendHqSale.findMany.mockResolvedValueOnce([makeSale()]);
      await service.runSyncJob();
      expect(soapClient.createSimpleInvoice).toHaveBeenCalledTimes(1);
      expect(prisma.fusionInvoiceHeader.create).toHaveBeenCalledTimes(1);
      expect(prisma.fusionInvoiceLine.createMany).toHaveBeenCalledTimes(1);
    });

    it('marks the sale as fusionSynced=true after success', async () => {
      prisma.backupVendHqSale.findMany.mockResolvedValueOnce([makeSale()]);
      await service.runSyncJob();
      expect(prisma.backupVendHqSale.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sale-db-001' },
          data: expect.objectContaining({ fusionSynced: true }),
        }),
      );
    });

    it('creates standard receipts for each SR in the transform result', async () => {
      const result = makeTransformResult();
      result.standardReceipts = [
        {
          currencyCode: 'AED',
          saleDate: new Date(),
          receiptMethodId: 123,
          receiptNumber: 'RCP-001',
          remittanceBankAccountId: 555,
          accountValue: '101',
          orgId: 300,
          receiptAmount: 100,
        },
      ];
      transformation.buildSalePayloads.mockResolvedValueOnce(result);
      prisma.backupVendHqSale.findMany.mockResolvedValueOnce([makeSale()]);

      await service.runSyncJob();

      expect(soapClient.createStandardReceipt).toHaveBeenCalledTimes(1);
      expect(prisma.fusionStandardReceipt.create).toHaveBeenCalledTimes(1);
    });

    it('creates misc receipts for each MR in the transform result', async () => {
      const result = makeTransformResult();
      result.miscReceipts = [
        {
          currencyCode: 'AED',
          saleDate: new Date(),
          receiptMethodId: 456,
          receiptMethodName: 'Visa',
          receiptNumber: 'MISC-001',
          bankAccountName: 'Main Bank',
          receivableActivityName: 'Bank Charges',
          orgId: 300,
          receiptAmount: -2.5,
        },
      ];
      transformation.buildSalePayloads.mockResolvedValueOnce(result);
      prisma.backupVendHqSale.findMany.mockResolvedValueOnce([makeSale()]);

      await service.runSyncJob();

      expect(soapClient.createMiscellaneousReceipt).toHaveBeenCalledTimes(1);
      expect(prisma.fusionMiscReceipt.create).toHaveBeenCalledTimes(1);
    });

    it('updates SaleSyncStatus after successful sync', async () => {
      prisma.backupVendHqSale.findMany.mockResolvedValueOnce([makeSale()]);
      await service.runSyncJob();
      expect(prisma.saleSyncStatus.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
