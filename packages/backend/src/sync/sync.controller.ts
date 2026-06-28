import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, SyncStatus } from '@prisma/client';
import {
  extractBranchCode,
  normalizeOrderForIngestion,
} from '../common/odoo-utils';
import { parseLimit } from '../common/parse-limit';
import { DateFormatUtil } from '../common/utils/date-format.util';
import { IbqBackupService } from '../ibq-backup/ibq-backup.service';
import { OdooBackupService } from '../odoo-backup/odoo-backup.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { CreateSyncJobDto } from './dto/create-sync-job.dto';
import { OrderListResponseDto, OrderResponseDto } from './dto/order-response.dto';
import { OrderDiagnosticsService } from './order-diagnostics.service';
import { OrderSyncService } from './order-sync.service';
import { OrderEnrichmentService } from './order-enrichment.service';
import { SyncService } from './sync.service';
import { AutoFixService } from './auto-fix.service';

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  constructor(
    private readonly syncService: SyncService,
    private readonly orderSyncService: OrderSyncService,
    private readonly odooBackupService: OdooBackupService,
    private readonly ibqBackupService: IbqBackupService,
    private readonly prisma: PrismaService,
    private readonly diagnosticsService: OrderDiagnosticsService,
    private readonly autoFixService: AutoFixService,
    private readonly queuesService: QueuesService,
    private readonly orderEnrichmentService: OrderEnrichmentService,
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

  /**
   * GET /sync/orders - List orders with proper date formatting
   * 
   * Fixes "[object Ob]" issue by ensuring all dates are formatted as ISO strings
   */
  @Get('orders')
  @ApiOperation({ 
    summary: 'List orders with proper date formatting',
    description: 'Returns orders from OrderSyncQueue with all dates formatted as ISO strings to fix UI display issues'
  })
  async getOrders(
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('status') status?: string,
    @Query('branchCode') branchCode?: string,
  ): Promise<OrderListResponseDto> {
    const skipNum = Number(skip || 0);
    const takeNum = Number(take || 20);

    // Build where clause
    const where: any = {};
    if (status) {
      where.status = status as SyncStatus;
    }
    if (branchCode) {
      where.branchCode = branchCode;
    }

    // Fetch orders
    const [orders, total] = await Promise.all([
      this.prisma.orderSyncQueue.findMany({
        where,
        skip: skipNum,
        take: takeNum,
        orderBy: { orderDate: 'desc' },
      }),
      this.prisma.orderSyncQueue.count({ where }),
    ]);

    // Return with proper date formatting via DTO
    return new OrderListResponseDto(orders, total, skipNum, takeNum);
  }

  /**
   * POST /sync/fix-all-failed - Bulk fix all failed orders
   * 
   * Resets failed orders to PENDING status and triggers sync
   */
  @Post('fix-all-failed')
  @ApiOperation({ 
    summary: 'Fix all failed orders',
    description: 'Resets all failed orders to PENDING status and triggers sync. Useful for bulk recovery after fixing issues.'
  })
  async fixAllFailedOrders() {
    this.logger.log('🔧 FIXING ALL FAILED ORDERS...');

    // Get all failed orders
    const failedOrders = await this.prisma.orderSyncQueue.findMany({
      where: {
        status: SyncStatus.FAILED,
        syncAttempts: { lt: 5 },
      },
    });

    this.logger.log(`Found ${failedOrders.length} failed orders`);

    const results = {
      total: failedOrders.length,
      reset: 0,
      requeued: 0,
      errors: [] as any[],
      orders: [] as any[],
    };

    for (const order of failedOrders) {
      try {
        // Reset order status to PENDING
        await this.prisma.orderSyncQueue.update({
          where: { id: order.id },
          data: {
            status: SyncStatus.PENDING,
            syncAttempts: 0,
            validationErrors: Prisma.JsonNull,
            lastSyncAt: null,
          },
        });

        results.reset++;
        results.orders.push({
          id: order.id,
          orderNumber: order.odooOrderNumber,
          branchCode: order.branchCode,
          status: 'RESET_TO_PENDING',
        });

        this.logger.log(`✅ Reset order ${order.id}: ${order.odooOrderNumber}`);

        // Re-queue for processing
        await this.queuesService.enqueueOrderSync({
          orderSyncQueueId: order.id,
          odooOrderId: order.odooOrderId,
          branchCode: order.branchCode,
        });
        
        results.requeued++;

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.errors.push({
          orderId: order.id,
          orderNumber: order.odooOrderNumber,
          error: errorMessage,
        });
        this.logger.error(`❌ Failed to reset order ${order.id}:`, errorMessage);
      }
    }

    this.logger.log(`✅ Fix completed: ${results.reset} reset, ${results.requeued} requeued`);

    return {
      message: 'Fix completed',
      results,
      nextStep: 'Orders reset to PENDING and re-queued. Sync will process automatically.',
    };
  }

  /**
   * Sync a specific order directly
   */
  @Post('sync-direct/:orderId')
  @ApiOperation({ 
    summary: 'Directly sync a specific order',
    description: 'Resets order to PENDING and immediately queues it for sync. Useful for testing.'
  })
  async syncOrderDirect(@Param('orderId') orderId: string) {
    this.logger.log(`Direct sync for order: ${orderId}`);

    const order = await this.prisma.orderSyncQueue.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    // Reset to PENDING
    await this.prisma.orderSyncQueue.update({
      where: { id: orderId },
      data: {
        status: SyncStatus.PENDING,
        syncAttempts: 0,
        validationErrors: Prisma.JsonNull,  // ✅ Fixed
      },
    });

    // Enqueue for sync
    await this.queuesService.enqueueOrderSync({
      orderSyncQueueId: order.id,
      odooOrderId: order.odooOrderId,
      branchCode: order.branchCode,
    });

    return {
      message: `Order ${orderId} queued for sync`,
      orderId: order.id,
      orderNumber: order.odooOrderNumber,
      status: 'PENDING',
    };
  }

  /**
   * Get order data with lines and payments
   */
  @Get('order-data/:orderSyncQueueId')
  @ApiOperation({
    summary: 'Get order data with lines and payments from backup tables',
    description: 'Retrieves order along with its line items and payments from BackupOdooOrder tables. Use this to verify data exists before enrichment.'
  })
  async getOrderData(@Param('orderSyncQueueId') orderSyncQueueId: string) {
    this.logger.log(`Getting order data for: ${orderSyncQueueId}`);

    const order = await this.prisma.orderSyncQueue.findUnique({
      where: { id: orderSyncQueueId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderSyncQueueId} not found`);
    }

    // Get backup order
    const backupOrder = await this.prisma.backupOdooOrder.findFirst({
      where: { 
        orderNumber: order.odooOrderNumber,
      },
    });

    // Get backup lines - use numeric orderId
    const backupLines = await this.prisma.backupOdooOrderLine.findMany({
      where: backupOrder 
        ? { orderId: backupOrder.orderId }
        : { orderId: 0 },
    });

    // Get backup payments - use numeric orderId
    const backupPayments = await this.prisma.backupOdooOrderPayment.findMany({
      where: backupOrder 
        ? { orderId: backupOrder.orderId }
        : { orderId: 0 },
    });

    return {
      order: {
        id: order.id,
        odooOrderId: order.odooOrderId,
        odooOrderNumber: order.odooOrderNumber,
        branchCode: order.branchCode,
        branchName: order.branchName,
        totalAmount: Number(order.totalAmount),
        currency: order.currency,
        status: order.status,
        syncAttempts: order.syncAttempts,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      },
      backupOrderFound: !!backupOrder,
      backupLines: {
        count: backupLines.length,
        data: backupLines.slice(0, 10),
      },
      backupPayments: {
        count: backupPayments.length,
        data: backupPayments.slice(0, 10),
      },
    };
  }

  /**
   * Test enrichment - Build Oracle payloads without sending to Oracle
   */
  @Post('test-enrich/:orderSyncQueueId')
  @ApiOperation({
    summary: 'Test order enrichment with backup table data',
    description: 'Runs enrichment on a specific order to verify that lines and payments are being fetched correctly from backup tables.'
  })
  async testEnrichOrder(@Param('orderSyncQueueId') orderSyncQueueId: string): Promise<any> {
    this.logger.log(`Testing enrichment for order: ${orderSyncQueueId}`);

    const order = await this.prisma.orderSyncQueue.findUnique({
      where: { id: orderSyncQueueId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderSyncQueueId} not found`);
    }

    // Get backup order
    const backupOrder = await this.prisma.backupOdooOrder.findFirst({
      where: { 
        orderNumber: order.odooOrderNumber,
      },
    });

    // Get backup lines - use numeric orderId
    const backupLines = await this.prisma.backupOdooOrderLine.findMany({
      where: backupOrder 
        ? { orderId: backupOrder.orderId }
        : { orderId: 0 },
    });

    // Get backup payments - use numeric orderId
    const backupPayments = await this.prisma.backupOdooOrderPayment.findMany({
      where: backupOrder 
        ? { orderId: backupOrder.orderId }
        : { orderId: 0 },
    });

    // Build enriched payloads
    const enriched = await this.orderEnrichmentService.enrichOrder(
      order.id,
      order.branchCode,
      order.region || order.branchCode,
    );

    return {
      success: true,
      orderId: order.id,
      orderNumber: order.odooOrderNumber,
      branchCode: order.branchCode,
      region: order.region || order.branchCode,
      totalAmount: Number(order.totalAmount),
      currency: order.currency,
      customerName: order.customerName,
      backupOrderFound: !!backupOrder,
      backupLinesCount: backupLines.length,
      backupPaymentsCount: backupPayments.length,
      enriched: {
        invoiceLines: enriched.invoiceHeader.invoiceLines.length,
        invoiceLinesData: enriched.invoiceHeader.invoiceLines.slice(0, 5),
        standardReceipts: enriched.standardReceipts.length,
        applyReceipts: enriched.applyReceipts.length,
        miscReceipts: enriched.miscReceipts.length,
        journalHeaders: enriched.journalHeaders.length,
      },
      payload: enriched, // Full payload for inspection
    };
  }

  /**
   * Debug endpoint - Check if an order has backup data
   */
  @Get('debug-backup/:orderNumber')
  @ApiOperation({ summary: 'Debug backup data for an order by order number' })
  async debugBackup(@Param('orderNumber') orderNumber: string) {
    this.logger.log(`Debugging backup for order: ${orderNumber}`);

    // 1. Find the order in OrderSyncQueue
    const order = await this.prisma.orderSyncQueue.findFirst({
      where: { 
        odooOrderNumber: orderNumber,
      },
    });

    // 2. Find backup lines - use the numeric order ID
    // First, find the backup order
    const backupOrder = await this.prisma.backupOdooOrder.findFirst({
      where: { 
        orderNumber: orderNumber,
      },
    });

    const backupLines = await this.prisma.backupOdooOrderLine.findMany({
      where: backupOrder 
        ? { orderId: backupOrder.orderId }  // ✅ Use numeric orderId
        : { orderId: 0 },  // No match
    });

    // 3. Find backup payments
    const backupPayments = await this.prisma.backupOdooOrderPayment.findMany({
      where: backupOrder 
        ? { orderId: backupOrder.orderId }  // ✅ Use numeric orderId
        : { orderId: 0 },  // No match
    });

    return {
      orderNumber,
      orderExists: !!order,
      orderId: order?.id,
      orderStatus: order?.status,
      orderSyncAttempts: order?.syncAttempts,
      backupOrderExists: !!backupOrder,
      backupOrderId: backupOrder?.id,
      backupLines: {
        count: backupLines.length,
        sample: backupLines.slice(0, 3),
      },
      backupPayments: {
        count: backupPayments.length,
        sample: backupPayments.slice(0, 3),
      },
      canSync: backupLines.length > 0 || backupPayments.length > 0 || !!backupOrder,
      summary: backupLines.length > 0 
        ? `✅ Found ${backupLines.length} lines and ${backupPayments.length} payments` 
        : '⚠️ No backup data found - will use minimal data',
    };
  }
}
