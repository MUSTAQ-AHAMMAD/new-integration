import { Module, forwardRef } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { ClientsModule } from '../clients/clients.module';
import { IbqBackupModule } from '../ibq-backup/ibq-backup.module';
import { OdooBackupModule } from '../odoo-backup/odoo-backup.module';
import { PaymentMappingModule } from '../payment-mapping/payment-mapping.module';
import { QueuesModule } from '../queues/queues.module';
import { StoreConfigModule } from '../store-config/store-config.module';
import { SyncController } from './sync.controller';
import { AutoFixService } from './auto-fix.service';
import { FusionTransformationService } from './fusion-transformation.service';
import { IdempotencyService } from './idempotency.service';
import { OdooTransformationService } from './odoo-transformation.service';
import { OrderDiagnosticsService } from './order-diagnostics.service';
import { OrderSyncService } from './order-sync.service';
import { PipelineSchedulerService } from './pipeline-scheduler.service';
import { StalledOrdersService } from './stalled-orders.service';
import { SyncResolver } from './sync.resolver';
import { SyncService } from './sync.service';
import { SyncControlService } from './sync-control.service';
import { TimezoneService } from './timezone.service';
import { ValidationService } from './validation.service';

@Module({
  imports: [
    forwardRef(() => QueuesModule),
    StoreConfigModule,
    AlertsModule,
    PaymentMappingModule,
    ClientsModule,
    forwardRef(() => OdooBackupModule),
    forwardRef(() => IbqBackupModule),
  ],
  controllers: [SyncController],
  providers: [
    SyncService,
    OrderSyncService,
    IdempotencyService,
    TimezoneService,
    ValidationService,
    FusionTransformationService,
    OdooTransformationService,
    StalledOrdersService,
    OrderDiagnosticsService,
    AutoFixService,
    SyncResolver,
    PipelineSchedulerService,
    SyncControlService,
  ],
  exports: [
    SyncService,
    OrderSyncService,
    IdempotencyService,
    TimezoneService,
    ValidationService,
    FusionTransformationService,
    OdooTransformationService,
    StalledOrdersService,
    OrderDiagnosticsService,
    AutoFixService,
    PipelineSchedulerService,
    SyncControlService,
  ],
})
export class SyncModule {}
