import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule } from '../clients/clients.module';
import { BackupVendHqSale } from '../database/entities/backup-vend-hq-sale.entity';
import { BackupVendHqLineItem } from '../database/entities/backup-vend-hq-line-item.entity';
import { BackupVendHqPayment } from '../database/entities/backup-vend-hq-payment.entity';
import { SaleSyncStatus } from '../database/entities/sale-sync-status.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { SalesIntegrationStatus } from '../database/entities/sales-integration-status.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionStandardReceipt } from '../database/entities/fusion-standard-receipt.entity';
import { FusionMiscReceipt } from '../database/entities/fusion-misc-receipt.entity';
import { FusionApplyReceipt } from '../database/entities/fusion-apply-receipt.entity';
import { FusionJournalHeader } from '../database/entities/fusion-journal-header.entity';
import { FusionJournalLine } from '../database/entities/fusion-journal-line.entity';
import { SyncModule } from '../sync/sync.module';
import { VendHqBackupController } from './vendhq-backup.controller';
import { VendHqSalesBackupService } from './vendhq-backup.service';
import { VendHqToOracleSyncService } from './vendhq-to-oracle-sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      VendHqCredential,
      SalesIntegrationStatus,
      BackupVendHqSale,
      BackupVendHqLineItem,
      BackupVendHqPayment,
      SaleSyncStatus,
      VendHqItemMeta,
      FusionInvoiceHeader,
      FusionInvoiceLine,
      FusionStandardReceipt,
      FusionMiscReceipt,
      FusionApplyReceipt,
      FusionJournalHeader,
      FusionJournalLine,
    ]),
    forwardRef(() => SyncModule),
    ClientsModule,
  ],
  controllers: [VendHqBackupController],
  providers: [VendHqSalesBackupService, VendHqToOracleSyncService],
  exports: [VendHqSalesBackupService, VendHqToOracleSyncService],
})
export class VendHqBackupModule {}
