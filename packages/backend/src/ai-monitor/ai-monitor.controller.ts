import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AiMonitorService } from './ai-monitor.service';
import type { AnalysisResult, DiagnosticSignals } from './ai-monitor.types';

/**
 * AI monitoring endpoints. Exposes the automated diagnostics so the dashboard
 * (and operators via Swagger) can see exactly what is wrong with the
 * integration and how to fix it.
 */
@ApiTags('ai-monitor')
@Controller('ai-monitor')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AiMonitorController {
  constructor(private readonly aiMonitor: AiMonitorService) {}

  @Get('analyze')
  @ApiOperation({
    summary:
      'Run a full AI-powered diagnostic analysis and return findings, a health score and a summary',
  })
  analyze(): Promise<AnalysisResult> {
    return this.aiMonitor.analyze();
  }

  @Get('signals')
  @ApiOperation({
    summary: 'Return the raw diagnostic signals used by the analysis',
  })
  signals(): Promise<DiagnosticSignals> {
    return this.aiMonitor.collectSignals();
  }
}
