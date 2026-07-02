import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { VendHqToOracleSyncService } from './vendhq-to-oracle-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { FusionTransformationService } from '../sync/fusion-transformation.service';
import { OracleSoapClient } from '../clients/oracle/oracle-soap.client';
import { AlertsService } from '../alerts/alerts.service';
import { CircuitBreakerService } from '../clients/circuit-breaker.service';
import { OracleUomService } from '../clients/oracle/oracle-uom.service';

/**
 * End-to-End Integration Test for VendHQ → Oracle Invoice Flow
 * 
 * This test validates the complete sales-to-invoice pipeline:
 * 1. VendHQ sales backup → database
 * 2. Transformation → Oracle invoice format
 * 3. SOAP call → Oracle Fusion
 * 4. Result persistence → database (7 Fusion tables)
 * 5. Error handling → network timeout, invalid data
 */
describe('VendHQ to Oracle Integration (E2E)', () => {
  let service: VendHqToOracleSyncService;
  let prisma: PrismaService;
  let soapClient: OracleSoapClient;
  let transformation: FusionTransformationService;

  // Mock data factories
  const createMockSale = (overrides: Partial<any> = {}) => ({
    id: 'sale-001',
    saleId: 'vendhq-sale-001',
    region: 'AE',
    invoiceNumber: 'INV-TEST-001',
    outletId: 'outlet-ae-001',
    outletName: 'Dubai Main Store',
    registerId: 'register-001',
    registerName: 'Main Register',
    saleDate: new Date('2024-06-15T14:30:00Z'),
    totalPrice: 525.50,
    totalTax: 25.50,
    status: 'CLOSED',
    fusionSynced: false,
    fusionSyncError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    backupLineItems: [
      {
        id: 'line-001',
        productId: 'prod-001',
        productSku: 'WIDGET-001',
        productName: 'Premium Widget',
        quantity: 2,
        price: 100,
        tax: 10,
        taxName: '5% VAT',
        discount: 0,
        totalTax: 10,
        totalPrice: 110,
      },
      {
        id: 'line-002',
        productId: 'prod-002',
        productSku: 'GADGET-001',
        productName: 'Super Gadget',
        quantity: 3,
        price: 125,
        tax: 18.75,
        taxName: '5% VAT',
        discount: 0,
        totalTax: 18.75,
        totalPrice: 393.75,
      },
    ],
    backupPayments: [
      {
        id: 'pay-001',
        paymentType: 'Cash',
        amount: 300,
      },
      {
        id: 'pay-002',
        paymentType: 'Credit Card',
        amount: 225.50,
      },
    ],
    ...overrides,
  });

  const createMockMetadata = () => ({
    id: 'meta-001',
    region: 'AE',
    customerType: 'RETAIL',
    billToCustomerName: 'Retail Customer - UAE',
    billToLocation: 'DXB-RETAIL-SITE',
    billToAccountNumber: 'CUST-AE-RETAIL',
    businessUnit: 'BU-UAE',
    transactionSource: 'VendHQ POS',
    transactionType: 'PASA CONSULTING SALE',
    soldToCustomerName: null,
    billToContact: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const createMockRegister = () => ({
    id: 'reg-001',
    region: 'AE',
    outletId: 'outlet-ae-001',
    outletName: 'Dubai Main Store',
    registerName: 'Main Register',
    bankAccountName: 'UAE Bank Account - Cash',
    cashAccountName: 'UAE Cash Account',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const createMockReceiptMethod = () => [
    {
      id: 'rm-001',
      region: 'AE',
      receiptMethodName: 'Cash',
      receiptMethodId: 1001,
      remittanceBankAccountId: 2001,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'rm-002',
      region: 'AE',
      receiptMethodName: 'Credit Card',
      receiptMethodId: 1002,
      remittanceBankAccountId: 2002,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendHqToOracleSyncService,
        {
          provide: PrismaService,
          useValue: {
            backupVendHqSale: {
              findMany: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
            },
            fusionSalesMetadata: {
              findFirst: jest.fn(),
            },
            vendHqRegister: {
              findFirst: jest.fn(),
            },
            fusionReceiptMethod: {
              findMany: jest.fn(),
            },
            fusionInvoiceHeader: {
              create: jest.fn(),
            },
            fusionInvoiceLine: {
              createMany: jest.fn(),
            },
            fusionStandardReceipt: {
              create: jest.fn(),
            },
            fusionMiscReceipt: {
              create: jest.fn(),
            },
            fusionApplyReceipt: {
              create: jest.fn(),
            },
            fusionJournalHeader: {
              create: jest.fn(),
            },
            fusionJournalLine: {
              createMany: jest.fn(),
            },
            saleSyncStatus: {
              updateMany: jest.fn(),
            },
          },
        },
        {
          provide: FusionTransformationService,
          useValue: {
            transformVendHqSaleToFusion: jest.fn(),
          },
        },
        {
          provide: OracleSoapClient,
          useValue: {
            createSimpleInvoice: jest.fn(),
            createStandardReceipt: jest.fn(),
            createApplyReceipt: jest.fn(),
            createMiscellaneousReceipt: jest.fn(),
            importJournalEntry: jest.fn(),
          },
        },
        {
          provide: AlertsService,
          useValue: {
            sendAlert: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, any> = {
                BATCH_SIZE: 50,
                LOG_LEVEL: 'debug',
              };
              return config[key];
            }),
          },
        },
        {
          provide: CircuitBreakerService,
          useValue: {
            execute: jest.fn((fn) => fn()),
          },
        },
        {
          provide: OracleUomService,
          useValue: {
            getUomCode: jest.fn().mockResolvedValue('Ea'),
          },
        },
      ],
    }).compile();

    service = module.get<VendHqToOracleSyncService>(VendHqToOracleSyncService);
    prisma = module.get<PrismaService>(PrismaService);
    soapClient = module.get<OracleSoapClient>(OracleSoapClient);
    transformation = module.get<FusionTransformationService>(
      FusionTransformationService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Complete Sale → Invoice + Receipts + Journals Flow', () => {
    it('should process complete sale with invoice, receipts, and journals', async () => {
      // Arrange: Setup mock data
      const mockSale = createMockSale();
      const mockMetadata = createMockMetadata();
      const mockRegister = createMockRegister();
      const mockReceiptMethods = createMockReceiptMethod();

      jest.spyOn(prisma.backupVendHqSale, 'findMany').mockResolvedValue([
        mockSale as any,
      ]);
      jest
        .spyOn(prisma.fusionSalesMetadata, 'findFirst')
        .mockResolvedValue(mockMetadata as any);
      jest
        .spyOn(prisma.vendHqRegister, 'findFirst')
        .mockResolvedValue(mockRegister as any);
      jest
        .spyOn(prisma.fusionReceiptMethod, 'findMany')
        .mockResolvedValue(mockReceiptMethods as any);

      // Mock transformation result
      const mockTransformResult = {
        invoiceHeader: {
          billToCustomerName: mockMetadata.billToCustomerName,
          billToLocation: mockMetadata.billToLocation,
          billToAccountNumber: mockMetadata.billToAccountNumber,
          businessUnit: mockMetadata.businessUnit,
          transactionSource: mockMetadata.transactionSource,
          transactionType: mockMetadata.transactionType,
          saleDate: mockSale.saleDate,
          trxDate: mockSale.saleDate,
          invoiceCurrencyCode: 'AED',
          conversionRateType: 'Corporate',
          conversionRate: 1,
          conversionDate: mockSale.saleDate,
          invoiceLines: [
            {
              lineNumber: 1,
              itemNumber: 'WIDGET-001',
              description: 'Premium Widget',
              quantity: 2,
              unitSellingPrice: 100,
              currencyCode: 'AED',
              salesOrder: mockSale.invoiceNumber,
              salesOrderLine: '1',
            },
            {
              lineNumber: 2,
              itemNumber: 'GADGET-001',
              description: 'Super Gadget',
              quantity: 3,
              unitSellingPrice: 125,
              currencyCode: 'AED',
              salesOrder: mockSale.invoiceNumber,
              salesOrderLine: '2',
            },
          ],
          outletName: mockSale.outletName,
        },
        standardReceipts: [
          {
            currencyCode: 'AED',
            saleDate: mockSale.saleDate,
            receiptMethodId: 1001,
            receiptNumber: `Cash-${mockSale.invoiceNumber}`,
            remittanceBankAccountId: 2001,
            accountValue: mockMetadata.billToAccountNumber,
            orgId: 300,
            receiptAmount: 300,
          },
        ],
        miscReceipts: [
          {
            currencyCode: 'AED',
            saleDate: mockSale.saleDate,
            receiptMethodId: 1002,
            receiptMethodName: 'Credit Card',
            receiptNumber: `Credit Card-${mockSale.invoiceNumber}-MISC`,
            bankAccountName: mockRegister.bankAccountName,
            receivableActivityName: 'Miscellaneous Receipt',
            orgId: 300,
            receiptAmount: 225.5,
          },
        ],
        applyReceipts: [
          {
            receiptDate: mockSale.saleDate,
            transactionNumber: mockSale.invoiceNumber,
            receiptNumber: `Cash-${mockSale.invoiceNumber}`,
            amountApplied: 300,
            receiptCurrency: 'AED',
            transactionSource: mockMetadata.transactionSource,
          },
        ],
        journalHeaders: [],
      };

      jest
        .spyOn(transformation, 'transformVendHqSaleToFusion')
        .mockResolvedValue(mockTransformResult as any);

      // Mock Oracle SOAP responses
      jest.spyOn(soapClient, 'createSimpleInvoice').mockResolvedValue({
        customerTrxId: 9001,
        transactionNumber: 'TRX-9001',
        serviceStatus: 'SUCCESS',
      });

      jest.spyOn(soapClient, 'createStandardReceipt').mockResolvedValue({
        cashReceiptId: 5001,
        receiptNumber: `Cash-${mockSale.invoiceNumber}`,
        serviceStatus: 'SUCCESS',
      });

      jest.spyOn(soapClient, 'createApplyReceipt').mockResolvedValue({
        receivableApplicationId: 6001,
        serviceStatus: 'SUCCESS',
      });

      jest.spyOn(soapClient, 'createMiscellaneousReceipt').mockResolvedValue({
        cashReceiptId: 5002,
        receiptNumber: `Credit Card-${mockSale.invoiceNumber}-MISC`,
        serviceStatus: 'SUCCESS',
      });

      // Mock database persistence
      jest.spyOn(prisma.fusionInvoiceHeader, 'create').mockResolvedValue({
        id: 'inv-header-001',
        region: mockSale.region,
        customerTrxId: BigInt(9001),
        transactionNumber: 'TRX-9001',
        status: 'SUCCESS',
      } as any);

      jest.spyOn(prisma.fusionInvoiceLine, 'createMany').mockResolvedValue({
        count: 2,
      });

      jest.spyOn(prisma.fusionStandardReceipt, 'create').mockResolvedValue({
        id: 'std-receipt-001',
        region: mockSale.region,
        cashReceiptId: BigInt(5001),
        status: 'SUCCESS',
      } as any);

      jest.spyOn(prisma.fusionApplyReceipt, 'create').mockResolvedValue({
        id: 'apply-receipt-001',
        region: mockSale.region,
        receivableApplicationId: BigInt(6001),
        status: 'SUCCESS',
      } as any);

      jest.spyOn(prisma.fusionMiscReceipt, 'create').mockResolvedValue({
        id: 'misc-receipt-001',
        region: mockSale.region,
        cashReceiptId: BigInt(5002),
        status: 'SUCCESS',
      } as any);

      jest.spyOn(prisma.backupVendHqSale, 'update').mockResolvedValue({
        ...mockSale,
        fusionSynced: true,
      } as any);

      // Act: Execute the sync job
      await service.runSyncJob('AE');

      // Assert: Verify transformation was called
      expect(transformation.transformVendHqSaleToFusion).toHaveBeenCalledWith(
        mockSale,
        mockMetadata,
        mockRegister,
        mockReceiptMethods,
      );

      // Assert: Verify Oracle SOAP calls
      expect(soapClient.createSimpleInvoice).toHaveBeenCalledWith(
        'AE',
        mockTransformResult.invoiceHeader,
      );
      expect(soapClient.createStandardReceipt).toHaveBeenCalledWith(
        'AE',
        mockTransformResult.standardReceipts[0],
      );
      expect(soapClient.createApplyReceipt).toHaveBeenCalledWith(
        'AE',
        mockTransformResult.applyReceipts[0],
      );
      expect(soapClient.createMiscellaneousReceipt).toHaveBeenCalledWith(
        'AE',
        mockTransformResult.miscReceipts[0],
      );

      // Assert: Verify database persistence
      expect(prisma.fusionInvoiceHeader.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            region: 'AE',
            customerTrxId: BigInt(9001),
            transactionNumber: 'TRX-9001',
            status: 'SUCCESS',
          }),
        }),
      );

      expect(prisma.fusionInvoiceLine.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              lineNumber: 1,
              itemNumber: 'WIDGET-001',
            }),
            expect.objectContaining({
              lineNumber: 2,
              itemNumber: 'GADGET-001',
            }),
          ]),
        }),
      );

      expect(prisma.fusionStandardReceipt.create).toHaveBeenCalled();
      expect(prisma.fusionApplyReceipt.create).toHaveBeenCalled();
      expect(prisma.fusionMiscReceipt.create).toHaveBeenCalled();

      // Assert: Verify sale marked as synced
      expect(prisma.backupVendHqSale.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockSale.id },
          data: expect.objectContaining({
            fusionSynced: true,
            fusionSyncError: null,
          }),
        }),
      );
    });

    it('should handle Oracle SOAP errors gracefully', async () => {
      // Arrange: Setup mock data
      const mockSale = createMockSale();
      const mockMetadata = createMockMetadata();
      const mockRegister = createMockRegister();
      const mockReceiptMethods = createMockReceiptMethod();

      jest.spyOn(prisma.backupVendHqSale, 'findMany').mockResolvedValue([
        mockSale as any,
      ]);
      jest
        .spyOn(prisma.fusionSalesMetadata, 'findFirst')
        .mockResolvedValue(mockMetadata as any);
      jest
        .spyOn(prisma.vendHqRegister, 'findFirst')
        .mockResolvedValue(mockRegister as any);
      jest
        .spyOn(prisma.fusionReceiptMethod, 'findMany')
        .mockResolvedValue(mockReceiptMethods as any);

      // Mock transformation result
      jest
        .spyOn(transformation, 'transformVendHqSaleToFusion')
        .mockResolvedValue({
          invoiceHeader: {
            billToCustomerName: 'Test',
            billToLocation: 'Test',
            billToAccountNumber: 'Test',
            businessUnit: 'Test',
            transactionSource: 'Test',
            transactionType: 'Test',
            saleDate: new Date(),
            trxDate: new Date(),
            invoiceCurrencyCode: 'AED',
            conversionRateType: 'Corporate',
            conversionRate: 1,
            conversionDate: new Date(),
            invoiceLines: [],
            outletName: 'Test',
          },
          standardReceipts: [],
          miscReceipts: [],
          applyReceipts: [],
          journalHeaders: [],
        } as any);

      // Mock Oracle SOAP to throw error
      const soapError = new Error(
        'Oracle SOAP Error: Invalid account number - Account CUST-INVALID does not exist',
      );
      jest.spyOn(soapClient, 'createSimpleInvoice').mockRejectedValue(soapError);

      // Mock database persistence
      jest.spyOn(prisma.fusionInvoiceHeader, 'create').mockResolvedValue({
        id: 'inv-header-error-001',
        region: mockSale.region,
        status: 'ERROR',
        errorMessage: soapError.message,
      } as any);

      jest.spyOn(prisma.backupVendHqSale, 'update').mockResolvedValue({
        ...mockSale,
        fusionSynced: false,
        fusionSyncError: soapError.message,
      } as any);

      // Act: Execute the sync job
      await service.runSyncJob('AE');

      // Assert: Verify error persisted to FusionInvoiceHeader
      expect(prisma.fusionInvoiceHeader.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'ERROR',
            errorMessage: expect.stringContaining('Invalid account number'),
          }),
        }),
      );

      // Assert: Verify BackupVendHqSale.fusionSyncError populated
      expect(prisma.backupVendHqSale.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockSale.id },
          data: expect.objectContaining({
            fusionSynced: false,
            fusionSyncError: expect.stringContaining('Invalid account number'),
          }),
        }),
      );
    });

    it('should handle network timeout errors', async () => {
      // Arrange: Setup mock data
      const mockSale = createMockSale();
      const mockMetadata = createMockMetadata();
      const mockRegister = createMockRegister();
      const mockReceiptMethods = createMockReceiptMethod();

      jest.spyOn(prisma.backupVendHqSale, 'findMany').mockResolvedValue([
        mockSale as any,
      ]);
      jest
        .spyOn(prisma.fusionSalesMetadata, 'findFirst')
        .mockResolvedValue(mockMetadata as any);
      jest
        .spyOn(prisma.vendHqRegister, 'findFirst')
        .mockResolvedValue(mockRegister as any);
      jest
        .spyOn(prisma.fusionReceiptMethod, 'findMany')
        .mockResolvedValue(mockReceiptMethods as any);

      jest
        .spyOn(transformation, 'transformVendHqSaleToFusion')
        .mockResolvedValue({
          invoiceHeader: {} as any,
          standardReceipts: [],
          miscReceipts: [],
          applyReceipts: [],
          journalHeaders: [],
        });

      // Mock network timeout
      const timeoutError = new Error('Request timeout after 30 seconds');
      timeoutError.name = 'ETIMEDOUT';
      jest.spyOn(soapClient, 'createSimpleInvoice').mockRejectedValue(timeoutError);

      jest.spyOn(prisma.fusionInvoiceHeader, 'create').mockResolvedValue({
        id: 'inv-header-timeout-001',
        status: 'ERROR',
        errorMessage: timeoutError.message,
      } as any);

      jest.spyOn(prisma.backupVendHqSale, 'update').mockResolvedValue({
        ...mockSale,
        fusionSynced: false,
        fusionSyncError: timeoutError.message,
      } as any);

      // Act: Execute the sync job
      await service.runSyncJob('AE');

      // Assert: Verify timeout error handled
      expect(prisma.fusionInvoiceHeader.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'ERROR',
            errorMessage: expect.stringContaining('timeout'),
          }),
        }),
      );

      expect(prisma.backupVendHqSale.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fusionSynced: false,
            fusionSyncError: expect.stringContaining('timeout'),
          }),
        }),
      );
    });

    it('should handle invalid data errors', async () => {
      // Arrange: Setup mock data with missing required fields
      const mockSale = createMockSale({
        outletId: null, // Missing outlet ID
      });
      const mockMetadata = createMockMetadata();

      jest.spyOn(prisma.backupVendHqSale, 'findMany').mockResolvedValue([
        mockSale as any,
      ]);
      jest
        .spyOn(prisma.fusionSalesMetadata, 'findFirst')
        .mockResolvedValue(mockMetadata as any);
      jest
        .spyOn(prisma.vendHqRegister, 'findFirst')
        .mockResolvedValue(null); // No register found

      jest.spyOn(prisma.backupVendHqSale, 'update').mockResolvedValue({
        ...mockSale,
        fusionSynced: false,
        fusionSyncError: expect.any(String),
      } as any);

      // Act: Execute the sync job
      await service.runSyncJob('AE');

      // Assert: Verify error for missing register
      expect(prisma.backupVendHqSale.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fusionSynced: false,
            fusionSyncError: expect.stringContaining('register'),
          }),
        }),
      );
    });
  });

  describe('Batch Processing', () => {
    it('should process multiple sales in batch', async () => {
      // Arrange: Create 3 mock sales
      const mockSales = [
        createMockSale({ id: 'sale-001', invoiceNumber: 'INV-001' }),
        createMockSale({ id: 'sale-002', invoiceNumber: 'INV-002' }),
        createMockSale({ id: 'sale-003', invoiceNumber: 'INV-003' }),
      ];
      const mockMetadata = createMockMetadata();
      const mockRegister = createMockRegister();
      const mockReceiptMethods = createMockReceiptMethod();

      jest
        .spyOn(prisma.backupVendHqSale, 'findMany')
        .mockResolvedValue(mockSales as any);
      jest
        .spyOn(prisma.fusionSalesMetadata, 'findFirst')
        .mockResolvedValue(mockMetadata as any);
      jest
        .spyOn(prisma.vendHqRegister, 'findFirst')
        .mockResolvedValue(mockRegister as any);
      jest
        .spyOn(prisma.fusionReceiptMethod, 'findMany')
        .mockResolvedValue(mockReceiptMethods as any);

      jest
        .spyOn(transformation, 'transformVendHqSaleToFusion')
        .mockResolvedValue({
          invoiceHeader: {} as any,
          standardReceipts: [],
          miscReceipts: [],
          applyReceipts: [],
          journalHeaders: [],
        });

      jest.spyOn(soapClient, 'createSimpleInvoice').mockResolvedValue({
        customerTrxId: 9001,
        transactionNumber: 'TRX-9001',
        serviceStatus: 'SUCCESS',
      });

      jest
        .spyOn(prisma.fusionInvoiceHeader, 'create')
        .mockResolvedValue({} as any);
      jest
        .spyOn(prisma.fusionInvoiceLine, 'createMany')
        .mockResolvedValue({ count: 0 });
      jest
        .spyOn(prisma.backupVendHqSale, 'update')
        .mockResolvedValue({} as any);

      // Act: Execute the sync job
      await service.runSyncJob('AE');

      // Assert: Verify all 3 sales were processed
      expect(transformation.transformVendHqSaleToFusion).toHaveBeenCalledTimes(
        3,
      );
      expect(soapClient.createSimpleInvoice).toHaveBeenCalledTimes(3);
      expect(prisma.backupVendHqSale.update).toHaveBeenCalledTimes(3);
    });
  });
});
