import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Min,
} from 'class-validator';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { OdooBackupState } from '../database/entities/odoo-backup-state.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { OdooBackupService } from './odoo-backup.service';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export class CreateOdooCredentialDto {
  @ApiProperty({
    description:
      'Base URL of the Odoo instance, e.g. https://mycompany.odoo.com',
  })
  @IsUrl({ require_tld: false })
  baseUrl!: string;

  @ApiProperty({ description: 'API key sent as x-api-key header' })
  @IsString()
  apiKey!: string;

  @ApiProperty({ description: 'Region identifier, e.g. AE, SA, KW' })
  @IsString()
  region!: string;

  @ApiProperty({
    required: false,
    description:
      'REST endpoint path used to fetch orders. Defaults to /api/pos/order (Odoo POS REST API). ' +
      'Set to /api/sale.order (Odoo sale-order REST API) for instances that serve sale orders ' +
      'instead of POS orders, or supply any other path required by the instance.',
  })
  @IsOptional()
  @IsString()
  apiPath?: string;

  @ApiProperty({
    required: false,
    default: true,
    description:
      'When false, TLS certificate verification is disabled for this credential. ' +
      'Use only for dev/staging Odoo instances whose hostname does not match the ' +
      'server certificate (e.g. *.dev.odoo.com vs a *.odoo.com cert). ' +
      'Always keep true for production.',
  })
  @IsOptional()
  @IsBoolean()
  rejectUnauthorizedSsl?: boolean;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateOdooCredentialDto {
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
  @IsString()
  region?: string;

  @ApiProperty({
    required: false,
    description:
      'REST endpoint path used to fetch orders. Defaults to /api/pos/order (Odoo POS REST API). ' +
      'Set to /api/sale.order (Odoo sale-order REST API) for instances that serve sale orders ' +
      'instead of POS orders, or supply any other path required by the instance.',
  })
  @IsOptional()
  @IsString()
  apiPath?: string;

  @ApiProperty({
    required: false,
    description:
      'When false, TLS certificate verification is disabled for this credential. ' +
      'Use only for dev/staging Odoo instances whose hostname does not match the ' +
      'server certificate (e.g. *.dev.odoo.com vs a *.odoo.com cert). ' +
      'Always keep true for production.',
  })
  @IsOptional()
  @IsBoolean()
  rejectUnauthorizedSsl?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ReingestFromBackupDto {
  @ApiProperty({
    required: false,
    description:
      'Start date filter (ISO 8601). Only orders on or after this date will be re-ingested.',
  })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiProperty({
    required: false,
    description:
      'End date filter (ISO 8601). Only orders on or before this date will be re-ingested.',
  })
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiProperty({
    required: false,
    description:
      'Filter by order state (e.g., "paid", "done", "posted"). Case-sensitive.',
  })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiProperty({
    required: false,
    description: 'Filter by region (e.g., "AE", "KW", "SA").',
  })
  @IsOptional()
  @IsString()
  region?: string;

  @ApiProperty({
    required: false,
    description:
      'Maximum number of orders to re-ingest. Defaults to 1000 to avoid memory issues.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('odoo-backup')
@Controller('odoo-backup')
export class OdooBackupController {
  constructor(
    private readonly backupService: OdooBackupService,
    @InjectRepository(BackupOdooOrder)
    private readonly orders: Repository<BackupOdooOrder>,
    @InjectRepository(OdooBackupState)
    private readonly backupState: Repository<OdooBackupState>,
    @InjectRepository(OdooCredential)
    private readonly credentials: Repository<OdooCredential>,
  ) {}

  /**
   * Manually trigger an Odoo backup run (uses the lastSyncAt watermark).
   */
  @Post('trigger')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually trigger the Odoo order backup job' })
  async triggerBackup() {
    await this.backupService.runBackupJob();
    return { ok: true, message: 'Odoo backup triggered' };
  }

  /**
   * List the most recent backed-up Odoo orders (latest 100).
   */
  @Get('orders')
  @ApiOperation({ summary: 'List recent backed-up Odoo orders' })
  async listOrders(@Query('limit') limit?: string) {
    const parsed = parseInt(limit ?? '100', 10);
    const take = Math.min(isNaN(parsed) ? 100 : parsed, 500);
    return this.orders.find({
      order: { createdAt: 'DESC' },
      take,
      select: {
        id: true,
        orderId: true,
        orderName: true,
        branchId: true,
        branchName: true,
        dateOrder: true,
        amountTotal: true,
        amountTax: true,
        state: true,
        timezone: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Get a single backed-up Odoo order with its lines and payments.
   */
  @Get('orders/:id')
  @ApiOperation({
    summary: 'Get a backed-up Odoo order with lines and payments',
  })
  async getOrder(@Param('id') id: string) {
    return this.orders.findOne({
      where: { id },
      relations: { orderLines: true, orderPayments: true },
    });
  }

  /**
   * Get the current backup watermark state.
   */
  @Get('state')
  @ApiOperation({ summary: 'Get the Odoo backup watermark state' })
  async getState() {
    const state = await this.backupState.findOne({
      where: { source: 'default' },
    });
    return state ?? { source: 'default', lastSyncAt: null };
  }

  // ── Per-region Odoo Credential CRUD ─────────────────────────────────────

  /**
   * List all Odoo credentials (API keys are masked).
   */
  @Get('credentials')
  @ApiOperation({ summary: 'List all per-region Odoo credentials' })
  async listCredentials() {
    const creds = await this.credentials.find({
      order: { region: 'ASC' },
    });
    return creds.map((c) => ({ ...c, apiKey: this.maskKey(c.apiKey) }));
  }

  /**
   * Create a new per-region Odoo credential.
   */
  @Post('credentials')
  @ApiOperation({ summary: 'Create a new per-region Odoo credential' })
  async createCredential(@Body() dto: CreateOdooCredentialDto) {
    const cred = await this.credentials.save(
      this.credentials.create({
        baseUrl: dto.baseUrl,
        apiKey: dto.apiKey,
        region: dto.region,
        active: dto.active ?? true,
        ...(dto.apiPath !== undefined && { apiPath: dto.apiPath }),
        ...(dto.rejectUnauthorizedSsl !== undefined && {
          rejectUnauthorizedSsl: dto.rejectUnauthorizedSsl,
        }),
      }),
    );
    return { ...cred, apiKey: this.maskKey(cred.apiKey) };
  }

  /**
   * Update an existing Odoo credential.
   */
  @Put('credentials/:id')
  @ApiOperation({ summary: 'Update an Odoo credential' })
  async updateCredential(
    @Param('id') id: string,
    @Body() dto: UpdateOdooCredentialDto,
  ) {
    await this.credentials.update(
      { id },
      {
        ...(dto.baseUrl !== undefined && { baseUrl: dto.baseUrl }),
        ...(dto.apiKey !== undefined && { apiKey: dto.apiKey }),
        ...(dto.region !== undefined && { region: dto.region }),
        ...(dto.apiPath !== undefined && { apiPath: dto.apiPath }),
        ...(dto.active !== undefined && { active: dto.active }),
        ...(dto.rejectUnauthorizedSsl !== undefined && {
          rejectUnauthorizedSsl: dto.rejectUnauthorizedSsl,
        }),
      },
    );
    const cred = await this.credentials.findOne({ where: { id } });
    return cred ? { ...cred, apiKey: this.maskKey(cred.apiKey) } : { id };
  }

  /**
   * Delete an Odoo credential.
   */
  @Delete('credentials/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an Odoo credential' })
  async deleteCredential(@Param('id') id: string) {
    await this.credentials.delete({ id });
    return { ok: true, id };
  }

  /**
   * Probe a credential by making a lightweight request (limit=1) to the
   * configured endpoint.  Returns diagnostic info — status code, body snippet,
   * and how many orders were parsed — so operators can verify their configuration
   * without running a full backup.  Always returns HTTP 200; the inner `ok`
   * field indicates whether the Odoo request itself succeeded.
   */
  @Post('credentials/:id/probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Test an Odoo credential by probing its configured endpoint (limit=1)',
  })
  async probeCredential(@Param('id') id: string) {
    const cred = await this.credentials.findOne({ where: { id } });
    if (!cred) {
      throw new NotFoundException(`Odoo credential not found: ${id}`);
    }
    return this.backupService.probeCredential(cred);
  }

  /**
   * Live reconciliation: compare the Odoo API's order count for a region + date
   * range against the count stored in the backup tables. Read-only — a single
   * lightweight request, no re-pull. Best for live regions (e.g. SN); expired
   * Odoo tenants will report apiReachable=false.
   */
  @Get('reconcile')
  @ApiOperation({
    summary:
      'Compare live Odoo order count vs stored backup count for a region + date range',
  })
  async reconcile(
    @Query('region') region?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const reg = (region ?? '').trim().toUpperCase();
    if (!reg) throw new BadRequestException('region is required');
    if (
      !startDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !endDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
    ) {
      throw new BadRequestException(
        'startDate and endDate are required as YYYY-MM-DD',
      );
    }
    const cred = await this.credentials.findOne({
      where: { region: reg, active: true },
    });
    if (!cred) {
      throw new BadRequestException(
        `No active Odoo credential for region ${reg}`,
      );
    }

    const probe = await this.backupService.reconcileForCredential(cred, {
      startDate,
      endDate,
    });
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);
    const storedCount = await this.orders.count({
      where: { region: reg, dateOrder: Between(start, end) },
    });
    const apiTotal = probe.apiTotal;
    return {
      region: reg,
      startDate,
      endDate,
      apiReachable: probe.ok,
      apiTotal,
      storedCount,
      difference: apiTotal != null ? apiTotal - storedCount : null,
      inSync: apiTotal != null ? apiTotal === storedCount : null,
      note:
        apiTotal == null
          ? probe.ok
            ? 'The Odoo endpoint did not advertise a total count for this range — an exact check would need a full live fetch.'
            : `Odoo API not reachable: ${probe.error ?? 'unknown error'}`
          : null,
      probe: {
        url: probe.url,
        status: probe.status,
        sampleCount: probe.sampleCount,
        error: probe.error,
      },
    };
  }

  /**
   * Re-ingest orders from the backup tables into the OrderSyncQueue without
   * re-fetching from the Odoo API. Useful for processing orders that were
   * backed up but never ingested, or re-processing orders after fixing branch
   * mappings or state mapping changes.
   */
  @Post('reingest-from-backup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Re-ingest orders from backup tables into OrderSyncQueue without re-fetching from Odoo API',
  })
  async reingestFromBackup(@Body() dto: ReingestFromBackupDto) {
    const result = await this.backupService.reingestFromBackup({
      startDate: dto.startDate,
      endDate: dto.endDate,
      state: dto.state,
      region: dto.region,
      limit: dto.limit,
    });
    return {
      ok: true,
      message: `Re-ingested ${result.ingested} orders from backup tables`,
      ...result,
    };
  }

  // ---------------------------------------------------------------------------

  private maskKey(key: string): string {
    if (key.length <= 8) return '*'.repeat(key.length);
    return `${'*'.repeat(key.length - 4)}${key.slice(-4)}`;
  }
}
