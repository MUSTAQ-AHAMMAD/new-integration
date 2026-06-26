/**
 * WorkerAppModule — minimal NestJS application module for the dedicated
 * BullMQ worker process. It includes only the modules required to process
 * queue jobs and omits HTTP-only concerns (Swagger, Bull Board, metrics
 * endpoint, webhooks, dashboard aggregations).
 *
 * This module includes:
 * - Core infrastructure: Prisma, Redis, Queues, Config, Logging
 * - Queue processors: Order sync, inventory sync, retry, notifications
 * - Backup services with cron jobs: Odoo, IBQ, VendHQ (scheduled data ingestion)
 * - Sync pipeline: PipelineSchedulerService, OrderSyncService (automatic processing)
 * - Store/payment configuration services (required by processors)
 *
 * Run with: `node dist/worker`
 * Scale independently from the API server to increase queue throughput.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { QueuesModule } from './queues/queues.module';
import { AlertsModule } from './alerts/alerts.module';
import { ClientsModule } from './clients/clients.module';
import { GatewayModule } from './gateway/gateway.module';
import { StoreConfigModule } from './store-config/store-config.module';
import { PaymentMappingModule } from './payment-mapping/payment-mapping.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SyncModule } from './sync/sync.module';
import { OdooBackupModule } from './odoo-backup/odoo-backup.module';
import { IbqBackupModule } from './ibq-backup/ibq-backup.module';
import { VendHqBackupModule } from './vendhq-backup/vendhq-backup.module';
import { ItemSyncModule } from './item-sync/item-sync.module';
import { InventoryModule } from './inventory/inventory.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? {
                target: 'pino-pretty',
                options: { colorize: true, singleLine: true },
              }
            : undefined,
        level: process.env.LOG_LEVEL || 'info',
      },
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    AlertsModule,
    ClientsModule,
    GatewayModule,
    StoreConfigModule,
    PaymentMappingModule,
    NotificationsModule,
    // QueuesModule transitively imports SyncModule via forwardRef; both are
    // needed so all processor dependencies are satisfied.
    SyncModule,
    QueuesModule,
    // Backup modules with cron jobs for automatic data ingestion
    OdooBackupModule,
    IbqBackupModule,
    VendHqBackupModule,
    // Item and inventory sync modules
    ItemSyncModule,
    InventoryModule,
  ],
})
export class WorkerAppModule {}
