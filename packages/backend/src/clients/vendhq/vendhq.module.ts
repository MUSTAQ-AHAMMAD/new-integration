import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VendHqClient } from './vendhq.client';

@Module({
  imports: [ConfigModule],
  providers: [VendHqClient],
  exports: [VendHqClient],
})
export class VendHqModule {}
