import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule } from '../clients/clients.module';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { BackupOdooOrderPayment } from '../database/entities/backup-odoo-order-payment.entity';
import { OdooBackupState } from '../database/entities/odoo-backup-state.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { SyncModule } from '../sync/sync.module';
import { OdooBackupDiagnosticsController } from './diagnostic.controller';
import { OdooBackupController } from './odoo-backup.controller';
import { OdooBackupService } from './odoo-backup.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BackupOdooOrder,
      BackupOdooOrderLine,
      BackupOdooOrderPayment,
      OdooBackupState,
      OdooCredential,
      StoreConfiguration,
    ]),
    ClientsModule,
    forwardRef(() => SyncModule),
  ],
  controllers: [OdooBackupController, OdooBackupDiagnosticsController],
  providers: [OdooBackupService],
  exports: [OdooBackupService],
})
export class OdooBackupModule {}
