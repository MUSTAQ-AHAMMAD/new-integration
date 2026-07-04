import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  withTimeout,
  MODULE_INIT_TIMEOUT_MS,
} from '../common/utils/timeout';

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

  constructor(private readonly prisma: PrismaService) {}

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
    const services: Array<Omit<SyncServiceConfig, 'region'>> = [
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
        description: 'Fetches sales from VendHQ API every 10 minutes (per region)',
        enabled: true,
      },
      {
        serviceName: 'vendhq-to-oracle',
        displayName: 'VendHQ→Oracle Sync Service',
        description: 'Syncs VendHQ sales to Oracle every 10 minutes (per region)',
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
      // because Prisma doesn't handle null well in composite unique constraints
      const existing = await this.prisma.syncControl.findFirst({
        where: {
          serviceName: service.serviceName,
          region: null,
        },
      });

      if (existing) {
        await this.prisma.syncControl.update({
          where: { id: existing.id },
          data: {
            displayName: service.displayName,
            description: service.description,
          },
        });
      } else {
        await this.prisma.syncControl.create({
          data: service,
        });
      }
    }
  }

  /**
   * Check if a sync service is enabled
   */
  async isEnabled(serviceName: string, region?: string): Promise<boolean> {
    const control = await this.prisma.syncControl.findUnique({
      where: { 
        serviceName_region: {
          serviceName,
          region: (region ?? null)!,
        },
      },
    });

    // Default to true if not found (backward compatibility)
    return control?.enabled ?? true;
  }

  /**
   * Mark a sync service as running
   */
  async markRunning(serviceName: string, region?: string): Promise<void> {
    await this.prisma.syncControl.update({
      where: { 
        serviceName_region: {
          serviceName,
          region: (region ?? null)!,
        },
      },
      data: {
        isRunning: true,
        lastRunAt: new Date(),
        runCount: { increment: 1 },
      },
    });
  }

  /**
   * Mark a sync service as stopped
   */
  async markStopped(
    serviceName: string,
    status: 'success' | 'error',
    region?: string,
  ): Promise<void> {
    await this.prisma.syncControl.update({
      where: { 
        serviceName_region: {
          serviceName,
          region: (region ?? null)!,
        },
      },
      data: {
        isRunning: false,
        lastStatus: status,
        ...(status === 'error' ? { errorCount: { increment: 1 } } : {}),
      },
    });
  }

  /**
   * Enable a sync service
   */
  async enable(serviceName: string, region?: string): Promise<void> {
    await this.prisma.syncControl.update({
      where: { 
        serviceName_region: {
          serviceName,
          region: (region ?? null)!,
        },
      },
      data: { enabled: true },
    });
    const regionLabel = region ? ` (region=${region})` : '';
    this.logger.log(`Sync service "${serviceName}"${regionLabel} has been ENABLED`);
  }

  /**
   * Disable a sync service
   */
  async disable(serviceName: string, region?: string): Promise<void> {
    await this.prisma.syncControl.update({
      where: { 
        serviceName_region: {
          serviceName,
          region: (region ?? null)!,
        },
      },
      data: { enabled: false },
    });
    const regionLabel = region ? ` (region=${region})` : '';
    this.logger.warn(`Sync service "${serviceName}"${regionLabel} has been DISABLED`);
  }

  /**
   * Get all sync control records, optionally filtered by region
   */
  async listAll(region?: string) {
    return this.prisma.syncControl.findMany({
      where: region ? { region } : {},
      orderBy: [{ region: 'asc' }, { displayName: 'asc' }],
    });
  }

  /**
   * Get single sync control record
   */
  async getOne(serviceName: string, region?: string) {
    return this.prisma.syncControl.findUnique({
      where: { 
        serviceName_region: {
          serviceName,
          region: (region ?? null)!,
        },
      },
    });
  }
}
