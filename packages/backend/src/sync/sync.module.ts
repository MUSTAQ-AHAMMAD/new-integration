import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { AlertsModule } from '../alerts/alerts.module';
import { ClientsModule } from '../clients/clients.module';
import { OracleModule } from '../clients/oracle/oracle.module';
import { GatewayModule } from '../gateway/gateway.module';
import { IbqBackupModule } from '../ibq-backup/ibq-backup.module';
import { OdooBackupModule } from '../odoo-backup/odoo-backup.module';
import { PaymentMappingModule } from '../payment-mapping/payment-mapping.module';
import { QueuesModule } from '../queues/queues.module';
import { StoreConfigModule } from '../store-config/store-config.module';
import { FusionMetadataService } from '../fusion/fusion-metadata.service';
import { AuditLog } from '../database/entities/audit-log.entity';
import { BackupIbqOrder } from '../database/entities/backup-ibq-order.entity';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { BackupOdooOrderPayment } from '../database/entities/backup-odoo-order-payment.entity';
import { BackupVendHqSale } from '../database/entities/backup-vend-hq-sale.entity';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionCustomerAccount } from '../database/entities/fusion-customer-account.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionInvTxn } from '../database/entities/fusion-inv-txn.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { OutletIntegrationConfig } from '../database/entities/outlet-integration-config.entity';
import { FusionStandardReceipt } from '../database/entities/fusion-standard-receipt.entity';
import { FusionMiscReceipt } from '../database/entities/fusion-misc-receipt.entity';
import { FusionJournalHeader } from '../database/entities/fusion-journal-header.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { FusionApplyReceipt } from '../database/entities/fusion-apply-receipt.entity';
import { FusionReceiptMethod } from '../database/entities/fusion-receipt-method.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { ServiceProviderJournalMeta } from '../database/entities/service-provider-journal-meta.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { SyncControl } from '../database/entities/sync-control.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqOutlet } from '../database/entities/vend-hq-outlet.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
import { SyncController } from './sync.controller';
import { AutoFixService } from './auto-fix.service';
import { FusionTransformationService } from './fusion-transformation.service';
import { IdempotencyService } from './idempotency.service';
import { OdooTransformationService } from './odoo-transformation.service';
import { DailyAggregationService } from './daily-aggregation.service';
import { DailyInvoiceService } from './daily-invoice.service';
import { DailyInvoiceSchedulerService } from './daily-invoice-scheduler.service';
import { IntegrationRunService } from './integration-run.service';
import { ReadinessService } from './readiness.service';
import { OrderDiagnosticsService } from './order-diagnostics.service';
import { OrderEnrichmentService } from './order-enrichment.service';
import { OrderSyncService } from './order-sync.service';
import { PipelineSchedulerService } from './pipeline-scheduler.service';
import { StalledOrdersService } from './stalled-orders.service';
import { SyncResolver } from './sync.resolver';
import { SyncService } from './sync.service';
import { SyncControlService } from './sync-control.service';
import { TimezoneService } from './timezone.service';
import { ValidationService } from './validation.service';
import { BulkRetryService } from './bulk-retry.service';

@Module({
  imports: [
    // Oracle repositories (TypeORM) for every entity touched by the sync module.
    TypeOrmModule.forFeature([
      AuditLog,
      BackupIbqOrder,
      BackupOdooOrder,
      BackupOdooOrderLine,
      BackupOdooOrderPayment,
      BackupVendHqSale,
      FailedTransaction,
      FusionBusinessUnitMap,
      FusionCustomerAccount,
      FusionInvoiceLine,
      FusionInvTxn,
      VendHqItemMeta,
      OutletIntegrationConfig,
      FusionStandardReceipt,
      FusionMiscReceipt,
      FusionJournalHeader,
      FusionInvoiceHeader,
      FusionApplyReceipt,
      FusionReceiptMethod,
      FusionSalesMetadata,
      OdooCredential,
      OrderSyncQueue,
      RefundTracking,
      ServiceProviderJournalMeta,
      StoreConfiguration,
      SyncControl,
      SyncJob,
      VendHqCredential,
      VendHqOutlet,
      VendHqRegister,
    ]),
    forwardRef(() => QueuesModule),
    StoreConfigModule,
    AlertsModule,
    NotificationsModule,
    PaymentMappingModule,
    ClientsModule,
    OracleModule,
    GatewayModule,
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
    DailyAggregationService,
    DailyInvoiceService,
    DailyInvoiceSchedulerService,
    ReadinessService,
    IntegrationRunService,
    OrderEnrichmentService,
    StalledOrdersService,
    OrderDiagnosticsService,
    AutoFixService,
    SyncResolver,
    PipelineSchedulerService,
    SyncControlService,
    FusionMetadataService,
    BulkRetryService,
  ],
  exports: [
    SyncService,
    OrderSyncService,
    IdempotencyService,
    TimezoneService,
    ValidationService,
    FusionTransformationService,
    OdooTransformationService,
    DailyAggregationService,
    DailyInvoiceService,
    DailyInvoiceSchedulerService,
    ReadinessService,
    IntegrationRunService,
    OrderEnrichmentService,
    StalledOrdersService,
    OrderDiagnosticsService,
    AutoFixService,
    PipelineSchedulerService,
    SyncControlService,
    FusionMetadataService,
    BulkRetryService,
  ],
})
export class SyncModule {}
