/**
 * OdooBackupService — scheduled backup of orders from the main Odoo instance
 * (configured via ODOO_BASE_URL / ODOO_API_KEY env vars) into the local Oracle
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
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  FindOptionsWhere,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import axios, { AxiosError, AxiosResponse } from 'axios';
import * as https from 'https';
import * as oracledb from 'oracledb';
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
  RawOdooOrderFields,
} from '../common/odoo-utils';
import { generateId } from '../database/id.util';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { BackupOdooOrderPayment } from '../database/entities/backup-odoo-order-payment.entity';
import { OdooBackupState } from '../database/entities/odoo-backup-state.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { OrderSyncService } from '../sync/order-sync.service';
import { SyncControlService } from '../sync/sync-control.service';

const DEFAULT_SOURCE = 'default';
/** Default REST endpoint used to fetch POS orders from Odoo. */
const DEFAULT_ODOO_ORDERS_API_PATH = '/api/pos/order';
/** Number of records fetched per page during paginated credential backup. */
const CREDENTIAL_PAGE_SIZE = 200;
/** Per-request HTTP timeout (ms) for credential backup fetches. */
const CREDENTIAL_FETCH_TIMEOUT_MS = 120_000;
/**
 * How many order upserts / ingests run concurrently. Each order is several
 * independent DB round-trips, so overlapping them is the single biggest lever
 * on pull throughput. Bounded so we never exceed the Oracle connection pool
 * (APP_DB_POOL_MAX). Overridable via env for tuning.
 */
// Kept a little below the DB pool size (APP_DB_POOL_MAX, default 16) so several
// region pulls can run at once without starving the pool or the API of warm
// connections. Raise ODOO_INGEST_CONCURRENCY (and the pool) for single-region
// bulk backfills.
const INGEST_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.ODOO_INGEST_CONCURRENCY ?? '10', 10),
);

/** Progress reported during a credential backup+ingest, for live UIs. */
export interface BackupProgress {
  phase: 'BACKUP' | 'INGEST';
  done: number;
  total: number;
}

/**
 * Runs `worker` over `items` with at most `concurrency` promises in flight,
 * invoking `onEach(done)` after each item completes. Never rejects — the worker
 * is responsible for catching its own per-item errors — so one bad record can't
 * abort the whole batch.
 */
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  onEach?: (done: number) => void,
): Promise<void> {
  let cursor = 0;
  let done = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
      done += 1;
      if (onEach) onEach(done);
    }
  };
  const lanes = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length) },
    () => runNext(),
  );
  await Promise.all(lanes);
}

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
 * Extract the first tax name from an Odoo Many2many tax field.
 *
 * Handles four common formats:
 *   - `[[id, "VAT 5%"], ...]`  — tuple array (most common in POS)
 *   - `["VAT 5%", ...]`        — plain string array
 *   - `"VAT 5%"`               — plain string (non-standard)
 *   - `[61, ...]`              — integer ID-only array (no name available → null)
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
  // Plain integer ID-only array — name is not embedded; return null gracefully.
  if (typeof first === 'number') return null;

  return null;
}

/**
 * Extract tax IDs from Odoo tax_ids or tax_id field and return as JSON string array.
 * Handles both plain integer arrays and Many2one tuple arrays.
 *
 * @example
 *   extractTaxIdsJson([26, 27])           → "[26,27]"
 *   extractTaxIdsJson([[26, "VAT 5%"]])   → "[26]"
 *   extractTaxIdsJson(null)               → null
 */
function extractTaxIdsJson(taxField: unknown): string | null {
  if (!Array.isArray(taxField) || taxField.length === 0) return null;

  const ids = taxField
    .map((t) => (typeof t === 'number' ? t : Array.isArray(t) ? t[0] : null))
    .filter((t) => t != null);

  return ids.length > 0 ? JSON.stringify(ids) : null;
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
    @InjectRepository(BackupOdooOrder)
    private readonly orders: Repository<BackupOdooOrder>,
    @InjectRepository(BackupOdooOrderLine)
    private readonly orderLines: Repository<BackupOdooOrderLine>,
    @InjectRepository(BackupOdooOrderPayment)
    private readonly orderPayments: Repository<BackupOdooOrderPayment>,
    @InjectRepository(OdooBackupState)
    private readonly backupState: Repository<OdooBackupState>,
    @InjectRepository(OdooCredential)
    private readonly credentials: Repository<OdooCredential>,
    @InjectRepository(StoreConfiguration)
    private readonly storeConfigs: Repository<StoreConfiguration>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly odooClient: OdooClient,
    @Inject(forwardRef(() => OrderSyncService))
    private readonly orderSyncService: OrderSyncService,
    @Inject(forwardRef(() => SyncControlService))
    private readonly syncControl: SyncControlService,
  ) {}

  /**
   * Scheduled cron: backs up all new/updated Odoo orders every 15 minutes
   * using the lastSyncAt watermark stored in OdooBackupState.
   */
  @Cron('0 */15 * * * *')
  async runBackupJob(): Promise<void> {
    // Check if sync control allows this service to run
    const enabled = await this.syncControl.isEnabled('odoo-backup');
    if (!enabled) {
      this.logger.debug('Odoo backup service is disabled, skipping cron run');
      return;
    }

    await this.syncControl.markRunning('odoo-backup');
    try {
      const state = await this.backupState.findOne({
        where: { source: DEFAULT_SOURCE },
      });

      const startDate = state?.lastSyncAt
        ? state.lastSyncAt.toISOString()
        : undefined;

      const runAt = new Date();
      const result = await this.backupOrders({ startDate });

      // Pre-load StoreConfigurations for branchCode resolution
      const branchIdMap = await this.loadBranchIdMap();

      // Advance the watermark after a successful cron run
      await this.upsertBackupState(runAt);

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
            odooBranchId != null ? branchIdMap.get(BigInt(odooBranchId)) : null;
          const resolvedBranchCode =
            storeEntry?.branchCode ?? payload.branchCode;
          const resolvedRegion = storeEntry?.region ?? null;

          const backupOrder = await this.orders.findOne({
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

      await this.syncControl.markStopped('odoo-backup', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Odoo backup cron failed: ${msg}`);
      await this.syncControl.markStopped('odoo-backup', 'error');
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
   * every 15 minutes (offset by 7 minutes from the main backup job to avoid overlap).
   * Mirrors the IbqBackupService pattern so all regions are kept in sync
   * automatically without manual intervention.
   */
  @Cron('0 7-59/15 * * * *')
  async runCredentialBackupJob(): Promise<void> {
    // Check if sync control allows this service to run
    const enabled = await this.syncControl.isEnabled('odoo-backup');
    if (!enabled) {
      this.logger.debug(
        'Odoo credential backup is disabled, skipping cron run',
      );
      return;
    }

    const credentials = await this.credentials.find({
      where: { active: true },
    });

    if (credentials.length === 0) {
      return;
    }

    for (const cred of credentials) {
      const runAt = new Date();
      try {
        await this.backupAndIngestForCredential(cred, {
          startDate: cred.lastSyncAt?.toISOString(),
        });

        // Advance the per-credential watermark after the ingestion loop so that
        // any backup failure (backupAndIngestForCredential throwing) prevents the
        // watermark from advancing and the orders are re-fetched on the next run.
        await this.credentials.update({ id: cred.id }, { lastSyncAt: runAt });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Odoo credential backup failed for region=${cred.region} url=${cred.baseUrl}: ${msg}`,
        );
      }
    }
  }

  /**
   * Pulls orders from one OdooCredential into the backup tables AND ingests
   * them into the OrderSyncQueue with canonical branch codes. Shared by the
   * 15-minute cron (watermark-driven) and the operator-triggered integration
   * run (explicit date range). Does NOT advance the credential watermark.
   */
  async backupAndIngestForCredential(
    cred: OdooCredential,
    params: {
      startDate?: string;
      endDate?: string;
      limit?: number;
      /**
       * Skip the per-order OrderSyncQueue ingest. The Integration Run posts off
       * the BackupOdooOrder tables directly (daily aggregation), so it doesn't
       * need the queue — skipping it removes the slow per-order ingest pass.
       */
      skipIngest?: boolean;
    },
    onProgress?: (p: BackupProgress) => void,
  ): Promise<{
    saved: number;
    skipped: number;
    ingested: number;
    ingestSkipped: number;
    total: number;
  }> {
    // Pre-load all active StoreConfiguration records so we can resolve the
    // canonical branchCode for each Odoo order's numeric branch_id without
    // issuing a separate DB query per order.
    const branchIdMap = await this.loadBranchIdMap();

    const result = await this.backupOrdersForCredential(
      cred,
      {
        startDate: params.startDate,
        endDate: params.endDate,
        limit: params.limit, // undefined → fetch all pages
      },
      onProgress,
    );

    if (params.skipIngest) {
      // Sales are posted straight from the BackupOdooOrder tables by daily
      // aggregation, so they don't need the OrderSyncQueue. REFUNDS are the
      // exception: they never aggregate — a refund must flow through the ingest
      // path so a RefundTracking row is created and the CreditMemoService cron
      // pushes its Oracle credit memo. Without this, an Integration Run produces
      // ZERO credit memos for the refunds in its range.
      const refundOrders = result.orders.filter((o) => this.isRefundOrder(o));
      const backupIdByOrderId = await this.mapBackupIds(refundOrders);
      let refundsIngested = 0;
      let refundsSkipped = 0;
      await mapWithConcurrency(refundOrders, INGEST_CONCURRENCY, async (order) => {
        const r = await this.ingestSingleBackupOrder(
          order,
          cred,
          branchIdMap,
          backupIdByOrderId,
        );
        if (r === 'ingested') refundsIngested++;
        else refundsSkipped++;
      });
      this.logger.log(
        `Odoo credential backup done for region=${cred.region}: ` +
          `backup.saved=${result.saved} backup.skipped=${result.skipped} ` +
          `(sales ingest skipped; ${refundsIngested} refund(s) ingested for ` +
          `credit-memo coverage, ${refundsSkipped} skipped).`,
      );
      return {
        saved: result.saved,
        skipped: result.skipped,
        ingested: refundsIngested,
        ingestSkipped: refundsSkipped,
        total: result.orders.length,
      };
    }

    // ── Batch-load the backup-row UUIDs for every fetched order in ONE pass ──
    // Previously this issued a findOne PER order (thousands of round-trips).
    // Oracle caps an IN list at 1000, so chunk the ids.
    const orderIds = result.orders
      .map((o) => (typeof o.id === 'number' ? o.id : null))
      .filter((id): id is number => id !== null);
    const backupIdByOrderId = new Map<number, string>();
    for (let i = 0; i < orderIds.length; i += 1000) {
      const chunk = orderIds.slice(i, i + 1000);
      const rows = await this.orders.find({
        where: { orderId: In(chunk) },
        select: { id: true, orderId: true },
      });
      for (const row of rows) backupIdByOrderId.set(row.orderId, row.id);
    }

    // Ingest backed-up orders into the OrderSyncQueue — concurrently, so the
    // per-order DB round-trips overlap instead of running one at a time.
    let ingested = 0;
    let ingestSkipped = 0;
    const total = result.orders.length;
    await mapWithConcurrency(
      result.orders,
      INGEST_CONCURRENCY,
      async (order) => {
        try {
          const payload = normalizeOrderForIngestion(order);
          if (!payload) {
            this.logger.warn(
              `Odoo order id=${String(order.id)} region=${cred.region} skipped: ` +
                `normalizeOrderForIngestion returned null (missing Odoo fields branch_id or date_order)`,
            );
            ingestSkipped++;
            return;
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
            odooBranchId != null ? branchIdMap.get(BigInt(odooBranchId)) : null;
          const resolvedBranchCode =
            storeEntry?.branchCode ?? payload.branchCode;
          // Prefer region from credential; fall back to StoreConfiguration.region
          const resolvedRegion = cred.region || storeEntry?.region || null;

          await this.orderSyncService.ingestOrder({
            ...payload,
            branchCode: resolvedBranchCode,
            region: resolvedRegion ?? undefined,
            odooBackupOrderId:
              typeof order.id === 'number'
                ? backupIdByOrderId.get(order.id)
                : undefined,
          });
          ingested++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to ingest Odoo order id=${String(order.id)} region=${cred.region}: ${msg}`,
          );
          ingestSkipped++;
        }
      },
      (doneCount) => {
        // Throttle progress events to every 25 records (and the final one).
        if (onProgress && (doneCount % 25 === 0 || doneCount === total)) {
          onProgress({ phase: 'INGEST', done: doneCount, total });
        }
      },
    );

    this.logger.log(
      `Odoo credential backup+ingest done for region=${cred.region}: ` +
        `backup.saved=${result.saved} backup.skipped=${result.skipped} ` +
        `ingest.queued=${ingested} ingest.skipped=${ingestSkipped}`,
    );
    return {
      saved: result.saved,
      skipped: result.skipped,
      ingested,
      ingestSkipped,
      total: result.orders.length,
    };
  }

  /** A refund is an explicit is_refund flag or a negative total (Odoo parity). */
  private isRefundOrder(order: OdooOrder): boolean {
    const amt = Number(order.amount_total ?? 0);
    return (
      Boolean((order as unknown as { is_refund?: unknown }).is_refund) || amt < 0
    );
  }

  /** Batch-load backup-row UUIDs by numeric Odoo order id (Oracle IN cap 1000). */
  private async mapBackupIds(
    orders: OdooOrder[],
  ): Promise<Map<number, string>> {
    const orderIds = orders
      .map((o) => (typeof o.id === 'number' ? o.id : null))
      .filter((id): id is number => id !== null);
    const map = new Map<number, string>();
    for (let i = 0; i < orderIds.length; i += 1000) {
      const chunk = orderIds.slice(i, i + 1000);
      const rows = await this.orders.find({
        where: { orderId: In(chunk) },
        select: { id: true, orderId: true },
      });
      for (const row of rows) map.set(row.orderId, row.id);
    }
    return map;
  }

  /**
   * Ingest one backed-up Odoo order into the OrderSyncQueue (resolving the
   * canonical branchCode/region), returning whether it was ingested or skipped.
   * Shared by the refunds-only pass and, conceptually, the full ingest loop.
   */
  private async ingestSingleBackupOrder(
    order: OdooOrder,
    cred: OdooCredential,
    branchIdMap: Map<bigint, { branchCode: string; region: string | null }>,
    backupIdByOrderId: Map<number, string>,
  ): Promise<'ingested' | 'skipped'> {
    try {
      const payload = normalizeOrderForIngestion(order);
      if (!payload) {
        this.logger.warn(
          `Odoo order id=${String(order.id)} region=${cred.region} skipped: ` +
            `normalizeOrderForIngestion returned null (missing branch_id/date_order)`,
        );
        return 'skipped';
      }
      const odooBranchId =
        order.branch_id != null
          ? Array.isArray(order.branch_id)
            ? order.branch_id[0]
            : order.branch_id
          : null;
      const storeEntry =
        odooBranchId != null ? branchIdMap.get(BigInt(odooBranchId)) : null;
      const resolvedBranchCode = storeEntry?.branchCode ?? payload.branchCode;
      const resolvedRegion = cred.region || storeEntry?.region || null;
      await this.orderSyncService.ingestOrder({
        ...payload,
        branchCode: resolvedBranchCode,
        region: resolvedRegion ?? undefined,
        odooBackupOrderId:
          typeof order.id === 'number'
            ? backupIdByOrderId.get(order.id)
            : undefined,
      });
      return 'ingested';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to ingest Odoo order id=${String(order.id)} region=${cred.region}: ${msg}`,
      );
      return 'skipped';
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

    const apiPath =
      normalizeApiPath(cred.apiPath) ?? DEFAULT_ODOO_ORDERS_API_PATH;

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
        const body = err.response?.data as unknown;
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
   * Read-only live reconciliation: a single lightweight GET (limit=1) for a
   * region + date range that returns the server-advertised TOTAL order count for
   * that range — without fetching every page or writing anything. The caller
   * compares it to the stored backup count. Never throws.
   */
  async reconcileForCredential(
    cred: {
      baseUrl: string;
      apiKey: string;
      region: string;
      apiPath?: string | null;
      rejectUnauthorizedSsl?: boolean | null;
    },
    params: { startDate?: string; endDate?: string },
  ): Promise<{
    ok: boolean;
    url: string;
    status: number | null;
    apiTotal: number | null;
    sampleCount: number;
    error: string | null;
  }> {
    const rawBase = cred.baseUrl.replace(/\/$/, '');
    const baseUrl = /^https?:\/\//i.test(rawBase)
      ? rawBase
      : `https://${rawBase}`;
    const apiPath =
      normalizeApiPath(cred.apiPath) ?? DEFAULT_ODOO_ORDERS_API_PATH;
    const url = `${baseUrl}${apiPath}`;
    const sslVerify = cred.rejectUnauthorizedSsl !== false;
    const httpsAgent = new https.Agent({ rejectUnauthorized: sslVerify });

    try {
      const response = await axios.get<unknown>(url, {
        headers: { 'x-api-key': cred.apiKey },
        params: {
          limit: 1,
          offset: 0,
          ...(params.startDate && {
            start_date: toApiDatetime(params.startDate),
          }),
          ...(params.endDate && {
            end_date: toApiDatetime(params.endDate, { end: true }),
          }),
        },
        httpsAgent,
        timeout: 20_000,
      });
      return {
        ok: true,
        url,
        status: response.status,
        apiTotal: this.extractTotalFromResponse(response.data),
        sampleCount: this.extractOrderList(response.data).length,
        error: null,
      };
    } catch (err: unknown) {
      const status =
        err instanceof AxiosError ? (err.response?.status ?? null) : null;
      return {
        ok: false,
        url,
        status,
        apiTotal: null,
        sampleCount: 0,
        error: err instanceof Error ? err.message : String(err),
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
    onProgress?: (p: BackupProgress) => void,
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
      this.logger.error(
        `⚠️  SECURITY WARNING: OdooCredential region=${cred.region}: SSL certificate verification is DISABLED! ` +
          `This is a security risk and should only be used for dev/staging environments. ` +
          `Set rejectUnauthorizedSsl=true once the server certificate covers this hostname.`,
      );
    } else {
      this.logger.log(
        `✅ SSL certificate verification is ENABLED for OdooCredential region=${cred.region}`,
      );
    }

    // params.limit sets the per-page fetch size sent to the Odoo API.
    // When omitted the default CREDENTIAL_PAGE_SIZE (200) is used.  Note that
    // this controls only the page size — pagination continues until a page
    // shorter than effectivePageSize is received, so the total records returned
    // may exceed the value passed here.  Callers that need a hard cap on total
    // records must slice the returned orders array after this method returns.
    const effectivePageSize = params.limit ?? CREDENTIAL_PAGE_SIZE;

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
      limitOverride?: number,
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
            limit: limitOverride ?? effectivePageSize,
            offset,
          },
          httpsAgent,
          // A single full-set fetch (limitOverride) can return thousands of
          // rows, so allow it more time than a normal page.
          timeout: limitOverride
            ? Math.max(CREDENTIAL_FETCH_TIMEOUT_MS, 120_000)
            : CREDENTIAL_FETCH_TIMEOUT_MS,
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
        await this.credentials.update(
          { id: cred.id },
          { apiPath: fallbackPath },
        );
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
    // that network I/O and DB writes overlap.
    //
    // Exit conditions (evaluated in order after each page):
    //   1. Count-verified: fetched >= totalExpected (uses server-reported total
    //      when available — handles short pages from deleted records correctly).
    //   2. Short page: page.length < effectivePageSize (fallback when the server
    //      does not report a total count).
    //   3. Duplicate-page guard: the server returned the same IDs as the previous
    //      page, meaning offset pagination is non-functional — stop immediately
    //      to prevent an infinite loop instead of silently re-ingesting records.
    //
    // allOrders is accumulated and returned so runCredentialBackupJob can pass
    // each page through the ingestion pipeline without a second DB round-trip.
    // Incremental 15-minute cron runs fetch only new records, so the in-memory
    // set remains small in normal operation.  Very large initial back-fills
    // should be run in date-range slices via the manual fetch-odoo endpoint.

    // Extract total count from the first response (null when not advertised).
    const totalExpected = this.extractTotalFromResponse(firstResp.data);
    const totalPages =
      totalExpected !== null
        ? Math.ceil(totalExpected / effectivePageSize)
        : null;

    if (totalExpected !== null) {
      this.logger.log(
        `OdooCredential region=${cred.region}: server reports ${totalExpected} total records` +
          ` (${totalPages} page${totalPages === 1 ? '' : 's'} of ${effectivePageSize}).`,
      );
    }

    const allOrders: OdooOrder[] = [];
    const prevPageIds = new Set<number>();

    let currentPageOrders = this.extractOrderList(firstResp.data);
    let currentOffset = 0;
    let nextOffset = effectivePageSize;
    let pageNumber = 1;
    let saved = 0;
    let skipped = 0;

    while (true) {
      // ── Duplicate-page detection ──────────────────────────────────────────
      // If the server returns the same set of IDs as the previous page, offset
      // pagination is not working.  Break immediately to prevent an infinite
      // loop that would silently re-ingest the same records on every iteration.
      if (prevPageIds.size > 0 && currentPageOrders.length > 0) {
        const currentIds = currentPageOrders
          .map((o) => (typeof o.id === 'number' ? o.id : null))
          .filter((id): id is number => id !== null);
        const dupeCount = currentIds.filter((id) => prevPageIds.has(id)).length;

        if (dupeCount === currentIds.length) {
          // This endpoint ignores `offset` (every page repeats the first), but
          // it DOES honour a large `limit` — so fetch the whole result set in a
          // single request instead of stopping at one page. Only the records not
          // already ingested from page 1 are processed (upsert is idempotent, but
          // this avoids redundant work). Falls back to stopping if the total is
          // unknown or the full fetch fails.
          if (totalExpected !== null && totalExpected > allOrders.length) {
            this.logger.warn(
              `OdooCredential region=${cred.region}: offset pagination not supported ` +
                `by this endpoint — refetching all ${totalExpected} records in a single ` +
                `request (limit=${totalExpected}).`,
            );
            let fullResp: AxiosResponse<unknown> | null = null;
            try {
              fullResp = await tryFetch(resolvedPath, 0, totalExpected);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              this.logger.error(
                `OdooCredential region=${cred.region}: full-set refetch failed: ${msg} — ` +
                  `keeping the ${allOrders.length} record(s) already fetched.`,
              );
            }
            if (fullResp) {
              const fullList = this.extractOrderList(fullResp.data);
              const seen = new Set(
                allOrders
                  .map((o) => (typeof o.id === 'number' ? o.id : null))
                  .filter((id): id is number => id !== null),
              );
              const remaining = fullList.filter(
                (o) => typeof o.id !== 'number' || !seen.has(o.id),
              );
              // Bulk-persist — the throughput-critical path for endpoints that
              // ignore offset (thousands of records at once).
              const backupTotal = allOrders.length + remaining.length;
              const baseline = allOrders.length;
              const persisted = await this.persistOrders(
                remaining,
                cred.region,
                (doneCount) => {
                  const done = baseline + doneCount;
                  if (onProgress && (done % 100 === 0 || doneCount === remaining.length)) {
                    onProgress({ phase: 'BACKUP', done, total: backupTotal });
                  }
                },
              );
              saved += persisted.saved;
              skipped += persisted.skipped;
              allOrders.push(...remaining);
              this.logger.log(
                `OdooCredential region=${cred.region}: full-set refetch added ` +
                  `${remaining.length} record(s) — total ${allOrders.length}/${totalExpected}.`,
              );
            }
          } else {
            this.logger.warn(
              `OdooCredential region=${cred.region}: page at offset=${currentOffset} is ` +
                `identical to the previous page — offset pagination is not supported by ` +
                `this endpoint; stopping to prevent an infinite loop.`,
            );
          }
          break;
        }
        if (dupeCount > 0) {
          this.logger.warn(
            `OdooCredential region=${cred.region}: page at offset=${currentOffset} ` +
              `contains ${dupeCount} duplicate IDs from the previous page.`,
          );
        }
        prevPageIds.clear();
        currentIds.forEach((id) => prevPageIds.add(id));
      } else {
        const currentIds = currentPageOrders
          .map((o) => (typeof o.id === 'number' ? o.id : null))
          .filter((id): id is number => id !== null);
        currentIds.forEach((id) => prevPageIds.add(id));
      }

      // ── Determine whether a next page should be pre-fetched ───────────────
      const fetchedAfterThisPage = allOrders.length + currentPageOrders.length;
      const expectMoreByCount =
        totalExpected !== null
          ? fetchedAfterThisPage < totalExpected
          : currentPageOrders.length >= effectivePageSize;

      // Start fetching the next page in the background before we begin
      // upserting the current page — this hides network latency behind DB work.
      const nextPageFetch: Promise<AxiosResponse<unknown> | null> =
        expectMoreByCount
          ? tryFetch(resolvedPath, nextOffset)
          : Promise.resolve(null);

      // Persist the current page (bulk, with per-order fallback), then add them
      // to the return array.
      const pageBaseline = allOrders.length;
      const pagePersisted = await this.persistOrders(
        currentPageOrders,
        cred.region,
        (doneCount) => {
          const done = pageBaseline + doneCount;
          if (
            onProgress &&
            (done % 100 === 0 || doneCount === currentPageOrders.length)
          ) {
            onProgress({
              phase: 'BACKUP',
              done,
              total: totalExpected ?? done,
            });
          }
        },
      );
      saved += pagePersisted.saved;
      skipped += pagePersisted.skipped;
      allOrders.push(...currentPageOrders);

      // ── Per-page structured log ───────────────────────────────────────────
      this.logger.debug(
        `OdooCredential region=${cred.region}: page ${pageNumber}` +
          (totalPages !== null ? `/${totalPages}` : '') +
          ` offset=${currentOffset}, fetched=${currentPageOrders.length}` +
          `, cumulative=${allOrders.length}` +
          (totalExpected !== null ? `/${totalExpected}` : '') +
          `, saved=${saved}, skipped=${skipped}`,
      );

      // ── Exit conditions ───────────────────────────────────────────────────
      if (!expectMoreByCount) break;

      let nextResp: AxiosResponse<unknown> | null;
      try {
        nextResp = await nextPageFetch;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BadGatewayException(
          `Odoo API error for region ${cred.region} while fetching page at offset=${nextOffset}: ${msg}`,
        );
      }

      if (!nextResp) {
        // tryFetch only returns null for auto-discovery 404s on the first page;
        // receiving null here on a subsequent page is unexpected.
        this.logger.warn(
          `OdooCredential region=${cred.region}: unexpected null response for page at offset=${nextOffset} — stopping pagination.`,
        );
        break;
      }
      currentPageOrders = this.extractOrderList(nextResp.data);
      currentOffset = nextOffset;
      nextOffset += effectivePageSize;
      pageNumber++;
    }

    // ── Completeness validation ───────────────────────────────────────────────
    if (totalExpected !== null && allOrders.length < totalExpected) {
      this.logger.warn(
        `OdooCredential region=${cred.region}: fetched ${allOrders.length} of ` +
          `${totalExpected} expected records — some records may have been missed.`,
      );
    } else if (totalExpected !== null) {
      this.logger.log(
        `OdooCredential region=${cred.region}: fetched all ${allOrders.length}/${totalExpected} records.`,
      );
    }

    return { saved, skipped, orders: allOrders };
  }

  /**
   * Extracts the total record count advertised by the Odoo API response
   * envelope.  Returns `null` when the response does not include a count field
   * (e.g. plain-array responses or custom modules that omit it).
   *
   * Supported patterns:
   *   - `{ length: N, records: [...] }`             — Odoo 17/18 REST
   *   - `{ total: N, ... }`                          — some custom modules
   *   - `{ count: N, ... }`                          — some IBQ variants
   *   - `{ result: { length: N, records: [...] } }`  — nested result envelope
   */
  private extractTotalFromResponse(payload: unknown): number | null {
    if (typeof payload !== 'object' || payload === null) return null;
    // A bare array does not advertise a separate total count — its own
    // `.length` property is just the number of records on this page, not a
    // server-reported grand total.  Treating it as a total would make
    // pagination stop after the first full page (fetched === length), so
    // return null here and let short-page detection drive the loop instead.
    if (Array.isArray(payload)) return null;
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
   * Handles three envelope patterns:
   *  1. Standard Odoo REST: each element IS the order object.
   *  2. IBQ unified API v1: each element is `{ order: { order_id, amount_paid, ... } }`.
   *     In this case the inner `order` object is unwrapped and field aliases are
   *     normalised (`order_id` → `id`, `amount_paid` → `amount_total`).
   *  3. IBQ unified API v2: each element is `{ order: {...}, lines: [...], payments: [...] }`.
   *     The `lines` and `payments` arrays are at the same level as `order` (not nested inside it).
   *     These sibling arrays must be merged into the order object so upsertOrder can find them.
   */
  private normalizeOrderItems(items: unknown[]): OdooOrder[] {
    return items.map((item) => {
      if (typeof item !== 'object' || item === null) return item as OdooOrder;
      const raw = item as Record<string, unknown>;

      // IBQ unified API wraps each order in a { order: { ... } } envelope.
      // Check if this is the IBQ structure with separate order/lines/payments.
      const hasIbqStructure =
        typeof raw['order'] === 'object' && raw['order'] !== null;

      const inner = hasIbqStructure
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

      // IBQ unified API: lines and payments sit as siblings of `order`, named
      // `order_lines` and `order_payment_lines` (NOT `lines`/`payments`), with
      // their own field names. Merge them into the order and map the fields to
      // what upsertOrder reads, or every order stores as a header-only line with
      // no payment. Verified against live ibraqperfumes.odoo.com data.
      const rawLines = raw['order_lines'] ?? raw['lines'];
      if (Array.isArray(rawLines)) {
        normalised['lines'] = rawLines.map((l) => {
          const line = (typeof l === 'object' && l ? l : {}) as Record<
            string,
            unknown
          >;
          return {
            id: line['order_line_id'] ?? line['id'],
            product_id: line['product_id'],
            product_code:
              line['product_barcode'] ??
              line['product_code'] ??
              line['default_code'],
            product_barcode: line['product_barcode'],
            name: line['product_name'] ?? line['name'],
            qty: line['qty'],
            price_unit: line['price_unit'],
            price_subtotal:
              line['price_subtotal_without_tax'] ?? line['price_subtotal'],
            price_subtotal_incl:
              line['price_subtotal_with_tax'] ?? line['price_subtotal_incl'],
            discount: line['discount'],
            product_uom_id: line['base_uom_id'],
            // POS-style payloads carry tax_id (singular tuple array); unified
            // API uses tax_ids — keep whichever is present so TAX_NAME survives.
            tax_ids: line['tax_ids'] ?? line['tax_id'],
          };
        });
      }

      const rawPayments = raw['order_payment_lines'] ?? raw['payments'];
      if (Array.isArray(rawPayments)) {
        normalised['statement_ids'] = rawPayments.map((p) => {
          const pay = (typeof p === 'object' && p ? p : {}) as Record<
            string,
            unknown
          >;
          return {
            id: pay['id'],
            amount: pay['amount'],
            currency_id: pay['currency_id'] ?? pay['currency'],
            payment_method_code: pay['payment_method'],
            name: pay['payment_method'],
          };
        });
      }

      return normalised as unknown as OdooOrder;
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Loads active StoreConfiguration rows into a Map keyed by odooBranchId so an
   * order's numeric branch_id can be resolved to a canonical branchCode/region
   * without a per-order query.
   */
  private async loadBranchIdMap(): Promise<
    Map<bigint, { branchCode: string; region: string | null }>
  > {
    const storeConfigs = await this.storeConfigs.find({
      where: { isActive: true },
      select: { branchCode: true, odooBranchId: true, region: true },
    });
    return new Map(
      storeConfigs.map((sc) => [
        sc.odooBranchId,
        { branchCode: sc.branchCode, region: sc.region ?? null },
      ]),
    );
  }

  /**
   * Upserts the singleton OdooBackupState watermark row for DEFAULT_SOURCE.
   * find-then-save because Oracle has no ON CONFLICT-style upsert here.
   */
  private async upsertBackupState(lastSyncAt: Date): Promise<void> {
    const existing = await this.backupState.findOne({
      where: { source: DEFAULT_SOURCE },
    });
    if (existing) {
      existing.lastSyncAt = lastSyncAt;
      await this.backupState.save(existing);
      return;
    }
    await this.backupState.save(
      this.backupState.create({ source: DEFAULT_SOURCE, lastSyncAt }),
    );
  }

  /**
   * Resolves the raw payment array from an Odoo order, preferring
   * `statement_ids` (Odoo v15) when non-empty, falling back to
   * `payment_ids` (Odoo v18), and then to `payments` (some API variants).
   * Returns an empty array when no field contains data.
   */
  private extractPaymentItems(order: OdooOrder): unknown[] {
    if (Array.isArray(order.statement_ids) && order.statement_ids.length > 0) {
      return order.statement_ids;
    }
    if (Array.isArray(order.payment_ids) && order.payment_ids.length > 0) {
      return order.payment_ids;
    }
    if (Array.isArray(order.payments)) {
      return order.payments;
    }
    return [];
  }

  /**
   * Upserts one Odoo order and its related line items and payments.
   * Uses the unique index on BackupOdooOrder.orderId to prevent duplicate
   * header rows (find-then-save).
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
    const orderData = this.buildOrderColumns(order, region, resolvedBranchCode);

    const existing = await this.orders.findOne({
      where: { orderId: order.id },
      select: { id: true },
    });
    let parentId: string;
    if (existing) {
      await this.orders.update({ id: existing.id }, orderData);
      parentId = existing.id;
    } else {
      const created = await this.orders.save(
        this.orders.create({ orderId: order.id, ...orderData }),
      );
      parentId = created.id;
    }

    const lineDataItems = this.buildLineRows(order, parentId, region);
    if (lineDataItems.length > 0) {
      await this.dataSource.transaction(async (mgr) => {
        await mgr.delete(BackupOdooOrderLine, { orderId: order.id });
        await mgr.insert(BackupOdooOrderLine, lineDataItems);
      });
    }

    const paymentDataItems = this.buildPaymentRows(order, parentId, region);
    if (paymentDataItems.length > 0) {
      await this.dataSource.transaction(async (mgr) => {
        await mgr.delete(BackupOdooOrderPayment, { orderId: order.id });
        await mgr.insert(BackupOdooOrderPayment, paymentDataItems);
      });
    }
  }

  /** Bulk persistence is on by default; ODOO_BULK_PERSIST=false forces the
   *  slower per-order path (kept as a safety valve / fallback). */
  private readonly bulkPersistEnabled =
    process.env.ODOO_BULK_PERSIST !== 'false';
  private static readonly BULK_BATCH = 500;

  /**
   * Persists a set of fetched orders, preferring the fast bulk path and falling
   * back to the per-order upsert for any batch the bulk path rejects. Returns
   * running saved/skipped counts and reports incremental progress.
   */
  private async persistOrders(
    orders: OdooOrder[],
    region: string | null | undefined,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ saved: number; skipped: number }> {
    const total = orders.length;
    let saved = 0;
    let skipped = 0;
    let done = 0;

    const perOrder = async (batch: OdooOrder[]) => {
      await mapWithConcurrency(batch, INGEST_CONCURRENCY, async (o) => {
        try {
          await this.upsertOrder(o, region);
          saved += 1;
        } catch (err) {
          this.logger.warn(
            `Failed to persist Odoo order id=${String(o.id)}: ${err instanceof Error ? err.message : String(err)}`,
          );
          skipped += 1;
        }
      });
    };

    if (!this.bulkPersistEnabled) {
      await perOrder(orders);
      onProgress?.(orders.length, total);
      return { saved, skipped };
    }

    for (let i = 0; i < orders.length; i += OdooBackupService.BULK_BATCH) {
      const batch = orders.slice(i, i + OdooBackupService.BULK_BATCH);
      try {
        const r = await this.bulkUpsertOrders(batch, region);
        saved += r.saved;
        skipped += r.skipped;
      } catch (err) {
        this.logger.error(
          `Bulk persist failed for a ${batch.length}-order batch — falling back ` +
            `to per-order: ${err instanceof Error ? err.message : String(err)}`,
        );
        await perOrder(batch);
      }
      done += batch.length;
      onProgress?.(done, total);
    }
    return { saved, skipped };
  }

  // ── Shared row builders (used by both per-order upsert and bulk insert) ─────

  /** Maps one Odoo order to the BackupOdooOrder column set (minus id/orderId). */
  private buildOrderColumns(
    order: OdooOrder,
    region?: string | null,
    resolvedBranchCode?: string | null,
  ) {
    const branchName =
      resolveName(order.branch_id) ??
      (typeof order.name === 'string' && order.name.includes('/')
        ? order.name.split('/')[0]
        : null);
    return {
      orderName: order.name ?? null,
      branchId: resolveId(order.branch_id),
      branchName,
      dateOrder: order.date_order ? new Date(order.date_order) : null,
      amountTotal:
        order.amount_total != null ? Number(order.amount_total) : null,
      amountUntaxed:
        order['amount_untaxed'] != null
          ? Number(order['amount_untaxed'])
          : null,
      amountTax: order.amount_tax != null ? Number(order.amount_tax) : null,
      amountDiscount:
        order['amount_discount'] != null
          ? Number(order['amount_discount'])
          : null,
      state: typeof order.state === 'string' ? order.state : null,
      partnerId: resolveId(order.partner_id),
      partnerName: resolveName(order.partner_id),
      warehouseId: resolveId(order['warehouse_id'] as Many2OneField),
      warehouseName: resolveName(order['warehouse_id'] as Many2OneField),
      posConfigId: resolveId(order['pos_config_id'] as Many2OneField),
      posConfigName:
        resolveName(order['pos_config_id'] as Many2OneField) ??
        resolveName(order['session_id'] as Many2OneField),
      customerType:
        typeof order['customer_type'] === 'string'
          ? order['customer_type']
          : null,
      timezone: typeof order.timezone === 'string' ? order.timezone : null,
      region: region ?? null,
      resolvedBranchCode: resolvedBranchCode ?? null,
      rawJson: order as object,
    };
  }

  /** Maps an order's embedded line objects to BackupOdooOrderLine rows. */
  private buildLineRows(
    order: OdooOrder,
    parentId: string,
    region?: string | null,
  ) {
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
    if (lines.length === 0 && rawLineItems.length > 0) {
      this.logger.warn(
        `Odoo order id=${order.id} region=${region ?? 'unknown'}: ` +
          `API returned ${rawLineItems.length} line item IDs but no embedded objects — ` +
          `order lines will not be stored.`,
      );
    }
    return lines.map((line) => {
      const productCode =
        typeof line.product_code === 'string'
          ? line.product_code
          : typeof line['default_code'] === 'string'
            ? line['default_code']
            : typeof line.product_barcode === 'string'
              ? line.product_barcode
              : null;
      return {
        // Bulk insert bypasses @BeforeInsert — assign the key here.
        id: generateId(),
        orderId: order.id,
        lineId: typeof line.id === 'number' ? line.id : null,
        productId: resolveId(line.product_id),
        productName: resolveName(line.product_id),
        productCode,
        lineName: typeof line.name === 'string' ? line.name : null,
        qty: resolveQty(line),
        priceUnit: line.price_unit != null ? Number(line.price_unit) : null,
        priceSubtotal:
          line.price_subtotal != null ? Number(line.price_subtotal) : null,
        priceSubtotalIncl:
          line.price_subtotal_incl != null
            ? Number(line.price_subtotal_incl)
            : null,
        discount: line.discount != null ? Number(line.discount) : null,
        taxName: extractFirstTaxName(line.tax_ids ?? line.tax_id),
        taxIds: extractTaxIdsJson(line.tax_ids ?? line.tax_id),
        baseUomId: resolveId(line.base_uom_id),
        baseUomName: resolveName(line.base_uom_id),
        productUomId: resolveId(line.product_uom_id),
        productUomName: resolveName(line.product_uom_id),
        parentOrderId: parentId,
      };
    });
  }

  /** Maps an order's embedded payment objects to BackupOdooOrderPayment rows. */
  private buildPaymentRows(
    order: OdooOrder,
    parentId: string,
    region?: string | null,
  ) {
    const rawPaymentItems: unknown[] = this.extractPaymentItems(order);
    const rawPayments: OdooOrderPayment[] = rawPaymentItems.filter(
      (p): p is OdooOrderPayment => typeof p === 'object' && p !== null,
    );
    if (rawPayments.length === 0 && rawPaymentItems.length > 0) {
      this.logger.warn(
        `Odoo order id=${order.id} region=${region ?? 'unknown'}: ` +
          `API returned ${rawPaymentItems.length} payment IDs but no embedded objects — ` +
          `payments will not be stored.`,
      );
    }
    return rawPayments.map((pmt) => {
      const currency = Array.isArray(pmt.currency_id)
        ? typeof (pmt.currency_id as [number, unknown])[1] === 'string'
          ? pmt.currency_id[1]
          : null
        : null;
      const paymentDateRaw = pmt.date ?? pmt.payment_date;
      return {
        id: generateId(),
        orderId: order.id,
        paymentId: typeof pmt.id === 'number' ? pmt.id : null,
        paymentName: extractPaymentName(pmt),
        amount: pmt.amount != null ? Number(pmt.amount) : null,
        currency,
        paymentDate:
          typeof paymentDateRaw === 'string' ? new Date(paymentDateRaw) : null,
        parentOrderId: parentId,
      };
    });
  }

  // ── Bulk persistence (executeMany) ──────────────────────────────────────────

  private bulkPool?: oracledb.Pool;

  /**
   * A small dedicated node-oracledb pool for bulk `executeMany` inserts. Kept
   * separate from TypeORM's pool so the raw driver API is available. Thick mode
   * is already initialised by the app's TypeORM data-source at startup.
   */
  private async getBulkPool(): Promise<oracledb.Pool> {
    if (this.bulkPool) return this.bulkPool;
    const host = process.env.APP_DB_HOST ?? 'localhost';
    const port = process.env.APP_DB_PORT ?? '1521';
    const service = process.env.APP_DB_SERVICE ?? 'XEPDB1';
    this.bulkPool = await oracledb.createPool({
      user: process.env.APP_DB_USERNAME,
      password: process.env.APP_DB_PASSWORD,
      connectString: `${host}:${port}/${service}`,
      poolMin: 1,
      poolMax: 4,
      poolIncrement: 1,
    });
    return this.bulkPool;
  }

  /**
   * Persists a batch of orders (+ their lines and payments) with node-oracledb
   * `executeMany` — a few multi-row round-trips instead of ~6 per order. The
   * big win is binding the rawJson CLOB as a STRING (binding it as a LOB is
   * ~200x slower). Existing orders keep their backup-row id (so OrderSyncQueue
   * links survive); new orders get a fresh id. Per-row failures are isolated
   * (batchErrors) and counted as skipped, never aborting the batch.
   */
  private async bulkUpsertOrders(
    orders: OdooOrder[],
    region?: string | null,
  ): Promise<{ saved: number; skipped: number }> {
    const byId = new Map<number, OdooOrder>();
    for (const o of orders) if (typeof o.id === 'number') byId.set(o.id, o);
    const list = [...byId.values()];
    if (list.length === 0) return { saved: 0, skipped: 0 };

    // 1. Which orders already have a backup row (keep their id for FK stability).
    const existing = new Map<number, string>();
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await this.orders.find({
        where: { orderId: In(ids.slice(i, i + 1000)) },
        select: { id: true, orderId: true },
      });
      for (const r of rows) existing.set(r.orderId, r.id);
    }
    const parentIdByOrderId = new Map<number, string>();
    for (const o of list)
      parentIdByOrderId.set(o.id, existing.get(o.id) ?? generateId());

    const now = new Date();
    const STR = (maxSize: number) => ({ type: oracledb.STRING, maxSize });
    const NUM = { type: oracledb.NUMBER };
    const DT = { type: oracledb.DATE };

    // 2. Parent rows split into inserts (new) and updates (existing).
    const insRows: oracledb.BindParameters[] = [];
    const updRows: oracledb.BindParameters[] = [];
    for (const o of list) {
      const c = this.buildOrderColumns(o, region, null);
      const bind = {
        id: parentIdByOrderId.get(o.id),
        orderId: o.id,
        orderName: c.orderName,
        branchId: c.branchId,
        branchName: c.branchName,
        dateOrder: c.dateOrder,
        amountTotal: c.amountTotal,
        amountUntaxed: c.amountUntaxed,
        amountTax: c.amountTax,
        amountDiscount: c.amountDiscount,
        state: c.state,
        partnerId: c.partnerId,
        partnerName: c.partnerName,
        warehouseId: c.warehouseId,
        warehouseName: c.warehouseName,
        posConfigId: c.posConfigId,
        posConfigName: c.posConfigName,
        customerType: c.customerType,
        timezone: c.timezone,
        region: c.region,
        resolvedBranchCode: c.resolvedBranchCode,
        rawJson: JSON.stringify(o),
        updatedAt: now,
      };
      if (existing.has(o.id)) updRows.push(bind);
      else insRows.push({ ...bind, createdAt: now });
    }

    const jsonMax = Math.max(
      1,
      ...list.map((o) => Buffer.byteLength(JSON.stringify(o), 'utf8')),
    );
    const orderCols = {
      orderName: STR(1020),
      branchId: NUM,
      branchName: STR(1020),
      dateOrder: DT,
      amountTotal: NUM,
      amountUntaxed: NUM,
      amountTax: NUM,
      amountDiscount: NUM,
      state: STR(1020),
      partnerId: NUM,
      partnerName: STR(1020),
      warehouseId: NUM,
      warehouseName: STR(1020),
      posConfigId: NUM,
      posConfigName: STR(1020),
      customerType: STR(1020),
      timezone: STR(1020),
      region: STR(1020),
      resolvedBranchCode: STR(1020),
      rawJson: STR(jsonMax),
    };

    const pool = await this.getBulkPool();
    const conn = await pool.getConnection();
    let skipped = 0;
    try {
      if (insRows.length > 0) {
        const r = await conn.executeMany(
          `INSERT INTO "BackupOdooOrder" ("id","orderId","orderName","branchId","branchName","dateOrder","amountTotal","amountUntaxed","amountTax","amountDiscount","state","partnerId","partnerName","warehouseId","warehouseName","posConfigId","posConfigName","customerType","timezone","region","resolvedBranchCode","rawJson","createdAt","updatedAt") ` +
            `VALUES (:id,:orderId,:orderName,:branchId,:branchName,:dateOrder,:amountTotal,:amountUntaxed,:amountTax,:amountDiscount,:state,:partnerId,:partnerName,:warehouseId,:warehouseName,:posConfigId,:posConfigName,:customerType,:timezone,:region,:resolvedBranchCode,:rawJson,:createdAt,:updatedAt)`,
          insRows,
          {
            autoCommit: false,
            batchErrors: true,
            bindDefs: {
              id: STR(64),
              orderId: NUM,
              ...orderCols,
              createdAt: DT,
              updatedAt: DT,
            },
          },
        );
        skipped += r.batchErrors?.length ?? 0;
      }
      if (updRows.length > 0) {
        const r = await conn.executeMany(
          `UPDATE "BackupOdooOrder" SET "orderName"=:orderName,"branchId"=:branchId,"branchName"=:branchName,"dateOrder"=:dateOrder,"amountTotal"=:amountTotal,"amountUntaxed"=:amountUntaxed,"amountTax"=:amountTax,"amountDiscount"=:amountDiscount,"state"=:state,"partnerId"=:partnerId,"partnerName"=:partnerName,"warehouseId"=:warehouseId,"warehouseName"=:warehouseName,"posConfigId"=:posConfigId,"posConfigName"=:posConfigName,"customerType"=:customerType,"timezone"=:timezone,"region"=:region,"resolvedBranchCode"=:resolvedBranchCode,"rawJson"=:rawJson,"updatedAt"=:updatedAt WHERE "orderId"=:orderId`,
          updRows,
          {
            autoCommit: false,
            batchErrors: true,
            bindDefs: { orderId: NUM, ...orderCols, updatedAt: DT },
          },
        );
        skipped += r.batchErrors?.length ?? 0;
      }

      // 3. Children: delete-then-insert for every parent in this batch.
      const allParentIds = [...parentIdByOrderId.values()];
      for (let i = 0; i < allParentIds.length; i += 500) {
        const chunk = allParentIds.slice(i, i + 500);
        const ph = chunk.map((_, k) => `:${k + 1}`).join(',');
        await conn.execute(
          `DELETE FROM "BackupOdooOrderLine" WHERE "parentOrderId" IN (${ph})`,
          chunk,
          { autoCommit: false },
        );
        await conn.execute(
          `DELETE FROM "BackupOdooOrderPayment" WHERE "parentOrderId" IN (${ph})`,
          chunk,
          { autoCommit: false },
        );
      }

      const lineRows: oracledb.BindParameters[] = [];
      const payRows: oracledb.BindParameters[] = [];
      for (const o of list) {
        const pid = parentIdByOrderId.get(o.id) as string;
        for (const l of this.buildLineRows(o, pid, region))
          lineRows.push({ ...l, createdAt: now });
        for (const p of this.buildPaymentRows(o, pid, region))
          payRows.push({ ...p, createdAt: now });
      }

      if (lineRows.length > 0) {
        await conn.executeMany(
          `INSERT INTO "BackupOdooOrderLine" ("id","orderId","lineId","productId","productName","lineName","productCode","qty","priceUnit","priceSubtotal","priceSubtotalIncl","discount","taxName","taxIds","baseUomId","baseUomName","productUomId","productUomName","createdAt","parentOrderId") ` +
            `VALUES (:id,:orderId,:lineId,:productId,:productName,:lineName,:productCode,:qty,:priceUnit,:priceSubtotal,:priceSubtotalIncl,:discount,:taxName,:taxIds,:baseUomId,:baseUomName,:productUomId,:productUomName,:createdAt,:parentOrderId)`,
          lineRows,
          {
            autoCommit: false,
            batchErrors: true,
            bindDefs: {
              id: STR(64),
              orderId: NUM,
              lineId: NUM,
              productId: NUM,
              productName: STR(1020),
              lineName: STR(1020),
              productCode: STR(1020),
              qty: NUM,
              priceUnit: NUM,
              priceSubtotal: NUM,
              priceSubtotalIncl: NUM,
              discount: NUM,
              taxName: STR(1020),
              taxIds: STR(1020),
              baseUomId: NUM,
              baseUomName: STR(1020),
              productUomId: NUM,
              productUomName: STR(1020),
              createdAt: DT,
              parentOrderId: STR(64),
            },
          },
        );
      }

      if (payRows.length > 0) {
        await conn.executeMany(
          `INSERT INTO "BackupOdooOrderPayment" ("id","orderId","paymentId","paymentName","amount","currency","paymentDate","createdAt","parentOrderId") ` +
            `VALUES (:id,:orderId,:paymentId,:paymentName,:amount,:currency,:paymentDate,:createdAt,:parentOrderId)`,
          payRows,
          {
            autoCommit: false,
            batchErrors: true,
            bindDefs: {
              id: STR(64),
              orderId: NUM,
              paymentId: NUM,
              paymentName: STR(1020),
              amount: NUM,
              currency: STR(1020),
              paymentDate: DT,
              createdAt: DT,
              parentOrderId: STR(64),
            },
          },
        );
      }

      await conn.commit();
      return { saved: list.length - skipped, skipped };
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      await conn.close().catch(() => undefined);
    }
  }

  /**
   * Re-ingests orders from the backup tables into the OrderSyncQueue without
   * re-fetching from the Odoo API. Useful for:
   * - Processing orders that were backed up but never ingested
   * - Re-processing orders after fixing branch mappings
   * - Re-processing orders after state mapping changes
   *
   * Supports optional filtering by date range, state, and region.
   *
   * @param params Filter criteria
   * @returns Stats on how many orders were ingested/skipped
   */
  async reingestFromBackup(params: {
    startDate?: string;
    endDate?: string;
    state?: string;
    region?: string;
    limit?: number;
  }): Promise<{ ingested: number; skipped: number; total: number }> {
    const { startDate, endDate, state, region, limit } = params;

    // Build filter criteria using TypeORM operators
    const where: FindOptionsWhere<BackupOdooOrder> = {};
    if (startDate && endDate) {
      where.dateOrder = Between(new Date(startDate), new Date(endDate));
    } else if (startDate) {
      where.dateOrder = MoreThanOrEqual(new Date(startDate));
    } else if (endDate) {
      where.dateOrder = LessThanOrEqual(new Date(endDate));
    }
    if (state) {
      where.state = state;
    }
    if (region) {
      where.region = region;
    }

    // Fetch orders from backup tables
    const backupOrders = await this.orders.find({
      where,
      take: limit ?? 1000, // Default to 1000 to avoid memory issues
      order: { dateOrder: 'ASC' },
      select: {
        id: true,
        orderId: true,
        orderName: true,
        branchId: true,
        branchName: true,
        dateOrder: true,
        amountTotal: true,
        state: true,
        timezone: true,
        region: true,
        resolvedBranchCode: true,
        rawJson: true,
      },
    });

    this.logger.log(
      `Re-ingesting ${backupOrders.length} orders from backup tables` +
        (region ? ` (region=${region})` : '') +
        (state ? ` (state=${state})` : ''),
    );

    // Pre-load StoreConfigurations for branchCode resolution
    const branchIdMap = await this.loadBranchIdMap();

    let ingested = 0;
    let skipped = 0;

    for (const backupOrder of backupOrders) {
      try {
        // Reconstruct the order object from rawJson if available, otherwise use backup fields
        let order: RawOdooOrderFields;

        if (
          backupOrder.rawJson &&
          typeof backupOrder.rawJson === 'object' &&
          !Array.isArray(backupOrder.rawJson)
        ) {
          // Use the full rawJson which should contain payment data
          order = backupOrder.rawJson as unknown as RawOdooOrderFields;
        } else {
          // Fallback: construct from backup fields and fetch payment data from database
          const payments = await this.orderPayments.find({
            where: { parentOrderId: backupOrder.id },
            select: {
              paymentId: true,
              paymentName: true,
              amount: true,
              currency: true,
              paymentDate: true,
            },
          });

          order = {
            id: backupOrder.orderId,
            name: backupOrder.orderName,
            branch_id: backupOrder.branchId,
            date_order: backupOrder.dateOrder?.toISOString(),
            amount_total: backupOrder.amountTotal,
            state: backupOrder.state,
            timezone: backupOrder.timezone,
            // Include payment data if available
            statement_ids: payments.length > 0 ? payments : undefined,
          };
        }

        const payload = normalizeOrderForIngestion(
          order,
          backupOrder.timezone ?? undefined,
        );
        if (!payload) {
          this.logger.debug(
            `Skipping backup order id=${backupOrder.orderId}: no valid branch code`,
          );
          skipped++;
          continue;
        }

        // Resolve canonical branchCode from StoreConfiguration.odooBranchId
        const odooBranchId = backupOrder.branchId ?? null;
        const storeEntry =
          odooBranchId != null ? branchIdMap.get(BigInt(odooBranchId)) : null;
        const resolvedBranchCode =
          backupOrder.resolvedBranchCode ??
          storeEntry?.branchCode ??
          payload.branchCode;
        const resolvedRegion = backupOrder.region ?? storeEntry?.region ?? null;

        await this.orderSyncService.ingestOrder({
          ...payload,
          branchCode: resolvedBranchCode,
          region: resolvedRegion ?? undefined,
          odooBackupOrderId: backupOrder.id,
        });
        ingested++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to ingest backup order id=${backupOrder.orderId}: ${msg}`,
        );
        skipped++;
      }
    }

    this.logger.log(
      `Re-ingestion complete: ingested=${ingested} skipped=${skipped} total=${backupOrders.length}`,
    );

    return { ingested, skipped, total: backupOrders.length };
  }
}
