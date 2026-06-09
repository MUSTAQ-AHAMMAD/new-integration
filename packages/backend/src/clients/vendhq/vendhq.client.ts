/**
 * VendHQ REST client — mirrors the Java VendHQRESTClient used by
 * FusionItemsToVendHQItemsIntegration, VendHQSalesBackupJob, etc.
 *
 * API docs: https://docs.vendhq.com/
 * Base URL:  https://{domain}.vendhq.com/api/2.0
 */
import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { CircuitBreakerService } from '../circuit-breaker.service';

// ──────────────────────────────────────────────────────────────
// Domain models
// ──────────────────────────────────────────────────────────────

export interface VendHqSale {
  id: string;
  invoice_number?: string;
  sale_date?: string;
  register_id?: string;
  register_name?: string;
  customer_id?: string;
  customer_name?: string;
  customer_code?: string;
  note?: string;
  status?: string;
  total_price?: number;
  total_tax?: number;
  total_price_incl_tax?: number;
  line_items?: VendHqLineItem[];
  payments?: VendHqPayment[];
  [key: string]: unknown;
}

export interface VendHqLineItem {
  id?: string;
  product_id?: string;
  sku?: string;
  name?: string;
  quantity?: number;
  price?: number;
  tax?: number;
  total_price?: number;
  tax_name?: string;
  line_note?: string;
  [key: string]: unknown;
}

export interface VendHqPayment {
  id?: string;
  payment_type_id?: string;
  name?: string;
  amount?: number;
  [key: string]: unknown;
}

export interface VendHqProduct {
  id: string;
  handle?: string;
  sku?: string;
  name?: string;
  description?: string;
  supply_price?: number;
  retail_price?: number;
  tax_id?: string;
  tax_name?: string;
  tax_rate?: number;
  is_active?: boolean;
  updated_at?: string;
  [key: string]: unknown;
}

export interface VendHqProductCreate {
  handle?: string;
  sku?: string;
  name: string;
  description?: string;
  supply_price?: number;
  retail_price?: number;
  tax_id?: string;
  is_active?: boolean;
  [key: string]: unknown;
}

export interface VendHqOutlet {
  id: string;
  name?: string;
  default_tax_id?: string;
  currency?: string;
  [key: string]: unknown;
}

export interface VendHqRegister {
  id: string;
  name?: string;
  outlet_id?: string;
  [key: string]: unknown;
}

export interface VendHqCustomer {
  id: string;
  code?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  customer_group_id?: string;
  customer_group_name?: string;
  [key: string]: unknown;
}

export interface VendHqInventory {
  product_id: string;
  outlet_id: string;
  current?: number;
  [key: string]: unknown;
}

// ──────────────────────────────────────────────────────────────
// Client
// ──────────────────────────────────────────────────────────────

@Injectable()
export class VendHqClient {
  private readonly logger = new Logger(VendHqClient.name);
  private readonly http: AxiosInstance;
  private readonly circuitBreaker: CircuitBreakerService;

  constructor(
    private readonly configService: ConfigService,
    @Optional() circuitBreaker?: CircuitBreakerService,
  ) {
    this.circuitBreaker = circuitBreaker ?? new CircuitBreakerService();
    const baseURL = this.configService.get<string>('VENDHQ_BASE_URL');
    const token = this.configService.get<string>('VENDHQ_API_TOKEN', '');

    this.http = axios.create({
      baseURL,
      timeout: 30_000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
  }

  // ── Sales ─────────────────────────────────────────────────

  /**
   * Fetch recent sales. Equivalent to the Java VendHQSalesBackupJob fetch.
   * GET /api/2.0/sales?since={afterVersion}&outlet_id={outletId}
   */
  async getSales(params: {
    afterVersion?: number;
    outletId?: string;
    since?: string;
    pageSize?: number;
  }): Promise<VendHqSale[]> {
    return this.circuitBreaker.execute(
      'vendhq:getSales',
      () =>
        this.withRetries(async () => {
          const query: Record<string, string | number> = {};
          if (params.afterVersion !== undefined)
            query.after = params.afterVersion;
          if (params.outletId) query.outlet_id = params.outletId;
          if (params.since) query.since = params.since;
          query.page_size = params.pageSize ?? 200;

          const resp = await this.http.get<{ data: VendHqSale[] }>(
            '/api/2.0/sales',
            { params: query },
          );
          return resp.data?.data ?? [];
        }),
    );
  }

  /**
   * Fetch a single sale by ID.
   * GET /api/2.0/sales/{id}
   */
  async getSale(saleId: string): Promise<VendHqSale> {
    return this.circuitBreaker.execute(
      'vendhq:getSale',
      () =>
        this.withRetries(async () => {
          const resp = await this.http.get<{ data: VendHqSale }>(
            `/api/2.0/sales/${saleId}`,
          );
          return resp.data?.data ?? (resp.data as unknown as VendHqSale);
        }),
    );
  }

  // ── Products ──────────────────────────────────────────────

  /**
   * Fetch products (used for item cache sync).
   * GET /api/2.0/products?since={afterVersion}&page_size=200
   */
  async getProducts(params: {
    afterVersion?: number;
    pageSize?: number;
    page?: number;
  }): Promise<VendHqProduct[]> {
    return this.circuitBreaker.execute(
      'vendhq:getProducts',
      () =>
        this.withRetries(async () => {
          const query: Record<string, string | number> = {
            page_size: params.pageSize ?? 200,
            page: params.page ?? 1,
          };
          if (params.afterVersion !== undefined)
            query.after = params.afterVersion;

          const resp = await this.http.get<{ data: VendHqProduct[] }>(
            '/api/2.0/products',
            { params: query },
          );
          return resp.data?.data ?? [];
        }),
    );
  }

  /**
   * Create or update a product in VendHQ.
   * POST /api/2.0/products
   */
  async upsertProduct(product: VendHqProductCreate): Promise<VendHqProduct> {
    return this.circuitBreaker.execute(
      'vendhq:upsertProduct',
      () =>
        this.withRetries(async () => {
          const resp = await this.http.post<{ data: VendHqProduct }>(
            '/api/2.0/products',
            product,
          );
          return resp.data?.data ?? (resp.data as unknown as VendHqProduct);
        }),
    );
  }

  // ── Inventory ─────────────────────────────────────────────

  /**
   * Fetch inventory levels for an outlet.
   * GET /api/2.0/inventory?outlet_id={outletId}
   */
  async getInventory(params: {
    outletId?: string;
    productId?: string;
  }): Promise<VendHqInventory[]> {
    return this.circuitBreaker.execute(
      'vendhq:getInventory',
      () =>
        this.withRetries(async () => {
          const query: Record<string, string> = {};
          if (params.outletId) query.outlet_id = params.outletId;
          if (params.productId) query.product_id = params.productId;

          const resp = await this.http.get<{ data: VendHqInventory[] }>(
            '/api/2.0/inventory',
            { params: query },
          );
          return resp.data?.data ?? [];
        }),
    );
  }

  // ── Outlets ───────────────────────────────────────────────

  /**
   * GET /api/2.0/outlets
   */
  async getOutlets(): Promise<VendHqOutlet[]> {
    return this.circuitBreaker.execute(
      'vendhq:getOutlets',
      () =>
        this.withRetries(async () => {
          const resp = await this.http.get<{ data: VendHqOutlet[] }>(
            '/api/2.0/outlets',
          );
          return resp.data?.data ?? [];
        }),
    );
  }

  // ── Registers ────────────────────────────────────────────

  /**
   * GET /api/2.0/registers
   */
  async getRegisters(): Promise<VendHqRegister[]> {
    return this.circuitBreaker.execute(
      'vendhq:getRegisters',
      () =>
        this.withRetries(async () => {
          const resp = await this.http.get<{ data: VendHqRegister[] }>(
            '/api/2.0/registers',
          );
          return resp.data?.data ?? [];
        }),
    );
  }

  // ── Customers ────────────────────────────────────────────

  /**
   * GET /api/2.0/customers?code={code}
   */
  async getCustomerByCode(code: string): Promise<VendHqCustomer | null> {
    return this.circuitBreaker.execute(
      'vendhq:getCustomer',
      () =>
        this.withRetries(async () => {
          const resp = await this.http.get<{ data: VendHqCustomer[] }>(
            '/api/2.0/customers',
            { params: { code } },
          );
          return resp.data?.data?.[0] ?? null;
        }),
    );
  }

  // ── Test connection ───────────────────────────────────────

  /**
   * Lightweight connectivity test. Returns the first outlet name.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const outlets = await this.getOutlets();
      return {
        ok: true,
        message: `Connected — ${outlets.length} outlet(s) found`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Connection failed: ${msg}` };
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private static readonly BASE_RETRY_DELAY_MS = 300;

  private isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
  }

  private async withRetries<T>(
    operation: () => Promise<T>,
    attempt = 1,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= 3) {
        this.logger.error('VendHQ request failed after retries');
        throw error;
      }
      await this.delay(VendHqClient.BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
      return this.withRetries(operation, attempt + 1);
    }
  }

  private async delay(ms: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
