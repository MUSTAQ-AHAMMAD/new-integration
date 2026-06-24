/**
 * OdooBackupService — scheduled backup of orders from the main Odoo instance
 * (configured via ODOO_BASE_URL / ODOO_API_KEY env vars) into local PostgreSQL
 * backup tables.
 *
 * Runs every 15 minutes. On each run it:
 *  1. Reads the lastSyncAt watermark from OdooBackupState.
 *  2. Fetches orders from Odoo using that watermark as startDate.
 *  3. Upserts each order into BackupOdooOrder / BackupOdooOrderLine /
 *     BackupOdooOrderPayment.
 *  4. Advances the lastSyncAt watermark.
 *
 * The service also exposes a `backupOrders` method used by the manual
 * fetch-odoo endpoint so raw data is persisted before processing.
 *
 * Per-region Odoo credentials can be stored in the OdooCredential table and
 * used by the manual fetch-odoo endpoint instead of the global env vars.
 */
import {
  BadGatewayException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios, { AxiosError, AxiosResponse } from 'axios';
import * as https from 'https';
import {
  OdooClient,
  OdooOrder,
  OdooOrderLine,
  OdooOrderPayment,
} from '../clients/odoo/odoo.client';
import {
  normalizeOrderForIngestion,
  findArrayInPayload,
  toApiDatetime,
} from '../common/odoo-utils';
import { PrismaService } from '../prisma/prisma.service';
import { OrderSyncService } from '../sync/order-sync.service';

const DEFAULT_SOURCE = 'default';
/** Default REST endpoint used to fetch POS orders from Odoo. */
const DEFAULT_ODOO_ORDERS_API_PATH = '/api/pos/order';
/** Number of records fetched per page during paginated credential backup. */
const CREDENTIAL_PAGE_SIZE = 200;
/** Per-request HTTP timeout (ms) for credential backup fetches. */
const CREDENTIAL_FETCH_TIMEOUT_MS = 120_000;

/**
 * Normalises a raw API path value from an OdooCredential.
 * Returns null when no path is configured (triggers auto-discovery).
 * Ensures the path starts with "/" to avoid malformed URLs when the
 * operator omits the leading slash (e.g. "api/sales/order" → "/api/sales/order").
 */
function normalizeApiPath(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() || null;
  if (!trimmed) return null;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Odoo Many2one field: either a plain integer id or a [id, name] tuple. */
type Many2OneField = number | [number, string] | null | undefined;

/** Extract the integer id from an Odoo Many2one field ([id, name] or plain id) */
function resolveId(field: Many2OneField): number | null {
  if (field == null) return null;
  if (Array.isArray(field)) return field[0] ?? null;
  return typeof field === 'number' ? field : null;
}

/** Extract the name string from an Odoo Many2one field */
function resolveName(field: Many2OneField): string | null {
  if (field == null) return null;
  if (Array.isArray(field)) return field[1] ?? null;
  return null;
}

/** Resolve ordered quantity from a line — POS uses "qty", sale orders use "product_uom_qty" */
function resolveQty(line: OdooOrderLine): number | null {
  if (line.qty != null) return Number(line.qty);
  if (line.product_uom_qty != null) return Number(line.product_uom_qty);
  return null;
}

/**
 * Extract the first tax name from an Odoo Many2many tax_id field.
 *
 * Handles three common formats:
 *   - `[[id, "VAT 5%"], ...]`  — tuple array (most common in POS)
 *   - `["VAT 5%", ...]`        — plain string array
 *   - `"VAT 5%"`               — plain string (non-standard)
 */
function extractFirstTaxName(taxId: unknown): string | null {
  if (typeof taxId === 'string') return taxId || null;

  if (!Array.isArray(taxId) || taxId.length === 0) return null;

  const first: unknown = taxId[0];
  if (
    Array.isArray(first) &&
    first.length > 1 &&
    typeof first[1] === 'string'
  ) {
    return first[1] || null;
  }
  if (typeof first === 'string') return first || null;

  return null;
}

/**
 * Extract the payment method name from an Odoo payment/statement record.
 *
 * Resolution order (matching the old integration's PAYMENT_TYPE logic):
 *   1. payment_method_code  — code string (some IBQ variants)
 *   2. name                 — plain string (Odoo v15 statement lines)
 *   3. payment_method_id[1] — Many2one name (Odoo v16+)
 *   4. journal_id[1]        — journal name fallback
 */
function extractPaymentName(pmt: OdooOrderPayment): string | null {
  if (typeof pmt.payment_method_code === 'string' && pmt.payment_method_code) {
    return pmt.payment_method_code;
  }
  if (typeof pmt.name === 'string' && pmt.name) {
    return pmt.name;
  }
  if (Array.isArray(pmt.payment_method_id)) {
    const name = (pmt.payment_method_id as [number, unknown])[1];
    if (typeof name === 'string' && name) return name;
  }
  if (Array.isArray(pmt.journal_id)) {
    const name = (pmt.journal_id as [number, unknown])[1];
    if (typeof name === 'string' && name) return name;
  }
  return null;
}

@Injectable()
export class OdooBackupService {
  private readonly logger = new Logger(OdooBackupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly odooClient: OdooClient,
    @Inject(forwardRef(() => OrderSyncService))
    private readonly orderSyncService: OrderSyncService,
  ) {}

  /**
   * Scheduled cron: backs up all new/updated Odoo orders every 15 minutes
   * using the lastSyncAt watermark stored in OdooBackupState.
   */
  @Cron('0 */15 * * * *')
  async runBackupJob(): Promise<void> {
    try {
      const state = await this.prisma.odooBackupState.findUnique({
        where: { source: DEFAULT_SOURCE },
      });

      const startDate = state?.lastSyncAt
        ? state.lastSyncAt.toISOString()
        : undefined;

      const runAt = new Date();
      const result = await this.backupOrders({ startDate });

      // Pre-load StoreConfigurations for branchCode resolution
      const storeConfigs = await this.prisma.storeConfiguration.findMany({
        where: { isActive: true },
        select: { branchCode: true, odooBranchId: true, region: true },
      });
      const branchIdMap = new Map(
        storeConfigs.map((sc) => [
          sc.odooBranchId,
          { branchCode: sc.branchCode, region: sc.region ?? null },
        ]),
      );

      // Advance the watermark after a successful cron run
      await this.prisma.odooBackupState.upsert({
        where: { source: DEFAULT_SOURCE },
        create: { source: DEFAULT_SOURCE, lastSyncAt: runAt },
        update: { lastSyncAt: runAt },
      });

      // Ingest backed-up orders into the OrderSyncQueue so the downstream
      // pipeline (BullMQ → Oracle) has real data to process.
      // Note: backup (saved/backupSkipped) and ingestion (ingested/ingestSkipped)
      // are counted separately — an order can be backed up successfully while
      // failing ingestion (e.g. missing branch mapping), and vice-versa retries
      // can re-ingest from backup without re-fetching from Odoo.
      let ingested = 0;
      let ingestSkipped = 0;
      for (const order of result.orders) {
        try {
          const payload = normalizeOrderForIngestion(order);
          if (!payload) {
            ingestSkipped++;
            continue;
          }

          // Resolve canonical branchCode from StoreConfiguration.odooBranchId
          const odooBranchId =
            order.branch_id != null
              ? Array.isArray(order.branch_id)
                ? order.branch_id[0]
                : order.branch_id
              : null;
          const storeEntry =
            odooBranchId != null ? branchIdMap.get(odooBranchId) : null;
          const resolvedBranchCode =
            storeEntry?.branchCode ?? payload.branchCode;
          const resolvedRegion = storeEntry?.region ?? null;

          const backupOrder = await this.prisma.backupOdooOrder.findUnique({
            where: { orderId: order.id },
            select: { id: true },
          });

          await this.orderSyncService.ingestOrder({
            ...payload,
            branchCode: resolvedBranchCode,
            region: resolvedRegion ?? undefined,
            odooBackupOrderId: backupOrder?.id,
          });
          ingested++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to ingest Odoo order id=${String(order.id)}: ${msg}`,
          );
          ingestSkipped++;
        }
      }

      this.logger.log(
        `Odoo backup+ingest done: ` +
          `backup.saved=${result.saved} backup.skipped=${result.skipped} ` +
          `ingest.queued=${ingested} ingest.skipped=${ingestSkipped}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Odoo backup cron failed: ${msg}`);
    }
  }

  /**
   * Fetches orders from Odoo using the given parameters and persists them to
   * backup tables.  Returns the saved/skipped counts and the raw order list so
   * callers (e.g. the fetch-odoo endpoint) can continue processing them.
   * Does NOT advance the lastSyncAt watermark — that is the cron's responsibility.
   */
  async backupOrders(params: {
    branchId?: number;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<{ saved: number; skipped: number; orders: OdooOrder[] }> {
    const orders = await this.odooClient.getOrders({
      branchId: params.branchId,
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit,
    });

    let saved = 0;
    let skipped = 0;

    for (const order of orders) {
      try {
        await this.upsertOrder(order);
        saved++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to persist Odoo order id=${order.id} name=${order.name ?? 'no-name'}: ${msg}`,
        );
        skipped++;
      }
    }

    return { saved, skipped, orders };
  }

  /**
   * Scheduled cron: backs up orders from every active per-region OdooCredential
   * every 15 minutes, using the per-credential lastSyncAt watermark.
   * Mirrors the IbqBackupService pattern so all regions are kept in sync
   * automatically without manual intervention.
   */
  @Cron('0 */15 * * * *')
  async runCredentialBackupJob(): Promise<void> {
    const credentials = await this.prisma.odooCredential.findMany({
      where: { active: true },
    });

    if (credentials.length === 0) {
      return;
    }

    // Pre-load all active StoreConfiguration records so we can resolve the
    // canonical branchCode for each Odoo order's numeric branch_id without
    // issuing a separate DB query per order.
    const storeConfigs = await this.prisma.storeConfiguration.findMany({
      where: { isActive: true },
      select: { branchCode: true, odooBranchId: true, region: true },
    });
    // Map odooBranchId → { branchCode, region } for fast lookup
    const branchIdMap = new Map(
      storeConfigs.map((sc) => [
        sc.odooBranchId,
        { branchCode: sc.branchCode, region: sc.region ?? null },
      ]),
    );

    for (const cred of credentials) {
      const runAt = new Date();
      try {
        const result = await this.backupOrdersForCredential(cred, {
          startDate: cred.lastSyncAt?.toISOString(),
          limit: undefined, // fetch all pages
        });

        // Ingest backed-up orders into the OrderSyncQueue.
        let ingested = 0;
        let ingestSkipped = 0;
        for (const order of result.orders) {
          try {
            const payload = normalizeOrderForIngestion(order);
            if (!payload) {
              this.logger.warn(
                `Odoo order id=${String(order.id)} region=${cred.region} skipped: ` +
                  `normalizeOrderForIngestion returned null (missing Odoo fields branch_id or date_order)`,
              );
              ingestSkipped++;
              continue;
            }

            // ── Resolve canonical branchCode from StoreConfiguration ──────────
            // normalizeOrderForIngestion sets branchCode = String(branch_id) which
            // is a numeric Odoo ID (e.g. "3").  StoreConfiguration.branchCode is a
            // human-readable code (e.g. "CCNTRBHR") keyed via odooBranchId.  Look up
            // the real branchCode so validation and Oracle transformation work correctly.
            const odooBranchId =
              order.branch_id != null
                ? Array.isArray(order.branch_id)
                  ? order.branch_id[0]
                  : order.branch_id
                : null;
            const storeEntry =
              odooBranchId != null ? branchIdMap.get(odooBranchId) : null;
            const resolvedBranchCode =
              storeEntry?.branchCode ?? payload.branchCode;
            // Prefer region from credential; fall back to StoreConfiguration.region
            const resolvedRegion = cred.region || storeEntry?.region || null;

            // Look up the BackupOdooOrder record we just upserted so we can link
            // the queue entry back to the raw backup for transformation.
            const backupOrder = await this.prisma.backupOdooOrder.findUnique({
              where: { orderId: order.id },
              select: { id: true },
            });

            await this.orderSyncService.ingestOrder({
              ...payload,
              branchCode: resolvedBranchCode,
              region: resolvedRegion ?? undefined,
              odooBackupOrderId: backupOrder?.id,
            });
            ingested++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Failed to ingest Odoo order id=${String(order.id)} region=${cred.region}: ${msg}`,
            );
            ingestSkipped++;
          }
        }

        // Advance the per-credential watermark after the ingestion loop so that
        // any backup failure (backupOrdersForCredential throwing) prevents the
        // watermark from advancing and the orders are re-fetched on the next run.
        await this.prisma.odooCredential.update({
          where: { id: cred.id },
          data: { lastSyncAt: runAt },
        });

        this.logger.log(
          `Odoo credential backup+ingest done for region=${cred.region}: ` +
            `backup.saved=${result.saved} backup.skipped=${result.skipped} ` +
            `ingest.queued=${ingested} ingest.skipped=${ingestSkipped}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Odoo credential backup failed for region=${cred.region} url=${cred.baseUrl}: ${msg}`,
        );
      }
    }
  }

  /**
   * Probes a specific OdooCredential by making a lightweight GET request to the
   * configured endpoint (limit=1).  Returns diagnostic information that lets
   * operators verify the credential is correctly configured without running a
   * full backup.
   *
   * Never throws — all outcomes are returned as a structured result object so
   * the caller (controller) can always return a 200 response with diagnostics.
   */
  async probeCredential(cred: {
    baseUrl: string;
    apiKey: string;
    region: string;
    apiPath?: string | null;
    rejectUnauthorizedSsl?: boolean | null;
  }): Promise<{
    ok: boolean;
    url: string;
    status: number | null;
    parsedCount: number;
    bodySnippet: string;
    error: string | null;
  }> {
    const rawBase = cred.baseUrl.replace(/\/$/, '');
    const baseUrl = /^https?:\/\//i.test(rawBase)
      ? rawBase
      : `https://${rawBase}`;

    const apiPath = normalizeApiPath(cred.apiPath) ?? DEFAULT_ODOO_ORDERS_API_PATH;

    const url = `${baseUrl}${apiPath}`;
    const sslVerify = cred.rejectUnauthorizedSsl !== false;
    const httpsAgent = new https.Agent({ rejectUnauthorized: sslVerify });

    try {
      const response = await axios.get<unknown>(url, {
        headers: { 'x-api-key': cred.apiKey },
        params: { limit: 1, offset: 0 },
        httpsAgent,
        timeout: 15_000,
      });

      const body = response.data;
      const bodySnippet =
        typeof body === 'string'
          ? body.slice(0, 500)
          : JSON.stringify(body).slice(0, 500);

      const orders = this.extractOrderList(body);

      return {
        ok: true,
        url,
        status: response.status,
        parsedCount: orders.length,
        bodySnippet,
        error: null,
      };
    } catch (err: unknown) {
      if (err instanceof AxiosError) {
        const status = err.response?.status ?? null;
        const body = err.response?.data;
        const bodySnippet =
          typeof body === 'string'
            ? body.slice(0, 500)
            : body != null
              ? JSON.stringify(body).slice(0, 500)
              : '';
        return {
          ok: false,
          url,
          status,
          parsedCount: 0,
          bodySnippet,
          error: `HTTP ${status ?? 'unknown'}: ${err.message}`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        url,
        status: null,
        parsedCount: 0,
        bodySnippet: '',
        error: message,
      };
    }
  }

  /**
   * Fetches orders from a specific OdooCredential (per-region DB credential)
   * and persists them to backup tables.
   * Uses a temporary axios instance scoped to the credential's baseUrl/apiKey.
   * Does NOT advance the lastSyncAt watermark — callers decide that.
   */
  async backupOrdersForCredential(
    cred: {
      id: string;
      baseUrl: string;
      apiKey: string;
      region: string;
      apiPath?: string | null;
      lastSyncAt?: Date | null;
      rejectUnauthorizedSsl?: boolean | null;
    },
    params: {
      branchId?: number;
      startDate?: string;
      endDate?: string;
      limit?: number;
    },
  ): Promise<{ saved: number; skipped: number; orders: OdooOrder[] }> {
    // Ensure the stored baseUrl always has an https:// scheme so that the
    // axios request doesn't fail with "Invalid URL" when the credential was
    // saved without an explicit protocol prefix.
    const rawBase = cred.baseUrl.replace(/\/$/, '');
    if (!/^https?:\/\//i.test(rawBase)) {
      this.logger.warn(
        `OdooCredential region=${cred.region} baseUrl has no protocol — prepending https://. ` +
          `Update the credential to include the full URL to avoid ambiguity.`,
      );
    }
    const baseUrl = /^https?:\/\//i.test(rawBase)
      ? rawBase
      : `https://${rawBase}`;

    // Use the per-credential apiPath when configured; fall back to the POS REST
    // endpoint which is the default for Odoo instances that expose it.
    // normalizeApiPath ensures the path starts with "/" to avoid malformed URLs
    // when the operator omitted the leading slash (e.g. "api/sales/order").
    const explicitPath = normalizeApiPath(cred.apiPath);
    const primaryPath = explicitPath ?? DEFAULT_ODOO_ORDERS_API_PATH;
    const fallbackPath = '/api/sale.order';

    // Build a custom https agent that skips SSL certificate verification when
    // rejectUnauthorizedSsl is explicitly set to false.  This is necessary for
    // Odoo dev/staging instances whose hostname (e.g. *.dev.odoo.com) does not
    // match the server certificate (e.g. *.odoo.com).  Defaults to true (verify).
    const sslVerify = cred.rejectUnauthorizedSsl !== false;
    const httpsAgent = new https.Agent({ rejectUnauthorized: sslVerify });

    if (!sslVerify) {
      this.logger.warn(
        `OdooCredential region=${cred.region}: SSL certificate verification is DISABLED. ` +
          `Set rejectUnauthorizedSsl=true once the server certificate covers this hostname.`,
      );
    }

    /**
     * Attempt a single GET against the given path at the given page offset.
     * Returns the AxiosResponse on success.
     * Returns null on 404 only when no explicit path is configured (auto-discovery
     * mode); otherwise throws BadGatewayException for all errors including 404.
     * Throws BadGatewayException for non-404 AxiosErrors in all cases.
     */
    const tryFetch = async (
      apiPath: string,
      offset: number,
    ): Promise<AxiosResponse<unknown> | null> => {
      try {
        return await axios.get<unknown>(`${baseUrl}${apiPath}`, {
          headers: { 'x-api-key': cred.apiKey },
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
            limit: CREDENTIAL_PAGE_SIZE,
            offset,
          },
          httpsAgent,
          timeout: CREDENTIAL_FETCH_TIMEOUT_MS,
        });
      } catch (err: unknown) {
        if (err instanceof AxiosError) {
          const status = err.response?.status;
          // On 404 without an explicit path, return null so we can auto-discover.
          if (status === 404 && !explicitPath) {
            return null;
          }
          const data: unknown = err.response?.data;
          // Try to extract a human-readable message from the Odoo error body.
          // Odoo typically returns { error: { message: '...' } } or { message: '...' }.
          // Guard against empty strings by treating them the same as null so the
          // fallback chain reaches err.message when the body carries no useful text.
          let odooMessage: string;
          if (typeof data === 'string' && data) {
            odooMessage = data;
          } else if (typeof data === 'object' && data !== null) {
            const d = data as Record<string, unknown>;
            const nested =
              typeof d['error'] === 'object' && d['error'] !== null
                ? (d['error'] as Record<string, unknown>)
                : null;
            odooMessage =
              (nested &&
              typeof nested['message'] === 'string' &&
              nested['message']
                ? nested['message']
                : null) ??
              (typeof d['message'] === 'string' && d['message']
                ? d['message']
                : null) ??
              (typeof d['error'] === 'string' && d['error']
                ? d['error']
                : null) ??
              err.message;
          } else {
            odooMessage = err.message;
          }
          const hint =
            status === 404
              ? ` — endpoint not found at ${baseUrl}${apiPath}; update the credential's apiPath (e.g. /api/sale.order or /api/pos/order)`
              : '';
          throw new BadGatewayException(
            `Odoo API error for region ${cred.region}${status ? ` (HTTP ${status})` : ''}: ${odooMessage}${hint}`,
          );
        }
        throw err;
      }
    };

    // ── First page — includes auto-discovery ─────────────────────────────────
    let resolvedPath = primaryPath;
    let firstResp = await tryFetch(primaryPath, 0);

    if (firstResp === null) {
      // primaryPath returned 404 and no explicit path is configured — try the
      // sale-order REST endpoint as an automatic fallback.
      this.logger.warn(
        `OdooCredential region=${cred.region}: "${baseUrl}${primaryPath}" returned 404, ` +
          `retrying with "${fallbackPath}" (auto-discovery).`,
      );
      const fallbackResp = await tryFetch(fallbackPath, 0);
      if (fallbackResp === null) {
        // Both endpoints returned 404 while in auto-discovery mode (no explicit
        // apiPath was set on this credential). Surface a clear error so the operator
        // knows they must configure apiPath explicitly.
        throw new BadGatewayException(
          `Odoo API error for region ${cred.region} (HTTP 404): ` +
            `neither "${baseUrl}${primaryPath}" nor "${baseUrl}${fallbackPath}" were found on the server. ` +
            `Set the credential's apiPath to the correct endpoint to resolve this.`,
        );
      }
      firstResp = fallbackResp;
      resolvedPath = fallbackPath;

      // Persist the discovered path so future cron runs skip the discovery step.
      try {
        await this.prisma.odooCredential.update({
          where: { id: cred.id },
          data: { apiPath: fallbackPath },
        });
        this.logger.log(
          `OdooCredential region=${cred.region}: apiPath auto-set to "${fallbackPath}".`,
        );
      } catch (persistErr) {
        const msg =
          persistErr instanceof Error ? persistErr.message : String(persistErr);
        // Log at error level: if the persist fails, every subsequent cron run will
        // hit the discovery round-trip again instead of using the cached path.
        this.logger.error(
          `OdooCredential region=${cred.region}: failed to persist discovered apiPath "${fallbackPath}" — ` +
            `future runs will repeat auto-discovery until this is resolved: ${msg}`,
        );
      }
    }

    // ── Pagination loop — fetch all pages ────────────────────────────────────
    // Strategy: pre-fetch the next page while upserting the current page so
    // that network I/O and DB writes overlap.  Pages are processed immediately
    // as they arrive instead of accumulating all records in memory first, which
    // keeps memory usage bounded regardless of result-set size.
    //
    // allOrders is still accumulated and returned so that runCredentialBackupJob
    // can pass the records through the ingestion pipeline without a second DB
    // round-trip.  For typical 15-minute incremental runs the set is small; for
    // large initial loads the caller streams ingestion from the same slice.
    const allOrders: OdooOrder[] = [];
    let saved = 0;
    let skipped = 0;

    let currentPageOrders = this.extractOrderList(firstResp.data);
    // `offset` always holds the starting offset of the NEXT page to fetch.
    // The current page's offset is therefore `offset - CREDENTIAL_PAGE_SIZE`.
    let offset = CREDENTIAL_PAGE_SIZE;

    while (true) {
      // Start fetching the next page in the background before we begin
      // upserting the current page — this hides network latency behind DB work.
      const nextPageFetch: Promise<AxiosResponse<unknown> | null> =
        currentPageOrders.length === CREDENTIAL_PAGE_SIZE
          ? tryFetch(resolvedPath, offset)
          : Promise.resolve(null);

      // Upsert every order in the current page.
      for (const order of currentPageOrders) {
        try {
          await this.upsertOrder(order, cred.region);
          saved++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to persist Odoo order id=${order.id} name=${order.name ?? 'no-name'} region=${cred.region}: ${msg}`,
          );
          skipped++;
        }
      }

      allOrders.push(...currentPageOrders);

      // Last page reached — no more records to fetch.
      if (currentPageOrders.length < CREDENTIAL_PAGE_SIZE) break;

      const currentPageOffset = offset - CREDENTIAL_PAGE_SIZE;
      this.logger.debug(
        `OdooCredential region=${cred.region}: processed page at offset=${currentPageOffset}, ` +
          `total so far=${allOrders.length}, saved=${saved}, skipped=${skipped}`,
      );

      let nextResp: AxiosResponse<unknown> | null;
      try {
        nextResp = await nextPageFetch;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BadGatewayException(
          `Odoo API error for region ${cred.region} while fetching page at offset=${offset}: ${msg}`,
        );
      }

      if (!nextResp) break; // guard against unexpected null on non-first pages
      currentPageOrders = this.extractOrderList(nextResp.data);
      offset += CREDENTIAL_PAGE_SIZE;
    }

    return { saved, skipped, orders: allOrders };
  }

  /** Flatten various Odoo REST API response envelopes to a plain order array. */
  private extractOrderList(payload: unknown): OdooOrder[] {
    if (Array.isArray(payload)) return this.normalizeOrderItems(payload);
    if (typeof payload === 'object' && payload !== null) {
      const p = payload as Record<string, unknown>;
      // IBQ unified API: { results: [{ order: { order_id, ... } }] }
      if (Array.isArray(p['results']))
        return this.normalizeOrderItems(p['results']);
      if (Array.isArray(p['records']))
        return this.normalizeOrderItems(p['records']);
      // Some Odoo/IBQ variants return { orders: [...] } at the top level
      if (Array.isArray(p['orders']))
        return this.normalizeOrderItems(p['orders']);
      // Odoo 17/18 REST API: { result: { records: [...], length: N } }
      // or { result: { data: [...], count: N } } or { result: { orders: [...] } }.
      // This nested-object case is checked before the direct-array fallbacks below
      // so the more specific envelope pattern takes precedence.
      if (
        typeof p['result'] === 'object' &&
        p['result'] !== null &&
        !Array.isArray(p['result'])
      ) {
        const inner = p['result'] as Record<string, unknown>;
        if (Array.isArray(inner['records']))
          return this.normalizeOrderItems(inner['records']);
        if (Array.isArray(inner['data']))
          return this.normalizeOrderItems(inner['data']);
        if (Array.isArray(inner['orders']))
          return this.normalizeOrderItems(inner['orders']);
      }
      if (Array.isArray(p['result']))
        return this.normalizeOrderItems(p['result']);
      if (Array.isArray(p['data'])) return this.normalizeOrderItems(p['data']);

      // Generic fallback: scan all top-level keys for the first non-empty array.
      // Covers custom Odoo REST modules that use non-standard envelope keys.
      const found = findArrayInPayload(p);
      if (found) {
        if (found.length > 0) {
          this.logger.debug(
            `extractOrderList: using generic fallback (${found.length} items)`,
          );
        }
        return this.normalizeOrderItems(found);
      }
    }
    return [];
  }

  /**
   * Normalize a raw array of order items from any Odoo/IBQ API variant into
   * the OdooOrder shape consumed by the rest of the service.
   *
   * Handles two envelope patterns:
   *  1. Standard Odoo REST: each element IS the order object.
   *  2. IBQ unified API: each element is `{ order: { order_id, amount_paid, ... } }`.
   *     In this case the inner `order` object is unwrapped and field aliases are
   *     normalised (`order_id` → `id`, `amount_paid` → `amount_total`).
   */
  private normalizeOrderItems(items: unknown[]): OdooOrder[] {
    return items.map((item) => {
      if (typeof item !== 'object' || item === null) return item as OdooOrder;
      const raw = item as Record<string, unknown>;

      // IBQ unified API wraps each order in a { order: { ... } } envelope.
      const inner =
        typeof raw['order'] === 'object' && raw['order'] !== null
          ? (raw['order'] as Record<string, unknown>)
          : raw;

      // Normalise field name aliases used by IBQ's unified endpoint.
      const normalised: Record<string, unknown> = { ...inner };
      // `order_id` is the primary key in IBQ responses; map it to `id` so
      // upsertOrder and logging code that references `order.id` works correctly.
      if (normalised['id'] == null && normalised['order_id'] != null) {
        normalised['id'] = normalised['order_id'];
      }
      // `amount_paid` is the IBQ equivalent of Odoo's `amount_total`.
      if (
        normalised['amount_total'] == null &&
        normalised['amount_paid'] != null
      ) {
        normalised['amount_total'] = normalised['amount_paid'];
      }

      return normalised as unknown as OdooOrder;
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves the raw payment array from an Odoo order, preferring
   * `statement_ids` (Odoo v15) when non-empty and falling back to
   * `payment_ids` (Odoo v18) otherwise. Returns an empty array when neither
   * field contains data.
   */
  private extractPaymentItems(order: OdooOrder): unknown[] {
    if (Array.isArray(order.statement_ids) && order.statement_ids.length > 0) {
      return order.statement_ids;
    }
    if (Array.isArray(order.payment_ids)) {
      return order.payment_ids;
    }
    return [];
  }

  /**
   * Upserts one Odoo order and its related line items and payments.
   * Uses the @@unique([orderId]) constraint on BackupOdooOrder to prevent
   * duplicate header rows.
   *
   * @param order           Raw order from the Odoo API
   * @param region          Region identifier from the credential (optional)
   * @param resolvedBranchCode  Canonical branchCode from StoreConfiguration (optional)
   */
  private async upsertOrder(
    order: OdooOrder,
    region?: string | null,
    resolvedBranchCode?: string | null,
  ): Promise<void> {
    const branchId = resolveId(order.branch_id);
    // Try to get the branch name from the Many2one field; fall back to the
    // part of the order name before the first "/" (e.g. "CCNTRBHR" from
    // "CCNTRBHR/2139") when the API only returns the branch ID integer.
    const branchName =
      resolveName(order.branch_id) ??
      (typeof order.name === 'string' && order.name.includes('/')
        ? order.name.split('/')[0]
        : null);
    const partnerId = resolveId(order.partner_id);
    const partnerName = resolveName(order.partner_id);
    const dateOrder = order.date_order ? new Date(order.date_order) : null;

    // ── Extra fields that match the old integration's BACKUP_VENDHQ_SALES mapping ──
    // warehouse_id → OUTLET_NAME
    const warehouseId = resolveId(order['warehouse_id'] as Many2OneField);
    const warehouseName = resolveName(order['warehouse_id'] as Many2OneField);
    // pos_config_id or session_id → REGISTER_NAME
    const posConfigId = resolveId(order['pos_config_id'] as Many2OneField);
    const posConfigName =
      resolveName(order['pos_config_id'] as Many2OneField) ??
      resolveName(order['session_id'] as Many2OneField);
    // amount_untaxed → TOTAL_PRICE (subtotal excl. tax)
    const amountUntaxed =
      order['amount_untaxed'] != null ? Number(order['amount_untaxed']) : null;
    // amount_discount → TOTAL_LOYALTY (discount/loyalty amount)
    const amountDiscount =
      order['amount_discount'] != null
        ? Number(order['amount_discount'])
        : null;
    // Customer type from tags or partner type
    const customerType =
      typeof order['customer_type'] === 'string'
        ? order['customer_type']
        : null;

    const orderData = {
      orderName: order.name ?? null,
      branchId,
      branchName,
      dateOrder,
      amountTotal:
        order.amount_total != null ? Number(order.amount_total) : null,
      amountUntaxed,
      amountTax: order.amount_tax != null ? Number(order.amount_tax) : null,
      amountDiscount,
      state: typeof order.state === 'string' ? order.state : null,
      partnerId,
      partnerName,
      warehouseId,
      warehouseName,
      posConfigId,
      posConfigName,
      customerType,
      timezone: typeof order.timezone === 'string' ? order.timezone : null,
      region: region ?? null,
      resolvedBranchCode: resolvedBranchCode ?? null,
      rawJson: order as object,
    };

    const upserted = await this.prisma.backupOdooOrder.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, ...orderData },
      update: orderData,
      select: { id: true },
    });
    const parentId = upserted.id;

    // ── Order lines ──────────────────────────────────────────────────────────
    // Odoo POS uses `lines`, sale orders use `order_line`, some versions use
    // `line_ids`.  Filter out any integer-only entries (IDs without data) that
    // some API variants return instead of full embedded objects.
    const rawLineItems: unknown[] = Array.isArray(order.lines)
      ? order.lines
      : Array.isArray(order.order_line)
        ? order.order_line
        : Array.isArray(order['line_ids'])
          ? (order['line_ids'] as unknown[])
          : [];
    const lines: OdooOrderLine[] = rawLineItems.filter(
      (l): l is OdooOrderLine => typeof l === 'object' && l !== null,
    );

    if (lines.length > 0) {
      // Pre-fetch all existing lines for this order to avoid N+1 queries
      const existingLines = await this.prisma.backupOdooOrderLine.findMany({
        where: { orderId: order.id },
        select: { id: true, lineId: true },
      });
      const existingLineMap = new Map(
        existingLines
          .filter(
            (l: { id: string; lineId: number | null }) => l.lineId != null,
          )
          .map((l: { id: string; lineId: number | null }) => [
            l.lineId as number,
            l.id,
          ]),
      );

      for (const line of lines) {
        const productId = resolveId(line.product_id);
        const productName = resolveName(line.product_id);
        const lineId = typeof line.id === 'number' ? line.id : null;

        // Product internal reference / SKU (default_code or product_code) → ITEM_NUMBER
        const productCode =
          typeof line['product_code'] === 'string'
            ? line['product_code']
            : typeof line['default_code'] === 'string'
              ? line['default_code']
              : null;

        // Tax name from tax_id Many2many field — first entry's name → TAX_NAME
        const taxName = extractFirstTaxName(line['tax_id']);

        const lineData = {
          orderId: order.id,
          lineId,
          productId,
          productName,
          productCode,
          qty: resolveQty(line),
          priceUnit: line.price_unit != null ? Number(line.price_unit) : null,
          priceSubtotal:
            line.price_subtotal != null ? Number(line.price_subtotal) : null,
          priceSubtotalIncl:
            line.price_subtotal_incl != null
              ? Number(line.price_subtotal_incl)
              : null,
          discount: line.discount != null ? Number(line.discount) : null,
          taxName,
          parentOrderId: parentId,
        };

        const existingId =
          lineId != null ? existingLineMap.get(lineId) : undefined;
        if (existingId) {
          await this.prisma.backupOdooOrderLine.update({
            where: { id: existingId },
            data: lineData,
          });
        } else {
          await this.prisma.backupOdooOrderLine.create({ data: lineData });
        }
      }
    }

    // ── Payments — Odoo v15 uses statement_ids, v18 may use payment_ids ──────
    // Filter out integer-only entries for the same reason as lines above.
    // Only prefer statement_ids when it is non-empty; otherwise fall through to
    // payment_ids so that v18 orders whose statement_ids is [] but payment_ids
    // carries real data are not silently dropped.
    const rawPayments: OdooOrderPayment[] = this.extractPaymentItems(order).filter(
      (p): p is OdooOrderPayment => typeof p === 'object' && p !== null,
    );

    if (rawPayments.length > 0) {
      // Pre-fetch all existing payments for this order to avoid N+1 queries
      const existingPayments =
        await this.prisma.backupOdooOrderPayment.findMany({
          where: { orderId: order.id },
          select: { id: true, paymentId: true },
        });
      const existingPaymentMap = new Map(
        existingPayments
          .filter(
            (p: { id: string; paymentId: number | null }) =>
              p.paymentId != null,
          )
          .map((p: { id: string; paymentId: number | null }) => [
            p.paymentId as number,
            p.id,
          ]),
      );

      for (const pmt of rawPayments) {
        const pmtId = typeof pmt.id === 'number' ? pmt.id : null;

        // Payment method name — uses extractPaymentName() helper for clear resolution order
        const paymentName = extractPaymentName(pmt);

        // Currency code from currency_id Many2one → CURRENCY
        const currency = Array.isArray(pmt.currency_id)
          ? typeof (pmt.currency_id as [number, unknown])[1] === 'string'
            ? pmt.currency_id[1]
            : null
          : null;

        // Payment date → PAYMENT_DATE
        const paymentDateRaw = pmt.date ?? pmt.payment_date;
        const paymentDate =
          typeof paymentDateRaw === 'string' ? new Date(paymentDateRaw) : null;

        const pmtData = {
          orderId: order.id,
          paymentId: pmtId,
          paymentName,
          amount: pmt.amount != null ? Number(pmt.amount) : null,
          currency,
          paymentDate,
          parentOrderId: parentId,
        };

        const existingId =
          pmtId != null ? existingPaymentMap.get(pmtId) : undefined;
        if (existingId) {
          await this.prisma.backupOdooOrderPayment.update({
            where: { id: existingId },
            data: pmtData,
          });
        } else {
          await this.prisma.backupOdooOrderPayment.create({ data: pmtData });
        }
      }
    }
  }
}
