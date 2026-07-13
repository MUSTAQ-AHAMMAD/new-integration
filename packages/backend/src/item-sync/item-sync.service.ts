/**
 * ItemSyncService — refreshes the local item master from Oracle.
 *
 * Historically this pulled items from Oracle's `items` REST resource, but that
 * resource is search-only: it rejects any unfiltered/bulk listing with
 * EGP-2776154 ("You must enter at least 3 characters in one of these fields:
 * ItemNumber, ItemDescription, Keyword") and rejects wildcards, so it can never
 * enumerate the catalog. Every run therefore 500'd.
 *
 * The item master is instead sourced from the direct Oracle DB import
 * (OracleNativeService.importFromOracle → VENDHQ_ITEM_META → VendHqItemMeta),
 * which is the path that actually populated the ~16k-row master. This service
 * now delegates to that import.
 *
 * Scheduled every hour (matching the Java Quartz interval for item sync); can
 * also be triggered manually via ItemSyncController.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OracleNativeService } from '../admin/oracle-native.service';
import { PrismaService } from '../prisma/prisma.service';
import { SyncControlService } from '../sync/sync-control.service';

/** Oracle DB source table holding the item master. */
const ITEM_META_TABLE = 'VENDHQ_ITEM_META';

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
    private readonly oracleNative: OracleNativeService,
    private readonly syncControl: SyncControlService,
  ) {}

  /**
   * Runs every hour — mirrors Java Quartz schedule for item master sync.
   * Can also be triggered manually via ItemSyncController.
   */
  @Cron('0 0 * * * *')
  async runItemSync(): Promise<void> {
    const enabled = await this.syncControl.isEnabled('item-sync');
    if (!enabled) {
      this.logger.debug('Item sync service is disabled, skipping cron run');
      return;
    }

    await this.syncControl.markRunning('item-sync');
    try {
      const result = await this.importItemMaster();
      this.logger.log(
        `Item sync done: synced=${result.synced} skipped=${result.skipped} failed=${result.failed}`,
      );
      await this.syncControl.markStopped(
        'item-sync',
        result.failed > 0 ? 'error' : 'success',
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Item sync job failed: ${msg}`);
      await this.syncControl.markStopped('item-sync', 'error');
    }
  }

  /**
   * Refreshes the item master from the Oracle DB. The `region` argument is
   * accepted for API compatibility but the source table holds all regions, so a
   * single import covers every region at once.
   */
  async syncItemsForRegion(region: string): Promise<ItemSyncResult> {
    const result = await this.importItemMaster();
    return { ...result, region };
  }

  /**
   * Imports VENDHQ_ITEM_META from the Oracle DB into VendHqItemMeta via the
   * native importer, and maps its summary onto ItemSyncResult.
   */
  private async importItemMaster(): Promise<ItemSyncResult> {
    const summary = await this.oracleNative.importFromOracle([ITEM_META_TABLE]);
    const tableResult = summary.results.find(
      (r) => r.oracleTable === ITEM_META_TABLE,
    );
    const result: ItemSyncResult = {
      region: 'ALL',
      synced: tableResult?.imported ?? 0,
      skipped: tableResult?.skipped ?? 0,
      failed: tableResult?.errors.length ?? 0,
      errors: tableResult?.errors ?? [],
    };
    this.logger.log(
      `Imported ${ITEM_META_TABLE} from Oracle DB (${summary.connectedAs}): ` +
        `synced=${result.synced} skipped=${result.skipped} failed=${result.failed}`,
    );
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
