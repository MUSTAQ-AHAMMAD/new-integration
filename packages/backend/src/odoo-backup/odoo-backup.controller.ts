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
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUrl } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('odoo-backup')
@Controller('odoo-backup')
export class OdooBackupController {
  constructor(
    private readonly backupService: OdooBackupService,
    private readonly prisma: PrismaService,
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
    return this.prisma.backupOdooOrder.findMany({
      orderBy: { createdAt: 'desc' },
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
    return this.prisma.backupOdooOrder.findUnique({
      where: { id },
      include: { orderLines: true, orderPayments: true },
    });
  }

  /**
   * Get the current backup watermark state.
   */
  @Get('state')
  @ApiOperation({ summary: 'Get the Odoo backup watermark state' })
  async getState() {
    const state = await this.prisma.odooBackupState.findUnique({
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
    const creds = await this.prisma.odooCredential.findMany({
      orderBy: { region: 'asc' },
    });
    return creds.map((c) => ({ ...c, apiKey: this.maskKey(c.apiKey) }));
  }

  /**
   * Create a new per-region Odoo credential.
   */
  @Post('credentials')
  @ApiOperation({ summary: 'Create a new per-region Odoo credential' })
  async createCredential(@Body() dto: CreateOdooCredentialDto) {
    const cred = await this.prisma.odooCredential.create({
      data: {
        baseUrl: dto.baseUrl,
        apiKey: dto.apiKey,
        region: dto.region,
        active: dto.active ?? true,
        ...(dto.apiPath !== undefined && { apiPath: dto.apiPath }),
      },
    });
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
    const cred = await this.prisma.odooCredential.update({
      where: { id },
      data: {
        ...(dto.baseUrl !== undefined && { baseUrl: dto.baseUrl }),
        ...(dto.apiKey !== undefined && { apiKey: dto.apiKey }),
        ...(dto.region !== undefined && { region: dto.region }),
        ...(dto.apiPath !== undefined && { apiPath: dto.apiPath }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    });
    return { ...cred, apiKey: this.maskKey(cred.apiKey) };
  }

  /**
   * Delete an Odoo credential.
   */
  @Delete('credentials/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an Odoo credential' })
  async deleteCredential(@Param('id') id: string) {
    await this.prisma.odooCredential.delete({ where: { id } });
    return { ok: true, id };
  }

  // ---------------------------------------------------------------------------

  private maskKey(key: string): string {
    if (key.length <= 8) return '*'.repeat(key.length);
    return `${'*'.repeat(key.length - 4)}${key.slice(-4)}`;
  }
}
