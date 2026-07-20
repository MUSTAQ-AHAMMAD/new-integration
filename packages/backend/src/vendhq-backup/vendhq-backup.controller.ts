import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqSalesBackupService } from './vendhq-backup.service';
import { VendHqToOracleSyncService } from './vendhq-to-oracle-sync.service';

@ApiTags('vendhq-backup')
@Controller('vendhq-backup')
export class VendHqBackupController {
  constructor(
    private readonly backupService: VendHqSalesBackupService,
    private readonly oracleSyncService: VendHqToOracleSyncService,
    @InjectRepository(VendHqCredential)
    private readonly credentials: Repository<VendHqCredential>,
  ) {}

  /**
   * Manually trigger a full sales backup for all active credentials.
   * Mirrors the Java "triggerSalesJobNow" button in the ADF scheduler UI.
   */
  @Post('trigger')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually trigger VendHQ sales backup for all regions',
  })
  async triggerAll() {
    await this.backupService.runBackupJob();
    return { ok: true, message: 'Backup triggered for all active credentials' };
  }

  /**
   * Manually trigger backup for a single credential (by credential id).
   */
  @Post('trigger/:credentialId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger VendHQ sales backup for a specific credential',
  })
  async triggerOne(@Param('credentialId') credentialId: string) {
    const cred = await this.credentials.findOne({
      where: { id: credentialId },
    });
    if (!cred || !cred.active) {
      return {
        ok: false,
        message: `Credential ${credentialId} not found or inactive`,
      };
    }
    const result = await this.backupService.backupRegion(cred);
    return { ok: true, ...result };
  }

  /**
   * Manually trigger backup for all active credentials in a named region.
   */
  @Post('trigger-region/:region')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger VendHQ sales backup for all credentials in a region',
  })
  async triggerByRegion(@Param('region') region: string) {
    const creds = await this.credentials.find({
      where: { region, active: true },
    });
    if (creds.length === 0) {
      return {
        ok: false,
        message: `No active credentials found for region: ${region}`,
      };
    }
    const results = await Promise.all(
      creds.map(async (cred) => {
        try {
          const result = await this.backupService.backupRegion(cred);
          return { credentialId: cred.id, ok: true, ...result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { credentialId: cred.id, ok: false, error: message };
        }
      }),
    );
    const allFailed = results.every((r) => !r.ok);
    return { ok: !allFailed, region, triggered: results.length, results };
  }

  /**
   * List all available regions (from active credentials).
   */
  @Get('regions')
  @ApiOperation({
    summary: 'List all regions that have active VendHQ credentials',
  })
  async listRegions() {
    const creds = await this.credentials.find({
      where: { active: true },
      select: {
        id: true,
        region: true,
        domainName: true,
        lastSyncAt: true,
        lastSyncVersion: true,
      },
      order: { region: 'ASC' },
    });
    return creds;
  }

  // ── Region-level integration control ─────────────────────────────────────

  /**
   * Get the current integration status and last-sync metadata for a region.
   */
  @Get('region/:region/status')
  @ApiOperation({
    summary: 'Get integration status and last sync info for a region',
  })
  async getRegionStatus(@Param('region') region: string) {
    return this.backupService.getRegionStatus(region);
  }

  /**
   * Start (enable) the integration for a specific region.
   * The next scheduled cron run will include this region again.
   */
  @Post('region/:region/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable VendHQ backup integration for a region' })
  async startRegion(@Param('region') region: string) {
    return this.backupService.enableRegion(region);
  }

  /**
   * Stop (disable) the integration for a specific region.
   * The scheduled cron will skip this region until it is re-enabled.
   */
  @Post('region/:region/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable VendHQ backup integration for a region' })
  async stopRegion(@Param('region') region: string) {
    return this.backupService.disableRegion(region);
  }

  // ── VendHQ → Oracle Fusion sync ───────────────────────────────────────────

  /**
   * Manually trigger the VendHQ→Oracle Fusion sync for all pending sales
   * across all regions.
   */
  @Post('sync-to-oracle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Push all pending VendHQ backup sales to Oracle Fusion',
  })
  async syncToOracleAll() {
    const result = await this.oracleSyncService.runSyncJob();
    return { ok: true, ...result };
  }

  /**
   * Manually trigger the VendHQ→Oracle Fusion sync for a specific region.
   */
  @Post('sync-to-oracle/:region')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Push pending VendHQ backup sales for a specific region to Oracle Fusion',
  })
  async syncToOracleByRegion(@Param('region') region: string) {
    const result = await this.oracleSyncService.runSyncJob(region);
    return { ok: true, region, ...result };
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  /**
   * Trace a single VendHQ sale end-to-end through the Fusion pipeline for
   * debugging. Fetches the backup sale by invoice number, validates its items
   * against VendHqItemMeta, transforms it to Fusion payloads and (optionally)
   * pushes it to Oracle, logging every step. By default this is a dry run and
   * does NOT push to Oracle; pass `?dryRun=false` to attempt the push.
   */
  @Get('diagnostics/trace/:region/:invoiceNumber')
  @ApiOperation({
    summary:
      'Trace a single VendHQ sale through the Fusion pipeline (item fetch → validate → transform → push)',
  })
  async traceSale(
    @Param('region') region: string,
    @Param('invoiceNumber') invoiceNumber: string,
    @Query('dryRun') dryRun?: string,
  ) {
    // Dry run is the safe default; only an explicit falsy value enables the push.
    const isDryRun = !['false', '0', 'no'].includes(
      (dryRun ?? '').trim().toLowerCase(),
    );
    const report = await this.oracleSyncService.traceSale(
      invoiceNumber,
      region,
      { dryRun: isDryRun },
    );
    return { ok: report.sale.found, report };
  }
}
