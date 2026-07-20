import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { SyncControl } from '../database/entities/sync-control.entity';
import { withTimeout, MODULE_INIT_TIMEOUT_MS } from '../common/utils/timeout';

export interface SyncServiceConfig {
  serviceName: string;
  displayName: string;
  description: string;
  enabled?: boolean;
}

/**
 * SyncControlService - Centralized control for all sync operations
 *
 * Provides admin-level control to enable/disable sync cron jobs at runtime.
 * Each sync service (Odoo, IBQ, VendHQ backup, etc.) checks with this service
 * before running to ensure it's enabled.
 */
@Injectable()
export class SyncControlService implements OnModuleInit {
  private readonly logger = new Logger(SyncControlService.name);

  constructor(
    @InjectRepository(SyncControl)
    private readonly syncControlRepo: Repository<SyncControl>,
  ) {}

  /**
   * Initialize sync control records for all known sync services
   */
  async onModuleInit() {
    await withTimeout(
      this.initializeSyncControls(),
      MODULE_INIT_TIMEOUT_MS,
      'SyncControlService.onModuleInit',
    );
  }

  private async initializeSyncControls() {
    const services: Array<SyncServiceConfig> = [
      {
        serviceName: 'odoo-backup',
        displayName: 'Odoo Backup Service',
        description: 'Fetches orders from Odoo API every 15 minutes',
        enabled: true,
      },
      {
        serviceName: 'ibq-backup',
        displayName: 'IBQ Backup Service',
        description: 'Fetches orders from IBQ API every 15 minutes',
        enabled: true,
      },
      {
        serviceName: 'vendhq-backup',
        displayName: 'VendHQ Backup Service',
        description:
          'Fetches sales from VendHQ API every 10 minutes (per region)',
        enabled: true,
      },
      {
        serviceName: 'vendhq-to-oracle',
        displayName: 'VendHQ→Oracle Sync Service',
        description:
          'Syncs VendHQ sales to Oracle every 10 minutes (per region)',
        enabled: true,
      },
      {
        serviceName: 'pipeline-scheduler',
        displayName: 'Pipeline Scheduler',
        description: 'Processes pending orders every 5 minutes',
        enabled: true,
      },
      {
        serviceName: 'item-sync',
        displayName: 'Item Sync Service',
        description: 'Syncs items from Oracle to VendHQ daily (per region)',
        enabled: true,
      },
      {
        serviceName: 'stalled-orders',
        displayName: 'Stalled Orders Service',
        description: 'Checks for stalled orders daily at 1 AM',
        enabled: true,
      },
      {
        serviceName: 'fusion-inv-to-vendhq',
        displayName: 'Fusion Inventory to VendHQ',
        description:
          'Syncs on-hand quantities from Oracle Fusion to VendHQ every 30 minutes (per region)',
        enabled: true,
      },
    ];

    for (const service of services) {
      // For global services (region = null), we need to handle upsert manually
      // because null in a composite unique constraint is handled specially
      // (SQL NULL != NULL), so we match with IS NULL explicitly.
      const existing = await this.syncControlRepo.findOne({
        where: {
          serviceName: service.serviceName,
          region: IsNull(),
        },
      });

      if (existing) {
        await this.syncControlRepo.update(existing.id, {
          displayName: service.displayName,
          description: service.description,
        });
      } else {
        await this.syncControlRepo.save(
          this.syncControlRepo.create({
            serviceName: service.serviceName,
            displayName: service.displayName,
            description: service.description,
            enabled: service.enabled ?? true,
            region: null,
          }),
        );
      }
    }
  }

  /**
   * Check if a sync service is enabled
   */
  async isEnabled(serviceName: string, region?: string): Promise<boolean> {
    // NOTE: the serviceName_region compound key is seeded with region=null for
    // global services; SQL NULL != NULL, so we must match with IS NULL when
    // region is not provided.
    const control = await this.syncControlRepo.findOne({
      where: {
        serviceName,
        region: region ?? IsNull(),
      },
    });

    // Default to true if not found (backward compatibility)
    return control?.enabled ?? true;
  }

  /**
   * Mark a sync service as running
   */
  async markRunning(serviceName: string, region?: string): Promise<void> {
    await this.syncControlRepo.update(
      {
        serviceName,
        region: region ?? IsNull(),
      },
      {
        isRunning: true,
        lastRunAt: new Date(),
        runCount: () => '"runCount" + 1',
      },
    );
  }

  /**
   * Mark a sync service as stopped
   */
  async markStopped(
    serviceName: string,
    status: 'success' | 'error',
    region?: string,
  ): Promise<void> {
    await this.syncControlRepo.update(
      {
        serviceName,
        region: region ?? IsNull(),
      },
      {
        isRunning: false,
        lastStatus: status,
        ...(status === 'error' ? { errorCount: () => '"errorCount" + 1' } : {}),
      },
    );
  }

  /**
   * Enable a sync service
   */
  async enable(serviceName: string, region?: string): Promise<void> {
    await this.syncControlRepo.update(
      {
        serviceName,
        region: region ?? IsNull(),
      },
      { enabled: true },
    );
    const regionLabel = region ? ` (region=${region})` : '';
    this.logger.log(
      `Sync service "${serviceName}"${regionLabel} has been ENABLED`,
    );
  }

  /**
   * Disable a sync service
   */
  async disable(serviceName: string, region?: string): Promise<void> {
    await this.syncControlRepo.update(
      {
        serviceName,
        region: region ?? IsNull(),
      },
      { enabled: false },
    );
    const regionLabel = region ? ` (region=${region})` : '';
    this.logger.warn(
      `Sync service "${serviceName}"${regionLabel} has been DISABLED`,
    );
  }

  /**
   * Get all sync control records, optionally filtered by region
   */
  async listAll(region?: string) {
    return this.syncControlRepo.find({
      where: region ? { region } : {},
      order: { region: 'ASC', displayName: 'ASC' },
    });
  }

  /**
   * Get single sync control record
   */
  async getOne(serviceName: string, region?: string) {
    return this.syncControlRepo.findOne({
      where: {
        serviceName,
        region: region ?? IsNull(),
      },
    });
  }
}
