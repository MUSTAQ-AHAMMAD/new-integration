import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { IbqBackupController } from './ibq-backup.controller';
import { IbqBackupService } from './ibq-backup.service';

@Module({
  imports: [PrismaModule, forwardRef(() => SyncModule)],
  controllers: [IbqBackupController],
  providers: [IbqBackupService],
  exports: [IbqBackupService],
})
export class IbqBackupModule {}
