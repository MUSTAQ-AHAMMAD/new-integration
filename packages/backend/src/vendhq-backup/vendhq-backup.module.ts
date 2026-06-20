import { Module, forwardRef } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { VendHqBackupController } from './vendhq-backup.controller';
import { VendHqSalesBackupService } from './vendhq-backup.service';
import { VendHqToOracleSyncService } from './vendhq-to-oracle-sync.service';

@Module({
  imports: [PrismaModule, forwardRef(() => SyncModule), ClientsModule],
  controllers: [VendHqBackupController],
  providers: [VendHqSalesBackupService, VendHqToOracleSyncService],
  exports: [VendHqSalesBackupService, VendHqToOracleSyncService],
})
export class VendHqBackupModule {}
