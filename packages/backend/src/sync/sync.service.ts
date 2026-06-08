import { Injectable, NotFoundException } from '@nestjs/common';
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
    const scopeValue: Record<string, unknown> = {};
    if (dto.orderIds) scopeValue.orderIds = dto.orderIds;
    if (dto.branchCode) scopeValue.branchCode = dto.branchCode;
    if (dto.startDate) scopeValue.startDate = dto.startDate;
    if (dto.endDate) scopeValue.endDate = dto.endDate;

    const job = await this.prisma.syncJob.create({
      data: {
        jobType: dto.jobType,
        scopeType: dto.scopeType,
        scopeValue,
        createdBy: dto.createdBy || 'API',
      },
    });

    const orders = await this.findOrdersByScope(dto);
    let successCount = 0;
    let skippedCount = 0;

    for (const order of orders) {
      if (!order.isPaid || order.isCancelled) {
        await this.prisma.orderSyncQueue.update({
          where: { id: order.id },
          data: { status: SyncStatus.SKIPPED },
        });
        skippedCount += 1;
        continue;
      }

      await this.queues.enqueueOrderSync({
        orderSyncQueueId: order.id,
        odooOrderId: order.odooOrderId,
        branchCode: order.branchCode,
      });
      successCount += 1;
    }

    const finalStatus = successCount === 0 && skippedCount > 0 ? JobStatus.PARTIAL : JobStatus.PENDING;

    return this.prisma.syncJob.update({
      where: { id: job.id },
      data: {
        totalRecords: orders.length,
        processedRecords: successCount + skippedCount,
        successCount,
        skippedCount,
        status: finalStatus,
        startedAt: orders.length ? new Date() : undefined,
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
    if (![JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status)) {
      throw new Error(`Cannot cancel job in status: ${job.status}`);
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
      orderIds: Array.isArray(parsedScope.orderIds) ? parsedScope.orderIds.map(String) : undefined,
      branchCode: typeof parsedScope.branchCode === 'string' ? parsedScope.branchCode : undefined,
      startDate: typeof parsedScope.startDate === 'string' ? parsedScope.startDate : undefined,
      endDate: typeof parsedScope.endDate === 'string' ? parsedScope.endDate : undefined,
      createdBy: job.createdBy,
    };

    await this.prisma.syncJob.update({
      where: { id },
      data: { status: JobStatus.PENDING, retryCount: { increment: 1 }, errorMessage: null },
    });

    return this.createSyncJob(dto);
  }

  async getQueueStats() {
    return this.queues.getQueueStats();
  }

  async getOrderStatus(odooOrderId: string) {
    return this.prisma.orderSyncQueue.findMany({
      where: { odooOrderId },
      include: { failedTransactions: { take: 5, orderBy: { createdAt: 'desc' } } },
    });
  }

  private async findOrdersByScope(dto: CreateSyncJobDto) {
    if (dto.scopeType === ScopeType.SINGLE_ORDER && dto.orderIds?.length) {
      return this.prisma.orderSyncQueue.findMany({
        where: { odooOrderId: { in: dto.orderIds } },
        orderBy: { createdAt: 'asc' },
      });
    }

    if (dto.scopeType === ScopeType.BRANCH && dto.branchCode) {
      return this.prisma.orderSyncQueue.findMany({
        where: { branchCode: dto.branchCode },
        orderBy: { createdAt: 'asc' },
      });
    }

    if (dto.scopeType === ScopeType.DATE_RANGE && dto.startDate && dto.endDate) {
      const timezone = 'UTC';
      const range = this.timezoneService.getDateRangeUtc(dto.startDate, dto.endDate, timezone);
      return this.prisma.orderSyncQueue.findMany({
        where: { orderDateUtc: { gte: range.start, lte: range.end } },
        orderBy: { orderDateUtc: 'asc' },
      });
    }

    if (dto.scopeType === ScopeType.FAILED_ONLY) {
      return this.prisma.orderSyncQueue.findMany({
        where: { status: SyncStatus.FAILED },
        orderBy: { updatedAt: 'asc' },
      });
    }

    return this.prisma.orderSyncQueue.findMany({ orderBy: { createdAt: 'asc' } });
  }
}
