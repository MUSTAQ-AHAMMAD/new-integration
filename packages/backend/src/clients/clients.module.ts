import { Module } from '@nestjs/common';
import { CircuitBreakerService } from './circuit-breaker.service';
import { OdooModule } from './odoo/odoo.module';
import { OracleModule } from './oracle/oracle.module';
import { VendHqModule } from './vendhq/vendhq.module';

@Module({
  imports: [OdooModule, OracleModule, VendHqModule],
  providers: [CircuitBreakerService],
  exports: [CircuitBreakerService, OdooModule, OracleModule, VendHqModule],
})
export class ClientsModule {}
