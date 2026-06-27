import { Module, forwardRef } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { FusionInvToVendHqController } from './fusion-inv-to-vendhq.controller';
import { FusionInvToVendHqService } from './fusion-inv-to-vendhq.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [PrismaModule, ClientsModule, forwardRef(() => SyncModule)],
  controllers: [InventoryController, FusionInvToVendHqController],
  providers: [InventoryService, FusionInvToVendHqService],
  exports: [InventoryService, FusionInvToVendHqService],
})
export class InventoryModule {}
