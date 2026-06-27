import { Controller, Get, Post } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { HealthService } from './health.service';
import { Public } from '../auth/public.decorator';

@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly healthService: HealthService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
    ]);
  }

  @Get('services')
  @ApiOperation({ summary: 'Get latest health status for all services' })
  async getServicesHealth() {
    return this.prisma.integrationHealthCheck.findMany({
      orderBy: [{ serviceName: 'asc' }, { createdAt: 'desc' }],
      distinct: ['serviceName'],
    });
  }

  @Post('check')
  @ApiOperation({
    summary: 'Trigger an immediate health check for all services',
  })
  async triggerHealthCheck() {
    await this.healthService.runHealthChecks();
    return this.prisma.integrationHealthCheck.findMany({
      orderBy: [{ serviceName: 'asc' }, { createdAt: 'desc' }],
      distinct: ['serviceName'],
    });
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
