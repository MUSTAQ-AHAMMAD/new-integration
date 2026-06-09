import { BullModule } from '@nestjs/bull';
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AlertsModule } from '../alerts/alerts.module';
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

export const QUEUE_NAMES = {
  ORDER_SYNC: 'order-sync',
  INVENTORY_SYNC: 'inventory-sync',
  RETRY: 'retry',
  NOTIFICATIONS: 'notifications',
} as const;

@Module({
  imports: [
    ConfigModule,
    GatewayModule,
    AlertsModule,
    StoreConfigModule,
    PaymentMappingModule,
    NotificationsModule,
    forwardRef(() => SyncModule),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: {
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get('REDIS_PASSWORD') || undefined,
        },
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 500,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.ORDER_SYNC },
      { name: QUEUE_NAMES.INVENTORY_SYNC },
      { name: QUEUE_NAMES.RETRY },
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
