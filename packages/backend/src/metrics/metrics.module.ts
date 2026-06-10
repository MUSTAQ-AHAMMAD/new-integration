import { Module, forwardRef } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { QueuesModule } from '../queues/queues.module';

@Module({
  imports: [forwardRef(() => QueuesModule)],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
