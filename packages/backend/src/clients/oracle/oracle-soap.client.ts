/**
 * Oracle Fusion SOAP client — TypeScript equivalent of the Java FusionInvoiceClient,
 * FusionReceiptClient, FusionJournalClient, and FusionCustomerProfileClient.
 *
 * All SOAP operations send raw XML envelopes over HTTP Basic Auth, mirroring the
 * Java JAX-WS stubs that were generated from the Oracle Fusion WSDLs.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { CircuitBreakerService } from '../circuit-breaker.service';

// ──────────────────────────────────────────────────────────────
// Domain models (mirrors Java fusion/soap/model/*.java)
// ──────────────────────────────────────────────────────────────

export interface InvoiceLine {
  lineNumber: number;
  itemNumber?: string;
  memoLineName?: string;
  description?: string;
  quantity: number;
  uomCode?: string;
  unitSellingPrice: number;
  currencyCode: string;
  salesOrder: string;
  salesOrderLine?: string;
  taxClassificationCode?: string;
}

export interface InvoiceHeader {
  billToCustomerName: string;
  billToLocation: string;
  billToAccountNumber: string;
  businessUnit: string;
  outletName?: string;
  saleDate: Date;
  paymentTermsName?: string;
  transactionSource: string;
  transactionType: string;
  invoiceCurrencyCode: string;
  conversionRateType: string;
  invoiceLines: InvoiceLine[];
}

export interface InvoiceResponse {
  serviceStatus: string;
  transactionNumber: string;
  customerTrxId: string;
}

export interface StandardReceiptRequest {
  currencyCode: string;
  saleDate: Date;
  receiptMethodId: number;
  receiptNumber: string;
  remittanceBankAccountId: number;
  accountValue: string;
  region?: string;
  orgId: number;
  customerId?: number;
  receiptAmount: number;
}

export interface StandardReceiptResponse {
  receiptNumber: string;
  customerReceiptReference: string;
}

export interface ApplyReceiptRequest {
  transactionNumber: string;
  receiptNumber: string;
  amountApplied: number;
  receiptCurrency: string;
  transactionSource: string;
  accountingDate: Date;
  applicationDate: Date;
}

export interface ApplyReceiptResponse {
  customerTrxId: string;
  receiptNumber: string;
}

export interface MiscReceiptRequest {
  currencyCode: string;
  saleDate: Date;
  receiptMethodId: number;
  receiptMethodName: string;
  receiptNumber: string;
  bankAccountName: string;
  receivableActivityName: string;
  orgId: number;
  receiptAmount: number;
}

export interface MiscReceiptResponse {
  receivablesTransactionId: string;
  receiptNumber: string;
}

export interface JournalLine {
  ledgerId: number;
  periodName?: string;
  accountingDate: Date;
  userJeSourceName: string;
  jeCategoryName: string;
  groupId?: number;
  chartOfAccountsId?: number;
  segment1?: string;
  segment2?: string;
  segment3?: string;
  segment4?: string;
  segment5?: string;
  segment6?: string;
  segment7?: string;
  segment8?: string;
  segment9?: string;
  segment10?: string;
  currencyCode: string;
  enteredDrAmount?: number;
  enteredCrAmount?: number;
  accountedDr?: number;
  accountedCr?: number;
  currencyConversionRate?: number;
  currencyConversionType?: string;
  currencyConversionDate?: Date;
  transactionDate?: Date;
  status?: string;
  taxCode?: string;
}

export interface JournalHeader {
  batchName: string;
  batchDescription?: string;
  ledgerId: number;
  accountingPeriodName: string;
  accountingDate: Date;
  userSourceName: string;
  userCategoryName: string;
  errorToSuspenseFlag?: boolean;
  summaryFlag?: boolean;
  journalLines: JournalLine[];
  jeHeaderId?: number;
}

export interface CustomerProfileResult {
  customerAccountId: number;
  paymentTermsName: string;
}

// ──────────────────────────────────────────────────────────────
// SOAP XML builders
// ──────────────────────────────────────────────────────────────

function xmlDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function xmlDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function opt(tag: string, val: string | number | undefined | null): string {
  if (val === undefined || val === null || val === '') return '';
  return `<typ:${tag}>${val}</typ:${tag}>`;
}

function buildInvoiceSoap(header: InvoiceHeader): string {
  const linesXml = header.invoiceLines
    .map(
      (l) => `
        <typ1:InvoiceLine>
          <typ1:LineNumber>${l.lineNumber}</typ1:LineNumber>
          ${l.itemNumber ? `<typ1:ItemNumber>${l.itemNumber}</typ1:ItemNumber>` : ''}
          ${l.memoLineName ? `<typ1:MemoLineName>${l.memoLineName}</typ1:MemoLineName>` : ''}
          ${l.description ? `<typ1:Description>${escapeXml(l.description)}</typ1:Description>` : ''}
          <typ1:Quantity>${l.quantity}</typ1:Quantity>
          ${l.uomCode ? `<typ1:UOMCode>${l.uomCode}</typ1:UOMCode>` : ''}
          <typ1:UnitSellingPrice>${l.unitSellingPrice}</typ1:UnitSellingPrice>
          <typ1:CurrencyCode>${l.currencyCode}</typ1:CurrencyCode>
          ${l.salesOrder ? `<typ1:SalesOrder>${escapeXml(l.salesOrder)}</typ1:SalesOrder>` : ''}
          ${l.salesOrderLine ? `<typ1:SalesOrderLine>${l.salesOrderLine}</typ1:SalesOrderLine>` : ''}
          ${l.taxClassificationCode ? `<typ1:TaxClassificationCode>${l.taxClassificationCode}</typ1:TaxClassificationCode>` : ''}
        </typ1:InvoiceLine>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:typ="http://xmlns.oracle.com/apps/financials/receivables/transactions/invoices/invoiceService/types/"
  xmlns:typ1="http://xmlns.oracle.com/apps/financials/receivables/transactions/invoices/invoiceService/">
  <soapenv:Header/>
  <soapenv:Body>
    <typ:createSimpleInvoice>
      <typ:invoice>
        <typ1:BillToCustomerName>${escapeXml(header.billToCustomerName)}</typ1:BillToCustomerName>
        <typ1:BillToLocation>${escapeXml(header.billToLocation)}</typ1:BillToLocation>
        <typ1:BillToAccountNumber>${escapeXml(header.billToAccountNumber)}</typ1:BillToAccountNumber>
        <typ1:BusinessUnit>${escapeXml(header.businessUnit)}</typ1:BusinessUnit>
        <typ1:TransactionSource>${escapeXml(header.transactionSource)}</typ1:TransactionSource>
        <typ1:TransactionType>${escapeXml(header.transactionType)}</typ1:TransactionType>
        <typ1:InvoiceCurrencyCode>${header.invoiceCurrencyCode}</typ1:InvoiceCurrencyCode>
        <typ1:ConversionRateType>${header.conversionRateType}</typ1:ConversionRateType>
        ${header.paymentTermsName ? `<typ1:PaymentTermsName>${escapeXml(header.paymentTermsName)}</typ1:PaymentTermsName>` : ''}
        <typ1:GlDate>${xmlDate(header.saleDate)}</typ1:GlDate>
        ${linesXml}
      </typ:invoice>
    </typ:createSimpleInvoice>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildStandardReceiptSoap(req: StandardReceiptRequest): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:typ="http://xmlns.oracle.com/apps/financials/receivables/receipts/shared/standardReceiptService/commonService/types/"
  xmlns:typ1="http://xmlns.oracle.com/apps/financials/receivables/receipts/shared/standardReceiptService/commonService/">
  <soapenv:Header/>
  <soapenv:Body>
    <typ:createStandardReceipt>
      <typ:standardReceipt>
        <typ1:CurrencyCode>${req.currencyCode}</typ1:CurrencyCode>
        <typ1:ReceiptDate>${xmlDate(req.saleDate)}</typ1:ReceiptDate>
        <typ1:ReceiptMethodId>${req.receiptMethodId}</typ1:ReceiptMethodId>
        <typ1:ReceiptNumber>${escapeXml(req.receiptNumber)}</typ1:ReceiptNumber>
        <typ1:RemittanceBankAccountId>${req.remittanceBankAccountId}</typ1:RemittanceBankAccountId>
        <typ1:CustomerAccountNumber>${escapeXml(req.accountValue)}</typ1:CustomerAccountNumber>
        <typ1:BusinessUnitId>${req.orgId}</typ1:BusinessUnitId>
        ${req.customerId ? `<typ1:PayingCustomerPartyId>${req.customerId}</typ1:PayingCustomerPartyId>` : ''}
        <typ1:Amount>${req.receiptAmount}</typ1:Amount>
      </typ:standardReceipt>
    </typ:createStandardReceipt>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildApplyReceiptSoap(req: ApplyReceiptRequest): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:typ="http://xmlns.oracle.com/apps/financials/receivables/receipts/shared/standardReceiptService/commonService/types/"
  xmlns:typ1="http://xmlns.oracle.com/apps/financials/receivables/receipts/shared/standardReceiptService/commonService/">
  <soapenv:Header/>
  <soapenv:Body>
    <typ:createApplyReceipt>
      <typ:applyReceipt>
        <typ1:TransactionNumber>${escapeXml(req.transactionNumber)}</typ1:TransactionNumber>
        <typ1:ReceiptNumber>${escapeXml(req.receiptNumber)}</typ1:ReceiptNumber>
        <typ1:AmountApplied>${req.amountApplied}</typ1:AmountApplied>
        <typ1:ReceiptCurrencyCode>${req.receiptCurrency}</typ1:ReceiptCurrencyCode>
        <typ1:TransactionSource>${escapeXml(req.transactionSource)}</typ1:TransactionSource>
        <typ1:AccountingDate>${xmlDate(req.accountingDate)}</typ1:AccountingDate>
        <typ1:ApplyDate>${xmlDate(req.applicationDate)}</typ1:ApplyDate>
      </typ:applyReceipt>
    </typ:createApplyReceipt>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildMiscReceiptSoap(req: MiscReceiptRequest): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:typ="http://xmlns.oracle.com/apps/financials/receivables/receipts/shared/miscellaneousReceiptService/commonService/types/"
  xmlns:typ1="http://xmlns.oracle.com/apps/financials/receivables/receipts/shared/miscellaneousReceiptService/commonService/">
  <soapenv:Header/>
  <soapenv:Body>
    <typ:createMiscellaneousReceipt>
      <typ:miscellaneousReceipt>
        <typ1:CurrencyCode>${req.currencyCode}</typ1:CurrencyCode>
        <typ1:ReceiptDate>${xmlDate(req.saleDate)}</typ1:ReceiptDate>
        <typ1:ReceiptMethodId>${req.receiptMethodId}</typ1:ReceiptMethodId>
        <typ1:ReceiptMethodName>${escapeXml(req.receiptMethodName)}</typ1:ReceiptMethodName>
        <typ1:ReceiptNumber>${escapeXml(req.receiptNumber)}</typ1:ReceiptNumber>
        <typ1:BankAccountName>${escapeXml(req.bankAccountName)}</typ1:BankAccountName>
        <typ1:ReceivableActivityName>${escapeXml(req.receivableActivityName)}</typ1:ReceivableActivityName>
        <typ1:BusinessUnitId>${req.orgId}</typ1:BusinessUnitId>
        <typ1:Amount>${req.receiptAmount}</typ1:Amount>
      </typ:miscellaneousReceipt>
    </typ:createMiscellaneousReceipt>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildJournalSoap(header: JournalHeader): string {
  const linesXml = header.journalLines
    .map(
      (l) => `
        <typ1:JournalLine>
          <typ1:LedgerId>${l.ledgerId}</typ1:LedgerId>
          ${l.periodName ? `<typ1:PeriodName>${l.periodName}</typ1:PeriodName>` : ''}
          <typ1:AccountingDate>${xmlDate(l.accountingDate)}</typ1:AccountingDate>
          <typ1:UserJeSourceName>${escapeXml(l.userJeSourceName)}</typ1:UserJeSourceName>
          <typ1:JeCategoryName>${escapeXml(l.jeCategoryName)}</typ1:JeCategoryName>
          ${l.groupId !== undefined ? `<typ1:GroupId>${l.groupId}</typ1:GroupId>` : ''}
          ${l.chartOfAccountsId !== undefined ? `<typ1:ChartOfAccountsId>${l.chartOfAccountsId}</typ1:ChartOfAccountsId>` : ''}
          ${opt('Segment1', l.segment1)}
          ${opt('Segment2', l.segment2)}
          ${opt('Segment3', l.segment3)}
          ${opt('Segment4', l.segment4)}
          ${opt('Segment5', l.segment5)}
          ${opt('Segment6', l.segment6)}
          ${opt('Segment7', l.segment7)}
          ${opt('Segment8', l.segment8)}
          ${opt('Segment9', l.segment9)}
          ${opt('Segment10', l.segment10)}
          <typ1:CurrencyCode>${l.currencyCode}</typ1:CurrencyCode>
          ${l.enteredDrAmount !== undefined ? `<typ1:EnteredDr>${l.enteredDrAmount}</typ1:EnteredDr>` : ''}
          ${l.enteredCrAmount !== undefined ? `<typ1:EnteredCr>${l.enteredCrAmount}</typ1:EnteredCr>` : ''}
          ${l.accountedDr !== undefined ? `<typ1:AcctDr>${l.accountedDr}</typ1:AcctDr>` : ''}
          ${l.accountedCr !== undefined ? `<typ1:AcctCr>${l.accountedCr}</typ1:AcctCr>` : ''}
          ${l.currencyConversionRate !== undefined ? `<typ1:CurrencyConversionRate>${l.currencyConversionRate}</typ1:CurrencyConversionRate>` : ''}
          ${l.currencyConversionType ? `<typ1:CurrencyConversionType>${l.currencyConversionType}</typ1:CurrencyConversionType>` : ''}
          ${l.currencyConversionDate ? `<typ1:CurrencyConversionDate>${xmlDate(l.currencyConversionDate)}</typ1:CurrencyConversionDate>` : ''}
          ${l.transactionDate ? `<typ1:TransactionDate>${xmlDate(l.transactionDate)}</typ1:TransactionDate>` : ''}
          ${l.status ? `<typ1:Status>${l.status}</typ1:Status>` : ''}
          ${l.taxCode ? `<typ1:TaxCode>${l.taxCode}</typ1:TaxCode>` : ''}
        </typ1:JournalLine>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:typ="http://xmlns.oracle.com/apps/financials/generalLedger/journals/desktopEntry/journalImportService/types/"
  xmlns:typ1="http://xmlns.oracle.com/apps/financials/generalLedger/journals/desktopEntry/journalImportService/">
  <soapenv:Header/>
  <soapenv:Body>
    <typ:importJournals>
      <typ:journal>
        <typ1:LedgerId>${header.ledgerId}</typ1:LedgerId>
        <typ1:AccountingPeriodName>${escapeXml(header.accountingPeriodName)}</typ1:AccountingPeriodName>
        <typ1:JeBatchName>${escapeXml(header.batchName)}</typ1:JeBatchName>
        ${header.batchDescription ? `<typ1:JeBatchDescription>${escapeXml(header.batchDescription)}</typ1:JeBatchDescription>` : ''}
        <typ1:AccountingDate>${xmlDate(header.accountingDate)}</typ1:AccountingDate>
        <typ1:UserJeSourceName>${escapeXml(header.userSourceName)}</typ1:UserJeSourceName>
        <typ1:JeCategoryName>${escapeXml(header.userCategoryName)}</typ1:JeCategoryName>
        <typ1:ErrorToSuspenseFlag>${header.errorToSuspenseFlag ?? false}</typ1:ErrorToSuspenseFlag>
        <typ1:SummaryJournalFlag>${header.summaryFlag ?? false}</typ1:SummaryJournalFlag>
        ${linesXml}
      </typ:journal>
    </typ:importJournals>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildCustomerProfileSoap(accountNumber: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:typ="http://xmlns.oracle.com/apps/financials/receivables/customers/customerProfileService/types/"
  xmlns:typ1="http://xmlns.oracle.com/apps/financials/receivables/customers/customerProfileService/">
  <soapenv:Header/>
  <soapenv:Body>
    <typ:getActiveCustomerProfile>
      <typ:customerProfile>
        <typ1:AccountNumber>${escapeXml(accountNumber)}</typ1:AccountNumber>
      </typ:customerProfile>
    </typ:getActiveCustomerProfile>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ──────────────────────────────────────────────────────────────
// Simple XML text extractor (avoids pulling in a heavy XML lib)
// ──────────────────────────────────────────────────────────────

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

// ──────────────────────────────────────────────────────────────
// Injectable service
// ──────────────────────────────────────────────────────────────

@Injectable()
export class OracleSoapClient {
  private readonly logger = new Logger(OracleSoapClient.name);
  private readonly http: AxiosInstance;
  private readonly circuitBreaker: CircuitBreakerService;

  constructor(
    private readonly configService: ConfigService,
    @Optional() circuitBreaker?: CircuitBreakerService,
  ) {
    this.circuitBreaker = circuitBreaker ?? new CircuitBreakerService();
    const baseURL = this.configService.get<string>('ORACLE_SOAP_BASE_URL');
    const username = this.configService.get<string>('ORACLE_USERNAME', '');
    const password = this.configService.get<string>('ORACLE_PASSWORD', '');
    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');

    this.http = axios.create({
      baseURL,
      timeout: 60_000,
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        Authorization: `Basic ${basicAuth}`,
      },
    });
  }

  // ── Invoice Service ────────────────────────────────────────

  /**
   * Calls Oracle Fusion RecInvoiceService.createSimpleInvoice
   * WSDL: /fscmService/RecInvoiceService?WSDL
   */
  async createSimpleInvoice(header: InvoiceHeader): Promise<InvoiceResponse> {
    return this.circuitBreaker.execute('oracle:createSimpleInvoice', () =>
      this.withRetries(async () => {
        const body = buildInvoiceSoap(header);
        const resp = await this.http.post(
          '/fscmService/RecInvoiceService',
          body,
          {
            headers: {
              SOAPAction:
                'http://xmlns.oracle.com/apps/financials/receivables/transactions/invoices/invoiceService/createSimpleInvoice',
            },
          },
        );
        const xml = resp.data as string;
        this.assertNoFault(xml, 'createSimpleInvoice');
        const serviceStatus = extractTag(xml, 'ServiceStatus') || extractTag(xml, 'serviceStatus');
        const transactionNumber = extractTag(xml, 'TransactionNumber') || extractTag(xml, 'transactionNumber');
        const customerTrxId = extractTag(xml, 'CustomerTrxId') || extractTag(xml, 'customerTrxId');
        this.logger.log(`Invoice created: txn=${transactionNumber} status=${serviceStatus}`);
        return { serviceStatus, transactionNumber, customerTrxId };
      }),
    );
  }

  // ── Standard Receipt Service ──────────────────────────────

  /**
   * Calls Oracle Fusion StandardReceiptService.createStandardReceipt
   * WSDL: /fscmService/StandardReceiptService?WSDL
   */
  async createStandardReceipt(
    req: StandardReceiptRequest,
  ): Promise<StandardReceiptResponse> {
    return this.circuitBreaker.execute('oracle:createStandardReceipt', () =>
      this.withRetries(async () => {
        const body = buildStandardReceiptSoap(req);
        const resp = await this.http.post(
          '/fscmService/StandardReceiptService',
          body,
          {
            headers: {
              SOAPAction:
                'http://xmlns.oracle.com/apps/financials/receivables/receipts/shared/standardReceiptService/commonService/createStandardReceipt',
            },
          },
        );
        const xml = resp.data as string;
        this.assertNoFault(xml, 'createStandardReceipt');
        const receiptNumber = extractTag(xml, 'ReceiptNumber') || extractTag(xml, 'receiptNumber');
        const customerReceiptReference = extractTag(xml, 'CustomerReceiptReference') || extractTag(xml, 'customerReceiptReference');
        this.logger.log(`Standard receipt created: ${receiptNumber}`);
        return { receiptNumber, customerReceiptReference };
      }),
    );
  }

  /**
   * Calls Oracle Fusion StandardReceiptService.createApplyReceipt
   * WSDL: /fscmService/StandardReceiptService?WSDL
   */
  async createApplyReceipt(
    req: ApplyReceiptRequest,
  ): Promise<ApplyReceiptResponse> {
    return this.circuitBreaker.execute('oracle:createApplyReceipt', () =>
      this.withRetries(async () => {
        const body = buildApplyReceiptSoap(req);
        const resp = await this.http.post(
          '/fscmService/StandardReceiptService',
          body,
          {
            headers: {
              SOAPAction:
                'http://xmlns.oracle.com/apps/financials/receivables/receipts/shared/standardReceiptService/commonService/createApplyReceipt',
            },
          },
        );
        const xml = resp.data as string;
        this.assertNoFault(xml, 'createApplyReceipt');
        const customerTrxId = extractTag(xml, 'CustomerTrxId') || extractTag(xml, 'customerTrxId');
        const receiptNumber = extractTag(xml, 'ReceiptNumber') || extractTag(xml, 'receiptNumber');
        this.logger.log(`Apply receipt created: receipt=${receiptNumber}`);
        return { customerTrxId, receiptNumber };
      }),
    );
  }

  // ── Miscellaneous Receipt Service ─────────────────────────

  /**
   * Calls Oracle Fusion MiscellaneousReceiptService.createMiscellaneousReceipt
   * WSDL: /fscmService/MiscellaneousReceiptService?WSDL
   */
  async createMiscellaneousReceipt(
    req: MiscReceiptRequest,
  ): Promise<MiscReceiptResponse> {
    return this.circuitBreaker.execute('oracle:createMiscellaneousReceipt', () =>
      this.withRetries(async () => {
        const body = buildMiscReceiptSoap(req);
        const resp = await this.http.post(
          '/fscmService/MiscellaneousReceiptService',
          body,
          {
            headers: {
              SOAPAction:
                'http://xmlns.oracle.com/apps/financials/receivables/receipts/shared/miscellaneousReceiptService/commonService/createMiscellaneousReceipt',
            },
          },
        );
        const xml = resp.data as string;
        this.assertNoFault(xml, 'createMiscellaneousReceipt');
        const receivablesTransactionId = extractTag(xml, 'ReceivablesTransactionId') || extractTag(xml, 'receivablesTransactionId');
        const receiptNumber = extractTag(xml, 'ReceiptNumber') || extractTag(xml, 'receiptNumber');
        this.logger.log(`Misc receipt created: ${receiptNumber}`);
        return { receivablesTransactionId, receiptNumber };
      }),
    );
  }

  // ── Journal Import Service ────────────────────────────────

  /**
   * Calls Oracle Fusion JournalImportService.importJournals
   * WSDL: /fscmService/JournalImportService?WSDL
   */
  async importJournalEntry(header: JournalHeader): Promise<number | null> {
    return this.circuitBreaker.execute('oracle:importJournalEntry', () =>
      this.withRetries(async () => {
        const body = buildJournalSoap(header);
        const resp = await this.http.post(
          '/fscmService/JournalImportService',
          body,
          {
            headers: {
              SOAPAction:
                'http://xmlns.oracle.com/apps/financials/generalLedger/journals/desktopEntry/journalImportService/importJournals',
            },
          },
        );
        const xml = resp.data as string;
        this.assertNoFault(xml, 'importJournals');
        const result = extractTag(xml, 'result') || extractTag(xml, 'return');
        const jeHeaderId = result ? parseInt(result, 10) : null;
        this.logger.log(`Journal imported: jeHeaderId=${String(jeHeaderId)}`);
        return isNaN(jeHeaderId ?? NaN) ? null : jeHeaderId;
      }),
    );
  }

  // ── Customer Profile Service ──────────────────────────────

  /**
   * Calls Oracle Fusion CustomerProfileService.getActiveCustomerProfile
   * WSDL: /fscmService/CustomerProfileService?WSDL
   */
  async getCustomerProfile(
    accountNumber: string,
  ): Promise<CustomerProfileResult> {
    return this.circuitBreaker.execute('oracle:getCustomerProfile', () =>
      this.withRetries(async () => {
        const body = buildCustomerProfileSoap(accountNumber);
        const resp = await this.http.post(
          '/fscmService/CustomerProfileService',
          body,
          {
            headers: {
              SOAPAction:
                'http://xmlns.oracle.com/apps/financials/receivables/customers/customerProfileService/getActiveCustomerProfile',
            },
          },
        );
        const xml = resp.data as string;
        this.assertNoFault(xml, 'getActiveCustomerProfile');
        const customerAccountId = parseInt(
          extractTag(xml, 'CustomerAccountId') || extractTag(xml, 'customerAccountId') || '0',
          10,
        );
        const paymentTermsName =
          extractTag(xml, 'PaymentTerms') || extractTag(xml, 'paymentTerms') || 'IMMEDIATE';
        return { customerAccountId, paymentTermsName };
      }),
    );
  }

  // ── Helpers ───────────────────────────────────────────────

  private assertNoFault(xml: string, operation: string): void {
    if (xml.includes('<faultcode>') || xml.includes(':Fault>')) {
      const faultString =
        extractTag(xml, 'faultstring') || extractTag(xml, 'text');
      this.logger.error(`SOAP fault on ${operation}: ${faultString}`);
      throw new Error(`Oracle SOAP fault [${operation}]: ${faultString}`);
    }
  }

  private async withRetries<T>(
    operation: () => Promise<T>,
    attempt = 1,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= 3) {
        this.logger.error('Oracle SOAP request failed after retries');
        throw error;
      }
      // Exponential back-off: 5 s, 10 s  (matching Java pain-point #8 retry pattern)
      await this.delay(5_000 * attempt);
      return this.withRetries(operation, attempt + 1);
    }
  }

  private async delay(ms: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
