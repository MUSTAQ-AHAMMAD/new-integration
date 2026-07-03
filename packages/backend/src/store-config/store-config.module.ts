import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StoreConfigController } from './store-config.controller';
import { StoreConfigService } from './store-config.service';
import { BatchOperationsService } from './batch-operations.service';

@Module({
  imports: [AlertsModule, PrismaModule],
  controllers: [StoreConfigController],
  providers: [StoreConfigService, BatchOperationsService],
  exports: [StoreConfigService, BatchOperationsService],
})
export class StoreConfigModule {}
