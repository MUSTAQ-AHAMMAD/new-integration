import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookEvent } from '../database/entities/webhook-event.entity';
import { SyncModule } from '../sync/sync.module';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([WebhookEvent]), SyncModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}
