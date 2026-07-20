import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertLog } from '../database/entities/alert-log.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { QueuesModule } from '../queues/queues.module';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderSyncQueue,
      AlertLog,
      StoreConfiguration,
      FailedTransaction,
    ]),
    forwardRef(() => QueuesModule),
    forwardRef(() => SyncModule),
  ],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
