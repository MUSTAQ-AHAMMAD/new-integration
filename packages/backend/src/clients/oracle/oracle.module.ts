import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OracleClient } from './oracle.client';
import { OracleSoapClient } from './oracle-soap.client';
import { FusionCredentialResolver } from './fusion-credential.resolver';
import { OracleUomService } from './oracle-uom.service';
import { OracleTaxService } from './oracle-tax.service';
import { OracleCustomerService } from './oracle-customer.service';

@Module({
  imports: [ConfigModule],
  providers: [
    FusionCredentialResolver,
    OracleClient,
    OracleSoapClient,
    OracleUomService,
    OracleTaxService,
    OracleCustomerService,
  ],
  exports: [
    FusionCredentialResolver,
    OracleClient,
    OracleSoapClient,
    OracleUomService,
    OracleTaxService,
    OracleCustomerService,
  ],
})
export class OracleModule {}
