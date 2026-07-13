import { Module, forwardRef } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { AdminModule } from '../admin/admin.module';
import { ItemSyncController } from './item-sync.controller';
import { ItemSyncService } from './item-sync.service';

@Module({
  imports: [
    PrismaModule,
    ClientsModule,
    forwardRef(() => SyncModule),
    AdminModule,
  ],
  controllers: [ItemSyncController],
  providers: [ItemSyncService],
  exports: [ItemSyncService],
})
export class ItemSyncModule {}
