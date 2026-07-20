import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BackupIbqOrder } from '../database/entities/backup-ibq-order.entity';
import { BackupIbqOrderLine } from '../database/entities/backup-ibq-order-line.entity';
import { BackupIbqOrderPayment } from '../database/entities/backup-ibq-order-payment.entity';
import { IbqCredential } from '../database/entities/ibq-credential.entity';
import { SalesIntegrationStatus } from '../database/entities/sales-integration-status.entity';
import { SyncModule } from '../sync/sync.module';
import { IbqBackupController } from './ibq-backup.controller';
import { IbqBackupService } from './ibq-backup.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      IbqCredential,
      SalesIntegrationStatus,
      BackupIbqOrder,
      BackupIbqOrderLine,
      BackupIbqOrderPayment,
    ]),
    forwardRef(() => SyncModule),
  ],
  controllers: [IbqBackupController],
  providers: [IbqBackupService],
  exports: [IbqBackupService],
})
export class IbqBackupModule {}
