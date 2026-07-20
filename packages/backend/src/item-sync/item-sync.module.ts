import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule } from '../clients/clients.module';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { SyncModule } from '../sync/sync.module';
import { AdminModule } from '../admin/admin.module';
import { ItemSyncController } from './item-sync.controller';
import { ItemSyncService } from './item-sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([VendHqItemMeta]),
    ClientsModule,
    forwardRef(() => SyncModule),
    AdminModule,
  ],
  controllers: [ItemSyncController],
  providers: [ItemSyncService],
  exports: [ItemSyncService],
})
export class ItemSyncModule {}
