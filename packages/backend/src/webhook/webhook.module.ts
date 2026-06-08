import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [SyncModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}
