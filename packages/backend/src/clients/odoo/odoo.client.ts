import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { findArrayInPayload, toApiDatetime } from '../../common/odoo-utils';

export interface OdooOrderLine {
  id?: number;
  product_id?: number | [number, string];
  /** POS orders use "qty", sale orders use "product_uom_qty" */
  qty?: number;
  product_uom_qty?: number;
  price_unit?: number;
  price_subtotal?: number;
  price_subtotal_incl?: number;
  discount?: number;
  [key: string]: unknown;
}

export interface OdooOrderPayment {
  id?: number;
  name?: string;
  amount?: number;
  /** ISO currency code from currency_id Many2one field */
  currency_id?: number | [number, string];
  /** Payment method from payment_method_id Many2one (v16+) */
  payment_method_id?: number | [number, string];
  /** Journal name from journal_id Many2one */
  journal_id?: number | [number, string];
  /** Payment method code string (some IBQ variants) */
  payment_method_code?: string;
  /** Payment date */
  date?: string;
  payment_date?: string;
  [key: string]: unknown;
}

export interface OdooOrder {
  id: number;
  name: string;
  amount_total?: number;
  amount_tax?: number;
  branch_id?: number | [number, string];
  date_order?: string;
  state?: string;
  partner_id?: number | [number, string] | null;
  timezone?: string;
  /** POS orders expose lines here */
  lines?: OdooOrderLine[];
  /** Sale orders expose lines here */
  order_line?: OdooOrderLine[];
  /** Odoo v15 uses statement_ids, v18 may use payment_ids */
  statement_ids?: OdooOrderPayment[];
  payment_ids?: OdooOrderPayment[];
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
      timeout: 120_000,
    });
  }

  /**
   * Returns request headers for the chosen auth strategy.
   * When ODOO_API_KEY is configured the x-api-key header is used and no
   * session cookie is required.  Otherwise a session cookie is obtained via
   * username/password authentication.
   */
  private async authHeaders(
    forceRefresh = false,
  ): Promise<Record<string, string>> {
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
    return this.circuitBreaker.execute('odoo:getOrders', () =>
      this.withRetries(async (attempt) => {
        const headers = await this.authHeaders(attempt > 1);
        const pageSize = 100;
        const allOrders: OdooOrder[] = [];
        let offset = 0;
        // Total count advertised by the server (null when not available).
        let totalExpected: number | null = null;
        // Track IDs of the previous page to detect non-functioning offset pagination.
        const prevPageIds = new Set<number>();

        while (true) {
          let pageOrders: OdooOrder[];
          let rawData: unknown;

          if (this.apiKey) {
            // POS REST API — uses query parameters directly
            const response = await this.http.get('/api/pos/order', {
              headers,
              params: {
                ...(params.branchId !== undefined && {
                  branch_id: params.branchId,
                }),
                ...(params.startDate && {
                  start_date: toApiDatetime(params.startDate),
                }),
                ...(params.endDate && {
                  end_date: toApiDatetime(params.endDate, { end: true }),
                }),
                limit: pageSize,
                offset,
              },
            });
            rawData = response.data;
          } else {
            // Session-based fallback: use domain filter on sale.order
            const domain = this.buildOrdersDomain(params);
            const response = await this.http.get('/api/sale.order', {
              headers,
              params: {
                domain: JSON.stringify(domain),
                limit: pageSize,
                offset,
              },
            });
            rawData = response.data;
          }

          // Capture total from first page only; server count doesn't change mid-run.
          if (offset === 0) {
            totalExpected = this.extractTotal(rawData);
            if (totalExpected !== null) {
              this.logger.debug(
                `Odoo getOrders: server reports ${totalExpected} total records`,
              );
            }
          }

          pageOrders = this.extractList<OdooOrder>(rawData);

          // ── Duplicate-page detection ─────────────────────────────────────
          // If the server returns the same IDs we saw on the previous page,
          // offset pagination is not functioning.  Stop immediately to prevent
          // an infinite loop that would return the same first page forever.
          if (prevPageIds.size > 0 && pageOrders.length > 0) {
            const pageIds = pageOrders
              .map((o) => (typeof o.id === 'number' ? o.id : null))
              .filter((id): id is number => id !== null);
            const dupes = pageIds.filter((id) => prevPageIds.has(id));
            if (dupes.length === pageIds.length) {
              this.logger.warn(
                `Odoo getOrders: page at offset=${offset} is identical to the previous page — ` +
                  `offset pagination is not supported by this endpoint; stopping.`,
              );
              break;
            }
            if (dupes.length > 0) {
              this.logger.warn(
                `Odoo getOrders: page at offset=${offset} contains ${dupes.length} duplicate IDs.`,
              );
            }
            prevPageIds.clear();
            pageIds.forEach((id) => prevPageIds.add(id));
          } else {
            const pageIds = pageOrders
              .map((o) => (typeof o.id === 'number' ? o.id : null))
              .filter((id): id is number => id !== null);
            pageIds.forEach((id) => prevPageIds.add(id));
          }

          allOrders.push(...pageOrders);

          this.logger.debug(
            `Odoo getOrders: offset=${offset}, page=${pageOrders.length}, cumulative=${allOrders.length}` +
              (totalExpected !== null ? `, total=${totalExpected}` : ''),
          );

          // ── Exit conditions ───────────────────────────────────────────────
          // 1. Count-verified: stop when we have at least as many records as the
          //    server advertised (handles short pages caused by deleted records).
          if (totalExpected !== null && allOrders.length >= totalExpected) break;

          // 2. Short page: last page has fewer records than the page size.
          //    Used when the server does not report a total count.
          if (totalExpected === null && pageOrders.length < pageSize) break;

          // 3. Caller-specified hard cap.
          if (params.limit !== undefined && allOrders.length >= params.limit)
            break;

          offset += pageSize;
        }

        if (
          totalExpected !== null &&
          allOrders.length < totalExpected
        ) {
          this.logger.warn(
            `Odoo getOrders: fetched ${allOrders.length} of ${totalExpected} expected records — some may be missing.`,
          );
        }

        return allOrders;
      }),
    );
  }

  async getOrder(orderId: string): Promise<OdooOrder> {
    return this.circuitBreaker.execute('odoo:getOrder', () =>
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
    return this.circuitBreaker.execute('odoo:getPaymentMethods', () =>
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
      // 4xx responses are permanent failures — retrying them will not help and
      // only wastes time/quota.  Surface the error immediately with the most
      // semantically appropriate NestJS exception.
      if (error instanceof AxiosError && error.response?.status !== undefined) {
        const status = error.response.status;
        if (status >= 400 && status < 500) {
          this.logger.error(
            `Odoo request failed with permanent HTTP ${status} — not retrying`,
          );
          const detail = `Odoo request failed (HTTP ${status}): ${error.message}`;
          if (status === 401 || status === 403) {
            throw new UnauthorizedException(detail);
          }
          if (status === 404) {
            throw new NotFoundException(detail);
          }
          throw new BadRequestException(detail);
        }
      }

      if (attempt >= 3) {
        this.logger.error('Odoo request failed after retries');
        // Wrap non-HTTP errors so callers receive a proper 503 instead of an
        // unhandled exception that becomes a generic 500 response.
        const message =
          error instanceof Error ? error.message : 'Odoo request failed';
        throw new ServiceUnavailableException(
          `Odoo service unreachable: ${message}`,
        );
      }

      // Only clear the session cookie when using session-based auth
      if (!this.apiKey) {
        this.sessionCookie = undefined;
      }
      // Exponential backoff with jitter to avoid thundering herd when multiple
      // cron runs retry simultaneously against the same Odoo instance.
      await this.delay(
        200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100),
      );
      return this.withRetries(operation, attempt + 1);
    }
  }

  /**
   * Extracts the total record count advertised by the Odoo API response
   * envelope.  Returns `null` when the response does not include a count field
   * (e.g. plain array responses).
   *
   * Supported patterns:
   *   - `{ length: N, records: [...] }`           — Odoo 17/18 REST
   *   - `{ total: N, ... }`                        — some custom modules
   *   - `{ count: N, ... }`                        — some IBQ variants
   *   - `{ result: { length: N, records: [...] } }` — nested result
   */
  private extractTotal(payload: unknown): number | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as Record<string, unknown>;

    if (typeof p['length'] === 'number') return p['length'];
    if (typeof p['total'] === 'number') return p['total'];
    if (typeof p['count'] === 'number') return p['count'];

    if (
      typeof p['result'] === 'object' &&
      p['result'] !== null &&
      !Array.isArray(p['result'])
    ) {
      const r = p['result'] as Record<string, unknown>;
      if (typeof r['length'] === 'number') return r['length'];
      if (typeof r['total'] === 'number') return r['total'];
      if (typeof r['count'] === 'number') return r['count'];
    }

    return null;
  }

  private extractList<T>(payload: unknown): T[] {
    if (Array.isArray(payload)) {
      return this.normalizeItems<T>(payload);
    }

    if (this.isRecord(payload)) {
      // IBQ unified API: { results: [{ order: { order_id, ... } }] }
      const results = payload.results;
      if (Array.isArray(results)) {
        return this.normalizeItems<T>(results);
      }

      // Odoo 16+ REST API wraps list results in a `records` key
      const records = payload.records;
      if (Array.isArray(records)) {
        return this.normalizeItems<T>(records);
      }

      const data = payload.data;
      if (Array.isArray(data)) {
        return this.normalizeItems<T>(data);
      }

      // Some Odoo/IBQ variants return { orders: [...] } at the top level
      const orders = payload.orders;
      if (Array.isArray(orders)) {
        return this.normalizeItems<T>(orders);
      }

      // Odoo 17/18 REST API: { result: { records: [...], length: N } }
      // or { result: { data: [...], count: N } } or { result: { orders: [...] } }
      const result = payload.result;
      // Explicit typeof + !Array.isArray guards are used here to narrow `result`
      // to a plain object so we can safely access its nested array properties.
      if (
        typeof result === 'object' &&
        result !== null &&
        !Array.isArray(result)
      ) {
        const resultObj = result as Record<string, unknown>;
        if (Array.isArray(resultObj['records'])) {
          return this.normalizeItems<T>(resultObj['records']);
        }
        if (Array.isArray(resultObj['data'])) {
          return this.normalizeItems<T>(resultObj['data']);
        }
        if (Array.isArray(resultObj['orders'])) {
          return this.normalizeItems<T>(resultObj['orders']);
        }
      }

      if (Array.isArray(result)) {
        return this.normalizeItems<T>(result);
      }

      // Generic fallback: scan all top-level keys for the first non-empty array.
      // Covers custom Odoo REST modules that use non-standard envelope keys
      // (e.g. "items", "rows", "Sale_detail", "orders_list", etc.).
      const found = findArrayInPayload(payload);
      if (found) {
        if (found.length > 0) {
          this.logger.debug(
            `extractList: using generic fallback (${found.length} items)`,
          );
        }
        return this.normalizeItems<T>(found);
      }
    }

    return [];
  }

  /**
   * Normalise raw list items from any Odoo/IBQ API variant.
   * IBQ unified API wraps each order in `{ order: { order_id, amount_paid, ... } }`.
   * This unwraps that envelope and maps field aliases so the rest of the code
   * can use standard OdooOrder field names (`id`, `amount_total`).
   */
  private normalizeItems<T>(items: unknown[]): T[] {
    return items.map((item) => {
      if (typeof item !== 'object' || item === null) return item as T;
      const raw = item as Record<string, unknown>;

      const inner =
        typeof raw['order'] === 'object' && raw['order'] !== null
          ? (raw['order'] as Record<string, unknown>)
          : raw;

      const normalised: Record<string, unknown> = { ...inner };
      if (normalised['id'] == null && normalised['order_id'] != null) {
        normalised['id'] = normalised['order_id'];
      }
      if (
        normalised['amount_total'] == null &&
        normalised['amount_paid'] != null
      ) {
        normalised['amount_total'] = normalised['amount_paid'];
      }

      return normalised as unknown as T;
    });
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
