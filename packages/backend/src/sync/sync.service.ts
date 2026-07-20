import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, MoreThan, Repository } from 'typeorm';
import { FailedTransaction } from '../database/entities/failed-transaction.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { SyncJob } from '../database/entities/sync-job.entity';
import { JobStatus, JobType, ScopeType, SyncStatus } from '../database/enums';
import { QueuesService } from '../queues/queues.service';
import { TimezoneService } from './timezone.service';
import { CreateSyncJobDto } from './dto/create-sync-job.dto';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  // Constants
  private readonly MAX_CSV_EXPORT_RECORDS = 5000;

  constructor(
    @InjectRepository(SyncJob)
    private readonly syncJobRepo: Repository<SyncJob>,
    @InjectRepository(OrderSyncQueue)
    private readonly orderSyncQueueRepo: Repository<OrderSyncQueue>,
    @InjectRepository(FailedTransaction)
    private readonly failedTransactionRepo: Repository<FailedTransaction>,
    private readonly queues: QueuesService,
    private readonly timezoneService: TimezoneService,
  ) {}

  async createSyncJob(dto: CreateSyncJobDto) {
    const scopeValue: Record<string, unknown> = {};
    if (dto.orderIds) scopeValue.orderIds = dto.orderIds;
    if (dto.branchCode) scopeValue.branchCode = dto.branchCode;
    if (dto.startDate) scopeValue.startDate = dto.startDate;
    if (dto.endDate) scopeValue.endDate = dto.endDate;
    if (dto.timezone) scopeValue.timezone = dto.timezone;

    const job = await this.syncJobRepo.save(
      this.syncJobRepo.create({
        jobType: dto.jobType as unknown as JobType,
        scopeType: dto.scopeType as unknown as ScopeType,
        scopeValue: scopeValue,
        createdBy: dto.createdBy || 'API',
      }),
    );

    let enqueuedCount = 0;
    let skippedCount = 0;
    const BATCH_SIZE = 5000;
    let cursorId: string | undefined;

    while (true) {
      const batch = await this.findOrdersByScope(dto, BATCH_SIZE, cursorId);
      if (batch.length === 0) break;

      cursorId = batch[batch.length - 1].id;

      const toSkipIds: string[] = [];
      const toEnqueue: {
        orderSyncQueueId: string;
        odooOrderId: string;
        branchCode: string;
        syncJobId: string;
      }[] = [];

      for (const order of batch) {
        if (!order.isPaid || order.isCancelled) {
          toSkipIds.push(order.id);
          skippedCount += 1;
        } else {
          toEnqueue.push({
            orderSyncQueueId: order.id,
            odooOrderId: order.odooOrderId,
            branchCode: order.branchCode,
            syncJobId: job.id,
          });
          enqueuedCount += 1;
        }
      }

      await Promise.all([
        toSkipIds.length > 0
          ? this.orderSyncQueueRepo.update(
              { id: In(toSkipIds) },
              { status: SyncStatus.SKIPPED },
            )
          : Promise.resolve(),
        toEnqueue.length > 0
          ? this.queues.enqueueOrderSyncBulk(toEnqueue)
          : Promise.resolve(),
      ]);

      if (batch.length < BATCH_SIZE) break;
    }

    const totalRecords = enqueuedCount + skippedCount;

    // Determine the correct initial status:
    // - COMPLETED: no records at all (nothing to do)
    // - PARTIAL: all records were immediately skipped (no Oracle pushes queued)
    // - PENDING: at least one order was enqueued for Oracle processing
    let finalStatus: JobStatus;
    if (totalRecords === 0) {
      finalStatus = JobStatus.COMPLETED;
    } else if (enqueuedCount === 0) {
      finalStatus = JobStatus.PARTIAL;
    } else {
      finalStatus = JobStatus.PENDING;
    }

    // processedRecords starts at skippedCount — the orders that were immediately
    // handled (marked SKIPPED) without going through the queue.
    // successCount starts at 0 — Oracle-synced counts are incremented by the
    // queue processor as each order is actually submitted to Oracle.
    await this.syncJobRepo.update(job.id, {
      totalRecords,
      processedRecords: skippedCount,
      successCount: 0,
      skippedCount,
      status: finalStatus,
      startedAt: totalRecords > 0 ? new Date() : undefined,
      completedAt: finalStatus === JobStatus.COMPLETED ? new Date() : undefined,
    });

    // The row was just created and updated by id, so it always exists.
    const saved = await this.syncJobRepo.findOne({ where: { id: job.id } });
    return saved as SyncJob;
  }

  async listSyncJobs(status?: string, limit = 50) {
    return this.syncJobRepo.find({
      where: status ? { status: status as JobStatus } : undefined,
      order: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getSyncJob(id: string) {
    const job = await this.syncJobRepo.findOne({ where: { id } });
    if (!job) throw new NotFoundException(`Sync job ${id} not found`);
    return job;
  }

  async cancelSyncJob(id: string) {
    const job = await this.getSyncJob(id);
    if (
      job.status !== JobStatus.PENDING &&
      job.status !== JobStatus.PROCESSING
    ) {
      throw new BadRequestException(
        `Cannot cancel job in status: ${job.status}`,
      );
    }

    await this.syncJobRepo.update(id, {
      status: JobStatus.CANCELLED,
      completedAt: new Date(),
    });

    return this.syncJobRepo.findOne({ where: { id } });
  }

  async retrySyncJob(id: string) {
    const job = await this.getSyncJob(id);
    const parsedScope = (job.scopeValue as Record<string, unknown>) ?? {};
    const dto: CreateSyncJobDto = {
      jobType: job.jobType as unknown as CreateSyncJobDto['jobType'],
      scopeType: job.scopeType as unknown as CreateSyncJobDto['scopeType'],
      orderIds: Array.isArray(parsedScope.orderIds)
        ? parsedScope.orderIds.map(String)
        : undefined,
      branchCode:
        typeof parsedScope.branchCode === 'string'
          ? parsedScope.branchCode
          : undefined,
      startDate:
        typeof parsedScope.startDate === 'string'
          ? parsedScope.startDate
          : undefined,
      endDate:
        typeof parsedScope.endDate === 'string'
          ? parsedScope.endDate
          : undefined,
      timezone:
        typeof parsedScope.timezone === 'string'
          ? parsedScope.timezone
          : undefined,
      createdBy: job.createdBy,
    };

    await this.syncJobRepo.increment({ id }, 'retryCount', 1);
    await this.syncJobRepo.update(id, {
      status: JobStatus.PENDING,
      errorMessage: null,
    });

    return this.createSyncJob(dto);
  }

  async getQueueStats() {
    return this.queues.getQueueStats();
  }

  async listOrderQueue(
    opts: {
      status?: string;
      branchCode?: string;
      search?: string;
      limit?: number;
      isCancelled?: boolean;
      isRefund?: boolean;
    } = {},
  ) {
    const { status, branchCode, search, limit = 200, isCancelled, isRefund } =
      opts;
    const take = Math.min(limit, 1000);

    const qb = this.orderSyncQueueRepo.createQueryBuilder('o');

    if (status && status !== 'ALL') {
      qb.andWhere('o.status = :status', { status });
    }
    if (branchCode && branchCode !== 'ALL') {
      qb.andWhere('o.branchCode = :branchCode', { branchCode });
    }
    if (typeof isCancelled === 'boolean') {
      qb.andWhere('o.isCancelled = :isCancelled', {
        isCancelled: isCancelled ? 1 : 0,
      });
    }
    if (typeof isRefund === 'boolean') {
      qb.andWhere('o.isRefund = :isRefund', { isRefund: isRefund ? 1 : 0 });
    }
    if (search) {
      const s = search.trim();
      qb.andWhere(
        '(LOWER(o.odooOrderNumber) LIKE LOWER(:search) OR LOWER(o.customerName) LIKE LOWER(:search))',
        { search: `%${s}%` },
      );
    }

    const orders = await qb
      .orderBy('o.createdAt', 'DESC')
      .take(take)
      .getMany();

    return this.attachFailedTransactions(orders, {
      onlyUnresolved: true,
      take: 5,
      select: true,
    });
  }

  async retryOrderQueueEntry(id: string) {
    const order = await this.orderSyncQueueRepo.findOne({ where: { id } });
    if (!order)
      throw new NotFoundException(`Order queue entry ${id} not found`);

    await this.orderSyncQueueRepo.update(id, { status: SyncStatus.PENDING });

    await this.queues.enqueueOrderSync({
      orderSyncQueueId: order.id,
      odooOrderId: order.odooOrderId,
      branchCode: order.branchCode,
      isRetry: true,
    });

    return { ok: true, id };
  }

  async getOrderStatus(odooOrderId: string) {
    const orders = await this.orderSyncQueueRepo.find({
      where: { odooOrderId },
    });
    return this.attachFailedTransactions(orders, { take: 5 });
  }

  async listFailedTransactions(limit = 50) {
    const failed = await this.failedTransactionRepo.find({
      where: { isResolved: false },
      relations: { orderSyncQueue: true },
      order: { createdAt: 'desc' },
      take: limit,
    });

    return failed.map((ft) => ({
      ...ft,
      orderSyncQueue: ft.orderSyncQueue
        ? {
            odooOrderNumber: ft.orderSyncQueue.odooOrderNumber,
            branchCode: ft.orderSyncQueue.branchCode,
          }
        : null,
    }));
  }

  async resolveFailedTransaction(
    id: string,
    resolvedBy: string,
    resolutionNote?: string,
  ) {
    await this.failedTransactionRepo.update(id, {
      isResolved: true,
      resolvedBy,
      resolvedAt: new Date(),
      resolutionNote: resolutionNote ?? null,
    });

    return this.failedTransactionRepo.findOne({ where: { id } });
  }

  private async findOrdersByScope(
    dto: CreateSyncJobDto,
    take?: number,
    cursorId?: string,
  ): Promise<OrderSyncQueue[]> {
    // Orders are sorted by `id` (CUID, lexicographically time-ordered) to
    // support stable cursor-based pagination across batches. This replaces
    // the previous `createdAt` / `orderDateUtc` ordering, which was not
    // suitable for keyset pagination because those columns are non-unique.
    //
    // Keyset pagination is expressed as `id > :cursorId` (TypeORM `MoreThan`)
    // combined with `ORDER BY id ASC`, matching Prisma's `cursor + skip:1`.
    const buildWhere = (
      base: Record<string, unknown>,
    ): Record<string, unknown> =>
      cursorId ? { ...base, id: MoreThan(cursorId) } : base;

    const options = (base: Record<string, unknown>) => ({
      where: buildWhere(base),
      order: { id: 'ASC' as const },
      ...(take !== undefined ? { take } : {}),
    });

    if (dto.scopeType === ScopeType.SINGLE_ORDER && dto.orderIds?.length) {
      return this.orderSyncQueueRepo.find(
        options({ odooOrderId: In(dto.orderIds) }),
      );
    }

    if (dto.scopeType === ScopeType.BRANCH && dto.branchCode) {
      return this.orderSyncQueueRepo.find(
        options({ branchCode: dto.branchCode }),
      );
    }

    if (
      dto.scopeType === ScopeType.DATE_RANGE &&
      dto.startDate &&
      dto.endDate
    ) {
      const timezone = dto.timezone ?? 'UTC';
      const range = this.timezoneService.getDateRangeUtc(
        dto.startDate,
        dto.endDate,
        timezone,
      );
      return this.orderSyncQueueRepo.find(
        options({ orderDateUtc: Between(range.start, range.end) }),
      );
    }

    if (
      dto.scopeType === ScopeType.BRANCH_DATE_RANGE &&
      dto.branchCode &&
      dto.startDate &&
      dto.endDate
    ) {
      const timezone = dto.timezone ?? 'UTC';
      const range = this.timezoneService.getDateRangeUtc(
        dto.startDate,
        dto.endDate,
        timezone,
      );
      return this.orderSyncQueueRepo.find(
        options({
          branchCode: dto.branchCode,
          orderDateUtc: Between(range.start, range.end),
        }),
      );
    }

    if (dto.scopeType === ScopeType.FAILED_ONLY) {
      return this.orderSyncQueueRepo.find(
        options({ status: SyncStatus.FAILED }),
      );
    }

    return this.orderSyncQueueRepo.find(options({}));
  }

  /**
   * Loads related FailedTransaction rows for a set of orders and attaches them
   * as `failedTransactions`. Prisma's per-relation `where`/`orderBy`/`take`
   * `include` has no direct `find` equivalent, so the children are fetched in a
   * single query and grouped in memory.
   */
  private async attachFailedTransactions<T extends { id: string }>(
    orders: T[],
    opts: { onlyUnresolved?: boolean; take: number; select?: boolean },
  ): Promise<(T & { failedTransactions: unknown[] })[]> {
    if (orders.length === 0) {
      return orders.map((o) => ({ ...o, failedTransactions: [] }));
    }

    const qb = this.failedTransactionRepo
      .createQueryBuilder('ft')
      .where('ft.orderSyncQueueId IN (:...ids)', {
        ids: orders.map((o) => o.id),
      });
    if (opts.onlyUnresolved) {
      qb.andWhere('ft.isResolved = :resolved', { resolved: 0 });
    }
    const allFailed = await qb.orderBy('ft.createdAt', 'DESC').getMany();

    const byOrder = new Map<string, FailedTransaction[]>();
    for (const ft of allFailed) {
      const key = ft.orderSyncQueueId ?? '';
      const list = byOrder.get(key) ?? [];
      if (list.length < opts.take) list.push(ft);
      byOrder.set(key, list);
    }

    return orders.map((o) => {
      const list = byOrder.get(o.id) ?? [];
      const failedTransactions = opts.select
        ? list.map((ft) => ({
            id: ft.id,
            errorType: ft.errorType,
            errorMessage: ft.errorMessage,
            retryCount: ft.retryCount,
            createdAt: ft.createdAt,
          }))
        : list;
      return { ...o, failedTransactions };
    });
  }

  /**
   * Re-processes orders that were previously skipped but should now be synced.
   * This is useful after expanding the isPaid state mapping to include more states.
   *
   * @param branchCode Optional filter by branch code
   * @param limit Maximum number of orders to re-process
   * @returns Count of orders re-queued for processing
   */
  async retrySkippedOrders(
    branchCode?: string,
    limit = 1000,
  ): Promise<{ updated: number; enqueued: number }> {
    // Find skipped orders that should actually be processed
    // (orders that were skipped but are now marked as paid)
    const skippedOrders = await this.orderSyncQueueRepo.find({
      where: {
        status: SyncStatus.SKIPPED,
        isPaid: true,
        isCancelled: false,
        ...(branchCode ? { branchCode } : {}),
      },
      take: limit,
      select: {
        id: true,
        odooOrderId: true,
        branchCode: true,
      },
    });

    if (skippedOrders.length === 0) {
      this.logger.log('No skipped orders found to retry');
      return { updated: 0, enqueued: 0 };
    }

    // Update status to PENDING
    const updateResult = await this.orderSyncQueueRepo.update(
      { id: In(skippedOrders.map((o) => o.id)) },
      { status: SyncStatus.PENDING },
    );

    // Enqueue for processing
    await this.queues.enqueueOrderSyncBulk(
      skippedOrders.map((order) => ({
        orderSyncQueueId: order.id,
        odooOrderId: order.odooOrderId,
        branchCode: order.branchCode,
        isRetry: true,
      })),
    );

    const updatedCount = updateResult.affected ?? 0;
    this.logger.log(
      `Re-queued ${updatedCount} previously skipped orders` +
        (branchCode ? ` for branch ${branchCode}` : ''),
    );

    return {
      updated: updatedCount,
      enqueued: skippedOrders.length,
    };
  }

  /**
   * Export failed transactions to CSV format
   */
  async exportFailedTransactionsCSV(): Promise<string> {
    const failedTransactions = await this.failedTransactionRepo.find({
      where: { isResolved: false },
      relations: { orderSyncQueue: true },
      order: { createdAt: 'desc' },
      take: this.MAX_CSV_EXPORT_RECORDS, // Limit to prevent memory issues
    });

    // Build CSV header
    const csvRows = [
      [
        'ID',
        'Order Number',
        'Branch Code',
        'Amount',
        'Currency',
        'Order Date',
        'Error Type',
        'Error Message',
        'Retry Count',
        'Created At',
      ].join(','),
    ];

    // Add data rows
    for (const ft of failedTransactions) {
      const row = [
        ft.id,
        ft.orderSyncQueue?.odooOrderNumber ?? 'N/A',
        ft.orderSyncQueue?.branchCode ?? 'N/A',
        ft.orderSyncQueue?.totalAmount?.toString() ?? '0',
        ft.orderSyncQueue?.currency ?? 'AED',
        ft.orderSyncQueue?.orderDate?.toISOString() ?? 'N/A',
        ft.errorType,
        `"${ft.errorMessage.replace(/"/g, '""')}"`, // Escape quotes in CSV
        ft.retryCount.toString(),
        ft.createdAt.toISOString(),
      ].join(',');
      csvRows.push(row);
    }

    return csvRows.join('\n');
  }

  /**
   * List failed orders with details
   */
  async listFailedOrders(limit = 100) {
    const orders = await this.orderSyncQueueRepo.find({
      where: { status: SyncStatus.FAILED },
      order: { updatedAt: 'desc' },
      take: limit,
    });

    const withFailures = await this.attachFailedTransactions(orders, {
      onlyUnresolved: true,
      take: 1,
    });

    return withFailures.map((order) => {
      const failedTransactions = order.failedTransactions as FailedTransaction[];
      return {
        id: order.id,
        orderNumber: order.odooOrderNumber,
        orderId: order.odooOrderId,
        branchCode: order.branchCode,
        branchName: order.branchName,
        totalAmount: order.totalAmount,
        currency: order.currency,
        orderDate: order.orderDate,
        syncAttempts: order.syncAttempts,
        lastSyncAt: order.lastSyncAt,
        customerName: order.customerName,
        errorDetails: failedTransactions[0]
          ? {
              errorType: failedTransactions[0].errorType,
              errorMessage: failedTransactions[0].errorMessage,
              errorStack: failedTransactions[0].errorStack,
              createdAt: failedTransactions[0].createdAt,
            }
          : null,
      };
    });
  }

  /**
   * Retry all failed orders
   */
  async retryAllFailedOrders(): Promise<{
    updated: number;
    enqueued: number;
  }> {
    const failedOrders = await this.orderSyncQueueRepo.find({
      where: { status: SyncStatus.FAILED },
      select: {
        id: true,
        odooOrderId: true,
        branchCode: true,
      },
    });

    if (failedOrders.length === 0) {
      this.logger.log('No failed orders found to retry');
      return { updated: 0, enqueued: 0 };
    }

    // Update status to PENDING
    const updateResult = await this.orderSyncQueueRepo.update(
      { id: In(failedOrders.map((o) => o.id)) },
      { status: SyncStatus.PENDING },
    );

    // Enqueue for processing
    await this.queues.enqueueOrderSyncBulk(
      failedOrders.map((order) => ({
        orderSyncQueueId: order.id,
        odooOrderId: order.odooOrderId,
        branchCode: order.branchCode,
        isRetry: true,
      })),
    );

    const updatedCount = updateResult.affected ?? 0;
    this.logger.log(`Re-queued ${updatedCount} failed orders for retry`);

    return { updated: updatedCount, enqueued: failedOrders.length };
  }
}
