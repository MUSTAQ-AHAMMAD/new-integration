import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BackupIbqOrder } from '../database/entities/backup-ibq-order.entity';
import { IbqCredential } from '../database/entities/ibq-credential.entity';
import { IbqBackupService } from './ibq-backup.service';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export class CreateIbqCredentialDto {
  @ApiProperty({
    description:
      'Base URL of the IBQ Odoo instance, e.g. https://ibraqperfumes.odoo.com',
  })
  @IsUrl({ require_tld: false })
  baseUrl!: string;

  @ApiProperty({ description: 'API key sent as x-api-key header' })
  @IsString()
  apiKey!: string;

  @ApiProperty({ description: 'Odoo company_id filter', required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  companyId?: number;

  @ApiProperty({ description: 'Region identifier, e.g. SA, AE, KW' })
  @IsString()
  region!: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateIbqCredentialDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  companyId?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  region?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('ibq-backup')
@Controller('ibq-backup')
export class IbqBackupController {
  constructor(
    private readonly backupService: IbqBackupService,
    @InjectRepository(IbqCredential)
    private readonly credentials: Repository<IbqCredential>,
    @InjectRepository(BackupIbqOrder)
    private readonly orders: Repository<BackupIbqOrder>,
  ) {}

  // ── Trigger controls ───────────────────────────────────────────────────────

  /**
   * Manually trigger a full IBQ backup for all active credentials.
   */
  @Post('trigger')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually trigger IBQ POS backup for all active credentials',
  })
  async triggerAll() {
    await this.backupService.runBackupJob();
    return {
      ok: true,
      message: 'IBQ backup triggered for all active credentials',
    };
  }

  /**
   * Manually trigger backup for a single credential (by id).
   */
  @Post('trigger/:credentialId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger IBQ backup for a specific credential' })
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
    summary: 'Trigger IBQ backup for all credentials in a region',
  })
  async triggerByRegion(@Param('region') region: string) {
    const creds = await this.credentials.find({
      where: { region, active: true },
    });
    if (creds.length === 0) {
      return {
        ok: false,
        message: `No active IBQ credentials found for region: ${region}`,
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

  // ── Region status / enable / disable ──────────────────────────────────────

  /**
   * List all regions that have active IBQ credentials.
   */
  @Get('regions')
  @ApiOperation({ summary: 'List all regions with active IBQ credentials' })
  async listRegions() {
    return this.credentials.find({
      where: { active: true },
      select: {
        id: true,
        region: true,
        baseUrl: true,
        companyId: true,
        lastSyncAt: true,
      },
      order: { region: 'ASC' },
    });
  }

  /**
   * Get the current integration status and last-sync metadata for a region.
   */
  @Get('region/:region/status')
  @ApiOperation({
    summary: 'Get IBQ integration status and last-sync info for a region',
  })
  async getRegionStatus(@Param('region') region: string) {
    return this.backupService.getRegionStatus(region);
  }

  /**
   * Enable the IBQ backup integration for a region.
   */
  @Post('region/:region/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable IBQ backup integration for a region' })
  async startRegion(@Param('region') region: string) {
    return this.backupService.enableRegion(region);
  }

  /**
   * Disable the IBQ backup integration for a region.
   */
  @Post('region/:region/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable IBQ backup integration for a region' })
  async stopRegion(@Param('region') region: string) {
    return this.backupService.disableRegion(region);
  }

  // ── Credential CRUD ────────────────────────────────────────────────────────

  /**
   * List all IBQ credentials (API keys are masked in the response).
   */
  @Get('credentials')
  @ApiOperation({ summary: 'List all IBQ credentials' })
  async listCredentials() {
    const creds = await this.credentials.find({
      order: { region: 'ASC' },
    });
    return creds.map((c) => ({
      ...c,
      apiKey: this.maskKey(c.apiKey),
    }));
  }

  /**
   * Create a new IBQ credential.
   */
  @Post('credentials')
  @ApiOperation({ summary: 'Create a new IBQ credential' })
  async createCredential(@Body() dto: CreateIbqCredentialDto) {
    const cred = await this.credentials.save(
      this.credentials.create({
        baseUrl: dto.baseUrl,
        apiKey: dto.apiKey,
        companyId: dto.companyId ?? null,
        region: dto.region,
        active: dto.active ?? true,
      }),
    );
    return { ...cred, apiKey: this.maskKey(cred.apiKey) };
  }

  /**
   * Update an existing IBQ credential.
   */
  @Put('credentials/:id')
  @ApiOperation({ summary: 'Update an IBQ credential' })
  async updateCredential(
    @Param('id') id: string,
    @Body() dto: UpdateIbqCredentialDto,
  ) {
    await this.credentials.update(
      { id },
      {
        ...(dto.baseUrl !== undefined && { baseUrl: dto.baseUrl }),
        ...(dto.apiKey !== undefined && { apiKey: dto.apiKey }),
        ...(dto.companyId !== undefined && { companyId: dto.companyId }),
        ...(dto.region !== undefined && { region: dto.region }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    );
    const cred = await this.credentials.findOne({ where: { id } });
    return cred ? { ...cred, apiKey: this.maskKey(cred.apiKey) } : { id };
  }

  /**
   * Delete an IBQ credential.
   */
  @Delete('credentials/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an IBQ credential' })
  async deleteCredential(@Param('id') id: string) {
    await this.credentials.delete({ id });
    return { ok: true, id };
  }

  // ── Backed-up data inspection ──────────────────────────────────────────────

  /**
   * List recent backed-up IBQ orders for a region (latest 100).
   */
  @Get('orders/:region')
  @ApiOperation({ summary: 'List recent backed-up IBQ orders for a region' })
  async listOrders(@Param('region') region: string) {
    return this.orders.find({
      where: { region },
      order: { createdAt: 'DESC' },
      take: 100,
      select: {
        id: true,
        orderId: true,
        orderName: true,
        posReference: true,
        dateOrder: true,
        amountTotal: true,
        amountTax: true,
        state: true,
        companyName: true,
        posConfigName: true,
        createdAt: true,
      },
    });
  }

  // ---------------------------------------------------------------------------

  private maskKey(key: string): string {
    if (key.length <= 6) return '*'.repeat(key.length);
    return `${key.slice(0, 3)}${'*'.repeat(Math.max(4, key.length - 3))}`;
  }
}
