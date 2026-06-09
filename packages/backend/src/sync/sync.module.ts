import { Module, forwardRef } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { PaymentMappingModule } from '../payment-mapping/payment-mapping.module';
import { QueuesModule } from '../queues/queues.module';
import { StoreConfigModule } from '../store-config/store-config.module';
import { SyncController } from './sync.controller';
import { IdempotencyService } from './idempotency.service';
import { OrderSyncService } from './order-sync.service';
import { SyncResolver } from './sync.resolver';
import { SyncService } from './sync.service';
import { TimezoneService } from './timezone.service';
import { ValidationService } from './validation.service';

@Module({
  imports: [
    forwardRef(() => QueuesModule),
    StoreConfigModule,
    AlertsModule,
    PaymentMappingModule,
  ],
  controllers: [SyncController],
  providers: [
    SyncService,
    OrderSyncService,
    IdempotencyService,
    TimezoneService,
    ValidationService,
    SyncResolver,
  ],
  exports: [
    SyncService,
    OrderSyncService,
    IdempotencyService,
    TimezoneService,
    ValidationService,
  ],
})
export class SyncModule {}
