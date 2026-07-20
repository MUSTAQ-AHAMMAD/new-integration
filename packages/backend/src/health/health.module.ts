import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationHealthCheck } from '../database/entities/integration-health-check.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { GatewayModule } from '../gateway/gateway.module';
import { OracleModule } from '../clients/oracle/oracle.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [
    TerminusModule,
    GatewayModule,
    OracleModule,
    TypeOrmModule.forFeature([
      IntegrationHealthCheck,
      OrderSyncQueue,
      SyncJob,
      FailedTransaction,
    ]),
  ],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
