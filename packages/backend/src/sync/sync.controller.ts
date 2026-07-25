import {
  Body,
  Controller,
  Get,
  Logger,
  BadRequestException,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { SyncStatus } from '../database/enums';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { BackupOdooOrderPayment } from '../database/entities/backup-odoo-order-payment.entity';
import { normalizeOrderForIngestion } from '../common/odoo-utils';
import { parseLimit } from '../common/parse-limit';
import { toSafeNumber } from '../common/utils/bigint-utils';
import { IbqBackupService } from '../ibq-backup/ibq-backup.service';
import { OdooBackupService } from '../odoo-backup/odoo-backup.service';
import { QueuesService } from '../queues/queues.service';
import { CircuitBreakerService } from '../clients/circuit-breaker.service';
import { FusionMetadataService } from '../fusion/fusion-metadata.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateSyncJobDto } from './dto/create-sync-job.dto';
import { OrderListResponseDto } from './dto/order-response.dto';
import { OrderDiagnosticsService } from './order-diagnostics.service';
import { OrderSyncService } from './order-sync.service';
import { OrderEnrichmentService } from './order-enrichment.service';
import { SyncService } from './sync.service';
import { AutoFixService } from './auto-fix.service';
import { DailyInvoiceService } from './daily-invoice.service';
import { DailyAggregationService } from './daily-aggregation.service';
import { DailyInvoiceSchedulerService } from './daily-invoice-scheduler.service';
import { IntegrationRunService } from './integration-run.service';
import { IntegrationSchedulerService } from './integration-scheduler.service';
import { ReadinessService } from './readiness.service';

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  constructor(
    private readonly syncService: SyncService,
    private readonly dailyInvoiceService: DailyInvoiceService,
    private readonly dailyAggregationService: DailyAggregationService,
    private readonly dailyInvoiceScheduler: DailyInvoiceSchedulerService,
    private readonly integrationRun: IntegrationRunService,
    private readonly integrationScheduler: IntegrationSchedulerService,
    private readonly readinessService: ReadinessService,
    private readonly orderSyncService: OrderSyncService,
    private readonly odooBackupService: OdooBackupService,
    private readonly ibqBackupService: IbqBackupService,
    @InjectRepository(OdooCredential)
    private readonly odooCredentialRepo: Repository<OdooCredential>,
    @InjectRepository(OrderSyncQueue)
    private readonly orderSyncQueueRepo: Repository<OrderSyncQueue>,
    @InjectRepository(BackupOdooOrder)
    private readonly backupOdooOrderRepo: Repository<BackupOdooOrder>,
    @InjectRepository(BackupOdooOrderLine)
    private readonly backupOdooOrderLineRepo: Repository<BackupOdooOrderLine>,
    @InjectRepository(BackupOdooOrderPayment)
    private readonly backupOdooOrderPaymentRepo: Repository<BackupOdooOrderPayment>,
    private readonly diagnosticsService: OrderDiagnosticsService,
    private readonly autoFixService: AutoFixService,
    private readonly queuesService: QueuesService,
    private readonly orderEnrichmentService: OrderEnrichmentService,
    private readonly circuitBreakerService: CircuitBreakerService,
    private readonly fusionMetadataService: FusionMetadataService,
  ) {}

  /**
   * Convert Prisma Decimal or BigInt to number safely
   * Handles various data types that can come from Prisma queries
   * @deprecated Use toSafeNumber from bigint-utils instead
   */
  private convertDecimal(value: any): number {
    return toSafeNumber(value);
  }

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
    @Query('isCancelled') isCancelled?: string,
    @Query('isRefund') isRefund?: string,
  ) {
    return this.syncService.listOrderQueue({
      status,
      branchCode,
      search,
      limit: parseLimit(limit, 200),
      isCancelled:
        isCancelled === undefined ? undefined : isCancelled === 'true',
      isRefund: isRefund === undefined ? undefined : isRefund === 'true',
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

  @Get('daily-invoice/readiness/:region')
  @ApiOperation({
    summary:
      'Preflight go/no-go for a region: reference data, store configs, Oracle ' +
      'reachability and outlet gating. ready=false lists the exact blockers.',
  })
  async regionReadiness(@Param('region') region: string) {
    return this.readinessService.checkRegion(region);
  }

  // ── Operator integration run: pull (Odoo) → post (one invoice/store/day) ──

  @Post('integration-run')
  @ApiOperation({
    summary:
      'Start a full integration run for a region + date range: pull the Odoo ' +
      'orders into the backup tables, then post one Oracle invoice per store ' +
      'per business day with the complete cycle (receipts, applications, ' +
      'journals, inventory). Returns the tracking job immediately; watch it ' +
      'via GET /sync/integration-run/:id or the "integrationRun" websocket event.',
  })
  async startIntegrationRun(
    @Body()
    body: {
      region: string;
      startDate: string;
      endDate: string;
    },
  ) {
    return this.integrationRun.startRun({
      region: body?.region,
      startDate: body?.startDate,
      endDate: body?.endDate,
    });
  }

  @Post('integration-run/all')
  @ApiOperation({
    summary:
      'Start an integration run for EVERY active region over one date range. ' +
      'Regions run concurrently; a region already running is skipped (reported).',
  })
  async startIntegrationRunAll(
    @Body() body: { startDate: string; endDate: string },
  ) {
    if (
      !body?.startDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate) ||
      !body?.endDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate)
    ) {
      throw new BadRequestException(
        'startDate and endDate are required as YYYY-MM-DD.',
      );
    }
    return this.integrationRun.startAllActiveRegions({
      startDate: body.startDate,
      endDate: body.endDate,
    });
  }

  @Post('integration-auto/run-now')
  @ApiOperation({
    summary:
      'Trigger the automatic per-region integration immediately for every ' +
      'region whose "Automatic Integration" toggle is enabled.',
  })
  async runAutoIntegrationNow() {
    const started = await this.integrationScheduler.run('MANUAL_TRIGGER');
    return { ok: true, startedRegions: started };
  }

  @Get('integration-run')
  @ApiOperation({ summary: 'List recent integration runs (newest first)' })
  listIntegrationRuns(@Query('limit') limit?: string) {
    return this.integrationRun.listRuns(limit ? Number(limit) : undefined);
  }

  @Get('integration-run/:id')
  @ApiOperation({
    summary:
      'Live status of one integration run — counters, per-day Oracle results ' +
      'and the event log.',
  })
  async getIntegrationRun(@Param('id') id: string) {
    const job = await this.integrationRun.getRun(id);
    if (!job) {
      throw new BadRequestException(`Integration run ${id} not found`);
    }
    return job;
  }

  @Post('daily-invoice/run-now')
  @ApiOperation({
    summary:
      'Run the scheduled daily invoicing immediately for every active region, ' +
      'using the same catch-up window the 03:00 cron would use.',
  })
  async runDailyInvoicingNow() {
    const results = await this.dailyInvoiceScheduler.run();
    return {
      ok: results.every((r) => r.status !== 'FAILED'),
      created: results.filter((r) => r.status === 'CREATED').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
      results,
    };
  }

  @Post('daily-invoice')
  @ApiOperation({
    summary:
      'Post aggregated daily invoices to Oracle — one invoice per branch, ' +
      'business day, customer type and credit flag. Re-running a day is safe: ' +
      'lines already posted are skipped.',
  })
  async postDailyInvoices(
    @Body()
    body: {
      branchCode?: string;
      region?: string;
      startDate: string;
      days?: number;
      trigger?: 'MANUAL' | 'AUTOMATIC';
    },
  ) {
    if (!body?.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
      throw new BadRequestException(
        'startDate is required in YYYY-MM-DD form (store-local business day).',
      );
    }
    const results = await this.dailyInvoiceService.postRange({
      branchCode: body.branchCode,
      region: body.region,
      startDate: body.startDate,
      days: body.days,
      // Operator-triggered: MANUAL outlets only, per OUTLETS_INTEGRATION_CONFIG.
      trigger: body.trigger ?? 'MANUAL',
    });
    return {
      ok: results.every((r) => r.status !== 'FAILED'),
      created: results.filter((r) => r.status === 'CREATED').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
      results,
    };
  }

  @Get('daily-invoice/preview/:branchCode/:businessDay')
  @ApiOperation({
    summary:
      'Dry run — show the invoice groups that WOULD be posted for a branch/day ' +
      'without sending anything to Oracle.',
  })
  async previewDailyInvoices(
    @Param('branchCode') branchCode: string,
    @Param('businessDay') businessDay: string,
  ) {
    const groups = await this.dailyAggregationService.buildDailyGroups(
      branchCode,
      businessDay,
    );
    return {
      branchCode,
      businessDay,
      groupCount: groups.length,
      groups: groups.map((g) => ({
        groupKey: g.groupKey,
        customerType: g.customerType,
        isCredit: g.isCredit,
        sourceOrderCount: g.sourceOrderNumbers.length,
        sourceOrderNumbers: g.sourceOrderNumbers,
        invoiceLineCount: g.invoiceHeader.invoiceLines.length,
        alreadyPostedLines: g.alreadyPostedLines,
        invoiceTotal: g.invoiceHeader.invoiceLines.reduce(
          (sum, l) => sum + l.quantity * l.unitSellingPrice,
          0,
        ),
        billTo: g.invoiceHeader.billToCustomerName,
        standardReceipts: g.standardReceipts.map((r) => ({
          receiptNumber: r.receiptNumber,
          amount: r.receiptAmount,
        })),
        miscReceipts: g.miscReceipts.length,
        journals: g.journalHeaders.length,
      })),
    };
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
      const cred = await this.odooCredentialRepo.findOne({
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
    description:
      'Returns orders from OrderSyncQueue with all dates formatted as ISO strings to fix UI display issues',
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
      this.orderSyncQueueRepo.find({
        where,
        skip: skipNum,
        take: takeNum,
        order: { orderDate: 'DESC' },
      }),
      this.orderSyncQueueRepo.count({ where }),
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
    description:
      'Resets all failed orders to PENDING status and triggers sync. Useful for bulk recovery after fixing issues.',
  })
  async fixAllFailedOrders() {
    this.logger.log('🔧 FIXING ALL FAILED ORDERS...');

    // Get all failed orders
    const failedOrders = await this.orderSyncQueueRepo.find({
      where: {
        status: SyncStatus.FAILED,
        syncAttempts: LessThan(5),
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
        await this.orderSyncQueueRepo.update(order.id, {
          status: SyncStatus.PENDING,
          syncAttempts: 0,
          validationErrors: null as unknown as object,
          lastSyncAt: null,
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
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        results.errors.push({
          orderId: order.id,
          orderNumber: order.odooOrderNumber,
          error: errorMessage,
        });
        this.logger.error(
          `❌ Failed to reset order ${order.id}:`,
          errorMessage,
        );
      }
    }

    this.logger.log(
      `✅ Fix completed: ${results.reset} reset, ${results.requeued} requeued`,
    );

    return {
      message: 'Fix completed',
      results,
      nextStep:
        'Orders reset to PENDING and re-queued. Sync will process automatically.',
    };
  }

  /**
   * Sync a specific order directly
   */
  @Post('sync-direct/:orderId')
  @ApiOperation({
    summary: 'Directly sync a specific order',
    description:
      'Resets order to PENDING and immediately queues it for sync. Useful for testing.',
  })
  async syncOrderDirect(@Param('orderId') orderId: string) {
    this.logger.log(`Direct sync for order: ${orderId}`);

    const order = await this.orderSyncQueueRepo.findOne({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    // Reset to PENDING
    await this.orderSyncQueueRepo.update(orderId, {
      status: SyncStatus.PENDING,
      syncAttempts: 0,
      validationErrors: null as unknown as object, // ✅ Fixed
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
    description:
      'Retrieves order along with its line items and payments from BackupOdooOrder tables. Use this to verify data exists before enrichment.',
  })
  async getOrderData(@Param('orderSyncQueueId') orderSyncQueueId: string) {
    this.logger.log(`Getting order data for: ${orderSyncQueueId}`);

    const order = await this.orderSyncQueueRepo.findOne({
      where: { id: orderSyncQueueId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderSyncQueueId} not found`);
    }

    // Get backup order
    const backupOrder = await this.backupOdooOrderRepo.findOne({
      where: {
        orderName: order.odooOrderNumber,
      },
    });

    // Get backup lines - use numeric orderId
    const backupLines = await this.backupOdooOrderLineRepo.find({
      where: backupOrder ? { orderId: backupOrder.orderId } : { orderId: 0 },
    });

    // Get backup payments - use numeric orderId
    const backupPayments = await this.backupOdooOrderPaymentRepo.find({
      where: backupOrder ? { orderId: backupOrder.orderId } : { orderId: 0 },
    });

    return {
      order: {
        id: order.id,
        odooOrderId: order.odooOrderId,
        odooOrderNumber: order.odooOrderNumber,
        branchCode: order.branchCode,
        branchName: order.branchName,
        totalAmount: this.convertDecimal(order.totalAmount),
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
    description:
      'Runs enrichment on a specific order to verify that lines and payments are being fetched correctly from backup tables.',
  })
  async testEnrichOrder(
    @Param('orderSyncQueueId') orderSyncQueueId: string,
  ): Promise<any> {
    this.logger.log(`Testing enrichment for order: ${orderSyncQueueId}`);

    const order = await this.orderSyncQueueRepo.findOne({
      where: { id: orderSyncQueueId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderSyncQueueId} not found`);
    }

    // Get backup order
    const backupOrder = await this.backupOdooOrderRepo.findOne({
      where: {
        orderName: order.odooOrderNumber,
      },
    });

    // Get backup lines - use numeric orderId
    const backupLines = await this.backupOdooOrderLineRepo.find({
      where: backupOrder ? { orderId: backupOrder.orderId } : { orderId: 0 },
    });

    // Get backup payments - use numeric orderId
    const backupPayments = await this.backupOdooOrderPaymentRepo.find({
      where: backupOrder ? { orderId: backupOrder.orderId } : { orderId: 0 },
    });

    // Build enriched payloads
    const enriched = await this.orderEnrichmentService.enrichOrder(
      order.id,
      order.branchCode,
      order.branchCode,
    );

    return {
      success: true,
      orderId: order.id,
      orderNumber: order.odooOrderNumber,
      branchCode: order.branchCode,
      totalAmount: this.convertDecimal(order.totalAmount),
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
    const order = await this.orderSyncQueueRepo.findOne({
      where: {
        odooOrderNumber: orderNumber,
      },
    });

    // 2. Find backup lines - use the numeric order ID
    // First, find the backup order
    const backupOrder = await this.backupOdooOrderRepo.findOne({
      where: {
        orderName: orderNumber,
      },
    });

    const backupLines = await this.backupOdooOrderLineRepo.find({
      where: backupOrder
        ? { orderId: backupOrder.orderId } // ✅ Use numeric orderId
        : { orderId: 0 }, // No match
    });

    // 3. Find backup payments
    const backupPayments = await this.backupOdooOrderPaymentRepo.find({
      where: backupOrder
        ? { orderId: backupOrder.orderId } // ✅ Use numeric orderId
        : { orderId: 0 }, // No match
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
      canSync:
        backupLines.length > 0 || backupPayments.length > 0 || !!backupOrder,
      summary:
        backupLines.length > 0
          ? `✅ Found ${backupLines.length} lines and ${backupPayments.length} payments`
          : '⚠️ No backup data found - will use minimal data',
    };
  }

  /**
   * Get all circuit breaker statuses
   */
  @Get('admin/circuit-breakers')
  @ApiOperation({
    summary: 'Get all circuit breaker statuses',
    description: 'Returns status of all circuit breakers in the system',
  })
  async getCircuitBreakers() {
    const statuses = await this.circuitBreakerService.getStatus();
    return {
      message: 'Circuit breaker statuses retrieved',
      circuitBreakers: statuses,
    };
  }

  /**
   * Get status of a specific circuit breaker
   */
  @Get('admin/circuit-breaker/:name')
  @ApiOperation({
    summary: 'Get circuit breaker status by name',
    description: 'Returns the status of a specific circuit breaker',
  })
  async getCircuitBreaker(@Param('name') name: string) {
    const status = await this.circuitBreakerService.getStatus(name);
    if (!status) {
      throw new NotFoundException(`Circuit breaker ${name} not found`);
    }
    return {
      message: `Circuit breaker ${name} status retrieved`,
      circuitBreaker: status,
    };
  }

  /**
   * Reset a circuit breaker to CLOSED state
   */
  @Post('admin/circuit-breaker/reset/:name')
  @ApiOperation({
    summary: 'Reset circuit breaker for a service',
    description:
      'Manually reset a circuit breaker to CLOSED state. Use this to recover from OPEN state after fixing the underlying issue.',
  })
  async resetCircuitBreaker(@Param('name') name: string) {
    this.logger.log(`Resetting circuit breaker: ${name}`);
    const result = await this.circuitBreakerService.reset(name);
    return {
      message: result.message,
      circuitBreaker: name,
      success: result.success,
    };
  }

  /**
   * Debug endpoint - Get FusionSalesMetadata by region
   */
  @Get('debug/metadata/:region')
  @ApiOperation({
    summary: 'Get FusionSalesMetadata by region',
    description:
      'Debug endpoint to check metadata configuration for a specific region',
  })
  async debugMetadata(@Param('region') region: string) {
    const metadata = await this.fusionMetadataService.getSalesMetadata(region);
    const buMap = await this.fusionMetadataService.getBusinessUnitMap(region);

    return {
      region,
      metadata,
      businessUnitMap: buMap,
      hasMetadata: !!metadata,
      hasBusinessUnitMap: !!buMap,
    };
  }

  /**
   * Debug endpoint - Test invoice building with metadata
   */
  @Post('debug/test-invoice/:region')
  @ApiOperation({
    summary: 'Test invoice building with metadata',
    description:
      'Debug endpoint to test invoice payload generation using FusionSalesMetadata',
  })
  async testInvoiceWithMetadata(@Param('region') region: string) {
    const metadata = await this.fusionMetadataService.getSalesMetadata(region);

    const testInvoice = {
      billToCustomerName: metadata.billToName,
      billToLocation: metadata.siteNumber || '',
      billToAccountNumber: String(metadata.billToAccount),
      businessUnit: metadata.businessUnit,
      transactionSource: metadata.txnSource,
      transactionType: metadata.txnType,
      invoiceCurrencyCode: 'AED',
      conversionRateType: metadata.rateIsCorporate ? 'Corporate' : 'User',
      saleDate: new Date(),
      invoiceLines: [
        {
          lineNumber: 1,
          description: 'Test Line',
          quantity: 1,
          unitSellingPrice: 10,
          currencyCode: 'AED',
          salesOrder: 'TEST-001',
          salesOrderLine: '1',
        },
      ],
    };

    return {
      region,
      metadata,
      testInvoice,
      message:
        'Test invoice built from metadata. Check logs for Oracle response.',
    };
  }

  /**
   * Bulk retry all failed transactions
   */
  @Post('orders/retry-all-failed')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Bulk retry all failed transactions with FIFO ordering and duplicate detection',
  })
  retryAllFailed(
    @Body()
    body?: {
      maxTransactions?: number;
      dryRun?: boolean;
      priorityBranches?: string[];
    },
  ) {
    return {
      message:
        'Bulk retry endpoint - requires BulkRetryService to be registered',
      options: body,
    };
  }

  /**
   * Retry failed transactions for specific branches
   */
  @Post('orders/retry-for-branches')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  @ApiOperation({
    summary: 'Retry failed transactions for specific branches',
  })
  retryForBranches(@Body() body: { branchCodes: string[]; dryRun?: boolean }) {
    return {
      message: 'Branch retry endpoint - requires BulkRetryService',
      branchCodes: body.branchCodes,
    };
  }

  /**
   * Get failed transaction statistics
   */
  @Get('orders/failed-stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'OPERATOR', 'VIEWER')
  @ApiOperation({
    summary: 'Get statistics about failed transactions',
  })
  getFailedStats() {
    return {
      message: 'Failed stats endpoint - requires BulkRetryService',
    };
  }
}
