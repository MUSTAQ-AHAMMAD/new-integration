import { OdooTransformationService } from './odoo-transformation.service';
import { PrismaService } from '../prisma/prisma.service';

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

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    backupOdooOrder: {
      findUnique: jest.fn().mockResolvedValue(makeBackup()),
    },
    storeConfiguration: {
      findUnique: jest.fn().mockResolvedValue(makeStoreConfig()),
    },
    fusionSalesMetadata: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([makeSalesMeta()]),
    },
    vendHqRegister: {
      findMany: jest.fn().mockResolvedValue([makeRegister()]),
    },
    fusionBusinessUnitMap: {
      findFirst: jest.fn().mockResolvedValue({ businessUnitId: 300 }),
    },
    serviceProviderJournalMeta: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    fusionReceiptMethod: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OdooTransformationService', () => {
  let service: OdooTransformationService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    service = new OdooTransformationService(prisma as unknown as PrismaService);
    jest.clearAllMocks();
  });

  // ── buildOrderPayloads — guard conditions ──────────────────────────────────

  it('throws when BackupOdooOrder is not found', async () => {
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.buildOrderPayloads('missing-id', 'CCNTRBHR', 'AE'),
    ).rejects.toThrow('BackupOdooOrder not found: missing-id');
  });

  it('throws when StoreConfiguration is not found', async () => {
    prisma.storeConfiguration.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.buildOrderPayloads('backup-001', 'UNKNOWN', 'AE'),
    ).rejects.toThrow('StoreConfiguration not found for branchCode=UNKNOWN');
  });

  // ── InvoiceHeader ──────────────────────────────────────────────────────────

  it('builds invoice header from store config', async () => {
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(makeBackup());
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
      makeBackup({ orderPayments: [{ paymentName: 'Mystery', amount: 50 }] }),
    );
    prisma.fusionReceiptMethod.findFirst.mockResolvedValueOnce(null);
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.standardReceipts).toHaveLength(0);
  });

  it('skips payment with name "credit on cust"', async () => {
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
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
    expect(prisma.fusionReceiptMethod.findFirst).not.toHaveBeenCalled();
  });

  it('builds a standard receipt for a cash payment', async () => {
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Cash', amount: 100 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 100 }],
      }),
    );
    prisma.fusionReceiptMethod.findFirst.mockResolvedValueOnce({
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
    // Cash payment → no misc receipt
    expect(result.miscReceipts).toHaveLength(0);
  });

  it('warns and skips standard receipt when cashAccountId is null', async () => {
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
      makeBackup({ orderPayments: [{ paymentName: 'Cash', amount: 80 }] }),
    );
    prisma.storeConfiguration.findUnique.mockResolvedValueOnce(
      makeStoreConfig({ cashAccountId: null }),
    );
    // No matching VendHqRegister either → no account available at all.
    prisma.vendHqRegister.findMany.mockResolvedValueOnce([]);
    prisma.fusionReceiptMethod.findFirst.mockResolvedValueOnce({
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
    expect(result.standardReceipts).toHaveLength(0);
  });

  it('builds standard and misc receipts for a card payment', async () => {
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Visa', amount: 200 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 200 }],
      }),
    );
    prisma.fusionReceiptMethod.findFirst.mockResolvedValueOnce({
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Debit Card', amount: 5000 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 5000 }],
      }),
    );
    prisma.fusionReceiptMethod.findFirst.mockResolvedValueOnce({
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Debit Card', amount: 5000 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 5000 }],
      }),
    );
    prisma.fusionReceiptMethod.findFirst.mockResolvedValueOnce({
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Cash', amount: 100 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 100 }],
      }),
    );
    prisma.fusionReceiptMethod.findFirst.mockResolvedValueOnce({
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

  it('returns no journal headers when journalMeta is null', async () => {
    prisma.serviceProviderJournalMeta.findFirst.mockResolvedValueOnce(null);
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.journalHeaders).toHaveLength(0);
  });

  it('builds journal header when journalMeta is present and there are invoice lines', async () => {
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
      makeBackup({
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 100 }],
      }),
    );
    prisma.serviceProviderJournalMeta.findFirst.mockResolvedValueOnce({
      ledgerId: 1001,
      jeSource: 'Odoo',
      jeCategory: 'Sales',
      chartOfAccountsId: 2,
      company: '01',
      account: '4000',
      department: null,
    });
    const result = await service.buildOrderPayloads(
      'backup-001',
      'CCNTRBHR',
      'AE',
    );
    expect(result.journalHeaders).toHaveLength(1);
    expect(result.journalHeaders[0].ledgerId).toBe(1001);
    expect(result.journalHeaders[0].journalLines).toHaveLength(1);
  });

  // ── transactionNumberOverride ─────────────────────────────────────────────

  it('uses transactionNumberOverride when provided', async () => {
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Cash', amount: 50 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 50 }],
      }),
    );
    prisma.fusionReceiptMethod.findFirst.mockResolvedValueOnce({
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
    prisma.backupOdooOrder.findUnique.mockResolvedValueOnce(
      makeBackup({
        orderPayments: [{ paymentName: 'Cash Rounding', amount: 0.05 }],
        orderLines: [{ productName: 'Item', qty: 1, priceUnit: 100 }],
      }),
    );
    prisma.fusionReceiptMethod.findFirst.mockResolvedValueOnce({
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
});
