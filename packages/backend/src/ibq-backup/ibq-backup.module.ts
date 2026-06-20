import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { IbqBackupController } from './ibq-backup.controller';
import { IbqBackupService } from './ibq-backup.service';

@Module({
  imports: [PrismaModule],
  controllers: [IbqBackupController],
  providers: [IbqBackupService],
  exports: [IbqBackupService],
})
export class IbqBackupModule {}
