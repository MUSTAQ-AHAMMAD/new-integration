import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule } from '../clients/clients.module';
import { FusionInvTxn } from '../database/entities/fusion-inv-txn.entity';
import { InventorySyncTracker } from '../database/entities/inventory-sync-tracker.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { VendHqOutlet } from '../database/entities/vend-hq-outlet.entity';
import { SyncModule } from '../sync/sync.module';
import { FusionInvToVendHqController } from './fusion-inv-to-vendhq.controller';
import { FusionInvToVendHqService } from './fusion-inv-to-vendhq.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InventorySyncTracker,
      VendHqCredential,
      VendHqOutlet,
      VendHqItemMeta,
      FusionInvTxn,
    ]),
    ClientsModule,
    forwardRef(() => SyncModule),
  ],
  controllers: [InventoryController, FusionInvToVendHqController],
  providers: [InventoryService, FusionInvToVendHqService],
  exports: [InventoryService, FusionInvToVendHqService],
})
export class InventoryModule {}
