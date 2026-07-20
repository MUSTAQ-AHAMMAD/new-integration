import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule } from '../clients/clients.module';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { SyncModule } from '../sync/sync.module';
import { CreditMemoService } from './credit-memo.service';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

@Module({
  // Oracle repositories (TypeORM) for this module's entities;
  // SyncModule → OdooTransformationService + IdempotencyService;
  // ClientsModule → OracleSoapClient + CircuitBreakerService.
  imports: [
    TypeOrmModule.forFeature([
      RefundTracking,
      OrderSyncQueue,
      StoreConfiguration,
      BackupOdooOrder,
    ]),
    SyncModule,
    ClientsModule,
  ],
  controllers: [RefundsController],
  providers: [RefundsService, CreditMemoService],
  exports: [RefundsService, CreditMemoService],
})
export class RefundsModule {}
