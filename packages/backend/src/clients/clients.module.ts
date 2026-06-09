import { Module } from '@nestjs/common';
import { CircuitBreakerService } from './circuit-breaker.service';
import { OdooModule } from './odoo/odoo.module';
import { OracleModule } from './oracle/oracle.module';

@Module({
  imports: [OdooModule, OracleModule],
  providers: [CircuitBreakerService],
  exports: [CircuitBreakerService, OdooModule, OracleModule],
})
export class ClientsModule {}
