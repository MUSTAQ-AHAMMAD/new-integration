/**
 * ItemSyncService — TypeScript port of the Java
 * FusionItemsToVendHQItemsIntegration processor.
 *
 * Scheduled every hour (matching the Java Quartz interval for item sync).
 * For each active VendHqCredential / Oracle region it:
 *  1. Fetches inventory items from Oracle Fusion REST API.
 *  2. Upserts each item into VendHQ via PUT /api/2.0/products.
 *  3. Tracks results in VendHqItemMeta so the dashboard can show sync state.
 *  4. Fires an alert on partial failures without blocking other items.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { OracleInventoryItem } from '../clients/oracle/oracle.client';
import { OracleClient } from '../clients/oracle/oracle.client';
import { VendHqClient } from '../clients/vendhq/vendhq.client';
import { PrismaService } from '../prisma/prisma.service';
import { SyncControlService } from '../sync/sync-control.service';

export interface ItemSyncResult {
  region: string;
  synced: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/** Fallback watermark when no item meta exists: mirrors Java `calendar.add(Calendar.YEAR, -10)`. */
const WATERMARK_FALLBACK_MS = 10 * 365 * 24 * 60 * 60 * 1000;

@Injectable()
export class ItemSyncService {
  private readonly logger = new Logger(ItemSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oracleClient: OracleClient,
    private readonly vendHqClient: VendHqClient,
    private readonly syncControl: SyncControlService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether a VendHQ push target is configured. When it is not (e.g. an
   * Odoo→Oracle deployment that never syncs to VendHQ), item-sync stores the
   * fetched Oracle item master locally instead of failing on every push.
   */
  private get vendHqConfigured(): boolean {
    return !!this.config.get<string>('VENDHQ_BASE_URL');
  }

  /**
   * Runs every hour — mirrors Java Quartz schedule for item master sync.
   * Can also be triggered manually via ItemSyncController.
   */
  @Cron('0 0 * * * *')
  async runItemSync(): Promise<void> {
    // Check if sync control allows this service to run
    const enabled = await this.syncControl.isEnabled('item-sync');
    if (!enabled) {
      this.logger.debug('Item sync service is disabled, skipping cron run');
      return;
    }

    await this.syncControl.markRunning('item-sync');
    let hasError = false;

    try {
      const credentials = await this.prisma.vendHqCredential.findMany({
        where: { active: true },
      });

      if (credentials.length === 0) {
        this.logger.warn('No active VendHQ credentials — item sync skipped');
        await this.syncControl.markStopped('item-sync', 'success');
        return;
      }

      for (const cred of credentials) {
        try {
          const result = await this.syncItemsForRegion(cred.region);
          this.logger.log(
            `Item sync done for region=${result.region}: ` +
              `synced=${result.synced} skipped=${result.skipped} failed=${result.failed}`,
          );
          if (result.failed > 0) {
            hasError = true;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Item sync failed for region=${cred.region}: ${msg}`,
          );
          hasError = true;
        }
      }

      await this.syncControl.markStopped(
        'item-sync',
        hasError ? 'error' : 'success',
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Item sync job failed: ${msg}`);
      await this.syncControl.markStopped('item-sync', 'error');
    }
  }

  /**
   * Sync Oracle Fusion items → VendHQ for one region.
   * Exposed so the controller can trigger a manual run.
   */
  async syncItemsForRegion(region: string): Promise<ItemSyncResult> {
    const result: ItemSyncResult = {
      region,
      synced: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    // ── 1. Resolve the Oracle org code from VendHqCredential.fusionOrgCode ───
    //       This mirrors the Java doIntegration(region, fusionOrgCode, ...) param.
    const credential = await this.prisma.vendHqCredential.findFirst({
      where: { region, active: true },
    });
    const organizationCode = credential?.fusionOrgCode ?? region;

    // ── 2. Determine watermark — mirrors Java session.getGetVenHqItemsLastUpdatedDate ──
    const latestMeta = await this.prisma.vendHqItemMeta.findFirst({
      where: { region },
      orderBy: { lastUpdateDate: 'desc' },
      select: { lastUpdateDate: true },
    });
    const lastUpdateDate =
      latestMeta?.lastUpdateDate ??
      new Date(Date.now() - WATERMARK_FALLBACK_MS); // 10 years ago fallback

    // ── 3. Fetch items from Oracle Fusion in pages ──────────────────────────
    const allItems: OracleInventoryItem[] = [];
    const pageSize = 500;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await this.oracleClient.getInventoryItems({
        organizationCode,
        lastUpdateDate,
        limit: pageSize,
        offset,
      });
      allItems.push(...page);
      hasMore = page.length === pageSize;
      offset += pageSize;
    }

    this.logger.log(
      `Fetched ${allItems.length} items from Oracle for region=${region} (orgCode=${organizationCode})`,
    );

    // ── 4. Push each item to VendHQ and track in VendHqItemMeta ─────────────
    for (const item of allItems) {
      if (!item.ItemNumber) {
        this.logger.warn(
          `Skipping item (region=${region}): ItemNumber is null or empty`,
          { item },
        );
        result.skipped++;
        continue;
      }

      // Mirrors Java: skip if no market price (Java throws for null price)
      if (item.MarketPrice == null) {
        this.logger.warn(
          `Skipping item ${item.ItemNumber} (region=${region}): MarketPrice is null`,
        );
        result.skipped++;
        continue;
      }

      const isActive = item.InventoryItemStatusCode === 'Active';
      const retailPrice = Number(item.MarketPrice);
      // Java uses LongDescription for the product name, falls back to ItemDescription
      const productName =
        item.LongDescription ?? item.ItemDescription ?? item.ItemNumber;

      // ── Local-only mode (no VendHQ target) ───────────────────────────────
      // Store the Oracle item master directly so it "syncs" and can feed the
      // transformation's UOM/tax/description lookups, keyed by the Oracle item
      // number (there is no VendHQ product id).
      if (!this.vendHqConfigured) {
        const localMeta = {
          itemId: item.ItemNumber,
          sourceId: null, // Oracle ItemId exceeds Int range; omit
          name: productName,
          sku: item.ItemNumber,
          handle: item.ItemNumber,
          uomCode: item.PrimaryUOMCode ?? null,
          uomName: item.PrimaryUOMValue ?? null,
          itemType: item.UserItemTypeValue ?? null,
          description: item.ItemDescription ?? null,
          active: isActive,
          retailPrice: isNaN(retailPrice) ? null : retailPrice,
          taxId: item.OutputTaxClassificationCodeValue ?? null,
          status: 'SUCCESS',
          message: 'Stored from Oracle (VendHQ push skipped — not configured)',
          lastUpdateDate: item.LastUpdateDate
            ? new Date(item.LastUpdateDate)
            : new Date(),
          region,
        };
        await this.prisma.vendHqItemMeta.upsert({
          where: { itemId_region: { itemId: item.ItemNumber, region } },
          create: localMeta,
          update: localMeta,
        });
        result.synced++;
        continue;
      }

      try {
        const vendProduct = await this.vendHqClient.upsertProduct({
          sku: item.ItemNumber,
          handle: item.ItemNumber,
          name: productName,
          description: item.ItemDescription ?? undefined,
          retail_price: isNaN(retailPrice) ? undefined : retailPrice,
          is_active: isActive,
        });

        // Track / update in VendHqItemMeta using upsert to prevent duplicates
        const metaData = {
          itemId: vendProduct.id,
          sourceId: item.ItemId ?? null,
          name: productName,
          sku: item.ItemNumber,
          handle: item.ItemNumber,
          uomCode: item.PrimaryUOMCode ?? null,
          uomName: item.PrimaryUOMValue ?? null,
          itemType: item.UserItemTypeValue ?? null,
          description: item.ItemDescription ?? null,
          active: isActive,
          retailPrice: isNaN(retailPrice) ? null : retailPrice,
          taxId: vendProduct.tax_id ?? null,
          status: 'SUCCESS',
          lastUpdateDate: item.LastUpdateDate
            ? new Date(item.LastUpdateDate)
            : new Date(),
          region,
        };

        await this.prisma.vendHqItemMeta.upsert({
          where: {
            itemId_region: {
              itemId: vendProduct.id,
              region,
            },
          },
          create: metaData,
          update: metaData,
        });

        result.synced++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to sync item ${item.ItemNumber} to VendHQ (region=${region}): ${msg}`,
        );
        result.failed++;
        result.errors.push(`${item.ItemNumber}: ${msg}`);

        // Track failure in VendHqItemMeta for observability
        try {
          const failData = {
            itemId: item.ItemNumber,
            name: productName,
            sku: item.ItemNumber,
            handle: item.ItemNumber,
            status: 'ERROR',
            message: msg,
            lastUpdateDate: new Date(),
            region,
          };

          await this.prisma.vendHqItemMeta.upsert({
            where: {
              itemId_region: {
                itemId: item.ItemNumber,
                region,
              },
            },
            create: failData,
            update: failData,
          });
        } catch {
          // best-effort
        }
      }
    }

    return result;
  }

  async getItemSyncStatus(region?: string) {
    return this.prisma.vendHqItemMeta.findMany({
      where: region ? { region } : undefined,
      orderBy: { lastUpdateDate: 'desc' },
      take: 100,
    });
  }
}
