import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  extractBranchCode,
  normalizeOrderForIngestion,
} from '../common/odoo-utils';
import { parseLimit } from '../common/parse-limit';
import { IbqBackupService } from '../ibq-backup/ibq-backup.service';
import { OdooBackupService } from '../odoo-backup/odoo-backup.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSyncJobDto } from './dto/create-sync-job.dto';
import { OrderDiagnosticsService } from './order-diagnostics.service';
import { OrderSyncService } from './order-sync.service';
import { SyncService } from './sync.service';
import { AutoFixService } from './auto-fix.service';

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly orderSyncService: OrderSyncService,
    private readonly odooBackupService: OdooBackupService,
    private readonly ibqBackupService: IbqBackupService,
    private readonly prisma: PrismaService,
    private readonly diagnosticsService: OrderDiagnosticsService,
    private readonly autoFixService: AutoFixService,
  ) {}

  @Post('jobs')
  @ApiOperation({ summary: 'Create a new sync job (selective sync)' })
  createJob(@Body() dto: CreateSyncJobDto) {
    return this.syncService.createSyncJob(dto);
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List all sync jobs' })
  listJobs(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.syncService.listSyncJobs(status, parseLimit(limit, 50));
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Get sync job details' })
  getJob(@Param('id') id: string) {
    return this.syncService.getSyncJob(id);
  }

  @Post('jobs/:id/cancel')
  @ApiOperation({ summary: 'Cancel a pending sync job' })
  cancelJob(@Param('id') id: string) {
    return this.syncService.cancelSyncJob(id);
  }

  @Post('jobs/:id/retry')
  @ApiOperation({ summary: 'Retry a failed sync job' })
  retryJob(@Param('id') id: string) {
    return this.syncService.retrySyncJob(id);
  }

  @Get('queue/stats')
  @ApiOperation({ summary: 'Get queue statistics' })
  queueStats() {
    return this.syncService.getQueueStats();
  }

  @Post('failed-transactions/:id/resolve')
  @ApiOperation({ summary: 'Resolve a failed transaction' })
  resolveFailedTransaction(
    @Param('id') id: string,
    @Body() body: { resolvedBy: string; resolutionNote?: string },
  ) {
    return this.syncService.resolveFailedTransaction(
      id,
      body.resolvedBy,
      body.resolutionNote,
    );
  }

  @Get('failed-transactions')
  @ApiOperation({ summary: 'List unresolved failed transactions' })
  listFailedTransactions(@Query('limit') limit?: string) {
    return this.syncService.listFailedTransactions(parseLimit(limit, 50));
  }

  @Get('failed-transactions/export-csv')
  @ApiOperation({ summary: 'Export failed transactions to CSV' })
  async exportFailedTransactionsCSV() {
    return this.syncService.exportFailedTransactionsCSV();
  }

  @Get('failed-orders')
  @ApiOperation({ summary: 'List failed orders with details' })
  async listFailedOrders(@Query('limit') limit?: string) {
    return this.syncService.listFailedOrders(parseLimit(limit, 100));
  }

  @Post('retry-all-failed')
  @ApiOperation({ summary: 'Retry all failed orders' })
  async retryAllFailedOrders() {
    return this.syncService.retryAllFailedOrders();
  }

  @Get('order-queue')
  @ApiOperation({
    summary: 'List OrderSyncQueue entries (individual ingested orders)',
  })
  listOrderQueue(
    @Query('status') status?: string,
    @Query('branchCode') branchCode?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.syncService.listOrderQueue({
      status,
      branchCode,
      search,
      limit: parseLimit(limit, 200),
    });
  }

  @Post('order-queue/:id/retry')
  @ApiOperation({
    summary: 'Re-queue a single OrderSyncQueue entry for processing',
  })
  retryOrderQueueEntry(@Param('id') id: string) {
    return this.syncService.retryOrderQueueEntry(id);
  }

  @Get('orders/:odooOrderId')
  @ApiOperation({ summary: 'Get sync status for specific order' })
  getOrderStatus(@Param('odooOrderId') odooOrderId: string) {
    return this.syncService.getOrderStatus(odooOrderId);
  }

  @Post('orders/retry-negative-inventory')
  @ApiOperation({
    summary:
      'Re-queue orders held for negative inventory (call after Finance corrects stock)',
  })
  retryNegativeInventoryOrders(@Query('branchCode') branchCode?: string) {
    return this.orderSyncService.retryNegativeInventoryOrders(branchCode);
  }

  @Post('orders/retry-skipped')
  @ApiOperation({
    summary:
      'Re-process orders that were previously skipped but should now be synced (useful after expanding state mapping)',
  })
  retrySkippedOrders(
    @Query('branchCode') branchCode?: string,
    @Query('limit') limit?: string,
  ) {
    return this.syncService.retrySkippedOrders(
      branchCode,
      parseLimit(limit, 1000),
    );
  }

  @Post('fetch-odoo')
  @ApiOperation({
    summary:
      'Manually pull orders from Odoo, persist raw backup, and ingest them into the sync queue',
  })
  async fetchOdooOrders(
    @Body()
    body: {
      credentialId?: string;
      branchId?: number;
      startDate?: string;
      endDate?: string;
      limit?: number;
    },
  ) {
    let orders: import('../clients/odoo/odoo.client').OdooOrder[];
    let backedUp: number;
    let backupSkipped: number;

    if (body.credentialId) {
      // Per-region credential path: use the stored baseUrl/apiKey.
      const cred = await this.prisma.odooCredential.findUnique({
        where: { id: body.credentialId },
      });
      if (!cred) {
        throw new NotFoundException(
          `Odoo credential not found: ${body.credentialId}`,
        );
      }
      ({
        orders,
        saved: backedUp,
        skipped: backupSkipped,
      } = await this.odooBackupService.backupOrdersForCredential(cred, {
        branchId: body.branchId,
        startDate: body.startDate,
        endDate: body.endDate,
        limit: body.limit,
      }));
    } else {
      // Legacy path: use the global ODOO_BASE_URL / ODOO_API_KEY env vars.
      ({
        orders,
        saved: backedUp,
        skipped: backupSkipped,
      } = await this.odooBackupService.backupOrders({
        branchId: body.branchId,
        startDate: body.startDate,
        endDate: body.endDate,
        limit: body.limit,
      }));
    }

    // Step 2: ingest each backed-up order into the sync queue.
    let ingested = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const order of orders) {
      try {
        // Use normalizeOrderForIngestion which handles comprehensive payment detection
        // with 22+ paid states and payment data fallback
        const payload = normalizeOrderForIngestion(order);

        if (!payload) {
          skipped++;
          errors.push(
            `Order ${String(order.name ?? order.id)} skipped: missing branch_id`,
          );
          continue;
        }

        await this.orderSyncService.ingestOrder(payload);
        ingested++;
      } catch (err) {
        skipped++;
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return {
      ok: true,
      fetched: orders.length,
      backedUp,
      backupSkipped,
      ingested,
      skipped,
      errors,
    };
  }

  @Post('fetch-ibq')
  @ApiOperation({
    summary:
      'Manually pull orders from IBQ, persist raw backup, and ingest them into the sync queue',
  })
  async fetchIbqOrders(
    @Body()
    body: {
      credentialId: string;
      startDate?: string;
      endDate?: string;
      branchId?: number;
      companyId?: number;
      limit?: number;
    },
  ) {
    // Step 1: fetch from IBQ and persist raw data to backup tables.
    const {
      orders,
      saved: backedUp,
      skipped: backupSkipped,
    } = await this.ibqBackupService.backupOrders(body.credentialId, {
      startDate: body.startDate,
      endDate: body.endDate,
      branchId: body.branchId,
      companyId: body.companyId,
      limit: body.limit ?? 100,
    });

    // Step 2: ingest each backed-up order into the sync queue.
    let ingested = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const order of orders) {
      try {
        // Use normalizeOrderForIngestion which handles branch_id extraction.
        // For IBQ instances that don't set branch_id, fall back to config_id
        // (the POS configuration / terminal id) as the branch code so orders
        // are not silently skipped by the ingestion step.
        const payload = normalizeOrderForIngestion(
          {
            ...order,
            branch_id: order.branch_id ?? order.config_id ?? null,
          },
          'Asia/Dubai',
        );

        if (!payload) {
          skipped++;
          errors.push(
            `Order ${String(order.name ?? order.pos_reference ?? order.id)} skipped: ` +
              `no branch_id or config_id available for routing`,
          );
          continue;
        }

        await this.orderSyncService.ingestOrder(payload);
        ingested++;
      } catch (err) {
        skipped++;
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return {
      ok: true,
      fetched: orders.length,
      backedUp,
      backupSkipped,
      ingested,
      skipped,
      errors,
    };
  }

  @Get('orders/:odooOrderId/diagnose')
  @ApiOperation({
    summary:
      'Diagnose why a specific order is not syncing to Oracle - provides detailed analysis and recommendations',
  })
  diagnoseOrder(
    @Param('odooOrderId') odooOrderId: string,
    @Query('branchCode') branchCode?: string,
  ) {
    return this.diagnosticsService.diagnoseOrder(odooOrderId, branchCode);
  }

  @Get('diagnostics/summary')
  @ApiOperation({
    summary:
      'Get summary statistics of order sync status to identify common issues',
  })
  getDiagnosticsSummary() {
    return this.diagnosticsService.getOrderStatsSummary();
  }

  @Post('auto-fix/skipped-orders')
  @ApiOperation({
    summary:
      'Automatically diagnose and fix skipped orders - will re-queue orders that should be synced',
  })
  autoFixSkippedOrders(
    @Query('odooOrderId') odooOrderId?: string,
    @Query('branchCode') branchCode?: string,
    @Query('limit') limit?: string,
  ) {
    return this.autoFixService.autoFixSkippedOrders(
      odooOrderId,
      branchCode,
      parseLimit(limit, 100),
    );
  }

  @Get('auto-fix/suggest-states')
  @ApiOperation({
    summary:
      'Suggest order states that might need to be added to PAID_ORDER_STATES based on skipped orders',
  })
  suggestStatesToAdd() {
    return this.autoFixService.suggestStatesToAdd();
  }
}
