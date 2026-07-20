import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertsModule } from '../alerts/alerts.module';
import { AlertLog } from '../database/entities/alert-log.entity';
import { BackupIbqOrder } from '../database/entities/backup-ibq-order.entity';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { ConfigurationBackup } from '../database/entities/configuration-backup.entity';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
import { StoreConfigController } from './store-config.controller';
import { StoreConfigService } from './store-config.service';
import { BatchOperationsService } from './batch-operations.service';

@Module({
  imports: [
    AlertsModule,
    TypeOrmModule.forFeature([
      StoreConfiguration,
      FusionSalesMetadata,
      FusionBusinessUnitMap,
      VendHqRegister,
      BackupOdooOrder,
      BackupIbqOrder,
      ConfigurationBackup,
      AlertLog,
    ]),
  ],
  controllers: [StoreConfigController],
  providers: [StoreConfigService, BatchOperationsService],
  exports: [StoreConfigService, BatchOperationsService],
})
export class StoreConfigModule {}
