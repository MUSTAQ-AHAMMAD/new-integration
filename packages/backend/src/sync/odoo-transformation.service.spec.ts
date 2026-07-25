import { ObjectLiteral, Repository } from 'typeorm';
import { OdooTransformationService } from './odoo-transformation.service';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionCustomerAccount } from '../database/entities/fusion-customer-account.entity';
import { FusionReceiptMethod } from '../database/entities/fusion-receipt-method.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { ServiceProviderJournalMeta } from '../database/entities/service-provider-journal-meta.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeBackup(overrides: Record<string, unknown> = {}) {
  return {
    id: 'backup-001',
    orderId: 1001,
    orderName: 'CCNTRBHR/2139',
    dateOrder: new Date('2024-03-15T10:00:00Z'),
    amountTotal: 150,
    amountUntaxed: 130,
    branchName: 'Central',
    warehouseName: 'Main Warehouse',
    orderLines: [],
    orderPayments: [],
    ...overrides,
  };
}

function makeStoreConfig(overrides: Record<string, unknown> = {}) {
  return {
    branchCode: 'CCNTRBHR',
    branchName: 'Central',
    billToSiteName: 'Acme Corp',
    billToLocation: 'Dubai',
    oracleOperatingUnitId: 101,
    oracleBusinessUnit: 'BU-AE',
    transactionSource: 'POS',
    transactionType: 'Invoice',
    invoiceCurrencyCode: 'AED',
    bankAccountName: 'Main Bank',
    cashAccountName: 'Main Cash',
    bankAccountId: 555,
    cashAccountId: 666,
    ...overrides,
  };
}

function makeSalesMeta(overrides: Record<string, unknown> = {}) {
  return {
    billToName: 'Central',
    siteNumber: '2003',
    billToAccount: 3003n,
    businessUnit: 'BU-AE',
    customerType: 'NORMAL',
    region: 'AE',
    ...overrides,
  };
}

function makeRegister(overrides: Record<string, unknown> = {}) {
  return {
    registerName: 'Central',
    bankAccountId: 555n,
    cashAccountId: 666n,
    region: 'AE',
    ...overrides,
  };
}

// Per-entity repository mocks. `findUnique`/`findFirst` (Prisma) both map to
// TypeORM's `findOne`; `findMany` maps to `find`. The model keys are kept so the
// test bodies read the same as before.
function makeRepos() {
  return {
    backupOdooOrder: {
      findOne: jest.fn().mockResolvedValue(makeBackup()),
    },
    storeConfiguration: {
      findOne: jest.fn().mockResolvedValue(makeStoreConfig()),
    },
    fusionSalesMetadata: {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([makeSalesMeta()]),
    },
    vendHqRegister: {
      find: jest.fn().mockResolvedValue([makeRegister()]),
    },
    fusionBusinessUnitMap: {
      findOne: jest.fn().mockResolvedValue({ businessUnitId: 300n }),
    },
    serviceProviderJournalMeta: {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    },
    fusionReceiptMethod: {
      findOne: jest.fn().mockResolvedValue(null),
    },
    fusionCustomerAccount: {
      findOne: jest
        .fn()
        .mockResolvedValue({ customerAccountId: 300000051631461n }),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OdooTransformationService', () => {
  let service: OdooTransformationService;
  let prisma: ReturnType<typeof makeRepos>;

  const asRepo = <T extends ObjectLiteral>(mock: unknown) =>
    mock as unknown as Repository<T>;

  beforeEach(() => {
    prisma = makeRepos();
    service = new OdooTransformationService(
      asRepo<FusionSalesMetadata>(prisma.fusionSalesMetadata),
      asRepo<VendHqRegister>(prisma.vendHqRegister),
      asRepo<FusionCustomerAccount>(prisma.fusionCustomerAccount),
      asRepo<BackupOdooOrder>(prisma.backupOdooOrder),
      asRepo<StoreConfiguration>(prisma.storeConfiguration),
      asRepo<FusionBusinessUnitMap>(prisma.fusionBusinessUnitMap),
      asRepo<FusionReceiptMethod>(prisma.fusionReceiptMethod),
      asRepo<ServiceProviderJournalMeta>(prisma.serviceProviderJournalMeta),
    );
    jest.clearAllMocks();
  });

  // ── buildOrderPayloads — guard conditions ──────────────────────────────────

  it('throws when BackupOdooOrder is not found', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(null);
    await expect(
      service.buildOrderPayloads('missing-id', 'CCNTRBHR', 'AE'),
    ).rejects.toThrow('BackupOdooOrder not found: missing-id');
  });

  it('throws when StoreConfiguration is not found', async () => {
    prisma.storeConfiguration.findOne.mockResolvedValueOnce(null);
    await expect(
      service.buildOrderPayloads('backup-001', 'UNKNOWN', 'AE'),
    ).rejects.toThrow('StoreConfiguration not found for branchCode=UNKNOWN');
  });

  // ── InvoiceHeader ──────────────────────────────────────────────────────────

  it('builds invoice header from store config', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(makeBackup());
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );

    // Bill-to now comes from FusionSalesMetadata (matched by branchName), not
    // the StoreConfiguration placeholder.
    expect(result.invoiceHeader.billToCustomerName).toBe('Central');
    expect(result.invoiceHeader.billToAccountNumber).toBe('3003');
    expect(result.invoiceHeader.billToLocation).toBe('2003');
    expect(result.invoiceHeader.businessUnit).toBe('BU-AE');
    expect(result.invoiceHeader.transactionSource).toBe('POS');
    expect(result.invoiceHeader.invoiceCurrencyCode).toBe('AED');
    expect(result.invoiceHeader.outletName).toBe('Main Warehouse');
  });

  it('falls back to branchName when warehouseName is absent', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({ warehouseName: null }),
    );
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.invoiceHeader.outletName).toBe('Central');
  });

  // ── InvoiceLines ──────────────────────────────────────────────────────────

  it('maps order lines to invoice lines', async () => {
    const orderLines = [
      {
        productName: 'Widget A',
        qty: 2,
        priceUnit: 50,
        priceSubtotal: 100,
        priceSubtotalIncl: 110,
        productCode: 'SKU-001',
        productId: 42,
      },
    ];
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({ orderLines }),
    );
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );

    expect(result.invoiceHeader.invoiceLines).toHaveLength(1);
    const line = result.invoiceHeader.invoiceLines[0];
    expect(line.description).toBe('Widget A');
    expect(line.quantity).toBe(2);
    // unitSellingPrice comes from priceUnit directly (service prefers priceUnit when set)
    expect(line.unitSellingPrice).toBe(50);
    expect(line.itemNumber).toBe('SKU-001');
  });

  it('skips line with zero quantity', async () => {
    const orderLines = [
      { productName: 'Zero Qty', qty: 0, priceUnit: 50 },
      { productName: 'Normal', qty: 1, priceUnit: 30 },
    ];
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({ orderLines }),
    );
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.invoiceHeader.invoiceLines).toHaveLength(1);
    expect(result.invoiceHeader.invoiceLines[0].description).toBe('Normal');
  });

  it('synthesises a single line when no order lines present', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({ orderLines: [], amountTotal: 200, amountUntaxed: 180 }),
    );
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );

    expect(result.invoiceHeader.invoiceLines).toHaveLength(1);
    // amountUntaxed (180) is used when available
    expect(result.invoiceHeader.invoiceLines[0].unitSellingPrice).toBe(180);
    expect(result.invoiceHeader.invoiceLines[0].quantity).toBe(1);
  });

  it('synthesises from amountTotal when amountUntaxed is null', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({ orderLines: [], amountTotal: 200, amountUntaxed: null }),
    );
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.invoiceHeader.invoiceLines[0].unitSellingPrice).toBe(200);
  });

  it('uses productId as itemNumber when productCode is absent', async () => {
    const orderLines = [
      {
        productName: 'Widget',
        qty: 1,
        priceUnit: 10,
        productCode: null,
        productId: 99,
      },
    ];
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({ orderLines }),
    );
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.invoiceHeader.invoiceLines[0].itemNumber).toBe('99');
  });

  // ── Receipts ──────────────────────────────────────────────────────────────

  it('returns no receipts when order has no payments', async () => {
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.standardReceipts).toHaveLength(0);
    expect(result.miscReceipts).toHaveLength(0);
  });

  it('skips payment when receipt method not configured', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({ orderPayments: [{ paymentName: 'Mystery', amount: 50 }] }),
    );
    prisma.fusionReceiptMethod.findOne.mockResolvedValueOnce(null);
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.standardReceipts).toHaveLength(0);
  });

  it('skips payment with name "credit on cust"', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Credit on Cust', amount: 50 }],
      }),
    );
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.standardReceipts).toHaveLength(0);
    // fusionReceiptMethod.findFirst should not even be called
    expect(prisma.fusionReceiptMethod.findOne).not.toHaveBeenCalled();
  });

  it('builds a standard receipt for a cash payment', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Cash', amount: 100 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 100 }],
      }),
    );
    prisma.fusionReceiptMethod.findOne.mockResolvedValueOnce({
      receiptMethodId: 123n,
      receiptIsCash: true,
      receiptBankCharge: 0,
      receiptMethodTax: 0,
    });
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.standardReceipts).toHaveLength(1);
    expect(result.standardReceipts[0].receiptAmount).toBe(100);
    expect(result.standardReceipts[0].receiptMethodId).toBe(123);
    // Resolved Oracle customer account id → receipt is customer-identified.
    expect(result.standardReceipts[0].customerId).toBe(300000051631461);
    // Cash payment → no misc receipt
    expect(result.miscReceipts).toHaveLength(0);
  });

  it('throws when no Oracle customer account id is mapped', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Cash', amount: 100 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 100 }],
      }),
    );
    prisma.fusionReceiptMethod.findOne.mockResolvedValueOnce({
      receiptMethodId: 123n,
      receiptIsCash: true,
      receiptBankCharge: 0,
      receiptMethodTax: 0,
    });
    // Customer account not in the map → the build must hold the order rather
    // than create an unidentified, unapplicable receipt.
    prisma.fusionCustomerAccount.findOne.mockResolvedValueOnce(null);
    await expect(
      service.buildOrderPayloads('backup-001', 'CCNTRBHR', 'AE'),
    ).rejects.toThrow('No Oracle customer account id mapped');
  });

  it('throws when the register has no bank/cash account (Java parity)', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({ orderPayments: [{ paymentName: 'Cash', amount: 80 }] }),
    );
    prisma.storeConfiguration.findOne.mockResolvedValueOnce(
      makeStoreConfig({ cashAccountId: null }),
    );
    // No matching VendHqRegister either → no account available at all.
    prisma.vendHqRegister.find.mockResolvedValueOnce([]);
    prisma.fusionReceiptMethod.findOne.mockResolvedValueOnce({
      receiptMethodId: 1n,
      receiptIsCash: true,
      receiptBankCharge: 0,
      receiptMethodTax: 0,
    });
    await expect(
      service.buildOrderPayloads('backup-001', 'CCNTRBHR', 'AE'),
    ).rejects.toThrow('is not entered in VendHqRegister');
  });

  it('builds standard and misc receipts for a card payment', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Visa', amount: 200 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 200 }],
      }),
    );
    prisma.fusionReceiptMethod.findOne.mockResolvedValueOnce({
      receiptMethodId: 456n,
      receiptIsCash: false,
      receiptBankCharge: 0.01,
      receiptMethodTax: 0.05,
    });
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.standardReceipts).toHaveLength(1);
    expect(result.miscReceipts).toHaveLength(1);
    // misc amount = 200 * 0.01 * (1 + 0.05) = 2.1
    expect(result.miscReceipts[0].receiptAmount).toBeCloseTo(-2.1);
  });

  it('applies OM Debit Card misc cap at 10', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Debit Card', amount: 5000 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 5000 }],
      }),
    );
    prisma.fusionReceiptMethod.findOne.mockResolvedValueOnce({
      receiptMethodId: 789n,
      receiptIsCash: false,
      receiptBankCharge: 0.01,
      receiptMethodTax: 0.05,
    });
    // region OM triggers the cap
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'OM',
    );
    // 5000 * 0.01 * 1.05 = 52.5 → capped at 10
    expect(result.miscReceipts[0].receiptAmount).toBe(-10);
  });

  it('does not cap Debit Card misc in non-OM region', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Debit Card', amount: 5000 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 5000 }],
      }),
    );
    prisma.fusionReceiptMethod.findOne.mockResolvedValueOnce({
      receiptMethodId: 789n,
      receiptIsCash: false,
      receiptBankCharge: 0.01,
      receiptMethodTax: 0.05,
    });
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.miscReceipts[0].receiptAmount).toBeCloseTo(-52.5);
  });

  // ── ApplyReceipts ─────────────────────────────────────────────────────────

  it('creates one apply receipt per standard receipt', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Cash', amount: 100 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 100 }],
      }),
    );
    prisma.fusionReceiptMethod.findOne.mockResolvedValueOnce({
      receiptMethodId: 1n,
      receiptIsCash: true,
      receiptBankCharge: 0,
      receiptMethodTax: 0,
    });
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.applyReceipts).toHaveLength(1);
    expect(result.applyReceipts[0].receiptNumber).toBe(
      result.standardReceipts[0].receiptNumber,
    );
  });

  // ── Journal entries ───────────────────────────────────────────────────────

  it('returns no journal headers for NORMAL retail sales', async () => {
    // Default order is a NORMAL sale → no service-provider journal.
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.journalHeaders).toHaveLength(0);
  });

  it('builds a balanced Dr/Cr journal for a service-provider order', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        customerType: 'TABBY',
        // A real TABBY payment makes this a service-provider order by derivation.
        orderPayments: [{ paymentName: 'TABBY', amount: 100 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 100 }],
      }),
    );
    // Non-NORMAL bill-to resolves by (subinventory, customerType, region).
    prisma.fusionSalesMetadata.find.mockResolvedValueOnce([
      makeSalesMeta({
        billToName: 'Tabby',
        customerType: 'TABBY',
        subinventory: 'Central',
      }),
    ]);
    // getServiceProviderNames() reads the region's providers first (order has no
    // provider payment, so classification falls back to customerType='TABBY');
    // buildJournalHeaders() then reads the paired CREDIT/DEBIT rows.
    prisma.serviceProviderJournalMeta.find.mockResolvedValueOnce([
      { serviceProvider: 'TABBY' },
    ]);
    // Paired provider rows: CREDIT-row account is debited, DEBIT-row credited.
    prisma.serviceProviderJournalMeta.find.mockResolvedValueOnce([
      {
        creditDebit: 'CREDIT',
        ledgerId: 1001n,
        chartOfAccountsId: 2n,
        company: '01',
        account: '3020044',
        department: '46',
        productCategory: '00',
        interCompany: '01',
        futUsed: '00',
        extraSegment1: null,
        extraSegment2: null,
        extraSegment3: null,
        jeSource: 'Vend',
        jeCategory: 'Vend',
        // The journal posts the provider COMMISSION (total × rate), not the
        // gross sale — without a rate no journal is built.
        bankChargeRate: 0.05,
      },
      {
        creditDebit: 'DEBIT',
        ledgerId: 1001n,
        chartOfAccountsId: 2n,
        company: '01',
        account: '5000104',
        department: '46',
        jeSource: 'Vend',
        jeCategory: 'Vend',
      },
    ]);
    // Store cost center (SEGMENT4) from the store's own NORMAL metadata row.
    prisma.fusionSalesMetadata.find.mockResolvedValueOnce([
      { billToName: 'Central', costCenterCode: '0502' },
    ]);

    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.journalHeaders).toHaveLength(1);
    const lines = result.journalHeaders[0].journalLines;
    expect(lines).toHaveLength(2);
    // Balanced: one debit to 3020044, one credit to 5000104, equal amounts.
    const dr = lines.find((l) => l.enteredDrAmount != null)!;
    const cr = lines.find((l) => l.enteredCrAmount != null)!;
    expect(dr.segment2).toBe('3020044');
    expect(cr.segment2).toBe('5000104');
    expect(dr.segment4).toBe('0502');
    expect(dr.enteredDrAmount).toBe(cr.enteredCrAmount);
    // Per requirement: a service-provider sale posts ONLY invoice + journal —
    // no standard/misc/apply receipts (the platform settles the receivable).
    expect(result.standardReceipts).toHaveLength(0);
    expect(result.miscReceipts).toHaveLength(0);
    expect(result.applyReceipts).toHaveLength(0);
    expect(result.invoiceHeader.invoiceLines.length).toBeGreaterThan(0);
  });

  it('does not flag a service-provider payment (TAMARA) as unmapped', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [
          { paymentName: 'TAMARA', amount: 120 },
          { paymentName: 'Cash', amount: 30 },
        ],
      }),
    );
    // Region providers include TAMARA (so it is skipped, not flagged).
    prisma.serviceProviderJournalMeta.find.mockResolvedValueOnce([
      { serviceProvider: 'TAMARA' },
    ]);
    // Cash resolves to a receipt method; TAMARA must never be looked up.
    prisma.fusionReceiptMethod.findOne.mockResolvedValue({
      receiptMethodId: 10n,
      receiptIsCash: true,
    } as never);

    const { unmapped } = await service.findUnmappedPaymentNames(
      'CCNTRBHR/2139',
      'SN',
    );
    expect(unmapped).not.toContain('TAMARA');
  });

  it('skips the journal (non-fatal) when a service-provider journal lacks a CREDIT/DEBIT account pair', async () => {
    // A GL-metadata gap must never fail the whole store's invoice — the invoice,
    // receipts and inventory still build; only the journal is skipped.
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        customerType: 'TABBY',
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 100 }],
      }),
    );
    prisma.fusionSalesMetadata.find.mockResolvedValueOnce([
      makeSalesMeta({
        billToName: 'Tabby',
        customerType: 'TABBY',
        subinventory: 'Central',
      }),
    ]);
    // getServiceProviderNames() consumes the first find(); the unpaired row below
    // is what buildJournalHeaders() then sees.
    prisma.serviceProviderJournalMeta.find.mockResolvedValueOnce([
      { serviceProvider: 'TABBY' },
    ]);
    prisma.serviceProviderJournalMeta.find.mockResolvedValueOnce([
      { creditDebit: 'CREDIT', ledgerId: 1n, chartOfAccountsId: 2n, account: '3020044' },
    ]);
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.journalHeaders).toHaveLength(0);
    expect(result.invoiceHeader.invoiceLines.length).toBeGreaterThan(0);
  });

  // ── transactionNumberOverride ─────────────────────────────────────────────

  it('uses transactionNumberOverride when provided', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Cash', amount: 50 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 50 }],
      }),
    );
    prisma.fusionReceiptMethod.findOne.mockResolvedValueOnce({
      receiptMethodId: 1n,
      receiptIsCash: true,
      receiptBankCharge: 0,
      receiptMethodTax: 0,
    });
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
      'TXN-OVERRIDE',
    );
    expect(result.standardReceipts[0].receiptNumber).toContain('TXN-OVERRIDE');
    expect(result.applyReceipts[0].transactionNumber).toBe('TXN-OVERRIDE');
  });

  // ── Cash Rounding ─────────────────────────────────────────────────────────

  it('creates cash rounding misc receipt (not standard)', async () => {
    prisma.backupOdooOrder.findOne.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Cash Rounding', amount: 0.05 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 100 }],
      }),
    );
    prisma.fusionReceiptMethod.findOne.mockResolvedValueOnce({
      receiptMethodId: 10n,
      receiptIsCash: true,
      receiptBankCharge: 0,
      receiptMethodTax: 0,
    });
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    // cash rounding creates misc receipt, not standard
    expect(result.standardReceipts).toHaveLength(0);
    expect(result.miscReceipts).toHaveLength(1);
    expect(result.miscReceipts[0].receivableActivityName).toBe('Cash Rounding');
    expect(result.miscReceipts[0].receiptAmount).toBeCloseTo(-0.05);
  });

  // ── Service-provider derivation (Odoo has no customer_type) ─────────────────

  describe('getServiceProviderNames / deriveServiceProvider', () => {
    it('returns the region providers upper-cased and de-duplicated', async () => {
      prisma.serviceProviderJournalMeta.find.mockResolvedValueOnce([
        { serviceProvider: 'TABBY' },
        { serviceProvider: 'TABBY' },
        { serviceProvider: 'Tamara' },
        { serviceProvider: '  ' },
        { serviceProvider: null },
      ]);
      const names = await service.getServiceProviderNames('SA');
      expect([...names].sort()).toEqual(['TABBY', 'TAMARA']);
    });

    it('classifies an order by a matching provider payment', () => {
      const providers = new Set(['TABBY', 'TAMARA']);
      const order = makeBackup({
        orderPayments: [{ paymentName: 'Tabby', amount: 120 }],
      }) as unknown as BackupOdooOrder;
      expect(service.deriveServiceProvider(order, providers)).toBe('TABBY');
    });

    it('returns null for an ordinary retail sale', () => {
      const providers = new Set(['TABBY', 'TAMARA']);
      const order = makeBackup({
        orderPayments: [
          { paymentName: 'Cash', amount: 50 },
          { paymentName: 'Mada', amount: 70 },
        ],
      }) as unknown as BackupOdooOrder;
      expect(service.deriveServiceProvider(order, providers)).toBeNull();
    });

    it('picks the provider that settled the largest amount on a split payment', () => {
      const providers = new Set(['TABBY', 'TAMARA']);
      const order = makeBackup({
        orderPayments: [
          { paymentName: 'TABBY', amount: 30 },
          { paymentName: 'TAMARA', amount: 90 },
        ],
      }) as unknown as BackupOdooOrder;
      expect(service.deriveServiceProvider(order, providers)).toBe('TAMARA');
    });

    it('returns null when no providers are configured for the region', () => {
      const order = makeBackup({
        orderPayments: [{ paymentName: 'TABBY', amount: 30 }],
      }) as unknown as BackupOdooOrder;
      expect(service.deriveServiceProvider(order, new Set())).toBeNull();
    });
  });
});
