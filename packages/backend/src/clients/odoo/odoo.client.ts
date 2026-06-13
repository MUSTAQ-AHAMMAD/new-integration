import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { CircuitBreakerService } from '../circuit-breaker.service';

export interface OdooOrder {
  id: number;
  name: string;
  amount_total?: number;
  branch_id?: number | [number, string];
  date_order?: string;
  state?: string;
  [key: string]: unknown;
}

export interface OdooPaymentMethod {
  id: number;
  name: string;
  code?: string;
  [key: string]: unknown;
}

type OdooDomain = Array<[string, string, string | number]>;

@Injectable()
export class OdooClient {
  private readonly logger = new Logger(OdooClient.name);
  private readonly http: AxiosInstance;
  private readonly circuitBreaker: CircuitBreakerService;
  private readonly apiKey?: string;
  private sessionCookie?: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional() circuitBreaker?: CircuitBreakerService,
  ) {
    this.circuitBreaker = circuitBreaker ?? new CircuitBreakerService();
    this.apiKey = this.configService.get<string>('ODOO_API_KEY');
    this.http = axios.create({
      baseURL: this.configService.get<string>('ODOO_BASE_URL'),
      timeout: 30_000,
    });
  }

  /**
   * Returns request headers for the chosen auth strategy.
   * When ODOO_API_KEY is configured the x-api-key header is used and no
   * session cookie is required.  Otherwise a session cookie is obtained via
   * username/password authentication.
   */
  private async authHeaders(forceRefresh = false): Promise<Record<string, string>> {
    if (this.apiKey) {
      return { 'x-api-key': this.apiKey };
    }

    const cookie = await this.authenticateSession(forceRefresh);
    return { Cookie: cookie };
  }

  private async authenticateSession(forceRefresh = false): Promise<string> {
    if (this.sessionCookie && !forceRefresh) {
      return this.sessionCookie;
    }

    const db = this.configService.get<string>('ODOO_DB');
    const username = this.configService.get<string>('ODOO_USERNAME');
    const password = this.configService.get<string>('ODOO_PASSWORD');

    const response = await this.http.post('/web/session/authenticate', {
      jsonrpc: '2.0',
      params: {
        db,
        login: username,
        password,
      },
    });

    const setCookie = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!cookieHeader) {
      throw new ServiceUnavailableException('Odoo authentication failed');
    }

    this.sessionCookie = cookieHeader.split(';', 1)[0];
    return this.sessionCookie;
  }

  async getOrders(params: {
    branchId?: number;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<OdooOrder[]> {
    return this.circuitBreaker.execute(
      'odoo:getOrders',
      () =>
        this.withRetries(async (attempt) => {
          const headers = await this.authHeaders(attempt > 1);

          if (this.apiKey) {
            // POS REST API — uses query parameters directly
            const response = await this.http.get('/api/pos/order', {
              headers,
              params: {
                ...(params.branchId !== undefined && { branch_id: params.branchId }),
                ...(params.startDate && { start_date: params.startDate }),
                ...(params.endDate && { end_date: params.endDate }),
              },
            });
            return this.extractList<OdooOrder>(response.data);
          }

          // Session-based fallback: use domain filter on sale.order
          const domain = this.buildOrdersDomain(params);
          const response = await this.http.get('/api/sale.order', {
            headers,
            params: {
              domain: JSON.stringify(domain),
              limit: params.limit ?? 100,
            },
          });
          return this.extractList<OdooOrder>(response.data);
        }),
    );
  }

  async getOrder(orderId: string): Promise<OdooOrder> {
    return this.circuitBreaker.execute(
      'odoo:getOrder',
      () =>
        this.withRetries(async (attempt) => {
          const headers = await this.authHeaders(attempt > 1);
          const endpoint = this.apiKey
            ? `/api/pos/order/${orderId}`
            : `/api/sale.order/${orderId}`;
          const response = await this.http.get(endpoint, { headers });
          return this.extractItem<OdooOrder>(response.data);
        }),
    );
  }

  async getPaymentMethods(): Promise<OdooPaymentMethod[]> {
    return this.circuitBreaker.execute(
      'odoo:getPaymentMethods',
      () =>
        this.withRetries(async (attempt) => {
          const headers = await this.authHeaders(attempt > 1);
          const response = await this.http.get('/api/account.payment.method', {
            headers,
          });

          return this.extractList<OdooPaymentMethod>(response.data);
        }),
    );
  }

  private buildOrdersDomain(params: {
    branchId?: number;
    startDate?: string;
    endDate?: string;
  }): OdooDomain {
    const domain: OdooDomain = [];

    if (params.branchId !== undefined) {
      domain.push(['branch_id', '=', params.branchId]);
    }

    if (params.startDate) {
      domain.push(['date_order', '>=', params.startDate]);
    }

    if (params.endDate) {
      domain.push(['date_order', '<=', params.endDate]);
    }

    return domain;
  }

  private async withRetries<T>(
    operation: (attempt: number) => Promise<T>,
    attempt = 1,
  ): Promise<T> {
    try {
      return await operation(attempt);
    } catch (error: unknown) {
      if (attempt >= 3) {
        this.logger.error('Odoo request failed after retries');
        throw error;
      }

      // Only clear the session cookie when using session-based auth
      if (!this.apiKey) {
        this.sessionCookie = undefined;
      }
      await this.delay(200 * 2 ** (attempt - 1));
      return this.withRetries(operation, attempt + 1);
    }
  }

  private extractList<T>(payload: unknown): T[] {
    if (Array.isArray(payload)) {
      return payload as T[];
    }

    if (this.isRecord(payload)) {
      const result = payload.result;
      if (Array.isArray(result)) {
        return result as T[];
      }

      const data = payload.data;
      if (Array.isArray(data)) {
        return data as T[];
      }
    }

    return [];
  }

  private extractItem<T>(payload: unknown): T {
    if (this.isRecord(payload)) {
      const result = payload.result;
      if (this.isRecord(result)) {
        return result as T;
      }

      const data = payload.data;
      if (this.isRecord(data)) {
        return data as T;
      }
    }

    if (this.isRecord(payload)) {
      return payload as T;
    }

    throw new ServiceUnavailableException('Unexpected Odoo response payload');
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private async delay(ms: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
