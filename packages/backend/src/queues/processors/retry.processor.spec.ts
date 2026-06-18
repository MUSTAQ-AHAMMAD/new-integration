// Mock the queues module before NestJS decorators are evaluated
jest.mock('../queues.module', () => ({
  QUEUE_NAMES: {
    ORDER_SYNC: 'order-sync',
    INVENTORY_SYNC: 'inventory-sync',
    RETRY: 'retry',
    NOTIFICATIONS: 'notifications',
  },
  QueuesModule: class QueuesModule {},
}));

import { Job } from 'bull';
import { QueuesService } from '../queues.service';
import { RetryProcessor } from './retry.processor';

function makeJob(
  data: Partial<{
    orderSyncQueueId: string;
    odooOrderId: string;
    branchCode: string;
    syncJobId: string;
    isRetry: boolean;
  }> = {},
): Job {
  return {
    id: 'job-1',
    data: {
      orderSyncQueueId: 'q-001',
      odooOrderId: 'ORD-001',
      branchCode: 'DXB',
      ...data,
    },
  } as unknown as Job;
}

describe('RetryProcessor', () => {
  let processor: RetryProcessor;
  let mockQueuesService: jest.Mocked<Pick<QueuesService, 'enqueueOrderSync'>>;

  beforeEach(() => {
    mockQueuesService = {
      enqueueOrderSync: jest.fn().mockResolvedValue({ id: 'enqueued-1' }),
    };

    processor = new RetryProcessor(
      mockQueuesService as unknown as QueuesService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('re-enqueues the order with isRetry flag set to true', async () => {
    const job = makeJob({ odooOrderId: 'ORD-001', branchCode: 'DXB' });

    await processor.handleRetry(job);

    expect(mockQueuesService.enqueueOrderSync).toHaveBeenCalledWith(
      expect.objectContaining({
        odooOrderId: 'ORD-001',
        branchCode: 'DXB',
        isRetry: true,
      }),
    );
  });

  it('preserves all existing job data when re-enqueueing', async () => {
    const job = makeJob({
      orderSyncQueueId: 'q-special',
      odooOrderId: 'ORD-999',
      branchCode: 'AUH',
      syncJobId: 'sync-42',
    });

    await processor.handleRetry(job);

    expect(mockQueuesService.enqueueOrderSync).toHaveBeenCalledWith(
      expect.objectContaining({
        orderSyncQueueId: 'q-special',
        odooOrderId: 'ORD-999',
        branchCode: 'AUH',
        syncJobId: 'sync-42',
      }),
    );
  });

  it('calls enqueueOrderSync exactly once per retry job', async () => {
    await processor.handleRetry(makeJob());

    expect(mockQueuesService.enqueueOrderSync).toHaveBeenCalledTimes(1);
  });

  it('propagates errors thrown by enqueueOrderSync', async () => {
    mockQueuesService.enqueueOrderSync.mockRejectedValueOnce(
      new Error('Queue unavailable'),
    );

    await expect(processor.handleRetry(makeJob())).rejects.toThrow(
      'Queue unavailable',
    );
  });

  it('overrides a pre-existing isRetry=false flag to true', async () => {
    const job = makeJob({ isRetry: false });

    await processor.handleRetry(job);

    const callArg = (mockQueuesService.enqueueOrderSync as jest.Mock).mock
      .calls[0][0] as { isRetry: boolean };
    expect(callArg.isRetry).toBe(true);
  });
});
