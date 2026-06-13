import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentMappingController } from './payment-mapping.controller';
import { PaymentMappingService } from './payment-mapping.service';

@Module({
  imports: [AlertsModule, PrismaModule],
  controllers: [PaymentMappingController],
  providers: [PaymentMappingService],
  exports: [PaymentMappingService],
})
export class PaymentMappingModule {}
