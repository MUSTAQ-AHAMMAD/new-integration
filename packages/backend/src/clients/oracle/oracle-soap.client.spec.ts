import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { CircuitBreakerService } from '../circuit-breaker.service';
import {
  ApplyReceiptRequest,
  InvoiceHeader,
  JournalHeader,
  MiscReceiptRequest,
  OracleSoapClient,
  StandardReceiptRequest,
} from './oracle-soap.client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeInvoiceHeader(
  overrides: Partial<InvoiceHeader> = {},
): InvoiceHeader {
  return {
    billToCustomerName: 'Test Customer',
    billToLocation: 'DXB-SITE',
    billToAccountNumber: 'CUST-001',
    businessUnit: 'BU-UAE',
    saleDate: new Date('2024-01-15T10:00:00Z'),
    trxDate: new Date('2024-01-15T10:00:00Z'),
    transactionSource: 'VendHQ',
    transactionType: 'PASA CONSULTING SALE',
    invoiceCurrencyCode: 'AED',
    conversionRateType: 'Corporate',
    conversionRate: 1,
    conversionDate: new Date('2024-01-15T10:00:00Z'),
    invoiceLines: [
      {
        lineNumber: 1,
        itemNumber: 'ITEM-001',
        description: 'Product A',
        quantity: 2,
        unitSellingPrice: 50,
        currencyCode: 'AED',
        salesOrder: 'SALE-001',
        salesOrderLine: '1',
      },
    ],
    ...overrides,
  };
}

function makeStandardReceiptRequest(
  overrides: Partial<StandardReceiptRequest> = {},
): StandardReceiptRequest {
  return {
    currencyCode: 'AED',
    saleDate: new Date('2024-01-15T10:00:00Z'),
    receiptMethodId: 101,
    receiptNumber: 'Cash-SALE-001',
    remittanceBankAccountId: 201,
    accountValue: 'CUST-001',
    orgId: 300,
    receiptAmount: 100,
    ...overrides,
  };
}

function makeApplyReceiptRequest(
  overrides: Partial<ApplyReceiptRequest> = {},
): ApplyReceiptRequest {
  return {
    receiptDate: new Date('2024-01-15T10:00:00Z'),
    transactionNumber: 'SALE-001',
    receiptNumber: 'Cash-SALE-001',
    amountApplied: 100,
    receiptCurrency: 'AED',
    transactionSource: 'VendHQ',
    ...overrides,
  };
}

function makeMiscReceiptRequest(
  overrides: Partial<MiscReceiptRequest> = {},
): MiscReceiptRequest {
  return {
    currencyCode: 'AED',
    saleDate: new Date('2024-01-15T10:00:00Z'),
    receiptMethodId: 102,
    receiptMethodName: 'Credit Card',
    receiptNumber: 'Credit Card-SALE-001-MISC',
    bankAccountName: 'Main Bank',
    receivableActivityName: 'Bank Charges',
    orgId: 300,
    receiptAmount: -2.5,
    ...overrides,
  };
}

function makeJournalHeader(
  overrides: Partial<JournalHeader> = {},
): JournalHeader {
  return {
    batchName: 'Jan-24: SERVICE',
    batchDescription: 'Journal Import: SALE-001',
    ledgerId: 1001,
    accountingPeriodName: 'Jan-24',
    accountingDate: new Date('2024-01-15T10:00:00Z'),
    userSourceName: 'Vend',
    userCategoryName: 'Vend',
    errorToSuspenseFlag: false,
    summaryFlag: false,
    journalLines: [
      {
        ledgerId: 1001,
        accountingDate: new Date('2024-01-15T10:00:00Z'),
        userJeSourceName: 'Vend',
        jeCategoryName: 'Vend',
        currencyCode: 'AED',
        enteredCrAmount: 100,
        accountedCr: 100,
        currencyConversionRate: 1,
        currencyConversionType: 'Corporate',
        currencyConversionDate: new Date('2024-01-15T10:00:00Z'),
        transactionDate: new Date('2024-01-15T10:00:00Z'),
        status: 'P',
        taxCode: 'N',
      },
    ],
    ...overrides,
  };
}

function buildSuccessXml(tags: Record<string, string>): string {
  const body = Object.entries(tags)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('\n');
  return `<soapenv:Envelope><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

function buildFaultXml(message: string): string {
  return `<soapenv:Envelope><soapenv:Body><soapenv:Fault><faultcode>Server</faultcode><faultstring>${message}</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`;
}

describe('OracleSoapClient', () => {
  let client: OracleSoapClient;
  let mockHttpPost: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();

    const mockAxiosInstance = {
      post: jest.fn(),
    };
    mockHttpPost = mockAxiosInstance.post;

    mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);

    const configService = {
      get: jest.fn().mockImplementation((key: string, fallback?: string) => {
        const map: Record<string, string> = {
          ORACLE_SOAP_BASE_URL: 'https://oracle.example.com',
          ORACLE_USERNAME: 'testuser',
          ORACLE_PASSWORD: 'testpass',
        };
        return map[key] ?? fallback ?? '';
      }),
    } as unknown as ConfigService;

    const circuitBreaker = new CircuitBreakerService();

    client = new OracleSoapClient(configService, circuitBreaker);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── createSimpleInvoice ────────────────────────────────────────

  describe('createSimpleInvoice', () => {
    it('creates an invoice and returns parsed response', async () => {
      const successXml = buildSuccessXml({
        ServiceStatus: 'SUCCESS',
        TransactionNumber: 'INV-001',
        CustomerTrxId: 'TRX-9001',
      });
      mockHttpPost.mockResolvedValueOnce({ data: successXml });

      const result = await client.createSimpleInvoice(makeInvoiceHeader());

      expect(result.serviceStatus).toBe('SUCCESS');
      expect(result.transactionNumber).toBe('INV-001');
      expect(result.customerTrxId).toBe('TRX-9001');
    });

    it('sends the correct SOAP endpoint and SOAPAction', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ TransactionNumber: 'INV-001' }),
      });

      await client.createSimpleInvoice(makeInvoiceHeader());

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/fscmService/RecInvoiceService',
        expect.stringContaining('createSimpleInvoice'),
        expect.objectContaining({
          headers: expect.objectContaining({
            SOAPAction: expect.stringContaining('createSimpleInvoice'),
          }),
        }),
      );
    });

    it('includes customer name and account number in the SOAP envelope', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ TransactionNumber: 'INV-001' }),
      });

      await client.createSimpleInvoice(makeInvoiceHeader());

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toContain('Test Customer');
      expect(soapBody).toContain('CUST-001');
    });

    it('escapes special XML characters in customer name', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ TransactionNumber: 'INV-001' }),
      });

      await client.createSimpleInvoice(
        makeInvoiceHeader({ billToCustomerName: 'Customer & Sons <LLC>' }),
      );

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toContain('Customer &amp; Sons &lt;LLC&gt;');
    });

    it('throws on SOAP fault', async () => {
      const faultXml = buildFaultXml('InvalidCustomer');
      mockHttpPost.mockResolvedValue({ data: faultXml });

      const promise = client.createSimpleInvoice(makeInvoiceHeader());
      const assertion = expect(promise).rejects.toThrow(
        'Oracle SOAP fault [createSimpleInvoice]',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('retries on network failure and succeeds on third attempt', async () => {
      const successXml = buildSuccessXml({ TransactionNumber: 'INV-001' });

      mockHttpPost
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce({ data: successXml });

      const promise = client.createSimpleInvoice(makeInvoiceHeader());

      // Advance timers for exponential back-off (5s + 10s)
      await jest.runAllTimersAsync();

      const result = await promise;

      expect(mockHttpPost).toHaveBeenCalledTimes(3);
      expect(result.transactionNumber).toBe('INV-001');
    });

    it('throws after exhausting all retries', async () => {
      mockHttpPost.mockRejectedValue(new Error('persistent failure'));

      const promise = client.createSimpleInvoice(makeInvoiceHeader());
      const assertion = expect(promise).rejects.toThrow('persistent failure');
      await jest.runAllTimersAsync();
      await assertion;
      expect(mockHttpPost).toHaveBeenCalledTimes(3);
    });

    it('throws on Status E with standard ErrorMessage tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        TransactionNumber: 'INV-ERR',
        ErrorMessage: 'Invalid customer account',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createSimpleInvoice(makeInvoiceHeader());
      const assertion = expect(promise).rejects.toThrow(
        'Oracle invoice creation failed with Status E: Invalid customer account',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with Detail tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        TransactionNumber: 'INV-ERR',
        Detail: 'Payment terms not found for customer',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createSimpleInvoice(makeInvoiceHeader());
      const assertion = expect(promise).rejects.toThrow(
        'Payment terms not found for customer',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with Text tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        TransactionNumber: 'INV-ERR',
        Text: 'Business unit validation failed',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createSimpleInvoice(makeInvoiceHeader());
      const assertion = expect(promise).rejects.toThrow(
        'Business unit validation failed',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with no error message tags', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        TransactionNumber: 'INV-ERR',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createSimpleInvoice(makeInvoiceHeader());
      const assertion = expect(promise).rejects.toThrow(
        'Oracle returned Status E without error details',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('uses invoiceHeaderInformation wrapper in SOAP envelope', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ TransactionNumber: 'INV-001' }),
      });

      await client.createSimpleInvoice(makeInvoiceHeader());

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toContain('<typ:invoiceHeaderInformation>');
      expect(soapBody).toContain('</typ:invoiceHeaderInformation>');
      expect(soapBody).not.toContain('<typ:invoice>');
    });

    it('includes unitCode attribute in Quantity field', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ TransactionNumber: 'INV-001' }),
      });

      await client.createSimpleInvoice(makeInvoiceHeader());

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toMatch(/<typ1:Quantity unitCode="Ea">2<\/typ1:Quantity>/);
    });

    it('includes currencyCode attribute in UnitSellingPrice field', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ TransactionNumber: 'INV-001' }),
      });

      await client.createSimpleInvoice(makeInvoiceHeader());

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toMatch(/<typ1:UnitSellingPrice currencyCode="AED">50<\/typ1:UnitSellingPrice>/);
    });

    it('uses custom uomCode when provided', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ TransactionNumber: 'INV-001' }),
      });

      await client.createSimpleInvoice(
        makeInvoiceHeader({
          invoiceLines: [
            {
              lineNumber: 1,
              itemNumber: 'ITEM-001',
              quantity: 5,
              uomCode: 'Box',
              unitSellingPrice: 100,
              currencyCode: 'SAR',
              salesOrder: 'SALE-001',
            },
          ],
        }),
      );

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toMatch(/<typ1:Quantity unitCode="Box">5<\/typ1:Quantity>/);
    });

    it('prioritizes MemoLineName over ItemNumber for discount items', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ TransactionNumber: 'INV-001' }),
      });

      await client.createSimpleInvoice(
        makeInvoiceHeader({
          invoiceLines: [
            {
              lineNumber: 1,
              itemNumber: 'ITEM-001',
              memoLineName: 'Discount Item',
              quantity: 1,
              unitSellingPrice: -10,
              currencyCode: 'SAR',
              salesOrder: 'SALE-001',
            },
          ],
        }),
      );

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toContain('<typ1:MemoLineName>Discount Item</typ1:MemoLineName>');
      expect(soapBody).not.toContain('<typ1:ItemNumber>ITEM-001</typ1:ItemNumber>');
    });

    it('uses ItemNumber when MemoLineName is not provided', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ TransactionNumber: 'INV-001' }),
      });

      await client.createSimpleInvoice(makeInvoiceHeader());

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toContain('<typ1:ItemNumber>ITEM-001</typ1:ItemNumber>');
      expect(soapBody).not.toContain('<typ1:MemoLineName>');
    });
  });

  // ── createStandardReceipt ─────────────────────────────────────

  describe('createStandardReceipt', () => {
    it('creates a standard receipt and returns receipt number', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({
          ReceiptNumber: 'Cash-SALE-001',
          CustomerReceiptReference: 'REF-001',
        }),
      });

      const result = await client.createStandardReceipt(
        makeStandardReceiptRequest(),
      );

      expect(result.receiptNumber).toBe('Cash-SALE-001');
      expect(result.customerReceiptReference).toBe('REF-001');
    });

    it('sends request to StandardReceiptService endpoint', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ ReceiptNumber: 'REC-001' }),
      });

      await client.createStandardReceipt(makeStandardReceiptRequest());

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/fscmService/StandardReceiptService',
        expect.any(String),
        expect.any(Object),
      );
    });

    it('throws on SOAP fault', async () => {
      mockHttpPost.mockResolvedValue({
        data: buildFaultXml('ReceiptMethodNotFound'),
      });

      const promise = client.createStandardReceipt(
        makeStandardReceiptRequest(),
      );
      const assertion = expect(promise).rejects.toThrow(
        'Oracle SOAP fault [createStandardReceipt]',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with ErrorMessage tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'REC-ERR',
        ErrorMessage: 'Invalid receipt method',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createStandardReceipt(
        makeStandardReceiptRequest(),
      );
      const assertion = expect(promise).rejects.toThrow(
        'Oracle standard receipt creation failed with Status E: Invalid receipt method',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with Detail tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'REC-ERR',
        Detail: 'Bank account not found',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createStandardReceipt(
        makeStandardReceiptRequest(),
      );
      const assertion = expect(promise).rejects.toThrow(
        'Bank account not found',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with Text tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'REC-ERR',
        Text: 'Receipt amount validation failed',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createStandardReceipt(
        makeStandardReceiptRequest(),
      );
      const assertion = expect(promise).rejects.toThrow(
        'Receipt amount validation failed',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with no error message tags', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'REC-ERR',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createStandardReceipt(
        makeStandardReceiptRequest(),
      );
      const assertion = expect(promise).rejects.toThrow(
        'Oracle returned Status E without error details',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });
  });

  // ── createApplyReceipt ────────────────────────────────────────

  describe('createApplyReceipt', () => {
    it('applies a receipt and returns transaction and receipt numbers', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({
          CustomerTrxId: 'TRX-001',
          ReceiptNumber: 'Cash-SALE-001',
        }),
      });

      const result = await client.createApplyReceipt(makeApplyReceiptRequest());

      expect(result.customerTrxId).toBe('TRX-001');
      expect(result.receiptNumber).toBe('Cash-SALE-001');
    });

    it('includes transaction number in SOAP body', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ ReceiptNumber: 'Cash-SALE-001' }),
      });

      await client.createApplyReceipt(makeApplyReceiptRequest());

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toContain('SALE-001');
    });

    it('throws on Status E with ErrorMessage tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'REC-ERR',
        CustomerTrxId: 'TRX-ERR',
        ErrorMessage: 'Transaction not found',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createApplyReceipt(makeApplyReceiptRequest());
      const assertion = expect(promise).rejects.toThrow(
        'Oracle apply receipt creation failed with Status E: Transaction not found',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with Detail tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'REC-ERR',
        Detail: 'Amount exceeds invoice balance',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createApplyReceipt(makeApplyReceiptRequest());
      const assertion = expect(promise).rejects.toThrow(
        'Amount exceeds invoice balance',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with Text tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'REC-ERR',
        Text: 'Currency mismatch',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createApplyReceipt(makeApplyReceiptRequest());
      const assertion = expect(promise).rejects.toThrow('Currency mismatch');
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with no error message tags', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'REC-ERR',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createApplyReceipt(makeApplyReceiptRequest());
      const assertion = expect(promise).rejects.toThrow(
        'Oracle returned Status E without error details',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });
  });

  // ── createMiscellaneousReceipt ────────────────────────────────

  describe('createMiscellaneousReceipt', () => {
    it('creates a misc receipt and returns transaction id', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({
          ReceivablesTransactionId: 'MISC-001',
          ReceiptNumber: 'Credit Card-SALE-001-MISC',
        }),
      });

      const result = await client.createMiscellaneousReceipt(
        makeMiscReceiptRequest(),
      );

      expect(result.receivablesTransactionId).toBe('MISC-001');
      expect(result.receiptNumber).toBe('Credit Card-SALE-001-MISC');
    });

    it('sends a negative receipt amount for bank charges', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ ReceiptNumber: 'Credit Card-SALE-001-MISC' }),
      });

      await client.createMiscellaneousReceipt(
        makeMiscReceiptRequest({ receiptAmount: -2.5 }),
      );

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toContain('-2.5');
    });

    it('throws on Status E with ErrorMessage tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'MISC-ERR',
        ErrorMessage: 'Invalid receivable activity',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createMiscellaneousReceipt(
        makeMiscReceiptRequest(),
      );
      const assertion = expect(promise).rejects.toThrow(
        'Oracle misc receipt creation failed with Status E: Invalid receivable activity',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with Detail tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'MISC-ERR',
        Detail: 'Bank account not configured for this business unit',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createMiscellaneousReceipt(
        makeMiscReceiptRequest(),
      );
      const assertion = expect(promise).rejects.toThrow(
        'Bank account not configured for this business unit',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with Text tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'MISC-ERR',
        Text: 'Receipt method not found',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createMiscellaneousReceipt(
        makeMiscReceiptRequest(),
      );
      const assertion = expect(promise).rejects.toThrow(
        'Receipt method not found',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with no error message tags', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ReceiptNumber: 'MISC-ERR',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.createMiscellaneousReceipt(
        makeMiscReceiptRequest(),
      );
      const assertion = expect(promise).rejects.toThrow(
        'Oracle returned Status E without error details',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });
  });

  // ── importJournalEntry ────────────────────────────────────────

  describe('importJournalEntry', () => {
    it('imports a journal and returns the jeHeaderId', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ result: '42' }),
      });

      const result = await client.importJournalEntry(makeJournalHeader());

      expect(result).toBe(42);
    });

    it('returns null when result tag is missing', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({}),
      });

      const result = await client.importJournalEntry(makeJournalHeader());

      expect(result).toBeNull();
    });

    it('sends request to JournalImportService endpoint', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ result: '1' }),
      });

      await client.importJournalEntry(makeJournalHeader());

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/fscmService/JournalImportService',
        expect.any(String),
        expect.any(Object),
      );
    });

    it('throws on Status E with ErrorMessage tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        ErrorMessage: 'Invalid accounting date',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.importJournalEntry(makeJournalHeader());
      const assertion = expect(promise).rejects.toThrow(
        'Oracle journal import failed with Status E: Invalid accounting date',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with Detail tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        Detail: 'Accounting period is closed',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.importJournalEntry(makeJournalHeader());
      const assertion = expect(promise).rejects.toThrow(
        'Accounting period is closed',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with Text tag', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
        Text: 'Invalid ledger ID',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.importJournalEntry(makeJournalHeader());
      const assertion = expect(promise).rejects.toThrow('Invalid ledger ID');
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('throws on Status E with no error message tags', async () => {
      const errorXml = buildSuccessXml({
        ServiceStatus: 'E',
      });
      mockHttpPost.mockResolvedValue({ data: errorXml });

      const promise = client.importJournalEntry(makeJournalHeader());
      const assertion = expect(promise).rejects.toThrow(
        'Oracle returned Status E without error details',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });
  });

  // ── getCustomerProfile ────────────────────────────────────────

  describe('getCustomerProfile', () => {
    it('returns customer account id and payment terms', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({
          CustomerAccountId: '12345',
          PaymentTerms: 'NET30',
        }),
      });

      const result = await client.getCustomerProfile('CUST-001');

      expect(result.customerAccountId).toBe(12345);
      expect(result.paymentTermsName).toBe('NET30');
    });

    it('defaults payment terms to IMMEDIATE when tag is missing', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ CustomerAccountId: '99' }),
      });

      const result = await client.getCustomerProfile('CUST-001');

      expect(result.paymentTermsName).toBe('IMMEDIATE');
    });

    it('throws on SOAP fault', async () => {
      mockHttpPost.mockResolvedValue({
        data: buildFaultXml('CustomerNotFound'),
      });

      const promise = client.getCustomerProfile('UNKNOWN');
      const assertion = expect(promise).rejects.toThrow(
        'Oracle SOAP fault [getActiveCustomerProfile]',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });
  });
});
