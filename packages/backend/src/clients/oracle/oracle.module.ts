import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OracleClient } from './oracle.client';
import { OracleSoapClient } from './oracle-soap.client';
import { FusionCredentialResolver } from './fusion-credential.resolver';

@Module({
  imports: [ConfigModule],
  providers: [FusionCredentialResolver, OracleClient, OracleSoapClient],
  exports: [FusionCredentialResolver, OracleClient, OracleSoapClient],
})
export class OracleModule {}
