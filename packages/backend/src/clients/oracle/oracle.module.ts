import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BackupOdooOrderLine } from '../../database/entities/backup-odoo-order-line.entity';
import { FusionCredential } from '../../database/entities/fusion-credential.entity';
import { FusionInvoiceLine } from '../../database/entities/fusion-invoice-line.entity';
import { StoreConfiguration } from '../../database/entities/store-configuration.entity';
import { VendHqItemMeta } from '../../database/entities/vend-hq-item-meta.entity';
import { OracleClient } from './oracle.client';
import { OracleSoapClient } from './oracle-soap.client';
import { FusionCredentialResolver } from './fusion-credential.resolver';
import { OracleUomService } from './oracle-uom.service';
import { OracleTaxService } from './oracle-tax.service';
import { OracleCustomerService } from './oracle-customer.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      FusionCredential,
      StoreConfiguration,
      FusionInvoiceLine,
      VendHqItemMeta,
      BackupOdooOrderLine,
    ]),
  ],
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
