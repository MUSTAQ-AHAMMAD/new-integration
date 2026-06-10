/**
 * WorkerAppModule — minimal NestJS application module for the dedicated
 * BullMQ worker process.  It includes only the modules required to process
 * queue jobs and omits HTTP-only concerns (Swagger, Bull Board, metrics
 * endpoint, webhooks, dashboard aggregations).
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
  ],
})
export class WorkerAppModule {}
