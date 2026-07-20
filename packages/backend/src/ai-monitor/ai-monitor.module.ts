import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertsModule } from '../alerts/alerts.module';
import { AlertLog } from '../database/entities/alert-log.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { FusionCredential } from '../database/entities/fusion-credential.entity';
import { IbqCredential } from '../database/entities/ibq-credential.entity';
import { IntegrationHealthCheck } from '../database/entities/integration-health-check.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncControl } from '../database/entities/sync-control.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
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
    TypeOrmModule.forFeature([
      FusionCredential,
      OdooCredential,
      VendHqCredential,
      IbqCredential,
      SyncControl,
      OrderSyncQueue,
      SyncJob,
      FailedTransaction,
      AlertLog,
      IntegrationHealthCheck,
      VendHqItemMeta,
    ]),
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
