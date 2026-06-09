import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get dashboard overview statistics' })
  getOverview() {
    return this.service.getOverview();
  }

  @Get('sync-trend')
  @ApiOperation({ summary: 'Get sync trend data' })
  getSyncTrend(@Query('days') days?: string) {
    return this.service.getSyncTrend(days ? Number(days) : 7);
  }

  @Get('failed-transactions')
  @ApiOperation({ summary: 'Get unresolved failed transactions' })
  getFailedTransactions(@Query('limit') limit?: string) {
    return this.service.getFailedTransactions(limit ? Number(limit) : 20);
  }

  @Get('orders-by-branch')
  @ApiOperation({ summary: 'Get order counts grouped by branch' })
  getOrdersByBranch() {
    return this.service.getOrdersByBranch();
  }

  @Get('recent-activity')
  @ApiOperation({ summary: 'Get recent audit log activity' })
  getRecentActivity(@Query('limit') limit?: string) {
    return this.service.getRecentActivity(limit ? Number(limit) : 50);
  }

  @Get('health')
  @ApiOperation({ summary: 'Get integration health status' })
  getHealth() {
    return this.service.getHealthStatus();
  }

  @Get('negative-inventory')
  @ApiOperation({ summary: 'Get negative inventory items' })
  getNegativeInventory(@Query('limit') limit?: string) {
    return this.service.getNegativeInventory(limit ? Number(limit) : 20);
  }

  @Get('webhook-events')
  @ApiOperation({ summary: 'Get recent webhook events' })
  getWebhookEvents(@Query('limit') limit?: string) {
    return this.service.getWebhookEvents(limit ? Number(limit) : 100);
  }
}
