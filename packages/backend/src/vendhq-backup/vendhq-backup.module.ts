import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VendHqSalesBackupService } from './vendhq-backup.service';
import { VendHqBackupController } from './vendhq-backup.controller';

@Module({
  imports: [PrismaModule],
  controllers: [VendHqBackupController],
  providers: [VendHqSalesBackupService],
  exports: [VendHqSalesBackupService],
})
export class VendHqBackupModule {}
