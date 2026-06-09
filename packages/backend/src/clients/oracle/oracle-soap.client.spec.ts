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

function makeInvoiceHeader(overrides: Partial<InvoiceHeader> = {}): InvoiceHeader {
  return {
    billToCustomerName: 'Test Customer',
    billToLocation: 'DXB-SITE',
    billToAccountNumber: 'CUST-001',
    businessUnit: 'BU-UAE',
    saleDate: new Date('2024-01-15T10:00:00Z'),
    transactionSource: 'VendHQ',
    transactionType: 'PASA CONSULTING SALE',
    invoiceCurrencyCode: 'AED',
    conversionRateType: 'Corporate',
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
    transactionNumber: 'SALE-001',
    receiptNumber: 'Cash-SALE-001',
    amountApplied: 100,
    receiptCurrency: 'AED',
    transactionSource: 'VendHQ',
    accountingDate: new Date('2024-01-15T10:00:00Z'),
    applicationDate: new Date('2024-01-15T10:00:00Z'),
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

function makeJournalHeader(overrides: Partial<JournalHeader> = {}): JournalHeader {
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

      const result = await client.createStandardReceipt(makeStandardReceiptRequest());

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
      mockHttpPost.mockResolvedValue({ data: buildFaultXml('ReceiptMethodNotFound') });

      const promise = client.createStandardReceipt(makeStandardReceiptRequest());
      const assertion = expect(promise).rejects.toThrow('Oracle SOAP fault [createStandardReceipt]');
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

      const result = await client.createMiscellaneousReceipt(makeMiscReceiptRequest());

      expect(result.receivablesTransactionId).toBe('MISC-001');
      expect(result.receiptNumber).toBe('Credit Card-SALE-001-MISC');
    });

    it('sends a negative receipt amount for bank charges', async () => {
      mockHttpPost.mockResolvedValueOnce({
        data: buildSuccessXml({ ReceiptNumber: 'Credit Card-SALE-001-MISC' }),
      });

      await client.createMiscellaneousReceipt(makeMiscReceiptRequest({ receiptAmount: -2.5 }));

      const soapBody = mockHttpPost.mock.calls[0][1] as string;
      expect(soapBody).toContain('-2.5');
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
      mockHttpPost.mockResolvedValue({ data: buildFaultXml('CustomerNotFound') });

      const promise = client.getCustomerProfile('UNKNOWN');
      const assertion = expect(promise).rejects.toThrow(
        'Oracle SOAP fault [getActiveCustomerProfile]',
      );
      await jest.runAllTimersAsync();
      await assertion;
    });
  });
});
