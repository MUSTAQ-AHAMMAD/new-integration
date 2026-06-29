import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
    const services: SyncServiceConfig[] = [
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
        description: 'Fetches sales from VendHQ API every 10 minutes',
        enabled: true,
      },
      {
        serviceName: 'vendhq-to-oracle',
        displayName: 'VendHQ→Oracle Sync Service',
        description: 'Syncs VendHQ sales to Oracle every 10 minutes',
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
        description: 'Syncs items from Oracle to VendHQ daily',
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
          'Syncs on-hand quantities from Oracle Fusion to VendHQ every 30 minutes',
        enabled: true,
      },
    ];

    for (const service of services) {
      await this.prisma.syncControl.upsert({
        where: { serviceName: service.serviceName },
        create: service,
        update: {
          displayName: service.displayName,
          description: service.description,
        },
      });
    }
  }

  /**
   * Check if a sync service is enabled
   */
  async isEnabled(serviceName: string): Promise<boolean> {
    const control = await this.prisma.syncControl.findUnique({
      where: { serviceName },
    });

    // Default to true if not found (backward compatibility)
    return control?.enabled ?? true;
  }

  /**
   * Mark a sync service as running
   */
  async markRunning(serviceName: string): Promise<void> {
    await this.prisma.syncControl.update({
      where: { serviceName },
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
  ): Promise<void> {
    await this.prisma.syncControl.update({
      where: { serviceName },
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
  async enable(serviceName: string): Promise<void> {
    await this.prisma.syncControl.update({
      where: { serviceName },
      data: { enabled: true },
    });
    this.logger.log(`Sync service "${serviceName}" has been ENABLED`);
  }

  /**
   * Disable a sync service
   */
  async disable(serviceName: string): Promise<void> {
    await this.prisma.syncControl.update({
      where: { serviceName },
      data: { enabled: false },
    });
    this.logger.warn(`Sync service "${serviceName}" has been DISABLED`);
  }

  /**
   * Get all sync control records
   */
  async listAll() {
    return this.prisma.syncControl.findMany({
      orderBy: { displayName: 'asc' },
    });
  }

  /**
   * Get single sync control record
   */
  async getOne(serviceName: string) {
    return this.prisma.syncControl.findUnique({
      where: { serviceName },
    });
  }
}
