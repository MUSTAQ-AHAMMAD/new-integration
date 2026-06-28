import { FusionTransformationService } from './fusion-transformation.service';
import { PrismaService } from '../prisma/prisma.service';
import { OracleUomService } from '../clients/oracle/oracle-uom.service';
import { OracleTaxService } from '../clients/oracle/oracle-tax.service';
import { OracleCustomerService } from '../clients/oracle/oracle-customer.service';

// ---------------------------------------------------------------------------
// Minimal fake DB records
// ---------------------------------------------------------------------------

function makeSale(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sale-1',
    saleNumber: 'SALE-001',
    invoiceNumber: 'SALE-001',
    outletId: 'outlet-1',
    outletName: 'Dubai Store',
    saleDate: new Date('2024-01-15T10:00:00Z'),
    rawJson: {},
    backupLineItems: [
      {
        id: 'li-1',
        productId: 'ITEM-001',
        productName: 'Product A',
        quantity: 2,
        totalPrice: 100,
      },
    ],
    backupPayments: [
      {
        id: 'pmt-1',
        paymentMethod: 'Cash',
        amount: 100,
      },
    ],
    ...overrides,
  };
}

function makeOutlet(overrides: Record<string, unknown> = {}) {
  return {
    outletId: 'outlet-1',
    region: 'AE',
    currency: 'AED',
    ...overrides,
  };
}

function makeRegister(overrides: Record<string, unknown> = {}) {
  return {
    registerName: '',
    cashAccountId: 201n,
    bankAccountId: 202n,
    cashAccount: 'Cash Account',
    bankAccount: 'Bank Account',
    outletId: 'outlet-1',
    region: 'AE',
    ...overrides,
  };
}

function makeRegisters(overrides: Record<string, unknown> = {}) {
  return [makeRegister(overrides)];
}

function makeSalesMeta(overrides: Record<string, unknown> = {}) {
  return {
    id: 'meta-1',
    customerType: 'NORMAL',
    region: 'AE',
    billToName: 'Walk-In Customer',
    billToAccount: 99001,
    siteNumber: 'SITE-001',
    businessUnit: 'UAE BU',
    txnSource: 'VendHQ',
    txnType: 'PASA CONSULTING SALE',
    rateIsCorporate: true,
    costCenterCode: 'CC001',
    recActivityNameBank: 'Bank Charges',
    recActivityNameCash: 'Cash Rounding',
    ...overrides,
  };
}

function makeBuMap() {
  return { region: 'AE', businessUnitId: 300 };
}

function makeReceiptMethod(
  name: string,
  isCash: boolean,
  overrides: Record<string, unknown> = {},
) {
  return {
    receiptMethodName: name,
    region: 'AE',
    receiptMethodId: isCash ? 101 : 102,
    receiptIsCash: isCash,
    receiptBankCharge: 0.015,
    receiptMethodTax: 0.05,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock PrismaService
// ---------------------------------------------------------------------------

function buildMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    backupVendHqSale: {
      findUnique: jest.fn(),
    },
    vendHqOutlet: {
      findFirst: jest.fn(),
    },
    vendHqRegister: {
      findMany: jest.fn(),
    },
    fusionSalesMetadata: {
      findFirst: jest.fn(),
    },
    fusionBusinessUnitMap: {
      findFirst: jest.fn(),
    },
    serviceProviderJournalMeta: {
      findFirst: jest.fn(),
    },
    fusionReceiptMethod: {
      findFirst: jest.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers to set up default happy-path mocks
// ---------------------------------------------------------------------------

function setupDefaultMocks(
  mockPrisma: ReturnType<typeof buildMockPrisma>,
  salePatch: Record<string, unknown> = {},
) {
  mockPrisma.backupVendHqSale.findUnique.mockResolvedValue(makeSale(salePatch));
  mockPrisma.vendHqOutlet.findFirst.mockResolvedValue(makeOutlet());
  mockPrisma.vendHqRegister.findMany.mockResolvedValue(makeRegisters());
  mockPrisma.fusionSalesMetadata.findFirst.mockResolvedValue(makeSalesMeta());
  mockPrisma.fusionBusinessUnitMap.findFirst.mockResolvedValue(makeBuMap());
  mockPrisma.serviceProviderJournalMeta.findFirst.mockResolvedValue(null);
  mockPrisma.fusionReceiptMethod.findFirst.mockResolvedValue(
    makeReceiptMethod('Cash', true),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FusionTransformationService', () => {
  let service: FusionTransformationService;
  let mockPrisma: ReturnType<typeof buildMockPrisma>;
  let mockUomService: jest.Mocked<OracleUomService>;
  let mockTaxService: jest.Mocked<OracleTaxService>;
  let mockCustomerService: jest.Mocked<OracleCustomerService>;

  beforeEach(() => {
    mockPrisma = buildMockPrisma();
    
    // Mock the Oracle enrichment services
    mockUomService = {
      getUomCode: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<OracleUomService>;
    
    mockTaxService = {
      getTaxClassificationCode: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<OracleTaxService>;
    
    mockCustomerService = {
      getCustomerId: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<OracleCustomerService>;
    
    service = new FusionTransformationService(
      mockPrisma as unknown as PrismaService,
      mockUomService,
      mockTaxService,
      mockCustomerService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Sale not found ──────────────────────────────────────────

  it('throws when sale is not found', async () => {
    mockPrisma.backupVendHqSale.findUnique.mockResolvedValue(null);

    await expect(service.buildSalePayloads('missing-id', 'AE')).rejects.toThrow(
      'BackupVendHqSale not found: missing-id',
    );
  });

  it('throws when FusionSalesMetadata is not found', async () => {
    mockPrisma.backupVendHqSale.findUnique.mockResolvedValue(makeSale());
    mockPrisma.vendHqOutlet.findFirst.mockResolvedValue(makeOutlet());
    mockPrisma.fusionSalesMetadata.findFirst.mockResolvedValue(null);
    mockPrisma.fusionBusinessUnitMap.findFirst.mockResolvedValue(makeBuMap());
    mockPrisma.serviceProviderJournalMeta.findFirst.mockResolvedValue(null);

    await expect(service.buildSalePayloads('sale-1', 'AE')).rejects.toThrow(
      'FusionSalesMetadata not found',
    );
  });

  // ── InvoiceHeader mapping ───────────────────────────────────

  describe('InvoiceHeader', () => {
    it('maps billToCustomerName from salesMeta', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.billToCustomerName).toBe('Walk-In Customer');
    });

    it('maps billToAccountNumber from salesMeta', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.billToAccountNumber).toBe('99001');
    });

    it('maps transactionType from salesMeta', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.transactionType).toBe('PASA CONSULTING SALE');
    });

    it('uses outlet currency for invoiceCurrencyCode', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.invoiceCurrencyCode).toBe('AED');
    });

    it('falls back to AED when outlet has no currency', async () => {
      setupDefaultMocks(mockPrisma);
      mockPrisma.vendHqOutlet.findFirst.mockResolvedValue(
        makeOutlet({ currency: null }),
      );

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.invoiceCurrencyCode).toBe('AED');
    });

    it('sets conversionRateType to Corporate when rateIsCorporate is true', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.conversionRateType).toBe('Corporate');
    });

    it('sets conversionRateType to User when rateIsCorporate is false', async () => {
      setupDefaultMocks(mockPrisma);
      mockPrisma.fusionSalesMetadata.findFirst.mockResolvedValue(
        makeSalesMeta({ rateIsCorporate: false }),
      );

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.conversionRateType).toBe('User');
    });

    it('uses transactionNumberOverride for applyReceipts when provided', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads(
        'sale-1',
        'AE',
        'INV-OVERRIDE-001',
      );

      expect(result.applyReceipts[0]?.transactionNumber).toBe(
        'INV-OVERRIDE-001',
      );
    });
  });

  // ── InvoiceLines mapping ────────────────────────────────────

  describe('InvoiceLines', () => {
    it('builds one invoice line per sale line item', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.invoiceLines).toHaveLength(1);
    });

    it('calculates unitSellingPrice as |totalPrice / quantity|', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      const line = result.invoiceHeader.invoiceLines[0];
      expect(line.unitSellingPrice).toBe(50); // 100 / 2
      expect(line.quantity).toBe(2);
    });

    it('skips line items with zero quantity', async () => {
      setupDefaultMocks(mockPrisma, {
        backupLineItems: [
          {
            id: 'li-zero',
            productId: 'P001',
            productName: 'Zero Qty',
            quantity: 0,
            totalPrice: 0,
          },
          {
            id: 'li-1',
            productId: 'ITEM-001',
            productName: 'Product A',
            quantity: 2,
            totalPrice: 100,
          },
        ],
      });

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.invoiceLines).toHaveLength(1);
      expect(result.invoiceHeader.invoiceLines[0].itemNumber).toBe('ITEM-001');
    });

    it('maps Discount Item as memo line without itemNumber', async () => {
      setupDefaultMocks(mockPrisma, {
        backupLineItems: [
          {
            id: 'li-disc',
            productId: 'DISC-001',
            productName: 'Discount Item',
            quantity: -1,
            totalPrice: -10,
          },
        ],
      });

      const result = await service.buildSalePayloads('sale-1', 'AE');

      const discLine = result.invoiceHeader.invoiceLines[0];
      expect(discLine.memoLineName).toBe('Discount Item');
    });

    it('forces Discount Item quantity to 1 when totalPrice is positive', async () => {
      setupDefaultMocks(mockPrisma, {
        backupLineItems: [
          {
            id: 'li-disc',
            productId: 'DISC-001',
            productName: 'Discount Item',
            quantity: 5,
            totalPrice: 50,
          },
        ],
      });

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.invoiceLines[0].quantity).toBe(1);
    });

    it('assigns sequential line numbers starting at 1', async () => {
      setupDefaultMocks(mockPrisma, {
        backupLineItems: [
          {
            id: 'li-1',
            productId: 'ITEM-001',
            productName: 'Product A',
            quantity: 1,
            totalPrice: 50,
          },
          {
            id: 'li-2',
            productId: 'ITEM-002',
            productName: 'Product B',
            quantity: 2,
            totalPrice: 60,
          },
        ],
        backupPayments: [],
      });

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.invoiceHeader.invoiceLines[0].lineNumber).toBe(1);
      expect(result.invoiceHeader.invoiceLines[1].lineNumber).toBe(2);
    });
  });

  // ── StandardReceipts ────────────────────────────────────────

  describe('StandardReceipts', () => {
    it('creates one standard receipt per cash payment', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.standardReceipts).toHaveLength(1);
      expect(result.standardReceipts[0].receiptNumber).toBe('Cash-SALE-001');
    });

    it('skips "Credit on Cust" payment method', async () => {
      setupDefaultMocks(mockPrisma, {
        backupPayments: [
          { id: 'pmt-1', paymentMethod: 'credit on cust', amount: 100 },
        ],
      });

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.standardReceipts).toHaveLength(0);
    });

    it('uses cash account id for cash payments', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.standardReceipts[0].remittanceBankAccountId).toBe(201);
    });

    it('warns and skips when receipt method is not configured', async () => {
      setupDefaultMocks(mockPrisma);
      mockPrisma.fusionReceiptMethod.findFirst.mockResolvedValue(null);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.standardReceipts).toHaveLength(0);
    });

    it('throws when bank account is not configured for non-cash payment', async () => {
      setupDefaultMocks(mockPrisma, {
        backupPayments: [
          { id: 'pmt-2', paymentMethod: 'Credit Card', amount: 50 },
        ],
      });
      mockPrisma.fusionReceiptMethod.findFirst.mockResolvedValue(
        makeReceiptMethod('Credit Card', false),
      );
      mockPrisma.vendHqRegister.findMany.mockResolvedValue([
        makeRegister({
          registerName: '',
          cashAccountId: null,
          bankAccountId: null,
          cashAccount: '',
          bankAccount: '',
        }),
      ]);

      await expect(service.buildSalePayloads('sale-1', 'AE')).rejects.toThrow(
        'Bank/cash account not configured',
      );
    });
  });

  // ── MiscReceipts ────────────────────────────────────────────

  describe('MiscReceipts', () => {
    it('creates a misc receipt for non-cash payment (bank charges)', async () => {
      setupDefaultMocks(mockPrisma, {
        backupPayments: [
          { id: 'pmt-2', paymentMethod: 'Credit Card', amount: 100 },
        ],
      });
      mockPrisma.fusionReceiptMethod.findFirst.mockResolvedValue(
        makeReceiptMethod('Credit Card', false, { bankAccountId: 202n }),
      );
      mockPrisma.vendHqRegister.findMany.mockResolvedValue([
        makeRegister({
          registerName: '',
          cashAccountId: 201n,
          bankAccountId: 202n,
          cashAccount: 'Cash Acc',
          bankAccount: 'Bank Acc',
        }),
      ]);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.miscReceipts).toHaveLength(1);
      expect(result.miscReceipts[0].receiptNumber).toBe(
        'Credit Card-SALE-001-MISC',
      );
      expect(result.miscReceipts[0].receiptAmount).toBeLessThan(0);
    });

    it('caps misc receipt at 10 for Debit Card in OM region', async () => {
      setupDefaultMocks(mockPrisma, {
        backupPayments: [
          { id: 'pmt-3', paymentMethod: 'Debit Card', amount: 1000 },
        ],
      });
      mockPrisma.fusionReceiptMethod.findFirst.mockResolvedValue(
        makeReceiptMethod('Debit Card', false, {
          receiptBankCharge: 0.02,
          receiptMethodTax: 0.05,
          bankAccountId: 202n,
        }),
      );
      mockPrisma.vendHqOutlet.findFirst.mockResolvedValue(
        makeOutlet({ currency: 'OMR' }),
      );
      mockPrisma.vendHqRegister.findMany.mockResolvedValue([
        makeRegister({
          registerName: '',
          cashAccountId: 201n,
          bankAccountId: 202n,
          cashAccount: 'Cash',
          bankAccount: 'Bank',
        }),
      ]);

      const result = await service.buildSalePayloads('sale-1', 'OM');

      const miscAmount = Math.abs(result.miscReceipts[0].receiptAmount);
      expect(miscAmount).toBe(10);
    });

    it('creates misc receipt for cash rounding', async () => {
      setupDefaultMocks(mockPrisma, {
        backupPayments: [
          { id: 'pmt-cr', paymentMethod: 'Cash Rounding', amount: 0.05 },
        ],
      });
      mockPrisma.fusionReceiptMethod.findFirst.mockResolvedValue(
        makeReceiptMethod('Cash Rounding', true),
      );

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.miscReceipts).toHaveLength(1);
      expect(result.miscReceipts[0].receivableActivityName).toBe(
        'Cash Rounding',
      );
      expect(result.miscReceipts[0].receiptAmount).toBe(-0.05);
    });
  });

  // ── ApplyReceipts ───────────────────────────────────────────

  describe('ApplyReceipts', () => {
    it('creates one apply receipt per standard receipt', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.applyReceipts).toHaveLength(1);
    });

    it('sets amountApplied equal to receipt amount', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.applyReceipts[0].amountApplied).toBe(100);
    });

    it('links apply receipt to correct receipt number', async () => {
      setupDefaultMocks(mockPrisma);

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.applyReceipts[0].receiptNumber).toBe(
        result.standardReceipts[0].receiptNumber,
      );
    });
  });

  // ── JournalHeaders (non-NORMAL customers) ──────────────────

  describe('JournalHeaders', () => {
    const journalMeta = {
      region: 'AE',
      ledgerId: 1001,
      jeSource: 'Vend',
      jeCategory: 'Vend',
      chartOfAccountsId: 500,
      company: '101',
      account: '1200',
      department: null,
    };

    it('does NOT create journal entries for NORMAL customer type', async () => {
      setupDefaultMocks(mockPrisma);
      mockPrisma.serviceProviderJournalMeta.findFirst.mockResolvedValue(
        journalMeta,
      );

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.journalHeaders).toHaveLength(0);
    });

    it('creates journal entries for non-NORMAL customer type', async () => {
      setupDefaultMocks(mockPrisma, { rawJson: { customer_code: 'SERVICE' } });
      mockPrisma.fusionSalesMetadata.findFirst.mockResolvedValue(
        makeSalesMeta({ customerType: 'SERVICE' }),
      );
      mockPrisma.serviceProviderJournalMeta.findFirst.mockResolvedValue(
        journalMeta,
      );

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.journalHeaders).toHaveLength(1);
      expect(result.journalHeaders[0].ledgerId).toBe(1001);
    });

    it('creates one journal line per invoice line', async () => {
      setupDefaultMocks(mockPrisma, {
        rawJson: { customer_code: 'SERVICE' },
        backupLineItems: [
          {
            id: 'li-1',
            productId: 'ITEM-001',
            productName: 'Product A',
            quantity: 1,
            totalPrice: 50,
          },
          {
            id: 'li-2',
            productId: 'ITEM-002',
            productName: 'Product B',
            quantity: 2,
            totalPrice: 80,
          },
        ],
      });
      mockPrisma.fusionSalesMetadata.findFirst.mockResolvedValue(
        makeSalesMeta({ customerType: 'SERVICE' }),
      );
      mockPrisma.serviceProviderJournalMeta.findFirst.mockResolvedValue(
        journalMeta,
      );

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.journalHeaders[0].journalLines).toHaveLength(2);
    });

    it('formats accountingPeriodName as Mon-YY', async () => {
      setupDefaultMocks(mockPrisma, {
        rawJson: { customer_code: 'SERVICE' },
        saleDate: new Date('2024-03-05T00:00:00Z'),
      });
      mockPrisma.fusionSalesMetadata.findFirst.mockResolvedValue(
        makeSalesMeta({ customerType: 'SERVICE' }),
      );
      mockPrisma.serviceProviderJournalMeta.findFirst.mockResolvedValue(
        journalMeta,
      );

      const result = await service.buildSalePayloads('sale-1', 'AE');

      expect(result.journalHeaders[0].accountingPeriodName).toBe('Mar-24');
    });
  });

  // ── customerType resolution ─────────────────────────────────

  describe('customerType resolution from rawJson', () => {
    it('uses customer_code from rawJson if present', async () => {
      setupDefaultMocks(mockPrisma, {
        rawJson: { customer_code: 'WHOLESALE' },
      });
      mockPrisma.fusionSalesMetadata.findFirst.mockResolvedValue(
        makeSalesMeta({ customerType: 'WHOLESALE' }),
      );

      await service.buildSalePayloads('sale-1', 'AE');

      const call = mockPrisma.fusionSalesMetadata.findFirst.mock
        .calls[0][0] as {
        where: { customerType: string };
      };
      expect(call.where.customerType).toBe('WHOLESALE');
    });

    it('falls back to NORMAL when rawJson has no customer_code or customer_type', async () => {
      setupDefaultMocks(mockPrisma, { rawJson: {} });

      await service.buildSalePayloads('sale-1', 'AE');

      const call = mockPrisma.fusionSalesMetadata.findFirst.mock
        .calls[0][0] as {
        where: { customerType: string };
      };
      expect(call.where.customerType).toBe('NORMAL');
    });
  });
});
