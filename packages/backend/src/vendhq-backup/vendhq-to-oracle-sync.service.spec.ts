import {
  ApplyReceiptRequest,
  MiscReceiptRequest,
  StandardReceiptRequest,
} from '../clients/oracle/oracle-soap.client';
import { OracleSoapClient } from '../clients/oracle/oracle-soap.client';
import { Repository } from 'typeorm';
import { BackupVendHqSale } from '../database/entities/backup-vend-hq-sale.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionStandardReceipt } from '../database/entities/fusion-standard-receipt.entity';
import { FusionMiscReceipt } from '../database/entities/fusion-misc-receipt.entity';
import { FusionApplyReceipt } from '../database/entities/fusion-apply-receipt.entity';
import { FusionJournalHeader } from '../database/entities/fusion-journal-header.entity';
import { FusionJournalLine } from '../database/entities/fusion-journal-line.entity';
import { SaleSyncStatus } from '../database/entities/sale-sync-status.entity';
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

function makeRepos() {
  const sales = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(makeSale()),
    update: jest.fn().mockResolvedValue({}),
  };
  const itemMeta = {
    find: jest.fn().mockResolvedValue([]),
  };
  const invoiceHeaders = {
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({ id: 'inv-header-001' }),
  };
  const invoiceLines = {
    insert: jest.fn().mockResolvedValue({}),
  };
  const standardReceiptsRepo = {
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({}),
  };
  const miscReceiptsRepo = {
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({}),
  };
  const applyReceiptsRepo = {
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({}),
  };
  const journalHeadersRepo = {
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({ id: 'jh-001' }),
  };
  const journalLinesRepo = {
    insert: jest.fn().mockResolvedValue({}),
  };
  const saleSyncStatus = {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return {
    sales,
    itemMeta,
    invoiceHeaders,
    invoiceLines,
    standardReceiptsRepo,
    miscReceiptsRepo,
    applyReceiptsRepo,
    journalHeadersRepo,
    journalLinesRepo,
    saleSyncStatus,
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
    createStandardReceipt: jest
      .fn()
      .mockResolvedValue({ receiptNumber: 'RCP-001' }),
    createMiscellaneousReceipt: jest
      .fn()
      .mockResolvedValue({ receiptNumber: 'MISC-001' }),
    createApplyReceipt: jest.fn().mockResolvedValue({}),
    importJournalEntry: jest.fn().mockResolvedValue(9001),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VendHqToOracleSyncService', () => {
  let service: VendHqToOracleSyncService;
  let repos: ReturnType<typeof makeRepos>;
  let transformation: ReturnType<typeof makeTransformation>;
  let soapClient: ReturnType<typeof makeSoapClient>;

  beforeEach(() => {
    repos = makeRepos();
    transformation = makeTransformation();
    soapClient = makeSoapClient();
    const syncControl = {
      isEnabled: jest.fn().mockResolvedValue(true),
      markRunning: jest.fn().mockResolvedValue(undefined),
      markStopped: jest.fn().mockResolvedValue(undefined),
    };
    service = new VendHqToOracleSyncService(
      repos.sales as unknown as Repository<BackupVendHqSale>,
      repos.itemMeta as unknown as Repository<VendHqItemMeta>,
      repos.invoiceHeaders as unknown as Repository<FusionInvoiceHeader>,
      repos.invoiceLines as unknown as Repository<FusionInvoiceLine>,
      repos.standardReceiptsRepo as unknown as Repository<FusionStandardReceipt>,
      repos.miscReceiptsRepo as unknown as Repository<FusionMiscReceipt>,
      repos.applyReceiptsRepo as unknown as Repository<FusionApplyReceipt>,
      repos.journalHeadersRepo as unknown as Repository<FusionJournalHeader>,
      repos.journalLinesRepo as unknown as Repository<FusionJournalLine>,
      repos.saleSyncStatus as unknown as Repository<SaleSyncStatus>,
      transformation as unknown as FusionTransformationService,
      soapClient as unknown as OracleSoapClient,
      syncControl as never,
    );
    jest.clearAllMocks();
  });

  // ── handleCron ────────────────────────────────────────────────────────────

  describe('handleCron', () => {
    it('does not run twice concurrently (running guard)', async () => {
      // Directly set the private running flag to simulate an in-progress sync
      (service as unknown as { running: boolean }).running = true;

      await service.handleCron();

      // find should not have been called since handleCron returned early
      expect(repos.sales.find).not.toHaveBeenCalled();
    });
  });

  // ── runSyncJob ────────────────────────────────────────────────────────────

  describe('runSyncJob', () => {
    it('returns zeros when no pending sales', async () => {
      repos.sales.find.mockResolvedValueOnce([]);
      const result = await service.runSyncJob();
      expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    });

    it('processes sales and returns succeeded count', async () => {
      repos.sales.find.mockResolvedValueOnce([makeSale()]);
      const result = await service.runSyncJob();
      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('filters by region when provided', async () => {
      repos.sales.find.mockResolvedValueOnce([]);
      await service.runSyncJob('KW');
      expect(repos.sales.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ region: 'KW' }),
        }),
      );
    });

    it('increments failed count when processSale throws', async () => {
      repos.sales.find.mockResolvedValueOnce([makeSale()]);
      transformation.buildSalePayloads.mockRejectedValueOnce(
        new Error('transformation failed'),
      );
      const result = await service.runSyncJob();
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(0);
    });

    it('processes multiple sales independently', async () => {
      repos.sales.find.mockResolvedValueOnce([
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
      repos.sales.find.mockResolvedValueOnce([makeSale()]);
      await service.runSyncJob();
      expect(soapClient.createSimpleInvoice).toHaveBeenCalledTimes(1);
      expect(repos.invoiceHeaders.save).toHaveBeenCalledTimes(1);
      expect(repos.invoiceLines.insert).toHaveBeenCalledTimes(1);
    });

    it('marks the sale as fusionSynced=true after success', async () => {
      repos.sales.find.mockResolvedValueOnce([makeSale()]);
      await service.runSyncJob();
      expect(repos.sales.update).toHaveBeenCalledWith(
        { id: 'sale-db-001' },
        expect.objectContaining({ fusionSynced: true }),
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
      ] as StandardReceiptRequest[];
      transformation.buildSalePayloads.mockResolvedValueOnce(result);
      repos.sales.find.mockResolvedValueOnce([makeSale()]);

      await service.runSyncJob();

      expect(soapClient.createStandardReceipt).toHaveBeenCalledTimes(1);
      expect(repos.standardReceiptsRepo.save).toHaveBeenCalledTimes(1);
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
      ] as MiscReceiptRequest[];
      transformation.buildSalePayloads.mockResolvedValueOnce(result);
      repos.sales.find.mockResolvedValueOnce([makeSale()]);

      await service.runSyncJob();

      expect(soapClient.createMiscellaneousReceipt).toHaveBeenCalledTimes(1);
      expect(repos.miscReceiptsRepo.save).toHaveBeenCalledTimes(1);
    });

    it('updates SaleSyncStatus after successful sync', async () => {
      repos.sales.find.mockResolvedValueOnce([makeSale()]);
      await service.runSyncJob();
      expect(repos.saleSyncStatus.update).toHaveBeenCalledTimes(1);
    });
  });

  // ── validateInvoiceLines ────────────────────────────────────────────────────

  describe('validateInvoiceLines', () => {
    const lines = [
      {
        lineNumber: 1,
        itemNumber: 'prod-1',
        description: 'Widget',
        quantity: 2,
        unitSellingPrice: 10,
        currencyCode: 'AED',
        salesOrder: 'INV-001',
      },
      {
        lineNumber: 2,
        itemNumber: 'prod-2',
        description: 'Gadget',
        quantity: 1,
        unitSellingPrice: 5,
        currencyCode: 'AED',
        salesOrder: 'INV-001',
      },
    ];

    it('flags items missing from VendHqItemMeta', async () => {
      repos.itemMeta.find.mockResolvedValueOnce([
        { itemId: 'prod-1', status: 'SUCCESS' },
      ]);
      const summary = await service.validateInvoiceLines(lines, 'AE');
      expect(summary.totalItems).toBe(2);
      expect(summary.matched).toBe(1);
      expect(summary.missingFromItemMeta).toBe(1);
      expect(summary.items[1].issue).toMatch(/not found in VendHqItemMeta/);
    });

    it('flags items with a non-success status', async () => {
      repos.itemMeta.find.mockResolvedValueOnce([
        { itemId: 'prod-1', status: 'SUCCESS' },
        { itemId: 'prod-2', status: 'ERROR' },
      ]);
      const summary = await service.validateInvoiceLines(lines, 'AE');
      expect(summary.matched).toBe(1);
      expect(summary.failedStatus).toBe(1);
      expect(summary.items[1].issue).toMatch(/status is "ERROR"/);
    });

    it('does not flag discount memo lines without an item number', async () => {
      const summary = await service.validateInvoiceLines(
        [
          {
            lineNumber: 1,
            memoLineName: 'Discount Item',
            description: 'Discount Item',
            quantity: 1,
            unitSellingPrice: -5,
            currencyCode: 'AED',
            salesOrder: 'INV-001',
          },
        ],
        'AE',
      );
      expect(summary.items[0].issue).toBeNull();
    });
  });

  // ── traceSale ────────────────────────────────────────────────────────────────

  describe('traceSale', () => {
    it('reports sale not found when the invoice is missing', async () => {
      repos.sales.findOne.mockResolvedValueOnce(null);
      const report = await service.traceSale('MISSING', 'AE');
      expect(report.sale.found).toBe(false);
      expect(report.steps[0]).toEqual(
        expect.objectContaining({ step: 'fetch', ok: false }),
      );
    });

    it('traces a sale through transform and validation as a dry run', async () => {
      repos.sales.findOne.mockResolvedValueOnce({
        ...makeSale(),
        backupLineItems: [
          {
            lineNumber: 1,
            productId: 'prod-1',
            productName: 'Widget',
            quantity: 1,
          },
        ],
      });
      repos.itemMeta.find.mockResolvedValueOnce([]);

      const report = await service.traceSale('INV-001', 'AE');

      expect(report.sale.found).toBe(true);
      expect(report.transform.ok).toBe(true);
      expect(report.itemValidation).not.toBeNull();
      expect(report.push.attempted).toBe(false);
      // Dry run must not push to Oracle
      expect(soapClient.createSimpleInvoice).not.toHaveBeenCalled();
    });

    it('attempts the Oracle push when dryRun is false', async () => {
      repos.sales.findOne
        .mockResolvedValueOnce({
          ...makeSale(),
          backupLineItems: [],
        })
        // processSale's updateSaleSyncStatus does a second findOne
        .mockResolvedValueOnce(makeSale());

      const report = await service.traceSale('INV-001', 'AE', {
        dryRun: false,
      });

      expect(report.push.attempted).toBe(true);
      expect(report.push.ok).toBe(true);
      expect(soapClient.createSimpleInvoice).toHaveBeenCalledTimes(1);
    });
  });
});
