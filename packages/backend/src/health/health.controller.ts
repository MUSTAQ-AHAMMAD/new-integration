import { Controller, Get, Post } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service';
import { Public } from '../auth/public.decorator';

@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly dbHealth: TypeOrmHealthIndicator,
    private readonly healthService: HealthService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.dbHealth.pingCheck('database')]);
  }

  @Get('services')
  @ApiOperation({ summary: 'Get latest health status for all services' })
  async getServicesHealth() {
    return this.healthService.getLatestHealthPerService();
  }

  @Post('check')
  @ApiOperation({
    summary: 'Trigger an immediate health check for all services',
  })
  async triggerHealthCheck() {
    await this.healthService.runHealthChecks();
    return this.healthService.getLatestHealthPerService();
  }

  @Get('sync-status')
  @ApiOperation({ summary: 'Get comprehensive sync system status' })
  async getSyncStatus() {
    return this.healthService.getSyncSystemStatus();
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Get system metrics and counters' })
  async getMetrics() {
    return this.healthService.getSystemMetrics();
  }
}
