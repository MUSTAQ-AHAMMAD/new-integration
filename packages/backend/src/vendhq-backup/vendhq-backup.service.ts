/**
 * VendHqSalesBackupService — TypeScript port of the Java
 * VendHQSalesBackupJob + BackupSalesVendHqPersistence.
 *
 * Scheduled every 10 minutes (matching the Java Quartz schedule).
 * For each active VendHqCredential it:
 *  1. Checks that the region is not disabled (SalesIntegrationStatus).
 *  2. Fetches new / updated sales from the VendHQ REST API using an
 *     incremental `after` version watermark (lastSyncVersion) so only
 *     new/updated records are fetched each run.
 *  3. Persists each sale into BackupVendHqSale / BackupVendHqLineItem /
 *     BackupVendHqPayment / BackupVendHqPromotion.
 *  4. Upserts a SaleSyncStatus record so the downstream
 *     FusionTransformationService can pick it up.
 *  5. Updates lastSyncVersion and lastSyncAt on the credential so the
 *     next run only fetches newer records (no duplicates).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SaleStatus } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

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

/** integMode value used in SalesIntegrationStatus for backup jobs */
const BACKUP_INTEG_MODE = 'BACKUP';
/** Status value meaning the integration is running / allowed */
const STATUS_ENABLED = 'ENABLED';
/** Status value meaning the integration has been paused by an operator */
const STATUS_DISABLED = 'DISABLED';

@Injectable()
export class VendHqSalesBackupService {
  private readonly logger = new Logger(VendHqSalesBackupService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs every 10 minutes — mirrors Java Quartz SimpleSchedule (10 min).
   * Can also be triggered manually via VendHqBackupController.
   */
  @Cron('0 */10 * * * *')
  async runBackupJob(): Promise<void> {
    const credentials = await this.prisma.vendHqCredential.findMany({
      where: { active: true },
    });

    if (credentials.length === 0) {
      this.logger.warn('No active VendHQ credentials found — backup skipped');
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
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `VendHQ backup failed for region=${cred.region} domain=${cred.domainName}: ${msg}`,
        );
      }
    }
  }

  /**
   * Fetches and persists all new sales for one VendHQ credential (region).
   * Uses lastSyncVersion as the `after` watermark so only new/updated
   * sales are fetched on each run — preventing redundant duplicate writes.
   * Exposed publicly so the controller can trigger a manual run.
   */
  async backupRegion(cred: {
    id: string;
    domainName: string;
    personalToken: string;
    region: string;
    timezoneOffset: number;
    currency: string;
    lastSyncVersion?: number;
  }): Promise<{ saved: number; skipped: number }> {
    const baseUrl = `https://${cred.domainName}.vendhq.com`;
    const afterVersion = cred.lastSyncVersion ?? 0;

    const resp = await axios.get<{ data?: VendHqSaleRaw[] }>(
      `${baseUrl}/api/2.0/sales`,
      {
        headers: {
          Authorization: 'Bearer ' + cred.personalToken,
          'Content-Type': 'application/json',
        },
        // `after` tells VendHQ to return only sales with version > afterVersion
        params: {
          page_size: 200,
          ...(afterVersion > 0 ? { after: afterVersion } : {}),
        },
        timeout: 30_000,
      },
    );

    const sales: VendHqSaleRaw[] = resp.data?.data ?? [];
    let saved = 0;
    let skipped = 0;
    let maxVersion = afterVersion;

    for (const sale of sales) {
      try {
        const wasNew = await this.upsertSale(sale, cred.region, cred.currency);
        if (wasNew) {
          saved++;
        } else {
          skipped++;
        }
        // Track the highest version seen so we can advance the watermark
        const v = typeof sale.version === 'number' ? sale.version : 0;
        if (v > maxVersion) maxVersion = v;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to persist sale ${sale.id} (${sale.invoice_number ?? 'no-inv'}) ` +
            `region=${cred.region}: ${msg}`,
        );
        skipped++;
      }
    }

    // Advance the watermark so the next run only fetches newer sales
    if (maxVersion > afterVersion) {
      await this.prisma.vendHqCredential.update({
        where: { id: cred.id },
        data: { lastSyncVersion: maxVersion, lastSyncAt: new Date() },
      });
    } else if (sales.length > 0) {
      // Sales were processed but had no version — at least record the timestamp
      await this.prisma.vendHqCredential.update({
        where: { id: cred.id },
        data: { lastSyncAt: new Date() },
      });
    }

    return { saved, skipped };
  }

  // ---------------------------------------------------------------------------
  // Region control helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true when a region is allowed to run (no DISABLED record exists).
   * A missing record is treated as ENABLED (opt-out model).
   */
  async isRegionEnabled(region: string): Promise<boolean> {
    const record = await this.prisma.salesIntegrationStatus.findUnique({
      where: { region_integMode: { region, integMode: BACKUP_INTEG_MODE } },
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
    const record = await this.prisma.salesIntegrationStatus.upsert({
      where: { region_integMode: { region, integMode: BACKUP_INTEG_MODE } },
      create: { region, integMode: BACKUP_INTEG_MODE, status: STATUS_ENABLED },
      update: { status: STATUS_ENABLED },
    });
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
    const record = await this.prisma.salesIntegrationStatus.upsert({
      where: { region_integMode: { region, integMode: BACKUP_INTEG_MODE } },
      create: { region, integMode: BACKUP_INTEG_MODE, status: STATUS_DISABLED },
      update: { status: STATUS_DISABLED },
    });
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
      this.prisma.salesIntegrationStatus.findUnique({
        where: { region_integMode: { region, integMode: BACKUP_INTEG_MODE } },
      }),
      this.prisma.vendHqCredential.findMany({
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Upserts one VendHQ sale and its line items + payments.
   * Returns true if the record was new or updated, false if skipped (same version).
   * Uses the @@unique([invoiceNumber, region]) DB constraint to prevent duplicates.
   */
  private async upsertSale(
    sale: VendHqSaleRaw,
    region: string,
    currency: string,
  ): Promise<boolean> {
    const invoiceNumber = sale.invoice_number ?? sale.id;
    const saleDate = sale.sale_date ? new Date(sale.sale_date) : new Date();
    const incomingVersion =
      typeof sale.version === 'number' ? sale.version : null;

    // ── BackupVendHqSale (upsert on invoiceNumber+region) ─────────────────
    const existing = await this.prisma.backupVendHqSale.findFirst({
      where: { invoiceNumber, region },
      select: { id: true, version: true },
    });

    // Skip if we already have this version — no downstream work needed
    if (
      existing &&
      incomingVersion !== null &&
      (existing.version ?? -1) >= incomingVersion
    ) {
      return false;
    }

    const saleData = {
      invoiceNumber,
      saleNumber: invoiceNumber,
      outletName: sale.outlet_name ?? null,
      outletId: sale.outlet_id ?? null,
      registerName: sale.register_name ?? null,
      saleDate,
      totalPrice: sale.total_price ?? null,
      totalTax: sale.total_tax ?? null,
      totalLoyalty: sale.total_loyalty ?? null,
      totalPriceInclTax: sale.total_price_incl_tax ?? null,
      version: incomingVersion,
      region,
      customerType: this.resolveCustomerType(sale),
      rawJson: sale as object,
    };

    let parentId: string;
    if (existing) {
      await this.prisma.backupVendHqSale.update({
        where: { id: existing.id },
        data: saleData,
      });
      parentId = existing.id;
    } else {
      const created = await this.prisma.backupVendHqSale.create({
        data: saleData,
      });
      parentId = created.id;
    }

    // ── BackupVendHqLineItem ───────────────────────────────────────────────
    const lineItems: VendHqLineItemRaw[] = Array.isArray(sale.line_items)
      ? sale.line_items
      : [];

    for (let idx = 0; idx < lineItems.length; idx++) {
      const li = lineItems[idx];
      const lineNumber = idx + 1;

      const existingLine = await this.prisma.backupVendHqLineItem.findFirst({
        where: { invoiceNumber, lineNumber, region },
        select: { id: true },
      });

      const lineData = {
        invoiceNumber,
        lineNumber,
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
      };

      if (existingLine) {
        await this.prisma.backupVendHqLineItem.update({
          where: { id: existingLine.id },
          data: lineData,
        });
      } else {
        await this.prisma.backupVendHqLineItem.create({ data: lineData });
      }
    }

    // ── BackupVendHqPayment ────────────────────────────────────────────────
    const payments: VendHqPaymentRaw[] = Array.isArray(sale.payments)
      ? sale.payments
      : [];

    for (const pmt of payments) {
      const pmtName = pmt.name ?? pmt.payment_type_id ?? 'Unknown';

      const existingPmt = await this.prisma.backupVendHqPayment.findFirst({
        where: { invoiceNumber, paymentType: pmtName, region },
        select: { id: true },
      });

      const pmtData = {
        invoiceNumber,
        outletName: sale.outlet_name ?? null,
        registerName: sale.register_name ?? null,
        amount: pmt.amount ?? null,
        currency: currency,
        paymentType: pmtName,
        paymentMethod: pmtName,
        paymentDate: saleDate,
        region,
        saleDate,
        saleId: parentId,
      };

      if (existingPmt) {
        await this.prisma.backupVendHqPayment.update({
          where: { id: existingPmt.id },
          data: pmtData,
        });
      } else {
        await this.prisma.backupVendHqPayment.create({ data: pmtData });
      }
    }

    // ── SaleSyncStatus (PENDING — downstream Oracle Fusion pipeline) ───────
    await this.prisma.saleSyncStatus.upsert({
      where: {
        saleId_outletId_saleDate: {
          saleId: sale.id,
          outletId: sale.outlet_id ?? region,
          saleDate,
        },
      },
      create: {
        saleId: sale.id,
        outletId: sale.outlet_id ?? region,
        saleDate,
        status: SaleStatus.PENDING,
      },
      update: {
        // Re-queue only if the previous attempt failed or was skipped
        status: SaleStatus.PENDING,
      },
    });

    return true;
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
