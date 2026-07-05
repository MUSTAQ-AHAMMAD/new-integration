import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AlertsModule } from '../alerts/alerts.module';
import { StoreConfigModule } from '../store-config/store-config.module';
import { PaymentMappingModule } from '../payment-mapping/payment-mapping.module';
import { SyncModule } from '../sync/sync.module';
import { AiMonitorController } from './ai-monitor.controller';
import { AiMonitorService } from './ai-monitor.service';
import { RemediationService } from './remediation.service';
import { LlmSummaryClient } from './llm-summary.client';

/**
 * AI-powered monitoring / diagnostics.
 *
 * Aggregates health, credential, queue, job and failed-transaction signals,
 * runs a deterministic rule engine to detect and root-cause issues, and
 * optionally uses an LLM to summarise them for non-technical operators. Also
 * exposes a guided remediation flow ({@link RemediationService}) that executes
 * the recommended fixes in the correct order.
 */
@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    AlertsModule,
    StoreConfigModule,
    PaymentMappingModule,
    SyncModule,
  ],
  controllers: [AiMonitorController],
  providers: [AiMonitorService, RemediationService, LlmSummaryClient],
  exports: [AiMonitorService, RemediationService],
})
export class AiMonitorModule {}
