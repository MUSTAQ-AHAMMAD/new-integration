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
import { Cron } from '@nestjs/schedule';
import {
  OracleInventoryItem,
} from '../clients/oracle/oracle.client';
import { OracleClient } from '../clients/oracle/oracle.client';
import { VendHqClient } from '../clients/vendhq/vendhq.client';
import { PrismaService } from '../prisma/prisma.service';

export interface ItemSyncResult {
  region: string;
  synced: number;
  skipped: number;
  failed: number;
  errors: string[];
}

@Injectable()
export class ItemSyncService {
  private readonly logger = new Logger(ItemSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oracleClient: OracleClient,
    private readonly vendHqClient: VendHqClient,
  ) {}

  /**
   * Runs every hour — mirrors Java Quartz schedule for item master sync.
   * Can also be triggered manually via ItemSyncController.
   */
  @Cron('0 0 * * * *')
  async runItemSync(): Promise<void> {
    const credentials = await this.prisma.vendHqCredential.findMany({
      where: { active: true },
    });

    if (credentials.length === 0) {
      this.logger.warn('No active VendHQ credentials — item sync skipped');
      return;
    }

    for (const cred of credentials) {
      try {
        const result = await this.syncItemsForRegion(cred.region);
        this.logger.log(
          `Item sync done for region=${result.region}: ` +
            `synced=${result.synced} skipped=${result.skipped} failed=${result.failed}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Item sync failed for region=${cred.region}: ${msg}`);
      }
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

    // ── 1. Determine Oracle organization code from the VendHQ outlet config ─
    const outlet = await this.prisma.vendHqOutlet.findFirst({
      where: { region },
    });
    // Oracle organization code defaults to region code when no outlet is found
    const organizationCode = outlet?.outletName ?? region;

    // ── 2. Fetch items from Oracle Fusion in pages ──────────────────────────
    const allItems: OracleInventoryItem[] = [];
    const pageSize = 500;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await this.oracleClient.getInventoryItems({
        organizationCode,
        limit: pageSize,
        offset,
      });
      allItems.push(...page);
      hasMore = page.length === pageSize;
      offset += pageSize;
    }

    this.logger.log(
      `Fetched ${allItems.length} items from Oracle for region=${region}`,
    );

    // ── 3. Push each item to VendHQ and track in VendHqItemMeta ─────────────
    for (const item of allItems) {
      if (!item.ItemNumber) {
        result.skipped++;
        continue;
      }

      try {
        const vendProduct = await this.vendHqClient.upsertProduct({
          sku: item.ItemNumber,
          name: item.ItemDescription ?? item.ItemNumber,
          retail_price: item.ListPrice,
          is_active: item.ItemStatus?.toUpperCase() === 'ACTIVE',
        });

        // Track / update in VendHqItemMeta
        const existing = await this.prisma.vendHqItemMeta.findFirst({
          where: { itemId: vendProduct.id, region },
          select: { id: true },
        });

        const metaData = {
          itemId: vendProduct.id,
          name: vendProduct.name ?? item.ItemDescription ?? item.ItemNumber,
          sku: item.ItemNumber,
          handle: vendProduct.handle ?? null,
          description: item.ItemDescription ?? null,
          active: item.ItemStatus?.toUpperCase() === 'ACTIVE',
          retailPrice: item.ListPrice ?? null,
          taxId: vendProduct.tax_id ?? null,
          status: 'SUCCESS',
          lastUpdateDate: new Date(),
          region,
        };

        if (existing) {
          await this.prisma.vendHqItemMeta.update({
            where: { id: existing.id },
            data: metaData,
          });
        } else {
          await this.prisma.vendHqItemMeta.create({ data: metaData });
        }

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
          const existing = await this.prisma.vendHqItemMeta.findFirst({
            where: { itemId: item.ItemNumber, region },
            select: { id: true },
          });
          const failData = {
            itemId: item.ItemNumber,
            name: item.ItemDescription ?? item.ItemNumber,
            sku: item.ItemNumber,
            status: 'ERROR',
            message: msg,
            lastUpdateDate: new Date(),
            region,
          };
          if (existing) {
            await this.prisma.vendHqItemMeta.update({
              where: { id: existing.id },
              data: failData,
            });
          } else {
            await this.prisma.vendHqItemMeta.create({ data: failData });
          }
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
