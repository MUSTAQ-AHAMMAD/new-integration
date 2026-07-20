import { AdminModule } from './admin/admin.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { LoggerModule } from 'nestjs-pino';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { QueuesModule } from './queues/queues.module';
import { SyncModule } from './sync/sync.module';
import { WebhookModule } from './webhook/webhook.module';
import { StoreConfigModule } from './store-config/store-config.module';
import { PaymentMappingModule } from './payment-mapping/payment-mapping.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { AlertsModule } from './alerts/alerts.module';
import { GatewayModule } from './gateway/gateway.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MetricsModule } from './metrics/metrics.module';
import { RefundsModule } from './refunds/refunds.module';
import { InventoryModule } from './inventory/inventory.module';
import { AuditModule } from './audit/audit.module';
import { ClientsModule } from './clients/clients.module';
import { SettingsModule } from './settings/settings.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { VendHqBackupModule } from './vendhq-backup/vendhq-backup.module';
import { ItemSyncModule } from './item-sync/item-sync.module';
import { IbqBackupModule } from './ibq-backup/ibq-backup.module';
import { OdooBackupModule } from './odoo-backup/odoo-backup.module';
import { AiMonitorModule } from './ai-monitor/ai-monitor.module';
import { ReportsModule } from './reports/reports.module';
import { BigIntInterceptor } from './common/interceptors/big-int.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 30,
      },
      {
        name: 'medium',
        ttl: 60000,
        limit: 300,
      },
      // Dedicated high-volume throttle for inbound webhooks (1000 req/min per IP)
      {
        name: 'webhook',
        ttl: 60000,
        limit: 1000,
      },
    ]),
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
        serializers: {
          req(req: { method?: string; url?: string; id?: string }) {
            return { method: req.method, url: req.url, id: req.id };
          },
          res(res: { statusCode?: number }) {
            return { statusCode: res.statusCode };
          },
        },
      },
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      sortSchema: true,
      playground: process.env.NODE_ENV !== 'production',
    }),
    ScheduleModule.forRoot(),
    // Oracle (TypeORM) is the application database.
    DatabaseModule,
    RedisModule,
    QueuesModule,
    SyncModule,
    WebhookModule,
    StoreConfigModule,
    PaymentMappingModule,
    DashboardModule,
    HealthModule,
    AlertsModule,
    GatewayModule,
    NotificationsModule,
    MetricsModule,
    RefundsModule,
    InventoryModule,
    AuditModule,
    ClientsModule,
    SettingsModule,
    AdminModule,
    AuthModule,
    VendHqBackupModule,
    ItemSyncModule,
    IbqBackupModule,
    OdooBackupModule,
    AiMonitorModule,
    ReportsModule,
  ],
  providers: [
    // Global BigInt serialization interceptor (applied before all other processing)
    {
      provide: APP_INTERCEPTOR,
      useClass: BigIntInterceptor,
    },
    // Rate limiting (applied after auth to avoid wasting tokens on invalid requests)
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // JWT authentication (all routes; use @Public() to opt-out)
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Role-based authorisation (after JWT guard so authed users are checked)
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
