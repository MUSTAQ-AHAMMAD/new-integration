import { Module, forwardRef } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { QueuesModule } from '../queues/queues.module';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [forwardRef(() => QueuesModule), forwardRef(() => SyncModule)],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
