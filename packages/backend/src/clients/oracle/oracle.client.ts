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

  async createInvoice(
    data: OracleInvoiceData,
  ): Promise<OracleInvoiceResult> {
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
        const response = await this.http.post(
          '/receivables/creditMemos',
          data,
        );
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
