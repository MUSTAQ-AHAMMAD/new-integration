import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AlertsModule } from '../alerts/alerts.module';
import { AiMonitorController } from './ai-monitor.controller';
import { AiMonitorService } from './ai-monitor.service';
import { LlmSummaryClient } from './llm-summary.client';

/**
 * AI-powered monitoring / diagnostics.
 *
 * Aggregates health, credential, queue, job and failed-transaction signals,
 * runs a deterministic rule engine to detect and root-cause issues, and
 * optionally uses an LLM to summarise them for non-technical operators.
 */
@Module({
  imports: [PrismaModule, ConfigModule, AlertsModule],
  controllers: [AiMonitorController],
  providers: [AiMonitorService, LlmSummaryClient],
  exports: [AiMonitorService],
})
export class AiMonitorModule {}
