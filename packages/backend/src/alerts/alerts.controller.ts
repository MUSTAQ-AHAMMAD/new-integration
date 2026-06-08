import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AlertSeverity } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';

@ApiTags('alerts')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly service: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'List alerts' })
  list(@Query('severity') severity?: AlertSeverity, @Query('resolved') resolved?: string, @Query('limit') limit?: string) {
    return this.service.listAlerts({
      severity,
      isResolved: resolved !== undefined ? resolved === 'true' : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post(':id/resolve')
  @ApiOperation({ summary: 'Resolve an alert' })
  resolve(@Param('id') id: string, @Body() body: { resolvedBy: string }) {
    return this.service.resolveAlert(id, body.resolvedBy);
  }
}
