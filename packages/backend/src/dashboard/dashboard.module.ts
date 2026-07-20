import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertLog } from '../database/entities/alert-log.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import { BackupVendHqSale } from '../database/entities/backup-vend-hq-sale.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { IntegrationHealthCheck } from '../database/entities/integration-health-check.entity';
import { InventorySyncTracker } from '../database/entities/inventory-sync-tracker.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { WebhookEvent } from '../database/entities/webhook-event.entity';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderSyncQueue,
      AlertLog,
      SyncJob,
      StoreConfiguration,
      BackupVendHqSale,
      FailedTransaction,
      AuditLog,
      IntegrationHealthCheck,
      InventorySyncTracker,
      WebhookEvent,
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
