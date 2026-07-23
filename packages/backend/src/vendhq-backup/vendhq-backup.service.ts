/**
 * VendHqSalesBackupService — TypeScript port of the Java
 * VendHQSalesBackupJob + BackupSalesVendHqPersistence.
 *
 * Scheduled every 10 minutes (matching the Java Quartz schedule).
 * For each active VendHqCredential it:
 *  1. Checks that the region is not disabled (SalesIntegrationStatus).
 *  2. Fetches new / updated sales from the VendHQ REST API using an
 *     incremental `after` version watermark (lastSyncVersion) so only
 *     new/updated records are fetched each run.  Paginates until the
 *     API returns fewer than VENDHQ_PAGE_SIZE records.
 *  3. Persists each page in bulk: upserts parent BackupVendHqSale rows
 *     concurrently, then replaces all child BackupVendHqLineItem /
 *     BackupVendHqPayment rows with a single delete + insert pair
 *     (eliminating N+1 queries).
 *  4. Upserts a SaleSyncStatus record so the downstream
 *     FusionTransformationService can pick it up.
 *  5. Updates lastSyncVersion and lastSyncAt on the credential so the
 *     next run only fetches newer records (no duplicates).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import axios from 'axios';
import { BackupVendHqSale } from '../database/entities/backup-vend-hq-sale.entity';
import { BackupVendHqLineItem } from '../database/entities/backup-vend-hq-line-item.entity';
import { BackupVendHqPayment } from '../database/entities/backup-vend-hq-payment.entity';
import { SaleSyncStatus } from '../database/entities/sale-sync-status.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { generateId } from '../database/id.util';
import { SalesIntegrationStatus } from '../database/entities/sales-integration-status.entity';
import { SaleStatus } from '../database/enums';
import { SyncControlService } from '../sync/sync-control.service';

// ---------------------------------------------------------------------------
// Raw VendHQ API shapes
// ---------------------------------------------------------------------------
interface VendHqLineItemRaw {
  id?: string;
  product_id?: string;
  sku?: string;
  name?: string;
  quantity?: number;
  tax?: number;
  total_price?: number;
  tax_name?: string;
  [key: string]: unknown;
}

interface VendHqPaymentRaw {
  id?: string;
  payment_type_id?: string;
  name?: string;
  amount?: number;
  [key: string]: unknown;
}

interface VendHqSaleRaw {
  id: string;
  invoice_number?: string;
  sale_date?: string;
  register_id?: string;
  register_name?: string;
  outlet_id?: string;
  outlet_name?: string;
  customer_code?: string;
  note?: string;
  status?: string;
  total_price?: number;
  total_tax?: number;
  total_loyalty?: number;
  total_price_incl_tax?: number;
  version?: number;
  line_items?: VendHqLineItemRaw[];
  payments?: VendHqPaymentRaw[];
  [key: string]: unknown;
}

/** VendHQ v2 API response envelope for /api/2.0/sales */
interface VendHqApiResponse {
  data?: VendHqSaleRaw[];
  /** Version cursor used for pagination — max version in the current page */
  version?: { max?: number };
}

/** integMode value used in SalesIntegrationStatus for backup jobs */
const BACKUP_INTEG_MODE = 'BACKUP';
/** Status value meaning the integration is running / allowed */
const STATUS_ENABLED = 'ENABLED';
/** Status value meaning the integration has been paused by an operator */
const STATUS_DISABLED = 'DISABLED';
/** Maximum records per VendHQ API page (API cap is 200) */
const VENDHQ_PAGE_SIZE = 200;
/** Concurrency limit for parallel parent-sale upserts within one page. */
const UPSERT_CONCURRENCY = 10;
/** Concurrency limit for parallel SaleSyncStatus upserts within one page. */
const SYNC_CONCURRENCY = 10;

@Injectable()
export class VendHqSalesBackupService {
  private readonly logger = new Logger(VendHqSalesBackupService.name);

  constructor(
    @InjectRepository(VendHqCredential)
    private readonly credentials: Repository<VendHqCredential>,
    @InjectRepository(SalesIntegrationStatus)
    private readonly integrationStatus: Repository<SalesIntegrationStatus>,
    @InjectRepository(BackupVendHqSale)
    private readonly sales: Repository<BackupVendHqSale>,
    @InjectRepository(BackupVendHqLineItem)
    private readonly lineItems: Repository<BackupVendHqLineItem>,
    @InjectRepository(BackupVendHqPayment)
    private readonly payments: Repository<BackupVendHqPayment>,
    @InjectRepository(SaleSyncStatus)
    private readonly saleSyncStatus: Repository<SaleSyncStatus>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly syncControl: SyncControlService,
  ) {}

  /**
   * Runs every 10 minutes — mirrors Java Quartz SimpleSchedule (10 min).
   * Can also be triggered manually via VendHqBackupController.
   */
  @Cron('0 */10 * * * *')
  async runBackupJob(): Promise<void> {
    // Check if sync control allows this service to run
    const enabled = await this.syncControl.isEnabled('vendhq-backup');
    if (!enabled) {
      this.logger.debug('VendHQ backup service is disabled, skipping cron run');
      return;
    }

    await this.syncControl.markRunning('vendhq-backup');
    let hasError = false;

    try {
      const credentials = await this.credentials.find({
        where: { active: true },
      });

      if (credentials.length === 0) {
        this.logger.warn('No active VendHQ credentials found — backup skipped');
        await this.syncControl.markStopped('vendhq-backup', 'success');
        return;
      }

      for (const cred of credentials) {
        try {
          // --- Region-level on/off check ---
          const regionEnabled = await this.isRegionEnabled(cred.region);
          if (!regionEnabled) {
            this.logger.log(
              `Backup skipped for region=${cred.region} — integration is DISABLED`,
            );
            continue;
          }

          const result = await this.backupRegion(cred);
          this.logger.log(
            `Backup done for region=${cred.region}: saved=${result.saved} skipped=${result.skipped}`,
          );
        } catch (err) {
          hasError = true;
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `VendHQ backup failed for region=${cred.region} domain=${cred.domainName}: ${msg}`,
          );
        }
      }

      await this.syncControl.markStopped(
        'vendhq-backup',
        hasError ? 'error' : 'success',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`VendHQ backup cron failed: ${msg}`);
      await this.syncControl.markStopped('vendhq-backup', 'error');
    }
  }

  /**
   * Resolves a credential's `domainName` to a VendHQ/Lightspeed base URL.
   *
   * Historically `domainName` was a bare store prefix ("mystore" →
   * https://mystore.vendhq.com). Records imported from Oracle, however, may
   * carry a full hostname ("www.ibqpos.com") or an explicit scheme. Appending
   * ".vendhq.com" to a full hostname yields an unresolvable host whose TLS cert
   * never matches ("www.ibqpos.com.vendhq.com"). Only append the suffix for bare
   * prefixes; use anything already containing a dot (or scheme) verbatim.
   */
  resolveVendHqBaseUrl(domainName: string): string {
    const raw = (domainName ?? '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(raw)) return raw;
    const host = raw.includes('.') ? raw : `${raw}.vendhq.com`;
    return `https://${host}`;
  }

  async backupRegion(cred: {
    id: string;
    domainName: string;
    personalToken: string;
    region: string;
    timezoneOffset: number;
    currency: string;
    lastSyncVersion?: number;
  }): Promise<{ saved: number; skipped: number }> {
    const baseUrl = this.resolveVendHqBaseUrl(cred.domainName);
    let afterVersion = cred.lastSyncVersion ?? 0;
    let maxVersionSeen = afterVersion;
    let totalSaved = 0;
    let totalSkipped = 0;

    while (true) {
      const resp = await axios.get<VendHqApiResponse>(
        `${baseUrl}/api/2.0/sales`,
        {
          headers: {
            Authorization: 'Bearer ' + cred.personalToken,
            'Content-Type': 'application/json',
          },
          // `after` tells VendHQ to return only sales with version > afterVersion
          params: {
            page_size: VENDHQ_PAGE_SIZE,
            ...(afterVersion > 0 ? { after: afterVersion } : {}),
          },
          timeout: 30_000,
        },
      );

      const sales: VendHqSaleRaw[] = resp.data?.data ?? [];
      if (sales.length === 0) break;

      const { saved, skipped } = await this.upsertSalesPage(
        sales,
        cred.region,
        cred.currency,
      );
      totalSaved += saved;
      totalSkipped += skipped;

      // Track max version for watermark advancement
      for (const sale of sales) {
        const v = typeof sale.version === 'number' ? sale.version : 0;
        if (v > maxVersionSeen) maxVersionSeen = v;
      }
      // Use version.max from VendHQ response cursor when available
      const apiVersionMax = resp.data?.version?.max;
      if (typeof apiVersionMax === 'number' && apiVersionMax > maxVersionSeen) {
        maxVersionSeen = apiVersionMax;
      }

      // Stop when the page is smaller than requested — no more records
      if (sales.length < VENDHQ_PAGE_SIZE) break;

      // Advance the version cursor for the next page
      afterVersion = maxVersionSeen;
    }

    // Advance the watermark so the next run only fetches newer sales
    if (maxVersionSeen > (cred.lastSyncVersion ?? 0)) {
      await this.credentials.update(
        { id: cred.id },
        { lastSyncVersion: maxVersionSeen, lastSyncAt: new Date() },
      );
    } else if (totalSaved + totalSkipped > 0) {
      // Sales were processed but had no version — at least record the timestamp
      await this.credentials.update({ id: cred.id }, { lastSyncAt: new Date() });
    }

    return { saved: totalSaved, skipped: totalSkipped };
  }

  // ---------------------------------------------------------------------------
  // Region control helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true when a region is allowed to run (no DISABLED record exists).
   * A missing record is treated as ENABLED (opt-out model).
   */
  async isRegionEnabled(region: string): Promise<boolean> {
    const record = await this.integrationStatus.findOne({
      where: { region, integMode: BACKUP_INTEG_MODE },
    });
    return !record || record.status !== STATUS_DISABLED;
  }

  /**
   * Enable the backup integration for a region.
   * Creates or updates the SalesIntegrationStatus record to ENABLED.
   */
  async enableRegion(
    region: string,
  ): Promise<{ region: string; status: string }> {
    const record = await this.upsertIntegrationStatus(region, STATUS_ENABLED);
    this.logger.log(`Integration ENABLED for region=${region}`);
    return { region: record.region, status: record.status };
  }

  /**
   * Disable the backup integration for a region.
   * Creates or updates the SalesIntegrationStatus record to DISABLED.
   * Running backup jobs will skip this region on the next scheduled tick.
   */
  async disableRegion(
    region: string,
  ): Promise<{ region: string; status: string }> {
    const record = await this.upsertIntegrationStatus(region, STATUS_DISABLED);
    this.logger.log(`Integration DISABLED for region=${region}`);
    return { region: record.region, status: record.status };
  }

  /**
   * Returns the current status and last-sync metadata for a region.
   */
  async getRegionStatus(region: string): Promise<{
    region: string;
    integrationStatus: string;
    credentials: Array<{
      id: string;
      domainName: string;
      active: boolean;
      lastSyncVersion: number;
      lastSyncAt: Date | null;
    }>;
  }> {
    const [statusRecord, credentials] = await Promise.all([
      this.integrationStatus.findOne({
        where: { region, integMode: BACKUP_INTEG_MODE },
      }),
      this.credentials.find({
        where: { region },
        select: {
          id: true,
          domainName: true,
          active: true,
          lastSyncVersion: true,
          lastSyncAt: true,
        },
      }),
    ]);

    return {
      region,
      integrationStatus: statusRecord?.status ?? STATUS_ENABLED,
      credentials,
    };
  }

  /**
   * Upserts a SalesIntegrationStatus row for (region, BACKUP) to the given
   * status. Emulates Prisma's composite-key upsert with find-then-save so it
   * works on Oracle without relying on ON CONFLICT semantics.
   */
  private async upsertIntegrationStatus(
    region: string,
    status: string,
  ): Promise<SalesIntegrationStatus> {
    const existing = await this.integrationStatus.findOne({
      where: { region, integMode: BACKUP_INTEG_MODE },
    });
    if (existing) {
      existing.status = status;
      return this.integrationStatus.save(existing);
    }
    return this.integrationStatus.save(
      this.integrationStatus.create({
        region,
        integMode: BACKUP_INTEG_MODE,
        status,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Batch-upserts one page of VendHQ sales and their child records.
   *
   * Performance strategy:
   *  1. One find to check existing versions → skip unchanged records.
   *  2. Concurrent upsert for all parent BackupVendHqSale rows (chunked).
   *  3. delete + insert for BackupVendHqLineItem (2 round-trips for
   *     the whole page, regardless of how many line items exist).
   *  4. delete + insert for BackupVendHqPayment (same).
   *  5. Concurrent upsert for SaleSyncStatus rows (chunked).
   */
  private async upsertSalesPage(
    sales: VendHqSaleRaw[],
    region: string,
    currency: string,
  ): Promise<{ saved: number; skipped: number }> {
    if (sales.length === 0) return { saved: 0, skipped: 0 };

    const invoiceNumbers = sales.map((s) => s.invoice_number ?? s.id);

    // 1. Batch-fetch existing versions (one query for the whole page)
    const existingSales = await this.sales.find({
      where: { invoiceNumber: In(invoiceNumbers), region },
      select: { invoiceNumber: true, version: true },
    });
    const existingVersionMap = new Map(
      existingSales.map((s) => [s.invoiceNumber, s.version ?? -1]),
    );

    // 2. Filter out records whose stored version is already current
    const salesToProcess = sales.filter((sale) => {
      const inv = sale.invoice_number ?? sale.id;
      const incomingVersion =
        typeof sale.version === 'number' ? sale.version : null;
      const storedVersion = existingVersionMap.get(inv);
      return (
        storedVersion === undefined ||
        incomingVersion === null ||
        storedVersion < incomingVersion
      );
    });

    if (salesToProcess.length === 0) {
      return { saved: 0, skipped: sales.length };
    }

    // 3. Upsert all parent rows concurrently (in chunks to respect pool limits)
    const upsertedSales: Array<{ id: string; invoiceNumber: string }> = [];

    for (let i = 0; i < salesToProcess.length; i += UPSERT_CONCURRENCY) {
      const chunk = salesToProcess.slice(i, i + UPSERT_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((sale) => this.upsertSale(sale, region, currency)),
      );
      upsertedSales.push(...results);
    }

    const parentIdMap = new Map(
      upsertedSales.map((s) => [s.invoiceNumber, s.id]),
    );

    // 4. Collect all child records for the processed sales
    const allLineItems: Array<{
      id: string;
      invoiceNumber: string;
      lineNumber: number;
      itemNumber: string | null;
      itemName: string | null;
      productId: string | null;
      productName: string | null;
      quantity: number | null;
      totalPrice: number | null;
      totalTax: number | null;
      taxName: string | null;
      region: string;
      saleDate: Date;
      saleId: string;
    }> = [];
    const allPayments: Array<{
      id: string;
      invoiceNumber: string;
      outletName: string | null;
      registerName: string | null;
      amount: number | null;
      currency: string;
      paymentType: string;
      paymentMethod: string;
      paymentDate: Date;
      region: string;
      saleDate: Date;
      saleId: string;
    }> = [];

    const processedInvoiceNumbers: string[] = [];

    for (const sale of salesToProcess) {
      const inv = sale.invoice_number ?? sale.id;
      const parentId = parentIdMap.get(inv);
      if (!parentId) {
        this.logger.warn(
          `VendHQ sale inv=${inv} region=${region}: parent upsert result not found — child rows skipped`,
        );
        continue;
      }
      processedInvoiceNumbers.push(inv);

      const saleDate = sale.sale_date ? new Date(sale.sale_date) : new Date();

      const lineItems: VendHqLineItemRaw[] = Array.isArray(sale.line_items)
        ? sale.line_items
        : [];
      for (let idx = 0; idx < lineItems.length; idx++) {
        const li = lineItems[idx];
        allLineItems.push({
          // Bulk insert bypasses @BeforeInsert — assign the PK or every row
          // fails ORA-01400 on the NOT NULL id (same fix as the Odoo backup).
          id: generateId(),
          invoiceNumber: inv,
          lineNumber: idx + 1,
          itemNumber: li.sku ?? null,
          itemName: li.name ?? null,
          productId: li.product_id ?? null,
          productName: li.name ?? null,
          quantity: li.quantity ?? null,
          totalPrice: li.total_price ?? null,
          totalTax: li.tax ?? null,
          taxName: li.tax_name ?? null,
          region,
          saleDate,
          saleId: parentId,
        });
      }

      const payments: VendHqPaymentRaw[] = Array.isArray(sale.payments)
        ? sale.payments
        : [];
      for (const pmt of payments) {
        const pmtName = pmt.name ?? pmt.payment_type_id ?? 'Unknown';
        allPayments.push({
          id: generateId(),
          invoiceNumber: inv,
          outletName: sale.outlet_name ?? null,
          registerName: sale.register_name ?? null,
          amount: pmt.amount ?? null,
          currency,
          paymentType: pmtName,
          paymentMethod: pmtName,
          paymentDate: saleDate,
          region,
          saleDate,
          saleId: parentId,
        });
      }
    }

    // 5. Batch-replace child tables inside a transaction so that a failed
    //    insert never leaves orphaned rows (atomicity guarantee).
    //    Two round-trips for the whole page replaces the old N+1 per-record pattern.
    await this.dataSource.transaction(async (mgr) => {
      await mgr.delete(BackupVendHqLineItem, {
        invoiceNumber: In(processedInvoiceNumbers),
        region,
      });
      if (allLineItems.length > 0) {
        await mgr.insert(BackupVendHqLineItem, allLineItems);
      }
      await mgr.delete(BackupVendHqPayment, {
        invoiceNumber: In(processedInvoiceNumbers),
        region,
      });
      if (allPayments.length > 0) {
        await mgr.insert(BackupVendHqPayment, allPayments);
      }
    });

    // 6. Upsert SaleSyncStatus rows concurrently (chunked)
    for (let i = 0; i < salesToProcess.length; i += SYNC_CONCURRENCY) {
      const chunk = salesToProcess.slice(i, i + SYNC_CONCURRENCY);
      await Promise.all(chunk.map((sale) => this.upsertSaleSyncStatus(sale, region)));
    }

    return {
      saved: salesToProcess.length,
      skipped: sales.length - salesToProcess.length,
    };
  }

  /**
   * Upserts one parent BackupVendHqSale row keyed on (invoiceNumber, region).
   * find-then-save preserves the generated id for existing rows and returns
   * the id + invoiceNumber needed to link child rows.
   */
  private async upsertSale(
    sale: VendHqSaleRaw,
    region: string,
    currency: string,
  ): Promise<{ id: string; invoiceNumber: string }> {
    const inv = sale.invoice_number ?? sale.id;
    const saleDate = sale.sale_date ? new Date(sale.sale_date) : new Date();
    const saleData: Partial<BackupVendHqSale> = {
      invoiceNumber: inv,
      saleNumber: inv,
      outletName: sale.outlet_name ?? null,
      outletId: sale.outlet_id ?? null,
      registerName: sale.register_name ?? null,
      saleDate,
      totalPrice: sale.total_price ?? null,
      totalTax: sale.total_tax ?? null,
      totalLoyalty: sale.total_loyalty ?? null,
      totalPriceInclTax: sale.total_price_incl_tax ?? null,
      version: typeof sale.version === 'number' ? sale.version : null,
      region,
      customerType: this.resolveCustomerType(sale),
      rawJson: sale as object,
    };

    // currency is not persisted on the sale header (it lives on payments);
    // the parameter is kept for signature parity with the page collector.
    void currency;

    const existing = await this.sales.findOne({
      where: { invoiceNumber: inv, region },
    });
    const entity = existing
      ? this.sales.merge(existing, saleData)
      : this.sales.create(saleData);
    const saved = await this.sales.save(entity);
    return { id: saved.id, invoiceNumber: saved.invoiceNumber };
  }

  /**
   * Upserts the SaleSyncStatus row (composite PK: saleId, outletId, saleDate)
   * that the downstream Fusion pipeline consumes. Re-queues to PENDING.
   */
  private async upsertSaleSyncStatus(
    sale: VendHqSaleRaw,
    region: string,
  ): Promise<void> {
    const saleDate = sale.sale_date ? new Date(sale.sale_date) : new Date();
    const saleId = sale.id;
    const outletId = sale.outlet_id ?? region;

    const existing = await this.saleSyncStatus.findOne({
      where: { saleId, outletId, saleDate },
    });
    if (existing) {
      // Re-queue only if the previous attempt failed or was skipped
      existing.status = SaleStatus.PENDING;
      await this.saleSyncStatus.save(existing);
      return;
    }
    await this.saleSyncStatus.save(
      this.saleSyncStatus.create({
        saleId,
        outletId,
        saleDate,
        status: SaleStatus.PENDING,
      }),
    );
  }

  /**
   * Derive customer type from VendHQ sale.
   * Mirrors Java logic: uses customer_code, falls back to "NORMAL".
   * Service providers (3PL delivery) carry specific customer codes.
   */
  private resolveCustomerType(sale: VendHqSaleRaw): string {
    const code = sale.customer_code ?? '';
    const upper = code.trim().toUpperCase();
    if (!upper || upper === 'NORMAL') return 'NORMAL';
    return upper;
  }
}
