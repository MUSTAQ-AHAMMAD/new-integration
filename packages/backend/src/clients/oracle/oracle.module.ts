import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OracleClient } from './oracle.client';
import { OracleSoapClient } from './oracle-soap.client';

@Module({
  imports: [ConfigModule],
  providers: [OracleClient, OracleSoapClient],
  exports: [OracleClient, OracleSoapClient],
})
export class OracleModule {}
