import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import { AlertsService } from '../alerts/alerts.service';
import { AlertLog } from '../database/entities/alert-log.entity';
import { ConfigurationBackup } from '../database/entities/configuration-backup.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
import { AlertType } from '../database/enums';

/**
 * Enhanced batch operations service with:
 * - Atomic transactions (all or nothing)
 * - Automatic backup before operations
 * - Rollback capability
 * - Alert resolution
 * - Dry-run mode
 */
@Injectable()
export class BatchOperationsService {
  private readonly logger = new Logger(BatchOperationsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(StoreConfiguration)
    private readonly stores: Repository<StoreConfiguration>,
    @InjectRepository(ConfigurationBackup)
    private readonly backups: Repository<ConfigurationBackup>,
    @InjectRepository(VendHqRegister)
    private readonly registers: Repository<VendHqRegister>,
    @InjectRepository(AlertLog)
    private readonly alertLogs: Repository<AlertLog>,
    private readonly alertsService: AlertsService,
  ) {}

  /**
   * Atomically update bank/cash account IDs with backup and rollback support
   */
  async populateBankCashAccountsAtomic(options?: {
    dryRun?: boolean;
    autoRollbackOnError?: boolean;
  }): Promise<{
    totalStores: number;
    updated: number;
    skipped: number;
    errors: string[];
    backupId?: string;
    dryRun: boolean;
  }> {
    const { dryRun = false, autoRollbackOnError = true } = options || {};

    this.logger.log('=== ATOMIC BATCH UPDATE: Populate Bank/Cash Accounts ===');
    this.logger.log(`Mode: ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
    this.logger.log(
      `Auto-rollback: ${autoRollbackOnError ? 'ENABLED' : 'DISABLED'}`,
    );

    const errors: string[] = [];
    let updated = 0;
    let skipped = 0;
    let backupId: string | undefined;

    try {
      // === STEP 1: FETCH DATA (outside transaction) ===
      this.logger.log('Step 1/6: Fetching VendHQ register data by region...');

      // Most-recent register per region (Oracle-portable replacement for the
      // former Postgres DISTINCT ON (region) ... ORDER BY region, createdAt DESC).
      const allRegisters = await this.registers.find({
        where: {
          bankAccountId: Not(IsNull()),
          cashAccountId: Not(IsNull()),
          region: Not(IsNull()),
        },
        order: { createdAt: 'DESC' },
      });
      const registersByRegion: Array<{
        region: string;
        bankAccountId: bigint | null;
        cashAccountId: bigint | null;
      }> = [];
      const seenRegions = new Set<string>();
      for (const reg of allRegisters) {
        if (!reg.region || seenRegions.has(reg.region)) continue;
        seenRegions.add(reg.region);
        registersByRegion.push({
          region: reg.region,
          bankAccountId: reg.bankAccountId,
          cashAccountId: reg.cashAccountId,
        });
      }

      if (registersByRegion.length === 0) {
        throw new Error(
          'No VendHqRegister data found with bankAccountId/cashAccountId',
        );
      }

      this.logger.log(
        `Found registers for ${registersByRegion.length} regions`,
      );

      // === STEP 2: IDENTIFY STORES NEEDING UPDATE ===
      this.logger.log(
        'Step 2/6: Identifying stores with missing account IDs...',
      );

      const stores = await this.stores.find({
        where: [
          { isActive: true, bankAccountId: IsNull() },
          { isActive: true, cashAccountId: IsNull() },
        ],
        select: {
          branchCode: true,
          region: true,
          bankAccountId: true,
          cashAccountId: true,
          branchName: true,
        },
      });

      this.logger.log(`Found ${stores.length} stores with missing account IDs`);

      if (stores.length === 0) {
        return {
          totalStores: 0,
          updated: 0,
          skipped: 0,
          errors: [],
          dryRun,
        };
      }

      // === DRY-RUN MODE: Return preview ===
      if (dryRun) {
        this.logger.log('DRY-RUN MODE: Showing what would be updated...');

        const preview = stores.map((store) => {
          const regionData = registersByRegion.find(
            (r) => r.region === store.region,
          );
          return {
            branchCode: store.branchCode,
            region: store.region,
            currentBankId: store.bankAccountId,
            currentCashId: store.cashAccountId,
            newBankId: regionData?.bankAccountId
              ? Number(regionData.bankAccountId)
              : null,
            newCashId: regionData?.cashAccountId
              ? Number(regionData.cashAccountId)
              : null,
            wouldUpdate: !!regionData,
          };
        });

        this.logger.log(
          `Would update ${preview.filter((p) => p.wouldUpdate).length} stores`,
        );

        return {
          totalStores: stores.length,
          updated: preview.filter((p) => p.wouldUpdate).length,
          skipped: preview.filter((p) => !p.wouldUpdate).length,
          errors: [],
          dryRun: true,
        };
      }

      // === STEP 3: CREATE BACKUP ===
      this.logger.log('Step 3/6: Creating backup snapshot...');

      const backupData = stores.map((s) => ({
        branchCode: s.branchCode,
        bankAccountId: s.bankAccountId,
        cashAccountId: s.cashAccountId,
      }));

      const backup = await this.backups.save(
        this.backups.create({
          backupReason: 'pre_batch_account_population',
          backupData: backupData,
          affectedBranches: stores.map((s) => s.branchCode),
          recordCount: stores.length,
          createdBy: 'SYSTEM_BATCH_UPDATE',
        }),
      );

      backupId = backup.id;
      this.logger.log(`✅ Backup created: ${backupId}`);

      // === STEP 4: ATOMIC TRANSACTION ===
      this.logger.log('Step 4/6: Executing atomic batch update...');

      await this.dataSource.transaction(async (manager) => {
        // Process in batches of 10 for better performance
        const BATCH_SIZE = 10;

        for (let i = 0; i < stores.length; i += BATCH_SIZE) {
          const batch = stores.slice(i, i + BATCH_SIZE);

          await Promise.all(
            batch.map(async (store) => {
              if (!store.region) {
                errors.push(
                  `Store ${store.branchCode} has no region - skipped`,
                );
                skipped++;
                return;
              }

              const regionData = registersByRegion.find(
                (r) => r.region === store.region,
              );

              if (!regionData) {
                errors.push(
                  `No register data for region ${store.region} - skipped`,
                );
                skipped++;
                return;
              }

              const updateData: {
                bankAccountId?: number;
                cashAccountId?: number;
              } = {};

              if (!store.bankAccountId && regionData.bankAccountId) {
                updateData.bankAccountId = Number(regionData.bankAccountId);
              }

              if (!store.cashAccountId && regionData.cashAccountId) {
                updateData.cashAccountId = Number(regionData.cashAccountId);
              }

              if (Object.keys(updateData).length > 0) {
                await manager.update(
                  StoreConfiguration,
                  { branchCode: store.branchCode },
                  updateData,
                );

                this.logger.log(
                  `Updated ${store.branchCode}: bank=${updateData.bankAccountId || 'unchanged'}, cash=${updateData.cashAccountId || 'unchanged'}`,
                );
                updated++;
              } else {
                skipped++;
              }
            }),
          );
        }

        // === POST-UPDATE VERIFICATION ===
        const missingAfterUpdate = await manager.count(StoreConfiguration, {
          where: [
            { isActive: true, bankAccountId: IsNull() },
            { isActive: true, cashAccountId: IsNull() },
          ],
        });

        if (missingAfterUpdate > 0) {
          throw new Error(
            `Integrity check failed: ${missingAfterUpdate} active stores still have NULL account IDs after update`,
          );
        }

        this.logger.log(
          '✅ Integrity check passed: All active stores have account IDs',
        );
      });

      // === STEP 5: RESOLVE ALERTS ===
      this.logger.log('Step 5/6: Resolving related alerts...');
      await this.resolveStoreConfigAlerts(stores.map((s) => s.branchCode));

      // === STEP 6: SUCCESS ===
      this.logger.log(
        `✅ Completed: ${updated} updated, ${skipped} skipped out of ${stores.length} stores`,
      );

      return {
        totalStores: stores.length,
        updated,
        skipped,
        errors,
        backupId,
        dryRun: false,
      };
    } catch (error) {
      this.logger.error('❌ Batch update failed:', error);

      // AUTO-ROLLBACK
      if (autoRollbackOnError && backupId) {
        this.logger.error(
          '🔄 Auto-rollback triggered - attempting to restore from backup...',
        );
        try {
          await this.rollbackFromBackup(backupId);
          this.logger.log('✅ Rollback successful');
          errors.push('Update failed and was rolled back successfully');
        } catch (rollbackError) {
          this.logger.error('❌ Rollback also failed:', rollbackError);
          errors.push(
            'CRITICAL: Update failed AND rollback failed - manual intervention required',
          );
          errors.push(`Backup ID for manual recovery: ${backupId}`);
        }
      }

      errors.push(error instanceof Error ? error.message : String(error));

      return {
        totalStores: 0,
        updated,
        skipped,
        errors,
        backupId,
        dryRun: false,
      };
    }
  }

  /**
   * Resolve store configuration alerts for specific branches
   */
  private async resolveStoreConfigAlerts(
    branchCodes: string[],
  ): Promise<number> {
    if (branchCodes.length === 0) return 0;

    const result = await this.alertLogs.update(
      {
        alertType: AlertType.STORE_CONFIG_INVALID,
        relatedEntityId: In(branchCodes),
        isResolved: false,
      },
      {
        isResolved: true,
        resolvedAt: new Date(),
        resolvedBy: 'SYSTEM_AUTO_FIX',
      },
    );

    const count = result.affected ?? 0;
    this.logger.log(`Resolved ${count} store configuration alerts`);
    return count;
  }

  /**
   * Rollback store configurations from a backup
   */
  async rollbackFromBackup(backupId: string): Promise<{
    restored: number;
    errors: string[];
  }> {
    this.logger.log(`🔄 Rolling back from backup: ${backupId}`);

    const backup = await this.backups.findOne({
      where: { id: backupId },
    });

    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    const backupData = backup.backupData as Array<{
      branchCode: string;
      bankAccountId: number | bigint | null;
      cashAccountId: number | bigint | null;
    }>;
    const errors: string[] = [];
    let restored = 0;

    await this.dataSource.transaction(async (manager) => {
      for (const config of backupData) {
        try {
          await manager.update(
            StoreConfiguration,
            { branchCode: config.branchCode },
            {
              bankAccountId:
                config.bankAccountId != null
                  ? Number(config.bankAccountId)
                  : null,
              cashAccountId:
                config.cashAccountId != null
                  ? Number(config.cashAccountId)
                  : null,
            },
          );
          restored++;
        } catch (err) {
          errors.push(`Failed to restore ${config.branchCode}: ${err}`);
        }
      }
    });

    this.logger.log(
      `✅ Rollback complete: ${restored} configurations restored`,
    );

    return { restored, errors };
  }

  /**
   * List available backups
   */
  async listBackups(limit = 20): Promise<Partial<ConfigurationBackup>[]> {
    return this.backups.find({
      order: { createdAt: 'DESC' },
      take: limit,
      select: {
        id: true,
        backupReason: true,
        recordCount: true,
        affectedBranches: true,
        createdBy: true,
        createdAt: true,
      },
    });
  }

  /**
   * Create a manual backup
   */
  async createManualBackup(reason: string): Promise<string> {
    const stores = await this.stores.find({
      where: { isActive: true },
      select: {
        branchCode: true,
        bankAccountId: true,
        cashAccountId: true,
        region: true,
      },
    });

    const backup = await this.backups.save(
      this.backups.create({
        backupReason: reason,
        backupData: stores,
        affectedBranches: stores.map((s) => s.branchCode),
        recordCount: stores.length,
        createdBy: 'MANUAL',
      }),
    );

    this.logger.log(
      `Manual backup created: ${backup.id} (${stores.length} stores)`,
    );
    return backup.id;
  }
}
