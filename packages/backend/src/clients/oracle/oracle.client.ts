import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { CircuitBreakerService } from '../circuit-breaker.service';

export interface OracleInvoiceData {
  customerTransactionId?: string;
  billToCustomerNumber?: string;
  transactionNumber?: string;
  transactionDate?: string;
  currencyCode?: string;
  amount?: number;
  lines?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OracleInvoiceResult {
  invoiceId?: string;
  invoiceNumber?: string;
  status?: string;
  [key: string]: unknown;
}

export interface OracleCreditMemoData {
  creditMemoNumber?: string;
  transactionDate?: string;
  amount?: number;
  reason?: string;
  relatedInvoiceNumber?: string;
  lines?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OracleCreditMemoResult {
  creditMemoId?: string;
  creditMemoNumber?: string;
  status?: string;
  [key: string]: unknown;
}

export interface OracleInventoryItem {
  ItemId?: number;
  ItemNumber: string;
  ItemDescription?: string;
  LongDescription?: string;
  PrimaryUOMCode?: string;
  PrimaryUOMValue?: string;
  UserItemTypeValue?: string;
  /** Oracle active-status field — value is "Active" or other codes */
  InventoryItemStatusCode?: string;
  /** Market / retail price as returned by Oracle (may be a string in some API versions) */
  MarketPrice?: number | string;
  OrganizationCode?: string;
  OrganizationId?: number;
  OutputTaxClassificationCodeValue?: string;
  LastUpdateDate?: string;
  CreationDate?: string;
  [key: string]: unknown;
}

export interface OracleOnHandQuantity {
  ItemNumber: string;
  OrganizationCode?: string;
  OrganizationId?: number;
  SubinventoryCode?: string;
  OnHandQuantity?: number;
  UOMCode?: string;
  [key: string]: unknown;
}

@Injectable()
export class OracleClient {
  private readonly logger = new Logger(OracleClient.name);
  private readonly http: AxiosInstance;
  private readonly circuitBreaker: CircuitBreakerService;

  constructor(
    private readonly configService: ConfigService,
    @Optional() circuitBreaker?: CircuitBreakerService,
  ) {
    this.circuitBreaker = circuitBreaker ?? new CircuitBreakerService();
    this.http = axios.create({
      baseURL: this.configService.get<string>('ORACLE_REST_BASE_URL'),
      timeout: 30_000,
      auth: {
        username: this.configService.get<string>('ORACLE_USERNAME', ''),
        password: this.configService.get<string>('ORACLE_PASSWORD', ''),
      },
    });
  }

  async createInvoice(data: OracleInvoiceData): Promise<OracleInvoiceResult> {
    return this.circuitBreaker.execute('oracle:createInvoice', () =>
      this.withRetries(async () => {
        const response = await this.http.post('/receivables/invoices', data);
        return this.extractObject<OracleInvoiceResult>(response.data);
      }),
    );
  }

  async createCreditMemo(
    data: OracleCreditMemoData,
  ): Promise<OracleCreditMemoResult> {
    return this.circuitBreaker.execute('oracle:createCreditMemo', () =>
      this.withRetries(async () => {
        const response = await this.http.post('/receivables/creditMemos', data);
        return this.extractObject<OracleCreditMemoResult>(response.data);
      }),
    );
  }

  async getInvoice(invoiceNumber: string): Promise<OracleInvoiceResult> {
    return this.circuitBreaker.execute('oracle:getInvoice', () =>
      this.withRetries(async () => {
        const response = await this.http.get(
          `/receivables/invoices/${invoiceNumber}`,
        );
        return this.extractObject<OracleInvoiceResult>(response.data);
      }),
    );
  }

  /**
   * Fetches inventory items from Oracle Fusion SCM.
   * Equivalent to Java FusionItemsToVendHQItemsIntegration / FusionItemsService.getFusionItems().
   * GET /fscmRestApi/resources/11.13.17.11/items
   */
  async getInventoryItems(params: {
    organizationCode?: string;
    /** Watermark — only items updated after this date are returned (mirrors Java lastRequestedDate). */
    lastUpdateDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<OracleInventoryItem[]> {
    return this.circuitBreaker.execute('oracle:getInventoryItems', () =>
      this.withRetries(async () => {
        // Build the semicolon-delimited "q" filter — mirrors Java FusionItemsService
        const qParts: string[] = [];
        if (params.lastUpdateDate) {
          const iso = params.lastUpdateDate.toISOString().replace('T', ' ').substring(0, 19);
          qParts.push(`LastUpdateDate>${iso}`);
        }
        qParts.push('UserItemTypeValue=Finished Good');
        if (params.organizationCode)
          qParts.push(`OrganizationCode=${params.organizationCode}`);

        const query: Record<string, string | number> = {
          limit: params.limit ?? 500,
          offset: params.offset ?? 0,
          orderBy: 'LastUpdateDate',
          q: qParts.join(';'),
          fields: [
            'ItemId',
            'ItemClass',
            'OrganizationId',
            'OrganizationCode',
            'ItemNumber',
            'ItemDescription',
            'MarketPrice',
            'PrimaryUOMCode',
            'PrimaryUOMValue',
            'UserItemTypeValue',
            'InventoryItemStatusCode',
            'LongDescription',
            'OutputTaxClassificationCodeValue',
            'LastUpdateDate',
            'CreationDate',
          ].join(','),
        };

        const response = await this.http.get(
          '/fscmRestApi/resources/11.13.17.11/items',
          { params: query },
        );
        const data = this.isRecord(response.data) ? response.data : {};
        const items = Array.isArray(data['items'])
          ? (data['items'] as OracleInventoryItem[])
          : [];
        return items;
      }),
    );
  }

  /**
   * Fetches on-hand inventory quantities from Oracle Fusion.
   * Equivalent to Java FusionOnHandQtyFetch + FusionInvToVendHQInvIntegration.
   * GET /fscmRestApi/resources/11.13.18.05/inventoryOnhandQuantities
   */
  async getInventoryOnHand(params: {
    organizationCode?: string;
    itemNumber?: string;
    subinventoryCode?: string;
    limit?: number;
    offset?: number;
  }): Promise<OracleOnHandQuantity[]> {
    return this.circuitBreaker.execute('oracle:getInventoryOnHand', () =>
      this.withRetries(async () => {
        const queryParts: string[] = [];
        if (params.organizationCode)
          queryParts.push(`OrganizationCode=${params.organizationCode}`);
        if (params.itemNumber)
          queryParts.push(`ItemNumber=${params.itemNumber}`);
        if (params.subinventoryCode)
          queryParts.push(`SubinventoryCode=${params.subinventoryCode}`);

        const query: Record<string, string | number> = {
          limit: params.limit ?? 500,
          offset: params.offset ?? 0,
        };
        if (queryParts.length > 0) query['q'] = queryParts.join(';');

        const response = await this.http.get(
          '/fscmRestApi/resources/11.13.18.05/inventoryOnhandQuantities',
          { params: query },
        );
        const data = this.isRecord(response.data) ? response.data : {};
        const items = Array.isArray(data['items'])
          ? (data['items'] as OracleOnHandQuantity[])
          : [];
        return items;
      }),
    );
  }

  private async withRetries<T>(
    operation: () => Promise<T>,
    attempt = 1,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= 3) {
        this.logger.error('Oracle request failed after retries');
        throw error;
      }

      await this.delay(200 * 2 ** (attempt - 1));
      return this.withRetries(operation, attempt + 1);
    }
  }

  private extractObject<T>(payload: unknown): T {
    if (this.isRecord(payload)) {
      return payload as T;
    }

    throw new ServiceUnavailableException('Unexpected Oracle response payload');
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private async delay(ms: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
