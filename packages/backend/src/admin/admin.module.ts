import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { OracleNativeService } from './oracle-native.service';
import { SyncControlController } from './sync-control.controller';
import { AdminDiagnosticsController } from './admin-diagnostics.controller';
import { RegisterAccountsController } from './register-accounts.controller';
import { RegisterAccountsService } from './register-accounts.service';
import { SyncModule } from '../sync/sync.module';
import { OracleModule } from '../clients/oracle/oracle.module';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionCredential } from '../database/entities/fusion-credential.entity';
import { FusionCustomerAccount } from '../database/entities/fusion-customer-account.entity';
import { FusionReceiptMethod } from '../database/entities/fusion-receipt-method.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { IbqCredential } from '../database/entities/ibq-credential.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { OutletIntegrationConfig } from '../database/entities/outlet-integration-config.entity';
import { SalesIntegrationStatus } from '../database/entities/sales-integration-status.entity';
import { ServiceProviderJournalMeta } from '../database/entities/service-provider-journal-meta.entity';
import { SyncControl } from '../database/entities/sync-control.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqDiscountItem } from '../database/entities/vend-hq-discount-item.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { VendHqOutlet } from '../database/entities/vend-hq-outlet.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
import { VendHqServiceProvider } from '../database/entities/vend-hq-service-provider.entity';
import { VendHqTaxMeta } from '../database/entities/vend-hq-tax-meta.entity';

@Module({
  imports: [
    ConfigModule,
    MulterModule.register({ limits: { fileSize: 50 * 1024 * 1024 } }),
    forwardRef(() => SyncModule),
    OracleModule,
    TypeOrmModule.forFeature([
      OutletIntegrationConfig,
      FusionBusinessUnitMap,
      FusionReceiptMethod,
      FusionSalesMetadata,
      ServiceProviderJournalMeta,
      FusionCredential,
      FusionCustomerAccount,
      VendHqCredential,
      VendHqOutlet,
      VendHqRegister,
      VendHqServiceProvider,
      VendHqDiscountItem,
      VendHqTaxMeta,
      VendHqItemMeta,
      SalesIntegrationStatus,
      OrderSyncQueue,
      OdooCredential,
      IbqCredential,
      SyncJob,
      SyncControl,
    ]),
  ],
  controllers: [
    // Specific admin sub-resources MUST be registered before AdminController,
    // whose catch-all `:table` / `:table/:id` routes would otherwise shadow
    // e.g. GET /admin/sync-control/:serviceName → "Unknown table: sync-control".
    SyncControlController,
    AdminDiagnosticsController,
    RegisterAccountsController,
    AdminController,
  ],
  providers: [AdminService, OracleNativeService, RegisterAccountsService],
  exports: [OracleNativeService],
})
export class AdminModule {}
