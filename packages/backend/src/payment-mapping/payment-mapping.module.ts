import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertsModule } from '../alerts/alerts.module';
import { PaymentMethodMapping } from '../database/entities/payment-method-mapping.entity';
import { PaymentMappingController } from './payment-mapping.controller';
import { PaymentMappingService } from './payment-mapping.service';

@Module({
  imports: [AlertsModule, TypeOrmModule.forFeature([PaymentMethodMapping])],
  controllers: [PaymentMappingController],
  providers: [PaymentMappingService],
  exports: [PaymentMappingService],
})
export class PaymentMappingModule {}
