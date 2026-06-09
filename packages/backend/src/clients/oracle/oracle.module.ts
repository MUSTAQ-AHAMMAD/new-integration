import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OracleClient } from './oracle.client';

@Module({
  imports: [ConfigModule],
  providers: [OracleClient],
  exports: [OracleClient],
})
export class OracleModule {}
