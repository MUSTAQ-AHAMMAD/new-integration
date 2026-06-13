import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { VendHqSalesBackupService } from './vendhq-backup.service';

@ApiTags('vendhq-backup')
@Controller('vendhq-backup')
export class VendHqBackupController {
  constructor(
    private readonly backupService: VendHqSalesBackupService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Manually trigger a full sales backup for all active credentials.
   * Mirrors the Java "triggerSalesJobNow" button in the ADF scheduler UI.
   */
  @Post('trigger')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually trigger VendHQ sales backup for all regions' })
  async triggerAll() {
    await this.backupService.runBackupJob();
    return { ok: true, message: 'Backup triggered for all active credentials' };
  }

  /**
   * Manually trigger backup for a single credential (by credential id).
   */
  @Post('trigger/:credentialId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger VendHQ sales backup for a specific credential' })
  async triggerOne(@Param('credentialId') credentialId: string) {
    const cred = await this.prisma.vendHqCredential.findUnique({
      where: { id: credentialId },
    });
    if (!cred || !cred.active) {
      return { ok: false, message: `Credential ${credentialId} not found or inactive` };
    }
    const result = await this.backupService.backupRegion(cred);
    return { ok: true, ...result };
  }

  /**
   * Manually trigger backup for all active credentials in a named region.
   */
  @Post('trigger-region/:region')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger VendHQ sales backup for all credentials in a region' })
  async triggerByRegion(@Param('region') region: string) {
    const creds = await this.prisma.vendHqCredential.findMany({
      where: { region, active: true },
    });
    if (creds.length === 0) {
      return { ok: false, message: `No active credentials found for region: ${region}` };
    }
    const results = await Promise.all(
      creds.map((cred) => this.backupService.backupRegion(cred)),
    );
    return { ok: true, region, triggered: results.length, results };
  }

  /**
   * List all available regions (from active credentials).
   */
  @Get('regions')
  @ApiOperation({ summary: 'List all regions that have active VendHQ credentials' })
  async listRegions() {
    const creds = await this.prisma.vendHqCredential.findMany({
      where: { active: true },
      select: { id: true, region: true, domainName: true },
      orderBy: { region: 'asc' },
    });
    return creds;
  }
}
