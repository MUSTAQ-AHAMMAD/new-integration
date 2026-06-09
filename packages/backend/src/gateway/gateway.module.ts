import { Module } from '@nestjs/common';
import { IntegrationGateway } from './integration.gateway';
import { GatewayService } from './gateway.service';

@Module({
  providers: [IntegrationGateway, GatewayService],
  exports: [GatewayService],
})
export class GatewayModule {}
