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
import { PrismaService } from '../prisma/prisma.service';
import { OdooBackupService } from './odoo-backup.service';

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
  @ApiOperation({ summary: 'Get a backed-up Odoo order with lines and payments' })
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
}
