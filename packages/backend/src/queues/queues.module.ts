import { BullModule } from '@nestjs/bull';
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionInvTxn } from '../database/entities/fusion-inv-txn.entity';
import { FusionStandardReceipt } from '../database/entities/fusion-standard-receipt.entity';
import { FusionMiscReceipt } from '../database/entities/fusion-misc-receipt.entity';
import { FusionApplyReceipt } from '../database/entities/fusion-apply-receipt.entity';
import { FusionJournalHeader } from '../database/entities/fusion-journal-header.entity';
import { FusionJournalLine } from '../database/entities/fusion-journal-line.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { InventorySyncTracker } from '../database/entities/inventory-sync-tracker.entity';
import { AlertsModule } from '../alerts/alerts.module';
import { ClientsModule } from '../clients/clients.module';
import { GatewayModule } from '../gateway/gateway.module';
import { PaymentMappingModule } from '../payment-mapping/payment-mapping.module';
import { StoreConfigModule } from '../store-config/store-config.module';
import { SyncModule } from '../sync/sync.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderSyncProcessor } from './processors/order-sync.processor';
import { InventorySyncProcessor } from './processors/inventory-sync.processor';
import { RetryProcessor } from './processors/retry.processor';
import { NotificationsProcessor } from './processors/notifications.processor';
import { QueuesService } from './queues.service';
import { QUEUE_NAMES } from './queues.constants';

export { QUEUE_NAMES };

@Module({
  imports: [
    ConfigModule,
    // Oracle repositories (TypeORM) for the entities the queue processors and
    // the dead-letter service touch.
    TypeOrmModule.forFeature([
      OrderSyncQueue,
      FailedTransaction,
      FusionInvoiceHeader,
      FusionInvoiceLine,
      FusionInvTxn,
      FusionStandardReceipt,
      FusionMiscReceipt,
      FusionApplyReceipt,
      FusionJournalHeader,
      FusionJournalLine,
      SyncJob,
      RefundTracking,
      BackupOdooOrder,
      InventorySyncTracker,
    ]),
    GatewayModule,
    AlertsModule,
    StoreConfigModule,
    PaymentMappingModule,
    NotificationsModule,
    ClientsModule,
    forwardRef(() => SyncModule),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const sentinelHosts = config.get<string>('REDIS_SENTINEL_HOSTS');
        const password = config.get<string>('REDIS_PASSWORD') || undefined;

        const redisConnection = sentinelHosts
          ? {
              sentinels: sentinelHosts.split(',').map((entry) => {
                const [host, port] = entry.trim().split(':');
                return { host, port: Number(port) || 26379 };
              }),
              name: config.get<string>('REDIS_MASTER_NAME', 'mymaster'),
              password,
              sentinelPassword: password,
            }
          : {
              host: config.get<string>('REDIS_HOST', 'localhost'),
              port: config.get<number>('REDIS_PORT', 6379),
              password,
            };

        return {
          redis: redisConnection,
          defaultJobOptions: {
            // Increased retention so operators have enough history for debugging
            // at high throughput: ~500 completed and 2 000 failed jobs in Redis.
            removeOnComplete: 500,
            removeOnFail: 2000,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
          },
        };
      },
    }),
    BullModule.registerQueue(
      {
        name: QUEUE_NAMES.ORDER_SYNC,
        // Limit to 30 Oracle calls/second to avoid API saturation
        limiter: { max: 30, duration: 1000 },
      },
      {
        name: QUEUE_NAMES.INVENTORY_SYNC,
        limiter: { max: 20, duration: 1000 },
      },
      {
        name: QUEUE_NAMES.RETRY,
        // Slow the retry lane to avoid hammering Oracle on recovery
        limiter: { max: 10, duration: 1000 },
      },
      { name: QUEUE_NAMES.NOTIFICATIONS },
    ),
  ],
  providers: [
    OrderSyncProcessor,
    InventorySyncProcessor,
    RetryProcessor,
    NotificationsProcessor,
    QueuesService,
  ],
  exports: [BullModule, QueuesService],
})
export class QueuesModule {}
