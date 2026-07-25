import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { parseLimit } from '../common/parse-limit';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get dashboard overview statistics' })
  getOverview(@Query('region') region?: string) {
    return this.service.getOverview(region || undefined);
  }

  @Get('sync-trend')
  @ApiOperation({ summary: 'Get sync trend data' })
  getSyncTrend(@Query('days') days?: string) {
    return this.service.getSyncTrend(days ? Number(days) : 7);
  }

  @Get('failed-transactions')
  @ApiOperation({ summary: 'Get unresolved failed transactions' })
  getFailedTransactions(@Query('limit') limit?: string) {
    return this.service.getFailedTransactions(parseLimit(limit, 20));
  }

  @Get('orders-by-branch')
  @ApiOperation({ summary: 'Get order counts grouped by branch' })
  getOrdersByBranch() {
    return this.service.getOrdersByBranch();
  }

  @Get('region-status')
  @ApiOperation({
    summary:
      'Per-region status board: last Odoo sync + fetched orders/revenue, ' +
      'last Oracle push + invoices/revenue, and failed-order count.',
  })
  getRegionStatus() {
    return this.service.getRegionStatus();
  }

  @Get('store-revenue')
  @ApiOperation({
    summary:
      'Per-store revenue from the Odoo backup (orders + Σ amountTotal), sorted ' +
      'by revenue — reflects Integration Run data.',
  })
  getStoreRevenue() {
    return this.service.getStoreRevenue();
  }

  @Get('executive-summary')
  @ApiOperation({
    summary:
      'Management KPIs: revenue completeness (Odoo vs Oracle + gap), value at ' +
      'risk, refund exposure, region freshness and store estate.',
  })
  getExecutiveSummary() {
    return this.service.getExecutiveSummary();
  }

  @Get('recent-activity')
  @ApiOperation({ summary: 'Get recent audit log activity' })
  getRecentActivity(@Query('limit') limit?: string) {
    return this.service.getRecentActivity(parseLimit(limit, 50));
  }

  @Get('health')
  @ApiOperation({ summary: 'Get integration health status' })
  getHealth() {
    return this.service.getHealthStatus();
  }

  @Get('negative-inventory')
  @ApiOperation({ summary: 'Get negative inventory items' })
  getNegativeInventory(@Query('limit') limit?: string) {
    return this.service.getNegativeInventory(parseLimit(limit, 20));
  }

  @Get('webhook-events')
  @ApiOperation({ summary: 'Get recent webhook events' })
  getWebhookEvents(@Query('limit') limit?: string) {
    return this.service.getWebhookEvents(parseLimit(limit, 100));
  }
}
