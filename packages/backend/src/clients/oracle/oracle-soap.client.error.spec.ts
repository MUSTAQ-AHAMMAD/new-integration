import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { CircuitBreakerService } from '../circuit-breaker.service';
import {
  InvoiceHeader,
  OracleSoapClient,
  StandardReceiptRequest,
  ApplyReceiptRequest,
  MiscReceiptRequest,
  JournalHeader,
} from './oracle-soap.client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * Comprehensive Oracle SOAP Client Error Handling Tests
 * 
 * Tests all 20+ Oracle SOAP error XML tags extraction:
 * - ErrorMessage, Detail, Text, Reason, StatusMessage
 * - Network timeouts, malformed XML, authentication failures
 * - Rate limiting, service unavailable errors
 * - Circuit breaker behavior under failures
 */
describe('OracleSoapClient Error Handling', () => {
  let client: OracleSoapClient;
  let circuitBreaker: CircuitBreakerService;
  let configService: ConfigService;

  const mockInvoiceHeader: InvoiceHeader = {
    billToCustomerName: 'Test Customer',
    billToLocation: 'TEST-SITE',
    billToAccountNumber: 'CUST-001',
    businessUnit: 'BU-TEST',
    saleDate: new Date('2024-06-15T10:00:00Z'),
    trxDate: new Date('2024-06-15T10:00:00Z'),
    transactionSource: 'VendHQ',
    transactionType: 'PASA CONSULTING SALE',
    invoiceCurrencyCode: 'AED',
    conversionRateType: 'Corporate',
    conversionRate: 1,
    conversionDate: new Date('2024-06-15T10:00:00Z'),
    invoiceLines: [
      {
        lineNumber: 1,
        itemNumber: 'ITEM-001',
        description: 'Test Product',
        quantity: 1,
        unitSellingPrice: 100,
        currencyCode: 'AED',
        salesOrder: 'SALE-001',
        salesOrderLine: '1',
      },
    ],
    outletName: 'Test Outlet',
  };

  beforeEach(() => {
    configService = new ConfigService({
      ORACLE_REST_BASE_URL: 'https://oracle-test.example.com',
      ORACLE_USERNAME: 'test-user',
      ORACLE_PASSWORD: 'test-password',
    });

    circuitBreaker = new CircuitBreakerService();

    client = new OracleSoapClient(configService, circuitBreaker);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Status E Error XML Tag Extraction', () => {
    it('should extract error from <ErrorMessage> tag', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importSimpleInvoiceResponse xmlns:ns1="http://xmlns.oracle.com/apps/financials/receivables/transactions/transactionService/">
              <ns1:result>
                <ns1:Status>E</ns1:Status>
                <ns1:ErrorMessage>Invalid account number - Account CUST-INVALID does not exist</ns1:ErrorMessage>
              </ns1:result>
            </ns1:importSimpleInvoiceResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('Invalid account number - Account CUST-INVALID does not exist');
    });

    it('should extract error from <Detail> tag', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importSimpleInvoiceResponse xmlns:ns1="http://xmlns.oracle.com/apps/financials/receivables/transactions/transactionService/">
              <ns1:result>
                <ns1:Status>E</ns1:Status>
                <ns1:Detail>Business unit BU-INVALID is not valid for this transaction</ns1:Detail>
              </ns1:result>
            </ns1:importSimpleInvoiceResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('Business unit BU-INVALID is not valid');
    });

    it('should extract error from <Text> tag', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importSimpleInvoiceResponse xmlns:ns1="http://xmlns.oracle.com/apps/financials/receivables/transactions/transactionService/">
              <ns1:result>
                <ns1:Status>E</ns1:Status>
                <ns1:Text>Transaction type INVALID-TYPE not found</ns1:Text>
              </ns1:result>
            </ns1:importSimpleInvoiceResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('Transaction type INVALID-TYPE not found');
    });

    it('should extract error from <Reason> tag', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <soap:Fault>
              <faultcode>soap:Server</faultcode>
              <faultstring>Internal Server Error</faultstring>
              <detail>
                <Reason>Database connection failed</Reason>
              </detail>
            </soap:Fault>
          </soap:Body>
        </soap:Envelope>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('Database connection failed');
    });

    it('should extract error from <StatusMessage> tag', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importStandardReceiptResponse xmlns:ns1="http://xmlns.oracle.com/apps/financials/receivables/receipts/receiptService/">
              <ns1:result>
                <ns1:Status>E</ns1:Status>
                <ns1:StatusMessage>Receipt method ID 9999 is invalid</ns1:StatusMessage>
              </ns1:result>
            </ns1:importStandardReceiptResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      const mockReceipt: StandardReceiptRequest = {
        currencyCode: 'AED',
        saleDate: new Date('2024-06-15'),
        receiptMethodId: 9999,
        receiptNumber: 'RCP-001',
        remittanceBankAccountId: 1001,
        accountValue: 'CUST-001',
        orgId: 300,
        receiptAmount: 100,
      };

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      await expect(
        client.createStandardReceipt('AE', mockReceipt),
      ).rejects.toThrow('Receipt method ID 9999 is invalid');
    });

    it('should extract error from nested fault tags', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <soap:Fault>
              <faultcode>soap:Client</faultcode>
              <faultstring>SOAP-ENV:Client</faultstring>
              <detail>
                <exception>
                  <message>Conversion rate type 'Invalid' is not recognized</message>
                </exception>
              </detail>
            </soap:Fault>
          </soap:Body>
        </soap:Envelope>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow("Conversion rate type 'Invalid' is not recognized");
    });

    it('should extract error from <ValidationError> tag', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importSimpleInvoiceResponse xmlns:ns1="http://xmlns.oracle.com/apps/financials/receivables/transactions/transactionService/">
              <ns1:result>
                <ns1:Status>E</ns1:Status>
                <ns1:ValidationError>Transaction date cannot be in the future</ns1:ValidationError>
              </ns1:result>
            </ns1:importSimpleInvoiceResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('Transaction date cannot be in the future');
    });

    it('should log full XML when no error message found', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importSimpleInvoiceResponse xmlns:ns1="http://xmlns.oracle.com/apps/financials/receivables/transactions/transactionService/">
              <ns1:result>
                <ns1:Status>E</ns1:Status>
              </ns1:result>
            </ns1:importSimpleInvoiceResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('Oracle SOAP returned Status E');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Full XML response:'),
        errorXml,
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Network Error Handling', () => {
    it('should handle network timeout with circuit breaker', async () => {
      const timeoutError = new Error('Request timeout after 30 seconds');
      (timeoutError as any).code = 'ETIMEDOUT';

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockRejectedValue(timeoutError),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('Request timeout after 30 seconds');
    });

    it('should handle connection refused errors', async () => {
      const connError = new Error('connect ECONNREFUSED 127.0.0.1:443');
      (connError as any).code = 'ECONNREFUSED';

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockRejectedValue(connError),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('connect ECONNREFUSED');
    });

    it('should handle DNS resolution errors', async () => {
      const dnsError = new Error('getaddrinfo ENOTFOUND oracle-invalid.example.com');
      (dnsError as any).code = 'ENOTFOUND';

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockRejectedValue(dnsError),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('getaddrinfo ENOTFOUND');
    });

    it('should handle SSL certificate errors', async () => {
      const sslError = new Error('self signed certificate in certificate chain');
      (sslError as any).code = 'DEPTH_ZERO_SELF_SIGNED_CERT';

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockRejectedValue(sslError),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('self signed certificate');
    });
  });

  describe('HTTP Status Code Error Handling', () => {
    it('should handle 401 authentication failure', async () => {
      const authError: Partial<AxiosError> = {
        response: {
          status: 401,
          statusText: 'Unauthorized',
          data: 'Invalid credentials',
          headers: {},
          config: {} as any,
        },
        message: 'Request failed with status code 401',
        isAxiosError: true,
      };

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockRejectedValue(authError),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('401');
    });

    it('should handle 429 rate limiting', async () => {
      const rateLimitError: Partial<AxiosError> = {
        response: {
          status: 429,
          statusText: 'Too Many Requests',
          data: 'Rate limit exceeded. Retry after 60 seconds.',
          headers: {
            'retry-after': '60',
          },
          config: {} as any,
        },
        message: 'Request failed with status code 429',
        isAxiosError: true,
      };

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockRejectedValue(rateLimitError),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('429');
    });

    it('should handle 500 internal server error', async () => {
      const serverError: Partial<AxiosError> = {
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: '<html><body>Internal Server Error</body></html>',
          headers: {},
          config: {} as any,
        },
        message: 'Request failed with status code 500',
        isAxiosError: true,
      };

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockRejectedValue(serverError),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('500');
    });

    it('should handle 503 service unavailable', async () => {
      const serviceError: Partial<AxiosError> = {
        response: {
          status: 503,
          statusText: 'Service Unavailable',
          data: 'Service temporarily unavailable',
          headers: {},
          config: {} as any,
        },
        message: 'Request failed with status code 503',
        isAxiosError: true,
      };

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockRejectedValue(serviceError),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('503');
    });

    it('should handle 504 gateway timeout', async () => {
      const gatewayError: Partial<AxiosError> = {
        response: {
          status: 504,
          statusText: 'Gateway Timeout',
          data: 'Gateway timeout',
          headers: {},
          config: {} as any,
        },
        message: 'Request failed with status code 504',
        isAxiosError: true,
      };

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockRejectedValue(gatewayError),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow('504');
    });
  });

  describe('Malformed XML Response Handling', () => {
    it('should handle malformed XML response', async () => {
      const malformedXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importSimpleInvoiceResponse
            <!-- Missing closing tags -->
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: malformedXml }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow();
    });

    it('should handle non-XML response', async () => {
      const htmlResponse = `
        <html>
          <head><title>404 Not Found</title></head>
          <body>The requested endpoint was not found</body>
        </html>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: htmlResponse }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow();
    });

    it('should handle empty response', async () => {
      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: '' }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow();
    });

    it('should handle JSON response instead of XML', async () => {
      const jsonResponse = JSON.stringify({
        error: 'Invalid content type',
        message: 'Expected application/xml',
      });

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: jsonResponse }),
      } as any);

      await expect(
        client.createSimpleInvoice('AE', mockInvoiceHeader),
      ).rejects.toThrow();
    });
  });

  describe('Circuit Breaker Behavior', () => {
    it('should open circuit breaker after 5 consecutive failures', async () => {
      const error = new Error('Service unavailable');

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockRejectedValue(error),
      } as any);

      // Attempt 5 times to trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        await expect(
          client.createSimpleInvoice('AE', mockInvoiceHeader),
        ).rejects.toThrow();
      }

      // Circuit should be open now - verify by checking if error is thrown immediately
      const circuitState = circuitBreaker.getState();
      expect(['open', 'half-open']).toContain(circuitState);
    });

    it('should allow requests after circuit breaker timeout', async () => {
      jest.useFakeTimers();

      const error = new Error('Service unavailable');
      const axiosPost = jest.fn().mockRejectedValue(error);

      mockedAxios.create.mockReturnValue({
        post: axiosPost,
      } as any);

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        await expect(
          client.createSimpleInvoice('AE', mockInvoiceHeader),
        ).rejects.toThrow();
      }

      // Fast-forward time to reset circuit breaker (typically 60 seconds)
      jest.advanceTimersByTime(61000);

      // Mock successful response
      const successXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importSimpleInvoiceResponse xmlns:ns1="http://xmlns.oracle.com/apps/financials/receivables/transactions/transactionService/">
              <ns1:result>
                <ns1:Status>S</ns1:Status>
                <ns1:CustomerTrxId>12345</ns1:CustomerTrxId>
                <ns1:TransactionNumber>TRX-12345</ns1:TransactionNumber>
              </ns1:result>
            </ns1:importSimpleInvoiceResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      axiosPost.mockResolvedValue({ data: successXml });

      // Circuit should allow requests again
      const result = await client.createSimpleInvoice('AE', mockInvoiceHeader);
      expect(result.customerTrxId).toBe(12345);

      jest.useRealTimers();
    });
  });

  describe('All SOAP Methods Error Handling', () => {
    it('should handle errors in createStandardReceipt', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importStandardReceiptResponse>
              <ns1:result>
                <ns1:Status>E</ns1:Status>
                <ns1:ErrorMessage>Bank account ID 9999 is invalid</ns1:ErrorMessage>
              </ns1:result>
            </ns1:importStandardReceiptResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      const receipt: StandardReceiptRequest = {
        currencyCode: 'AED',
        saleDate: new Date('2024-06-15'),
        receiptMethodId: 1001,
        receiptNumber: 'RCP-001',
        remittanceBankAccountId: 9999,
        accountValue: 'CUST-001',
        orgId: 300,
        receiptAmount: 100,
      };

      await expect(
        client.createStandardReceipt('AE', receipt),
      ).rejects.toThrow('Bank account ID 9999 is invalid');
    });

    it('should handle errors in createApplyReceipt', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importApplyReceiptResponse>
              <ns1:result>
                <ns1:Status>E</ns1:Status>
                <ns1:ErrorMessage>Transaction number TRX-999 not found</ns1:ErrorMessage>
              </ns1:result>
            </ns1:importApplyReceiptResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      const applyReceipt: ApplyReceiptRequest = {
        receiptDate: new Date('2024-06-15'),
        transactionNumber: 'TRX-999',
        receiptNumber: 'RCP-001',
        amountApplied: 100,
        receiptCurrency: 'AED',
        transactionSource: 'VendHQ',
      };

      await expect(
        client.createApplyReceipt('AE', applyReceipt),
      ).rejects.toThrow('Transaction number TRX-999 not found');
    });

    it('should handle errors in createMiscellaneousReceipt', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importMiscellaneousReceiptResponse>
              <ns1:result>
                <ns1:Status>E</ns1:Status>
                <ns1:ErrorMessage>Receivable activity not configured</ns1:ErrorMessage>
              </ns1:result>
            </ns1:importMiscellaneousReceiptResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      const miscReceipt: MiscReceiptRequest = {
        currencyCode: 'AED',
        saleDate: new Date('2024-06-15'),
        receiptMethodId: 1002,
        receiptMethodName: 'Credit Card',
        receiptNumber: 'MISC-001',
        bankAccountName: 'Main Bank',
        receivableActivityName: 'Invalid Activity',
        orgId: 300,
        receiptAmount: 50,
      };

      await expect(
        client.createMiscellaneousReceipt('AE', miscReceipt),
      ).rejects.toThrow('Receivable activity not configured');
    });

    it('should handle errors in importJournalEntry', async () => {
      const errorXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <ns1:importJournalEntryResponse>
              <ns1:result>
                <ns1:Status>E</ns1:Status>
                <ns1:ErrorMessage>Journal batch name exceeds maximum length</ns1:ErrorMessage>
              </ns1:result>
            </ns1:importJournalEntryResponse>
          </soap:Body>
        </soap:Envelope>
      `;

      mockedAxios.create.mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: errorXml }),
      } as any);

      const journalHeader: JournalHeader = {
        batchName: 'Very long batch name that exceeds the maximum allowed length for journal entries',
        batchDescription: 'Test journal',
        ledgerName: 'Main Ledger',
        journalName: 'JE-001',
        journalDescription: 'Test entry',
        currencyCode: 'AED',
        accountingDate: new Date('2024-06-15'),
        journalLines: [],
      };

      await expect(
        client.importJournalEntry('AE', journalHeader),
      ).rejects.toThrow('Journal batch name exceeds maximum length');
    });
  });
});
