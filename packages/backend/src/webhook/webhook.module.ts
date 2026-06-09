import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SyncModule } from '../sync/sync.module';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [ConfigModule, SyncModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}
