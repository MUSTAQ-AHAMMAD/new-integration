/**
 * FusionInvToVendHqService — TypeScript port of the Java
 * FusionOnHandQtyFetch + FusionInvToVendHQInvIntegration processors.
 *
 * Scheduled every 30 minutes (matching the Java Quartz interval for inventory sync).
 * For each active credential / Oracle region it:
 *  1. Fetches on-hand quantities from Oracle Fusion REST API (FusionOnHandQtyFetch).
 *  2. Resolves the matching VendHQ product by SKU (item number).
 *  3. Resolves the matching VendHQ outlet for the region.
 *  4. Pushes updated inventory counts to VendHQ (FusionInvToVendHQInvIntegration).
 *  5. Records each transaction in FusionInvTxn for audit/observability.
 *  6. Fires an alert on partial failures without blocking the rest.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  OracleClient,
  OracleOnHandQuantity,
} from '../clients/oracle/oracle.client';
import { VendHqClient } from '../clients/vendhq/vendhq.client';
import { PrismaService } from '../prisma/prisma.service';
import { SyncControlService } from '../sync/sync-control.service';

export interface InventoryPushResult {
  region: string;
  synced: number;
  skipped: number;
  failed: number;
  errors: string[];
}

@Injectable()
export class FusionInvToVendHqService {
  private readonly logger = new Logger(FusionInvToVendHqService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oracleClient: OracleClient,
    private readonly vendHqClient: VendHqClient,
    private readonly syncControl: SyncControlService,
  ) {}

  /**
   * Runs every 30 minutes — mirrors Java Quartz schedule for inventory sync.
   * Can also be triggered manually via the controller.
   */
  @Cron('0 */30 * * * *')
  async runInventorySync(): Promise<void> {
    // Check if sync control allows this service to run
    const enabled = await this.syncControl.isEnabled('fusion-inv-to-vendhq');
    if (!enabled) {
      this.logger.debug('Fusion inventory sync is disabled, skipping cron run');
      return;
    }

    await this.syncControl.markRunning('fusion-inv-to-vendhq');
    try {
      const credentials = await this.prisma.vendHqCredential.findMany({
        where: { active: true },
      });

      if (credentials.length === 0) {
        this.logger.warn(
          'No active VendHQ credentials — inventory sync skipped',
        );
        await this.syncControl.markStopped('fusion-inv-to-vendhq', 'success');
        return;
      }

      for (const cred of credentials) {
        try {
          const result = await this.syncInventoryForRegion(cred.region);
          this.logger.log(
            `Inventory sync done for region=${result.region}: ` +
              `synced=${result.synced} skipped=${result.skipped} failed=${result.failed}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Inventory sync failed for region=${cred.region}: ${msg}`,
          );
        }
      }
      await this.syncControl.markStopped('fusion-inv-to-vendhq', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Inventory sync cron failed: ${msg}`);
      await this.syncControl.markStopped('fusion-inv-to-vendhq', 'error');
    }
  }

  /**
   * Sync Oracle Fusion on-hand quantities → VendHQ for one region.
   * Exposed so the controller can trigger a manual run.
   *
   * Flow mirrors Java:
   *   FusionOnHandQtyFetch.execute()       → fetch from Oracle
   *   FusionInvToVendHQInvIntegration.run() → push to VendHQ
   */
  async syncInventoryForRegion(region: string): Promise<InventoryPushResult> {
    const result: InventoryPushResult = {
      region,
      synced: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    // ── 1. Resolve Oracle organization from VendHQ outlet config ─────────────
    const outlet = await this.prisma.vendHqOutlet.findFirst({
      where: { region },
    });
    const organizationCode = outlet?.outletName ?? region;
    const vendHqOutletId = outlet?.outletId;

    if (!vendHqOutletId) {
      this.logger.warn(
        `No VendHQ outlet found for region=${region} — inventory sync skipped`,
      );
      result.skipped++;
      return result;
    }

    // ── 2. FusionOnHandQtyFetch: fetch on-hand quantities from Oracle ─────────
    const allOnHand: OracleOnHandQuantity[] = [];
    const pageSize = 500;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await this.oracleClient.getInventoryOnHand({
        organizationCode,
        limit: pageSize,
        offset,
      });
      allOnHand.push(...page);
      hasMore = page.length === pageSize;
      offset += pageSize;
    }

    this.logger.log(
      `Fetched ${allOnHand.length} on-hand records from Oracle for region=${region}`,
    );

    // ── 3. FusionInvToVendHQInvIntegration: push each quantity to VendHQ ─────
    for (const onHand of allOnHand) {
      if (!onHand.ItemNumber) {
        result.skipped++;
        continue;
      }

      const quantity = onHand.OnHandQuantity ?? 0;

      try {
        // Resolve VendHQ product by SKU (item number)
        const vendHqItem = await this.prisma.vendHqItemMeta.findFirst({
          where: { sku: onHand.ItemNumber, region },
          select: { itemId: true },
        });

        if (!vendHqItem) {
          // Item not yet synced from Oracle to VendHQ — skip silently
          result.skipped++;
          continue;
        }

        // Push on-hand quantity to VendHQ
        await this.vendHqClient.updateInventory({
          productId: vendHqItem.itemId,
          outletId: vendHqOutletId,
          current: quantity,
        });

        // Record in FusionInvTxn for audit trail
        await this.prisma.fusionInvTxn.create({
          data: {
            status: 'SUCCESS',
            requestDate: new Date(),
            organizationName: organizationCode,
            itemNumber: onHand.ItemNumber,
            txnSourceName: 'ORACLE_ON_HAND',
            subInventory: onHand.SubinventoryCode ?? null,
            txnUom: onHand.UOMCode ?? 'EA',
            txnDate: new Date(),
            txnQty: quantity,
            region,
            integMode: `${region}-INV-SYNC`,
          },
        });

        result.synced++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Inventory push failed for item ${onHand.ItemNumber} (region=${region}): ${msg}`,
        );
        result.failed++;
        result.errors.push(`${onHand.ItemNumber}: ${msg}`);

        // Record failure in FusionInvTxn for observability
        try {
          await this.prisma.fusionInvTxn.create({
            data: {
              status: 'ERROR',
              message: msg,
              requestDate: new Date(),
              organizationName: organizationCode,
              itemNumber: onHand.ItemNumber,
              txnSourceName: 'ORACLE_ON_HAND',
              subInventory: onHand.SubinventoryCode ?? null,
              txnUom: onHand.UOMCode ?? 'EA',
              txnDate: new Date(),
              txnQty: quantity,
              region,
              integMode: `${region}-INV-SYNC`,
            },
          });
        } catch {
          // best-effort
        }
      }
    }

    return result;
  }

  /**
   * Fetch latest inventory transaction records for the given region.
   */
  async getInventoryTransactions(region?: string, limit = 100) {
    return this.prisma.fusionInvTxn.findMany({
      where: region ? { region } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
