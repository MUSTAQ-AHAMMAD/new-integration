/**
 * IntegrationSchedulerService — runs the full Odoo→Oracle Integration Run
 * automatically, per region, on a schedule.
 *
 * Each active Odoo region gets its own enable/disable toggle in the Sync
 * Control Center (SyncControl serviceName='integration-auto', region=<REGION>),
 * plus a global master switch (region=null). On each cron tick, every region
 * that is enabled (master AND its own row) kicks off an IntegrationRunService
 * run for a small catch-up window. Regions run concurrently — the run service's
 * per-region lock keeps a region from racing itself, while letting different
 * regions proceed in parallel.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { IntegrationRunService } from './integration-run.service';
import { SyncControlService } from './sync-control.service';
import { withTimeout, MODULE_INIT_TIMEOUT_MS } from '../common/utils/timeout';

const SERVICE = 'integration-auto';
/** How many days back (in addition to today) each auto run covers. */
const LOOKBACK_DAYS = Math.max(
  0,
  parseInt(process.env.INTEGRATION_AUTO_LOOKBACK_DAYS ?? '1', 10),
);

@Injectable()
export class IntegrationSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationSchedulerService.name);

  constructor(
    private readonly integrationRun: IntegrationRunService,
    private readonly syncControl: SyncControlService,
    @InjectRepository(OdooCredential)
    private readonly credentials: Repository<OdooCredential>,
  ) {}

  /** Seed a per-region toggle (disabled by default) for every active region. */
  async onModuleInit(): Promise<void> {
    await withTimeout(
      this.seedRegionControls(),
      MODULE_INIT_TIMEOUT_MS,
      'IntegrationSchedulerService.onModuleInit',
    ).catch((err) =>
      this.logger.warn(
        `Could not seed per-region integration toggles: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
  }

  private async seedRegionControls(): Promise<void> {
    for (const region of await this.activeRegions()) {
      await this.syncControl.ensureControl(SERVICE, region, {
        displayName: `Automatic Integration — ${region}`,
        description: `Auto-runs the full integration cycle for ${region} on schedule.`,
        enabled: false,
      });
    }
  }

  /**
   * Fires on the configured schedule (INTEGRATION_AUTO_CRON, default 02:00
   * daily). Runs every enabled region; regions proceed concurrently.
   */
  @Cron(process.env.INTEGRATION_AUTO_CRON || '0 0 2 * * *')
  async runScheduled(): Promise<void> {
    if (!(await this.syncControl.isEnabled(SERVICE))) {
      this.logger.debug('Automatic integration is disabled (master) — skipping');
      return;
    }
    await this.run('SCHEDULER');
  }

  /**
   * Starts an integration run for every enabled region. Safe to call manually.
   * Returns the regions actually started.
   */
  async run(createdBy = 'SCHEDULER'): Promise<string[]> {
    const regions = await this.activeRegions();
    const { startDate, endDate } = this.window();
    const started: string[] = [];

    for (const region of regions) {
      // Ensure the toggle exists (disabled) so a brand-new region never
      // auto-runs before an operator opts in.
      await this.syncControl.ensureControl(SERVICE, region, {
        displayName: `Automatic Integration — ${region}`,
        description: `Auto-runs the full integration cycle for ${region} on schedule.`,
        enabled: false,
      });
      if (!(await this.syncControl.isEnabled(SERVICE, region))) continue;

      try {
        await this.integrationRun.startRun({
          region,
          startDate,
          endDate,
          createdBy,
        });
        started.push(region);
        this.logger.log(
          `[${region}] automatic integration started for ${startDate} → ${endDate}`,
        );
      } catch (err) {
        // "already in progress", no credentials, etc. — never block other regions.
        this.logger.warn(
          `[${region}] automatic integration not started: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (started.length > 0) {
      this.logger.log(
        `Automatic integration triggered for ${started.length} region(s): ${started.join(', ')}`,
      );
    }
    return started;
  }

  private async activeRegions(): Promise<string[]> {
    const creds = await this.credentials.find({
      where: { active: true },
      select: { region: true },
    });
    return [
      ...new Set(
        creds
          .map((c) => c.region?.trim().toUpperCase())
          .filter((r): r is string => !!r && r.length > 0),
      ),
    ].sort();
  }

  private window(): { startDate: string; endDate: string } {
    const today = new Date();
    const endDate = today.toISOString().slice(0, 10);
    const start = new Date(today.getTime());
    start.setUTCDate(start.getUTCDate() - LOOKBACK_DAYS);
    return { startDate: start.toISOString().slice(0, 10), endDate };
  }
}
