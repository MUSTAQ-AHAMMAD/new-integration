import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JobStatus, Prisma, ScopeType, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { TimezoneService } from './timezone.service';
import { CreateSyncJobDto } from './dto/create-sync-job.dto';

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly timezoneService: TimezoneService,
  ) {}

  async createSyncJob(dto: CreateSyncJobDto) {
    const scopeValue: Record<string, Prisma.InputJsonValue> = {};
    if (dto.orderIds) scopeValue.orderIds = dto.orderIds;
    if (dto.branchCode) scopeValue.branchCode = dto.branchCode;
    if (dto.startDate) scopeValue.startDate = dto.startDate;
    if (dto.endDate) scopeValue.endDate = dto.endDate;
    if (dto.timezone) scopeValue.timezone = dto.timezone;

    const job = await this.prisma.syncJob.create({
      data: {
        jobType: dto.jobType,
        scopeType: dto.scopeType,
        scopeValue: scopeValue,
        createdBy: dto.createdBy || 'API',
      },
    });

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
          ? this.prisma.orderSyncQueue.updateMany({
              where: { id: { in: toSkipIds } },
              data: { status: SyncStatus.SKIPPED },
            })
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
    return this.prisma.syncJob.update({
      where: { id: job.id },
      data: {
        totalRecords,
        processedRecords: skippedCount,
        successCount: 0,
        skippedCount,
        status: finalStatus,
        startedAt: totalRecords > 0 ? new Date() : undefined,
        completedAt:
          finalStatus === JobStatus.COMPLETED ? new Date() : undefined,
      },
    });
  }

  async listSyncJobs(status?: string, limit = 50) {
    return this.prisma.syncJob.findMany({
      where: status ? { status: status as JobStatus } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getSyncJob(id: string) {
    const job = await this.prisma.syncJob.findUnique({ where: { id } });
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

    return this.prisma.syncJob.update({
      where: { id },
      data: { status: JobStatus.CANCELLED, completedAt: new Date() },
    });
  }

  async retrySyncJob(id: string) {
    const job = await this.getSyncJob(id);
    const parsedScope = job.scopeValue as Prisma.JsonObject;
    const dto: CreateSyncJobDto = {
      jobType: job.jobType,
      scopeType: job.scopeType,
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

    await this.prisma.syncJob.update({
      where: { id },
      data: {
        status: JobStatus.PENDING,
        retryCount: { increment: 1 },
        errorMessage: null,
      },
    });

    return this.createSyncJob(dto);
  }

  async getQueueStats() {
    return this.queues.getQueueStats();
  }

  async getOrderStatus(odooOrderId: string) {
    return this.prisma.orderSyncQueue.findMany({
      where: { odooOrderId },
      include: {
        failedTransactions: { take: 5, orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async listFailedTransactions(limit = 50) {
    return this.prisma.failedTransaction.findMany({
      where: { isResolved: false },
      include: {
        orderSyncQueue: {
          select: { odooOrderNumber: true, branchCode: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async resolveFailedTransaction(
    id: string,
    resolvedBy: string,
    resolutionNote?: string,
  ) {
    return this.prisma.failedTransaction.update({
      where: { id },
      data: {
        isResolved: true,
        resolvedBy,
        resolvedAt: new Date(),
        resolutionNote,
      },
    });
  }

  private async findOrdersByScope(
    dto: CreateSyncJobDto,
    take?: number,
    cursorId?: string,
  ) {
    // Orders are sorted by `id` (CUID, lexicographically time-ordered) to
    // support stable cursor-based pagination across batches. This replaces
    // the previous `createdAt` / `orderDateUtc` ordering, which was not
    // suitable for keyset pagination because those columns are non-unique.
    const pagination =
      take !== undefined
        ? {
            take,
            ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
          }
        : {};

    if (dto.scopeType === ScopeType.SINGLE_ORDER && dto.orderIds?.length) {
      return this.prisma.orderSyncQueue.findMany({
        where: { odooOrderId: { in: dto.orderIds } },
        orderBy: { id: 'asc' },
        ...pagination,
      });
    }

    if (dto.scopeType === ScopeType.BRANCH && dto.branchCode) {
      return this.prisma.orderSyncQueue.findMany({
        where: { branchCode: dto.branchCode },
        orderBy: { id: 'asc' },
        ...pagination,
      });
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
      return this.prisma.orderSyncQueue.findMany({
        where: { orderDateUtc: { gte: range.start, lte: range.end } },
        orderBy: { id: 'asc' },
        ...pagination,
      });
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
      return this.prisma.orderSyncQueue.findMany({
        where: {
          branchCode: dto.branchCode,
          orderDateUtc: { gte: range.start, lte: range.end },
        },
        orderBy: { id: 'asc' },
        ...pagination,
      });
    }

    if (dto.scopeType === ScopeType.FAILED_ONLY) {
      return this.prisma.orderSyncQueue.findMany({
        where: { status: SyncStatus.FAILED },
        orderBy: { id: 'asc' },
        ...pagination,
      });
    }

    return this.prisma.orderSyncQueue.findMany({
      orderBy: { id: 'asc' },
      ...pagination,
    });
  }
}
