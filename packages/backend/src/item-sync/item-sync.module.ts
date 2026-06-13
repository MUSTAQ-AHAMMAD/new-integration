import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ItemSyncController } from './item-sync.controller';
import { ItemSyncService } from './item-sync.service';

@Module({
  imports: [PrismaModule, ClientsModule],
  controllers: [ItemSyncController],
  providers: [ItemSyncService],
  exports: [ItemSyncService],
})
export class ItemSyncModule {}
