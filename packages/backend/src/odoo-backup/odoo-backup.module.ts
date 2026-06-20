import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OdooBackupController } from './odoo-backup.controller';
import { OdooBackupService } from './odoo-backup.service';

@Module({
  imports: [PrismaModule, ClientsModule],
  controllers: [OdooBackupController],
  providers: [OdooBackupService],
  exports: [OdooBackupService],
})
export class OdooBackupModule {}
