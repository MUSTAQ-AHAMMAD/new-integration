import { Module, forwardRef } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { OdooBackupDiagnosticsController } from './diagnostic.controller';
import { OdooBackupController } from './odoo-backup.controller';
import { OdooBackupService } from './odoo-backup.service';

@Module({
  imports: [PrismaModule, ClientsModule, forwardRef(() => SyncModule)],
  controllers: [OdooBackupController, OdooBackupDiagnosticsController],
  providers: [OdooBackupService],
  exports: [OdooBackupService],
})
export class OdooBackupModule {}
