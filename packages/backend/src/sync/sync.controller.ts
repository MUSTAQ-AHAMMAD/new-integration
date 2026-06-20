import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { parseLimit } from '../common/parse-limit';
import { IbqBackupService } from '../ibq-backup/ibq-backup.service';
import { OdooBackupService } from '../odoo-backup/odoo-backup.service';
import { CreateSyncJobDto } from './dto/create-sync-job.dto';
import { OrderSyncService } from './order-sync.service';
import { SyncService } from './sync.service';

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly orderSyncService: OrderSyncService,
    private readonly odooBackupService: OdooBackupService,
    private readonly ibqBackupService: IbqBackupService,
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

  @Post('fetch-odoo')
  @ApiOperation({
    summary: 'Manually pull orders from Odoo, persist raw backup, and ingest them into the sync queue',
  })
  async fetchOdooOrders(
    @Body()
    body: {
      branchId?: number;
      startDate?: string;
      endDate?: string;
      limit?: number;
    },
  ) {
    // Step 1: fetch from Odoo and persist raw data to backup tables so the
    // data is never lost even if the ingestion step fails.
    const { orders, saved: backedUp, skipped: backupSkipped } =
      await this.odooBackupService.backupOrders({
        branchId: body.branchId,
        startDate: body.startDate,
        endDate: body.endDate,
        limit: body.limit ?? 100,
      });

    // Step 2: ingest each backed-up order into the sync queue.
    let ingested = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const order of orders) {
      try {
        const branchRaw = order.branch_id;
        const branchCode =
          Array.isArray(branchRaw)
            ? String(branchRaw[0])
            : branchRaw !== undefined
              ? String(branchRaw)
              : null;

        // Skip orders that carry no branch information — they cannot be
        // mapped to a store configuration or routed to Oracle correctly.
        if (!branchCode) {
          skipped++;
          errors.push(`Order ${String(order.name ?? order.id)} skipped: missing branch_id`);
          continue;
        }

        const amountTotal = Number(order.amount_total ?? 0);
        const state = typeof order.state === 'string' ? order.state : 'draft';

        // Use the timezone carried on the order when available; fall back to
        // the Odoo default which is typically the Dubai (Gulf Standard) zone.
        const orderTimezone =
          typeof order.timezone === 'string' && order.timezone
            ? order.timezone
            : 'Asia/Dubai';

        await this.orderSyncService.ingestOrder({
          odooOrderId: String(order.id),
          odooOrderNumber: String(order.name ?? order.id),
          branchCode,
          orderDate: order.date_order
            ? new Date(order.date_order)
            : new Date(),
          originalTimezone: orderTimezone,
          totalAmount: amountTotal,
          isPaid: ['paid', 'done', 'posted'].includes(state),
          isCancelled: state === 'cancel',
          isRefund: amountTotal < 0,
        });
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
    summary: 'Manually pull orders from IBQ, persist raw backup, and ingest them into the sync queue',
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
    const { orders, saved: backedUp, skipped: backupSkipped } =
      await this.ibqBackupService.backupOrders(body.credentialId, {
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
        const branchRaw = order.branch_id;
        const branchCode =
          Array.isArray(branchRaw)
            ? String(branchRaw[0])
            : branchRaw !== undefined && branchRaw !== null
              ? String(branchRaw)
              : null;

        if (!branchCode) {
          skipped++;
          errors.push(`Order ${String(order.name ?? order.id)} skipped: missing branch_id`);
          continue;
        }

        const amountTotal = Number(order.amount_total ?? 0);
        const state = typeof order.state === 'string' ? order.state : 'draft';

        await this.orderSyncService.ingestOrder({
          odooOrderId: String(order.id),
          odooOrderNumber: String(order.name ?? order.id),
          branchCode,
          orderDate: order.date_order ? new Date(order.date_order) : new Date(),
          originalTimezone: 'Asia/Dubai',
          totalAmount: amountTotal,
          isPaid: ['paid', 'done', 'posted'].includes(state),
          isCancelled: state === 'cancel',
          isRefund: amountTotal < 0,
        });
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
}
