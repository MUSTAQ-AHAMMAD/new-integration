import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { parseLimit } from '../common/parse-limit';
import { CreateSyncJobDto } from './dto/create-sync-job.dto';
import { OrderSyncService } from './order-sync.service';
import { SyncService } from './sync.service';

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly orderSyncService: OrderSyncService,
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
}
