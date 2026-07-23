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
        serviceName: 'daily-invoice',
        displayName: 'Daily Invoice Aggregation',
        description:
          'Posts one Oracle invoice per branch, business day, customer type ' +
          'and credit flag at 03:00, catching up to 7 days',
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
  /**
   * Atomically acquires a cross-process run lock for a service.
   *
   * Unlike the in-process boolean guards it replaces, this is a single
   * compare-and-set UPDATE, so two backend instances (or api + worker) cannot
   * both win. The lock auto-expires after `leaseMs` using `lastRunAt` as the
   * lease timestamp, so a crashed holder never blocks the job forever.
   *
   * @returns true if this caller now holds the lock.
   */
  async acquireLock(
    serviceName: string,
    region?: string,
    leaseMs = 30 * 60 * 1000,
  ): Promise<boolean> {
    const leaseCutoff = new Date(Date.now() - leaseMs);
    // WHERE isRunning = false OR the lease has expired.
    const result = await this.syncControlRepo
      .createQueryBuilder()
      .update(SyncControl)
      .set({ isRunning: true, lastRunAt: new Date(), lastStatus: 'RUNNING' })
      .where('serviceName = :serviceName', { serviceName })
      .andWhere(region ? 'region = :region' : 'region IS NULL', { region })
      .andWhere('("isRunning" = 0 OR "lastRunAt" < :leaseCutoff)', {
        leaseCutoff,
      })
      .execute();

    const acquired = (result.affected ?? 0) > 0;
    if (acquired) {
      this.syncControlRepo
        .increment(
          { serviceName, region: region ?? IsNull() },
          'runCount',
          1,
        )
        .catch(() => undefined);
    } else {
      this.logger.warn(
        `Could not acquire run lock for "${serviceName}"${region ? ` (${region})` : ''} — another run holds it`,
      );
    }
    return acquired;
  }

  /** Releases a lock acquired by acquireLock. */
  async releaseLock(
    serviceName: string,
    region?: string,
    status: 'SUCCESS' | 'ERROR' = 'SUCCESS',
  ): Promise<void> {
    await this.syncControlRepo.update(
      { serviceName, region: region ?? IsNull() },
      { isRunning: false, lastStatus: status, lastRunAt: new Date() },
    );
  }

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
    const rows = await this.syncControlRepo.find({
      where: region ? { region } : {},
      order: { region: 'ASC', displayName: 'ASC' },
    });
    // Enrich each row with its next scheduled fire time so operators can see
    // "when does this run next" without inspecting cron strings.
    return rows.map((r) => ({
      ...r,
      nextRunAt: this.nextRunAt(r.serviceName),
    }));
  }

  /**
   * Cron expression per scheduled service, kept here so the control API can
   * report next-fire times. Must stay in sync with the @Cron decorators.
   */
  private static readonly SCHEDULES: Record<string, string> = {
    'odoo-backup': '0 */15 * * * *',
    'ibq-backup': '0 */15 * * * *',
    'vendhq-backup': '0 */10 * * * *',
    'vendhq-to-oracle': '0 */10 * * * *',
    'pipeline-scheduler': '0 */5 * * * *',
    'item-sync': '0 0 * * * *',
    'fusion-inv-to-vendhq': '0 */30 * * * *',
    'stalled-orders': '0 0 1 * * *',
    'daily-invoice': '0 0 3 * * *',
  };

  /**
   * Computes the next fire time for the fixed-interval / fixed-time crons above.
   * Handles the two shapes actually used: `0 * /N * * * *` (every N min) and
   * `0 0 H * * *` (daily at H). Returns null for anything else.
   */
  nextRunAt(serviceName: string): Date | null {
    const cron = SyncControlService.SCHEDULES[serviceName];
    if (!cron) return null;
    const parts = cron.split(' ');
    if (parts.length !== 6) return null;
    const [, min, hour] = parts;
    const now = new Date();
    const next = new Date(now.getTime());
    next.setSeconds(0, 0);

    const everyN = /^\*\/(\d+)$/.exec(min);
    if (everyN && hour === '*') {
      const n = Number(everyN[1]);
      const add = n - (now.getMinutes() % n || n);
      next.setMinutes(now.getMinutes() + (add === 0 ? n : add));
      return next;
    }
    // Daily at a fixed hour: "0 0 H * * *"
    if (min === '0' && /^\d+$/.test(hour)) {
      next.setMinutes(0);
      next.setHours(Number(hour));
      if (next <= now) next.setDate(next.getDate() + 1);
      return next;
    }
    return null;
  }

  /**
   * Get single sync control record
   */
  async getOne(serviceName: string, region?: string) {
    const row = await this.syncControlRepo.findOne({
      where: {
        serviceName,
        region: region ?? IsNull(),
      },
    });
    if (!row) return row;
    return { ...row, nextRunAt: this.nextRunAt(row.serviceName) };
  }
}
