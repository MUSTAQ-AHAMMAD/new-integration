import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { GatewayModule } from '../gateway/gateway.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [TerminusModule, GatewayModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
