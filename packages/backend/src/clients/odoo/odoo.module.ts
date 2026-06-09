import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OdooClient } from './odoo.client';

@Module({
  imports: [ConfigModule],
  providers: [OdooClient],
  exports: [OdooClient],
})
export class OdooModule {}
