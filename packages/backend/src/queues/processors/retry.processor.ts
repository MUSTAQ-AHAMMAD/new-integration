import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { QUEUE_NAMES } from '../queues.module';
import { OrderSyncJobData, QueuesService } from '../queues.service';

@Processor(QUEUE_NAMES.RETRY)
export class RetryProcessor {
  private readonly logger = new Logger(RetryProcessor.name);

  constructor(private readonly queuesService: QueuesService) {}

  @Process('retry')
  async handleRetry(job: Job<OrderSyncJobData>) {
    this.logger.log(`Retrying order: ${job.data.odooOrderId}`);
    await this.queuesService.enqueueOrderSync({ ...job.data, isRetry: true });
  }
}
